import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { nuevoSecretoTotp, uriTotp, verificarTotp } from '../auth/totp.js';
import { ErrorAuth, type Contexto } from '../auth/servicio.js';
import { cifrar, descifrar, hashPassword, hashToken, nuevoToken, validarPassword, verificarPassword, type Llaves } from '../crypto.js';
import type { Notificador } from '../correo/notificador.js';
import { ORG_OPERADORES, contextoTotpOperador } from '../db/operadores.js';

export interface OpcionesConsola { sesionHoras: number; pendienteMinutos: number; maxFallos: number; bloqueoMinutos: number }
export const OPCIONES_CONSOLA: OpcionesConsola = { sesionHoras: 8, pendienteMinutos: 5, maxFallos: 5, bloqueoMinutos: 15 };

export interface SesionOperador { sesionId: string; operadorId: string; nombre: string; email: string; rol: 'admin' | 'soporte' | 'finanzas'; mfaOk: boolean }

const RECHAZO = () => new ErrorAuth(401, 'credenciales_invalidas', 'Credenciales inválidas');

/** Errores que lanzan las funciones de la base (códigos propios) convertidos a respuestas HTTP. */
function traducir(e: unknown): never {
  const x = e as { code?: string; message?: string };
  const m = String(x.message ?? '');
  if (x.code === '42501' && m === 'requiere_codigo') throw new ErrorAuth(401, 'requiere_codigo', 'Falta confirmar con un código nuevo');
  if (x.code === '42501' && m === 'no_autorizado') throw new ErrorAuth(403, 'no_autorizado', 'No tienes permiso para esta acción');
  // Cualquier otro 42501 (p. ej. "permission denied for table") es un error de configuración: sube como error interno, no como un 403 que lo esconda.
  if (x.code === '22023' && /^[a-z_]{3,40}$/.test(m)) throw new ErrorAuth(400, m, 'Dato no válido');
  if (x.code === 'P0002' && /^[a-z_]{3,40}$/.test(m)) throw new ErrorAuth(404, m, 'No encontrado');
  if (x.code === '23505') throw new ErrorAuth(409, 'ya_existe', 'Ya existe un registro con esos datos');
  throw e;
}

export class ServicioConsola {
  private hashFalso?: Promise<string>;

  constructor(private readonly pool: pg.Pool, private readonly llaves: Llaves, private readonly op: OpcionesConsola = OPCIONES_CONSOLA, private readonly reloj: () => number = Date.now, private readonly notificador: Notificador) {}

  private relleno(): Promise<string> {
    this.hashFalso ??= hashPassword('relleno-para-igualar-tiempos');
    return this.hashFalso;
  }

  // ---------- Acceso ----------

  /** Contraseña correcta => sesión PENDIENTE de segundo factor. Los operadores siempre pasan por el segundo factor. */
  async login(email: string, password: string, ctx: Contexto): Promise<{ token: string; segundos: number }> {
    const r = await this.pool.query('SELECT * FROM consola_buscar_operador($1)', [email]);
    const o = r.rows[0] as { id: string; password_hash: string; activo: boolean; bloqueado_hasta: Date | null } | undefined;
    if (!o) {
      await verificarPassword(password, await this.relleno());
      throw RECHAZO();
    }
    if (!o.activo) {
      await verificarPassword(password, o.password_hash);
      throw RECHAZO();
    }
    // El intento se reserva ANTES de evaluar la contraseña (contador atómico): peticiones en paralelo no burlan el bloqueo.
    const permitido = (await this.pool.query('SELECT consola_reservar_intento($1,$2,$3) AS ok', [o.id, this.op.maxFallos, this.op.bloqueoMinutos])).rows[0].ok as boolean;
    const ok = await verificarPassword(password, o.password_hash);
    if (!permitido || !ok) throw RECHAZO();
    await this.pool.query('SELECT consola_liberar_intento($1,$2)', [o.id, this.op.maxFallos]); // clave correcta: falta el segundo factor, aún no es un fallo
    const token = nuevoToken();
    const segundos = this.op.pendienteMinutos * 60;
    await this.pool.query('SELECT consola_crear_sesion_pendiente($1,$2,$3,$4,$5)', [o.id, hashToken(token), segundos, ctx.ip, ctx.agente]);
    return { token, segundos };
  }

  /** Lee el secreto 2FA de la sesión y verifica el código. Devuelve el paso TOTP aceptado (o lanza si falla). */
  private async verificarCodigo(token: string, codigo: string, exigirCompleta: boolean, ahoraMs: number): Promise<{ paso: number; operadorId: string }> {
    const r = await this.pool.query('SELECT * FROM consola_datos_2fa($1)', [hashToken(token)]);
    const d = r.rows[0] as { op_id: string; secreto: Buffer; clave_version: number; ultimo_paso: string | null; mfa_ok: boolean; bloqueado_hasta: Date | null } | undefined;
    if (!d || d.mfa_ok !== exigirCompleta) throw new ErrorAuth(401, 'sesion_invalida', 'Sesión no válida');
    const permitido = (await this.pool.query('SELECT consola_reservar_intento($1,$2,$3) AS ok', [d.op_id, this.op.maxFallos, this.op.bloqueoMinutos])).rows[0].ok as boolean;
    if (!permitido) throw RECHAZO();
    const secreto = descifrar(this.llaves, { version: d.clave_version, datos: d.secreto }, ORG_OPERADORES, contextoTotpOperador(d.op_id));
    const paso = verificarTotp(secreto, codigo, d.ultimo_paso === null ? null : Number(d.ultimo_paso), ahoraMs);
    if (paso === null) throw new ErrorAuth(401, 'codigo_invalido', 'Código inválido'); // el fallo ya quedó contado en la reserva
    await this.pool.query('SELECT consola_liberar_intento($1,$2)', [d.op_id, this.op.maxFallos]);
    return { paso, operadorId: d.op_id };
  }

  async verificarSegundoFactor(tokenPendiente: string, codigo: string, ctx: Contexto): Promise<{ token: string; segundos: number }> {
    const { paso } = await this.verificarCodigo(tokenPendiente, codigo, false, this.reloj());
    const token = nuevoToken();
    const segundos = this.op.sesionHoras * 3600;
    const r = await this.pool.query('SELECT consola_completar_sesion($1,$2,$3,$4,$5,$6) AS ok',
      [hashToken(tokenPendiente), hashToken(token), segundos, paso, ctx.ip, ctx.agente]);
    if (!r.rows[0].ok) throw new ErrorAuth(401, 'codigo_invalido', 'Código inválido'); // p. ej. otra petición usó el mismo código primero
    return { token, segundos };
  }

  async resolver(token: string): Promise<SesionOperador | null> {
    const r = await this.pool.query('SELECT * FROM consola_resolver_sesion($1)', [hashToken(token)]);
    const f = r.rows[0];
    return f ? { sesionId: f.sesion_id, operadorId: f.op_id, nombre: f.nombre, email: f.email, rol: f.rol, mfaOk: f.mfa_ok } : null;
  }

  /** Cierra la sesión del operador y las sesiones de "Mi cuenta" que abrió. */
  async cerrarSesion(token: string): Promise<void> {
    await this.pool.query('SELECT consola_cerrar_sesion($1)', [hashToken(token)]);
  }

  // ---------- Lecturas ----------

  private async leer<T>(sql: string, params: unknown[]): Promise<T> {
    try { return (await this.pool.query(sql, params)).rows[0].r as T; } catch (e) { return traducir(e); }
  }
  resumen(token: string) { return this.leer<object>('SELECT consola_resumen($1) AS r', [hashToken(token)]); }
  clientes(token: string, busca: string | undefined, filtro: string | undefined, limite = 100) {
    return this.leer<object[]>('SELECT consola_clientes($1,$2,$3,$4) AS r', [hashToken(token), busca ?? null, filtro ?? null, limite]);
  }
  planes(token: string) { return this.leer<object[]>('SELECT consola_planes($1) AS r', [hashToken(token)]); }
  ficha(token: string, orgId: string) { return this.leer<object>('SELECT consola_ficha($1,$2) AS r', [hashToken(token), orgId]); }
  bitacora(token: string, limite = 100) { return this.leer<object[]>('SELECT consola_bitacora($1,$2) AS r', [hashToken(token), limite]); }

  // ---------- Escrituras: cada una exige un código nuevo (un código, una acción) ----------

  /**
   * Verifica el código nuevo y ejecuta la acción. La base consume la autorización al ejecutar la función,
   * así que un código no sirve para dos acciones aunque las dos lleguen casi juntas.
   */
  private async conCodigo<T>(token: string, codigo: string, accion: () => Promise<T>): Promise<T> {
    const { paso } = await this.verificarCodigo(token, codigo, true, this.reloj());
    const ok = (await this.pool.query('SELECT consola_reautenticar($1,$2) AS ok', [hashToken(token), paso])).rows[0].ok as boolean;
    if (!ok) throw new ErrorAuth(401, 'codigo_invalido', 'Código inválido');
    try { return await accion(); } catch (e) { return traducir(e); }
  }

  /**
   * Da de alta al cliente e invita a su administrador por correo (ya no hay contraseñas temporales: nadie ve ni comparte una clave).
   * Si el correo no sale, la cuenta queda creada y la invitación se puede reenviar (con un código nuevo).
   */
  async crearCliente(token: string, codigo: string, d: { nombre: string; email: string; nombreAdmin?: string; plan?: string }) {
    const tokenInv = nuevoToken();
    const f = await this.conCodigo(token, codigo, async () =>
      (await this.pool.query('SELECT * FROM consola_invitar_cliente($1,$2,$3,$4,$5,$6)', [hashToken(token), d.nombre, d.email, hashToken(tokenInv), d.nombreAdmin ?? null, d.plan ?? 'prueba'])).rows[0] as { org_id: string; expira_en: Date });
    const envio = await this.notificador.invitacion({
      para: d.email.trim().toLowerCase(), organizacion: d.nombre.trim(), rol: 'admin', nombre: d.nombreAdmin, token: tokenInv, expira: f.expira_en,
      clave: hashToken(tokenInv).toString('hex').slice(0, 24),
    });
    await this.avisar(token, null, () => `Creó la cuenta del cliente «${d.nombre.trim().slice(0, 80)}»`);
    return { orgId: f.org_id, invitacion: { enviada: envio.enviado, expira: f.expira_en, ...(envio.enlace ? { enlace: envio.enlace } : {}) } };
  }
  async reenviarInvitacion(token: string, codigo: string, orgId: string) {
    const tokenInv = nuevoToken();
    const f = await this.conCodigo(token, codigo, async () =>
      (await this.pool.query('SELECT * FROM consola_reenviar_invitacion($1,$2,$3)', [hashToken(token), orgId, hashToken(tokenInv)])).rows[0] as { email: string; expira_en: Date; nombre_sugerido: string | null; organizacion: string; rol: 'admin' | 'miembro' });
    const envio = await this.notificador.invitacion({
      para: f.email, organizacion: f.organizacion, rol: f.rol, nombre: f.nombre_sugerido ?? undefined, token: tokenInv, expira: f.expira_en,
      clave: hashToken(tokenInv).toString('hex').slice(0, 24),
    });
    return { enviada: envio.enviado, expira: f.expira_en, ...(envio.enlace ? { enlace: envio.enlace } : {}) };
  }
  async cambiarPlan(token: string, codigo: string, orgId: string, plan: string) {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_cambiar_plan($1,$2,$3)', [hashToken(token), orgId, plan]); });
    await this.avisar(token, orgId, (c) => `Cambió el plan de «${c}» a ${plan}`);
  }
  async agregarSaldo(token: string, codigo: string, orgId: string, cantidad: number, tipo: 'recarga' | 'ajuste', motivo?: string) {
    const saldo = await this.conCodigo(token, codigo, async () =>
      Number((await this.pool.query('SELECT consola_agregar_saldo($1,$2,$3,$4,$5) AS saldo', [hashToken(token), orgId, cantidad, tipo, motivo ?? null])).rows[0].saldo));
    await this.avisar(token, orgId, (c) => `${cantidad > 0 ? 'Agregó' : 'Quitó'} ${Math.abs(cantidad)} consultas al saldo de «${c}» (${tipo})`);
    return saldo;
  }
  async cambiarEstado(token: string, codigo: string, orgId: string, estado: string) {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_cambiar_estado($1,$2,$3)', [hashToken(token), orgId, estado]); });
    await this.avisar(token, orgId, (c) => `Dejó la cuenta de «${c}» en estado ${estado}`);
  }
  async cambiarModo(token: string, codigo: string, orgId: string, modo: string) {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_cambiar_modo($1,$2,$3)', [hashToken(token), orgId, modo]); });
    await this.avisar(token, orgId, (c) => `Cambió el modo de atención de «${c}» a ${modo}`);
  }
  async cambiarAutonomia(token: string, codigo: string, orgId: string, autonomia: string) {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_cambiar_autonomia($1,$2,$3)', [hashToken(token), orgId, autonomia]); });
    await this.avisar(token, orgId, (c) => `Cambió la autonomía de «${c}» a ${autonomia}`);
  }
  async asistencia(token: string, codigo: string, orgId: string, horas: number) {
    const hasta = await this.conCodigo(token, codigo, async () => (await this.pool.query('SELECT consola_asistencia($1,$2,$3) AS hasta', [hashToken(token), orgId, horas])).rows[0].hasta as Date | null);
    await this.avisar(token, orgId, (c) => (horas === 0 ? `Terminó el modo asistencia de «${c}»` : `Activó el modo asistencia de «${c}» por ${horas} h`));
    return hasta;
  }
  async resetear2fa(token: string, codigo: string, orgId: string, usuarioId: string) {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_resetear_2fa($1,$2,$3)', [hashToken(token), orgId, usuarioId]); });
    await this.avisar(token, orgId, (c) => `Restableció el segundo factor de una persona de «${c}»`);
  }

  // ---------- Conexiones, uso y widget por cliente ----------

  conexiones(token: string, orgId: string) { return this.leer<object[]>('SELECT consola_conexiones($1,$2) AS r', [hashToken(token), orgId]); }
  async quitarConexion(token: string, codigo: string, orgId: string, id: string) {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_quitar_conexion($1,$2,$3)', [hashToken(token), orgId, id]); });
    await this.avisar(token, orgId, (c) => `Quitó una conexión que estaba fallando en «${c}»`);
  }
  usoClientes(token: string, mes: string) { return this.leer<object>('SELECT consola_uso_clientes($1,$2) AS r', [hashToken(token), mes]); }
  usoCliente(token: string, orgId: string, mes: string) { return this.leer<object>('SELECT consola_uso_cliente($1,$2,$3) AS r', [hashToken(token), orgId, mes]); }
  widget(token: string, orgId: string) { return this.leer<object>('SELECT consola_widget($1,$2) AS r', [hashToken(token), orgId]); }
  async revocarClave(token: string, codigo: string, orgId: string, claveId: string) {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_revocar_clave($1,$2,$3)', [hashToken(token), orgId, claveId]); });
    await this.avisar(token, orgId, (c) => `Revocó una clave del widget de «${c}»`);
  }

  // ---------- Mi cuenta · Archie Tech ----------

  async hayCuentaPropia(token: string): Promise<boolean> {
    return this.leer<boolean>('SELECT consola_hay_cuenta_propia($1) AS r', [hashToken(token)]);
  }

  /**
   * Abre una sesión de cliente en la cuenta propia de Archie Tech para ESTA persona del equipo (su sesión de operador ya pasó el segundo factor).
   * El usuario del equipo en esa cuenta no tiene una contraseña que alguien conozca: solo se llega por aquí.
   */
  async abrirMiCuenta(token: string, ctx: Contexto): Promise<{ token: string; segundos: number; organizacion: string }> {
    const nuevo = nuevoToken();
    const inutil = await hashPassword(randomBytes(24).toString('base64url')); // hash de una clave que nadie conoce
    try {
      const r = await this.pool.query('SELECT * FROM consola_abrir_mi_cuenta($1,$2,$3,$4,$5,$6)', [hashToken(token), hashToken(nuevo), 4 * 3600, inutil, ctx.ip, ctx.agente]);
      return { token: nuevo, segundos: 4 * 3600, organizacion: r.rows[0].nombre_org as string };
    } catch (e) { return traducir(e); }
  }

  // ---------- Equipo de Archie ----------

  operadores(token: string) { return this.leer<object[]>('SELECT consola_operadores($1) AS r', [hashToken(token)]); }
  bitacoraEquipo(token: string) { return this.leer<object[]>('SELECT consola_bitacora_equipo($1,$2) AS r', [hashToken(token), 50]); }

  async invitarOperador(token: string, codigo: string, d: { email: string; nombre: string; rol: 'admin' | 'soporte' | 'finanzas' }) {
    const id = randomUUID();
    const tokenInv = nuevoToken();
    // Contraseña y segundo factor provisionales: se reemplazan al activar. Nadie las conoce ni se muestran.
    const hash = await hashPassword(randomBytes(24).toString('base64url'));
    const cif = cifrar(this.llaves, nuevoSecretoTotp(), ORG_OPERADORES, contextoTotpOperador(id));
    const quien = await this.resolver(token);
    const expira = await this.conCodigo(token, codigo, async () =>
      (await this.pool.query('SELECT consola_invitar_operador($1,$2,$3,$4,$5,$6,$7,$8,$9) AS expira', [hashToken(token), id, d.email, d.nombre, d.rol, hash, cif.datos, cif.version, hashToken(tokenInv)])).rows[0].expira as Date);
    const envio = await this.notificador.invitacionOperador({ para: d.email.trim().toLowerCase(), nombre: d.nombre.trim(), rol: d.rol, invitador: quien?.nombre ?? 'Alguien del equipo', token: tokenInv, expira, clave: hashToken(tokenInv).toString('hex').slice(0, 24) });
    await this.avisar(token, null, () => `Invitó a ${d.email.trim().toLowerCase()} al equipo con el rol ${d.rol}`);
    return { id, invitacion: { enviada: envio.enviado, expira, ...(envio.enlace ? { enlace: envio.enlace } : {}) } };
  }

  async reenviarInvitacionOperador(token: string, codigo: string, operadorId: string) {
    const tokenInv = nuevoToken();
    const quien = await this.resolver(token);
    const f = await this.conCodigo(token, codigo, async () =>
      (await this.pool.query('SELECT * FROM consola_reenviar_invitacion_operador($1,$2,$3)', [hashToken(token), operadorId, hashToken(tokenInv)])).rows[0] as { email: string; nombre: string; rol: 'admin' | 'soporte' | 'finanzas'; expira_en: Date });
    const envio = await this.notificador.invitacionOperador({ para: f.email, nombre: f.nombre, rol: f.rol, invitador: quien?.nombre ?? 'Alguien del equipo', token: tokenInv, expira: f.expira_en, clave: hashToken(tokenInv).toString('hex').slice(0, 24) });
    return { enviada: envio.enviado, expira: f.expira_en, ...(envio.enlace ? { enlace: envio.enlace } : {}) };
  }

  async estadoOperador(token: string, codigo: string, operadorId: string, activo: boolean) {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_estado_operador($1,$2,$3)', [hashToken(token), operadorId, activo]); });
    await this.avisar(token, null, () => (activo ? 'Reactivó a una persona del equipo' : 'Desactivó a una persona del equipo'));
  }

  async rolOperador(token: string, codigo: string, operadorId: string, rol: 'admin' | 'soporte' | 'finanzas') {
    await this.conCodigo(token, codigo, async () => { await this.pool.query('SELECT consola_rol_operador($1,$2,$3)', [hashToken(token), operadorId, rol]); });
    await this.avisar(token, null, () => `Cambió el rol de una persona del equipo a ${rol}`);
  }

  // ---------- Activación de un operador invitado (sin sesión) ----------

  private readonly maxIntentosActivacion = 8;

  async verInvitacionOperador(tokenInv: string): Promise<{ nombre: string; email: string; rol: string }> {
    const r = await this.pool.query('SELECT * FROM consola_ver_invitacion_operador($1)', [hashToken(tokenInv)]);
    const f = r.rows[0] as { nombre: string; email: string; rol: string } | undefined;
    if (!f) throw new ErrorAuth(404, 'invitacion_invalida', 'La invitación no existe, venció o ya se usó');
    return { nombre: f.nombre, email: f.email, rol: f.rol };
  }

  /** Paso 1: la persona elige su contraseña. Se genera su secreto del segundo factor y queda EN ESPERA hasta que confirme un código. */
  async iniciarActivacion(tokenInv: string, password: string): Promise<{ secretoTotp: string; uri: string }> {
    const err = validarPassword(password);
    if (err) throw new ErrorAuth(400, 'password_debil', err);
    const th = hashToken(tokenInv);
    const ver = (await this.pool.query('SELECT * FROM consola_ver_invitacion_operador($1)', [th])).rows[0] as { operador_id: string; email: string } | undefined;
    if (!ver) throw new ErrorAuth(404, 'invitacion_invalida', 'La invitación no existe, venció o ya se usó');
    if (!(await this.pool.query('SELECT consola_reservar_intento_activacion($1,$2) AS ok', [th, this.maxIntentosActivacion])).rows[0].ok) throw new ErrorAuth(404, 'invitacion_invalida', 'La invitación no existe, venció o ya se usó');
    const hash = await hashPassword(password);
    const secreto = nuevoSecretoTotp();
    const cif = cifrar(this.llaves, secreto, ORG_OPERADORES, contextoTotpOperador(ver.operador_id));
    const ok = (await this.pool.query('SELECT consola_guardar_activacion($1,$2,$3,$4) AS ok', [th, hash, cif.datos, cif.version])).rows[0].ok as boolean;
    if (!ok) throw new ErrorAuth(404, 'invitacion_invalida', 'La invitación no existe, venció o ya se usó');
    return { secretoTotp: secreto, uri: uriTotp(secreto, ver.email) };
  }

  /** Paso 2: confirma un código de su app de autenticación. Solo entonces queda activa la cuenta. */
  async completarActivacion(tokenInv: string, codigo: string): Promise<void> {
    const th = hashToken(tokenInv);
    if (!(await this.pool.query('SELECT consola_reservar_intento_activacion($1,$2) AS ok', [th, this.maxIntentosActivacion])).rows[0].ok) throw new ErrorAuth(404, 'invitacion_invalida', 'La invitación no existe, venció o ya se usó');
    const d = (await this.pool.query('SELECT * FROM consola_datos_activacion($1)', [th])).rows[0] as { operador_id: string; secreto: Buffer; clave_version: number } | undefined;
    if (!d) throw new ErrorAuth(409, 'activacion_incompleta', 'Primero elige tu contraseña');
    const secreto = descifrar(this.llaves, { version: d.clave_version, datos: d.secreto }, ORG_OPERADORES, contextoTotpOperador(d.operador_id));
    const paso = verificarTotp(secreto, codigo, null, this.reloj());
    if (paso === null) throw new ErrorAuth(401, 'codigo_invalido', 'Código inválido');
    const ok = (await this.pool.query('SELECT consola_completar_activacion($1,$2) AS ok', [th, paso])).rows[0].ok as boolean;
    if (!ok) throw new ErrorAuth(404, 'invitacion_invalida', 'La invitación no existe, venció o ya se usó');
  }

  // ---------- Alertas por correo ----------

  /**
   * Avisa por correo a las personas administradoras del equipo que se hizo una acción sensible. Nunca tumba la acción:
   * si algo falla se ignora (la acción ya quedó en la bitácora). El texto no incluye datos personales de los clientes.
   */
  private async avisar(token: string, orgId: string | null, que: (cliente: string) => string): Promise<void> {
    try {
      const quien = await this.resolver(token);
      if (!quien) return;
      const cliente = orgId ? String(((await this.ficha(token, orgId)) as { nombre?: string }).nombre ?? 'un cliente').slice(0, 80) : '';
      const para = await this.leer<string[]>('SELECT consola_destinatarios_alerta($1) AS r', [hashToken(token)]);
      if (para.length === 0) return;
      await this.notificador.alertaConsola({ para, quien: `${quien.nombre} (${quien.email})`, que: que(cliente), cuando: new Date(this.reloj()), clave: randomUUID() });
    } catch { /* la alerta es un extra: no afecta la acción */ }
  }
}

import type pg from 'pg';
import { cifrar, descifrar, hashPassword, hashToken, nuevoToken, validarPassword, verificarPassword, type Llaves } from '../crypto.js';
import { conOrg } from '../db/pool.js';
import { CANTIDAD_CODIGOS, hashCodigo, normalizarCodigo, nuevoCodigoRecuperacion } from './codigos.js';
import { nuevoSecretoTotp, uriTotp, verificarTotp } from './totp.js';

export class ErrorAuth extends Error {
  constructor(readonly estado: number, readonly codigo: string, mensaje: string) { super(mensaje); }
}

export interface OpcionesAuth {
  sesionHoras: number;      // duración de una sesión completa
  pendienteMinutos: number; // tiempo para escribir el código 2FA tras la contraseña
  maxFallos: number;        // fallos seguidos antes de bloquear la cuenta
  bloqueoMinutos: number;
}
export const OPCIONES_POR_DEFECTO: OpcionesAuth = { sesionHoras: 12, pendienteMinutos: 5, maxFallos: 5, bloqueoMinutos: 15 };

/** Avisos por correo que dispara la autenticación (opcionales: sin ellos solo se audita). Un fallo de envío nunca debe romper la acción. */
export interface AvisosAuth {
  enlaceRecuperacion(p: { para: string; nombre: string | null; token: string; expira: Date; clave: string }): Promise<unknown>;
  passwordCambiada(p: { para: string; nombre: string | null; motivo: 'restablecida' | 'cambiada'; clave: string }): Promise<unknown>;
  codigoRecuperacionUsado(p: { para: string; nombre: string | null; restantes: number; clave: string }): Promise<unknown>;
}

export const RECUPERACION_MINUTOS = 30;
const MAX_SOLICITUDES_HORA = 3;

export interface Contexto { ip: string; agente: string }
export interface SesionActiva { sesionId: string; usuarioId: string; orgId: string; rol: 'admin' | 'miembro'; mfaOk: boolean }

export type ResultadoLogin =
  | { tipo: 'ok'; token: string; segundos: number; usuario: { id: string; rol: string; totpActivo: boolean } }
  | { tipo: 'requiere_2fa'; token: string; segundos: number };

const RECHAZO = () => new ErrorAuth(401, 'credenciales_invalidas', 'Credenciales inválidas');
const CTX_TOTP = (usuarioId: string) => `totp:${usuarioId}`;

interface FilaUsuario {
  id: string; org_id: string; email: string; password_hash: string; rol: 'admin' | 'miembro';
  totp_secreto: Buffer | null; totp_clave_version: number | null; totp_activo: boolean; activo: boolean;
  bloqueado_hasta: Date | null; totp_ultimo_paso: string | null;
}

export class ServicioAuth {
  private hashFalso?: Promise<string>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly llaves: Llaves,
    private readonly op: OpcionesAuth = OPCIONES_POR_DEFECTO,
    private readonly avisos?: AvisosAuth,
    private readonly log: { error: (o: object, m: string) => void } = { error: () => undefined },
  ) {}

  /** Hash de relleno para que un correo inexistente tarde lo mismo que uno real (evita enumerar usuarios por tiempo). */
  private relleno(): Promise<string> {
    this.hashFalso ??= hashPassword('relleno-para-igualar-tiempos');
    return this.hashFalso;
  }

  // ---------- Auditoría ----------

  private async auditar(c: pg.PoolClient, orgId: string, usuarioId: string | null, accion: string, ctx?: Contexto, extra: object = {}) {
    await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
      [orgId, usuarioId, accion, JSON.stringify({ ...(ctx ? { ip: ctx.ip } : {}), ...extra })]);
  }
  private auditarAparte(orgId: string, usuarioId: string | null, accion: string, ctx?: Contexto, extra: object = {}) {
    return conOrg(this.pool, orgId, (c) => this.auditar(c, orgId, usuarioId, accion, ctx, extra));
  }

  private crearSesion(c: pg.PoolClient, f: { orgId: string; usuarioId: string }, mfaOk: boolean, ctx: Contexto) {
    const token = nuevoToken();
    const segundos = mfaOk ? this.op.sesionHoras * 3600 : this.op.pendienteMinutos * 60;
    return c.query(
      `INSERT INTO sesiones (org_id, usuario_id, token_hash, expira_en, ip, agente, mfa_ok)
       VALUES ($1,$2,$3, now() + make_interval(secs => $4), $5, $6, $7)`,
      [f.orgId, f.usuarioId, hashToken(token), segundos, ctx.ip, ctx.agente.slice(0, 200), mfaOk],
    ).then(() => ({ token, segundos }));
  }

  // ---------- Inicio de sesión ----------

  async login(email: string, password: string, ctx: Contexto): Promise<ResultadoLogin> {
    const r = await this.pool.query('SELECT * FROM buscar_usuario_para_login($1)', [email]);
    const u = r.rows[0] as { id: string; org_id: string; password_hash: string; totp_activo: boolean; activo: boolean; bloqueado_hasta: Date | null } | undefined;

    if (!u) {
      await verificarPassword(password, await this.relleno());
      throw RECHAZO();
    }
    if (!u.activo) {
      if (await verificarPassword(password, u.password_hash)) await this.auditarAparte(u.org_id, u.id, 'login_cuenta_inactiva', ctx);
      throw RECHAZO();
    }
    // El intento se RESERVA antes de evaluar la contraseña (contador atómico en la base de datos): así, aunque lleguen
    // cientos de peticiones a la vez, solo se evalúan tantas como intentos quedan antes del bloqueo.
    const permitido = (await this.pool.query('SELECT reservar_intento_login($1,$2,$3) AS ok', [u.id, this.op.maxFallos, this.op.bloqueoMinutos])).rows[0].ok as boolean;
    const claveOk = await verificarPassword(password, u.password_hash); // también si está bloqueada: mismo tiempo de respuesta
    if (!permitido) {
      await this.auditarAparte(u.org_id, u.id, 'login_bloqueado', ctx);
      throw RECHAZO(); // mismo mensaje: no se confirma si el correo existe ni si está bloqueado
    }
    if (!claveOk) {
      await this.auditarAparte(u.org_id, u.id, 'login_fallido', ctx); // el conteo ya quedó reservado
      throw RECHAZO();
    }
    // Clave correcta: con segundo factor la reserva se devuelve (aún no es un fallo); sin él, el conteo se reinicia abajo.
    if (u.totp_activo) await this.pool.query('SELECT liberar_intento_login($1,$2)', [u.id, this.op.maxFallos]);

    return conOrg(this.pool, u.org_id, async (c) => {
      const mfa = u.totp_activo;
      const s = await this.crearSesion(c, { orgId: u.org_id, usuarioId: u.id }, !mfa, ctx);
      if (mfa) {
        await this.auditar(c, u.org_id, u.id, 'login_clave_ok', ctx);
        return { tipo: 'requiere_2fa' as const, token: s.token, segundos: s.segundos };
      }
      await c.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [u.id]);
      await this.auditar(c, u.org_id, u.id, 'login_ok', ctx);
      const rol = (await c.query('SELECT rol FROM usuarios WHERE id = $1', [u.id])).rows[0].rol as string;
      return { tipo: 'ok' as const, token: s.token, segundos: s.segundos, usuario: { id: u.id, rol, totpActivo: false } };
    });
  }

  // ---------- Segundo factor al iniciar sesión ----------

  async verificarSegundoFactor(tokenPendiente: string, codigo: string, ctx: Contexto, ahoraMs = Date.now()): Promise<ResultadoLogin & { tipo: 'ok' }> {
    const s = await this.resolver(tokenPendiente);
    if (!s || s.mfaOk) throw new ErrorAuth(401, 'sesion_invalida', 'Sesión no válida');

    const veredicto = await conOrg(this.pool, s.orgId, async (c) => {
      const u = (await c.query('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [s.usuarioId])).rows[0] as FilaUsuario | undefined;
      if (!u || !u.activo || !u.totp_activo || !u.totp_secreto || u.totp_clave_version === null) return 'rechazado' as const;
      if (u.bloqueado_hasta && u.bloqueado_hasta.getTime() > Date.now()) return 'bloqueado' as const;
      const secreto = descifrar(this.llaves, { version: u.totp_clave_version, datos: u.totp_secreto }, s.orgId, CTX_TOTP(u.id));
      const paso = verificarTotp(secreto, codigo, u.totp_ultimo_paso === null ? null : Number(u.totp_ultimo_paso), ahoraMs);
      if (paso === null) {
        await c.query('SELECT registrar_login_fallido($1,$2,$3)', [u.id, this.op.maxFallos, this.op.bloqueoMinutos]); // dentro de la transacción: la fila está bloqueada
        await this.auditar(c, s.orgId, u.id, 'mfa_fallido', ctx);
        return 'codigo_malo' as const;
      }

      // Éxito: se rota el token (la sesión pendiente deja de servir) y se actualiza el último paso aceptado.
      await c.query('DELETE FROM sesiones WHERE id = $1', [s.sesionId]);
      const nueva = await this.crearSesion(c, { orgId: s.orgId, usuarioId: u.id }, true, ctx);
      await c.query('UPDATE usuarios SET totp_ultimo_paso = $2, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [u.id, paso]);
      await this.auditar(c, s.orgId, u.id, 'login_ok', ctx, { segundo_factor: true });
      return { tipo: 'ok' as const, token: nueva.token, segundos: nueva.segundos, usuario: { id: u.id, rol: u.rol, totpActivo: true } };
    });

    if (veredicto === 'codigo_malo') {
      throw new ErrorAuth(401, 'codigo_invalido', 'Código inválido');
    }
    if (veredicto === 'bloqueado') {
      await this.auditarAparte(s.orgId, s.usuarioId, 'login_bloqueado', ctx);
      throw RECHAZO();
    }
    if (veredicto === 'rechazado') throw RECHAZO();
    return veredicto;
  }

  // ---------- Sesión ----------

  async resolver(token: string): Promise<SesionActiva | null> {
    const r = await this.pool.query('SELECT * FROM resolver_sesion($1)', [hashToken(token)]);
    const f = r.rows[0];
    return f ? { sesionId: f.sesion_id, usuarioId: f.usuario_id, orgId: f.org_id, rol: f.rol, mfaOk: f.mfa_ok } : null;
  }

  /** ¿Es un administrador que todavía no activó el segundo factor? (con el 2FA de administradores obligatorio, solo puede configurarlo) */
  async debeActivar2fa(s: SesionActiva): Promise<boolean> {
    if (s.rol !== 'admin') return false;
    const r = await conOrg(this.pool, s.orgId, (c) => c.query(
      `SELECT u.totp_activo, (SELECT se.puente_operador IS NOT NULL FROM sesiones se WHERE se.id = $2) AS puente FROM usuarios u WHERE u.id = $1`, [s.usuarioId, s.sesionId]));
    // Una sesión abierta desde la consola ("Mi cuenta") ya pasó el segundo factor del operador: no se le pide otro aquí.
    return r.rows[0]?.totp_activo === false && r.rows[0]?.puente !== true;
  }

  async cerrarSesion(token: string, ctx: Contexto): Promise<void> {
    const s = await this.resolver(token);
    if (!s) return;
    await conOrg(this.pool, s.orgId, async (c) => {
      await c.query('DELETE FROM sesiones WHERE id = $1', [s.sesionId]);
      await this.auditar(c, s.orgId, s.usuarioId, 'logout', ctx);
    });
  }

  async perfil(s: SesionActiva) {
    const r = await conOrg(this.pool, s.orgId, (c) =>
      c.query(`SELECT u.id, u.email, u.nombre, u.rol, u.totp_activo, o.nombre AS organizacion,
                 EXISTS (SELECT 1 FROM sesiones se WHERE se.id = $2 AND se.puente_operador IS NOT NULL) AS puente,
                 (SELECT count(*) FROM codigos_recuperacion k WHERE k.usuario_id = u.id AND k.usado_en IS NULL)::int AS codigos
               FROM usuarios u JOIN organizaciones o ON o.id = u.org_id WHERE u.id = $1`, [s.usuarioId, s.sesionId]));
    const f = r.rows[0];
    return { id: f.id as string, email: f.email as string, nombre: (f.nombre ?? null) as string | null, rol: f.rol as string, totpActivo: f.totp_activo as boolean, organizacion: f.organizacion as string, codigosRestantes: f.codigos as number, puente: f.puente as boolean };
  }

  // ---------- Configurar el segundo factor (requiere sesión completa y la contraseña) ----------

  async iniciarEnrolamiento2fa(s: SesionActiva, password: string, ctx: Contexto) {
    if (!s.mfaOk) throw new ErrorAuth(403, 'sesion_incompleta', 'Falta completar el segundo factor');
    const r = await conOrg(this.pool, s.orgId, async (c) => {
      const u = (await c.query('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [s.usuarioId])).rows[0] as FilaUsuario;
      const p = await this.exigirPassword(c, u, password, ctx, s.orgId);
      if (p !== 'ok') return p;
      if (u.totp_activo) return 'ya_activo' as const;
      const secreto = nuevoSecretoTotp();
      const cif = cifrar(this.llaves, secreto, s.orgId, CTX_TOTP(u.id));
      await c.query('UPDATE usuarios SET totp_secreto = $2, totp_clave_version = $3, totp_activo = false, totp_ultimo_paso = NULL WHERE id = $1', [u.id, cif.datos, cif.version]);
      await this.auditar(c, s.orgId, u.id, '2fa_enrolamiento_iniciado', ctx);
      return { secreto, uri: uriTotp(secreto, u.email) };
    });
    if (r === 'mala' || r === 'bloqueada') throw this.errorPassword(r);
    if (r === 'ya_activo') throw new ErrorAuth(409, '2fa_ya_activo', 'El segundo factor ya está activo');
    return r;
  }

  async confirmarEnrolamiento2fa(s: SesionActiva, codigo: string, ctx: Contexto, ahoraMs = Date.now()): Promise<{ codigos: string[] }> {
    if (!s.mfaOk) throw new ErrorAuth(403, 'sesion_incompleta', 'Falta completar el segundo factor');
    const codigos = await conOrg(this.pool, s.orgId, async (c) => {
      const u = (await c.query('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [s.usuarioId])).rows[0] as FilaUsuario;
      if (u.totp_activo || !u.totp_secreto || u.totp_clave_version === null) throw new ErrorAuth(409, '2fa_no_pendiente', 'No hay una configuración pendiente');
      const secreto = descifrar(this.llaves, { version: u.totp_clave_version, datos: u.totp_secreto }, s.orgId, CTX_TOTP(u.id));
      const paso = verificarTotp(secreto, codigo, null, ahoraMs);
      if (paso === null) return null;
      await c.query('UPDATE usuarios SET totp_activo = true, totp_ultimo_paso = $2 WHERE id = $1', [u.id, paso]);
      await this.auditar(c, s.orgId, u.id, '2fa_activado', ctx);
      return this.reemplazarCodigos(c, s.orgId, u.id, ctx, false);
    });
    if (!codigos) throw new ErrorAuth(400, 'codigo_invalido', 'Código inválido');
    return { codigos };
  }

  // ---------- Códigos de recuperación del segundo factor ----------

  /** Borra el juego anterior y crea uno nuevo (10 códigos de un solo uso). Los códigos en claro se devuelven una sola vez. */
  private async reemplazarCodigos(c: pg.PoolClient, orgId: string, usuarioId: string, ctx: Contexto, auditarLo = true): Promise<string[]> {
    await c.query('DELETE FROM codigos_recuperacion WHERE usuario_id = $1', [usuarioId]);
    const codigos = Array.from({ length: CANTIDAD_CODIGOS }, () => nuevoCodigoRecuperacion());
    for (const k of codigos) {
      await c.query('INSERT INTO codigos_recuperacion (org_id, usuario_id, codigo_hash) VALUES ($1,$2,$3)', [orgId, usuarioId, hashCodigo(normalizarCodigo(k)!)]);
    }
    if (auditarLo) await this.auditar(c, orgId, usuarioId, '2fa_codigos_regenerados', ctx);
    return codigos;
  }

  /** Genera un juego nuevo (invalida el anterior). Pide sesión completa y la contraseña. */
  async regenerarCodigosRecuperacion(s: SesionActiva, password: string, ctx: Contexto): Promise<{ codigos: string[] }> {
    if (!s.mfaOk) throw new ErrorAuth(403, 'sesion_incompleta', 'Falta completar el segundo factor');
    const r = await conOrg(this.pool, s.orgId, async (c) => {
      const u = (await c.query('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [s.usuarioId])).rows[0] as FilaUsuario;
      const p = await this.exigirPassword(c, u, password, ctx, s.orgId);
      if (p !== 'ok') return p;
      if (!u.totp_activo) return 'sin_2fa' as const;
      return { codigos: await this.reemplazarCodigos(c, s.orgId, u.id, ctx) };
    });
    if (r === 'mala' || r === 'bloqueada') throw this.errorPassword(r);
    if (r === 'sin_2fa') throw new ErrorAuth(409, '2fa_no_activo', 'Primero activa el segundo factor');
    return r;
  }

  /** Entra con un código de recuperación en lugar del código de la app. Cada código sirve una sola vez. */
  async verificarCodigoRecuperacion(tokenPendiente: string, codigo: string, ctx: Contexto): Promise<ResultadoLogin & { tipo: 'ok'; restantes: number }> {
    const s = await this.resolver(tokenPendiente);
    if (!s || s.mfaOk) throw new ErrorAuth(401, 'sesion_invalida', 'Sesión no válida');
    const norm = normalizarCodigo(codigo);

    const veredicto = await conOrg(this.pool, s.orgId, async (c) => {
      const u = (await c.query('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [s.usuarioId])).rows[0] as FilaUsuario | undefined;
      if (!u || !u.activo || !u.totp_activo) return 'rechazado' as const;
      if (u.bloqueado_hasta && u.bloqueado_hasta.getTime() > Date.now()) return 'bloqueado' as const;
      // Un solo UPDATE decide: si dos peticiones usan el mismo código, solo una lo encuentra sin usar.
      const usado = norm === null ? null : (await c.query(
        'UPDATE codigos_recuperacion SET usado_en = now() WHERE usuario_id = $1 AND codigo_hash = $2 AND usado_en IS NULL RETURNING id',
        [u.id, hashCodigo(norm)])).rows[0];
      if (!usado) {
        await c.query('SELECT registrar_login_fallido($1,$2,$3)', [u.id, this.op.maxFallos, this.op.bloqueoMinutos]);
        await this.auditar(c, s.orgId, u.id, 'mfa_fallido', ctx);
        return 'codigo_malo' as const;
      }
      await c.query('DELETE FROM sesiones WHERE id = $1', [s.sesionId]);
      const nueva = await this.crearSesion(c, { orgId: s.orgId, usuarioId: u.id }, true, ctx);
      await c.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [u.id]);
      const restantes = (await c.query('SELECT count(*)::int AS n FROM codigos_recuperacion WHERE usuario_id = $1 AND usado_en IS NULL', [u.id])).rows[0].n as number;
      await this.auditar(c, s.orgId, u.id, 'login_codigo_recuperacion', ctx, { restantes });
      return { tipo: 'ok' as const, token: nueva.token, segundos: nueva.segundos, usuario: { id: u.id, rol: u.rol, totpActivo: true }, restantes, email: u.email, nombre: (u as unknown as { nombre: string | null }).nombre ?? null };
    });

    if (veredicto === 'codigo_malo') {
      throw new ErrorAuth(401, 'codigo_invalido', 'Código inválido');
    }
    if (veredicto === 'bloqueado') {
      await this.auditarAparte(s.orgId, s.usuarioId, 'login_bloqueado', ctx);
      throw RECHAZO();
    }
    if (veredicto === 'rechazado') throw RECHAZO();
    this.avisar(this.avisos?.codigoRecuperacionUsado({ para: veredicto.email, nombre: veredicto.nombre, restantes: veredicto.restantes, clave: `${s.usuarioId}-${Date.now()}` }));
    return veredicto;
  }

  /** Los avisos por correo son de mejor esfuerzo: sin esperar y sin que un error cambie el resultado. */
  private avisar(p: Promise<unknown> | undefined): void {
    p?.catch((e) => this.log.error({ err: e instanceof Error ? e.constructor.name : 'desconocido' }, 'no se pudo enviar el aviso de seguridad'));
  }

  // ---------- Recuperación de contraseña por correo ----------

  /**
   * Pide un enlace de recuperación. Responde igual exista o no el correo (el que llama no debe poder distinguirlo).
   * Máximo 3 solicitudes por hora por persona; las anteriores quedan anuladas. Devuelve la promesa del envío para poder esperarla en pruebas.
   */
  async solicitarRecuperacion(email: string): Promise<void> {
    const r = await this.pool.query('SELECT * FROM buscar_usuario_para_login($1)', [email]);
    const u = r.rows[0] as { id: string; org_id: string; activo: boolean } | undefined;
    if (!u || !u.activo) return;
    const token = nuevoToken();
    const datos = await conOrg(this.pool, u.org_id, async (c) => {
      const o = (await c.query('SELECT activa FROM organizaciones WHERE id = $1', [u.org_id])).rows[0];
      if (!o?.activa) return null;
      const recientes = (await c.query("SELECT count(*)::int AS n FROM recuperaciones_password WHERE usuario_id = $1 AND creada_en > now() - interval '1 hour'", [u.id])).rows[0].n as number;
      if (recientes >= MAX_SOLICITUDES_HORA) return null;
      await c.query('UPDATE recuperaciones_password SET usada_en = now() WHERE usuario_id = $1 AND usada_en IS NULL', [u.id]);
      const f = (await c.query(
        `INSERT INTO recuperaciones_password (org_id, usuario_id, token_hash, expira_en) VALUES ($1,$2,$3, now() + make_interval(mins => $4)) RETURNING expira_en, id`,
        [u.org_id, u.id, hashToken(token), RECUPERACION_MINUTOS])).rows[0];
      const us = (await c.query('SELECT email, nombre FROM usuarios WHERE id = $1', [u.id])).rows[0];
      await this.auditar(c, u.org_id, u.id, 'password_recuperacion_solicitada');
      return { expira: f.expira_en as Date, id: f.id as string, email: us.email as string, nombre: (us.nombre ?? null) as string | null };
    });
    if (!datos || !this.avisos) return;
    try { await this.avisos.enlaceRecuperacion({ para: datos.email, nombre: datos.nombre, token, expira: datos.expira, clave: datos.id }); }
    catch (e) { this.log.error({ err: e instanceof Error ? e.constructor.name : 'desconocido' }, 'no se pudo enviar el enlace de recuperación'); }
  }

  /** Cambia la contraseña con el enlace del correo. No salta el segundo factor y cierra todas las sesiones de la persona. */
  async restablecerPassword(token: string, nueva: string, ctx: Contexto): Promise<void> {
    const err = validarPassword(nueva);
    if (err) throw new ErrorAuth(400, 'password_debil', err);
    const nuevoHash = await hashPassword(nueva);
    let fila: { usuario_id: string; org_id: string; email: string } | undefined;
    try {
      fila = (await this.pool.query('SELECT * FROM recuperacion_aplicar($1,$2)', [hashToken(token), nuevoHash])).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === 'P0002') throw new ErrorAuth(400, 'enlace_invalido', 'El enlace no sirve: ya se usó o venció. Pide uno nuevo.');
      throw e;
    }
    if (!fila) throw new ErrorAuth(400, 'enlace_invalido', 'El enlace no sirve: ya se usó o venció. Pide uno nuevo.');
    await this.auditarAparte(fila.org_id, fila.usuario_id, 'password_restablecida_desde', ctx);
    const nombre = (await conOrg(this.pool, fila.org_id, (c) => c.query('SELECT nombre FROM usuarios WHERE id = $1', [fila!.usuario_id]))).rows[0]?.nombre ?? null;
    this.avisar(this.avisos?.passwordCambiada({ para: fila.email, nombre, motivo: 'restablecida', clave: `${fila.usuario_id}-${Date.now()}` }));
  }

  // ---------- Cambio de contraseña ----------

  async cambiarPassword(s: SesionActiva, actual: string, nueva: string, ctx: Contexto): Promise<void> {
    if (!s.mfaOk) throw new ErrorAuth(403, 'sesion_incompleta', 'Falta completar el segundo factor');
    const err = validarPassword(nueva);
    if (err) throw new ErrorAuth(400, 'password_debil', err);
    const nuevoHash = await hashPassword(nueva);
    const r = await conOrg(this.pool, s.orgId, async (c) => {
      const u = (await c.query('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [s.usuarioId])).rows[0] as FilaUsuario;
      const p = await this.exigirPassword(c, u, actual, ctx, s.orgId);
      if (p !== 'ok') return p;
      await c.query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [u.id, nuevoHash]);
      // Se cierran todas las demás sesiones de la persona (por si alguien más tenía acceso).
      await c.query('DELETE FROM sesiones WHERE usuario_id = $1 AND id <> $2', [u.id, s.sesionId]);
      await this.auditar(c, s.orgId, u.id, 'password_cambiada', ctx);
      return 'ok' as const;
    });
    if (r !== 'ok') throw this.errorPassword(r);
    const p = await this.perfil(s);
    this.avisar(this.avisos?.passwordCambiada({ para: p.email, nombre: p.nombre, motivo: 'cambiada', clave: `${s.usuarioId}-${Date.now()}` }));
  }

  /**
   * Reconfirma la contraseña dentro de una acción sensible. NO lanza: devuelve el estado para que quien llama
   * confirme la transacción (y con ella el conteo de fallos y la auditoría) y luego lance el error.
   * Los fallos cuentan para el bloqueo de la cuenta.
   */
  private async exigirPassword(c: pg.PoolClient, u: FilaUsuario, password: string, ctx: Contexto, orgId: string): Promise<'ok' | 'mala' | 'bloqueada'> {
    if (u.bloqueado_hasta && u.bloqueado_hasta.getTime() > Date.now()) return 'bloqueada';
    if (await verificarPassword(password, u.password_hash)) return 'ok';
    await c.query('SELECT registrar_login_fallido($1,$2,$3)', [u.id, this.op.maxFallos, this.op.bloqueoMinutos]);
    await this.auditar(c, orgId, u.id, 'password_reconfirmacion_fallida', ctx);
    return 'mala';
  }

  private errorPassword(e: 'mala' | 'bloqueada'): ErrorAuth {
    return e === 'bloqueada' ? RECHAZO() : new ErrorAuth(401, 'password_incorrecta', 'Contraseña incorrecta');
  }
}

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { codigoActual } from '../src/auth/totp.js';
import { cargarConfig } from '../src/config.js';
import { cargarLlaves, hashPassword } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { crearOperador, type RolOperador } from '../src/db/operadores.js';
import { CorreoMemoria } from '../src/correo/correo.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';
const PW_OP = 'clave-del-equipo-muy-larga-1';

describe.skipIf(!hay)('consola del equipo (operadores)', () => {
  let bd: BdPrueba;
  let app: FastifyInstance;
  let ahora = Date.now();
  let n = 0;
  const correoPrueba = new CorreoMemoria();
  const secretos = new Map<string, string>();

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_ORIGEN: 'https://archie.ejemplo.test' }), {
      pool: bd.app, llaves, relojConsola: () => ahora, correo: correoPrueba,
      rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } },
    });
  }, 60_000);
  afterAll(async () => { await app?.close(); await bd?.cerrar(); });

  /** Un código nuevo cada vez: el reloj de prueba avanza un intervalo (30 s) y el código sale de ese instante. */
  const codigo = (email: string) => { ahora += 30_000; return codigoActual(secretos.get(email)!, ahora); };

  async function nuevoOperador(rol: RolOperador = 'admin') {
    const email = `op${++n}@archie.test`;
    const r = await crearOperador(bd.owner, llaves, { email, nombre: `Operador ${n}`, rol, password: PW_OP });
    secretos.set(email, r.secretoTotp);
    return { email, id: r.id };
  }
  /** Entra a la consola completa (contraseña + código) y devuelve la cookie. */
  async function entrar(email: string) {
    const a = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email, password: PW_OP } });
    expect(a.statusCode).toBe(200);
    const pend = String(a.headers['set-cookie']).split(';')[0]!;
    const b = await app.inject({ method: 'POST', url: '/api/consola/auth/2fa', headers: { cookie: pend }, payload: { codigo: codigo(email) } });
    expect(b.statusCode).toBe(200);
    return String(b.headers['set-cookie']).split(';')[0]!;
  }
  const api = (cookie: string, metodo: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method: metodo, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  async function nuevaOrg(plan?: string) {
    const email = `c${++n}@cliente.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Cliente ${n}`, email, password: PW, nombreAdmin: `Persona ${n}`, plan });
    return { email, ...r };
  }
  async function sesionCliente(email: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW } });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }
  // El rol dueño también respeta la seguridad por filas: se consulta siempre dentro de la organización.
  const dueno = (orgId: string, sql: string, params: unknown[] = []) => conOrg(bd.owner, orgId, (cx) => cx.query(sql, params));
  const estadoOrg = async (orgId: string) => (await dueno(orgId, 'SELECT estado, activa, plan_id, modo, autonomia, asistencia_hasta FROM organizaciones WHERE id = $1', [orgId])).rows[0];
  const saldo = async (orgId: string) => Number((await dueno(orgId, 'SELECT coalesce(sum(cantidad),0) AS s FROM consultas_libro WHERE org_id = $1', [orgId])).rows[0].s);

  // ---------- Acceso ----------

  it('el segundo factor es obligatorio: la contraseña sola solo da una sesión pendiente que no abre nada', async () => {
    const o = await nuevoOperador();
    const a = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: o.email, password: PW_OP } });
    expect(a.json()).toEqual({ estado: 'requiere_2fa' });
    const pend = String(a.headers['set-cookie']).split(';')[0]!;
    expect((await api(pend, 'GET', '/api/consola/resumen')).statusCode).toBe(401);
    expect((await api(pend, 'GET', '/api/consola/yo')).statusCode).toBe(401);
    const ok = await entrar(o.email);
    expect((await api(ok, 'GET', '/api/consola/yo')).json()).toMatchObject({ email: o.email, rol: 'admin' });
    // la sesión pendiente quedó reemplazada por una nueva: ya no sirve
    expect((await api(pend, 'GET', '/api/consola/yo')).statusCode).toBe(401);
  });

  it('el secreto 2FA del operador queda cifrado y no existe un operador sin segundo factor', async () => {
    const o = await nuevoOperador();
    const f = (await bd.owner.query('SELECT totp_secreto FROM operadores WHERE id = $1', [o.id])).rows[0];
    expect(Buffer.from(f.totp_secreto).includes(Buffer.from(secretos.get(o.email)!))).toBe(false);
    await expect(bd.owner.query(
      `INSERT INTO operadores (email, nombre, rol, password_hash, totp_secreto, totp_clave_version) VALUES ('x@archie.test','X','admin','h',NULL,1)`)).rejects.toThrow();
  });

  it('contraseña mala y correo inexistente responden igual; 5 fallos bloquean la cuenta', async () => {
    const o = await nuevoOperador();
    const mala = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: o.email, password: 'incorrecta-incorrecta' } });
    const nada = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: 'nadie@archie.test', password: 'incorrecta-incorrecta' } });
    expect(mala.statusCode).toBe(401);
    expect(mala.json()).toEqual(nada.json());
    for (let i = 0; i < 4; i++) await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: o.email, password: 'incorrecta-incorrecta' } });
    const conBuena = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: o.email, password: PW_OP } });
    expect(conBuena.statusCode).toBe(401); // bloqueado: ni la contraseña correcta entra
  });

  it('consola: 60 contraseñas y 60 códigos malos en paralelo no pasan del límite de intentos', async () => {
    const o = await nuevoOperador();
    const L = (password: string) => app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: o.email, password } });
    await Promise.all(Array.from({ length: 60 }, () => L('incorrecta-incorrecta')));
    const f = (await bd.owner.query('SELECT intentos_fallidos, bloqueado_hasta FROM operadores WHERE id = $1', [o.id])).rows[0];
    expect(f.intentos_fallidos).toBe(5);
    expect(f.bloqueado_hasta).not.toBeNull();
    expect((await L(PW_OP)).statusCode).toBe(401);

    await bd.owner.query('UPDATE operadores SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [o.id]);
    const a = await L(PW_OP);
    expect(a.statusCode).toBe(200);
    const pend = String(a.headers['set-cookie']).split(';')[0]!;
    const rs = await Promise.all(Array.from({ length: 60 }, () => app.inject({ method: 'POST', url: '/api/consola/auth/2fa', headers: { cookie: pend }, payload: { codigo: '000000' } })));
    expect(rs.every((r) => r.statusCode === 401)).toBe(true);
    const g = (await bd.owner.query('SELECT intentos_fallidos, bloqueado_hasta FROM operadores WHERE id = $1', [o.id])).rows[0];
    expect(g.intentos_fallidos).toBe(5);
    expect(g.bloqueado_hasta).not.toBeNull();
  }, 60_000);

  it('un código ya usado no sirve otra vez para entrar', async () => {
    const o = await nuevoOperador();
    const a = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: o.email, password: PW_OP } });
    const pend = String(a.headers['set-cookie']).split(';')[0]!;
    const c = codigo(o.email);
    expect((await app.inject({ method: 'POST', url: '/api/consola/auth/2fa', headers: { cookie: pend }, payload: { codigo: c } })).statusCode).toBe(200);
    const a2 = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: o.email, password: PW_OP } });
    const pend2 = String(a2.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ method: 'POST', url: '/api/consola/auth/2fa', headers: { cookie: pend2 }, payload: { codigo: c } })).statusCode).toBe(401);
  });

  it('la sesión de un cliente no abre la consola y la del equipo no abre el panel del cliente', async () => {
    const o = await nuevoOperador();
    const org = await nuevaOrg();
    const cliente = await sesionCliente(org.email);
    const equipo = await entrar(o.email);
    for (const url of ['/api/consola/resumen', '/api/consola/clientes', '/api/consola/yo', '/api/consola/bitacora']) {
      expect((await api(cliente, 'GET', url)).statusCode).toBe(401);
    }
    // la cookie del cliente con el nombre de la cookie del equipo tampoco sirve (son tokens de tablas distintas)
    const falsa = `archie_op=${cliente.split('=')[1]}`;
    expect((await api(falsa, 'GET', '/api/consola/yo')).statusCode).toBe(401);
    const comoCliente = `archie_sid=${equipo.split('=')[1]}`;
    expect((await api(comoCliente, 'GET', '/api/panel/resumen')).statusCode).toBe(401);
  });

  it('la aplicación no puede leer ni escribir las tablas de operadores, ni ejecutar funciones con un token ajeno', async () => {
    await expect(bd.app.query('SELECT * FROM operadores')).rejects.toThrow(/permission denied/);
    await expect(bd.app.query('SELECT * FROM sesiones_operador')).rejects.toThrow(/permission denied/);
    await expect(bd.app.query('INSERT INTO acciones_operador (org_id, operador_nombre, accion, detalle) VALUES (gen_random_uuid(),\'x\',\'x_x\',\'x\')')).rejects.toThrow(/permission denied/);
    await expect(bd.app.query("UPDATE organizaciones SET plan_id = 'profesional'")).rejects.toThrow(/permission denied/);
    await expect(bd.app.query('SELECT consola_validar($1, ARRAY[\'admin\'], false)', [randomBytes(32)])).rejects.toThrow(/permission denied/);
    await expect(bd.app.query('SELECT consola_clientes($1, NULL, NULL, 10)', [randomBytes(32)])).rejects.toMatchObject({ code: '42501' });
    await expect(bd.app.query("SELECT consola_cambiar_estado($1, gen_random_uuid(), 'baja')", [randomBytes(32)])).rejects.toMatchObject({ code: '42501' });
  });

  // ---------- Lecturas ----------

  it('lista clientes con saldo y estado; filtra y busca sin interpretar comodines', async () => {
    const o = await nuevoOperador('soporte');
    const a = await nuevaOrg();
    const b = await nuevaOrg('basico');
    await dueno(b.orgId, "UPDATE organizaciones SET estado = 'suspendido', activa = false WHERE id = $1", [b.orgId]);
    const c = await entrar(o.email);
    const todos = (await api(c, 'GET', '/api/consola/clientes')).json() as Array<{ id: string; estado: string; saldo: number; plan: string }>;
    expect(todos.find((x) => x.id === a.orgId)).toMatchObject({ estado: 'prueba', saldo: 100, plan: 'Prueba' });
    expect(todos.find((x) => x.id === b.orgId)).toMatchObject({ estado: 'suspendido', saldo: 300 });
    const susp = (await api(c, 'GET', '/api/consola/clientes?filtro=suspendido')).json() as Array<{ id: string }>;
    expect(susp.some((x) => x.id === b.orgId)).toBe(true);
    expect(susp.some((x) => x.id === a.orgId)).toBe(false);
    const comodin = (await api(c, 'GET', '/api/consola/clientes?busca=%25')).json() as unknown[];
    expect(comodin).toEqual([]); // "%" se busca como texto, no como comodín
    const porCorreo = (await api(c, 'GET', `/api/consola/clientes?busca=${encodeURIComponent(a.email)}`)).json() as Array<{ id: string }>;
    expect(porCorreo.map((x) => x.id)).toEqual([a.orgId]);
    expect((await api(c, 'GET', '/api/consola/clientes?filtro=otro')).statusCode).toBe(400);
    const resumen = (await api(c, 'GET', '/api/consola/resumen')).json();
    expect(resumen).toMatchObject({ suspendidos: expect.any(Number), consultasMes: expect.any(Number) });
    const ficha = (await api(c, 'GET', `/api/consola/clientes/${a.orgId}`)).json();
    expect(ficha).toMatchObject({ id: a.orgId, saldo: 100, plan: { id: 'prueba' }, modo: 'autoservicio' });
    expect(ficha.equipo[0]).toMatchObject({ email: a.email, rol: 'admin' });
    expect(JSON.stringify(ficha)).not.toMatch(/password|totp_secreto/i);
    expect((await api(c, 'GET', `/api/consola/clientes/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).statusCode).toBe(404);
  });

  // ---------- Acciones sensibles ----------

  it('toda escritura pide un código: sin código no entra, con código malo cuenta como fallo, con código bueno se ejecuta', async () => {
    const o = await nuevoOperador();
    const org = await nuevaOrg();
    const c = await entrar(o.email);
    const url = `/api/consola/clientes/${org.orgId}/saldo`;
    expect((await api(c, 'POST', url, { cantidad: 500, tipo: 'recarga' })).statusCode).toBe(400);
    expect((await api(c, 'POST', url, { cantidad: 500, tipo: 'recarga', codigo: '000000' })).json()).toMatchObject({ error: 'codigo_invalido' });
    expect(await saldo(org.orgId)).toBe(100);
    const r = await api(c, 'POST', url, { cantidad: 500, tipo: 'recarga', codigo: codigo(o.email) });
    expect(r.json()).toEqual({ saldo: 600 });
    expect(await saldo(org.orgId)).toBe(600);
  });

  it('un código sirve para UNA acción: repetirlo falla y dos acciones simultáneas con el mismo código no se ejecutan las dos', async () => {
    const o = await nuevoOperador();
    const org = await nuevaOrg();
    const c = await entrar(o.email);
    const url = `/api/consola/clientes/${org.orgId}/saldo`;
    const cod = codigo(o.email);
    const [r1, r2] = await Promise.all([
      api(c, 'POST', url, { cantidad: 10, tipo: 'recarga', codigo: cod }),
      api(c, 'POST', url, { cantidad: 10, tipo: 'recarga', codigo: cod }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 401]);
    expect(await saldo(org.orgId)).toBe(110);
    expect((await api(c, 'POST', url, { cantidad: 10, tipo: 'recarga', codigo: cod })).statusCode).toBe(401);
    expect(await saldo(org.orgId)).toBe(110);
  });

  it('una autorización a medias no permite saltarse el código: la base exige el código nuevo en cada función', async () => {
    const o = await nuevoOperador();
    const org = await nuevaOrg();
    const c = await entrar(o.email);
    const token = c.split('=')[1]!;
    const { createHash } = await import('node:crypto');
    // hash del token, igual que hace la aplicación; llamada directa a la función sin pasar por la reautenticación
    const hash = createHash('sha256').update(token).digest();
    await expect(bd.app.query("SELECT consola_agregar_saldo($1,$2,50,'recarga',NULL)", [hash, org.orgId])).rejects.toMatchObject({ code: '42501', message: 'requiere_codigo' });
    expect(await saldo(org.orgId)).toBe(100);
  });

  it('recarga y ajuste: validaciones, saldo nunca negativo y todo queda en la bitácora que el cliente ve con el nombre del operador', async () => {
    const o = await nuevoOperador();
    const org = await nuevaOrg();
    const c = await entrar(o.email);
    const url = `/api/consola/clientes/${org.orgId}/saldo`;
    expect((await api(c, 'POST', url, { cantidad: -5, tipo: 'recarga', codigo: codigo(o.email) })).json()).toMatchObject({ error: 'datos_invalidos' });
    expect((await api(c, 'POST', url, { cantidad: -5, tipo: 'ajuste', codigo: codigo(o.email) })).json()).toMatchObject({ error: 'datos_invalidos' }); // ajuste sin motivo
    expect((await api(c, 'POST', url, { cantidad: -500, tipo: 'ajuste', motivo: 'corrección', codigo: codigo(o.email) })).json()).toMatchObject({ error: 'saldo_negativo' });
    expect((await api(c, 'POST', url, { cantidad: -20, tipo: 'ajuste', motivo: 'corrección de una prueba', codigo: codigo(o.email) })).json()).toEqual({ saldo: 80 });
    await api(c, 'POST', url, { cantidad: 500, tipo: 'recarga', codigo: codigo(o.email) });
    const clienteCookie = await sesionCliente(org.email);
    const bit = (await api(clienteCookie, 'GET', '/api/panel/bitacora-equipo')).json() as Array<{ quien: string; detalle: string; accion: string }>;
    expect(bit.map((x) => x.quien)).toEqual([`Operador ${n - 1}`, `Operador ${n - 1}`].map(() => bit[0]!.quien));
    expect(bit[0]).toMatchObject({ detalle: 'Agregó 500 consultas al saldo', accion: 'saldo_recarga' });
    expect(bit[1]!.detalle).toContain('Quitó 20 consultas');
    expect(bit[0]!.quien).toMatch(/^Operador \d+$/);
    // el cliente ve el saldo nuevo en su panel
    const consumo = (await api(clienteCookie, 'GET', '/api/panel/consumo')).json();
    expect(consumo.estado.saldo).toBe(580);
  });

  it('un cliente solo ve la bitácora de SU cuenta', async () => {
    const o = await nuevoOperador();
    const a = await nuevaOrg();
    const b = await nuevaOrg();
    const c = await entrar(o.email);
    await api(c, 'POST', `/api/consola/clientes/${a.orgId}/saldo`, { cantidad: 7, tipo: 'recarga', codigo: codigo(o.email) });
    const deB = (await api(await sesionCliente(b.email), 'GET', '/api/panel/bitacora-equipo')).json();
    expect(deB).toEqual([]);
    const deA = (await api(await sesionCliente(a.email), 'GET', '/api/panel/bitacora-equipo')).json() as unknown[];
    expect(deA.length).toBe(1);
  });

  it('suspender cierra las sesiones del cliente y le impide entrar; reactivar lo devuelve', async () => {
    const o = await nuevoOperador();
    const org = await nuevaOrg();
    const cliente = await sesionCliente(org.email);
    expect((await api(cliente, 'GET', '/api/panel/resumen')).statusCode).toBe(200);
    const c = await entrar(o.email);
    const url = `/api/consola/clientes/${org.orgId}/estado`;
    expect((await api(c, 'POST', url, { estado: 'suspendido', codigo: codigo(o.email) })).statusCode).toBe(200);
    expect(await estadoOrg(org.orgId)).toMatchObject({ estado: 'suspendido', activa: false });
    expect((await api(cliente, 'GET', '/api/panel/resumen')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: org.email, password: PW } })).statusCode).toBe(401);
    expect((await api(c, 'POST', url, { estado: 'activo', codigo: codigo(o.email) })).statusCode).toBe(200);
    expect(await estadoOrg(org.orgId)).toMatchObject({ estado: 'activo', activa: true });
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: org.email, password: PW } })).statusCode).toBe(200);
  });

  it('cambia plan, modo y autonomía, y rechaza valores inválidos', async () => {
    const o = await nuevoOperador();
    const org = await nuevaOrg();
    const c = await entrar(o.email);
    const base = `/api/consola/clientes/${org.orgId}`;
    expect((await api(c, 'POST', `${base}/plan`, { plan: 'profesional', codigo: codigo(o.email) })).statusCode).toBe(200);
    expect((await api(c, 'POST', `${base}/plan`, { plan: 'noexiste', codigo: codigo(o.email) })).json()).toMatchObject({ error: 'plan_invalido' });
    expect((await api(c, 'POST', `${base}/modo`, { modo: 'gestionada', codigo: codigo(o.email) })).statusCode).toBe(200);
    expect((await api(c, 'POST', `${base}/autonomia`, { autonomia: 'confirmacion', codigo: codigo(o.email) })).statusCode).toBe(200);
    expect((await api(c, 'POST', `${base}/modo`, { modo: 'otro', codigo: codigo(o.email) })).statusCode).toBe(400);
    expect(await estadoOrg(org.orgId)).toMatchObject({ plan_id: 'profesional', modo: 'gestionada', autonomia: 'confirmacion' });
  });

  it('restablecer el 2FA de un cliente solo con modo gestionada o asistencia activa; el cliente puede terminar la asistencia', async () => {
    const o = await nuevoOperador('soporte');
    const org = await nuevaOrg();
    await dueno(org.orgId, "UPDATE usuarios SET totp_activo = true, totp_secreto = '\\x00'::bytea, totp_clave_version = 1 WHERE id = $1", [org.usuarioId]);
    const c = await entrar(o.email);
    const base = `/api/consola/clientes/${org.orgId}`;
    const reset = () => api(c, 'POST', `${base}/resetear-2fa`, { usuarioId: org.usuarioId, codigo: codigo(o.email) });
    expect((await reset()).json()).toMatchObject({ error: 'requiere_asistencia' });
    const as = await api(c, 'POST', `${base}/asistencia`, { horas: 24, codigo: codigo(o.email) });
    expect(as.statusCode).toBe(200);
    const sesion = await sesionCliente(org.email); // sin 2FA real: entra directo para ver el aviso
    await dueno(org.orgId, 'UPDATE usuarios SET totp_activo = false WHERE id = $1', [org.usuarioId]);
    expect((await api(sesion, 'GET', '/api/panel/resumen')).json().asistenciaHasta).not.toBeNull();
    await dueno(org.orgId, 'UPDATE usuarios SET totp_activo = true WHERE id = $1', [org.usuarioId]);
    expect((await reset()).statusCode).toBe(200);
    const u = (await dueno(org.orgId, 'SELECT totp_activo, totp_secreto FROM usuarios WHERE id = $1', [org.usuarioId])).rows[0];
    expect(u).toMatchObject({ totp_activo: false, totp_secreto: null });
    // el cliente termina la asistencia
    const nueva = await sesionCliente(org.email);
    expect((await api(nueva, 'POST', '/api/panel/asistencia/terminar')).json()).toEqual({ estado: 'ok' });
    expect((await estadoOrg(org.orgId)).asistencia_hasta).toBeNull();
    const bit = (await api(nueva, 'GET', '/api/panel/bitacora-equipo')).json() as Array<{ accion: string; quien: string }>;
    expect(bit.map((x) => x.accion)).toEqual(['asistencia_terminada', 'dos_pasos_reseteado', 'asistencia_activada']);
    expect(bit[0]!.quien).toBe('El cliente');
  });

  it('un miembro (no administrador) del cliente no puede terminar la asistencia', async () => {
    const org = await nuevaOrg();
    const email = `m${++n}@cliente.test`;
    await conOrg(bd.owner, org.orgId, async (cx) => cx.query(
      "INSERT INTO usuarios (org_id, email, password_hash, rol) VALUES ($1,$2,$3,'miembro')", [org.orgId, email, await hashPassword(PW)]));
    const cookie = await sesionCliente(email);
    expect((await api(cookie, 'POST', '/api/panel/asistencia/terminar')).statusCode).toBe(403);
  });

  it('los roles limitan: soporte no mueve saldo ni suspende; finanzas no suspende ni cambia modo; solo admin crea clientes', async () => {
    const org = await nuevaOrg();
    const sop = await nuevoOperador('soporte');
    const fin = await nuevoOperador('finanzas');
    const cs = await entrar(sop.email);
    const cf = await entrar(fin.email);
    const base = `/api/consola/clientes/${org.orgId}`;
    expect((await api(cs, 'POST', `${base}/saldo`, { cantidad: 5, tipo: 'recarga', codigo: codigo(sop.email) })).statusCode).toBe(403);
    expect((await api(cs, 'POST', `${base}/estado`, { estado: 'baja', codigo: codigo(sop.email) })).statusCode).toBe(403);
    expect((await api(cf, 'POST', `${base}/estado`, { estado: 'baja', codigo: codigo(fin.email) })).statusCode).toBe(403);
    expect((await api(cf, 'POST', `${base}/modo`, { modo: 'gestionada', codigo: codigo(fin.email) })).statusCode).toBe(403);
    expect((await api(cf, 'POST', '/api/consola/clientes', { nombre: 'X', email: 'x@x.test', codigo: codigo(fin.email) })).statusCode).toBe(403);
    expect((await api(cf, 'POST', `${base}/saldo`, { cantidad: 5, tipo: 'recarga', codigo: codigo(fin.email) })).statusCode).toBe(200);
    expect(await estadoOrg(org.orgId)).toMatchObject({ estado: 'prueba' });
  });

  it('crea un cliente e invita a su administrador por correo (sin contraseñas temporales); el correo no se puede repetir', async () => {
    const o = await nuevoOperador();
    const c = await entrar(o.email);
    const correo = `nuevo${++n}@cliente.test`;
    const aClientes = () => correoPrueba.enviados.filter((m) => !m.asunto.startsWith('Consola de Archie AI'));  // las alertas al equipo se prueban aparte
    const antes = aClientes().length;
    const r = await api(c, 'POST', '/api/consola/clientes', { nombre: 'Clínica Nueva', email: correo, nombreAdmin: 'Sonia', plan: 'basico', codigo: codigo(o.email) });
    expect(r.statusCode).toBe(200);
    const cuerpo = r.json() as { orgId: string; passwordTemporal?: string; invitacion: { enviada: boolean; enlace?: string } };
    expect(cuerpo.passwordTemporal).toBeUndefined();
    expect(cuerpo.invitacion.enviada).toBe(true);
    expect(cuerpo.invitacion.enlace).toBeUndefined(); // el enlace solo se devuelve en desarrollo con correo de consola
    expect(aClientes().length).toBe(antes + 1);
    expect(aClientes().at(-1)).toMatchObject({ para: correo });
    expect(await saldo(cuerpo.orgId)).toBe(300);
    // Aún no existe ninguna cuenta: no se puede entrar hasta aceptar la invitación.
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: correo, password: PW } })).statusCode).toBe(401);
    expect((await api(c, 'POST', '/api/consola/clientes', { nombre: 'Otra', email: correo, codigo: codigo(o.email) })).statusCode).toBe(409);
    const bit = (await api(c, 'GET', '/api/consola/bitacora')).json() as Array<{ accion: string; cliente: string }>;
    expect(bit.find((x) => x.accion === 'cliente_creado')).toMatchObject({ cliente: 'Clínica Nueva' });
  });

  it('cerrar sesión mata la sesión del equipo y la consola nunca expone una ruta para entrar como un cliente', async () => {
    const o = await nuevoOperador();
    const c = await entrar(o.email);
    expect((await api(c, 'POST', '/api/consola/auth/logout')).statusCode).toBe(200);
    expect((await api(c, 'GET', '/api/consola/yo')).statusCode).toBe(401);
    const c2 = await entrar(o.email);
    for (const url of ['/api/consola/entrar-como', '/api/consola/suplantar', '/api/consola/clientes/x/entrar']) {
      expect((await api(c2, 'POST', url, {})).statusCode).toBe(404);
    }
  });

  it('operador desactivado pierde el acceso al instante', async () => {
    const o = await nuevoOperador();
    const c = await entrar(o.email);
    await bd.owner.query('UPDATE operadores SET activo = false WHERE id = $1', [o.id]);
    expect((await api(c, 'GET', '/api/consola/yo')).statusCode).toBe(401);
  });
  it('la lista de planes sale de la base de datos y solo la ve un operador con sesión completa', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/consola/planes' })).statusCode).toBe(401);
    const o = await nuevoOperador('soporte');
    const c = await entrar(o.email);
    const r = await api(c, 'GET', '/api/consola/planes');
    expect(r.statusCode).toBe(200);
    expect(r.json().map((p: any) => p.id)).toEqual(['prueba', 'basico', 'profesional']);
    expect(r.json()[0]).toMatchObject({ nombre: 'Prueba', cuotaMensual: 100, topeDiario: 50 });
    await bd.owner.query("UPDATE planes SET activo = false WHERE id = 'basico'");
    expect((await api(c, 'GET', '/api/consola/planes')).json().map((p: any) => p.id)).toEqual(['prueba', 'profesional']);
    await bd.owner.query("UPDATE planes SET activo = true WHERE id = 'basico'");
    // la aplicación (sin token de operador) no puede ejecutar la función
    await expect(bd.app.query("SELECT consola_planes('\\x00'::bytea)")).rejects.toThrow();
  });
});

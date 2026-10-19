import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { codigoActual } from '../src/auth/totp.js';
import { cargarConfig } from '../src/config.js';
import { CorreoMemoria } from '../src/correo/correo.js';
import { cargarLlaves } from '../src/crypto.js';
import { crearOperador } from '../src/db/operadores.js';
import { conOrg } from '../src/db/pool.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';
const PW_NUEVA = 'otra-clave-muy-larga-2';
const PW_OP = 'clave-del-equipo-muy-larga-1';
const ORIGEN = 'https://archie.ejemplo.test';

describe.skipIf(!hay)('invitaciones y equipo del cliente', () => {
  let bd: BdPrueba;
  let app: FastifyInstance;
  let ahora = Date.now();
  let n = 0;
  const correo = new CorreoMemoria();
  const sinAlertas = () => correo.enviados.filter((x) => !x.asunto.startsWith('Consola de Archie AI')); // las alertas al equipo se prueban aparte
  const secretos = new Map<string, string>();

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_ORIGEN: ORIGEN }), {
      pool: bd.app, llaves, correo, relojConsola: () => ahora,
      rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } },
    });
  }, 60_000);
  afterAll(async () => { await app?.close(); await bd?.cerrar(); });

  const codigo = (email: string) => { ahora += 30_000; return codigoActual(secretos.get(email)!, ahora); };
  const tokenDelUltimoCorreo = () => {
    const m = /#t=([A-Za-z0-9_-]{43})/.exec(sinAlertas().at(-1)!.texto);
    expect(m).not.toBeNull();
    return m![1]!;
  };

  async function operador() {
    const email = `op${++n}@archie.test`;
    const r = await crearOperador(bd.owner, llaves, { email, nombre: `Operador ${n}`, rol: 'admin', password: PW_OP });
    secretos.set(email, r.secretoTotp);
    const a = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email, password: PW_OP } });
    const pend = String(a.headers['set-cookie']).split(';')[0]!;
    const b = await app.inject({ method: 'POST', url: '/api/consola/auth/2fa', headers: { cookie: pend }, payload: { codigo: codigo(email) } });
    return { email, cookie: String(b.headers['set-cookie']).split(';')[0]! };
  }
  const consola = (o: { cookie: string }, url: string, payload: object) => app.inject({ method: 'POST', url, headers: { cookie: o.cookie }, payload });

  /** Cliente con una persona administradora ya activa (sin pasar por invitación). */
  async function cliente() {
    const email = `admin${++n}@cliente.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Cliente ${n}`, email, password: PW, nombreAdmin: `Admin ${n}` });
    return { email, orgId: r.orgId, cookie: await entrar(email, PW) };
  }
  async function entrar(email: string, password: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    expect(r.statusCode).toBe(200);
    return String(r.headers['set-cookie']).split(';')[0]!;
  }
  const panel = (cookie: string, metodo: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method: metodo, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const publica = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

  /** El administrador invita a alguien y esa persona acepta. Devuelve el correo y la cookie de su sesión. */
  async function sumar(admin: { cookie: string }, email: string, rol: 'admin' | 'miembro') {
    const r = await panel(admin.cookie, 'POST', '/api/panel/equipo/invitaciones', { email, rol });
    expect(r.statusCode).toBe(200);
    const a = await publica('/api/invitaciones/aceptar', { token: tokenDelUltimoCorreo(), nombre: `Persona ${++n}`, password: PW_NUEVA });
    expect(a.statusCode).toBe(200);
    return { email, cookie: await entrar(email, PW_NUEVA) };
  }

  it('el alta de cliente envía una invitación; aceptarla crea la cuenta y el enlace sirve una sola vez', async () => {
    const o = await operador();
    const email = `nuevo${++n}@cliente.test`;
    const antes = sinAlertas().length;
    const r = await consola(o, '/api/consola/clientes', { nombre: 'Clínica Sol', email, nombreAdmin: 'Sonia', plan: 'basico', codigo: codigo(o.email) });
    expect(r.statusCode).toBe(200);
    expect(sinAlertas().length).toBe(antes + 1);
    const msg = sinAlertas().at(-1)!;
    expect(msg.para).toBe(email);
    expect(msg.texto).toContain(`${ORIGEN}/invitacion#t=`);
    expect(msg.html).toContain('Crear mi contraseña');
    const token = tokenDelUltimoCorreo();

    const v = await publica('/api/invitaciones/ver', { token });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ organizacion: 'Clínica Sol', email, rol: 'admin', nombreSugerido: 'Sonia', yaTieneCuenta: false });

    // Contraseña débil: no gasta la invitación.
    expect((await publica('/api/invitaciones/aceptar', { token, nombre: 'Sonia', password: 'corta' })).statusCode).toBe(400);
    expect((await publica('/api/invitaciones/ver', { token })).statusCode).toBe(200);

    expect((await publica('/api/invitaciones/aceptar', { token, nombre: 'Sonia', password: PW_NUEVA })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW_NUEVA } })).statusCode).toBe(200);
    // Un solo uso.
    expect((await publica('/api/invitaciones/aceptar', { token, nombre: 'Otra', password: PW_NUEVA })).statusCode).toBe(404);
    expect((await publica('/api/invitaciones/ver', { token })).statusCode).toBe(404);
  });

  it('el enlace en el token no sirve si está mal formado, y las peticiones de otros sitios se rechazan', async () => {
    expect((await publica('/api/invitaciones/ver', { token: 'corto' })).statusCode).toBe(400);
    expect((await publica('/api/invitaciones/ver', { token: 'x'.repeat(43), extra: 1 })).statusCode).toBe(400);
    expect((await publica('/api/invitaciones/ver', { token: 'A'.repeat(43) })).statusCode).toBe(404); // formato válido pero inexistente
    const otroSitio = await app.inject({ method: 'POST', url: '/api/invitaciones/ver', headers: { origin: 'https://malo.test' }, payload: { token: 'A'.repeat(43) } });
    expect(otroSitio.statusCode).toBe(403);
  });

  it('una invitación vencida o revocada no se puede ver ni aceptar', async () => {
    const adm = await cliente();
    // Vencida (se adelanta el vencimiento con el rol dueño: la aplicación no puede cambiarlo).
    await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: `vence${++n}@cliente.test`, rol: 'miembro' });
    const tVence = tokenDelUltimoCorreo();
    await conOrg(bd.owner, adm.orgId, (c) => c.query(`UPDATE invitaciones SET expira_en = now() - interval '1 minute' WHERE org_id = $1`, [adm.orgId]));
    expect((await publica('/api/invitaciones/ver', { token: tVence })).statusCode).toBe(404);
    expect((await publica('/api/invitaciones/aceptar', { token: tVence, nombre: 'X', password: PW_NUEVA })).statusCode).toBe(404);

    // Revocada.
    const email = `revoca${++n}@cliente.test`;
    await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email, rol: 'miembro' });
    const tRevoca = tokenDelUltimoCorreo();
    const lista = (await panel(adm.cookie, 'GET', '/api/panel/equipo')).json() as { invitaciones: Array<{ id: string; email: string; estado: string }> };
    const fila = lista.invitaciones.find((i) => i.email === email)!;
    expect(fila.estado).toBe('pendiente');
    expect((await panel(adm.cookie, 'POST', `/api/panel/equipo/invitaciones/${fila.id}/revocar`)).statusCode).toBe(200);
    expect((await publica('/api/invitaciones/aceptar', { token: tRevoca, nombre: 'X', password: PW_NUEVA })).statusCode).toBe(404);
    expect((await panel(adm.cookie, 'POST', `/api/panel/equipo/invitaciones/${fila.id}/revocar`)).statusCode).toBe(404); // ya no está pendiente
  });

  it('con cinco aceptaciones simultáneas del mismo enlace solo una gana', async () => {
    const adm = await cliente();
    await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: `carrera${++n}@cliente.test`, rol: 'miembro' });
    const token = tokenDelUltimoCorreo();
    const r = await Promise.all(Array.from({ length: 5 }, () => publica('/api/invitaciones/aceptar', { token, nombre: 'Carrera', password: PW_NUEVA })));
    expect(r.filter((x) => x.statusCode === 200)).toHaveLength(1);
    expect(r.filter((x) => x.statusCode === 404)).toHaveLength(4);
    const eq = (await panel(adm.cookie, 'GET', '/api/panel/equipo')).json() as { miembros: unknown[] };
    expect(eq.miembros).toHaveLength(2);
  });

  it('el equipo de Archie reenvía la invitación: el enlace anterior deja de servir y el nuevo funciona', async () => {
    const o = await operador();
    const email = `reenvio${++n}@cliente.test`;
    const r = await consola(o, '/api/consola/clientes', { nombre: 'Clínica Luna', email, codigo: codigo(o.email) });
    const { orgId } = r.json() as { orgId: string };
    const viejo = tokenDelUltimoCorreo();
    // Sin código nuevo no se puede.
    expect((await consola(o, `/api/consola/clientes/${orgId}/reenviar-invitacion`, { codigo: '000000' })).statusCode).toBe(401);
    const re = await consola(o, `/api/consola/clientes/${orgId}/reenviar-invitacion`, { codigo: codigo(o.email) });
    expect(re.statusCode).toBe(200);
    expect(re.json()).toMatchObject({ enviada: true });
    const nuevo = tokenDelUltimoCorreo();
    expect(nuevo).not.toBe(viejo);
    expect(sinAlertas().at(-1)!.para).toBe(email);
    expect((await publica('/api/invitaciones/ver', { token: viejo })).statusCode).toBe(404);
    expect((await publica('/api/invitaciones/aceptar', { token: nuevo, nombre: 'Luna', password: PW_NUEVA })).statusCode).toBe(200);
    // Ya aceptada: no hay nada que reenviar.
    expect((await consola(o, `/api/consola/clientes/${orgId}/reenviar-invitacion`, { codigo: codigo(o.email) })).statusCode).toBe(404);
    // La ficha muestra el estado de las invitaciones (nunca el token) y la bitácora del cliente registra el reenvío.
    const ficha = (await app.inject({ method: 'GET', url: `/api/consola/clientes/${orgId}`, headers: { cookie: o.cookie } })).json() as { invitaciones: Array<{ estado: string }>; bitacora: Array<{ accion: string }> };
    expect(ficha.invitaciones.map((i) => i.estado).sort()).toEqual(['aceptada', 'revocada']);
    expect(ficha.bitacora.some((b) => b.accion === 'invitacion_reenviada')).toBe(true);
    expect(JSON.stringify(ficha)).not.toContain(nuevo);
  });

  it('si el correo falla, la cuenta queda creada y la invitación se puede reenviar', async () => {
    const o = await operador();
    correo.falla = true;
    let r;
    try { r = await consola(o, '/api/consola/clientes', { nombre: 'Clínica Fallo', email: `fallo${++n}@cliente.test`, codigo: codigo(o.email) }); } finally { correo.falla = false; }
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ invitacion: { enviada: false } });
    const { orgId } = r.json() as { orgId: string };
    const re = await consola(o, `/api/consola/clientes/${orgId}/reenviar-invitacion`, { codigo: codigo(o.email) });
    expect(re.json()).toMatchObject({ enviada: true });
  });

  it('un administrador del cliente invita a su equipo; los miembros no pueden administrar', async () => {
    const adm = await cliente();
    const miembro = await sumar(adm, `miembro${++n}@cliente.test`, 'miembro');
    expect(sinAlertas().at(-1)!.asunto).toContain('te invitó a');
    const lista = (await panel(miembro.cookie, 'GET', '/api/panel/equipo')).json() as { puedeAdministrar: boolean; miembros: Array<{ email: string; rol: string; yo: boolean }> };
    expect(lista.puedeAdministrar).toBe(false);
    expect(lista.miembros).toHaveLength(2);
    expect(lista.miembros.find((m) => m.yo)).toMatchObject({ email: miembro.email, rol: 'miembro' });
    const pw = (u: string, p?: object) => panel(miembro.cookie, 'POST', u, p);
    expect((await pw('/api/panel/equipo/invitaciones', { email: 'otro@cliente.test', rol: 'miembro' })).statusCode).toBe(403);
    const adminId = (await panel(adm.cookie, 'GET', '/api/panel/equipo')).json().miembros.find((m: { email: string }) => m.email === adm.email).id as string;
    expect((await pw(`/api/panel/equipo/miembros/${adminId}`, { activo: false })).statusCode).toBe(403);
    // La respuesta de la lista nunca incluye el token ni su hash.
    expect(JSON.stringify(lista)).not.toMatch(/token/i);
  });

  it('no se puede invitar a quien ya está en el equipo, y reinvitar reemplaza el enlace anterior', async () => {
    const adm = await cliente();
    expect((await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: adm.email, rol: 'miembro' })).statusCode).toBe(409);
    const email = `doble${++n}@cliente.test`;
    await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email, rol: 'miembro' });
    const t1 = tokenDelUltimoCorreo();
    await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: email.toUpperCase(), rol: 'admin' });
    const t2 = tokenDelUltimoCorreo();
    expect((await publica('/api/invitaciones/ver', { token: t1 })).statusCode).toBe(404);
    expect((await publica('/api/invitaciones/ver', { token: t2 })).json()).toMatchObject({ rol: 'admin', email });
  });

  it('un correo que ya tiene cuenta en otra organización no puede aceptar: el error es claro y la invitación sigue pendiente', async () => {
    const otra = await cliente();
    const adm = await cliente();
    // Quien invita no se entera de si el correo existe en otra organización (no hay forma de averiguarlo desde su cuenta).
    const r = await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: otra.email, rol: 'miembro' });
    expect(r.statusCode).toBe(200);
    const token = tokenDelUltimoCorreo();
    expect((await publica('/api/invitaciones/ver', { token })).json()).toMatchObject({ yaTieneCuenta: true });
    const a = await publica('/api/invitaciones/aceptar', { token, nombre: 'Doble', password: PW_NUEVA });
    expect(a.statusCode).toBe(409);
    expect(a.json()).toMatchObject({ error: 'ya_existe' });
    expect((await publica('/api/invitaciones/ver', { token })).statusCode).toBe(200); // todo se deshizo
  });

  it('el equipo de Archie no puede dar de alta un cliente con un correo que ya tiene cuenta o invitación pendiente', async () => {
    const o = await operador();
    const existente = await cliente();
    expect((await consola(o, '/api/consola/clientes', { nombre: 'Repetido', email: existente.email, codigo: codigo(o.email) })).statusCode).toBe(409);
  });

  it('una organización no puede ver ni tocar las invitaciones ni las personas de otra', async () => {
    const a = await cliente();
    const b = await cliente();
    await panel(a.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: `pendiente${++n}@cliente.test`, rol: 'miembro' });
    const delA = (await panel(a.cookie, 'GET', '/api/panel/equipo')).json() as { invitaciones: Array<{ id: string }>; miembros: Array<{ id: string }> };
    const idInv = delA.invitaciones[0]!.id;
    const idUsuarioA = delA.miembros[0]!.id;
    expect(((await panel(b.cookie, 'GET', '/api/panel/equipo')).json() as { invitaciones: unknown[] }).invitaciones).toHaveLength(0);
    expect((await panel(b.cookie, 'POST', `/api/panel/equipo/invitaciones/${idInv}/revocar`)).statusCode).toBe(404);
    expect((await panel(b.cookie, 'POST', `/api/panel/equipo/invitaciones/${idInv}/reenviar`)).statusCode).toBe(404);
    expect((await panel(b.cookie, 'POST', `/api/panel/equipo/miembros/${idUsuarioA}`, { activo: false })).statusCode).toBe(404);
    // Sigue pendiente y la persona de A sigue activa.
    expect(((await panel(a.cookie, 'GET', '/api/panel/equipo')).json() as { invitaciones: Array<{ estado: string }> }).invitaciones[0]!.estado).toBe('pendiente');
  });

  it('desactivar a alguien cierra sus sesiones; nadie se cambia a sí mismo; reactivar y cambiar rol funcionan', async () => {
    const adm = await cliente();
    const m = await sumar(adm, `baja${++n}@cliente.test`, 'miembro');
    const id = ((await panel(adm.cookie, 'GET', '/api/panel/equipo')).json() as { miembros: Array<{ id: string; email: string }> }).miembros.find((x) => x.email === m.email)!.id;
    const yoId = ((await panel(adm.cookie, 'GET', '/api/panel/equipo')).json() as { miembros: Array<{ id: string; yo: boolean }> }).miembros.find((x) => x.yo)!.id;
    expect((await panel(adm.cookie, 'POST', `/api/panel/equipo/miembros/${yoId}`, { activo: false })).statusCode).toBe(409);
    expect((await panel(adm.cookie, 'POST', `/api/panel/equipo/miembros/${yoId}`, { rol: 'miembro' })).statusCode).toBe(409);
    expect((await panel(m.cookie, 'GET', '/api/panel/equipo')).statusCode).toBe(200);
    expect((await panel(adm.cookie, 'POST', `/api/panel/equipo/miembros/${id}`, { activo: false })).statusCode).toBe(200);
    expect((await panel(m.cookie, 'GET', '/api/panel/equipo')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: m.email, password: PW_NUEVA } })).statusCode).toBe(401);
    expect((await panel(adm.cookie, 'POST', `/api/panel/equipo/miembros/${id}`, { activo: true, rol: 'admin' })).statusCode).toBe(200);
    const cookie2 = await entrar(m.email, PW_NUEVA);
    expect((await panel(cookie2, 'GET', '/api/panel/equipo')).json()).toMatchObject({ puedeAdministrar: true });
    expect((await panel(adm.cookie, 'POST', `/api/panel/equipo/miembros/${id}`, {})).statusCode).toBe(400); // no pide nada
  });

  it('con dos administradores que se desactivan a la vez, siempre queda uno activo', async () => {
    const a = await cliente();
    const b = await sumar(a, `adm2-${++n}@cliente.test`, 'admin');
    const idsDe = async (cookie: string) => (await panel(cookie, 'GET', '/api/panel/equipo')).json() as { miembros: Array<{ id: string; email: string }> };
    const ids = await idsDe(a.cookie);
    const idA = ids.miembros.find((x) => x.email === a.email)!.id;
    const idB = ids.miembros.find((x) => x.email === b.email)!.id;
    const [r1, r2] = await Promise.all([
      panel(a.cookie, 'POST', `/api/panel/equipo/miembros/${idB}`, { activo: false }),
      panel(b.cookie, 'POST', `/api/panel/equipo/miembros/${idA}`, { activo: false }),
    ]);
    expect([r1.statusCode, r2.statusCode].filter((c) => c === 200)).toHaveLength(1);
    const activos = await conOrg(bd.owner, a.orgId, (c) => c.query(`SELECT count(*)::int AS n FROM usuarios WHERE org_id = $1 AND activo AND rol = 'admin'`, [a.orgId]));
    expect(activos.rows[0].n).toBe(1);
  });

  it('frena el exceso de invitaciones por hora', async () => {
    const adm = await cliente();
    for (let i = 0; i < 10; i++) {
      expect((await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: `masa${++n}@cliente.test`, rol: 'miembro' })).statusCode).toBe(200);
    }
    const r = await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: `masa${++n}@cliente.test`, rol: 'miembro' });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ error: 'demasiadas_invitaciones' });
  });

  it('la aplicación no puede leer el hash del token, marcar invitaciones como usadas ni cambiar su vencimiento', async () => {
    const adm = await cliente();
    await panel(adm.cookie, 'POST', '/api/panel/equipo/invitaciones', { email: `perm${++n}@cliente.test`, rol: 'miembro' });
    const intenta = (sql: string) => conOrg(bd.app, adm.orgId, (c) => c.query(sql));
    await expect(intenta('SELECT token_hash FROM invitaciones')).rejects.toThrow(/permission denied/);
    await expect(intenta('UPDATE invitaciones SET usada_en = now()')).rejects.toThrow(/permission denied/);
    await expect(intenta(`UPDATE invitaciones SET expira_en = now() + interval '1 year'`)).rejects.toThrow(/permission denied/);
    await expect(intenta('DELETE FROM invitaciones')).rejects.toThrow(/permission denied/);
    // Sin organización fijada no ve nada (falla cerrada).
    expect((await bd.app.query('SELECT id FROM invitaciones')).rowCount).toBe(0);
  });

  it('las acciones de equipo y de invitaciones quedan en la auditoría de la cuenta', async () => {
    const adm = await cliente();
    const m = await sumar(adm, `audit${++n}@cliente.test`, 'miembro');
    const id = ((await panel(adm.cookie, 'GET', '/api/panel/equipo')).json() as { miembros: Array<{ id: string; email: string }> }).miembros.find((x) => x.email === m.email)!.id;
    await panel(adm.cookie, 'POST', `/api/panel/equipo/miembros/${id}`, { activo: false });
    const r = await conOrg(bd.owner, adm.orgId, (c) => c.query('SELECT accion FROM auditoria WHERE org_id = $1', [adm.orgId]));
    const acciones = r.rows.map((x) => x.accion as string);
    for (const esperada of ['invitacion_creada', 'invitacion_aceptada', 'miembro_desactivado']) expect(acciones).toContain(esperada);
  });
});

import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { cargarConfig } from '../src/config.js';
import { cargarLlaves } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { ServicioWidget } from '../src/widget/servicio.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import type { Bloque } from '../src/ia/modelo.js';
import { ModeloSimulado, type Guion } from '../src/ia/simulado.js';
import type { HttpSeguro, PeticionSegura } from '../src/conectores/http-seguro.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';
const TOKEN = `EAA${randomBytes(20).toString('hex')}`;
const web = mkdtempSync(join(tmpdir(), 'widget-web-'));
writeFileSync(join(web, 'index.html'), '<!doctype html><title>x</title>');

describe.skipIf(!hay)('widget embebible', () => {
  let bd: BdPrueba;
  let n = 0;
  const http = { pedir: async (p: PeticionSegura) => (p.ruta.includes('/insights')
    ? { estado: 200, cuerpo: JSON.stringify({ data: [{ spend: '50000', impressions: '1000', reach: '800', clicks: '40', actions: [] }] }), cabeceras: {} }
    : { estado: 200, cuerpo: JSON.stringify({ name: 'Cuenta', currency: 'COP', timezone_name: 'America/Bogota' }), cabeceras: {} }) } as unknown as HttpSeguro;

  beforeAll(async () => { bd = await prepararBdPrueba(); }, 60_000);
  afterAll(async () => { await bd?.cerrar(); });

  const montar = (guion?: Guion, limitesWidget?: { pedirPorIp: number; pedirPorClave: number; canjePorIp: number; ventanaMs: number }) => {
    const modelo = new ModeloSimulado(guion);
    return { modelo, app: crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_SEND_URL: 'http://127.0.0.1:9', ARCHIE_IA_MAX_PASOS: '10', ARCHIE_ORIGEN: 'https://ai.ejemplo.test', ARCHIE_WEB_DIR: web }), {
      pool: bd.app, llaves, modelo, httpTiendas: http, intentosTiendas: { max: 1000, ventanaMs: 60_000 }, limitesWidget,
      limitesChat: { mensajesPorMinutoUsuario: 10_000, mensajesPorMinutoOrg: 10_000 }, rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } } }) };
  };
  const panel = (a: FastifyInstance, cookie: string, metodo: 'GET' | 'POST', url: string, payload?: object) => a.inject({ method: metodo, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const wid = (a: FastifyInstance, token: string, metodo: 'GET' | 'POST', url: string, payload?: object) => a.inject({ method: metodo, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const login = async (app: FastifyInstance, email: string) => String((await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;

  async function cliente(app: FastifyInstance, conPauta = true) {
    const email = `admin${++n}@widget.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Cliente ${n}`, email, password: PW, nombreAdmin: `Admin ${n}` });
    const cookie = await login(app, email);
    if (conPauta) await panel(app, cookie, 'POST', '/api/panel/pauta', { plataforma: 'meta', nombre: 'Cuenta', cuenta: '123456789', token: TOKEN });
    return { orgId: r.orgId, cookie, email };
  }
  async function miembro(app: FastifyInstance, c: { orgId: string; email: string }, correo: string) {
    const hash = (await conOrg(bd.owner, c.orgId, (cl) => cl.query('SELECT password_hash FROM usuarios WHERE org_id = $1 LIMIT 1', [c.orgId]))).rows[0].password_hash;
    await conOrg(bd.owner, c.orgId, (cl) => cl.query("INSERT INTO usuarios (org_id, email, password_hash, rol, nombre) VALUES ($1,$2,$3,'miembro','Mia')", [c.orgId, correo, hash]));
    return login(app, correo);
  }
  const crearClave = async (app: FastifyInstance, cookie: string, nombre = 'Archie Send') => (await panel(app, cookie, 'POST', '/api/panel/widget/claves', { nombre })).json() as { id: string; clave: string };
  const pedir = (app: FastifyInstance, clave: string, email: string) => app.inject({ method: 'POST', url: '/api/widget/sesion', headers: { authorization: `Bearer ${clave}` }, payload: { email } });
  const canje = (url: string) => url.split('#c=')[1]!;
  /** Flujo completo: clave → enlace → sesión del widget (token en memoria del iframe). */
  async function abrir(app: FastifyInstance, clave: string, email: string) {
    const r = await pedir(app, clave, email);
    expect(r.statusCode, r.body).toBe(200);
    const c = await app.inject({ method: 'POST', url: '/api/widget/canjear', payload: { canje: canje(r.json().url) } });
    expect(c.statusCode, c.body).toBe(200);
    return c.json().token as string;
  }
  const eventos = (cuerpo: string) => cuerpo.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as any);
  const usar = (nombre: string, input: object = {}): Bloque => ({ type: 'tool_use', id: `toolu_${randomBytes(6).toString('hex')}`, name: nombre, input: input as Record<string, unknown> });

  it('orígenes: solo https://sitio, normalizados, con tope y solo administradores; otra organización no los ve', async () => {
    const { app } = montar();
    const a = await cliente(app, false); const b = await cliente(app, false);
    for (const origen of ['http://archiesend.com', 'https://archiesend.com:8443', 'https://archiesend.com/ruta', 'https://archiesend.com?x=1', 'https://169.254.169.254', 'https://localhost', 'https://u:p@archiesend.com', "https://a.com; script-src *", 'archiesend.com', 'https://a b.com', '*']) {
      const r = await panel(app, a.cookie, 'POST', '/api/panel/widget/origenes', { origen });
      expect(r.statusCode, origen).toBe(400); expect(r.json().error === 'origen_invalido' || r.json().error === 'entrada_invalida', origen).toBe(true);
    }
    expect((await panel(app, a.cookie, 'POST', '/api/panel/widget/origenes', { origen: ' HTTPS://ArchieSend.COM/ ' })).json().origen).toBe('https://archiesend.com');
    await panel(app, a.cookie, 'POST', '/api/panel/widget/origenes', { origen: 'https://archiesend.com' }); // repetido: no duplica
    expect((await panel(app, a.cookie, 'GET', '/api/panel/widget')).json().origenes).toEqual(['https://archiesend.com']);
    expect((await panel(app, b.cookie, 'GET', '/api/panel/widget')).json().origenes).toEqual([]);
    expect((await panel(app, b.cookie, 'POST', '/api/panel/widget/origenes/quitar', { origen: 'https://archiesend.com' })).statusCode).toBe(404);
    const m = await miembro(app, a, 'miembro@widget.test');
    expect((await panel(app, m, 'POST', '/api/panel/widget/origenes', { origen: 'https://otro.com' })).statusCode).toBe(403);
    expect((await panel(app, m, 'POST', '/api/panel/widget/claves', { nombre: 'x' })).statusCode).toBe(403);
    for (let i = 2; i <= 10; i++) expect((await panel(app, a.cookie, 'POST', '/api/panel/widget/origenes', { origen: `https://sitio${i}.com` })).statusCode).toBe(200);
    expect((await panel(app, a.cookie, 'POST', '/api/panel/widget/origenes', { origen: 'https://sitio11.com' })).json().error).toBe('demasiados_origenes');
    expect((await panel(app, a.cookie, 'POST', '/api/panel/widget/origenes/quitar', { origen: 'https://sitio2.com' })).statusCode).toBe(200);
  });

  it('mínimo privilegio: una sesión del widget rige como miembro aunque la persona sea administradora', async () => {
    const { app } = montar();
    const c = await cliente(app, false);
    const k = await crearClave(app, c.cookie);
    const token = await abrir(app, k.clave, c.email); // c.email es administrador
    const s = await new ServicioWidget(bd.app, 'https://ai.ejemplo.test').resolver(token);
    expect(s).not.toBeNull();
    expect(s!.rol).toBe('miembro');
    const r = (await conOrg(bd.owner, c.orgId, (cl) => cl.query('SELECT rol FROM usuarios WHERE email = $1', [c.email]))).rows[0];
    expect(r.rol).toBe('admin'); // en la base sigue siendo administrador; solo el widget lo limita
  });

  it('claves: se muestran una sola vez, en la base solo queda el hash, tope y revocación con auditoría', async () => {
    const { app } = montar();
    const c = await cliente(app, false);
    const k = await crearClave(app, c.cookie);
    expect(k.clave).toMatch(/^aiw_[A-Za-z0-9_-]{43}$/);
    const lista = await panel(app, c.cookie, 'GET', '/api/panel/widget');
    expect(lista.body).not.toContain(k.clave); expect(lista.json().claves[0]).toMatchObject({ nombre: 'Archie Send', prefijo: k.clave.slice(0, 8), revocada: false });
    const fila = (await conOrg(bd.owner, c.orgId, (cl) => cl.query('SELECT clave_hash FROM incrustacion_claves WHERE org_id = $1', [c.orgId]))).rows[0];
    expect(Buffer.from(fila.clave_hash).includes(Buffer.from(k.clave))).toBe(false);
    // La aplicación no puede leer los hashes.
    await expect(conOrg(bd.app, c.orgId, (cl) => cl.query('SELECT clave_hash FROM incrustacion_claves'))).rejects.toThrow();
    for (let i = 2; i <= 5; i++) expect((await panel(app, c.cookie, 'POST', '/api/panel/widget/claves', { nombre: `K${i}` })).statusCode).toBe(200);
    expect((await panel(app, c.cookie, 'POST', '/api/panel/widget/claves', { nombre: 'K6' })).json().error).toBe('demasiadas_claves');
    expect((await panel(app, c.cookie, 'POST', '/api/panel/widget/claves/quitar', { id: k.id })).statusCode).toBe(200);
    expect((await panel(app, c.cookie, 'POST', '/api/panel/widget/claves/quitar', { id: k.id })).statusCode).toBe(404);
    const aud = (await conOrg(bd.app, c.orgId, (cl) => cl.query("SELECT accion, detalle::text AS d FROM auditoria WHERE accion LIKE 'widget_%'"))).rows;
    expect(aud.map((x) => x.accion)).toContain('widget_clave_creada'); expect(aud.map((x) => x.accion)).toContain('widget_clave_revocada');
    for (const x of aud) expect(x.d).not.toContain(k.clave);
  });

  it('flujo: clave → enlace de un solo uso → sesión; el enlace va en el fragmento y no se puede reusar', async () => {
    const { app } = montar();
    const c = await cliente(app, false);
    const k = await crearClave(app, c.cookie);
    const r = await pedir(app, k.clave, c.email);
    expect(r.statusCode).toBe(200);
    const { url, expiraEnSegundos } = r.json();
    expect(url).toMatch(new RegExp(`^https://ai\\.ejemplo\\.test/widget/${c.orgId}#c=[A-Za-z0-9_-]{43}$`)); expect(expiraEnSegundos).toBe(120);
    const ok = await app.inject({ method: 'POST', url: '/api/widget/canjear', payload: { canje: canje(url) } });
    expect(ok.statusCode).toBe(200); expect(ok.json().segundos).toBe(7200);
    const dos = await app.inject({ method: 'POST', url: '/api/widget/canjear', payload: { canje: canje(url) } });
    expect(dos.statusCode).toBe(401); expect(dos.json().error).toBe('enlace_invalido');
    // el canje vencido tampoco sirve
    const v = await pedir(app, k.clave, c.email);
    await conOrg(bd.owner, c.orgId, (cl) => cl.query("UPDATE sesiones_widget SET expira_en = now() - interval '1 second' WHERE tipo = 'canje' AND usada_en IS NULL"));
    expect((await app.inject({ method: 'POST', url: '/api/widget/canjear', payload: { canje: canje(v.json().url) } })).statusCode).toBe(401);
    // dos canjes a la vez: solo uno gana
    const w = await pedir(app, k.clave, c.email);
    const [x, y] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/widget/canjear', payload: { canje: canje(w.json().url) } })));
    expect([x!.statusCode, y!.statusCode].sort()).toEqual([200, 401]);
    // en la base solo están los hashes
    const t = (await conOrg(bd.owner, c.orgId, (cl) => cl.query('SELECT token_hash FROM sesiones_widget'))).rows;
    for (const f of t) expect(Buffer.from(f.token_hash).includes(Buffer.from(canje(url)))).toBe(false);
    await expect(conOrg(bd.app, c.orgId, (cl) => cl.query('SELECT token_hash FROM sesiones_widget'))).rejects.toThrow();
    await expect(conOrg(bd.app, c.orgId, (cl) => cl.query('UPDATE sesiones_widget SET usada_en = NULL'))).rejects.toThrow();
  });

  it('claves malas y personas que no existen: errores iguales, sin revelar nada; con límite de frecuencia', async () => {
    const { app } = montar(undefined, { pedirPorIp: 1000, pedirPorClave: 1000, canjePorIp: 1000, ventanaMs: 60_000 });
    const a = await cliente(app, false); const b = await cliente(app, false);
    const ka = await crearClave(app, a.cookie);
    for (const clave of ['', 'aiw_corta', `aiw_${'x'.repeat(43)}`, 'Bearer x']) {
      const r = await pedir(app, clave, a.email);
      expect(r.statusCode, clave).toBe(401); expect(r.json().error).toBe('clave_invalida');
    }
    expect((await app.inject({ method: 'POST', url: '/api/widget/sesion', payload: { email: a.email } })).statusCode).toBe(401); // sin encabezado
    // la clave de una organización no abre personas de otra
    expect((await pedir(app, ka.clave, b.email)).json().error).toBe('usuario_no_encontrado');
    // un administrador desactivado tampoco
    await conOrg(bd.owner, a.orgId, (cl) => cl.query('UPDATE usuarios SET activo = false WHERE org_id = $1', [a.orgId]));
    expect((await pedir(app, ka.clave, a.email)).json().error).toBe('usuario_no_encontrado');

    const { app: lim } = montar(undefined, { pedirPorIp: 3, pedirPorClave: 1000, canjePorIp: 2, ventanaMs: 60_000 });
    for (let i = 0; i < 3; i++) await pedir(lim, 'x', 'a@b.co');
    expect((await pedir(lim, 'x', 'a@b.co')).statusCode).toBe(429);
    for (let i = 0; i < 2; i++) await lim.inject({ method: 'POST', url: '/api/widget/canjear', payload: { canje: 'a'.repeat(43) } });
    expect((await lim.inject({ method: 'POST', url: '/api/widget/canjear', payload: { canje: 'a'.repeat(43) } })).statusCode).toBe(429);
  });

  it('la sesión del widget conversa, es privada de cada persona y no sirve en el panel (ni la del panel en el widget)', async () => {
    const guion: Guion = (_p, paso) => (paso === 0 ? [usar('pauta_resumen', { periodo: '7_dias' })] : [{ type: 'text', text: 'Listo desde el widget.' }]);
    const { app, modelo } = montar(guion);
    const c = await cliente(app);
    const k = await crearClave(app, c.cookie);
    const t = await abrir(app, k.clave, c.email);

    const chat = await wid(app, t, 'POST', '/api/widget/chat', { texto: '¿Cómo va la pauta?' });
    const ev = eventos(chat.body);
    expect(ev.at(-1)).toMatchObject({ tipo: 'fin' }); expect(ev.find((e) => e.tipo === 'texto')).toBeTruthy();
    const id = ev.find((e) => e.tipo === 'inicio').conversacionId as string;
    expect(JSON.stringify((modelo.peticiones[1] as any).mensajes)).toContain('50000');
    expect((await wid(app, t, 'GET', '/api/widget/conversaciones')).json()).toHaveLength(1);
    expect((await wid(app, t, 'GET', `/api/widget/conversaciones/${id}`)).statusCode).toBe(200);
    expect((await wid(app, t, 'GET', '/api/widget/estado')).json()).toEqual({ conectado: true });
    // la misma conversación es del mismo usuario en el panel; otro usuario no la ve en el widget
    expect((await panel(app, c.cookie, 'GET', '/api/panel/chat/conversaciones')).json()).toHaveLength(1);
    const m = await miembro(app, c, 'otra@widget.test');
    expect(m).toBeTruthy();
    const t2 = await abrir(app, k.clave, 'otra@widget.test');
    expect((await wid(app, t2, 'GET', '/api/widget/conversaciones')).json()).toEqual([]);
    expect((await wid(app, t2, 'GET', `/api/widget/conversaciones/${id}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await wid(app, t2, 'POST', `/api/widget/conversaciones/${id}/borrar`)).statusCode).toBeGreaterThanOrEqual(400);

    // El token del widget NO abre nada del panel (ni como encabezado ni como cookie) y no hay rutas para aprobar, cambiar conexiones ni leer instrucciones.
    for (const [metodo, url] of [['GET', '/api/panel/conversaciones'], ['GET', '/api/panel/chat/conversaciones'], ['GET', '/api/panel/conexiones'], ['GET', '/api/panel/pauta'], ['GET', '/api/panel/propuestas'], ['GET', '/api/panel/widget'], ['GET', '/auth/yo']] as const) {
      expect((await wid(app, t, metodo, url)).statusCode, url).toBeGreaterThanOrEqual(401);
      expect((await app.inject({ method: metodo, url, headers: { cookie: `archie_sid=${t}` } })).statusCode, url).toBeGreaterThanOrEqual(401);
    }
    for (const url of ['/api/widget/propuestas', '/api/widget/conexiones', '/api/widget/acciones', '/api/widget/instrucciones']) expect((await wid(app, t, 'GET', url)).statusCode, url).toBe(404);
    // La cookie del panel no sirve como sesión del widget.
    const sidPanel = c.cookie.split('=')[1]!;
    expect((await wid(app, sidPanel, 'GET', '/api/widget/conversaciones')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/widget/conversaciones', headers: { cookie: c.cookie } })).statusCode).toBe(401);
    expect((await wid(app, 'a'.repeat(43), 'GET', '/api/widget/conversaciones')).statusCode).toBe(401);
  });

  it('revocar la clave, desactivar a la persona o dar de baja la organización cierra las sesiones del widget', async () => {
    const { app } = montar();
    const c = await cliente(app);
    const k = await crearClave(app, c.cookie, 'Una'); const k2 = await crearClave(app, c.cookie, 'Dos');
    const t = await abrir(app, k.clave, c.email); const t2 = await abrir(app, k2.clave, c.email);
    expect((await wid(app, t, 'GET', '/api/widget/conversaciones')).statusCode).toBe(200);
    await panel(app, c.cookie, 'POST', '/api/panel/widget/claves/quitar', { id: k.id });
    expect((await wid(app, t, 'GET', '/api/widget/conversaciones')).statusCode).toBe(401);
    expect((await pedir(app, k.clave, c.email)).statusCode).toBe(401);
    expect((await wid(app, t2, 'GET', '/api/widget/conversaciones')).statusCode).toBe(200); // la otra clave sigue sirviendo

    const m = await miembro(app, c, 'baja@widget.test'); expect(m).toBeTruthy();
    const t3 = await abrir(app, k2.clave, 'baja@widget.test');
    await conOrg(bd.owner, c.orgId, (cl) => cl.query("UPDATE usuarios SET activo = false WHERE email = 'baja@widget.test'"));
    expect((await wid(app, t3, 'GET', '/api/widget/conversaciones')).statusCode).toBe(401);
    await conOrg(bd.owner, c.orgId, (cl) => cl.query('UPDATE sesiones_widget SET expira_en = now() - interval \'1 second\' WHERE tipo = \'sesion\''));
    expect((await wid(app, t2, 'GET', '/api/widget/conversaciones')).statusCode).toBe(401); // vencida
    await wid(app, await abrir(app, k2.clave, c.email), 'POST', '/api/widget/salir');
  });

  it('la página del widget solo se puede incrustar en los sitios autorizados de esa organización', async () => {
    const { app } = montar();
    const a = await cliente(app, false); const b = await cliente(app, false);
    await panel(app, a.cookie, 'POST', '/api/panel/widget/origenes', { origen: 'https://archiesend.com' });
    await panel(app, a.cookie, 'POST', '/api/panel/widget/origenes', { origen: 'https://app.cliente.com' });
    const pa = await app.inject({ method: 'GET', url: `/widget/${a.orgId}` });
    expect(pa.statusCode).toBe(200);
    expect(String(pa.headers['content-security-policy'])).toContain('frame-ancestors https://app.cliente.com https://archiesend.com;');
    expect(pa.headers['x-frame-options']).toBeUndefined(); expect(String(pa.headers['cache-control'])).toMatch(/no-(store|cache)/);
    expect(String(pa.headers['content-security-policy'])).toContain("default-src 'self'");
    // sin sitios autorizados, o con un identificador inventado: nadie puede incrustarla
    for (const id of [b.orgId, 'no-es-un-uuid', '00000000-0000-0000-0000-000000000000']) {
      const r = await app.inject({ method: 'GET', url: `/widget/${id}` });
      expect(String(r.headers['content-security-policy']), id).toContain("frame-ancestors 'none'");
    }
    // el panel sigue sin poder incrustarse
    const panelHtml = await app.inject({ method: 'GET', url: '/chat' });
    expect(panelHtml.headers['x-frame-options']).toBe('DENY'); expect(String(panelHtml.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect((await app.inject({ method: 'GET', url: '/salud' })).headers['x-frame-options']).toBe('DENY');
  });

  it('la base de datos impide orígenes con caracteres de política y sesiones de widget de otra organización', async () => {
    const { app } = montar();
    const a = await cliente(app, false); const b = await cliente(app, false);
    const ins = (org: string, origen: string) => conOrg(bd.owner, org, (cl) => cl.query('INSERT INTO incrustacion_origenes (org_id, origen) VALUES ($1,$2)', [org, origen]));
    for (const o of ["https://a.com; script-src *", 'http://a.com', 'https://a.com:81', 'https://a..com', 'https://a.com/x']) await expect(ins(a.orgId, o), o).rejects.toThrow();
    await ins(a.orgId, 'https://bien.com');
    const k = await crearClave(app, a.cookie);
    // una persona de B no puede tener una sesión de widget con la clave de A (clave y persona deben ser de la misma organización)
    await expect(conOrg(bd.owner, b.orgId, (cl) => cl.query(
      "INSERT INTO sesiones_widget (org_id, usuario_id, clave_id, tipo, token_hash, expira_en) SELECT $1, id, $2, 'canje', $3, now() + interval '1 minute' FROM usuarios WHERE org_id = $4 LIMIT 1",
      [a.orgId, k.id, Buffer.from('x'.repeat(32)), b.orgId]))).rejects.toThrow();
    // ni una sesión de A puede colgar de una clave de B
    const kb = await crearClave(app, b.cookie, 'B');
    await expect(conOrg(bd.owner, a.orgId, (cl) => cl.query(
      "INSERT INTO sesiones_widget (org_id, usuario_id, clave_id, tipo, token_hash, expira_en) SELECT $1, id, $2, 'canje', $3, now() + interval '1 minute' FROM usuarios WHERE org_id = $1 LIMIT 1",
      [a.orgId, kb.id, Buffer.from('y'.repeat(32))]))).rejects.toThrow();
    // la aplicación no ve filas de otra organización
    expect((await conOrg(bd.app, b.orgId, (cl) => cl.query('SELECT * FROM incrustacion_origenes'))).rows).toEqual([]);
    expect((await conOrg(bd.app, b.orgId, (cl) => cl.query('SELECT id FROM incrustacion_claves'))).rows).toEqual([{ id: kb.id }]); // solo la suya, nunca la de A
  });
});

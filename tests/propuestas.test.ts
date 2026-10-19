import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { cargarConfig } from '../src/config.js';
import { cargarLlaves } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import type { Bloque, ModeloIA } from '../src/ia/modelo.js';
import { ModeloSimulado, type Guion } from '../src/ia/simulado.js';
import { huella, motivoNoValida, textoTarjeta, type Instantanea } from '../src/conectores/send-confirmaciones.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';
const USUARIO_SEND = 'archie-ai';
const TOKEN_SEND = `tok${randomBytes(12).toString('hex')}`;

const base: Instantanea = { id: 7, nombre: 'Promo', asunto: 'Hola', estado: 'draft', programadaPara: '2099-01-01T15:00:00Z', listas: [{ id: 1, nombre: 'Clientes', contactos: 1200 }, { id: 2, nombre: 'VIP', contactos: 30 }], creditos: 5000, cuerpoHash: 'a'.repeat(64), extracto: 'Hola, mira nuestra promo' };

describe('reglas de las acciones sensibles', () => {
  it('cada acción solo aplica a los estados correctos', () => {
    const e = (estado: string, extra: Partial<Instantanea> = {}) => ({ ...base, estado, ...extra });
    expect(motivoNoValida('enviar_ahora', e('draft'))).toBeNull();
    expect(motivoNoValida('enviar_ahora', e('finished'))).not.toBeNull();
    expect(motivoNoValida('enviar_ahora', e('draft', { listas: [] }))).not.toBeNull();
    expect(motivoNoValida('programar', e('draft'))).toBeNull();
    expect(motivoNoValida('programar', e('draft', { programadaPara: null }))).toContain('fecha');
    expect(motivoNoValida('programar', e('draft', { programadaPara: '2000-01-01T00:00:00Z' }))).toContain('pasó');
    expect(motivoNoValida('pausar', e('running'))).toBeNull();
    expect(motivoNoValida('pausar', e('draft'))).not.toBeNull();
    expect(motivoNoValida('reanudar', e('paused'))).toBeNull();
    expect(motivoNoValida('cancelar', e('finished'))).not.toBeNull();
    expect(motivoNoValida('borrar', e('draft'))).toBeNull();
    expect(motivoNoValida('borrar', e('running'))).not.toBeNull();
  });
  it('la tarjeta la escribe el servidor con datos reales y la huella cambia si cambia la campaña', () => {
    const t = textoTarjeta('enviar_ahora', base);
    expect(t).toContain('ENVIAR AHORA');
    expect(t).toContain('1.200 contactos');
    expect(t).toContain('como máximo 1.230');
    expect(t).toContain('5.000');
    expect(textoTarjeta('borrar', base)).toContain('No se puede deshacer');
    expect(huella(base, 'enviar_ahora')).toBe(huella({ ...base }, 'enviar_ahora'));
    expect(huella(base, 'enviar_ahora')).not.toBe(huella({ ...base, nombre: 'Otra' }, 'enviar_ahora'));
    expect(huella(base, 'enviar_ahora')).not.toBe(huella({ ...base, listas: [base.listas[0]!] }, 'enviar_ahora'));
    expect(huella(base, 'enviar_ahora')).not.toBe(huella(base, 'borrar'));
    expect(huella(base, 'enviar_ahora')).not.toBe(huella({ ...base, cuerpoHash: 'b'.repeat(64) }, 'enviar_ahora')); // el contenido cuenta
    expect(textoTarjeta('enviar_ahora', base)).toContain('Contenido (inicio): «Hola, mira nuestra promo»');
    expect(textoTarjeta('pausar', base)).not.toContain('Contenido');
    expect(huella(base, 'enviar_ahora')).toBe(huella({ ...base, listas: base.listas.map((l) => ({ ...l, contactos: 1 })) }, 'enviar_ahora')); // los conteos cambian solos: no cuentan
  });
});

interface Pedido { metodo: string; url: string; cuerpo: any }

describe.skipIf(!hay)('confirmación humana (nivel 3)', () => {
  let bd: BdPrueba;
  let send: Server;
  let urlSend = '';
  let pedidos: Pedido[] = [];
  let n = 0;
  let falla: { codigo: number; mensaje: string } | null = null;
  const campanas = new Map<number, any>();

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    send = createServer((req, res) => {
      const trozos: Buffer[] = [];
      req.on('data', (t) => trozos.push(t));
      req.on('end', () => {
        const texto = Buffer.concat(trozos).toString();
        let cuerpo: any; try { cuerpo = texto ? JSON.parse(texto) : undefined; } catch { cuerpo = undefined; }
        pedidos.push({ metodo: req.method ?? '', url: req.url ?? '', cuerpo });
        const json = (cod: number, o: unknown) => { res.writeHead(cod, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.headers.authorization !== `token ${USUARIO_SEND}:${TOKEN_SEND}`) return json(401, { message: 'no' });
        const u = new URL(req.url!, 'http://x');
        if (u.pathname === '/api/lists' && req.method === 'GET') return json(200, { data: { results: [], total: 0 } });
        if (u.pathname === '/api/credits') return json(200, { data: { status: { balance: 5000 } } });
        const l = /^\/api\/lists\/(\d+)$/.exec(u.pathname);
        if (l) return json(200, { data: { id: Number(l[1]), name: 'Clientes', subscriber_count: 1200 } });
        const st = /^\/api\/campaigns\/(\d+)\/status$/.exec(u.pathname);
        if (st && req.method === 'PUT') {
          if (falla) return json(falla.codigo, { message: falla.mensaje });
          const c = campanas.get(Number(st[1])); if (!c) return json(404, { message: 'no' });
          c.status = cuerpo.status; return json(200, { data: c });
        }
        const m = /^\/api\/campaigns\/(\d+)$/.exec(u.pathname);
        if (m && req.method === 'GET') return campanas.has(Number(m[1])) ? json(200, { data: campanas.get(Number(m[1])) }) : json(404, { message: 'no' });
        if (m && req.method === 'DELETE') return campanas.delete(Number(m[1])) ? json(200, { data: true }) : json(404, { message: 'no' });
        return json(405, { message: 'no' });
      });
    });
    await new Promise<void>((r) => send.listen(0, '127.0.0.1', r));
    urlSend = `http://127.0.0.1:${(send.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => { await new Promise((r) => send?.close(r)); await bd?.cerrar(); });

  let idCamp = 1000;
  const nuevaCampana = (extra: Record<string, unknown> = {}) => {
    const id = ++idCamp;
    campanas.set(id, { id, name: 'Promo de octubre', subject: 'Hola', status: 'draft', send_at: '2099-01-01T15:00:00Z', lists: [{ id: 1, name: 'Clientes' }], ...extra });
    return id;
  };
  const montar = (modelo: ModeloIA): FastifyInstance =>
    crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_SEND_URL: urlSend, ARCHIE_IA_MAX_PASOS: '10' }), {
      pool: bd.app, llaves, modelo, limitesChat: { mensajesPorMinutoUsuario: 10_000, mensajesPorMinutoOrg: 10_000 }, rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } } });
  const llamar = (a: FastifyInstance, cookie: string, metodo: 'GET' | 'POST', url: string, payload?: object) =>
    a.inject({ method: metodo, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const eventos = (cuerpo: string) => cuerpo.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as any);
  const loginMiembro = async (app: FastifyInstance, orgId: string, usuarioId: string) => {
    const hash = (await conOrg(bd.owner, orgId, (c) => c.query('SELECT password_hash FROM usuarios WHERE id = $1', [usuarioId]))).rows[0].password_hash;
    const email = `miembro${++n}@cliente.test`;
    await conOrg(bd.owner, orgId, (c) => c.query("INSERT INTO usuarios (org_id, email, password_hash, rol, nombre) VALUES ($1,$2,$3,'miembro','Mia')", [orgId, email, hash]));
    const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW } });
    return String(l.headers['set-cookie']).split(';')[0]!;
  };
  async function cliente(app: FastifyInstance, autonomia: 'borradores' | 'confirmacion' = 'confirmacion') {
    const email = `admin${++n}@cliente.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Cliente ${n}`, email, password: PW, nombreAdmin: `Admin ${n}` });
    await conOrg(bd.owner, r.orgId, (c) => c.query('UPDATE organizaciones SET autonomia = $2 WHERE id = $1', [r.orgId, autonomia]));
    const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW } });
    const cookie = String(l.headers['set-cookie']).split(';')[0]!;
    expect((await llamar(app, cookie, 'POST', '/api/panel/conexiones/send', { usuario: USUARIO_SEND, token: TOKEN_SEND })).statusCode).toBe(200);
    return { orgId: r.orgId, usuarioId: r.usuarioId, cookie };
  }
  const preguntar = (app: FastifyInstance, cookie: string, texto: string, conversacionId?: string) =>
    llamar(app, cookie, 'POST', '/api/panel/chat', { texto, ...(conversacionId ? { conversacionId } : {}) });
  const usar = (nombre: string, input: object): Bloque => ({ type: 'tool_use', id: `toolu_${randomBytes(6).toString('hex')}`, name: nombre, input: input as Record<string, unknown> });
  const dice = (t: string): Bloque => ({ type: 'text', text: t });
  const propone = (campana_id: number, accion: string): Guion => (_p, paso) => (paso === 0 ? [usar('send_proponer_accion_campana', { campana_id, accion })] : [dice('Dejé la tarjeta.')]);
  const mutaciones = () => pedidos.filter((p) => p.metodo === 'PUT' || p.metodo === 'DELETE' || p.metodo === 'POST');
  const filas = async (orgId: string) => (await conOrg(bd.app, orgId, (c) => c.query('SELECT * FROM propuestas ORDER BY creada_en'))).rows;
  const proponer = async (app: FastifyInstance, c: { cookie: string; orgId: string }, campana: number, accion: string) => {
    pedidos = [];
    const ev = eventos((await preguntar(app, c.cookie, 'hazlo')).body);
    const p = ev.find((e) => e.tipo === 'propuesta');
    return { ev, id: p?.id as string | undefined };
  };

  it('solo con autonomía «confirmación» el modelo ve la herramienta de proponer', async () => {
    const m1 = new ModeloSimulado(() => [dice('ok')]);
    const a1 = montar(m1); const c1 = await cliente(a1, 'borradores');
    await preguntar(a1, c1.cookie, 'hola');
    expect(m1.peticiones[0]!.herramientas.some((h) => h.name === 'send_proponer_accion_campana')).toBe(false);
    const m2 = new ModeloSimulado(() => [dice('ok')]);
    const a2 = montar(m2); const c2 = await cliente(a2, 'confirmacion');
    await preguntar(a2, c2.cookie, 'hola');
    const nombres = m2.peticiones[0]!.herramientas.map((h) => h.name);
    expect(nombres).toContain('send_proponer_accion_campana');
    expect(nombres.filter((x) => /^send_(enviar|programar|pausar|cancelar|borrar)/.test(x))).toHaveLength(0);
    await a1.close(); await a2.close();
  });

  it('proponer NO ejecuta nada: crea una tarjeta pendiente con datos reales y avisa por SSE', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { ev, id } = await proponer(app, c, idc, 'enviar_ahora');
    expect(id).toBeTruthy();
    expect(mutaciones()).toHaveLength(0); // ninguna escritura en Archie Send
    expect(campanas.get(idc).status).toBe('draft');
    const [f] = await filas(c.orgId);
    expect(f).toMatchObject({ estado: 'pendiente', accion: 'enviar_ahora', objeto_id: idc, usuario_id: c.usuarioId });
    expect(f.texto).toContain('Promo de octubre');
    expect(f.texto).toContain('1.200 contactos');
    expect(f.texto).toContain('5.000');
    const v = (await llamar(app, c.cookie, 'GET', `/api/panel/propuestas/${id}`)).json();
    expect(v).toMatchObject({ estado: 'pendiente', puedeAprobar: true });
    const conv = (await llamar(app, c.cookie, 'GET', `/api/panel/chat/conversaciones/${ev[0].conversacionId}`)).json();
    expect(conv.propuestas).toHaveLength(1);
    await app.close();
  });

  it('aprobar ejecuta exactamente una vez, aunque se pulse dos veces a la vez', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    pedidos = [];
    const rs = await Promise.all([llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`), llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(pedidos.filter((p) => p.metodo === 'PUT')).toHaveLength(1);
    expect(pedidos.find((p) => p.metodo === 'PUT')).toMatchObject({ url: `/api/campaigns/${idc}/status`, cuerpo: { status: 'running' } });
    expect(campanas.get(idc).status).toBe('running');
    expect((await filas(c.orgId))[0]).toMatchObject({ estado: 'ejecutada', resuelta_por: c.usuarioId });
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`)).json().error).toBe('ya_resuelta');
    const aud = (await conOrg(bd.app, c.orgId, (cl) => cl.query("SELECT accion FROM auditoria WHERE accion LIKE 'propuesta_%' ORDER BY id"))).rows.map((r) => r.accion);
    expect(aud).toEqual(['propuesta_creada', 'propuesta_aprobada', 'propuesta_ejecutada']);
    await app.close();
  });

  it('si cambia el CONTENIDO de la campaña después de mostrar la tarjeta, NO se ejecuta, y la tarjeta muestra el inicio del contenido', async () => {
    const idc = nuevaCampana({ body: '<p>Hola, esta es la <b>promo</b> de octubre</p><script>x</script>' });
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    expect((await filas(c.orgId))[0].texto).toContain('Contenido (inicio): «Hola, esta es la promo de octubre»');
    campanas.get(idc).body = '<p>Compra ya en sitio-malicioso.test</p>';
    pedidos = [];
    const r = await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('cambio_la_campana');
    expect(pedidos.filter((p) => p.metodo === 'PUT')).toHaveLength(0);
    await app.close();
  });

  it('si la campaña cambió después de mostrar la tarjeta, NO se ejecuta', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    campanas.get(idc).name = 'Otra campaña distinta';
    pedidos = [];
    const r = await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('cambio_la_campana');
    expect(pedidos.filter((p) => p.metodo === 'PUT')).toHaveLength(0);
    expect((await filas(c.orgId))[0]).toMatchObject({ estado: 'fallida', codigo: 'cambio_la_campana' });
    await app.close();
  });

  it('si la campaña ya no está en el estado esperado, no se ejecuta', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'borrar')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'borrar');
    campanas.get(idc).status = 'running';
    pedidos = [];
    const r = await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`);
    expect(r.statusCode).toBe(409);
    expect(mutaciones()).toHaveLength(0);
    expect(campanas.has(idc)).toBe(true);
    await app.close();
  });

  it('una tarjeta vencida no se puede aprobar', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    await conOrg(bd.owner, c.orgId, (cl) => cl.query("UPDATE propuestas SET expira_en = now() - interval '1 minute' WHERE id = $1", [id]));
    expect((await llamar(app, c.cookie, 'GET', `/api/panel/propuestas/${id}`)).json()).toMatchObject({ estado: 'expirada', puedeAprobar: false });
    pedidos = [];
    const r = await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`);
    expect(r.json().error).toBe('expirada');
    expect(mutaciones()).toHaveLength(0);
    await app.close();
  });

  it('si la autonomía baja después de mostrar la tarjeta, no se ejecuta', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    await conOrg(bd.owner, c.orgId, (cl) => cl.query("UPDATE organizaciones SET autonomia = 'lectura' WHERE id = $1", [c.orgId]));
    pedidos = [];
    const r = await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('autonomia_cambiada');
    expect(mutaciones()).toHaveLength(0);
    expect((await filas(c.orgId))[0].estado).toBe('pendiente');
    await app.close();
  });

  it('rechazar no ejecuta nada y cierra la tarjeta', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/rechazar`)).statusCode).toBe(200);
    pedidos = [];
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`)).json().error).toBe('ya_resuelta');
    expect(mutaciones()).toHaveLength(0);
    expect((await filas(c.orgId))[0].estado).toBe('rechazada');
    await app.close();
  });

  it('solo un administrador aprueba; un miembro ve solo lo suyo; otra organización no ve nada', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const otra = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    const miembro = await loginMiembro(app, c.orgId, c.usuarioId);
    pedidos = [];
    expect((await llamar(app, miembro, 'POST', `/api/panel/propuestas/${id}/aprobar`)).statusCode).toBe(403);
    expect((await llamar(app, miembro, 'GET', `/api/panel/propuestas/${id}`)).statusCode).toBe(404);
    expect((await llamar(app, miembro, 'GET', '/api/panel/propuestas')).json()).toHaveLength(0);
    expect((await llamar(app, otra.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`)).statusCode).toBe(404);
    expect((await llamar(app, otra.cookie, 'GET', '/api/panel/propuestas')).json()).toHaveLength(0);
    expect(mutaciones()).toHaveLength(0);
    expect((await llamar(app, c.cookie, 'GET', '/api/panel/propuestas')).json()).toHaveLength(1);
    await app.close();
  });

  it('acciones que no aplican al estado actual no generan tarjeta', async () => {
    const idc = nuevaCampana(); // en borrador: no se puede pausar
    const modelo = new ModeloSimulado(propone(idc, 'pausar'));
    const app = montar(modelo);
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'pausar');
    expect(id).toBeUndefined();
    expect(await filas(c.orgId)).toHaveLength(0);
    const t = modelo.peticiones.at(-1)!.mensajes.at(-1)!.content[0] as Extract<Bloque, { type: 'tool_result' }>;
    expect(t.content).toContain('propuesta_creada');
    expect(t.content).toContain('false');
    await app.close();
  });

  it('borrar solo borra tras la aprobación', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'borrar')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'borrar');
    expect(campanas.has(idc)).toBe(true);
    pedidos = [];
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`)).statusCode).toBe(200);
    expect(pedidos.filter((p) => p.metodo === 'DELETE')).toHaveLength(1);
    expect(campanas.has(idc)).toBe(false);
    await app.close();
  });

  it('si Archie Send rechaza (p. ej. créditos), la tarjeta queda fallida, no se reintenta y se explica el motivo', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    falla = { codigo: 422, mensaje: 'créditos insuficientes' };
    const r = await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`);
    falla = null;
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('send_datos_rechazados');
    expect(r.json().mensaje).toContain('créditos insuficientes');
    expect((await filas(c.orgId))[0]).toMatchObject({ estado: 'fallida', codigo: 'send_datos_rechazados' });
    pedidos = [];
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`)).json().error).toBe('ya_resuelta');
    expect(mutaciones()).toHaveLength(0);
    expect(campanas.get(idc).status).toBe('draft');
    await app.close();
  });

  it('tope de 3 tarjetas pendientes por conversación', async () => {
    const ids = [nuevaCampana(), nuevaCampana(), nuevaCampana(), nuevaCampana()];
    const app = montar(new ModeloSimulado((_p, paso) => (paso < ids.length ? [usar('send_proponer_accion_campana', { campana_id: ids[paso], accion: 'enviar_ahora' })] : [dice('fin')])));
    const c = await cliente(app);
    const { ev } = await proponer(app, c, ids[0]!, 'enviar_ahora');
    expect(ev.filter((e) => e.tipo === 'propuesta')).toHaveLength(3);
    expect(await filas(c.orgId)).toHaveLength(3);
    await app.close();
  });

  it('la base de datos no deja reabrir ni saltar estados de una tarjeta', async () => {
    const idc = nuevaCampana();
    const app = montar(new ModeloSimulado(propone(idc, 'enviar_ahora')));
    const c = await cliente(app);
    const { id } = await proponer(app, c, idc, 'enviar_ahora');
    await llamar(app, c.cookie, 'POST', `/api/panel/propuestas/${id}/aprobar`);
    await expect(conOrg(bd.app, c.orgId, (cl) => cl.query("UPDATE propuestas SET estado = 'pendiente' WHERE id = $1", [id]))).rejects.toThrow();
    await expect(conOrg(bd.app, c.orgId, (cl) => cl.query("UPDATE propuestas SET texto = 'otro' WHERE id = $1", [id]))).rejects.toThrow(); // la app no puede editar el texto aprobado
    await app.close();
  });
});

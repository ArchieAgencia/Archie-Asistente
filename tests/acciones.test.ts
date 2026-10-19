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
import { motivoCuerpoInseguro } from '../src/conectores/send-borradores.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';
const USUARIO_SEND = 'archie-ai';
const TOKEN_SEND = `tok${randomBytes(12).toString('hex')}`;

interface Pedido { metodo: string; url: string; cuerpo: any }

describe('validación del contenido del correo', () => {
  it('acepta HTML simple y las dos variables permitidas', () => {
    expect(motivoCuerpoInseguro('<p>Hola {{ .Subscriber.FirstName }}, mira {{.Subscriber.Name}}</p>')).toBeNull();
  });
  it.each([
    '<p>{{ .Subscriber.Email }}</p>', '{% if x %}', '{{ template "x" }}', '<script>alert(1)</script>', '<IFRAME src="x"></iframe>', '<a href="javascript:x()">a</a>',
    '<img src=x onerror=alert(1)>', '<form action="x">', '<object data="x">', '<embed src="x">', '<a href="data:text/html;base64,AA">x</a>',
  ])('rechaza %s', (c) => { expect(motivoCuerpoInseguro(c)).not.toBeNull(); });
  // Evasiones conocidas: entidades HTML, mayúsculas, espacios y controles dentro del esquema, otros esquemas y etiquetas activas.
  it.each([
    '<a href="javascript&colon;alert(1)">x</a>', '<a href="jav&#x61;script:alert(1)">x</a>', '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="java&Tab;script:alert(1)">x</a>', '<a href="JaVaScRiPt:alert(1)">x</a>', '<a href="  javascript:alert(1)">x</a>', '<a href="java\u0000script:alert(1)">x</a>',
    '<a href=vbscript:x>x</a>', '<a href="file:///etc/passwd">x</a>', '<img src="ftp://x/y.png">', '<a href="&amp;#106;avascript:alert(1)">x</a>',
    '<svg onload=alert(1)>', '<math><mi xlink:href="javascript:x"></mi></math>', '<style>@import url(x)</style>', '<meta http-equiv="refresh" content="0;url=x">',
    '<base href="https://evil.test/">', '<link rel="stylesheet" href="x">', '<iframe srcdoc="<p>x</p>"></iframe>', '<p style="width:expression(alert(1))">x</p>',
    "<a href='data:text/html;base64,AA'>x</a>", '<a ONCLICK = "x()">x</a>',
  ])('rechaza la evasión %s', (c) => { expect(motivoCuerpoInseguro(c)).not.toBeNull(); });
  it('acepta enlaces normales y de correo', () => {
    expect(motivoCuerpoInseguro('<p><a href="https://archietechnology.com/promo?x=1&y=2">Ver</a> <a href="mailto:hola@x.co">Escríbenos</a> <a href="/relativo">r</a> <a href="#a">a</a> <img src="https://x.co/a.png" alt="a"></p>')).toBeNull();
    expect(motivoCuerpoInseguro('<p>Hola &amp; bienvenido, nos vemos el 5 &lt; 6</p>')).toBeNull();
  });
});

describe.skipIf(!hay)('borradores reversibles (nivel 2)', () => {
  let bd: BdPrueba;
  let send: Server;
  let urlSend = '';
  let pedidos: Pedido[] = [];
  let n = 0;
  let siguienteId = 100;
  let rechazo: { codigo: number; mensaje: string } | null = null;
  const listas = new Map<number, any>();
  const campanas = new Map<number, any>();
  const segmentos = new Map<number, any>();

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
        const m = /^\/api\/(lists|campaigns|segments)(?:\/(\d+))?$/.exec(u.pathname);
        if (!m) return json(404, { message: 'no' });
        const tabla = m[1] === 'lists' ? listas : m[1] === 'campaigns' ? campanas : segmentos;
        const id = m[2] ? Number(m[2]) : undefined;
        if (req.method === 'POST' && id === undefined) {
          if (rechazo) return json(rechazo.codigo, { message: rechazo.mensaje });
          const nuevo = m[1] === 'lists' ? { id: ++siguienteId, name: cuerpo.name, subscriber_count: 0 }
            : m[1] === 'campaigns' ? { id: ++siguienteId, name: cuerpo.name, status: 'draft', subject: cuerpo.subject }
              : { id: ++siguienteId, name: cuerpo.name, filter: cuerpo.filter };
          tabla.set(nuevo.id, nuevo);
          return json(200, { data: nuevo });
        }
        if (req.method === 'GET' && id !== undefined) return tabla.has(id) ? json(200, { data: tabla.get(id) }) : json(404, { message: 'no existe' });
        if (req.method === 'GET' && id === undefined && m[1] === 'segments') return json(200, { data: [...segmentos.values()] });
        if (req.method === 'GET' && id === undefined) return json(200, { data: { results: [...tabla.values()], total: tabla.size } });
        if (req.method === 'DELETE' && id !== undefined) { const ok = tabla.delete(id); return ok ? json(200, { data: true }) : json(404, { message: 'no existe' }); }
        return json(405, { message: 'no' });
      });
    });
    await new Promise<void>((r) => send.listen(0, '127.0.0.1', r));
    urlSend = `http://127.0.0.1:${(send.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => { await new Promise((r) => send?.close(r)); await bd?.cerrar(); });

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
  async function cliente(app: FastifyInstance) {
    const email = `admin${++n}@cliente.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Cliente ${n}`, email, password: PW, nombreAdmin: `Admin ${n}` });
    const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW } });
    const cookie = String(l.headers['set-cookie']).split(';')[0]!;
    expect((await llamar(app, cookie, 'POST', '/api/panel/conexiones/send', { usuario: USUARIO_SEND, token: TOKEN_SEND })).statusCode).toBe(200);
    return { orgId: r.orgId, usuarioId: r.usuarioId, cookie };
  }
  const preguntar = (app: FastifyInstance, cookie: string, texto: string, conversacionId?: string) =>
    llamar(app, cookie, 'POST', '/api/panel/chat', { texto, ...(conversacionId ? { conversacionId } : {}) });
  const usar = (nombre: string, input: object): Bloque => ({ type: 'tool_use', id: `toolu_${randomBytes(6).toString('hex')}`, name: nombre, input: input as Record<string, unknown> });
  const dice = (t: string): Bloque => ({ type: 'text', text: t });
  const crea = (nombre: string, input: object): Guion => (_p, paso) => (paso === 0 ? [usar(nombre, input)] : [dice('Listo.')]);
  const escrituras = () => pedidos.filter((p) => p.metodo !== 'GET');
  const acciones = async (orgId: string) => (await conOrg(bd.app, orgId, (c) => c.query('SELECT * FROM acciones ORDER BY creada_en'))).rows;

  it('crear una lista: la crea vacía en Archie Send, deja constancia, avisa por SSE y se puede deshacer una sola vez', async () => {
    pedidos = [];
    const app = montar(new ModeloSimulado(crea('send_crear_lista', { nombre: 'Clientes VIP', doble_confirmacion: true })));
    const c = await cliente(app);
    const r = await preguntar(app, c.cookie, 'crea una lista Clientes VIP');
    const ev = eventos(r.body);
    const acc = ev.find((e) => e.tipo === 'accion');
    expect(acc).toMatchObject({ objeto: 'lista', nombre: 'Clientes VIP' });
    expect(ev.at(-1).tipo).toBe('fin');
    expect(escrituras()).toHaveLength(1);
    expect(escrituras()[0]).toMatchObject({ metodo: 'POST', url: '/api/lists', cuerpo: { name: 'Clientes VIP', optin: 'double', type: 'private' } });

    const filas = await acciones(c.orgId);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ objeto_tipo: 'lista', estado: 'hecha', usuario_id: c.usuarioId });
    const aud = (await conOrg(bd.app, c.orgId, (cl) => cl.query("SELECT 1 FROM auditoria WHERE accion = 'accion_creada'"))).rowCount;
    expect(aud).toBe(1);

    const lista = (await llamar(app, c.cookie, 'GET', '/api/panel/acciones')).json();
    expect(lista).toHaveLength(1);
    const ver = (await llamar(app, c.cookie, 'GET', `/api/panel/chat/conversaciones/${ev[0].conversacionId}`)).json();
    expect(ver.acciones).toHaveLength(1);

    const des = await llamar(app, c.cookie, 'POST', `/api/panel/acciones/${acc.id}/deshacer`);
    expect(des.statusCode).toBe(200);
    expect(des.json().estado).toBe('deshecha');
    expect(listas.has(filas[0].objeto_id)).toBe(false);
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/acciones/${acc.id}/deshacer`)).statusCode).toBe(409);
    await app.close();
  });

  it('deshacer una lista con contactos o con otro nombre NO la borra', async () => {
    const app = montar(new ModeloSimulado(crea('send_crear_lista', { nombre: 'Lista X' })));
    const c = await cliente(app);
    await preguntar(app, c.cookie, 'crea Lista X');
    const [a] = await acciones(c.orgId);
    listas.get(a.objeto_id).subscriber_count = 3;
    pedidos = [];
    const r1 = await llamar(app, c.cookie, 'POST', `/api/panel/acciones/${a.id}/deshacer`);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error).toBe('no_se_puede_deshacer');
    listas.get(a.objeto_id).subscriber_count = 0;
    listas.get(a.objeto_id).name = 'Otro nombre';
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/acciones/${a.id}/deshacer`)).statusCode).toBe(409);
    expect(escrituras()).toHaveLength(0); // nunca llegó a borrar
    expect(listas.has(a.objeto_id)).toBe(true);
    expect((await acciones(c.orgId))[0].estado).toBe('hecha');
    await app.close();
  });

  it('borrador de campaña: queda en borrador, y si ya no está en borrador no se borra', async () => {
    const app = montar(new ModeloSimulado(crea('send_crear_borrador_campana', { nombre: 'Promo', asunto: 'Hola {{ .Subscriber.FirstName }}', lista_ids: [1], cuerpo: '<p>Hola</p>' })));
    const c = await cliente(app);
    pedidos = [];
    await preguntar(app, c.cookie, 'prepara una campaña');
    expect(escrituras()).toHaveLength(1);
    expect(escrituras()[0]!.cuerpo).toMatchObject({ name: 'Promo', lists: [1], messenger: 'email' });
    expect(escrituras()[0]!.cuerpo).not.toHaveProperty('send_at');
    expect(escrituras()[0]!.cuerpo).not.toHaveProperty('status');
    const [a] = await acciones(c.orgId);
    campanas.get(a.objeto_id).status = 'scheduled';
    pedidos = [];
    const r = await llamar(app, c.cookie, 'POST', `/api/panel/acciones/${a.id}/deshacer`);
    expect(r.statusCode).toBe(409);
    expect(escrituras()).toHaveLength(0);
    campanas.get(a.objeto_id).status = 'draft';
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/acciones/${a.id}/deshacer`)).statusCode).toBe(200);
    expect(campanas.has(a.objeto_id)).toBe(false);
    await app.close();
  });

  it('un cuerpo inseguro se rechaza ANTES de salir a la red', async () => {
    const modelo = new ModeloSimulado(crea('send_crear_borrador_campana', { nombre: 'Mala', asunto: 'x', lista_ids: [1], cuerpo: '<p>{{ .Subscriber.Email }}</p><script>1</script>' }));
    const app = montar(modelo);
    const c = await cliente(app);
    pedidos = [];
    const ev = eventos((await preguntar(app, c.cookie, 'campaña')).body);
    expect(ev.find((e) => e.tipo === 'herramienta' && e.estado === 'error')).toBeTruthy();
    expect(ev.find((e) => e.tipo === 'accion')).toBeUndefined();
    expect(escrituras()).toHaveLength(0);
    expect(await acciones(c.orgId)).toHaveLength(0);
    await app.close();
  });

  it('segmento: se crea con el filtro traducido y se puede deshacer', async () => {
    const app = montar(new ModeloSimulado(crea('send_crear_segmento', { nombre: 'Compradores', coincidir: 'any', reglas: [{ campo: 'email', operador: 'contains', valor: '@empresa.co' }, { campo: 'list', operador: 'in', lista_id: 1, estado_suscripcion: 'confirmed' }] })));
    const c = await cliente(app);
    pedidos = [];
    await preguntar(app, c.cookie, 'segmento');
    expect(escrituras()[0]).toMatchObject({ url: '/api/segments', cuerpo: { name: 'Compradores', filter: { match: 'any', rules: [{ field: 'email', op: 'contains', value: '@empresa.co' }, { field: 'list', op: 'in', list_id: 1, status: 'confirmed' }] } } });
    const [a] = await acciones(c.orgId);
    expect((await llamar(app, c.cookie, 'POST', `/api/panel/acciones/${a.id}/deshacer`)).statusCode).toBe(200);
    expect(segmentos.has(a.objeto_id)).toBe(false);
    await app.close();
  });

  it('con autonomía "lectura" el modelo ni ve las herramientas de crear, y si las pide no se ejecutan', async () => {
    const modelo = new ModeloSimulado(crea('send_crear_lista', { nombre: 'No debe existir' }));
    const app = montar(modelo);
    const c = await cliente(app);
    await conOrg(bd.owner, c.orgId, (cl) => cl.query("UPDATE organizaciones SET autonomia = 'lectura' WHERE id = $1", [c.orgId]));
    pedidos = [];
    await preguntar(app, c.cookie, 'crea una lista');
    expect(modelo.peticiones[0]!.herramientas.some((h) => h.name.startsWith('send_crear'))).toBe(false);
    expect(escrituras()).toHaveLength(0);
    expect(await acciones(c.orgId)).toHaveLength(0);
    await app.close();
  });

  it('con autonomía "borradores" el catálogo incluye las tres de crear y ninguna de enviar', async () => {
    const modelo = new ModeloSimulado(() => [dice('ok')]);
    const app = montar(modelo);
    const c = await cliente(app);
    await preguntar(app, c.cookie, 'hola');
    const nombres = modelo.peticiones[0]!.herramientas.map((h) => h.name);
    expect(nombres).toEqual(expect.arrayContaining(['send_crear_lista', 'send_crear_segmento', 'send_crear_borrador_campana']));
    expect(nombres.filter((x) => /enviar|programar|pausar|borrar|editar|eliminar/.test(x))).toHaveLength(0);
    await app.close();
  });

  it('tope de 5 acciones por conversación', async () => {
    const app = montar(new ModeloSimulado((_p, paso) => (paso < 7 ? [usar('send_crear_lista', { nombre: `Lista ${paso}` })] : [dice('fin')])));
    const c = await cliente(app);
    pedidos = [];
    const ev = eventos((await preguntar(app, c.cookie, 'crea muchas')).body);
    expect(ev.filter((e) => e.tipo === 'accion')).toHaveLength(5);
    expect(escrituras()).toHaveLength(5);
    expect(await acciones(c.orgId)).toHaveLength(5);
    await app.close();
  });

  it('tope de 20 acciones por hora en toda la organización', async () => {
    const modelo = new ModeloSimulado(crea('send_crear_lista', { nombre: 'Una más' }));
    const app = montar(modelo);
    const c = await cliente(app);
    await conOrg(bd.app, c.orgId, (cl) => cl.query(
      `INSERT INTO acciones (org_id, usuario_id, herramienta, objeto_tipo, objeto_id, objeto_nombre, tool_use_id)
       SELECT $1, $2, 'send_crear_lista', 'lista', g, 'Previa ' || g, 'previa-' || g FROM generate_series(1, 20) g`, [c.orgId, c.usuarioId]));
    pedidos = [];
    const ev = eventos((await preguntar(app, c.cookie, 'crea otra')).body);
    expect(ev.find((e) => e.tipo === 'accion')).toBeUndefined();
    expect(escrituras()).toHaveLength(0);
    const t = modelo.peticiones.at(-1)!.mensajes.at(-1)!.content[0] as Extract<Bloque, { type: 'tool_result' }>;
    expect(t.content).toContain('máximo');
    await app.close();
  });

  it('errores de Archie Send al crear: el detalle va al modelo, no a la pantalla ni a la base de datos', async () => {
    const modelo = new ModeloSimulado(crea('send_crear_lista', { nombre: 'Rechazada' }));
    const app = montar(modelo);
    const c = await cliente(app);
    rechazo = { codigo: 422, mensaje: 'el nombre ya existe' };
    const r = await preguntar(app, c.cookie, 'crea');
    expect(r.body).not.toContain('el nombre ya existe');
    const ultimo = modelo.peticiones.at(-1)!.mensajes.at(-1)!.content[0] as Extract<Bloque, { type: 'tool_result' }>;
    expect(ultimo.is_error).toBe(true);
    expect(ultimo.content).toContain('el nombre ya existe');
    expect(await acciones(c.orgId)).toHaveLength(0);
    rechazo = { codigo: 403, mensaje: 'secreto' };
    const m2 = new ModeloSimulado(crea('send_crear_lista', { nombre: 'Sin permiso' }));
    const app2 = montar(m2);
    await preguntar(app2, c.cookie, 'crea');
    const t = m2.peticiones.at(-1)!.mensajes.at(-1)!.content[0] as Extract<Bloque, { type: 'tool_result' }>;
    expect(t.content).toContain('no tiene permiso para crear');
    expect(t.content).not.toContain('secreto');
    rechazo = null;
    await app.close(); await app2.close();
  });

  it('aislamiento: otra organización no ve ni deshace; un miembro solo ve las suyas; un administrador ve todas', async () => {
    const app = montar(new ModeloSimulado(crea('send_crear_lista', { nombre: 'Privada' })));
    const a = await cliente(app);
    const b = await cliente(app);
    await preguntar(app, a.cookie, 'crea');
    const [acc] = await acciones(a.orgId);
    expect((await llamar(app, b.cookie, 'GET', '/api/panel/acciones')).json()).toHaveLength(0);
    expect((await llamar(app, b.cookie, 'POST', `/api/panel/acciones/${acc.id}/deshacer`)).statusCode).toBe(404);
    const miembro = await loginMiembro(app, a.orgId, a.usuarioId);
    expect((await llamar(app, miembro, 'GET', '/api/panel/acciones')).json()).toHaveLength(0); // no es suya
    expect((await llamar(app, miembro, 'POST', `/api/panel/acciones/${acc.id}/deshacer`)).statusCode).toBe(404);
    expect((await llamar(app, a.cookie, 'GET', '/api/panel/acciones')).json()).toHaveLength(1);
    await app.close();
  });

  it('si la lista ya no existe en Archie Send, deshacer lo marca sin error', async () => {
    const app = montar(new ModeloSimulado(crea('send_crear_lista', { nombre: 'Fantasma' })));
    const c = await cliente(app);
    await preguntar(app, c.cookie, 'crea');
    const [a] = await acciones(c.orgId);
    listas.delete(a.objeto_id);
    const r = await llamar(app, c.cookie, 'POST', `/api/panel/acciones/${a.id}/deshacer`);
    expect(r.json().estado).toBe('ya_no_existia');
    await app.close();
  });

  it('el paso "primera_accion" del resumen se completa al crear algo', async () => {
    const app = montar(new ModeloSimulado(crea('send_crear_lista', { nombre: 'Primera' })));
    const c = await cliente(app);
    const antes = (await llamar(app, c.cookie, 'GET', '/api/panel/resumen')).json().pasos.find((p: any) => p.id === 'primera_accion');
    expect(antes.hecho).toBe(false);
    await preguntar(app, c.cookie, 'crea');
    const despues = (await llamar(app, c.cookie, 'GET', '/api/panel/resumen')).json().pasos.find((p: any) => p.id === 'primera_accion');
    expect(despues.hecho).toBe(true);
    await app.close();
  });
});

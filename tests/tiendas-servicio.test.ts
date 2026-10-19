import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { cargarConfig } from '../src/config.js';
import { cargarLlaves } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import type { Bloque } from '../src/ia/modelo.js';
import { ModeloSimulado, type Guion } from '../src/ia/simulado.js';
import type { HttpSeguro, PeticionSegura } from '../src/conectores/http-seguro.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';
const CK = `ck_${randomBytes(16).toString('hex')}`; const CS = `cs_${randomBytes(16).toString('hex')}`;
const MALA = `cs_${'z'.repeat(32)}`;
const PII = ['Juan Perez', 'juan@correo.com', '3001234567'];

describe.skipIf(!hay)('tiendas: conexiones y chat', () => {
  let bd: BdPrueba;
  const llamadas: PeticionSegura[] = [];
  let n = 0;

  const pedidoWoo = (id: number) => ({ id, number: String(id), status: 'completed', currency: 'COP', total: '100000', date_created_gmt: '2026-10-05T10:00:00', billing: { first_name: 'Juan', last_name: 'Perez', email: 'juan@correo.com', phone: '3001234567' },
    line_items: [{ product_id: 7, name: 'Camiseta', sku: 'C1', quantity: 2, price: 50000 }] });
  const http = {
    pedir: async (p: PeticionSegura) => {
      llamadas.push(p);
      if (p.host.endsWith('.myshopify.com')) return { estado: 200, cuerpo: JSON.stringify({ data: { shop: { name: 'S', currencyCode: 'COP' } } }), cabeceras: {} };
      const auth = p.cabeceras.Authorization ?? '';
      const bien = auth === `Basic ${Buffer.from(`${CK}:${CS}`).toString('base64')}`;
      if (!bien) return { estado: 401, cuerpo: 'secreto-interno-no-debe-salir', cabeceras: {} };
      if (p.ruta.includes('currencies')) return { estado: 200, cuerpo: JSON.stringify({ code: 'COP' }), cabeceras: {} };
      if (p.ruta.startsWith('/wp-json/wc/v3/orders')) return { estado: 200, cuerpo: JSON.stringify([pedidoWoo(1), pedidoWoo(2)]), cabeceras: { 'x-wp-total': '2', 'x-wp-totalpages': '1' } };
      return { estado: 200, cuerpo: '[]', cabeceras: { 'x-wp-total': '0', 'x-wp-totalpages': '1' } };
    },
  } as unknown as HttpSeguro;

  beforeAll(async () => { bd = await prepararBdPrueba(); }, 60_000);
  afterAll(async () => { await bd?.cerrar(); });

  const montar = (guion?: Guion, modelo = new ModeloSimulado(guion)) => ({
    modelo,
    app: crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_SEND_URL: 'http://127.0.0.1:9', ARCHIE_IA_MAX_PASOS: '10' }), {
      pool: bd.app, llaves, modelo, httpTiendas: http, intentosTiendas: { max: 1000, ventanaMs: 60_000 }, limitesChat: { mensajesPorMinutoUsuario: 10_000, mensajesPorMinutoOrg: 10_000 }, rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } } }),
  });
  const llamar = (a: FastifyInstance, cookie: string, metodo: 'GET' | 'POST', url: string, payload?: object) => a.inject({ method: metodo, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  async function cliente(app: FastifyInstance) {
    const email = `admin${++n}@tiendas.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Cliente ${n}`, email, password: PW, nombreAdmin: `Admin ${n}` });
    const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW } });
    return { orgId: r.orgId, cookie: String(l.headers['set-cookie']).split(';')[0]! };
  }
  const woo = (nombre = 'Tienda principal', extra: object = {}) => ({ plataforma: 'woocommerce', nombre, dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS, ...extra });
  const eventos = (cuerpo: string) => cuerpo.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as any);
  const usar = (nombre: string, input: object = {}): Bloque => ({ type: 'tool_use', id: `toolu_${randomBytes(6).toString('hex')}`, name: nombre, input: input as Record<string, unknown> });
  const preguntar = (app: FastifyInstance, cookie: string, texto: string) => llamar(app, cookie, 'POST', '/api/panel/chat', { texto });

  it('conectar: prueba las credenciales, las guarda cifradas y nunca las devuelve', async () => {
    const { app } = montar();
    const c = await cliente(app);
    const mala = await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo('Tienda principal', { secreto: MALA }));
    expect(mala.statusCode).toBe(422); expect(mala.json().error).toBe('tienda_credencial_rechazada'); expect(mala.body).not.toContain('secreto-interno');
    expect((await llamar(app, c.cookie, 'GET', '/api/panel/tiendas')).json().tiendas).toEqual([]);

    expect((await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo())).statusCode).toBe(200);
    const lista = await llamar(app, c.cookie, 'GET', '/api/panel/tiendas');
    expect(lista.json().tiendas).toEqual([expect.objectContaining({ nombre: 'Tienda principal', plataforma: 'woocommerce', origen: 'tienda.ejemplo.com', pruebaOk: true })]);
    for (const secreto of [CK, CS]) expect(lista.body).not.toContain(secreto);

    const fila = (await conOrg(bd.owner, c.orgId, (cl) => cl.query("SELECT secreto, conector FROM credenciales_conector WHERE org_id = $1 AND conector LIKE 'tienda%'", [c.orgId]))).rows[0];
    expect(fila.conector).toBe('tienda_woocommerce');
    for (const secreto of [CK, CS]) expect(Buffer.from(fila.secreto).includes(Buffer.from(secreto))).toBe(false);
    const aud = (await conOrg(bd.app, c.orgId, (cl) => cl.query("SELECT detalle::text AS d FROM auditoria WHERE accion = 'conexion_tienda_guardada'"))).rows;
    expect(aud).toHaveLength(1); for (const secreto of [CK, CS]) expect(aud[0].d).not.toContain(secreto);
  });

  it('rechaza direcciones y nombres no válidos antes de salir a la red', async () => {
    const { app } = montar();
    const c = await cliente(app);
    const antes = llamadas.length;
    for (const dominio of ['http://tienda.ejemplo.com', 'https://169.254.169.254', 'localhost', 'https://tienda.ejemplo.com:8443', 'https://u:p@tienda.ejemplo.com', 'mi-servicio.internal']) {
      const r = await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo('X', { dominio }));
      expect(r.statusCode, dominio).toBe(400); expect(r.json().error).toBe('credencial_invalida');
    }
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo('<script>'))).json().error).toBe('nombre_invalido');
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', { ...woo(), extra: 1 })).statusCode).toBe(400);
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', { plataforma: 'magento', nombre: 'x' })).statusCode).toBe(400);
    expect(llamadas.length).toBe(antes);
  });

  it('solo un administrador cambia conexiones; otra organización no ve las tiendas', async () => {
    const { app } = montar();
    const a = await cliente(app); const b = await cliente(app);
    await llamar(app, a.cookie, 'POST', '/api/panel/tiendas', woo());
    const hash = (await conOrg(bd.owner, a.orgId, (cl) => cl.query('SELECT password_hash FROM usuarios WHERE org_id = $1', [a.orgId]))).rows[0].password_hash;
    await conOrg(bd.owner, a.orgId, (cl) => cl.query("INSERT INTO usuarios (org_id, email, password_hash, rol, nombre) VALUES ($1,'miembro@tiendas.test',$2,'miembro','Mia')", [a.orgId, hash]));
    const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'miembro@tiendas.test', password: PW } });
    const miembro = String(l.headers['set-cookie']).split(';')[0]!;
    expect((await llamar(app, miembro, 'POST', '/api/panel/tiendas', woo('Otra'))).statusCode).toBe(403);
    expect((await llamar(app, miembro, 'POST', '/api/panel/tiendas/quitar', { nombre: 'Tienda principal' })).statusCode).toBe(403);
    expect((await llamar(app, b.cookie, 'GET', '/api/panel/tiendas')).json().tiendas).toEqual([]);
    expect((await llamar(app, b.cookie, 'POST', '/api/panel/tiendas/quitar', { nombre: 'Tienda principal' })).statusCode).toBe(404);
    expect((await llamar(app, a.cookie, 'GET', '/api/panel/tiendas')).json().tiendas).toHaveLength(1);
  });

  it('nombre único sin importar mayúsculas ni plataforma, reemplazo de credenciales y máximo de tiendas', async () => {
    const { app } = montar();
    const c = await cliente(app);
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo('Mi Tienda'))).statusCode).toBe(200);
    // mismo nombre (otra capitalización) y misma plataforma: reemplaza, no duplica
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo('mi tienda'))).statusCode).toBe(200);
    expect((await llamar(app, c.cookie, 'GET', '/api/panel/tiendas')).json().tiendas).toHaveLength(1);
    // mismo nombre en otra plataforma: conflicto
    const shop = await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', { plataforma: 'shopify', nombre: 'MI TIENDA', tienda: 'otra', token: 'shpat_' + 'x'.repeat(30) });
    expect(shop.statusCode).toBe(409); expect(shop.json().error).toBe('nombre_en_uso');
    expect((await llamar(app, c.cookie, 'GET', '/api/panel/tiendas')).json().tiendas).toHaveLength(1);
    for (let i = 2; i <= 10; i++) expect((await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo(`Tienda ${i}`))).statusCode).toBe(200);
    const once = await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo('Tienda 11'));
    expect(once.statusCode).toBe(409); expect(once.json().error).toBe('demasiadas_tiendas');
  });

  it('quitar borra la conexión y deja constancia sin secretos', async () => {
    const { app } = montar();
    const c = await cliente(app);
    await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo());
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/tiendas/quitar', { nombre: 'tienda PRINCIPAL' })).statusCode).toBe(200);
    expect((await llamar(app, c.cookie, 'GET', '/api/panel/tiendas')).json().tiendas).toEqual([]);
    const aud = (await conOrg(bd.app, c.orgId, (cl) => cl.query("SELECT detalle::text AS d FROM auditoria WHERE accion = 'conexion_tienda_quitada'"))).rows;
    expect(aud).toHaveLength(1);
  });

  it('chat: solo con una tienda (sin Archie Send) consulta ventas, sin datos del comprador y sin herramientas de Send', async () => {
    const guion: Guion = (_p, paso) => (paso === 0 ? [usar('tienda_resumen_ventas', { periodo: '30_dias' })] : [{ type: 'text', text: 'Listo.' }]);
    const { app, modelo } = montar(guion);
    const c = await cliente(app);
    expect((await preguntar(app, c.cookie, 'hola')).statusCode).toBe(409); // sin ninguna conexión
    await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo());
    const r = await preguntar(app, c.cookie, '¿Cómo van las ventas?');
    const ev = eventos(r.body);
    expect(ev.at(-1)).toMatchObject({ tipo: 'fin' });
    expect(ev.find((e) => e.tipo === 'herramienta' && e.estado === 'listo')).toBeTruthy();
    const nombres = (modelo.peticiones[0] as any).herramientas.map((h: any) => h.name) as string[];
    expect(nombres.some((x) => x.startsWith('tienda'))).toBe(true); expect(nombres.some((x) => x.startsWith('send_'))).toBe(false);
    const resultado = JSON.stringify((modelo.peticiones[1] as any).mensajes);
    expect(resultado).toContain('fuente\\":\\"tienda'); expect(resultado).toContain('200000');
    for (const x of PII) expect(resultado).not.toContain(x);
    for (const s of [CK, CS]) expect(resultado + JSON.stringify(modelo.peticiones[0])).not.toContain(s);
    expect(String((modelo.peticiones[0] as any).sistema)).toContain('tienda_');
    expect(String((modelo.peticiones[0] as any).sistema)).not.toContain('PREPARAR borradores');
  });

  it('chat: si el modelo pide una herramienta de Send sin Send conectado, falla controlado', async () => {
    const guion: Guion = (_p, paso) => (paso === 0 ? [usar('send_listas')] : [{ type: 'text', text: 'No pude.' }]);
    const { app, modelo } = montar(guion);
    const c = await cliente(app);
    await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo());
    const ev = eventos((await preguntar(app, c.cookie, 'listas')).body);
    expect(ev.find((e) => e.tipo === 'herramienta' && e.estado === 'error')).toBeTruthy();
    expect(JSON.stringify((modelo.peticiones[1] as any).mensajes)).toContain('herramienta no existe');
  });

  it('chat: con varias tiendas pide elegir; una tienda que no existe da error claro; credencial vencida se marca', async () => {
    const guion = (nombre: string | undefined): Guion => (_p, paso) => (paso === 0 ? [usar('tienda_pedidos', nombre ? { tienda: nombre } : {})] : [{ type: 'text', text: 'ok' }]);
    const { app, modelo } = montar(guion(undefined));
    const c = await cliente(app);
    await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo('Una'));
    await llamar(app, c.cookie, 'POST', '/api/panel/tiendas', woo('Dos'));
    await preguntar(app, c.cookie, 'pedidos');
    expect(JSON.stringify((modelo.peticiones[1] as any).mensajes)).toContain('indica_tienda');

    const { app: app2, modelo: m2 } = montar(guion('No existe'));
    await preguntar(app2, c.cookie, 'pedidos');
    expect(JSON.stringify((m2.peticiones[1] as any).mensajes)).toContain('no está conectada');

    // Las credenciales dejan de servir en la tienda: el chat lo cuenta y la conexión queda marcada como fallida.
    const cambiada = { pedir: async () => ({ estado: 401, cuerpo: '', cabeceras: {} }) } as unknown as HttpSeguro;
    const m3 = new ModeloSimulado(guion('Una'));
    const app3 = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_IA_MAX_PASOS: '10' }), { pool: bd.app, llaves, modelo: m3, httpTiendas: cambiada, rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } } });
    await preguntar(app3, c.cookie, 'pedidos');
    expect(JSON.stringify((m3.peticiones[1] as any).mensajes)).toContain('rechazó las credenciales');
    const t = (await llamar(app, c.cookie, 'GET', '/api/panel/tiendas')).json().tiendas as any[];
    expect(t.find((x) => x.nombre === 'Una').pruebaOk).toBe(false); expect(t.find((x) => x.nombre === 'Dos').pruebaOk).toBe(true);
  });

  it('la base de datos impide plataformas desconocidas y nombres repetidos aunque el código falle', async () => {
    const { app } = montar();
    const c = await cliente(app);
    const ins = (conector: string, nombre: string) => conOrg(bd.owner, c.orgId, (cl) => cl.query(
      "INSERT INTO credenciales_conector (org_id, conector, nombre, secreto, clave_version) VALUES ($1,$2,$3,'\\x00',1)", [c.orgId, conector, nombre]));
    await expect(ins('tienda_magento', 'a')).rejects.toThrow();
    await ins('tienda_vtex', 'Mi Tienda');
    await expect(ins('tienda_shopify', 'mi tienda')).rejects.toThrow();
    await ins('send', 'principal'); // otros conectores no se ven afectados
  });
});

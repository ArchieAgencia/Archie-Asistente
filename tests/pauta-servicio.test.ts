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
const TOKEN = `EAA${randomBytes(20).toString('hex')}`;
const MALO = `EAA${randomBytes(20).toString('hex')}`;
const TOKEN_T = randomBytes(20).toString('hex');
const PII = ['Mujeres 25-34', 'juan@correo.com'];

describe.skipIf(!hay)('pauta: conexiones y chat', () => {
  let bd: BdPrueba;
  const llamadas: PeticionSegura[] = [];
  let n = 0;

  const http = {
    pedir: async (p: PeticionSegura) => {
      llamadas.push(p);
      const auth = p.cabeceras.Authorization ?? p.cabeceras['Access-Token'] ?? '';
      if (p.host === 'graph.facebook.com') {
        if (auth !== `Bearer ${TOKEN}`) return { estado: 400, cuerpo: JSON.stringify({ error: { code: 190, message: 'secreto-interno-no-debe-salir' } }), cabeceras: {} };
        if (p.ruta.includes('/insights')) return { estado: 200, cuerpo: JSON.stringify({ data: [{ spend: '50000', impressions: '1000', reach: '800', clicks: '40', actions: [], audience: 'Mujeres 25-34', lead_email: 'juan@correo.com' }] }), cabeceras: {} };
        return { estado: 200, cuerpo: JSON.stringify({ name: 'Cuenta', currency: 'COP', timezone_name: 'America/Bogota' }), cabeceras: {} };
      }
      if (auth !== TOKEN_T) return { estado: 200, cuerpo: JSON.stringify({ code: 40105, message: 'secreto-interno-no-debe-salir' }), cabeceras: {} };
      return { estado: 200, cuerpo: JSON.stringify({ code: 0, data: { list: [{ name: 'T', currency: 'COP', timezone: 'America/Bogota' }] } }), cabeceras: {} };
    },
  } as unknown as HttpSeguro;

  beforeAll(async () => { bd = await prepararBdPrueba(); }, 60_000);
  afterAll(async () => { await bd?.cerrar(); });

  const montar = (guion?: Guion, h: HttpSeguro = http) => {
    const modelo = new ModeloSimulado(guion);
    return { modelo, app: crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_SEND_URL: 'http://127.0.0.1:9', ARCHIE_IA_MAX_PASOS: '10' }), {
      pool: bd.app, llaves, modelo, httpTiendas: h, intentosTiendas: { max: 1000, ventanaMs: 60_000 }, limitesChat: { mensajesPorMinutoUsuario: 10_000, mensajesPorMinutoOrg: 10_000 }, rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } } }) };
  };
  const llamar = (a: FastifyInstance, cookie: string, metodo: 'GET' | 'POST', url: string, payload?: object) => a.inject({ method: metodo, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  async function cliente(app: FastifyInstance) {
    const email = `admin${++n}@pauta.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Cliente ${n}`, email, password: PW, nombreAdmin: `Admin ${n}` });
    const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW } });
    return { orgId: r.orgId, cookie: String(l.headers['set-cookie']).split(';')[0]! };
  }
  const meta = (nombre = 'Casa Trenza', extra: object = {}) => ({ plataforma: 'meta', nombre, cuenta: 'act_123456789', token: TOKEN, ...extra });
  const tiktok = (nombre = 'TikTok Casa', extra: object = {}) => ({ plataforma: 'tiktok', nombre, anunciante: '7123456789012345678', token: TOKEN_T, ...extra });
  const eventos = (cuerpo: string) => cuerpo.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as any);
  const usar = (nombre: string, input: object = {}): Bloque => ({ type: 'tool_use', id: `toolu_${randomBytes(6).toString('hex')}`, name: nombre, input: input as Record<string, unknown> });
  const preguntar = (app: FastifyInstance, cookie: string, texto: string) => llamar(app, cookie, 'POST', '/api/panel/chat', { texto });

  it('conectar: prueba el token, lo guarda cifrado y nunca lo devuelve', async () => {
    const { app } = montar();
    const c = await cliente(app);
    const mala = await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta('Casa Trenza', { token: MALO }));
    expect(mala.statusCode).toBe(422); expect(mala.json().error).toBe('pauta_credencial_rechazada'); expect(mala.body).not.toContain('secreto-interno');
    expect((await llamar(app, c.cookie, 'GET', '/api/panel/pauta')).json().cuentas).toEqual([]);

    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta())).statusCode).toBe(200);
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', tiktok())).statusCode).toBe(200);
    const lista = await llamar(app, c.cookie, 'GET', '/api/panel/pauta');
    expect(lista.json().cuentas).toEqual([
      expect.objectContaining({ nombre: 'Casa Trenza', plataforma: 'meta', origen: 'act_123456789', pruebaOk: true }),
      expect.objectContaining({ nombre: 'TikTok Casa', plataforma: 'tiktok', pruebaOk: true }),
    ]);
    for (const s of [TOKEN, TOKEN_T]) expect(lista.body).not.toContain(s);

    const filas = (await conOrg(bd.owner, c.orgId, (cl) => cl.query("SELECT secreto, conector FROM credenciales_conector WHERE org_id = $1 AND conector LIKE 'pauta%'", [c.orgId]))).rows;
    expect(filas.map((f) => f.conector).sort()).toEqual(['pauta_meta', 'pauta_tiktok']);
    for (const f of filas) for (const s of [TOKEN, TOKEN_T]) expect(Buffer.from(f.secreto).includes(Buffer.from(s))).toBe(false);
    const aud = (await conOrg(bd.app, c.orgId, (cl) => cl.query("SELECT detalle::text AS d FROM auditoria WHERE accion = 'conexion_pauta_guardada'"))).rows;
    expect(aud).toHaveLength(2); for (const a of aud) for (const s of [TOKEN, TOKEN_T]) expect(a.d).not.toContain(s);
  });

  it('formatos inválidos se rechazan antes de salir a la red', async () => {
    const { app } = montar();
    const c = await cliente(app);
    const antes = llamadas.length;
    for (const cuenta of ['abc', '../x', '12']) expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta('X', { cuenta }))).json().error, cuenta).toBe('credencial_invalida');
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta('X', { token: 'corto' }))).json().error).toBe('credencial_invalida');
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', tiktok('X', { anunciante: 'no-numero' }))).json().error).toBe('credencial_invalida');
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta('<script>'))).json().error).toBe('nombre_invalido');
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', { ...meta(), extra: 1 })).statusCode).toBe(400);
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', { plataforma: 'google', nombre: 'x' })).statusCode).toBe(400);
    expect(llamadas.length).toBe(antes);
  });

  it('solo un administrador cambia conexiones; otra organización no ve las cuentas', async () => {
    const { app } = montar();
    const a = await cliente(app); const b = await cliente(app);
    await llamar(app, a.cookie, 'POST', '/api/panel/pauta', meta());
    const hash = (await conOrg(bd.owner, a.orgId, (cl) => cl.query('SELECT password_hash FROM usuarios WHERE org_id = $1', [a.orgId]))).rows[0].password_hash;
    await conOrg(bd.owner, a.orgId, (cl) => cl.query("INSERT INTO usuarios (org_id, email, password_hash, rol, nombre) VALUES ($1,'miembro@pauta.test',$2,'miembro','Mia')", [a.orgId, hash]));
    const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'miembro@pauta.test', password: PW } });
    const miembro = String(l.headers['set-cookie']).split(';')[0]!;
    expect((await llamar(app, miembro, 'POST', '/api/panel/pauta', meta('Otra'))).statusCode).toBe(403);
    expect((await llamar(app, miembro, 'POST', '/api/panel/pauta/quitar', { nombre: 'Casa Trenza' })).statusCode).toBe(403);
    expect((await llamar(app, b.cookie, 'GET', '/api/panel/pauta')).json().cuentas).toEqual([]);
    expect((await llamar(app, b.cookie, 'POST', '/api/panel/pauta/quitar', { nombre: 'Casa Trenza' })).statusCode).toBe(404);
    expect((await llamar(app, a.cookie, 'GET', '/api/panel/pauta')).json().cuentas).toHaveLength(1);
  });

  it('nombre único, reemplazo de token y máximo de cuentas', async () => {
    const { app } = montar();
    const c = await cliente(app);
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta('Mi Cuenta'))).statusCode).toBe(200);
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta('mi cuenta'))).statusCode).toBe(200);
    expect((await llamar(app, c.cookie, 'GET', '/api/panel/pauta')).json().cuentas).toHaveLength(1);
    const otra = await llamar(app, c.cookie, 'POST', '/api/panel/pauta', tiktok('MI CUENTA'));
    expect(otra.statusCode).toBe(409); expect(otra.json().error).toBe('nombre_en_uso');
    for (let i = 2; i <= 20; i++) expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta(`Cuenta ${i}`))).statusCode).toBe(200);
    const veintiuna = await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta('Cuenta 21'));
    expect(veintiuna.statusCode).toBe(409); expect(veintiuna.json().error).toBe('demasiadas_cuentas');
  });

  it('quitar borra la conexión y deja constancia sin secretos', async () => {
    const { app } = montar();
    const c = await cliente(app);
    await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta());
    expect((await llamar(app, c.cookie, 'POST', '/api/panel/pauta/quitar', { nombre: 'casa TRENZA' })).statusCode).toBe(200);
    expect((await llamar(app, c.cookie, 'GET', '/api/panel/pauta')).json().cuentas).toEqual([]);
    const aud = (await conOrg(bd.app, c.orgId, (cl) => cl.query("SELECT detalle::text AS d FROM auditoria WHERE accion = 'conexion_pauta_quitada'"))).rows;
    expect(aud).toHaveLength(1); expect(aud[0].d).not.toContain(TOKEN);
  });

  it('chat: solo con pauta conectada consulta métricas, sin herramientas de Send ni de tiendas y sin secretos ni datos de personas', async () => {
    const guion: Guion = (_p, paso) => (paso === 0 ? [usar('pauta_resumen', { periodo: '7_dias' })] : [{ type: 'text', text: 'Listo.' }]);
    const { app, modelo } = montar(guion);
    const c = await cliente(app);
    expect((await preguntar(app, c.cookie, 'hola')).statusCode).toBe(409);
    await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta());
    const ev = eventos((await preguntar(app, c.cookie, '¿Cómo va la pauta?')).body);
    expect(ev.at(-1)).toMatchObject({ tipo: 'fin' });
    expect(ev.find((e) => e.tipo === 'herramienta' && e.estado === 'listo')).toBeTruthy();
    const nombres = (modelo.peticiones[0] as any).herramientas.map((h: any) => h.name) as string[];
    expect(nombres.some((x) => x.startsWith('pauta_'))).toBe(true);
    expect(nombres.some((x) => x.startsWith('send_') || x.startsWith('tienda'))).toBe(false);
    const resultado = JSON.stringify((modelo.peticiones[1] as any).mensajes);
    expect(resultado).toContain('50000');
    for (const x of PII) expect(resultado).not.toContain(x);
    for (const s of [TOKEN, TOKEN_T]) expect(resultado + JSON.stringify(modelo.peticiones[0])).not.toContain(s);
    expect(String((modelo.peticiones[0] as any).sistema)).toContain('pauta_');
  });

  it('chat: varias cuentas piden elegir; una inexistente da error claro; token vencido marca la conexión', async () => {
    const guion = (nombre?: string): Guion => (_p, paso) => (paso === 0 ? [usar('pauta_resumen', nombre ? { cuenta: nombre } : {})] : [{ type: 'text', text: 'ok' }]);
    const { app, modelo } = montar(guion());
    const c = await cliente(app);
    await llamar(app, c.cookie, 'POST', '/api/panel/pauta', meta('Una'));
    await llamar(app, c.cookie, 'POST', '/api/panel/pauta', tiktok('Dos'));
    await preguntar(app, c.cookie, 'resumen');
    expect(JSON.stringify((modelo.peticiones[1] as any).mensajes)).toContain('indica_cuenta');

    const { app: app2, modelo: m2 } = montar(guion('No existe'));
    await preguntar(app2, c.cookie, 'resumen');
    expect(JSON.stringify((m2.peticiones[1] as any).mensajes)).toContain('no está conectada');

    const vencido = { pedir: async () => ({ estado: 400, cuerpo: JSON.stringify({ error: { code: 190 } }), cabeceras: {} }) } as unknown as HttpSeguro;
    const { app: app3, modelo: m3 } = montar(guion('Una'), vencido);
    await preguntar(app3, c.cookie, 'resumen');
    expect(JSON.stringify((m3.peticiones[1] as any).mensajes)).toContain('rechazó');
    const t = (await llamar(app, c.cookie, 'GET', '/api/panel/pauta')).json().cuentas as any[];
    expect(t.find((x) => x.nombre === 'Una').pruebaOk).toBe(false); expect(t.find((x) => x.nombre === 'Dos').pruebaOk).toBe(true);
  });

  it('la base de datos impide plataformas desconocidas y nombres repetidos aunque el código falle', async () => {
    const { app } = montar();
    const c = await cliente(app);
    const ins = (conector: string, nombre: string) => conOrg(bd.owner, c.orgId, (cl) => cl.query(
      "INSERT INTO credenciales_conector (org_id, conector, nombre, secreto, clave_version) VALUES ($1,$2,$3,'\\x00',1)", [c.orgId, conector, nombre]));
    await expect(ins('pauta_google', 'a')).rejects.toThrow();
    await ins('pauta_meta', 'Mi Cuenta');
    await expect(ins('pauta_tiktok', 'mi cuenta')).rejects.toThrow();
    await ins('tienda_vtex', 'Mi Cuenta'); // otra familia no se ve afectada
  });
});

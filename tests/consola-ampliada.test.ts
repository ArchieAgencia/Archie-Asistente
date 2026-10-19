import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { codigoActual } from '../src/auth/totp.js';
import { cargarConfig } from '../src/config.js';
import { cargarLlaves, hashToken } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { crearOperador, marcarCuentaPropia, type RolOperador } from '../src/db/operadores.js';
import { CorreoMemoria } from '../src/correo/correo.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';
const PW_OP = 'clave-del-equipo-muy-larga-1';

describe.skipIf(!hay)('consola ampliada: conexiones, uso, widget, equipo y Mi cuenta', () => {
  let bd: BdPrueba;
  let app: FastifyInstance;
  let appObligatoria: FastifyInstance;
  let ahora = Date.now();
  let n = 0;
  const correoPrueba = new CorreoMemoria();
  const secretos = new Map<string, string>();
  const alertas = () => correoPrueba.enviados.filter((m) => m.asunto.startsWith('Consola de Archie AI'));

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    const deps = { pool: bd.app, llaves, relojConsola: () => ahora, correo: correoPrueba, rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } } };
    app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_ORIGEN: 'https://archie.ejemplo.test' }), deps);
    appObligatoria = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'obligatorio', ARCHIE_ORIGEN: 'https://archie.ejemplo.test' }), deps);
  }, 60_000);
  afterAll(async () => { await app?.close(); await appObligatoria?.close(); await bd?.cerrar(); });

  const codigo = (email: string) => { ahora += 30_000; return codigoActual(secretos.get(email)!, ahora); };
  async function nuevoOperador(rol: RolOperador = 'admin') {
    const email = `op${++n}@archie.test`;
    const r = await crearOperador(bd.owner, llaves, { email, nombre: `Operador ${n}`, rol, password: PW_OP });
    secretos.set(email, r.secretoTotp);
    return { email, id: r.id };
  }
  async function entrar(email: string) {
    const a = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email, password: PW_OP } });
    expect(a.statusCode).toBe(200);
    const pend = String(a.headers['set-cookie']).split(';')[0]!;
    const b = await app.inject({ method: 'POST', url: '/api/consola/auth/2fa', headers: { cookie: pend }, payload: { codigo: codigo(email) } });
    expect(b.statusCode).toBe(200);
    return String(b.headers['set-cookie']).split(';')[0]!;
  }
  const api = (cookie: string, metodo: 'GET' | 'POST', url: string, payload?: object, a: FastifyInstance = app) =>
    a.inject({ method: metodo, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  async function nuevaOrg(nombre?: string) {
    const email = `c${++n}@cliente.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: nombre ?? `Cliente ${n}`, email, password: PW, nombreAdmin: `Persona ${n}` });
    return { email, ...r };
  }
  const dueno = (orgId: string, sql: string, params: unknown[] = []) => conOrg(bd.owner, orgId, (cx) => cx.query(sql, params));

  // ---------- Conexiones por cliente ----------

  async function conexion(orgId: string, conector: string, nombre: string, pruebaOk: boolean | null) {
    const id = randomUUID();
    await dueno(orgId, `INSERT INTO credenciales_conector (id, org_id, conector, nombre, secreto, clave_version, probada_en, prueba_ok, origen)
      VALUES ($1,$2,$3,$4,$5,1, CASE WHEN $6::boolean IS NULL THEN NULL ELSE now() END, $6, 'tienda.ejemplo.test')`, [id, orgId, conector, nombre, Buffer.from('SECRETO-QUE-NO-DEBE-SALIR-0123456789'), pruebaOk]);
    return id;
  }

  it('conexiones: la ficha muestra el estado de cada una y NUNCA el secreto', async () => {
    const o = await nuevoOperador('soporte');
    const c = await entrar(o.email);
    const org = await nuevaOrg();
    await conexion(org.orgId, 'tienda_woocommerce', 'principal', true);
    await conexion(org.orgId, 'suite_booking', 'principal', false);
    const r = await api(c, 'GET', `/api/consola/clientes/${org.orgId}/conexiones`);
    expect(r.statusCode).toBe(200);
    const lista = r.json() as Array<Record<string, unknown>>;
    expect(lista.map((x) => x.conector)).toEqual(['suite_booking', 'tienda_woocommerce']);
    expect(lista.find((x) => x.conector === 'suite_booking')).toMatchObject({ pruebaOk: false, origen: 'tienda.ejemplo.test' });
    expect(r.body).not.toContain('SECRETO');
    expect(r.body).not.toContain('secreto');
    expect((await api(c, 'GET', `/api/consola/clientes/${randomUUID()}/conexiones`)).statusCode).toBe(404);
    // la consola no puede leer la columna del secreto aunque se lo propusiera
    await expect(bd.owner.query("SET ROLE archie_consola; SELECT secreto FROM credenciales_conector").finally(() => bd.owner.query('RESET ROLE'))).rejects.toThrow(/permission denied/);
  });

  it('conexiones: solo se quita una que está fallando, con código nuevo, en la cuenta correcta, y queda en la bitácora del cliente', async () => {
    const o = await nuevoOperador('soporte');
    const c = await entrar(o.email);
    const org = await nuevaOrg();
    const otra = await nuevaOrg();
    const sana = await conexion(org.orgId, 'pauta_meta', 'principal', true);
    const sinProbar = await conexion(org.orgId, 'pauta_tiktok', 'cuenta-tiktok', null);
    const mala = await conexion(org.orgId, 'suite_talk', 'principal', false);
    const url = `/api/consola/clientes/${org.orgId}/conexiones/quitar`;
    expect((await api(c, 'POST', url, { id: mala, codigo: '123456' })).statusCode).toBe(401);                   // código inválido
    expect((await api(c, 'POST', url, { id: sana, codigo: codigo(o.email) })).json()).toMatchObject({ error: 'conexion_sana' });
    expect((await api(c, 'POST', url, { id: sinProbar, codigo: codigo(o.email) })).json()).toMatchObject({ error: 'conexion_sana' });
    expect((await api(c, 'POST', `/api/consola/clientes/${otra.orgId}/conexiones/quitar`, { id: mala, codigo: codigo(o.email) })).statusCode).toBe(404); // otra cuenta
    expect((await api(c, 'POST', url, { id: mala, codigo: codigo(o.email) })).statusCode).toBe(200);
    const quedan = (await dueno(org.orgId, 'SELECT conector FROM credenciales_conector ORDER BY conector')).rows.map((f) => f.conector);
    expect(quedan).toEqual(['pauta_meta', 'pauta_tiktok']);
    const b = (await dueno(org.orgId, "SELECT detalle, operador_nombre FROM acciones_operador WHERE accion = 'conexion_quitada'")).rows;
    expect(b).toHaveLength(1);
    expect(b[0].detalle).toContain('suite_talk');
  });

  it('conexiones: finanzas puede ver pero no quitar', async () => {
    const o = await nuevoOperador('finanzas');
    const c = await entrar(o.email);
    const org = await nuevaOrg();
    const mala = await conexion(org.orgId, 'suite_meet', 'principal', false);
    expect((await api(c, 'GET', `/api/consola/clientes/${org.orgId}/conexiones`)).statusCode).toBe(200);
    expect((await api(c, 'POST', `/api/consola/clientes/${org.orgId}/conexiones/quitar`, { id: mala, codigo: codigo(o.email) })).statusCode).toBe(403);
  });

  // ---------- Uso y costos ----------

  it('uso: totales por cliente y por mes, herramientas más usadas, errores y serie; no mezcla meses ni clientes', async () => {
    const o = await nuevoOperador('finanzas');
    const c = await entrar(o.email);
    const a = await nuevaOrg('Uso A');
    const b = await nuevaOrg('Uso B');
    const mes = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 7);
    await dueno(a.orgId, `INSERT INTO uso_ia (org_id, modelo, tokens_entrada, tokens_salida, tokens_cache, costo_micro_usd) VALUES ($1,'m-1',1000,200,50,12000),($1,'m-2',500,100,0,3000)`, [a.orgId]);
    await dueno(a.orgId, `INSERT INTO uso_ia (org_id, modelo, tokens_entrada, tokens_salida, costo_micro_usd, creado_en) VALUES ($1,'m-1',9999,9999,999999, now() - interval '70 days')`, [a.orgId]);
    await dueno(b.orgId, `INSERT INTO uso_ia (org_id, modelo, tokens_entrada, tokens_salida, costo_micro_usd) VALUES ($1,'m-1',10,5,100)`, [b.orgId]);
    await dueno(a.orgId, `INSERT INTO llamadas_herramienta (org_id, herramienta, ok, codigo) VALUES ($1,'tienda_resumen',true,NULL),($1,'tienda_resumen',true,NULL),($1,'pauta_resumen',false,'http_403'),($1,'pauta_resumen',false,'http_403'),($1,'booking_reservas',false,'tiempo_agotado')`, [a.orgId]);
    await dueno(a.orgId, `INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia) VALUES ($1,'consumo',-1,'u1'),($1,'consumo',-1,'u2'),($1,'consumo',-1,'u3')`, [a.orgId]);

    const g = (await api(c, 'GET', `/api/consola/uso?mes=${mes}`)).json() as { mes: string; clientes: Array<Record<string, unknown>>; total: Record<string, number> };
    expect(g.mes).toBe(mes);
    const fa = g.clientes.find((x) => x.nombre === 'Uso A')!;
    expect(fa).toMatchObject({ consultas: 3, tokensEntrada: 1500, tokensSalida: 300, tokensCache: 50, costoMicroUsd: 15000, errores: 3 });
    expect(g.clientes.find((x) => x.nombre === 'Uso B')).toMatchObject({ consultas: 0, tokensEntrada: 10, costoMicroUsd: 100, errores: 0 });
    expect(g.total.costoMicroUsd).toBeGreaterThanOrEqual(15100);

    const d = (await api(c, 'GET', `/api/consola/clientes/${a.orgId}/uso?mes=${mes}`)).json() as Record<string, any>;
    expect(d).toMatchObject({ mes, consultas: 3, costoMicroUsd: 15000, llamadas: 5, errores: 3 });
    expect(d.herramientas[0]).toEqual({ herramienta: 'pauta_resumen', usos: 2, errores: 2 });
    expect(d.herramientas.map((x: any) => x.herramienta).sort()).toEqual(['booking_reservas', 'pauta_resumen', 'tienda_resumen']);
    expect(d.codigosError[0]).toEqual({ codigo: 'http_403', veces: 2 });
    expect(d.modelos[0]).toMatchObject({ modelo: 'm-1', costoMicroUsd: 12000 });
    expect(d.serie).toHaveLength(6);
    expect(d.serie.at(-1)).toMatchObject({ mes, consultas: 3, costoMicroUsd: 15000 });
    // el gasto de hace 70 días aparece en su propio mes de la serie y no se suma al mes actual
    expect(d.serie.find((x: any) => x.costoMicroUsd === 999999)).toBeDefined();
    expect(d.serie.at(-1).costoMicroUsd).toBe(15000);

    expect((await api(c, 'GET', '/api/consola/uso?mes=2026-13')).statusCode).toBe(400);
    expect((await api(c, 'GET', `/api/consola/clientes/${randomUUID()}/uso`)).statusCode).toBe(404);
  });

  // ---------- Widget por cliente ----------

  it('widget: muestra sitios y claves (sin valores) y revocar una cierra sus sesiones; exige código y rol', async () => {
    const o = await nuevoOperador('soporte');
    const c = await entrar(o.email);
    const fin = await nuevoOperador('finanzas');
    const cf = await entrar(fin.email);
    const org = await nuevaOrg();
    const claveId = randomUUID();
    await dueno(org.orgId, `INSERT INTO incrustacion_origenes (org_id, origen) VALUES ($1,'https://send.ejemplo.test')`, [org.orgId]);
    await dueno(org.orgId, `INSERT INTO incrustacion_claves (id, org_id, nombre, prefijo, clave_hash) VALUES ($1,$2,'Archie Send','aw_abcd',$3)`, [claveId, org.orgId, hashToken('x'.repeat(40))]);
    const usuario = org.usuarioId;
    await dueno(org.orgId, `INSERT INTO sesiones_widget (org_id, usuario_id, clave_id, tipo, token_hash, expira_en) VALUES ($1,$2,$3,'sesion',$4, now() + interval '1 hour')`, [org.orgId, usuario, claveId, hashToken('s'.repeat(40))]);

    const v = await api(c, 'GET', `/api/consola/clientes/${org.orgId}/widget`);
    const w = v.json() as { origenes: any[]; claves: any[]; sesionesActivas: number };
    expect(w.origenes[0].origen).toBe('https://send.ejemplo.test');
    expect(w.claves[0]).toMatchObject({ id: claveId, nombre: 'Archie Send', prefijo: 'aw_abcd', revocada: false });
    expect(w.sesionesActivas).toBe(1);
    expect(v.body).not.toContain('clave_hash');
    expect(v.body).not.toContain('hash');

    const url = `/api/consola/clientes/${org.orgId}/widget/revocar`;
    expect((await api(cf, 'POST', url, { clave: claveId, codigo: codigo(fin.email) })).statusCode).toBe(403);   // finanzas no revoca
    expect((await api(c, 'POST', url, { clave: claveId, codigo: '000000' })).statusCode).toBe(401);
    expect((await api(c, 'POST', url, { clave: claveId, codigo: codigo(o.email) })).statusCode).toBe(200);
    expect((await api(c, 'POST', url, { clave: claveId, codigo: codigo(o.email) })).statusCode).toBe(404);     // ya revocada
    const despues = (await api(c, 'GET', `/api/consola/clientes/${org.orgId}/widget`)).json() as { claves: any[]; sesionesActivas: number };
    expect(despues.claves[0].revocada).toBe(true);
    expect(despues.sesionesActivas).toBe(0);
    expect((await dueno(org.orgId, "SELECT 1 FROM acciones_operador WHERE accion = 'widget_clave_revocada'")).rowCount).toBe(1);
  });

  // ---------- Mi cuenta · Archie Tech ----------

  const sesionPanel = (cookie: string, url = '/auth/yo', a: FastifyInstance = app) => a.inject({ method: 'GET', url, headers: { cookie } });

  it('Mi cuenta: sin cuenta propia configurada no abre; con ella, cada persona entra con su propio usuario y rol', async () => {
    const admin = await nuevoOperador('admin');
    const sop = await nuevoOperador('soporte');
    const ca = await entrar(admin.email);
    const cs = await entrar(sop.email);
    expect((await api(ca, 'GET', '/api/consola/yo')).json()).toMatchObject({ cuentaPropia: false });
    expect((await api(ca, 'POST', '/api/consola/mi-cuenta/abrir')).statusCode).toBe(404);

    const propia = await nuevaOrg('Archie Tech (propia)');
    expect(await marcarCuentaPropia(bd.owner, propia.orgId)).toBe(true);
    expect((await api(ca, 'GET', '/api/consola/yo')).json()).toMatchObject({ cuentaPropia: true });

    const r1 = await api(ca, 'POST', '/api/consola/mi-cuenta/abrir');
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ organizacion: 'Archie Tech (propia)' });
    const cookie1 = String(r1.headers['set-cookie']).split(';')[0]!;
    expect(cookie1.startsWith('archie_sid=')).toBe(true);
    const yo1 = (await sesionPanel(cookie1)).json() as Record<string, unknown>;
    expect(yo1).toMatchObject({ rol: 'admin', organizacion: 'Archie Tech (propia)', puente: true, nombre: 'Operador ' + admin.email.match(/\d+/)![0] });

    const r2 = await api(cs, 'POST', '/api/consola/mi-cuenta/abrir');
    const cookie2 = String(r2.headers['set-cookie']).split(';')[0]!;
    const yo2 = (await sesionPanel(cookie2)).json() as Record<string, unknown>;
    expect(yo2).toMatchObject({ rol: 'miembro', puente: true });
    expect(yo2.id).not.toBe(yo1.id);                       // cada persona, su identidad
    expect(String(yo1.email)).toMatch(/^equipo-[0-9a-f]{12}@equipo\.archie\.invalid$/);

    // Abrir otra vez reutiliza el mismo usuario y deja una sola sesión puente por persona.
    const r1b = await api(ca, 'POST', '/api/consola/mi-cuenta/abrir');
    const yo1b = (await sesionPanel(String(r1b.headers['set-cookie']).split(';')[0]!)).json() as Record<string, unknown>;
    expect(yo1b.id).toBe(yo1.id);
    expect((await sesionPanel(cookie1)).statusCode).toBe(401);
    expect((await dueno(propia.orgId, 'SELECT count(*)::int AS n FROM sesiones WHERE puente_operador IS NOT NULL')).rows[0].n).toBe(2);

    // Queda en la bitácora de la cuenta propia
    expect((await dueno(propia.orgId, "SELECT 1 FROM acciones_operador WHERE accion = 'mi_cuenta_abierta'")).rowCount).toBeGreaterThanOrEqual(3);
  });

  it('Mi cuenta: la sesión puente solo ve la cuenta propia, y la cuenta de otro cliente no se abre por ningún camino', async () => {
    const op = await nuevoOperador('admin');
    const c = await entrar(op.email);
    const otro = await nuevaOrg('Cliente ajeno');
    const abrir = await api(c, 'POST', '/api/consola/mi-cuenta/abrir');
    const ck = String(abrir.headers['set-cookie']).split(';')[0]!;
    const conv = await sesionPanel(ck, '/api/panel/chat/conversaciones');
    expect(conv.statusCode).toBe(200);
    expect(conv.json()).toEqual([]);                                          // nada del cliente ajeno
    // el cuerpo de la petición no puede escoger otra organización
    const intento = await api(c, 'POST', '/api/consola/mi-cuenta/abrir', { orgId: otro.orgId } as object);
    const ck2 = String(intento.headers['set-cookie']).split(';')[0]!;
    expect((await sesionPanel(ck2)).json()).toMatchObject({ organizacion: 'Archie Tech (propia)' });
    // la cuenta propia no puede ser a la vez la de un cliente: solo una marcada
    expect((await bd.owner.query('SELECT count(*)::int AS n FROM organizaciones WHERE es_propia')).rows[0].n).toBe(1);
  });

  it('Mi cuenta: sin sesión de operador completa no se abre, y una sesión de cliente no sirve', async () => {
    const op = await nuevoOperador('admin');
    const a = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: op.email, password: PW_OP } });
    const pend = String(a.headers['set-cookie']).split(';')[0]!;
    expect((await api(pend, 'POST', '/api/consola/mi-cuenta/abrir')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/consola/mi-cuenta/abrir' })).statusCode).toBe(401);
    const org = await nuevaOrg();
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: org.email, password: PW } });
    expect((await api(String(login.headers['set-cookie']).split(';')[0]!, 'POST', '/api/consola/mi-cuenta/abrir')).statusCode).toBe(401);
  });

  it('Mi cuenta: salir de la consola o desactivar a la persona cierra su sesión de cliente', async () => {
    const admin = await nuevoOperador('admin');
    const sop = await nuevoOperador('soporte');
    const ca = await entrar(admin.email);
    const cs = await entrar(sop.email);
    const ck = String((await api(cs, 'POST', '/api/consola/mi-cuenta/abrir')).headers['set-cookie']).split(';')[0]!;
    expect((await sesionPanel(ck)).statusCode).toBe(200);
    await api(cs, 'POST', '/api/consola/auth/logout');
    expect((await sesionPanel(ck)).statusCode).toBe(401);

    const cs2 = await entrar(sop.email);
    const ck2 = String((await api(cs2, 'POST', '/api/consola/mi-cuenta/abrir')).headers['set-cookie']).split(';')[0]!;
    expect((await sesionPanel(ck2)).statusCode).toBe(200);
    const r = await api(ca, 'POST', `/api/consola/equipo/${sop.id}/estado`, { activo: false, codigo: codigo(admin.email) });
    expect(r.statusCode).toBe(200);
    expect((await sesionPanel(ck2)).statusCode).toBe(401);
    expect((await api(cs2, 'GET', '/api/consola/yo')).statusCode).toBe(401);
  });

  it('Mi cuenta: con 2FA obligatorio la sesión puente no pide otro segundo factor, y la aplicación no puede fabricar sesiones puente', async () => {
    const op = await nuevoOperador('admin');
    const c = await entrar(op.email);
    const ck = String((await api(c, 'POST', '/api/consola/mi-cuenta/abrir')).headers['set-cookie']).split(';')[0]!;
    expect((await sesionPanel(ck, '/api/panel/chat/conversaciones', appObligatoria)).statusCode).toBe(200);
    // un administrador común sin 2FA sí queda limitado (control: la excepción es solo del puente)
    const org = await nuevaOrg();
    const login = await appObligatoria.inject({ method: 'POST', url: '/auth/login', payload: { email: org.email, password: PW } });
    expect((await sesionPanel(String(login.headers['set-cookie']).split(';')[0]!, '/api/panel/chat/conversaciones', appObligatoria)).statusCode).toBe(403);
    // la aplicación no puede escribir la marca de puente
    await expect(conOrg(bd.app, org.orgId, (cx) => cx.query(
      `INSERT INTO sesiones (org_id, usuario_id, token_hash, expira_en, puente_operador) VALUES ($1,$2,$3, now() + interval '1 hour', $4)`,
      [org.orgId, org.usuarioId, hashToken('p'.repeat(40)), op.id]))).rejects.toThrow(/permission denied/);
    // ni crear ni cambiar la marca de cuenta propia
    await expect(conOrg(bd.app, org.orgId, (cx) => cx.query('UPDATE organizaciones SET es_propia = true WHERE id = $1', [org.orgId]))).rejects.toThrow(/permission denied/);
  });

  it('Mi cuenta: cambiar el rol de la persona cambia su rol en la cuenta propia y cierra su sesión abierta', async () => {
    const admin = await nuevoOperador('admin');
    const otra = await nuevoOperador('soporte');
    const ca = await entrar(admin.email);
    const co = await entrar(otra.email);
    const ck = String((await api(co, 'POST', '/api/consola/mi-cuenta/abrir')).headers['set-cookie']).split(';')[0]!;
    expect((await sesionPanel(ck)).json()).toMatchObject({ rol: 'miembro' });
    expect((await api(ca, 'POST', `/api/consola/equipo/${otra.id}/rol`, { rol: 'admin', codigo: codigo(admin.email) })).statusCode).toBe(200);
    expect((await sesionPanel(ck)).statusCode).toBe(401);
    const ck2 = String((await api(co, 'POST', '/api/consola/mi-cuenta/abrir')).headers['set-cookie']).split(';')[0]!;
    expect((await sesionPanel(ck2)).json()).toMatchObject({ rol: 'admin' });
  });

  // ---------- Equipo de Archie ----------

  it('equipo: invitar, activar con contraseña y segundo factor propios, y entrar; el enlace sirve una sola vez', async () => {
    const admin = await nuevoOperador('admin');
    const c = await entrar(admin.email);
    const correo = `nueva${++n}@archie.test`;
    const antes = correoPrueba.enviados.length;
    const r = await api(c, 'POST', '/api/consola/equipo', { email: correo, nombre: 'Laura Gómez', rol: 'soporte', codigo: codigo(admin.email) });
    expect(r.statusCode).toBe(200);
    const inv = (r.json() as { invitacion: { enviada: boolean; enlace?: string } }).invitacion;
    expect(inv.enviada).toBe(true);
    expect(inv.enlace).toBeUndefined();
    const mail = correoPrueba.enviados.slice(antes).find((m) => m.para === correo)!;
    expect(mail.asunto).toBe('Te invitaron al equipo de Archie AI');
    const token = /\/equipo-archie\/activar#t=([A-Za-z0-9_-]+)/.exec(mail.texto)![1]!;

    // Aún no puede entrar (ni siquiera con una contraseña que adivine): está inactiva
    expect((await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: correo, password: PW_OP } })).statusCode).toBe(401);
    const lista = ((await api(c, 'GET', '/api/consola/equipo')).json() as { operadores: any[] }).operadores;
    expect(lista.find((x) => x.email === correo)).toMatchObject({ pendiente: true, activo: false, rol: 'soporte' });

    const ver = await app.inject({ method: 'POST', url: '/api/consola/activacion/ver', payload: { token } });
    expect(ver.json()).toMatchObject({ email: correo, nombre: 'Laura Gómez', rol: 'soporte' });
    // contraseña débil y completar antes de iniciar
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/iniciar', payload: { token, password: 'corta' } })).json()).toMatchObject({ error: 'password_debil' });
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/completar', payload: { token, codigo: '123456' } })).json()).toMatchObject({ error: 'activacion_incompleta' });

    const nueva = 'mi-propia-clave-larga-77';
    const ini = (await app.inject({ method: 'POST', url: '/api/consola/activacion/iniciar', payload: { token, password: nueva } })).json() as { secretoTotp: string; uri: string };
    expect(ini.secretoTotp).toMatch(/^[A-Z2-7]{20,}$/);
    expect(ini.uri).toContain('otpauth://totp/');
    // Todavía no está activa: el código tiene que confirmarse
    expect((await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: correo, password: nueva } })).statusCode).toBe(401);
    ahora += 30_000;
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/completar', payload: { token, codigo: '000000' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/completar', payload: { token, codigo: codigoActual(ini.secretoTotp, ahora) } })).statusCode).toBe(200);

    // Ahora sí: entra con SU contraseña y SU segundo factor
    secretos.set(correo, ini.secretoTotp);
    const a = await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: correo, password: nueva } });
    expect(a.statusCode).toBe(200);
    const pend = String(a.headers['set-cookie']).split(';')[0]!;
    ahora += 30_000;
    const b = await app.inject({ method: 'POST', url: '/api/consola/auth/2fa', headers: { cookie: pend }, payload: { codigo: codigoActual(ini.secretoTotp, ahora) } });
    expect(b.statusCode).toBe(200);
    expect((await api(String(b.headers['set-cookie']).split(';')[0]!, 'GET', '/api/consola/yo')).json()).toMatchObject({ email: correo, rol: 'soporte' });

    // El enlace ya no sirve
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/ver', payload: { token } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/iniciar', payload: { token, password: 'otra-clave-larga-88' } })).statusCode).toBe(404);
    const act = ((await api(c, 'GET', '/api/consola/equipo')).json() as { operadores: any[] }).operadores.find((x) => x.email === correo);
    expect(act).toMatchObject({ pendiente: false, activo: true });
    // y el secreto del segundo factor quedó cifrado
    const f = (await bd.owner.query('SELECT totp_secreto FROM operadores WHERE email = $1', [correo])).rows[0];
    expect(Buffer.from(f.totp_secreto).includes(Buffer.from(ini.secretoTotp))).toBe(false);
    const bit = ((await api(c, 'GET', '/api/consola/equipo/bitacora')).json() as any[]).map((x) => x.accion);
    expect(bit).toEqual(expect.arrayContaining(['operador_invitado', 'operador_activado']));
  });

  it('equipo: una invitación vencida o con demasiados intentos no sirve y se puede reenviar con otro enlace', async () => {
    const admin = await nuevoOperador('admin');
    const c = await entrar(admin.email);
    const correo = `vence${++n}@archie.test`;
    const antes = correoPrueba.enviados.length;
    const inv = await api(c, 'POST', '/api/consola/equipo', { email: correo, nombre: 'Pedro', rol: 'finanzas', codigo: codigo(admin.email) });
    const id = (inv.json() as { id: string }).id;
    const t1 = /#t=([A-Za-z0-9_-]+)/.exec(correoPrueba.enviados.slice(antes).find((m) => m.para === correo)!.texto)![1]!;

    // adivinar códigos: tras el tope la invitación deja de servir
    await app.inject({ method: 'POST', url: '/api/consola/activacion/iniciar', payload: { token: t1, password: 'una-clave-valida-123' } });
    let ultimo = 0;
    for (let i = 0; i < 12; i++) ultimo = (await app.inject({ method: 'POST', url: '/api/consola/activacion/completar', payload: { token: t1, codigo: '000000' } })).statusCode;
    expect(ultimo).toBe(404);

    // reenviar: nuevo enlace, el viejo muere
    const antes2 = correoPrueba.enviados.length;
    expect((await api(c, 'POST', `/api/consola/equipo/${id}/reenviar-invitacion`, { codigo: codigo(admin.email) })).statusCode).toBe(200);
    const t2 = /#t=([A-Za-z0-9_-]+)/.exec(correoPrueba.enviados.slice(antes2).find((m) => m.para === correo)!.texto)![1]!;
    expect(t2).not.toBe(t1);
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/ver', payload: { token: t1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/ver', payload: { token: t2 } })).statusCode).toBe(200);

    // vencida
    await bd.owner.query("UPDATE invitaciones_operador SET expira_en = now() - interval '1 minute' WHERE operador_id = $1", [id]);
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/ver', payload: { token: t2 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/consola/activacion/ver', payload: { token: 'no-es-un-token' } })).statusCode).toBe(400);
  });

  it('equipo: solo administración gestiona; no puedes desactivarte ni cambiarte el rol; el último administrador no se quita', async () => {
    const admin = await nuevoOperador('admin');
    const sop = await nuevoOperador('soporte');
    const c = await entrar(admin.email);
    const cs = await entrar(sop.email);
    expect((await api(cs, 'GET', '/api/consola/equipo')).statusCode).toBe(403);
    expect((await api(cs, 'GET', '/api/consola/equipo/bitacora')).statusCode).toBe(403);
    expect((await api(cs, 'POST', '/api/consola/equipo', { email: 'x@archie.test', nombre: 'X', rol: 'admin', codigo: codigo(sop.email) })).statusCode).toBe(403);
    expect((await api(c, 'POST', `/api/consola/equipo/${admin.id}/estado`, { activo: false, codigo: codigo(admin.email) })).json()).toMatchObject({ error: 'no_a_ti_mismo' });
    expect((await api(c, 'POST', `/api/consola/equipo/${admin.id}/rol`, { rol: 'soporte', codigo: codigo(admin.email) })).json()).toMatchObject({ error: 'no_a_ti_mismo' });
    expect((await api(c, 'POST', '/api/consola/equipo', { email: sop.email, nombre: 'Repetido', rol: 'soporte', codigo: codigo(admin.email) })).statusCode).toBe(409);
    expect((await api(c, 'POST', '/api/consola/equipo', { email: 'sin-arroba', nombre: 'X', rol: 'soporte', codigo: codigo(admin.email) })).statusCode).toBe(400);
    expect((await api(c, 'POST', '/api/consola/equipo', { email: `ok${++n}@archie.test`, nombre: 'X', rol: 'dios', codigo: codigo(admin.email) })).statusCode).toBe(400);

    // Último administrador: dejamos solo a `admin` activo entre los administradores y otro admin intenta quitarlo
    await bd.owner.query("UPDATE operadores SET activo = false WHERE rol = 'admin' AND id <> $1 AND id <> $2", [admin.id, sop.id]);
    const otroAdmin = await nuevoOperador('admin');
    const co = await entrar(otroAdmin.email);
    await bd.owner.query("UPDATE operadores SET activo = false WHERE rol = 'admin' AND id <> $1 AND id <> $2", [admin.id, otroAdmin.id]);
    expect((await api(co, 'POST', `/api/consola/equipo/${admin.id}/estado`, { activo: false, codigo: codigo(otroAdmin.email) })).statusCode).toBe(200); // aún queda otroAdmin
    expect((await api(co, 'POST', `/api/consola/equipo/${admin.id}/estado`, { activo: true, codigo: codigo(otroAdmin.email) })).statusCode).toBe(200);
    // promover a soporte: queda con dos administradores; bajar a uno y luego al otro es lo que se impide
    await api(co, 'POST', `/api/consola/equipo/${admin.id}/rol`, { rol: 'finanzas', codigo: codigo(otroAdmin.email) });
    // Ahora otroAdmin es el único administrador activo: nadie (solo él mismo, que no puede) podría quitarlo; lo comprobamos desde la base
    await expect(bd.app.query('SELECT consola_estado_operador($1,$2,$3)', [Buffer.alloc(32), otroAdmin.id, false])).rejects.toThrow();
  });

  it('equipo: un operador pendiente no se puede "reactivar" y desactivar corta sus sesiones al instante', async () => {
    const admin = await nuevoOperador('admin');
    const c = await entrar(admin.email);
    const sop = await nuevoOperador('finanzas');
    const cs = await entrar(sop.email);
    expect((await api(cs, 'GET', '/api/consola/yo')).statusCode).toBe(200);
    expect((await api(c, 'POST', `/api/consola/equipo/${sop.id}/estado`, { activo: false, codigo: codigo(admin.email) })).statusCode).toBe(200);
    expect((await api(cs, 'GET', '/api/consola/yo')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: sop.email, password: PW_OP } })).statusCode).toBe(401);
    expect((await api(c, 'POST', `/api/consola/equipo/${sop.id}/estado`, { activo: true, codigo: codigo(admin.email) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/consola/auth/login', payload: { email: sop.email, password: PW_OP } })).statusCode).toBe(200);

    const inv = await api(c, 'POST', '/api/consola/equipo', { email: `pend${++n}@archie.test`, nombre: 'Pendiente', rol: 'soporte', codigo: codigo(admin.email) });
    const pid = (inv.json() as { id: string }).id;
    expect((await api(c, 'POST', `/api/consola/equipo/${pid}/estado`, { activo: true, codigo: codigo(admin.email) })).json()).toMatchObject({ error: 'pendiente_de_activar' });
    expect((await api(c, 'POST', `/api/consola/equipo/${randomUUID()}/estado`, { activo: false, codigo: codigo(admin.email) })).statusCode).toBe(404);
  });

  // ---------- Alertas ----------

  it('alertas: cada acción sensible avisa por correo a las personas administradoras, sin datos del cliente final, y un fallo del correo no frena la acción', async () => {
    const admin = await nuevoOperador('admin');
    const otroAdmin = await nuevoOperador('admin');
    const c = await entrar(admin.email);
    const org = await nuevaOrg('Clínica Alerta');
    const antes = alertas().length;
    const r = await api(c, 'POST', `/api/consola/clientes/${org.orgId}/estado`, { estado: 'suspendido', codigo: codigo(admin.email) });
    expect(r.statusCode).toBe(200);
    const nuevas = alertas().slice(antes);
    const paras = nuevas.map((m) => m.para);
    expect(paras).toEqual(expect.arrayContaining([admin.email, otroAdmin.email]));
    const m = nuevas.find((x) => x.para === otroAdmin.email)!;
    expect(m.texto).toContain('Clínica Alerta');
    expect(m.texto).toContain(`Operador ${admin.email.match(/\d+/)![0]}`);
    expect(m.texto).toMatch(/suspendido/);
    expect(m.texto).not.toContain(org.email);                      // ni el correo de la persona del cliente
    expect(m.html).not.toContain('<script');

    // soporte no recibe alertas
    const sop = await nuevoOperador('soporte');
    expect(alertas().slice(antes).some((x) => x.para === sop.email)).toBe(false);

    // si el correo falla, la acción se hace igual
    correoPrueba.falla = true;
    try {
      const r2 = await api(c, 'POST', `/api/consola/clientes/${org.orgId}/estado`, { estado: 'activo', codigo: codigo(admin.email) });
      expect(r2.statusCode).toBe(200);
    } finally { correoPrueba.falla = false; }
    expect((await dueno(org.orgId, 'SELECT estado FROM organizaciones WHERE id = $1', [org.orgId])).rows[0].estado).toBe('activo');
  });

  it('alertas: invitar, desactivar y cambiar el rol de alguien del equipo también avisan', async () => {
    const admin = await nuevoOperador('admin');
    const c = await entrar(admin.email);
    const sop = await nuevoOperador('soporte');
    const antes = alertas().length;
    await api(c, 'POST', '/api/consola/equipo', { email: `al${++n}@archie.test`, nombre: 'Alguien', rol: 'soporte', codigo: codigo(admin.email) });
    await api(c, 'POST', `/api/consola/equipo/${sop.id}/rol`, { rol: 'finanzas', codigo: codigo(admin.email) });
    await api(c, 'POST', `/api/consola/equipo/${sop.id}/estado`, { activo: false, codigo: codigo(admin.email) });
    const asuntos = alertas().slice(antes).filter((m) => m.para === admin.email).map((m) => m.asunto);
    expect(asuntos.some((a) => a.includes('Invitó'))).toBe(true);
    expect(asuntos.some((a) => a.includes('Cambió el rol'))).toBe(true);
    expect(asuntos.some((a) => a.includes('Desactivó'))).toBe(true);
  });
});

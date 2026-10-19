import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { hashCodigo, nuevoCodigoRecuperacion, normalizarCodigo } from '../src/auth/codigos.js';
import { codigoActual } from '../src/auth/totp.js';
import { cargarConfig } from '../src/config.js';
import { CorreoMemoria } from '../src/correo/correo.js';
import { cargarLlaves } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { TAREAS_LIMPIEZA } from '../src/db/limpieza.js';
import { crearOperador } from '../src/db/operadores.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';
const PW2 = 'otra-clave-muy-larga-2';

describe('códigos de recuperación (formato)', () => {
  it('16 caracteres sin ambiguos, en grupos de 4; se normalizan y no se repiten', () => {
    const k = nuevoCodigoRecuperacion();
    expect(k).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    expect(normalizarCodigo(k.toLowerCase().replace(/-/g, ' '))).toBe(k.replace(/-/g, ''));
    expect(normalizarCodigo('ABC')).toBeNull();
    expect(normalizarCodigo('0000-0000-0000-0000')).toBeNull();
    expect(new Set(Array.from({ length: 200 }, nuevoCodigoRecuperacion)).size).toBe(200);
    expect(hashCodigo('AAAA')).not.toEqual(hashCodigo('AAAB'));
  });
});

describe.skipIf(!hay)('recuperación de acceso', () => {
  let bd: BdPrueba; let app: FastifyInstance; let n = 0;
  const correo = new CorreoMemoria();

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_ORIGEN: 'https://archie.ejemplo.test' }), {
      pool: bd.app, llaves, correo, rutas: { limites: { porIp: 10_000, porCorreo: 10_000, ventanaMs: 60_000 } } });
  }, 60_000);
  afterAll(async () => { await app?.close(); await bd?.cerrar(); });

  const post = (url: string, payload: object, cookie?: string) => app.inject({ method: 'POST', url, payload, ...(cookie ? { headers: { cookie } } : {}) });
  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const cookieDe = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;
  const esperar = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); };
  const correosA = (email: string) => correo.enviados.filter((m) => m.para === email);
  const auditoria = (orgId: string) => conOrg(bd.owner, orgId, (c) => c.query('SELECT accion FROM auditoria ORDER BY id')).then((r) => r.rows.map((x) => x.accion as string));

  async function usuario() {
    const email = `r${++n}@ejemplo.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Org ${n}`, email, password: PW, nombreAdmin: `Persona ${n}` });
    return { email, ...r };
  }
  /** Activa el 2FA y devuelve los códigos de recuperación. */
  async function conDosFactores() {
    const u = await usuario();
    const ck = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
    const { secreto } = (await post('/auth/2fa/iniciar', { password: PW }, ck)).json() as { secreto: string };
    const conf = await post('/auth/2fa/confirmar', { codigo: codigoActual(secreto) }, ck);
    expect(conf.statusCode).toBe(200);
    return { ...u, secreto, codigos: conf.json().codigos as string[], cookie: ck };
  }
  /** Contraseña correcta: queda una sesión pendiente del segundo factor. */
  const pendiente = async (email: string, password = PW) => cookieDe(await post('/auth/login', { email, password }));

  // ---------- Códigos de recuperación ----------

  it('al activar el 2FA se entregan 10 códigos una sola vez y en la base solo quedan sus hashes', async () => {
    const u = await conDosFactores();
    expect(u.codigos).toHaveLength(10);
    expect(new Set(u.codigos).size).toBe(10);
    expect((await get('/auth/yo', u.cookie)).json()).toMatchObject({ codigosRestantes: 10 });
    const filas = (await conOrg(bd.owner, u.orgId, (c) => c.query('SELECT codigo_hash FROM codigos_recuperacion WHERE usuario_id = $1', [u.usuarioId]))).rows;
    expect(filas).toHaveLength(10);
    for (const k of u.codigos) {
      expect(filas.some((f) => (f.codigo_hash as Buffer).equals(hashCodigo(normalizarCodigo(k)!)))).toBe(true);
      expect(JSON.stringify(filas)).not.toContain(k.replace(/-/g, ''));
    }
    expect(await auditoria(u.orgId)).toContain('2fa_activado');
  });

  it('un código de recuperación abre la sesión una sola vez, avisa por correo y deja la auditoría', async () => {
    const u = await conDosFactores();
    const escrito = u.codigos[0]!.toLowerCase().replace(/-/g, ' ');
    const r = await post('/auth/2fa', { recuperacion: escrito }, await pendiente(u.email));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ estado: 'ok', codigosRestantes: 9 });
    expect((await get('/auth/yo', cookieDe(r))).statusCode).toBe(200);
    // el mismo código no sirve otra vez
    const otra = await post('/auth/2fa', { recuperacion: u.codigos[0] }, await pendiente(u.email));
    expect(otra.statusCode).toBe(401);
    expect(otra.json().error).toBe('codigo_invalido');
    // los demás siguen sirviendo
    expect((await post('/auth/2fa', { recuperacion: u.codigos[1] }, await pendiente(u.email))).statusCode).toBe(200);
    await esperar(() => correosA(u.email).filter((m) => /código de recuperación/.test(m.asunto)).length >= 2);
    const avisos = correosA(u.email).filter((m) => /código de recuperación/.test(m.asunto));
    expect(avisos.length).toBeGreaterThanOrEqual(2);
    expect(avisos[0]!.texto).toContain('Te quedan 9 códigos');
    expect(JSON.stringify(avisos)).not.toContain(u.codigos[0]!.replace(/-/g, ''));
    expect(await auditoria(u.orgId)).toContain('login_codigo_recuperacion');
  });

  it('el código de otra persona no sirve, y los fallos bloquean la cuenta como con cualquier código', async () => {
    const a = await conDosFactores(); const b = await conDosFactores();
    expect((await post('/auth/2fa', { recuperacion: b.codigos[0] }, await pendiente(a.email))).statusCode).toBe(401);
    const ck = await pendiente(a.email);
    for (let i = 0; i < 4; i++) expect((await post('/auth/2fa', { recuperacion: 'AAAA-BBBB-CCCC-DDDD' }, ck)).statusCode).toBe(401);
    // con 5 fallos seguidos la cuenta se bloquea: ni el código bueno entra
    expect((await post('/auth/2fa', { recuperacion: 'AAAA-BBBB-CCCC-DDDD' }, ck)).statusCode).toBe(401);
    expect((await post('/auth/2fa', { recuperacion: a.codigos[2] }, ck)).statusCode).toBe(401);
    expect((await post('/auth/login', { email: a.email, password: PW })).statusCode).toBe(401);
  });

  it('dos peticiones a la vez con el mismo código: solo una entra', async () => {
    const u = await conDosFactores();
    const [c1, c2] = [await pendiente(u.email), await pendiente(u.email)];
    const rs = await Promise.all([post('/auth/2fa', { recuperacion: u.codigos[3] }, c1), post('/auth/2fa', { recuperacion: u.codigos[3] }, c2)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('regenerar pide la contraseña y la sesión completa, invalida el juego anterior y exige tener el 2FA activo', async () => {
    const u = await conDosFactores();
    expect((await post('/auth/2fa/codigos', { password: 'incorrecta-incorrecta' }, u.cookie)).statusCode).toBe(401);
    expect((await post('/auth/2fa/codigos', { password: PW }, await pendiente(u.email))).statusCode).toBe(401); // sesión pendiente
    const nuevo = await post('/auth/2fa/codigos', { password: PW }, u.cookie);
    expect(nuevo.statusCode).toBe(200);
    const codigos = nuevo.json().codigos as string[];
    expect(codigos).toHaveLength(10);
    expect((await post('/auth/2fa', { recuperacion: u.codigos[4] }, await pendiente(u.email))).statusCode).toBe(401); // el juego viejo ya no sirve
    expect((await post('/auth/2fa', { recuperacion: codigos[0] }, await pendiente(u.email))).statusCode).toBe(200);
    // sin 2FA no hay códigos que generar
    const s = await usuario();
    const ck = cookieDe(await post('/auth/login', { email: s.email, password: PW }));
    expect((await post('/auth/2fa/codigos', { password: PW }, ck)).statusCode).toBe(409);
  });

  // ---------- Recuperación de contraseña ----------

  const tokenDelCorreo = (email: string, desde = 0) => {
    const m = correosA(email).slice(desde).filter((x) => /Restablece/.test(x.asunto)).at(-1);
    return m ? decodeURIComponent(/#t=([^\s"]+)/.exec(m.texto)![1]!) : null;
  };

  it('el enlace del correo cambia la contraseña una sola vez, cierra las sesiones y avisa del cambio', async () => {
    const u = await usuario();
    const viva = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
    const r = await post('/auth/recuperar', { email: u.email.toUpperCase() });
    expect(r.json()).toEqual({ estado: 'ok' });
    await esperar(() => tokenDelCorreo(u.email) !== null);
    const token = tokenDelCorreo(u.email)!;
    const m = correosA(u.email).find((x) => /Restablece/.test(x.asunto))!;
    expect(m.texto).toContain('https://archie.ejemplo.test/restablecer#t=');
    expect(m.html).not.toContain(PW);
    // contraseña débil: se rechaza SIN gastar el enlace
    expect((await post('/auth/restablecer', { token, nueva: 'corta' })).statusCode).toBe(400);
    expect((await post('/auth/restablecer', { token, nueva: PW2 })).statusCode).toBe(200);
    expect((await get('/auth/yo', viva)).statusCode).toBe(401); // la sesión abierta quedó cerrada
    expect((await post('/auth/login', { email: u.email, password: PW })).statusCode).toBe(401);
    expect((await post('/auth/login', { email: u.email, password: PW2 })).statusCode).toBe(200);
    const reuso = await post('/auth/restablecer', { token, nueva: 'tercera-clave-larga-3' });
    expect(reuso.statusCode).toBe(400);
    expect(reuso.json().error).toBe('enlace_invalido');
    await esperar(() => correosA(u.email).some((x) => /Cambió la contraseña/.test(x.asunto)));
    expect(correosA(u.email).some((x) => /Cambió la contraseña/.test(x.asunto))).toBe(true);
    expect(await auditoria(u.orgId)).toEqual(expect.arrayContaining(['password_recuperacion_solicitada', 'password_restablecida']));
  });

  it('responde igual para correos sin cuenta o desactivados y no envía nada', async () => {
    const u = await usuario();
    await conOrg(bd.owner, u.orgId, (c) => c.query('UPDATE usuarios SET activo = false WHERE id = $1', [u.usuarioId]));
    const antes = correo.enviados.length;
    const rs = await Promise.all([post('/auth/recuperar', { email: 'nadie@ejemplo.test' }), post('/auth/recuperar', { email: u.email })]);
    expect(rs.map((r) => [r.statusCode, r.json()])).toEqual([[200, { estado: 'ok' }], [200, { estado: 'ok' }]]);
    await new Promise((r) => setTimeout(r, 300));
    expect(correo.enviados.length).toBe(antes);
  });

  it('una solicitud nueva anula el enlace anterior y hay un máximo de 3 por hora', async () => {
    const u = await usuario();
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const antes = correosA(u.email).length;
      await post('/auth/recuperar', { email: u.email });
      await esperar(() => correosA(u.email).length > antes);
      tokens.push(tokenDelCorreo(u.email, antes)!);
    }
    expect(new Set(tokens).size).toBe(3);
    expect((await post('/auth/restablecer', { token: tokens[0], nueva: PW2 })).statusCode).toBe(400); // anulado por el más nuevo
    const antes = correosA(u.email).length;
    await post('/auth/recuperar', { email: u.email }); // la cuarta no genera correo
    await new Promise((r) => setTimeout(r, 300));
    expect(correosA(u.email).length).toBe(antes);
    expect((await post('/auth/restablecer', { token: tokens[2], nueva: PW2 })).statusCode).toBe(200);
  });

  it('un enlace vencido o inventado no sirve y dice lo mismo', async () => {
    const u = await usuario();
    await post('/auth/recuperar', { email: u.email });
    await esperar(() => tokenDelCorreo(u.email) !== null);
    const token = tokenDelCorreo(u.email)!;
    await conOrg(bd.owner, u.orgId, (c) => c.query("UPDATE recuperaciones_password SET expira_en = now() - interval '1 minute' WHERE usuario_id = $1", [u.usuarioId]));
    const vencido = await post('/auth/restablecer', { token, nueva: PW2 });
    const falso = await post('/auth/restablecer', { token: randomBytes(32).toString('base64url'), nueva: PW2 });
    expect([vencido.statusCode, falso.statusCode]).toEqual([400, 400]);
    expect(vencido.json()).toEqual(falso.json());
  });

  it('restablecer la contraseña no salta el segundo factor y levanta el bloqueo por intentos', async () => {
    const u = await conDosFactores();
    for (let i = 0; i < 5; i++) await post('/auth/login', { email: u.email, password: 'mala-mala-mala-1' });
    expect((await post('/auth/login', { email: u.email, password: PW })).statusCode).toBe(401); // bloqueada
    await post('/auth/recuperar', { email: u.email });
    await esperar(() => tokenDelCorreo(u.email) !== null);
    expect((await post('/auth/restablecer', { token: tokenDelCorreo(u.email)!, nueva: PW2 })).statusCode).toBe(200);
    const r = await post('/auth/login', { email: u.email, password: PW2 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ estado: 'requiere_2fa' });
    expect((await get('/auth/yo', cookieDe(r))).statusCode).toBe(401);
  });

  it('un fallo del correo no cambia la respuesta ni rompe nada', async () => {
    const u = await usuario();
    correo.falla = true;
    try { expect((await post('/auth/recuperar', { email: u.email })).json()).toEqual({ estado: 'ok' }); await new Promise((r) => setTimeout(r, 200)); }
    finally { correo.falla = false; }
  });

  it('la aplicación no puede leer el hash del enlace ni "des-usar" un enlace o un código', async () => {
    const u = await conDosFactores();
    await post('/auth/2fa', { recuperacion: u.codigos[0] }, await pendiente(u.email)); // deja un código usado
    for (let i = 0; i < 2; i++) { // la segunda solicitud anula la primera: queda un enlace marcado como usado
      const antes = correosA(u.email).length;
      await post('/auth/recuperar', { email: u.email });
      await esperar(() => correosA(u.email).length > antes);
    }
    await expect(conOrg(bd.app, u.orgId, (c) => c.query('SELECT token_hash FROM recuperaciones_password'))).rejects.toThrow(/permission denied/);
    await expect(conOrg(bd.app, u.orgId, (c) => c.query('UPDATE recuperaciones_password SET expira_en = now() + interval \'1 year\'', []))).rejects.toThrow(/permission denied/);
    await expect(conOrg(bd.app, u.orgId, (c) => c.query('UPDATE codigos_recuperacion SET usado_en = NULL WHERE usado_en IS NOT NULL'))).rejects.toThrow(/ya_usado/);
    await expect(conOrg(bd.app, u.orgId, (c) => c.query('UPDATE recuperaciones_password SET usada_en = NULL WHERE usada_en IS NOT NULL'))).rejects.toThrow(/ya_usado/);
  });

  // ---------- Limpieza ----------

  it('la limpieza borra solo lo vencido o sin uso y deja lo vigente', async () => {
    const u = await usuario();
    const ses = (horas: number, tag: string) => conOrg(bd.owner, u.orgId, (c) => c.query(
      "INSERT INTO sesiones (org_id, usuario_id, token_hash, expira_en) VALUES ($1,$2,$3, now() + make_interval(hours => $4))", [u.orgId, u.usuarioId, Buffer.from(tag.padEnd(32, 'x')), horas]));
    await ses(-72, 'vencida'); await ses(-12, 'vencida-hoy'); await ses(24, 'vigente');
    const inv = (email: string, cols: string, ant: string) => conOrg(bd.owner, u.orgId, (c) => c.query(
      `INSERT INTO invitaciones (org_id, email, rol, token_hash, invitado_por_operador, expira_en, ${cols}) VALUES ($1,$2,'miembro',$3,gen_random_uuid(), now() + interval '1 day', now() - interval '${ant}')`,
      [u.orgId, email, randomBytes(32)]));
    await inv('vieja-usada@x.test', 'usada_en', '100 days'); await inv('reciente-usada@x.test', 'usada_en', '10 days'); await inv('vieja-revocada@x.test', 'revocada_en', '100 days');
    await conOrg(bd.owner, u.orgId, (c) => c.query("INSERT INTO invitaciones (org_id, email, rol, token_hash, invitado_por_operador, expira_en, creada_en) VALUES ($1,'vencida-sin-aceptar@x.test','admin',$2,gen_random_uuid(), now() - interval '200 days', now() - interval '210 days')", [u.orgId, randomBytes(32)]));
    await conOrg(bd.owner, u.orgId, (c) => c.query("INSERT INTO recuperaciones_password (org_id, usuario_id, token_hash, expira_en) VALUES ($1,$2,$3, now() - interval '2 days'), ($1,$2,$4, now() + interval '10 minutes')", [u.orgId, u.usuarioId, randomBytes(32), randomBytes(32)]));

    const op = await crearOperador(bd.owner, llaves, { email: `op${++n}@archie.test`, nombre: 'Op', rol: 'soporte', password: 'clave-equipo-muy-larga-1' }); // gitleaks:allow (valor falso de prueba)
    for (const [h, tag] of [[-72, 'a'], [24, 'b']] as const) {
      await bd.owner.query("INSERT INTO sesiones_operador (operador_id, token_hash, expira_en, mfa_ok) VALUES ($1,$2, now() + make_interval(hours => $3), true)", [op.id, Buffer.from(tag.padEnd(32, 'o')), h]);
    }
    for (const t of TAREAS_LIMPIEZA) await bd.owner.query(t.sql); // sin contexto de organización, como la tarea programada

    const q = (sql: string) => conOrg(bd.owner, u.orgId, (c) => c.query(sql)).then((r) => r.rows);
    expect((await q('SELECT count(*)::int AS n FROM sesiones WHERE usuario_id = \'' + u.usuarioId + '\' AND expira_en < now()'))[0].n).toBe(1); // solo la de hace menos de 1 día
    expect((await q('SELECT count(*)::int AS n FROM sesiones WHERE expira_en > now()'))[0].n).toBeGreaterThanOrEqual(1);
    expect((await q('SELECT email FROM invitaciones ORDER BY email')).map((x) => x.email)).toEqual(['reciente-usada@x.test', 'vencida-sin-aceptar@x.test']);
    expect((await q('SELECT count(*)::int AS n FROM recuperaciones_password'))[0].n).toBe(1);
    expect((await bd.owner.query('SELECT count(*)::int AS n FROM sesiones_operador WHERE operador_id = $1', [op.id])).rows[0].n).toBe(1);
  });
});

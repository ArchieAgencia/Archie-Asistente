import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { crearApp } from '../src/app.js';
import { codigoActual } from '../src/auth/totp.js';
import { cargarConfig } from '../src/config.js';
import { cargarLlaves } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { crearOrganizacionConAdmin, resetear2fa } from '../src/db/semilla.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const ORIGEN = 'https://archie.ejemplo.test';
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';

describe.skipIf(!hay)('autenticación', () => {
  let bd: BdPrueba;
  let app: FastifyInstance;
  let n = 0;

  const config = cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_ORIGEN: ORIGEN });

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    app = crearApp(config, { pool: bd.app, llaves, rutas: { limites: { porIp: 1000, porCorreo: 1000, ventanaMs: 60_000 } } });
  }, 60_000);
  afterAll(async () => { await app?.close(); await bd?.cerrar(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Crea una organización con su administrador y devuelve sus datos. */
  async function nuevoUsuario() {
    const email = `u${++n}@ejemplo.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Org ${n}`, email, password: PW });
    return { email, ...r };
  }

  const post = (url: string, payload: object, cookie?: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers: { ...(cookie ? { cookie } : {}), ...extra } });
  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const cookieDe = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;
  const auditoria = (orgId: string) =>
    conOrg(bd.owner, orgId, (c) => c.query('SELECT accion, detalle FROM auditoria ORDER BY id')).then((r) => r.rows as { accion: string; detalle: Record<string, unknown> }[]);

  async function entrar(email: string, password = PW) {
    const r = await post('/auth/login', { email, password });
    expect(r.statusCode).toBe(200);
    return r;
  }

  it('inicia sesión sin 2FA, entrega cookie segura y permite ver el perfil', async () => {
    const u = await nuevoUsuario();
    const r = await entrar(u.email);
    expect(r.json()).toMatchObject({ estado: 'ok', usuario: { rol: 'admin', totpActivo: false } });
    const set = String(r.headers['set-cookie']);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(r.headers['cache-control']).toBe('no-store');
    const yo = await get('/auth/yo', cookieDe(r));
    expect(yo.statusCode).toBe(200);
    expect(yo.json()).toMatchObject({ email: u.email, rol: 'admin' });
    expect(JSON.stringify(yo.json())).not.toMatch(/hash|secreto|password/i);
  });

  it('el correo no distingue mayúsculas', async () => {
    const u = await nuevoUsuario();
    expect((await post('/auth/login', { email: u.email.toUpperCase(), password: PW })).statusCode).toBe(200);
  });

  it('rechaza contraseña mala y correo inexistente con la misma respuesta', async () => {
    const u = await nuevoUsuario();
    const mala = await post('/auth/login', { email: u.email, password: 'otra-clave-equivocada' });
    const inexistente = await post('/auth/login', { email: 'nadie@ejemplo.test', password: 'otra-clave-equivocada' });
    expect(mala.statusCode).toBe(401);
    expect(inexistente.statusCode).toBe(401);
    expect(mala.body).toBe(inexistente.body);
    expect(mala.headers['set-cookie']).toBeUndefined();
  });

  it('bloquea la cuenta tras 5 fallos: ni la contraseña correcta entra mientras dure el bloqueo', async () => {
    const u = await nuevoUsuario();
    for (let i = 0; i < 5; i++) expect((await post('/auth/login', { email: u.email, password: 'incorrecta-incorrecta' })).statusCode).toBe(401);
    const r = await post('/auth/login', { email: u.email, password: PW });
    expect(r.statusCode).toBe(401);
    expect(r.body).toBe((await post('/auth/login', { email: 'nadie@ejemplo.test', password: PW })).body);
    expect((await auditoria(u.orgId)).map((a) => a.accion)).toContain('login_bloqueado');
    // Al vencer el bloqueo, se puede entrar de nuevo y el contador se reinicia.
    await conOrg(bd.owner, u.orgId, (c) => c.query("UPDATE usuarios SET bloqueado_hasta = now() - interval '1 second' WHERE id = $1", [u.usuarioId]));
    expect((await post('/auth/login', { email: u.email, password: PW })).statusCode).toBe(200);
    const f = await conOrg(bd.owner, u.orgId, (c) => c.query('SELECT intentos_fallidos FROM usuarios WHERE id = $1', [u.usuarioId]));
    expect(f.rows[0].intentos_fallidos).toBe(0);
  });

  it('100 contraseñas malas en paralelo: solo se evalúan 5 antes del bloqueo y la correcta tampoco entra', async () => {
    const u = await nuevoUsuario();
    const rs = await Promise.all(Array.from({ length: 100 }, () => post('/auth/login', { email: u.email, password: 'incorrecta-incorrecta' })));
    expect(rs.every((r) => r.statusCode === 401)).toBe(true);
    const acciones = (await auditoria(u.orgId)).map((a) => a.accion);
    expect(acciones.filter((a) => a === 'login_fallido').length).toBe(5);
    expect(acciones.filter((a) => a === 'login_bloqueado').length).toBe(95);
    expect((await post('/auth/login', { email: u.email, password: PW })).statusCode).toBe(401);
  }, 60_000);

  it('entrar bien muchas veces con 2FA no acumula fallos ni bloquea', async () => {
    const u = await nuevoUsuario();
    await conOrg(bd.owner, u.orgId, (c) => c.query('UPDATE usuarios SET totp_activo = true WHERE id = $1', [u.usuarioId]));
    for (let i = 0; i < 12; i++) expect((await post('/auth/login', { email: u.email, password: PW })).json().estado).toBe('requiere_2fa');
    const f = await conOrg(bd.owner, u.orgId, (c) => c.query('SELECT intentos_fallidos, bloqueado_hasta FROM usuarios WHERE id = $1', [u.usuarioId]));
    expect(f.rows[0].intentos_fallidos).toBe(0);
    expect(f.rows[0].bloqueado_hasta).toBeNull();
  }, 60_000);

  it('un usuario desactivado no entra aunque la contraseña sea correcta', async () => {
    const u = await nuevoUsuario();
    await conOrg(bd.owner, u.orgId, (c) => c.query('UPDATE usuarios SET activo = false WHERE id = $1', [u.usuarioId]));
    expect((await post('/auth/login', { email: u.email, password: PW })).statusCode).toBe(401);
  });

  it('cerrar sesión invalida la cookie en el servidor, no solo en el navegador', async () => {
    const u = await nuevoUsuario();
    const ck = cookieDe(await entrar(u.email));
    expect((await post('/auth/logout', {}, ck)).statusCode).toBe(200);
    expect((await get('/auth/yo', ck)).statusCode).toBe(401);
  });

  it('una cookie inventada o mal formada no sirve', async () => {
    expect((await get('/auth/yo', 'archie_sid=' + 'x'.repeat(43))).statusCode).toBe(401);
    expect((await get('/auth/yo', 'archie_sid=raro;valor')).statusCode).toBe(401);
    expect((await get('/auth/yo')).statusCode).toBe(401);
  });

  it('una sesión vencida deja de servir', async () => {
    const u = await nuevoUsuario();
    const ck = cookieDe(await entrar(u.email));
    await conOrg(bd.owner, u.orgId, (c) => c.query("UPDATE sesiones SET expira_en = now() - interval '1 minute'"));
    expect((await get('/auth/yo', ck)).statusCode).toBe(401);
  });

  it('rechaza entradas con campos de más o de tipo equivocado', async () => {
    expect((await post('/auth/login', { email: 'a@b.co', password: PW, rol: 'admin' })).statusCode).toBe(400);
    expect((await post('/auth/login', { email: { $ne: '' }, password: PW })).statusCode).toBe(400);
    expect((await post('/auth/login', { email: 'a@b.co', password: 'x'.repeat(5000) })).statusCode).toBe(400);
  });

  it('rechaza peticiones que vienen de otro sitio web (origen distinto)', async () => {
    const u = await nuevoUsuario();
    const r = await post('/auth/login', { email: u.email, password: PW }, undefined, { origin: 'https://sitio-malo.test' });
    expect(r.statusCode).toBe(403);
    expect((await post('/auth/login', { email: u.email, password: PW }, undefined, { origin: ORIGEN })).statusCode).toBe(200);
  });

  it('toma la IP real del último proxy de confianza y no la que el cliente inventa', async () => {
    const u = await nuevoUsuario();
    await post('/auth/login', { email: u.email, password: PW }, undefined, { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' });
    const a = await auditoria(u.orgId);
    const ev = a.find((x) => x.accion === 'login_ok')!;
    expect(ev.detalle.ip).toBe('1.2.3.4');
  });

  it('limita la frecuencia por IP y por correo', async () => {
    const limitada = crearApp(config, { pool: bd.app, llaves, rutas: { limites: { porIp: 3, porCorreo: 100, ventanaMs: 60_000 } } });
    const intento = () => limitada.inject({ method: 'POST', url: '/auth/login', payload: { email: 'z@ejemplo.test', password: PW } });
    expect([(await intento()).statusCode, (await intento()).statusCode, (await intento()).statusCode]).toEqual([401, 401, 401]);
    const r = await intento();
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    await limitada.close();
    const porCorreo = crearApp(config, { pool: bd.app, llaves, rutas: { limites: { porIp: 100, porCorreo: 2, ventanaMs: 60_000 } } });
    const i2 = () => porCorreo.inject({ method: 'POST', url: '/auth/login', payload: { email: 'q@ejemplo.test', password: PW } });
    await i2(); await i2();
    expect((await i2()).statusCode).toBe(429);
    await porCorreo.close();
  });

  it('la auditoría registra los eventos sin guardar contraseñas ni correos', async () => {
    const u = await nuevoUsuario();
    await post('/auth/login', { email: u.email, password: 'mala-mala-mala-mala' });
    const ck = cookieDe(await entrar(u.email));
    await post('/auth/logout', {}, ck);
    const a = await auditoria(u.orgId);
    expect(a.map((x) => x.accion)).toEqual(['organizacion_creada', 'login_fallido', 'login_ok', 'logout']);
    const texto = JSON.stringify(a);
    expect(texto).not.toContain(u.email);
    expect(texto).not.toContain(PW);
    expect(texto).not.toContain('mala-mala');
  });

  describe('segundo factor (2FA)', () => {
    /** Entra, activa el 2FA y devuelve el secreto. */
    async function conDosFactores() {
      const u = await nuevoUsuario();
      const ck = cookieDe(await entrar(u.email));
      const ini = await post('/auth/2fa/iniciar', { password: PW }, ck);
      expect(ini.statusCode).toBe(200);
      const { secreto, uri } = ini.json() as { secreto: string; uri: string };
      expect(uri).toContain(encodeURIComponent(u.email));
      const conf = await post('/auth/2fa/confirmar', { codigo: codigoActual(secreto) }, ck);
      expect(conf.statusCode).toBe(200);
      await post('/auth/logout', {}, ck);
      return { ...u, secreto };
    }

    it('activar el 2FA exige la contraseña y un código correcto; el secreto queda cifrado en la base', async () => {
      const u = await nuevoUsuario();
      const ck = cookieDe(await entrar(u.email));
      expect((await post('/auth/2fa/iniciar', { password: 'incorrecta-incorrecta' }, ck)).statusCode).toBe(401);
      const { secreto } = (await post('/auth/2fa/iniciar', { password: PW }, ck)).json() as { secreto: string };
      expect((await post('/auth/2fa/confirmar', { codigo: '000000' === codigoActual(secreto) ? '111111' : '000000' }, ck)).statusCode).toBe(400);
      const antes = await conOrg(bd.owner, u.orgId, (c) => c.query('SELECT totp_activo, totp_secreto FROM usuarios WHERE id = $1', [u.usuarioId]));
      expect(antes.rows[0].totp_activo).toBe(false); // sin confirmar no está activo
      expect((antes.rows[0].totp_secreto as Buffer).toString('latin1')).not.toContain(secreto);
      expect((await post('/auth/2fa/confirmar', { codigo: codigoActual(secreto) }, ck)).statusCode).toBe(200);
      expect((await get('/auth/yo', ck)).json()).toMatchObject({ totpActivo: true });
      // No se puede volver a iniciar el enrolamiento (taparía el secreto activo).
      expect((await post('/auth/2fa/iniciar', { password: PW }, ck)).statusCode).toBe(409);
    });

    it('con 2FA activo, la contraseña sola solo da una sesión pendiente que no abre nada', async () => {
      const u = await conDosFactores();
      const r = await post('/auth/login', { email: u.email, password: PW });
      expect(r.json()).toEqual({ estado: 'requiere_2fa' });
      const pendiente = cookieDe(r);
      expect((await get('/auth/yo', pendiente)).statusCode).toBe(401);
      expect((await post('/auth/password', { actual: PW, nueva: 'otra-clave-larga-2222' }, pendiente)).statusCode).toBe(401);
      expect((await post('/auth/2fa/iniciar', { password: PW }, pendiente)).statusCode).toBe(401);
    });

    it('con el código correcto entra y la sesión pendiente se reemplaza por una nueva', async () => {
      const u = await conDosFactores();
      const pendiente = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 90_000); // un código nuevo, distinto al usado al activar
      const r = await post('/auth/2fa', { codigo: codigoActual(u.secreto) }, pendiente);
      expect(r.statusCode).toBe(200);
      const completa = cookieDe(r);
      expect(completa).not.toBe(pendiente);
      expect((await get('/auth/yo', pendiente)).statusCode).toBe(401); // el token pendiente murió
      const cuenta = await conOrg(bd.owner, u.orgId, (c) => c.query('SELECT count(*)::int AS n FROM sesiones WHERE usuario_id = $1', [u.usuarioId]));
      expect(cuenta.rows[0].n).toBe(1); // la pendiente se borró: solo queda la completa
      expect((await get('/auth/yo', completa)).statusCode).toBe(200);
    });

    it('un código ya usado no sirve otra vez, ni dentro de su ventana de 30 segundos', async () => {
      const u = await conDosFactores();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 90_000);
      const codigo = codigoActual(u.secreto);
      const p1 = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
      expect((await post('/auth/2fa', { codigo }, p1)).statusCode).toBe(200);
      const p2 = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
      const reuso = await post('/auth/2fa', { codigo }, p2);
      expect(reuso.statusCode).toBe(401);
      expect(reuso.json()).toMatchObject({ error: 'codigo_invalido' });
    });

    it('el código vigente en el momento de activar tampoco se puede reutilizar para entrar', async () => {
      const u = await conDosFactores();
      const p = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
      expect((await post('/auth/2fa', { codigo: codigoActual(u.secreto) }, p)).statusCode).toBe(401);
    });

    it('adivinar códigos bloquea la cuenta (6 dígitos no se pueden probar sin límite)', async () => {
      const u = await conDosFactores();
      const p = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
      const buenoAhora = codigoActual(u.secreto);
      const malo = buenoAhora === '123456' ? '654321' : '123456';
      for (let i = 0; i < 5; i++) expect((await post('/auth/2fa', { codigo: malo }, p)).statusCode).toBe(401);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 90_000);
      expect((await post('/auth/2fa', { codigo: codigoActual(u.secreto) }, p)).statusCode).toBe(401); // ya está bloqueada
      expect((await auditoria(u.orgId)).map((a) => a.accion)).toContain('mfa_fallido');
    });

    it('una sesión pendiente vence a los pocos minutos', async () => {
      const u = await conDosFactores();
      const p = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
      await conOrg(bd.owner, u.orgId, (c) => c.query("UPDATE sesiones SET expira_en = now() - interval '1 second'"));
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 90_000);
      expect((await post('/auth/2fa', { codigo: codigoActual(u.secreto) }, p)).statusCode).toBe(401);
    });

    it('el operador puede resetear el 2FA de quien perdió el teléfono: entra con la contraseña y todo lo anterior muere', async () => {
      const u = await conDosFactores();
      const pendiente = cookieDe(await post('/auth/login', { email: u.email, password: PW }));
      expect(await resetear2fa(bd.owner, u.email.toUpperCase())).toBe(true);
      expect(await resetear2fa(bd.owner, 'nadie@ejemplo.test')).toBe(false);
      expect((await post('/auth/2fa', { codigo: codigoActual(u.secreto) }, pendiente)).statusCode).toBe(401);
      const r = await post('/auth/login', { email: u.email, password: PW });
      expect(r.json()).toMatchObject({ estado: 'ok', usuario: { totpActivo: false } });
      expect((await auditoria(u.orgId)).map((x) => x.accion)).toContain('2fa_reseteado_por_operador');
    });

    it('una sesión ya completa no se puede usar en /auth/2fa', async () => {
      const u = await nuevoUsuario();
      const ck = cookieDe(await entrar(u.email));
      expect((await post('/auth/2fa', { codigo: '123456' }, ck)).statusCode).toBe(401);
    });
  });

  describe('cambio de contraseña', () => {
    it('exige la actual, aplica el largo mínimo, cierra las demás sesiones y la vieja deja de servir', async () => {
      const u = await nuevoUsuario();
      const otra = cookieDe(await entrar(u.email));
      const ck = cookieDe(await entrar(u.email));
      expect((await post('/auth/password', { actual: 'equivocada-equivocada', nueva: 'nueva-clave-larga-33' }, ck)).statusCode).toBe(401);
      expect((await post('/auth/password', { actual: PW, nueva: 'corta' }, ck)).statusCode).toBe(400);
      expect((await post('/auth/password', { actual: PW, nueva: 'nueva-clave-larga-33' }, ck)).statusCode).toBe(200);
      expect((await get('/auth/yo', ck)).statusCode).toBe(200);    // la sesión que la cambió sigue
      expect((await get('/auth/yo', otra)).statusCode).toBe(401);  // las demás se cerraron
      expect((await post('/auth/login', { email: u.email, password: PW })).statusCode).toBe(401);
      expect((await post('/auth/login', { email: u.email, password: 'nueva-clave-larga-33' })).statusCode).toBe(200);
    });

    it('los fallos al reconfirmar la contraseña sí cuentan para el bloqueo (no se pierden por el error)', async () => {
      const u = await nuevoUsuario();
      const ck = cookieDe(await entrar(u.email));
      for (let i = 0; i < 3; i++) await post('/auth/password', { actual: 'equivocada-equivocada', nueva: 'nueva-clave-larga-33' }, ck);
      const f = await conOrg(bd.owner, u.orgId, (c) => c.query('SELECT intentos_fallidos FROM usuarios WHERE id = $1', [u.usuarioId]));
      expect(f.rows[0].intentos_fallidos).toBe(3);
      expect((await auditoria(u.orgId)).filter((a) => a.accion === 'password_reconfirmacion_fallida')).toHaveLength(3);
    });
  });

  it('una organización no puede usar la sesión de otra para ver datos ajenos', async () => {
    const a = await nuevoUsuario();
    const b = await nuevoUsuario();
    const ckA = cookieDe(await entrar(a.email));
    const yo = (await get('/auth/yo', ckA)).json() as { email: string; organizacion: string };
    expect(yo.email).toBe(a.email);
    expect(yo.email).not.toBe(b.email);
  });
});

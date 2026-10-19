import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { codigoActual } from '../src/auth/totp.js';
import { cargarConfig } from '../src/config.js';
import { cargarLlaves, hashPassword } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';

describe('2FA obligatorio para administradores (configuración)', () => {
  it('en producción no se puede dejar opcional; por defecto es obligatorio', () => {
    expect(cargarConfig({ NODE_ENV: 'test' }).ARCHIE_2FA_ADMIN).toBe('obligatorio');
    const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ARCHIE_ORIGEN: 'https://a.test', ARCHIE_CORREO: 'resend', RESEND_API_KEY: 'x'.repeat(12), ARCHIE_CORREO_REMITENTE: 'a@b.co', ARCHIE_IA: 'archie', ARCHIE_IA_CLAVE: 'clave-ia-1234567890', ARCHIE_IA_MODELO: 'modelo-x' };
    expect(cargarConfig(prod).ARCHIE_2FA_ADMIN).toBe('obligatorio');
    expect(() => cargarConfig({ ...prod, ARCHIE_2FA_ADMIN: 'opcional' })).toThrow(/ARCHIE_2FA_ADMIN/);
  });
});

describe.skipIf(!hay)('2FA obligatorio para administradores (servidor)', () => {
  let bd: BdPrueba;
  let app: FastifyInstance;
  let n = 0;

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_ORIGEN: 'https://archie.ejemplo.test' }), { pool: bd.app, llaves, rutas: { limites: { porIp: 1000, porCorreo: 1000, ventanaMs: 60_000 } } });
  }, 60_000);
  afterAll(async () => { await app?.close(); await bd?.cerrar(); });

  const llamar = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie, origin: 'https://archie.ejemplo.test' } });
  async function entrar(email: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW }, headers: { origin: 'https://archie.ejemplo.test' } });
    expect(r.statusCode).toBe(200);
    return String(r.headers['set-cookie']).split(';')[0]!;
  }

  it('un administrador sin 2FA entra, pero solo puede activarlo; con 2FA activo todo se abre', async () => {
    const email = `a${++n}@ejemplo.test`;
    await crearOrganizacionConAdmin(bd.owner, { nombre: `Org ${n}`, email, password: PW });
    const ck = await entrar(email);
    expect((await llamar('GET', '/auth/yo', ck)).statusCode).toBe(200);
    for (const [m, u] of [['GET', '/api/panel/resumen'], ['GET', '/api/panel/consumo'], ['GET', '/api/panel/equipo']] as const) {
      const r = await llamar(m, u, ck);
      expect(r.statusCode, u).toBe(403);
      expect(r.json()).toEqual({ error: '2fa_obligatoria' });
    }
    expect((await llamar('POST', '/api/panel/equipo/invitaciones', ck, { email: 'x@cliente.test', rol: 'miembro' })).statusCode).toBe(403);
    const { secreto } = (await llamar('POST', '/auth/2fa/iniciar', ck, { password: PW })).json() as { secreto: string };
    expect((await llamar('POST', '/auth/2fa/confirmar', ck, { codigo: codigoActual(secreto) })).statusCode).toBe(200);
    expect((await llamar('GET', '/api/panel/resumen', ck)).statusCode).toBe(200);
  });

  it('un miembro (no administrador) sin 2FA sigue entrando con normalidad', async () => {
    const email = `a${++n}@ejemplo.test`;
    const o = await crearOrganizacionConAdmin(bd.owner, { nombre: `Org ${n}`, email, password: PW });
    const emailM = `m${n}@ejemplo.test`;
    await conOrg(bd.owner, o.orgId, async (c) => c.query("INSERT INTO usuarios (org_id, email, password_hash, rol) VALUES ($1,$2,$3,'miembro')", [o.orgId, emailM, await hashPassword(PW)]));
    const ck = await entrar(emailM);
    expect((await llamar('GET', '/api/panel/resumen', ck)).statusCode).toBe(200);
  });

  it('un miembro promovido a administrador debe activar el 2FA en su siguiente petición', async () => {
    const email = `a${++n}@ejemplo.test`;
    const o = await crearOrganizacionConAdmin(bd.owner, { nombre: `Org ${n}`, email, password: PW });
    const emailM = `m${n}@ejemplo.test`;
    await conOrg(bd.owner, o.orgId, async (c) => c.query("INSERT INTO usuarios (org_id, email, password_hash, rol) VALUES ($1,$2,$3,'miembro')", [o.orgId, emailM, await hashPassword(PW)]));
    const ck = await entrar(emailM);
    expect((await llamar('GET', '/api/panel/resumen', ck)).statusCode).toBe(200);
    await conOrg(bd.owner, o.orgId, (c) => c.query("UPDATE usuarios SET rol = 'admin' WHERE email = $1", [emailM]));
    expect((await llamar('GET', '/api/panel/resumen', ck)).statusCode).toBe(403);
  });
});

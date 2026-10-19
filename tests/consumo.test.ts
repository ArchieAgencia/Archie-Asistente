import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { cargarConfig } from '../src/config.js';
import { cargarLlaves } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import { ServicioConsumo } from '../src/panel/consumo.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${randomBytes(32).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });
const PW = 'una-clave-muy-larga-1';

describe.skipIf(!hay)('planes, libro de consultas y consumo', () => {
  let bd: BdPrueba;
  let app: FastifyInstance;
  let svc: ServicioConsumo;
  let n = 0;

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    svc = new ServicioConsumo(bd.app);
    app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_ORIGEN: 'https://archie.ejemplo.test' }), {
      pool: bd.app, llaves, rutas: { limites: { porIp: 1000, porCorreo: 1000, ventanaMs: 60_000 } },
    });
  }, 60_000);
  afterAll(async () => { await app?.close(); await bd?.cerrar(); });

  async function nuevaOrg(plan?: string) {
    const email = `c${++n}@ejemplo.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Org ${n}`, email, password: PW, nombreAdmin: `Persona ${n}`, plan });
    return { email, ...r };
  }
  const duenoOrg = <T>(orgId: string, fn: Parameters<typeof conOrg<T>>[2]) => conOrg(bd.owner, orgId, fn);
  async function sesion(email: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PW } });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }

  it('una organización nueva recibe las consultas de su plan, una sola vez', async () => {
    const o = await nuevaOrg();
    const e = await svc.estado(o.orgId);
    expect(e.saldo).toBe(100);
    expect(e.plan).toMatchObject({ id: 'prueba', cuotaMensual: 100 });
    expect(e).toMatchObject({ estado: 'prueba', modo: 'autoservicio', autonomia: 'borradores', sinSaldo: false });
    // la referencia del plan inicial no se puede repetir
    await expect(duenoOrg(o.orgId, (c) => c.query(
      `INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia) SELECT org_id, tipo, cantidad, referencia FROM consultas_libro WHERE org_id = $1 LIMIT 1`, [o.orgId]))).rejects.toThrow();
  });

  it('consume, descuenta el saldo y reporta el uso del día y del mes', async () => {
    const o = await nuevaOrg();
    expect(await svc.consumir(o.orgId, o.usuarioId, 3, 'a1', 'Pregunta')).toEqual({ resultado: 'ok', saldo: 97 });
    const e = await svc.estado(o.orgId);
    expect(e).toMatchObject({ saldo: 97, consumidoHoy: 3, consumidoMes: 3 });
    const m = await svc.movimientos(o.orgId);
    expect(m[0]).toMatchObject({ tipo: 'consumo', cantidad: -3, detalle: 'Pregunta' });
  });

  it('la misma referencia no se cobra dos veces', async () => {
    const o = await nuevaOrg();
    await svc.consumir(o.orgId, o.usuarioId, 5, 'r1');
    expect(await svc.consumir(o.orgId, o.usuarioId, 5, 'r1')).toEqual({ resultado: 'repetido', saldo: 95 });
    expect((await svc.estado(o.orgId)).saldo).toBe(95);
  });

  it('rechaza cuando no alcanza el saldo y no registra nada', async () => {
    const o = await nuevaOrg();
    await duenoOrg(o.orgId, (c) => c.query('UPDATE organizaciones SET tope_diario_propio = 1000 WHERE id = $1', [o.orgId]));
    for (let i = 0; i < 10; i++) await svc.consumir(o.orgId, o.usuarioId, 10, `x${i}`);
    expect(await svc.consumir(o.orgId, o.usuarioId, 1, 'x-extra')).toEqual({ resultado: 'sin_saldo', saldo: 0 });
    const e = await svc.estado(o.orgId);
    expect(e).toMatchObject({ saldo: 0, sinSaldo: true });
  });

  it('respeta el tope diario del plan y el propio de la organización', async () => {
    const o = await nuevaOrg();                     // plan prueba: tope diario 50
    expect((await svc.consumir(o.orgId, o.usuarioId, 50, 't1')).resultado).toBe('ok');
    expect((await svc.consumir(o.orgId, o.usuarioId, 1, 't2')).resultado).toBe('tope_diario');
    await duenoOrg(o.orgId, (c) => c.query('UPDATE organizaciones SET tope_diario_propio = 60 WHERE id = $1', [o.orgId]));
    expect((await svc.consumir(o.orgId, o.usuarioId, 10, 't3')).resultado).toBe('ok');
    expect((await svc.consumir(o.orgId, o.usuarioId, 1, 't4')).resultado).toBe('tope_diario');
  });

  it('no cobra a una organización suspendida', async () => {
    const o = await nuevaOrg();
    await duenoOrg(o.orgId, (c) => c.query("UPDATE organizaciones SET estado = 'suspendido', activa = false WHERE id = $1", [o.orgId]));
    expect((await svc.consumir(o.orgId, o.usuarioId, 1, 's1')).resultado).toBe('suspendido');
  });

  it('con consumos simultáneos nunca se gasta más de lo que hay', async () => {
    const o = await nuevaOrg();
    await duenoOrg(o.orgId, (c) => c.query('UPDATE organizaciones SET tope_diario_propio = 1000 WHERE id = $1', [o.orgId]));
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => svc.consumir(o.orgId, o.usuarioId, 10, `p${i}`)));
    expect(rs.filter((r) => r.resultado === 'ok')).toHaveLength(10);   // 100 consultas / 10
    expect(rs.filter((r) => r.resultado === 'sin_saldo')).toHaveLength(20);
    expect((await svc.estado(o.orgId)).saldo).toBe(0);
  });

  it('valida los parámetros del consumo', async () => {
    const o = await nuevaOrg();
    await expect(svc.consumir(o.orgId, o.usuarioId, 0, 'z')).rejects.toThrow();
    await expect(svc.consumir(o.orgId, o.usuarioId, 101, 'z')).rejects.toThrow();
    await expect(svc.consumir(o.orgId, o.usuarioId, 1.5 as number, 'z')).rejects.toThrow();
  });

  it('la aplicación no puede sumarse saldo ni alterar el libro', async () => {
    const o = await nuevaOrg();
    for (const tipo of ['recarga', 'plan', 'ajuste']) {
      await expect(conOrg(bd.app, o.orgId, (c) => c.query(
        "INSERT INTO consultas_libro (org_id, tipo, cantidad) VALUES ($1,$2,1000)", [o.orgId, tipo]))).rejects.toThrow();
    }
    await svc.consumir(o.orgId, o.usuarioId, 1, 'l1');
    await expect(conOrg(bd.app, o.orgId, (c) => c.query('UPDATE consultas_libro SET cantidad = -1 WHERE org_id = $1', [o.orgId]))).rejects.toThrow();
    await expect(conOrg(bd.app, o.orgId, (c) => c.query('DELETE FROM consultas_libro WHERE org_id = $1', [o.orgId]))).rejects.toThrow();
    await expect(conOrg(bd.app, o.orgId, (c) => c.query("UPDATE organizaciones SET plan_id = 'profesional' WHERE id = $1", [o.orgId]))).rejects.toThrow();
    expect((await svc.estado(o.orgId)).saldo).toBe(99);
  });

  it('una organización no ve ni toca el libro de otra', async () => {
    const a = await nuevaOrg(); const b = await nuevaOrg();
    await svc.consumir(a.orgId, a.usuarioId, 7, 'aa');
    const vistoPorB = await conOrg(bd.app, b.orgId, (c) => c.query('SELECT * FROM consultas_libro WHERE org_id = $1', [a.orgId]));
    expect(vistoPorB.rowCount).toBe(0);
    await expect(conOrg(bd.app, b.orgId, (c) => c.query(
      "INSERT INTO consultas_libro (org_id, tipo, cantidad) VALUES ($1,'consumo',-1)", [a.orgId]))).rejects.toThrow();
    expect((await svc.estado(b.orgId)).saldo).toBe(100);
    expect((await svc.estado(a.orgId)).saldo).toBe(93);
  });

  it('la serie diaria devuelve 30 días con ceros y el uso de hoy', async () => {
    const o = await nuevaOrg();
    await svc.consumir(o.orgId, o.usuarioId, 4, 'd1');
    const s = await svc.serieDiaria(o.orgId, 30);
    expect(s).toHaveLength(30);
    expect(s.at(-1)!.consultas).toBe(4);
    expect(s.slice(0, 29).every((p) => p.consultas === 0)).toBe(true);
  });

  describe('API del panel', () => {
    it('exige sesión', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/panel/resumen' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/panel/consumo' })).statusCode).toBe(401);
    });

    it('entrega el resumen y el consumo solo de la organización de la sesión', async () => {
      const a = await nuevaOrg(); const b = await nuevaOrg();
      await svc.consumir(a.orgId, a.usuarioId, 12, 'api1');
      const r = await app.inject({ method: 'GET', url: '/api/panel/resumen', headers: { cookie: await sesion(a.email) } });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const j = r.json();
      expect(j.organizacion).toBe(`Org ${n - 1}`);
      expect(j.usuario).toMatchObject({ nombre: `Persona ${n - 1}`, rol: 'admin' });
      expect(j.consumo).toMatchObject({ saldo: 88, consumidoMes: 12 });
      expect(j.pasos.find((p: { id: string }) => p.id === 'primera_pregunta').hecho).toBe(true);
      const c = await app.inject({ method: 'GET', url: '/api/panel/consumo', headers: { cookie: await sesion(b.email) } });
      expect(c.json().estado.saldo).toBe(100);
      expect(c.json().movimientos.every((m: { tipo: string }) => m.tipo === 'plan')).toBe(true);
      expect(c.json().serie).toHaveLength(30);
    });

    it('no entrega nada con una sesión pendiente de segundo factor', async () => {
      const o = await nuevaOrg();
      await duenoOrg(o.orgId, (c) => c.query("UPDATE usuarios SET totp_activo = true, totp_secreto = '\\x00', totp_clave_version = 1 WHERE org_id = $1", [o.orgId]));
      const l = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: o.email, password: PW } });
      expect(l.json().estado).toBe('requiere_2fa');
      const r = await app.inject({ method: 'GET', url: '/api/panel/resumen', headers: { cookie: String(l.headers['set-cookie']).split(';')[0]! } });
      expect(r.statusCode).toBe(401);
    });
  });
});

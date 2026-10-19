import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CorreoMemoria } from '../src/correo/correo.js';
import { Notificador } from '../src/correo/notificador.js';
import { conOrg } from '../src/db/pool.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import { AlertasConsumo, umbralAlcanzado } from '../src/panel/alertas.js';
import { ServicioConsumo } from '../src/panel/consumo.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const PW = 'una-clave-muy-larga-1';

describe('umbral de consumo', () => {
  it('80 % y 100 % de la cuota del mes, o saldo agotado; sin cuota no hay alerta', () => {
    expect(umbralAlcanzado(79, 100, 21)).toBeNull();
    expect(umbralAlcanzado(80, 100, 20)).toBe(80);
    expect(umbralAlcanzado(99, 100, 1)).toBe(80);
    expect(umbralAlcanzado(100, 100, 5)).toBe(100);
    expect(umbralAlcanzado(10, 100, 0)).toBe(100);
    expect(umbralAlcanzado(50, 0, 50)).toBeNull();
  });
});

describe.skipIf(!hay)('alertas de consumo por correo', () => {
  let bd: BdPrueba; let n = 0;
  const correo = new CorreoMemoria();
  beforeAll(async () => { bd = await prepararBdPrueba(); }, 60_000);
  afterAll(async () => { await bd?.cerrar(); });

  const alertas = (c: CorreoMemoria = correo) => new AlertasConsumo(bd.app, new Notificador(c, 'https://archie.ejemplo.test', false));
  async function org() {
    const email = `adm${++n}@cliente.test`;
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `Org ${n}`, email, password: PW, nombreAdmin: `Admin ${n}` });
    return { ...r, email };
  }
  const consumir = (orgId: string, k: number) => conOrg(bd.owner, orgId, (c) =>
    c.query("INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia) VALUES ($1,'consumo',$2,$3)", [orgId, -k, `t-${randomBytes(6).toString('hex')}`]));
  const para = (email: string) => correo.enviados.filter((m) => m.para === email);

  it('no avisa por debajo del 80 %; avisa una vez al 80 % y una vez al 100 %, sin repetirse', async () => {
    const o = await org(); const a = alertas();
    await consumir(o.orgId, 79); await a.revisar(o.orgId);
    expect(para(o.email)).toHaveLength(0);
    await consumir(o.orgId, 1); await a.revisar(o.orgId); await a.revisar(o.orgId);
    expect(para(o.email)).toHaveLength(1);
    expect(para(o.email)[0]!.asunto).toMatch(/80/);
    await consumir(o.orgId, 20); await a.revisar(o.orgId); await a.revisar(o.orgId);
    expect(para(o.email)).toHaveLength(2);
    expect(para(o.email)[1]!.asunto).toMatch(/acabaron/i);
    const e = await new ServicioConsumo(bd.app).estado(o.orgId);
    expect(e.alerta).toBe(100);
  });

  it('en una cuenta de prueba el correo no promete renovación', async () => {
    const o = await org(); await consumir(o.orgId, 90); await alertas().revisar(o.orgId);
    const m = para(o.email)[0]!;
    expect(m.texto).toContain('no se renuevan');
    expect(m.texto).not.toMatch(/se renuevan el/);
  });

  it('en una cuenta activa el correo indica la fecha de renovación', async () => {
    const o = await org();
    await conOrg(bd.owner, o.orgId, (c) => c.query("UPDATE organizaciones SET estado = 'activo', activa = true WHERE id = $1", [o.orgId]));
    await consumir(o.orgId, 90); await alertas().revisar(o.orgId);
    expect(para(o.email)[0]!.texto).toMatch(/Se renuevan el/);
  });

  it('si cruza los dos umbrales de una vez, envía solo el correo del 100 %', async () => {
    const o = await org(); await consumir(o.orgId, 100); await alertas().revisar(o.orgId);
    expect(para(o.email)).toHaveLength(1);
    expect(para(o.email)[0]!.asunto).toMatch(/acabaron/i);
  });

  it('con varias revisiones a la vez se envía un solo correo por umbral', async () => {
    const o = await org(); await consumir(o.orgId, 85);
    await Promise.all(Array.from({ length: 8 }, () => alertas().revisar(o.orgId)));
    expect(para(o.email)).toHaveLength(1);
  });

  it('solo avisa a administradores activos de esa cuenta', async () => {
    const o = await org(); const otra = await org();
    await conOrg(bd.owner, o.orgId, (c) => c.query(
      "INSERT INTO usuarios (org_id, email, password_hash, rol, nombre) VALUES ($1,'miembro@cliente.test','x','miembro','M'), ($1,'inactivo@cliente.test','x','admin','I')", [o.orgId]));
    await conOrg(bd.owner, o.orgId, (c) => c.query("UPDATE usuarios SET activo = false WHERE email = 'inactivo@cliente.test'"));
    await consumir(o.orgId, 90); await alertas().revisar(o.orgId);
    expect(para(o.email)).toHaveLength(1);
    expect(para('miembro@cliente.test')).toHaveLength(0);
    expect(para('inactivo@cliente.test')).toHaveLength(0);
    expect(para(otra.email)).toHaveLength(0);
  });

  it('un fallo del correo no rompe nada y la app no puede alterar el registro de otra cuenta', async () => {
    const o = await org(); const otra = await org(); const mal = new CorreoMemoria(); mal.falla = true;
    await consumir(o.orgId, 90);
    await expect(alertas(mal).revisar(o.orgId)).resolves.toBeUndefined();
    await expect(conOrg(bd.app, o.orgId, (c) => c.query("INSERT INTO alertas_consumo (org_id, mes, umbral) VALUES ($1,'2026-10',80)", [otra.orgId]))).rejects.toThrow();
    await expect(conOrg(bd.app, o.orgId, (c) => c.query('DELETE FROM alertas_consumo'))).rejects.toThrow(/permission denied/);
  });
});

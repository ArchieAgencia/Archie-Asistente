import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conOrg } from '../src/db/pool.js';
import { renovarMes } from '../src/db/renovacion.js';
import { crearOrganizacionConAdmin } from '../src/db/semilla.js';
import { ServicioConsumo } from '../src/panel/consumo.js';
import { ADMIN_URL, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const PW = 'una-clave-muy-larga-1';

describe.skipIf(!hay)('renovación mensual de consultas', () => {
  let bd: BdPrueba;
  let svc: ServicioConsumo;
  let n = 0;
  beforeAll(async () => { bd = await prepararBdPrueba(); svc = new ServicioConsumo(bd.app); }, 60_000);
  afterAll(async () => { await bd?.cerrar(); });

  async function org(plan: string, estado: string) {
    const r = await crearOrganizacionConAdmin(bd.owner, { nombre: `R${++n}`, email: `r${n}@c.test`, password: PW, plan });
    await conOrg(bd.owner, r.orgId, (c) => c.query("UPDATE organizaciones SET estado = $2, activa = ($2 IN ('prueba','activo')) WHERE id = $1", [r.orgId, estado]));
    return r;
  }

  it('este mes no hace nada: el plan inicial ya se cargó con la misma referencia', async () => {
    const r = await org('basico', 'activo');
    const antes = (await svc.estado(r.orgId)).saldo;
    await renovarMes(bd.owner);
    expect((await svc.estado(r.orgId)).saldo).toBe(antes);
  });

  it('en un mes nuevo deja el saldo en la cuota: repone lo gastado, no acumula lo que sobra y no se repite', async () => {
    const gastada = await org('basico', 'activo');   // cuota 300
    const intacta = await org('basico', 'activo');
    await svc.consumir(gastada.orgId, gastada.usuarioId, 60, 'g1');
    expect((await svc.estado(gastada.orgId)).saldo).toBe(240);
    // sobrante: se agrega saldo extra por el dueño (como lo haría una recarga) y debe vencer
    await conOrg(bd.owner, intacta.orgId, (c) => c.query("INSERT INTO consultas_libro (org_id, tipo, cantidad, detalle) VALUES ($1,'recarga',150,'extra')", [intacta.orgId]));
    expect((await svc.estado(intacta.orgId)).saldo).toBe(450);

    const r1 = await renovarMes(bd.owner, '2099-01');
    expect(r1.renovadas).toBeGreaterThanOrEqual(2);
    expect((await svc.estado(gastada.orgId)).saldo).toBe(300);
    expect((await svc.estado(intacta.orgId)).saldo).toBe(300);
    const mov = await svc.movimientos(intacta.orgId);
    expect(mov[0]).toMatchObject({ tipo: 'ajuste', cantidad: -150 });

    const r2 = await renovarMes(bd.owner, '2099-01');  // se repite el mismo mes: nada cambia
    expect(r2.renovadas).toBe(0);
    expect((await svc.estado(gastada.orgId)).saldo).toBe(300);
    expect((await svc.estado(intacta.orgId)).saldo).toBe(300);
  });

  it('no renueva cuentas en prueba, suspendidas ni dadas de baja', async () => {
    const prueba = await org('prueba', 'prueba');
    const susp = await org('basico', 'suspendido');
    const baja = await org('basico', 'baja');
    for (const o of [prueba, susp, baja]) await svc.consumir(o.orgId, o.usuarioId, 1, `u${o.orgId}`).catch(() => undefined);
    const antes = await Promise.all([prueba, susp, baja].map(async (o) => (await svc.estado(o.orgId)).saldo));
    await renovarMes(bd.owner, '2099-02');
    const despues = await Promise.all([prueba, susp, baja].map(async (o) => (await svc.estado(o.orgId)).saldo));
    expect(despues).toEqual(antes);
  });

  it('rechaza un mes mal escrito y registra la renovación en la bitácora del cliente', async () => {
    await expect(renovarMes(bd.owner, '2099-13')).rejects.toThrow(/Mes inválido/);
    const r = await org('profesional', 'activo');
    await svc.consumir(r.orgId, r.usuarioId, 5, 'b1');
    await renovarMes(bd.owner, '2099-03');
    const f = await conOrg(bd.app, r.orgId, (c) => c.query("SELECT operador_nombre, accion FROM acciones_operador WHERE org_id = $1", [r.orgId]));
    expect(f.rows).toEqual([{ operador_nombre: 'Archie AI', accion: 'renovacion_mensual' }]);
  });
});

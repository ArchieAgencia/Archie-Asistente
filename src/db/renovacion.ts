import type pg from 'pg';
import { conOrg } from './pool.js';

export interface ResultadoRenovacion { renovadas: number; yaRenovadas: number; omitidas: number }

/**
 * Renovación mensual (se ejecuta el día 1, con el rol dueño, desde una tarea programada: no es una ruta de la API).
 * Deja el saldo de cada cuenta ACTIVA en la cuota de su plan, sin acumular: lo que sobró vence. Es idempotente por mes y plan
 * (la referencia `plan:AAAA-MM:<plan>` no se puede repetir), así que ejecutarla dos veces el mismo mes no suma dos veces.
 * Las cuentas en prueba, suspendidas o dadas de baja no se renuevan.
 */
export async function renovarMes(owner: pg.Pool, mes?: string): Promise<ResultadoRenovacion> {
  if (mes !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error('Mes inválido (AAAA-MM)'); // el parámetro existe para pruebas y reparaciones
  const lista = await owner.query<{ id: string }>("SELECT id FROM organizaciones WHERE estado = 'activo'"); // el rol dueño ve la lista (política de lectura previa a la sesión)
  const r: ResultadoRenovacion = { renovadas: 0, yaRenovadas: 0, omitidas: 0 };
  for (const { id } of lista.rows) {
    const resultado = await conOrg(owner, id, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 727))', [id]); // mismo candado que el consumo
      const f = (await c.query(
        `SELECT p.id AS plan, p.cuota_mensual AS cuota, o.estado,
                'plan:' || coalesce($2, to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM')) || ':' || p.id AS ref,
                (SELECT coalesce(sum(cantidad), 0) FROM consultas_libro WHERE org_id = o.id)::bigint AS saldo
         FROM organizaciones o JOIN planes p ON p.id = o.plan_id WHERE o.id = $1`, [id, mes ?? null])).rows[0];
      if (!f || f.estado !== 'activo' || f.cuota <= 0) return 'omitida' as const;
      const ya = await c.query('SELECT 1 FROM consultas_libro WHERE org_id = $1 AND referencia = $2', [id, f.ref]);
      if (ya.rowCount) return 'ya' as const;
      const delta = f.cuota - Number(f.saldo);
      if (delta === 0) return 'omitida' as const; // el saldo ya es igual a la cuota: nada que mover
      await c.query(
        `INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia, detalle) VALUES ($1,$2,$3,$4,$5)`,
        [id, delta > 0 ? 'plan' : 'ajuste', delta, f.ref, delta > 0 ? 'Renovación mensual del plan' : 'Renovación mensual: vencen las consultas sobrantes']);
      await c.query(
        `INSERT INTO acciones_operador (org_id, operador_nombre, accion, detalle) VALUES ($1,'Archie AI','renovacion_mensual',$2)`,
        [id, `Renovó las consultas del mes: el saldo queda en ${f.cuota}`]);
      return 'renovada' as const;
    });
    if (resultado === 'renovada') r.renovadas++; else if (resultado === 'ya') r.yaRenovadas++; else r.omitidas++;
  }
  return r;
}

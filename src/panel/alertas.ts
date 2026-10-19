import type pg from 'pg';
import type { Notificador } from '../correo/notificador.js';
import { conOrg } from '../db/pool.js';

/** Umbrales de consumo mensual que avisan a los administradores. */
export const UMBRALES = [80, 100] as const;

/** Umbral alcanzado según lo consumido en el mes (null si ninguno). Cuota 0 = sin cuota mensual: no hay alerta. */
export const umbralAlcanzado = (consumidoMes: number, cuota: number, saldo: number): 80 | 100 | null => {
  if (cuota <= 0) return null;
  if (saldo <= 0 || consumidoMes >= cuota) return 100;
  return consumidoMes / cuota >= 0.8 ? 80 : null;
};

/**
 * Avisa por correo a los administradores cuando una cuenta cruza el 80 % o el 100 % de su cuota del mes: una sola vez por umbral y mes
 * (la tabla alertas_consumo lo garantiza aunque lleguen varias respuestas a la vez). Es de "mejor esfuerzo": nunca debe romper un mensaje del chat.
 */
export class AlertasConsumo {
  constructor(private readonly pool: pg.Pool, private readonly notificador: Notificador, private readonly log: { error: (o: object, m: string) => void } = { error: () => undefined }) {}

  async revisar(orgId: string): Promise<void> {
    try {
      const nuevos = await conOrg(this.pool, orgId, async (c) => {
        const d = (await c.query(
          `SELECT o.nombre AS org, o.estado AS estado, p.cuota_mensual AS cuota,
                  to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM') AS mes,
                  (date_trunc('month', now() AT TIME ZONE 'America/Bogota') + interval '1 month') AT TIME ZONE 'America/Bogota' AS renueva,
                  coalesce((SELECT -sum(cantidad) FROM consultas_libro WHERE org_id = o.id AND tipo = 'consumo'
                     AND creado_en >= date_trunc('month', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'), 0)::int AS consumido,
                  coalesce((SELECT sum(cantidad) FROM consultas_libro WHERE org_id = o.id), 0)::int AS saldo
           FROM organizaciones o JOIN planes p ON p.id = o.plan_id WHERE o.id = $1`, [orgId])).rows[0];
        if (!d) return null;
        const u = umbralAlcanzado(d.consumido, d.cuota, d.saldo);
        if (!u) return null;
        const aEnviar: number[] = [];
        for (const umbral of UMBRALES.filter((x) => x <= u)) {
          const r = await c.query('INSERT INTO alertas_consumo (org_id, mes, umbral) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING umbral', [orgId, d.mes, umbral]);
          if (r.rowCount) aEnviar.push(umbral);
        }
        if (!aEnviar.length) return null;
        // Si cruzó los dos a la vez, solo se envía el más alto.
        const admins = (await c.query("SELECT email FROM usuarios WHERE org_id = $1 AND rol = 'admin' AND activo", [orgId])).rows.map((r) => r.email as string);
        return { umbral: Math.max(...aEnviar) as 80 | 100, org: d.org as string, cuota: d.cuota as number, consumido: d.consumido as number, renueva: d.estado === 'activo' ? (d.renueva as Date) : null, mes: d.mes as string, admins };
      });
      if (!nuevos) return;
      for (const para of nuevos.admins) {
        await this.notificador.alertaConsumo({ para, organizacion: nuevos.org, umbral: nuevos.umbral, consumidas: nuevos.consumido, cuota: nuevos.cuota, renueva: nuevos.renueva, clave: `${orgId}-${nuevos.mes}-${nuevos.umbral}-${para}` });
      }
    } catch (e) {
      this.log.error({ err: e }, 'no se pudo revisar la alerta de consumo');
    }
  }
}

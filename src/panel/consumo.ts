import type pg from 'pg';
import { conOrg } from '../db/pool.js';
import { umbralAlcanzado } from './alertas.js';

export type ResultadoConsumo = 'ok' | 'repetido' | 'sin_saldo' | 'tope_diario' | 'suspendido';

export interface EstadoConsumo {
  plan: { id: string; nombre: string; cuotaMensual: number; topeDiario: number };
  estado: 'prueba' | 'activo' | 'suspendido' | 'baja';
  modo: 'autoservicio' | 'gestionada';
  autonomia: 'lectura' | 'borradores' | 'confirmacion';
  saldo: number;
  sinSaldo: boolean;
  consumidoMes: number;
  consumidoHoy: number;
  topeDiario: number;
  alerta: 80 | 100 | null; // umbral de consumo del mes alcanzado (para el aviso en pantalla)
  renueva: string; // fecha (YYYY-MM-DD) del primer día del próximo mes en Bogotá
}

export interface Movimiento { id: number; tipo: string; cantidad: number; detalle: string | null; usuarioId: string | null; creadoEn: string }
export interface PuntoDia { dia: string; consultas: number }

const BOGOTA = "'America/Bogota'";

/** Consumo de consultas de una organización. Todas las lecturas pasan por la seguridad por filas. */
export class ServicioConsumo {
  constructor(private readonly pool: pg.Pool) {}

  /** Gasta `n` consultas de forma atómica. La organización la decide el servidor (sesión), nunca el cliente. */
  async consumir(orgId: string, usuarioId: string, n: number, referencia: string | null, detalle?: string): Promise<{ resultado: ResultadoConsumo; saldo: number }> {
    return conOrg(this.pool, orgId, async (c) => {
      const r = await c.query<{ resultado: ResultadoConsumo; saldo_restante: string }>(
        'SELECT * FROM consumir_consultas($1,$2,$3,$4)', [usuarioId, n, referencia, detalle ?? null]);
      return { resultado: r.rows[0]!.resultado, saldo: Number(r.rows[0]!.saldo_restante) };
    });
  }

  async estado(orgId: string): Promise<EstadoConsumo> {
    return conOrg(this.pool, orgId, async (c) => {
      const o = await c.query(
        `SELECT o.estado, o.modo, o.autonomia, p.id AS plan_id, p.nombre AS plan_nombre, p.cuota_mensual,
                coalesce(o.tope_diario_propio, p.tope_diario) AS tope,
                (date_trunc('month', now() AT TIME ZONE ${BOGOTA}) + interval '1 month')::date::text AS renueva
         FROM organizaciones o JOIN planes p ON p.id = o.plan_id WHERE o.id = $1`, [orgId]);
      const f = o.rows[0];
      if (!f) throw new Error('Organización no encontrada');
      const s = await c.query(
        `SELECT coalesce(sum(cantidad), 0) AS saldo,
           coalesce(-sum(cantidad) FILTER (WHERE tipo = 'consumo' AND creado_en >= date_trunc('month', now() AT TIME ZONE ${BOGOTA}) AT TIME ZONE ${BOGOTA}), 0) AS mes,
           coalesce(-sum(cantidad) FILTER (WHERE tipo = 'consumo' AND creado_en >= date_trunc('day', now() AT TIME ZONE ${BOGOTA}) AT TIME ZONE ${BOGOTA}), 0) AS hoy
         FROM consultas_libro WHERE org_id = $1`, [orgId]);
      const t = s.rows[0];
      const saldo = Number(t.saldo);
      return {
        plan: { id: f.plan_id, nombre: f.plan_nombre, cuotaMensual: f.cuota_mensual, topeDiario: Number(f.tope) },
        estado: f.estado, modo: f.modo, autonomia: f.autonomia,
        saldo, sinSaldo: saldo <= 0, consumidoMes: Number(t.mes), consumidoHoy: Number(t.hoy),
        topeDiario: Number(f.tope), renueva: f.renueva, alerta: umbralAlcanzado(Number(t.mes), f.cuota_mensual, saldo),
      };
    });
  }

  async movimientos(orgId: string, limite = 20): Promise<Movimiento[]> {
    const l = Math.min(Math.max(Math.trunc(limite), 1), 100);
    return conOrg(this.pool, orgId, async (c) => {
      const r = await c.query(
        'SELECT id, tipo, cantidad, detalle, usuario_id, creado_en FROM consultas_libro WHERE org_id = $1 ORDER BY id DESC LIMIT $2', [orgId, l]);
      return r.rows.map((x) => ({ id: Number(x.id), tipo: x.tipo, cantidad: x.cantidad, detalle: x.detalle, usuarioId: x.usuario_id, creadoEn: new Date(x.creado_en).toISOString() }));
    });
  }

  /** Consultas gastadas por día (día de Bogotá) en los últimos `dias` días, con ceros donde no hubo uso. */
  async serieDiaria(orgId: string, dias = 30): Promise<PuntoDia[]> {
    const d = Math.min(Math.max(Math.trunc(dias), 1), 90);
    return conOrg(this.pool, orgId, async (c) => {
      const r = await c.query(
        `SELECT g.dia::text AS dia, coalesce(-sum(l.cantidad), 0) AS consultas
         FROM generate_series((now() AT TIME ZONE ${BOGOTA})::date - ($2::int - 1), (now() AT TIME ZONE ${BOGOTA})::date, interval '1 day') AS g(dia)
         LEFT JOIN consultas_libro l ON l.org_id = $1 AND l.tipo = 'consumo' AND (l.creado_en AT TIME ZONE ${BOGOTA})::date = g.dia::date
         GROUP BY g.dia ORDER BY g.dia`, [orgId, d]);
      return r.rows.map((x) => ({ dia: x.dia.slice(0, 10), consultas: Number(x.consultas) }));
    });
  }
}

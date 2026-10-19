import type pg from 'pg';
import { ErrorAuth, type SesionActiva } from '../auth/servicio.js';
import { conOrg } from '../db/pool.js';

/** Contexto del negocio («Instrucciones»). Lo escribe un administrador; lo leen todos; entra al asistente como información, nunca como permisos. */

export const MAX_CONTEXTO = 2000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Limpia el texto: sin caracteres de control ni de dirección, sin marcadores que imiten el cierre del bloque, saltos de línea acotados. */
export function limpiarContexto(t: string): string {
  return t.replace(/\r\n?/g, '\n').replace(CONTROL, ' ').replace(/<<<|>>>/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CONTEXTO);
}

export class ServicioContexto {
  constructor(private readonly pool: pg.Pool) {}

  async ver(orgId: string): Promise<{ texto: string; actualizadoEn: Date | null; max: number }> {
    const f = (await conOrg(this.pool, orgId, (c) => c.query('SELECT texto, actualizado_en FROM instrucciones_org WHERE org_id = $1', [orgId]))).rows[0];
    return { texto: (f?.texto as string | undefined) ?? '', actualizadoEn: (f?.actualizado_en as Date | undefined) ?? null, max: MAX_CONTEXTO };
  }

  async guardar(s: SesionActiva, texto: string, ctx: { ip?: string } = {}): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las instrucciones');
    const limpio = limpiarContexto(texto);
    await conOrg(this.pool, s.orgId, async (c) => {
      await c.query(
        `INSERT INTO instrucciones_org (org_id, texto, actualizado_por) VALUES ($1,$2,$3)
         ON CONFLICT (org_id) DO UPDATE SET texto = EXCLUDED.texto, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()`, [s.orgId, limpio, s.usuarioId]);
      // La auditoría guarda solo el tamaño: el texto es de la cuenta y no hace falta copiarlo.
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'instrucciones_actualizadas', JSON.stringify({ caracteres: limpio.length, ip: ctx.ip })]);
    });
  }
}

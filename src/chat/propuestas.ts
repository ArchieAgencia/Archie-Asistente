import type pg from 'pg';
import { ErrorAuth, type SesionActiva } from '../auth/servicio.js';
import { ejecutarAccion, huella, instantanea, motivoNoValida, type AccionCampana, type PropuestaCreada } from '../conectores/send-confirmaciones.js';
import { ErrorConector, MENSAJES_CONECTOR } from '../conectores/send.js';
import { conOrg } from '../db/pool.js';
import type { ServicioConexiones } from './conexiones.js';

/** Tarjetas de confirmación (nivel 3). Nada se ejecuta sin que un administrador apruebe; se ejecuta exactamente lo que se mostró, una sola vez. */

export const MAX_PENDIENTES_CONVERSACION = 3;
export const MAX_PROPUESTAS_ORG_HORA = 10;

const ESTADO_VISIBLE = `CASE WHEN estado = 'pendiente' AND expira_en < now() THEN 'expirada' ELSE estado END`;
const COLUMNAS = `id, accion, objeto_nombre AS "nombre", texto, ${ESTADO_VISIBLE} AS estado, codigo, creada_en AS "creadaEn", expira_en AS "expiraEn", resuelta_en AS "resueltaEn", conversacion_id AS "conversacionId"`;

export interface PropuestaVista {
  id: string; accion: AccionCampana; nombre: string; texto: string; estado: 'pendiente' | 'ejecutando' | 'ejecutada' | 'fallida' | 'rechazada' | 'expirada';
  codigo: string | null; creadaEn: Date; expiraEn: Date; resueltaEn: Date | null; conversacionId: string | null;
}

export class ServicioPropuestas {
  constructor(private readonly pool: pg.Pool, private readonly conexiones: ServicioConexiones, private readonly log: { error: (o: object, m: string) => void } = { error: () => undefined }) {}

  /** Antes de consultar a Archie Send: topes de tarjetas pendientes y por hora. Lanza 'tope_propuestas'. */
  async verificarTopes(s: SesionActiva, convId: string): Promise<void> {
    const n = (await conOrg(this.pool, s.orgId, (c) => c.query(
      `SELECT (SELECT count(*) FROM propuestas WHERE conversacion_id = $1 AND estado = 'pendiente' AND expira_en > now())::int AS pend,
              (SELECT count(*) FROM propuestas WHERE creada_en > now() - interval '1 hour')::int AS hora`, [convId]))).rows[0] as { pend: number; hora: number };
    if (n.pend >= MAX_PENDIENTES_CONVERSACION || n.hora >= MAX_PROPUESTAS_ORG_HORA) throw new Error('tope_propuestas');
  }

  /** Guarda la tarjeta. Devuelve su id (o undefined si no se pudo guardar: entonces nada queda pendiente). */
  async registrar(s: SesionActiva, convId: string, herramienta: string, p: PropuestaCreada, toolUseId: string): Promise<string | undefined> {
    return conOrg(this.pool, s.orgId, async (c) => {
      const r = await c.query(
        `INSERT INTO propuestas (org_id, usuario_id, conversacion_id, herramienta, accion, objeto_id, objeto_nombre, texto, huella, tool_use_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (org_id, tool_use_id) DO NOTHING RETURNING id`,
        [s.orgId, s.usuarioId, convId, herramienta.slice(0, 60), p.accion, p.campanaId, p.nombre.slice(0, 200), p.texto.slice(0, 4000), p.huella, toolUseId.slice(0, 100)]);
      if (r.rows[0]) await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'propuesta_creada', JSON.stringify({ accion: p.accion, campana: p.campanaId })]);
      return r.rows[0]?.id as string | undefined;
    }).catch((e) => { this.log.error({ err: e }, 'no se pudo guardar la propuesta'); return undefined; });
  }

  /** Los administradores ven todas las de la organización; cada miembro, las suyas. */
  listar(s: SesionActiva): Promise<(PropuestaVista & { esMia: boolean; puedeAprobar: boolean })[]> {
    return conOrg(this.pool, s.orgId, async (c) => (await c.query(
      `SELECT ${COLUMNAS}, (usuario_id = $1) AS "esMia" FROM propuestas WHERE ($2 OR usuario_id = $1) ORDER BY creada_en DESC LIMIT 50`,
      [s.usuarioId, s.rol === 'admin'])).rows.map((r) => ({ ...r, puedeAprobar: s.rol === 'admin' && r.estado === 'pendiente' })));
  }

  /** Propuestas de UNA conversación propia (para pintar las tarjetas en el chat). */
  porConversacion(s: SesionActiva, convId: string) {
    return conOrg(this.pool, s.orgId, async (c) => (await c.query(
      `SELECT ${COLUMNAS} FROM propuestas WHERE conversacion_id = $1 AND usuario_id = $2 ORDER BY creada_en`, [convId, s.usuarioId])).rows as PropuestaVista[]);
  }

  async ver(s: SesionActiva, id: string): Promise<PropuestaVista & { puedeAprobar: boolean }> {
    const p = (await conOrg(this.pool, s.orgId, (c) => c.query(`SELECT ${COLUMNAS}, usuario_id FROM propuestas WHERE id = $1`, [id]))).rows[0];
    if (!p || (p.usuario_id !== s.usuarioId && s.rol !== 'admin')) throw new ErrorAuth(404, 'no_encontrado', 'Tarjeta no encontrada');
    const { usuario_id: _u, ...resto } = p;
    return { ...(resto as PropuestaVista), puedeAprobar: s.rol === 'admin' && p.estado === 'pendiente' };
  }

  async rechazar(s: SesionActiva, id: string, ctx: { ip?: string } = {}): Promise<void> {
    await conOrg(this.pool, s.orgId, async (c) => {
      const p = (await c.query('SELECT usuario_id, estado, expira_en FROM propuestas WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p || (p.usuario_id !== s.usuarioId && s.rol !== 'admin')) throw new ErrorAuth(404, 'no_encontrado', 'Tarjeta no encontrada');
      if (p.estado !== 'pendiente') throw new ErrorAuth(409, 'ya_resuelta', 'Esta tarjeta ya se resolvió');
      await c.query("UPDATE propuestas SET estado = 'rechazada', resuelta_en = now(), resuelta_por = $2 WHERE id = $1", [id, s.usuarioId]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)', [s.orgId, s.usuarioId, 'propuesta_rechazada', JSON.stringify({ ip: ctx.ip })]);
    });
  }

  /**
   * Aprobar y ejecutar. Solo administradores (sesión con segundo factor). Pasos:
   *  1) reclamar la tarjeta de forma atómica (pendiente → ejecutando): dos clics o dos personas a la vez = una sola ejecución;
   *  2) volver a leer la campaña y comprobar que sigue igual a lo que se mostró; si cambió, NO se ejecuta;
   *  3) ejecutar y dejar constancia. Nunca se reintenta solo.
   */
  async aprobar(s: SesionActiva, id: string, ctx: { ip?: string } = {}): Promise<{ estado: 'ejecutada' }> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede aprobar esta acción');
    const cliente = await this.conexiones.cliente(s.orgId).catch((e) => { throw traducir(e); });
    const p = await conOrg(this.pool, s.orgId, async (c) => {
      const f = (await c.query('SELECT accion, objeto_id, huella, estado, expira_en > now() AS vigente FROM propuestas WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!f) throw new ErrorAuth(404, 'no_encontrado', 'Tarjeta no encontrada');
      if (f.estado !== 'pendiente') throw new ErrorAuth(409, 'ya_resuelta', 'Esta tarjeta ya se resolvió');
      const aut = (await c.query('SELECT autonomia FROM organizaciones WHERE id = $1', [s.orgId])).rows[0]?.autonomia;
      if (aut !== 'confirmacion') throw new ErrorAuth(409, 'autonomia_cambiada', 'La autonomía de tu cuenta cambió y ya no permite acciones con confirmación. No se hizo nada.');
      if (!f.vigente) throw new ErrorAuth(409, 'expirada', 'La tarjeta venció (dura 15 minutos). Pídele a Archie AI que la prepare de nuevo.');
      await c.query("UPDATE propuestas SET estado = 'ejecutando', resuelta_en = now(), resuelta_por = $2 WHERE id = $1", [id, s.usuarioId]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'propuesta_aprobada', JSON.stringify({ accion: f.accion, campana: f.objeto_id, ip: ctx.ip })]);
      return f as { accion: AccionCampana; objeto_id: number; huella: string };
    });

    const cerrar = (estado: 'ejecutada' | 'fallida', codigo: string | null) => conOrg(this.pool, s.orgId, async (c) => {
      await c.query('UPDATE propuestas SET estado = $2, codigo = $3 WHERE id = $1', [id, estado, codigo]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, estado === 'ejecutada' ? 'propuesta_ejecutada' : 'propuesta_fallida', JSON.stringify({ accion: p.accion, campana: p.objeto_id, codigo })]);
    });

    try {
      const ahora = await instantanea(cliente, p.objeto_id);
      if (huella(ahora, p.accion) !== p.huella) { await cerrar('fallida', 'cambio_la_campana'); throw new ErrorAuth(409, 'cambio_la_campana', 'La campaña cambió en Archie Send después de mostrar la tarjeta. No se hizo nada; pídele a Archie AI una tarjeta nueva.'); }
      const motivo = motivoNoValida(p.accion, ahora);
      if (motivo) { await cerrar('fallida', 'ya_no_aplica'); throw new ErrorAuth(409, 'ya_no_aplica', `No se hizo nada. ${motivo}`); }
      await ejecutarAccion(cliente, p.accion, p.objeto_id);
    } catch (e) {
      if (e instanceof ErrorAuth) throw e;
      const cod = e instanceof ErrorConector ? `send_${e.codigo}` : 'error_interno';
      await cerrar('fallida', cod).catch(() => undefined);
      if (!(e instanceof ErrorConector)) this.log.error({ err: e }, 'error al ejecutar una propuesta');
      if (e instanceof ErrorConector && e.codigo === 'tiempo_agotado') throw new ErrorAuth(502, cod, 'Archie Send tardó demasiado: no sabemos si se ejecutó. Revisa la campaña en Archie Send antes de volver a pedirlo.');
      throw e instanceof ErrorConector ? new ErrorAuth(502, cod, e.detalle ? `${e.message} Archie Send dice: ${e.detalle}` : e.message) : new ErrorAuth(500, 'error_interno', 'No se pudo completar la acción. Revisa la campaña en Archie Send.');
    }
    await cerrar('ejecutada', null);
    return { estado: 'ejecutada' };
  }
}

function traducir(e: unknown): unknown {
  if (e instanceof ErrorConector) return e.codigo === 'no_conectado' ? new ErrorAuth(409, 'sin_conexion', MENSAJES_CONECTOR.no_conectado) : new ErrorAuth(502, `send_${e.codigo}`, e.message);
  return e;
}

import type pg from 'pg';
import { ErrorAuth, type SesionActiva } from '../auth/servicio.js';
import { limpiarTexto } from '../conectores/send-herramientas.js';
import { ErrorConector, MENSAJES_CONECTOR } from '../conectores/send.js';
import { conOrg } from '../db/pool.js';
import type { ServicioConexiones } from './conexiones.js';

/**
 * Acciones de Archie AI y su reversa. Deshacer es SIEMPRE un clic de una persona (nunca una herramienta del modelo)
 * y solo borra lo que Archie AI creó, si sigue sin haber cambiado de forma que se pierda trabajo:
 *  - lista: solo si sigue vacía y con el mismo nombre;
 *  - campaña: solo si sigue en borrador y con el mismo nombre;
 *  - segmento: solo si sigue con el mismo nombre.
 */

const RUTAS = { lista: 'lists', segmento: 'segments', campana: 'campaigns' } as const;
type Tipo = keyof typeof RUTAS;

const objeto = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const mismoNombre = (a: unknown, esperado: string) => typeof a === 'string' && limpiarTexto(a, 200) === limpiarTexto(esperado, 200);

export class ServicioAcciones {
  constructor(private readonly pool: pg.Pool, private readonly conexiones: ServicioConexiones) {}

  /** Los administradores ven todas las de la organización; cada miembro, las suyas. */
  listar(s: SesionActiva) {
    return conOrg(this.pool, s.orgId, async (c) => (await c.query(
      `SELECT a.id, a.objeto_tipo AS "objeto", a.objeto_nombre AS "nombre", a.estado, a.creada_en AS "creadaEn", a.deshecha_en AS "deshechaEn",
              a.conversacion_id AS "conversacionId", coalesce(u.nombre, u.email) AS "persona", (a.usuario_id = $1) AS "esMia"
       FROM acciones a JOIN usuarios u ON u.id = a.usuario_id AND u.org_id = a.org_id
       WHERE ($2 OR a.usuario_id = $1) ORDER BY a.creada_en DESC LIMIT 100`, [s.usuarioId, s.rol === 'admin'])).rows);
  }

  async deshacer(s: SesionActiva, id: string, ctx: { ip?: string } = {}): Promise<{ estado: 'deshecha' | 'ya_no_existia' }> {
    const cliente = await this.conexiones.cliente(s.orgId).catch((e) => { throw traducir(e); });
    return conOrg(this.pool, s.orgId, async (c) => {
      const a = (await c.query('SELECT usuario_id, objeto_tipo, objeto_id, objeto_nombre, estado FROM acciones WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!a || (a.usuario_id !== s.usuarioId && s.rol !== 'admin')) throw new ErrorAuth(404, 'no_encontrado', 'Acción no encontrada');
      if (a.estado === 'deshecha') throw new ErrorAuth(409, 'ya_deshecha', 'Esta acción ya se deshizo');
      const tipo = a.objeto_tipo as Tipo;
      const objetoId = a.objeto_id as number;
      const nombre = a.objeto_nombre as string;
      let existia = true;
      try {
        // 1) Comprobar que sigue siendo lo que creamos y que no se perdería trabajo.
        if (tipo === 'lista') {
          const l = objeto(await cliente.get(`/api/lists/${objetoId}`));
          if (!mismoNombre(l.name, nombre)) throw new ErrorAuth(409, 'no_se_puede_deshacer', 'La lista cambió de nombre en Archie Send; bórrala allí si quieres.');
          if (Number(l.subscriber_count) !== 0) throw new ErrorAuth(409, 'no_se_puede_deshacer', 'La lista ya tiene contactos; no se borra desde aquí para no perderlos.');
        } else if (tipo === 'campana') {
          const k = objeto(await cliente.get(`/api/campaigns/${objetoId}`));
          if (k.status !== 'draft') throw new ErrorAuth(409, 'no_se_puede_deshacer', 'La campaña ya no está en borrador; no se borra desde aquí.');
          if (!mismoNombre(k.name, nombre)) throw new ErrorAuth(409, 'no_se_puede_deshacer', 'La campaña cambió de nombre en Archie Send; bórrala allí si quieres.');
        } else {
          const r = await cliente.get('/api/segments');
          const filas = Array.isArray(r) ? r : Array.isArray(objeto(r).results) ? (objeto(r).results as unknown[]) : [];
          const sg = filas.map(objeto).find((x) => x.id === objetoId);
          if (!sg) throw new ErrorConector('no_encontrado');
          if (!mismoNombre(sg.name, nombre)) throw new ErrorAuth(409, 'no_se_puede_deshacer', 'El segmento cambió de nombre en Archie Send; bórralo allí si quieres.');
        }
        // 2) Borrar.
        await cliente.borrar(`/api/${RUTAS[tipo]}/${objetoId}`);
      } catch (e) {
        if (e instanceof ErrorConector && e.codigo === 'no_encontrado') existia = false; // ya lo borraron en Archie Send
        else throw traducir(e);
      }
      await c.query('UPDATE acciones SET estado = $2, deshecha_en = now(), deshecha_por = $3 WHERE id = $1', [id, 'deshecha', s.usuarioId]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'accion_deshecha', JSON.stringify({ objeto: tipo, id: objetoId, ya_no_existia: !existia, ip: ctx.ip })]);
      return { estado: existia ? 'deshecha' : 'ya_no_existia' } as const;
    });
  }
}

function traducir(e: unknown): unknown {
  if (e instanceof ErrorAuth) return e;
  if (e instanceof ErrorConector) {
    if (e.codigo === 'no_conectado') return new ErrorAuth(409, 'sin_conexion', MENSAJES_CONECTOR.no_conectado);
    return new ErrorAuth(502, `send_${e.codigo}`, e.message);
  }
  return e;
}

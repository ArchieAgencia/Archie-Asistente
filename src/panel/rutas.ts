import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { conOrg } from '../db/pool.js';
import type pg from 'pg';
import type { ServicioConsumo } from './consumo.js';

type Guardia = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface DepsPanel { pool: pg.Pool; consumo: ServicioConsumo; exigirSesion: (completa: boolean) => Guardia }

/** Rutas del panel del cliente. Siempre exigen sesión completa (con segundo factor) y trabajan solo con la organización de la sesión. */
export function registrarRutasPanel(app: FastifyInstance, d: DepsPanel): void {
  const guardia = d.exigirSesion(true);

  app.get('/api/panel/resumen', { preHandler: guardia }, async (req) => {
    const s = req.sesion!;
    const [consumo, datos] = await Promise.all([
      d.consumo.estado(s.orgId),
      conOrg(d.pool, s.orgId, async (c) => {
        const r = await c.query(
          `SELECT
             (SELECT nombre FROM organizaciones WHERE id = $1) AS organizacion,
             (SELECT CASE WHEN asistencia_hasta > now() THEN asistencia_hasta END FROM organizaciones WHERE id = $1) AS asistencia_hasta,
             (SELECT jsonb_build_object('nombre', nombre, 'email', email, 'rol', rol, 'totpActivo', totp_activo) FROM usuarios WHERE id = $2) AS usuario,
             (SELECT count(*) FROM credenciales_conector WHERE org_id = $1) AS conexiones,
             (SELECT count(*) FROM usuarios WHERE org_id = $1 AND activo) AS equipo,
             (SELECT count(*) FROM consultas_libro WHERE org_id = $1 AND tipo = 'consumo') AS preguntas,
             (SELECT count(*) FROM instrucciones_org WHERE org_id = $1 AND length(texto) > 0) AS instrucciones,
             (SELECT count(*) FROM acciones WHERE org_id = $1) + (SELECT count(*) FROM propuestas WHERE org_id = $1 AND estado = 'ejecutada') AS acciones`, [s.orgId, s.usuarioId]);
        return r.rows[0];
      }),
    ]);
    const pasos = [
      { id: 'dos_pasos', hecho: Boolean(datos.usuario.totpActivo) },
      { id: 'conexion', hecho: Number(datos.conexiones) > 0 },
      { id: 'primera_pregunta', hecho: Number(datos.preguntas) > 0 },
      { id: 'instrucciones', hecho: Number(datos.instrucciones) > 0 },
      { id: 'equipo', hecho: Number(datos.equipo) > 1 },
      { id: 'primera_accion', hecho: Number(datos.acciones) > 0 },
    ];
    return {
      organizacion: datos.organizacion as string,
      asistenciaHasta: (datos.asistencia_hasta ?? null) as Date | null, // modo asistencia vigente (el panel muestra un aviso permanente)
      usuario: datos.usuario,
      consumo,
      conexiones: Number(datos.conexiones),
      accionesPendientes: 0,
      pasos,
    };
  });

  app.get('/api/panel/consumo', { preHandler: guardia }, async (req) => {
    const s = req.sesion!;
    const [estado, movimientos, serie] = await Promise.all([
      d.consumo.estado(s.orgId), d.consumo.movimientos(s.orgId, 20), d.consumo.serieDiaria(s.orgId, 30),
    ]);
    return { estado, movimientos, serie };
  });

  // Lo que el equipo de Archie Tech hizo en la cuenta, con el nombre de quien lo hizo. El cliente siempre puede verlo.
  app.get('/api/panel/bitacora-equipo', { preHandler: guardia }, async (req) => {
    const s = req.sesion!;
    return conOrg(d.pool, s.orgId, async (c) => {
      const r = await c.query(
        `SELECT creado_en AS cuando, operador_nombre AS quien, accion, detalle FROM acciones_operador
         WHERE org_id = $1 ORDER BY creado_en DESC, id DESC LIMIT 100`, [s.orgId]);
      return r.rows;
    });
  });

  // El cliente puede terminar el modo asistencia cuando quiera. Solo administradores de la cuenta.
  app.post('/api/panel/asistencia/terminar', { preHandler: guardia }, async (req, reply) => {
    const s = req.sesion!;
    if (s.rol !== 'admin') return reply.code(403).send({ error: 'no_autorizado' });
    await conOrg(d.pool, s.orgId, (c) => c.query('SELECT panel_terminar_asistencia()'));
    return { estado: 'ok' };
  });
}

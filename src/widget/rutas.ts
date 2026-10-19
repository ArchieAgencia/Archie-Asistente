import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServicioChat } from '../chat/servicio.js';
import type { ServicioConexiones } from '../chat/conexiones.js';
import type { ServicioTiendas } from '../chat/tiendas.js';
import type { ServicioPauta } from '../chat/pauta.js';
import type { ServicioSuite } from '../chat/suite.js';
import { esquemaCanje, esquemaClaveNueva, esquemaClaveQuitar, esquemaOrigen, esquemaPedirSesion, type ServicioWidget } from './servicio.js';

type Guardia = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const params = z.object({ id: z.string().uuid() });

export interface DepsWidget {
  widget: ServicioWidget;
  chat: ServicioChat;
  conexiones: ServicioConexiones;
  tiendas?: ServicioTiendas;
  pauta?: ServicioPauta;
  suite?: ServicioSuite;
  /** Guardia del panel (sesión completa con 2FA): para que los administradores gestionen orígenes y claves. */
  guardiaPanel: Guardia;
  /** Manejador del chat con streaming, el mismo del panel (mismos límites, mismo cobro). */
  manejarChat: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const bearer = (req: FastifyRequest): string | undefined => {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? '');
  return m?.[1];
};

export function registrarRutasWidget(app: FastifyInstance, d: DepsWidget): void {
  /** Sesión del widget: solo sirve en estas rutas. Una sesión del panel (cookie) nunca sirve aquí ni al revés. */
  const guardiaWidget: Guardia = async (req, reply) => {
    const t = bearer(req);
    const s = t ? await d.widget.resolver(t) : null;
    if (!s) return reply.code(401).send({ error: 'no_autenticado' });
    req.sesion = s;
  };

  // --- Administración (panel) ---
  app.get('/api/panel/widget', { preHandler: d.guardiaPanel }, async (req) => ({ ...(await d.widget.listar(req.sesion!.orgId)), base: `/widget/${req.sesion!.orgId}` }));
  app.post('/api/panel/widget/origenes', { preHandler: d.guardiaPanel }, async (req) => ({ origen: await d.widget.agregarOrigen(req.sesion!, esquemaOrigen.parse(req.body).origen, { ip: req.ip }) }));
  app.post('/api/panel/widget/origenes/quitar', { preHandler: d.guardiaPanel }, async (req) => { await d.widget.quitarOrigen(req.sesion!, esquemaOrigen.parse(req.body).origen, { ip: req.ip }); return { estado: 'ok' }; });
  app.post('/api/panel/widget/claves', { preHandler: d.guardiaPanel }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return d.widget.crearClave(req.sesion!, esquemaClaveNueva.parse(req.body).nombre, { ip: req.ip });
  });
  app.post('/api/panel/widget/claves/quitar', { preHandler: d.guardiaPanel }, async (req) => { await d.widget.revocarClave(req.sesion!, esquemaClaveQuitar.parse(req.body).id, { ip: req.ip }); return { estado: 'ok' }; });

  // --- De servidor a servidor: la herramienta anfitriona pide el enlace ---
  app.post('/api/widget/sesion', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const clave = bearer(req);
    const b = esquemaPedirSesion.parse(req.body);
    return d.widget.pedirSesion(clave ?? '', b.email, { ip: req.ip });
  });

  // --- Desde el iframe ---
  app.post('/api/widget/canjear', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return d.widget.canjear(esquemaCanje.parse(req.body).canje, { ip: req.ip });
  });
  app.post('/api/widget/salir', { preHandler: guardiaWidget }, async (req) => { const t = bearer(req); if (t) await d.widget.cerrar(t); return { estado: 'ok' }; });
  app.get('/api/widget/estado', { preHandler: guardiaWidget }, async (req) => {
    const o = req.sesion!.orgId;
    const [send, tiendas, pauta, suite] = await Promise.all([d.conexiones.estado(o), d.tiendas?.listar(o) ?? [], d.pauta?.listar(o) ?? [], d.suite?.listar(o) ?? []]);
    return { conectado: Boolean((send as { conectado?: boolean }).conectado) || tiendas.length > 0 || pauta.length > 0 || suite.length > 0 };
  });
  app.get('/api/widget/conversaciones', { preHandler: guardiaWidget }, async (req) => d.chat.listar(req.sesion!));
  app.get('/api/widget/conversaciones/:id', { preHandler: guardiaWidget }, async (req) => d.chat.ver(req.sesion!, params.parse(req.params).id));
  app.post('/api/widget/conversaciones/:id/borrar', { preHandler: guardiaWidget }, async (req) => { await d.chat.borrar(req.sesion!, params.parse(req.params).id); return { estado: 'ok' }; });
  app.post('/api/widget/chat', { preHandler: guardiaWidget }, d.manejarChat);
}

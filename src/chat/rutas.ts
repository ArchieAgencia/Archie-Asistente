import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Limitador } from '../auth/limitador.js';
import type { ServicioAcciones } from './acciones.js';
import type { ServicioPropuestas } from './propuestas.js';
import { MAX_CONTEXTO, type ServicioContexto } from './contexto-negocio.js';
import type { ServicioConexiones } from './conexiones.js';
import { esquemaConexionTienda, type ServicioTiendas } from './tiendas.js';
import { esquemaConexionPauta, type ServicioPauta } from './pauta.js';
import { esquemaConexionSuite, type ServicioSuite } from './suite.js';
import { MAX_TEXTO, type EventoChat, type ServicioChat } from './servicio.js';

type Guardia = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const uuid = z.string().uuid();
const params = z.object({ id: uuid });
const cuerpoChat = z.object({ conversacionId: uuid.optional(), texto: z.string().min(1).max(MAX_TEXTO) }).strict();
const cuerpoContexto = z.object({ texto: z.string().max(MAX_CONTEXTO * 2) }).strict();
const cuerpoConexion = z.object({ usuario: z.string().trim().min(1).max(100), token: z.string().min(1).max(200) }).strict();

export interface DepsChat {
  chat: ServicioChat;
  conexiones: ServicioConexiones;
  tiendas?: ServicioTiendas;
  pauta?: ServicioPauta;
  suite?: ServicioSuite;
  acciones: ServicioAcciones;
  propuestas: ServicioPropuestas;
  contexto: ServicioContexto;
  exigirSesion: (completa: boolean) => Guardia;
  limites?: { mensajesPorMinutoUsuario: number; mensajesPorMinutoOrg: number };
}

/** Rutas del chat y de las conexiones. Siempre con sesión completa; la organización y la persona salen de la sesión, nunca del cuerpo. */
export function registrarRutasChat(app: FastifyInstance, d: DepsChat): { manejarChat: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> } {
  const guardia = d.exigirSesion(true);
  const lim = d.limites ?? { mensajesPorMinutoUsuario: 12, mensajesPorMinutoOrg: 60 };
  const limUsuario = new Limitador(lim.mensajesPorMinutoUsuario, 60_000);
  const limOrg = new Limitador(lim.mensajesPorMinutoOrg, 60_000);

  app.get('/api/panel/chat/conversaciones', { preHandler: guardia }, async (req) => d.chat.listar(req.sesion!));
  app.get('/api/panel/chat/conversaciones/:id', { preHandler: guardia }, async (req) => d.chat.ver(req.sesion!, params.parse(req.params).id));
  app.post('/api/panel/chat/conversaciones/:id/borrar', { preHandler: guardia }, async (req) => {
    await d.chat.borrar(req.sesion!, params.parse(req.params).id);
    return { estado: 'ok' };
  });

  // Respuesta en streaming (SSE). Los errores previos al primer evento (sin saldo, sin conexión…) salen como errores HTTP normales.
  const manejarChat = async (req: FastifyRequest, reply: FastifyReply) => {
    const b = cuerpoChat.parse(req.body);
    const s = req.sesion!;
    if (!limUsuario.permitir(s.usuarioId) || !limOrg.permitir(s.orgId)) return reply.code(429).header('Retry-After', '60').send({ error: 'demasiados_intentos' });

    const ctl = new AbortController();
    let iniciado = false;
    let latido: NodeJS.Timeout | undefined;
    const abrir = () => {
      iniciado = true;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      });
      reply.raw.on('close', () => { if (!reply.raw.writableFinished) ctl.abort(); });
      latido = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
      latido.unref();
    };
    const emitir = (e: EventoChat) => {
      if (!iniciado) abrir();
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    try {
      await d.chat.enviar(s, b, emitir, ctl.signal);
    } catch (e) {
      if (!iniciado) throw e; // todavía no se abrió el flujo: lo maneja el manejador de errores normal
      emitir({ tipo: 'error', codigo: 'error_interno' });
    } finally {
      if (latido) clearInterval(latido);
    }
    if (iniciado) reply.raw.end();
    return reply;
  };
  app.post('/api/panel/chat', { preHandler: guardia }, manejarChat);

  app.get('/api/panel/acciones', { preHandler: guardia }, async (req) => d.acciones.listar(req.sesion!));
  app.post('/api/panel/acciones/:id/deshacer', { preHandler: guardia }, async (req) => d.acciones.deshacer(req.sesion!, params.parse(req.params).id, { ip: req.ip }));

  app.get('/api/panel/propuestas', { preHandler: guardia }, async (req) => d.propuestas.listar(req.sesion!));
  app.get('/api/panel/propuestas/:id', { preHandler: guardia }, async (req) => d.propuestas.ver(req.sesion!, params.parse(req.params).id));
  app.post('/api/panel/propuestas/:id/aprobar', { preHandler: guardia }, async (req) => d.propuestas.aprobar(req.sesion!, params.parse(req.params).id, { ip: req.ip }));
  app.post('/api/panel/propuestas/:id/rechazar', { preHandler: guardia }, async (req) => { await d.propuestas.rechazar(req.sesion!, params.parse(req.params).id, { ip: req.ip }); return { estado: 'rechazada' }; });

  app.get('/api/panel/instrucciones', { preHandler: guardia }, async (req) => d.contexto.ver(req.sesion!.orgId));
  app.post('/api/panel/instrucciones', { preHandler: guardia }, async (req) => {
    await d.contexto.guardar(req.sesion!, cuerpoContexto.parse(req.body).texto, { ip: req.ip });
    return d.contexto.ver(req.sesion!.orgId);
  });

  app.get('/api/panel/conexiones', { preHandler: guardia }, async (req) => d.conexiones.estado(req.sesion!.orgId));
  app.post('/api/panel/conexiones/send', { preHandler: guardia }, async (req) => {
    const b = cuerpoConexion.parse(req.body);
    await d.conexiones.conectar(req.sesion!, b.usuario, b.token, { ip: req.ip });
    return { estado: 'ok' };
  });
  app.post('/api/panel/conexiones/send/quitar', { preHandler: guardia }, async (req) => {
    await d.conexiones.desconectar(req.sesion!, { ip: req.ip });
    return { estado: 'ok' };
  });

  if (d.tiendas) {
    const tiendas = d.tiendas;
    const cuerpoQuitar = z.object({ nombre: z.string().trim().min(1).max(60) }).strict();
    app.get('/api/panel/tiendas', { preHandler: guardia }, async (req) => ({ tiendas: await tiendas.listar(req.sesion!.orgId) }));
    app.post('/api/panel/tiendas', { preHandler: guardia }, async (req) => {
      await tiendas.conectar(req.sesion!, esquemaConexionTienda.parse(req.body), { ip: req.ip });
      return { estado: 'ok' };
    });
    app.post('/api/panel/tiendas/quitar', { preHandler: guardia }, async (req) => {
      await tiendas.desconectar(req.sesion!, cuerpoQuitar.parse(req.body).nombre, { ip: req.ip });
      return { estado: 'ok' };
    });
  }

  if (d.pauta) {
    const pauta = d.pauta;
    const cuerpoQuitar = z.object({ nombre: z.string().trim().min(1).max(60) }).strict();
    app.get('/api/panel/pauta', { preHandler: guardia }, async (req) => ({ cuentas: await pauta.listar(req.sesion!.orgId) }));
    app.post('/api/panel/pauta', { preHandler: guardia }, async (req) => {
      await pauta.conectar(req.sesion!, esquemaConexionPauta.parse(req.body), { ip: req.ip });
      return { estado: 'ok' };
    });
    app.post('/api/panel/pauta/quitar', { preHandler: guardia }, async (req) => {
      await pauta.desconectar(req.sesion!, cuerpoQuitar.parse(req.body).nombre, { ip: req.ip });
      return { estado: 'ok' };
    });
  }
  if (d.suite) {
    const suite = d.suite;
    const cuerpoQuitar = z.object({ producto: z.enum(['talk', 'meet', 'booking']) }).strict();
    app.get('/api/panel/suite', { preHandler: guardia }, async (req) => ({ conexiones: await suite.listar(req.sesion!.orgId) }));
    app.post('/api/panel/suite', { preHandler: guardia }, async (req) => {
      await suite.conectar(req.sesion!, esquemaConexionSuite.parse(req.body), { ip: req.ip });
      return { estado: 'ok' };
    });
    app.post('/api/panel/suite/quitar', { preHandler: guardia }, async (req) => {
      await suite.desconectar(req.sesion!, cuerpoQuitar.parse(req.body).producto, { ip: req.ip });
      return { estado: 'ok' };
    });
  }
  return { manejarChat };
}

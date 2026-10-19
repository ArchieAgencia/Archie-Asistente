import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Limitador } from '../auth/limitador.js';
import type { Contexto } from '../auth/servicio.js';
import { MAX_PASSWORD } from '../crypto.js';
import type { ServicioInvitaciones } from './servicio.js';

type Guardia = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/); // 32 bytes en base64url: el formato exacto del token
const email = z.string().trim().toLowerCase().email().max(320);
const rol = z.enum(['admin', 'miembro']);
const uuid = z.string().uuid();
const params = z.object({ id: uuid });

const cuerpoVer = z.object({ token }).strict();
const cuerpoAceptar = z.object({ token, nombre: z.string().trim().min(1).max(120), password: z.string().min(1).max(MAX_PASSWORD) }).strict();
const cuerpoInvitar = z.object({ email, rol }).strict();
const cuerpoMiembro = z.object({ rol: rol.optional(), activo: z.boolean().optional() }).strict().refine((b) => b.rol !== undefined || b.activo !== undefined);

export interface DepsInvitaciones {
  servicio: ServicioInvitaciones;
  exigirSesion: (completa: boolean) => Guardia;
  limites?: { porIp: number; ventanaMs: number };
}

/**
 * Rutas de invitaciones.
 *  - /api/invitaciones/*: públicas (sin sesión). El token viaja en el cuerpo (POST), nunca en la URL, y se limita por IP.
 *  - /api/panel/equipo/*: solo con sesión completa; las operaciones de administración exigen rol admin (lo vuelve a verificar el servicio).
 */
export function registrarRutasInvitaciones(app: FastifyInstance, d: DepsInvitaciones): void {
  const lim = d.limites ?? { porIp: 30, ventanaMs: 15 * 60_000 };
  const limVer = new Limitador(lim.porIp, lim.ventanaMs);
  const limAceptar = new Limitador(Math.max(5, Math.floor(lim.porIp / 3)), lim.ventanaMs);
  const guardia = d.exigirSesion(true);
  const ctx = (req: FastifyRequest): Contexto => ({ ip: req.ip, agente: String(req.headers['user-agent'] ?? '') });
  const demasiados = (reply: FastifyReply) => reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });

  app.post('/api/invitaciones/ver', async (req, reply) => {
    const b = cuerpoVer.parse(req.body);
    if (!limVer.permitir(req.ip)) return demasiados(reply);
    return d.servicio.ver(b.token);
  });

  app.post('/api/invitaciones/aceptar', async (req, reply) => {
    const b = cuerpoAceptar.parse(req.body);
    if (!limAceptar.permitir(req.ip)) return demasiados(reply);
    await d.servicio.aceptar(b.token, b.nombre, b.password);
    return { estado: 'ok' };
  });

  app.get('/api/panel/equipo', { preHandler: guardia }, async (req) => d.servicio.listar(req.sesion!));

  app.post('/api/panel/equipo/invitaciones', { preHandler: guardia }, async (req) => {
    const b = cuerpoInvitar.parse(req.body);
    return d.servicio.invitar(req.sesion!, b.email, b.rol, ctx(req));
  });
  app.post('/api/panel/equipo/invitaciones/:id/reenviar', { preHandler: guardia }, async (req) =>
    d.servicio.reenviar(req.sesion!, params.parse(req.params).id, ctx(req)));
  app.post('/api/panel/equipo/invitaciones/:id/revocar', { preHandler: guardia }, async (req) => {
    await d.servicio.revocar(req.sesion!, params.parse(req.params).id, ctx(req));
    return { estado: 'ok' };
  });
  app.post('/api/panel/equipo/miembros/:id', { preHandler: guardia }, async (req) => {
    const b = cuerpoMiembro.parse(req.body);
    await d.servicio.cambiarMiembro(req.sesion!, params.parse(req.params).id, b, ctx(req));
    return { estado: 'ok' };
  });
}

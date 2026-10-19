import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { MAX_PASSWORD, hashToken } from '../crypto.js';
import { cookieBorrar, cookieSesion, leerCookie, NOMBRE_COOKIE, NOMBRE_COOKIE_OPERADOR } from '../auth/cookies.js';
import { Limitador } from '../auth/limitador.js';
import { type Contexto } from '../auth/servicio.js';
import type { ServicioConsola, SesionOperador } from './servicio.js';

declare module 'fastify' {
  interface FastifyRequest { operador?: SesionOperador }
}

const email = z.string().trim().toLowerCase().min(3).max(320);
const codigo = z.string().trim().regex(/^\d{6}$/);
const uuid = z.string().uuid();
const params = z.object({ id: uuid });

const cuerpoLogin = z.object({ email, password: z.string().min(1).max(MAX_PASSWORD) }).strict();
const cuerpo2fa = z.object({ codigo }).strict();
const cuerpoCrear = z.object({
  nombre: z.string().trim().min(1).max(200), email, nombreAdmin: z.string().trim().min(1).max(120).optional(),
  plan: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/).optional(), codigo,
}).strict();
const cuerpoCodigo = z.object({ codigo }).strict();
const cuerpoPlan = z.object({ plan: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/), codigo }).strict();
const cuerpoSaldo = z.object({
  cantidad: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 100_000),
  tipo: z.enum(['recarga', 'ajuste']), motivo: z.string().trim().max(200).optional(), codigo,
}).strict();
const cuerpoEstado = z.object({ estado: z.enum(['prueba', 'activo', 'suspendido', 'baja']), codigo }).strict();
const cuerpoModo = z.object({ modo: z.enum(['autoservicio', 'gestionada']), codigo }).strict();
const cuerpoAutonomia = z.object({ autonomia: z.enum(['lectura', 'borradores', 'confirmacion']), codigo }).strict();
const cuerpoAsistencia = z.object({ horas: z.number().int().min(0).max(72), codigo }).strict();
const cuerpoReset = z.object({ usuarioId: uuid, codigo }).strict();
const mes = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const consultaMes = z.object({ mes: mes.optional() });
const cuerpoQuitarConexion = z.object({ id: uuid, codigo }).strict();
const cuerpoRevocarClave = z.object({ clave: uuid, codigo }).strict();
const rolOperador = z.enum(['admin', 'soporte', 'finanzas']);
const cuerpoInvitarOperador = z.object({ email: z.string().trim().toLowerCase().min(3).max(320), nombre: z.string().trim().min(1).max(120), rol: rolOperador, codigo }).strict();
const cuerpoEstadoOperador = z.object({ activo: z.boolean(), codigo }).strict();
const cuerpoRolOperador = z.object({ rol: rolOperador, codigo }).strict();
const tokenInvitacion = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const cuerpoVerActivacion = z.object({ token: tokenInvitacion }).strict();
const cuerpoIniciarActivacion = z.object({ token: tokenInvitacion, password: z.string().min(1).max(MAX_PASSWORD) }).strict();
const cuerpoCompletarActivacion = z.object({ token: tokenInvitacion, codigo }).strict();
/** Mes actual en Bogotá (AAAA-MM). */
const mesActual = (ahora: number) => new Date(ahora - 5 * 3600_000).toISOString().slice(0, 7);
const consulta = z.object({ busca: z.string().trim().max(100).optional(), filtro: z.enum(['prueba', 'activo', 'suspendido', 'baja', 'sin_saldo']).optional() });

export interface OpcionesRutasConsola { limites?: { porIp: number; porCorreo: number; ventanaMs: number } }

/**
 * Rutas de la consola del equipo (/api/consola). Cookie propia, siempre con segundo factor, y cada escritura pide un código nuevo.
 * No existe ninguna ruta para entrar como un cliente.
 */
export function registrarRutasConsola(app: FastifyInstance, svc: ServicioConsola, config: Config, opc: OpcionesRutasConsola = {}) {
  const seguro = config.NODE_ENV === 'production';
  const lim = opc.limites ?? { porIp: 30, porCorreo: 10, ventanaMs: 15 * 60_000 };
  const limIp = new Limitador(lim.porIp, lim.ventanaMs);
  const limCorreo = new Limitador(lim.porCorreo, lim.ventanaMs);
  const limCodigos = new Limitador(lim.porIp, lim.ventanaMs); // intentos de acciones sensibles por IP
  const ctx = (req: FastifyRequest): Contexto => ({ ip: req.ip, agente: String(req.headers['user-agent'] ?? '') });
  const tokenDe = (req: FastifyRequest) => leerCookie(req.headers.cookie, NOMBRE_COOKIE_OPERADOR);
  const fijar = (reply: FastifyReply, token: string, seg: number) => reply.header('Set-Cookie', cookieSesion(token, seg, seguro, NOMBRE_COOKIE_OPERADOR));

  /** Exige sesión de operador con segundo factor completo. */
  const exigir = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = tokenDe(req);
    const s = t ? await svc.resolver(t) : null;
    if (!s || !s.mfaOk) return reply.code(401).send({ error: 'no_autenticado' });
    req.operador = s;
  };
  /** Acciones que escriben: además de la sesión, limitan la frecuencia por IP. */
  const exigirEscritura = async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await exigir(req, reply);
    if (r) return r;
    if (!limCodigos.permitir(req.ip)) return reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });
  };
  const tk = (req: FastifyRequest) => tokenDe(req)!;

  app.post('/api/consola/auth/login', async (req, reply) => {
    const b = cuerpoLogin.parse(req.body);
    if (!limIp.permitir(req.ip) || !limCorreo.permitir(hashToken(b.email).toString('hex'))) {
      return reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });
    }
    const r = await svc.login(b.email, b.password, ctx(req));
    fijar(reply, r.token, r.segundos);
    return { estado: 'requiere_2fa' };
  });

  app.post('/api/consola/auth/2fa', async (req, reply) => {
    const b = cuerpo2fa.parse(req.body);
    const t = tokenDe(req);
    if (!t) return reply.code(401).send({ error: 'no_autenticado' });
    if (!limIp.permitir(`2fa:${req.ip}`)) return reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });
    const r = await svc.verificarSegundoFactor(t, b.codigo, ctx(req));
    fijar(reply, r.token, r.segundos);
    return { estado: 'ok' };
  });

  app.post('/api/consola/auth/logout', async (req, reply) => {
    const t = tokenDe(req);
    if (t) await svc.cerrarSesion(t);
    reply.header('Set-Cookie', cookieBorrar(seguro, NOMBRE_COOKIE_OPERADOR));
    return { estado: 'ok' };
  });

  app.get('/api/consola/yo', { preHandler: exigir }, async (req) => {
    const { nombre, email: correo, rol } = req.operador!;
    return { nombre, email: correo, rol, cuentaPropia: await svc.hayCuentaPropia(tk(req)) };
  });

  app.get('/api/consola/resumen', { preHandler: exigir }, async (req) => svc.resumen(tk(req)));
  app.get('/api/consola/clientes', { preHandler: exigir }, async (req) => {
    const q = consulta.parse(req.query);
    return svc.clientes(tk(req), q.busca, q.filtro);
  });
  app.get('/api/consola/clientes/:id', { preHandler: exigir }, async (req) => svc.ficha(tk(req), params.parse(req.params).id));
  app.get('/api/consola/planes', { preHandler: exigir }, async (req) => svc.planes(tk(req)));
  app.get('/api/consola/bitacora', { preHandler: exigir }, async (req) => svc.bitacora(tk(req)));

  // ---- Conexiones, uso y widget por cliente ----
  app.get('/api/consola/clientes/:id/conexiones', { preHandler: exigir }, async (req) => svc.conexiones(tk(req), params.parse(req.params).id));
  app.get('/api/consola/clientes/:id/widget', { preHandler: exigir }, async (req) => svc.widget(tk(req), params.parse(req.params).id));
  app.get('/api/consola/clientes/:id/uso', { preHandler: exigir }, async (req) =>
    svc.usoCliente(tk(req), params.parse(req.params).id, consultaMes.parse(req.query).mes ?? mesActual(Date.now())));
  app.get('/api/consola/uso', { preHandler: exigir }, async (req) => svc.usoClientes(tk(req), consultaMes.parse(req.query).mes ?? mesActual(Date.now())));
  app.post('/api/consola/clientes/:id/conexiones/quitar', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoQuitarConexion.parse(req.body);
    await svc.quitarConexion(tk(req), b.codigo, params.parse(req.params).id, b.id);
    return { estado: 'ok' };
  });
  app.post('/api/consola/clientes/:id/widget/revocar', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoRevocarClave.parse(req.body);
    await svc.revocarClave(tk(req), b.codigo, params.parse(req.params).id, b.clave);
    return { estado: 'ok' };
  });

  // ---- Mi cuenta · Archie Tech: sesión de cliente SOLO en la cuenta propia y SOLO para quien la pide (su identidad, su segundo factor) ----
  app.post('/api/consola/mi-cuenta/abrir', { preHandler: exigir }, async (req, reply) => {
    const r = await svc.abrirMiCuenta(tk(req), ctx(req));
    reply.header('Set-Cookie', cookieSesion(r.token, r.segundos, seguro, NOMBRE_COOKIE));
    return { estado: 'ok', organizacion: r.organizacion };
  });

  // ---- Equipo de Archie (solo administración; las lecturas y escrituras las valida la base) ----
  app.get('/api/consola/equipo', { preHandler: exigir }, async (req) => ({ operadores: await svc.operadores(tk(req)), yo: req.operador!.operadorId }));
  app.get('/api/consola/equipo/bitacora', { preHandler: exigir }, async (req) => svc.bitacoraEquipo(tk(req)));
  app.post('/api/consola/equipo', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoInvitarOperador.parse(req.body);
    return svc.invitarOperador(tk(req), b.codigo, b);
  });
  app.post('/api/consola/equipo/:id/reenviar-invitacion', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoCodigo.parse(req.body);
    return svc.reenviarInvitacionOperador(tk(req), b.codigo, params.parse(req.params).id);
  });
  app.post('/api/consola/equipo/:id/estado', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoEstadoOperador.parse(req.body);
    await svc.estadoOperador(tk(req), b.codigo, params.parse(req.params).id, b.activo);
    return { estado: 'ok' };
  });
  app.post('/api/consola/equipo/:id/rol', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoRolOperador.parse(req.body);
    await svc.rolOperador(tk(req), b.codigo, params.parse(req.params).id, b.rol);
    return { estado: 'ok' };
  });

  // ---- Activación de una persona invitada (sin sesión; el token va en el cuerpo, nunca en la dirección) ----
  const limActivacion = new Limitador(lim.porIp, lim.ventanaMs);
  const permitirActivacion = (req: FastifyRequest, reply: FastifyReply) => {
    if (limActivacion.permitir(`activacion:${req.ip}`)) return true;
    reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });
    return false;
  };
  app.post('/api/consola/activacion/ver', async (req, reply) => {
    if (!permitirActivacion(req, reply)) return reply;
    return svc.verInvitacionOperador(cuerpoVerActivacion.parse(req.body).token);
  });
  app.post('/api/consola/activacion/iniciar', async (req, reply) => {
    if (!permitirActivacion(req, reply)) return reply;
    const b = cuerpoIniciarActivacion.parse(req.body);
    return svc.iniciarActivacion(b.token, b.password);
  });
  app.post('/api/consola/activacion/completar', async (req, reply) => {
    if (!permitirActivacion(req, reply)) return reply;
    const b = cuerpoCompletarActivacion.parse(req.body);
    await svc.completarActivacion(b.token, b.codigo);
    return { estado: 'ok' };
  });

  app.post('/api/consola/clientes', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoCrear.parse(req.body);
    return svc.crearCliente(tk(req), b.codigo, b);
  });
  app.post('/api/consola/clientes/:id/reenviar-invitacion', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoCodigo.parse(req.body);
    return svc.reenviarInvitacion(tk(req), b.codigo, params.parse(req.params).id);
  });
  app.post('/api/consola/clientes/:id/plan', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoPlan.parse(req.body);
    await svc.cambiarPlan(tk(req), b.codigo, params.parse(req.params).id, b.plan);
    return { estado: 'ok' };
  });
  app.post('/api/consola/clientes/:id/saldo', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoSaldo.parse(req.body);
    return { saldo: await svc.agregarSaldo(tk(req), b.codigo, params.parse(req.params).id, b.cantidad, b.tipo, b.motivo) };
  });
  app.post('/api/consola/clientes/:id/estado', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoEstado.parse(req.body);
    await svc.cambiarEstado(tk(req), b.codigo, params.parse(req.params).id, b.estado);
    return { estado: 'ok' };
  });
  app.post('/api/consola/clientes/:id/modo', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoModo.parse(req.body);
    await svc.cambiarModo(tk(req), b.codigo, params.parse(req.params).id, b.modo);
    return { estado: 'ok' };
  });
  app.post('/api/consola/clientes/:id/autonomia', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoAutonomia.parse(req.body);
    await svc.cambiarAutonomia(tk(req), b.codigo, params.parse(req.params).id, b.autonomia);
    return { estado: 'ok' };
  });
  app.post('/api/consola/clientes/:id/asistencia', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoAsistencia.parse(req.body);
    return { hasta: await svc.asistencia(tk(req), b.codigo, params.parse(req.params).id, b.horas) };
  });
  app.post('/api/consola/clientes/:id/resetear-2fa', { preHandler: exigirEscritura }, async (req) => {
    const b = cuerpoReset.parse(req.body);
    await svc.resetear2fa(tk(req), b.codigo, params.parse(req.params).id, b.usuarioId);
    return { estado: 'ok' };
  });
}


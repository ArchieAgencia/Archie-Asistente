import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { MAX_PASSWORD, hashToken } from '../crypto.js';
import { cookieBorrar, cookieSesion, leerCookie, NOMBRE_COOKIE } from './cookies.js';
import { Limitador } from './limitador.js';
import { ErrorAuth, type Contexto, type ServicioAuth, type SesionActiva } from './servicio.js';

declare module 'fastify' {
  interface FastifyRequest { sesion?: SesionActiva }
}

const email = z.string().trim().toLowerCase().min(3).max(320);
const password = z.string().min(1).max(MAX_PASSWORD);
const codigo = z.string().trim().regex(/^\d{6}$/);

const cuerpoLogin = z.object({ email, password }).strict();
const cuerpo2fa = z.object({ codigo }).strict();
const cuerpoEntrada2fa = z.union([z.object({ codigo }).strict(), z.object({ recuperacion: z.string().trim().min(8).max(40) }).strict()]);
const cuerpoRecuperar = z.object({ email }).strict();
const cuerpoRestablecer = z.object({ token: z.string().min(20).max(100), nueva: z.string().min(1).max(MAX_PASSWORD) }).strict();
const cuerpoEnrolar = z.object({ password }).strict();
const cuerpoCambio = z.object({ actual: password, nueva: z.string().min(1).max(MAX_PASSWORD) }).strict();

export interface OpcionesRutas { limites?: { porIp: number; porCorreo: number; ventanaMs: number } }

export function registrarRutasAuth(app: FastifyInstance, servicio: ServicioAuth, config: Config, opc: OpcionesRutas = {}) {
  const seguro = config.NODE_ENV === 'production';
  const lim = opc.limites ?? { porIp: 30, porCorreo: 10, ventanaMs: 15 * 60_000 };
  const limIp = new Limitador(lim.porIp, lim.ventanaMs);
  const limCorreo = new Limitador(lim.porCorreo, lim.ventanaMs);

  const ctx = (req: FastifyRequest): Contexto => ({ ip: req.ip, agente: String(req.headers['user-agent'] ?? '') });

  // Defensa contra peticiones desde otros sitios (CSRF): además de SameSite=Lax, el origen debe ser el del panel.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origen = req.headers.origin;
    if (origen && config.ARCHIE_ORIGEN && origen !== new URL(config.ARCHIE_ORIGEN).origin) {
      return reply.code(403).send({ error: 'origen_no_permitido' });
    }
  });

  // Las respuestas con sesión nunca se guardan en cachés.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/auth/') || req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((e, req, reply) => {
    if (e instanceof ErrorAuth) return reply.code(e.estado).send({ error: e.codigo, mensaje: e.message });
    if (e instanceof z.ZodError) return reply.code(400).send({ error: 'entrada_invalida' });
    if ((e as { statusCode?: number }).statusCode && (e as { statusCode: number }).statusCode < 500) {
      return reply.code((e as { statusCode: number }).statusCode).send({ error: 'peticion_invalida' });
    }
    req.log.error({ err: e }, 'error interno'); // el detalle va al registro del servidor, nunca al cliente
    return reply.code(500).send({ error: 'error_interno' });
  });

  const fijarCookie = (reply: FastifyReply, token: string, segundos: number) =>
    reply.header('Set-Cookie', cookieSesion(token, segundos, seguro));

  const tokenDe = (req: FastifyRequest) => leerCookie(req.headers.cookie, NOMBRE_COOKIE);

  /** preHandler: exige sesión válida. `completa` exige además que haya pasado el segundo factor. */
  const exigirSesion = (completa: boolean, opc: { permiteSin2fa?: boolean } = {}) => async (req: FastifyRequest, reply: FastifyReply) => {
    const t = tokenDe(req);
    const s = t ? await servicio.resolver(t) : null;
    if (!s || (completa && !s.mfaOk)) return reply.code(401).send({ error: 'no_autenticado' });
    // Administradores sin segundo factor: solo pueden activarlo (y ver su perfil / cambiar la contraseña).
    if (completa && config.ARCHIE_2FA_ADMIN === 'obligatorio' && !opc.permiteSin2fa && await servicio.debeActivar2fa(s)) {
      return reply.code(403).send({ error: '2fa_obligatoria' });
    }
    req.sesion = s;
  };

  app.post('/auth/login', async (req, reply) => {
    const b = cuerpoLogin.parse(req.body);
    if (!limIp.permitir(req.ip) || !limCorreo.permitir(hashToken(b.email).toString('hex'))) {
      return reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });
    }
    const r = await servicio.login(b.email, b.password, ctx(req));
    fijarCookie(reply, r.token, r.segundos);
    return r.tipo === 'ok' ? { estado: 'ok', usuario: r.usuario } : { estado: 'requiere_2fa' };
  });

  app.post('/auth/2fa', async (req, reply) => {
    const b = cuerpoEntrada2fa.parse(req.body);
    const t = tokenDe(req);
    if (!t) return reply.code(401).send({ error: 'no_autenticado' });
    if (!limIp.permitir(`2fa:${req.ip}`)) return reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });
    if ('recuperacion' in b) {
      const r = await servicio.verificarCodigoRecuperacion(t, b.recuperacion, ctx(req));
      fijarCookie(reply, r.token, r.segundos);
      return { estado: 'ok', usuario: r.usuario, codigosRestantes: r.restantes };
    }
    const r = await servicio.verificarSegundoFactor(t, b.codigo, ctx(req));
    fijarCookie(reply, r.token, r.segundos);
    return { estado: 'ok', usuario: r.usuario };
  });

  app.post('/auth/logout', async (req, reply) => {
    const t = tokenDe(req);
    if (t) await servicio.cerrarSesion(t, ctx(req));
    reply.header('Set-Cookie', cookieBorrar(seguro));
    return { estado: 'ok' };
  });

  app.get('/auth/yo', { preHandler: exigirSesion(true, { permiteSin2fa: true }) }, async (req) => servicio.perfil(req.sesion!));

  app.post('/auth/2fa/iniciar', { preHandler: exigirSesion(true, { permiteSin2fa: true }) }, async (req) => {
    const b = cuerpoEnrolar.parse(req.body);
    return servicio.iniciarEnrolamiento2fa(req.sesion!, b.password, ctx(req));
  });

  app.post('/auth/2fa/confirmar', { preHandler: exigirSesion(true, { permiteSin2fa: true }) }, async (req) => {
    const b = cuerpo2fa.parse(req.body);
    const r = await servicio.confirmarEnrolamiento2fa(req.sesion!, b.codigo, ctx(req));
    return { estado: 'ok', codigos: r.codigos };
  });

  app.post('/auth/2fa/codigos', { preHandler: exigirSesion(true) }, async (req) => {
    const b = cuerpoEnrolar.parse(req.body);
    return servicio.regenerarCodigosRecuperacion(req.sesion!, b.password, ctx(req));
  });

  // Recuperación de contraseña (sin sesión). La respuesta es la misma exista o no el correo, y no espera al envío del correo
  // (así ni el contenido ni el tiempo permiten saber si el correo tiene cuenta).
  app.post('/auth/recuperar', async (req, reply) => {
    const b = cuerpoRecuperar.parse(req.body);
    if (!limIp.permitir(`rec:${req.ip}`)) return reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });
    if (limCorreo.permitir(`rec:${hashToken(b.email).toString('hex')}`)) {
      void servicio.solicitarRecuperacion(b.email).catch((e) => req.log.error({ err: e }, 'error al solicitar la recuperación'));
    }
    return { estado: 'ok' };
  });

  app.post('/auth/restablecer', async (req, reply) => {
    const b = cuerpoRestablecer.parse(req.body);
    if (!limIp.permitir(`res:${req.ip}`)) return reply.code(429).header('Retry-After', '900').send({ error: 'demasiados_intentos' });
    await servicio.restablecerPassword(b.token, b.nueva, ctx(req));
    return { estado: 'ok' };
  });

  app.post('/auth/password', { preHandler: exigirSesion(true, { permiteSin2fa: true }) }, async (req) => {
    const b = cuerpoCambio.parse(req.body);
    await servicio.cambiarPassword(req.sesion!, b.actual, b.nueva, ctx(req));
    return { estado: 'ok' };
  });

  return { exigirSesion };
}

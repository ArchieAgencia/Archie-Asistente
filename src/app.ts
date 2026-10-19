import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registrarRutasAuth, type OpcionesRutas } from './auth/rutas.js';
import { ServicioAuth, type OpcionesAuth } from './auth/servicio.js';
import { ServicioContexto } from './chat/contexto-negocio.js';
import { ServicioAcciones } from './chat/acciones.js';
import { AlertasConsumo } from './panel/alertas.js';
import { ServicioPropuestas } from './chat/propuestas.js';
import { ServicioConexiones } from './chat/conexiones.js';
import { ServicioTiendas } from './chat/tiendas.js';
import { ServicioPauta } from './chat/pauta.js';
import { ServicioSuite } from './chat/suite.js';
import { HttpSeguro } from './conectores/http-seguro.js';
import { registrarRutasChat } from './chat/rutas.js';
import { politicaIncrustacion, ServicioWidget } from './widget/servicio.js';
import { registrarRutasWidget } from './widget/rutas.js';
import { ServicioChat } from './chat/servicio.js';
import { ModeloArchieIA } from './ia/archie-ia.js';
import type { ModeloIA } from './ia/modelo.js';
import { ModeloSimulado } from './ia/simulado.js';
import type { OpcionesSend } from './conectores/send.js';
import { registrarRutasConsola } from './consola/rutas.js';
import { ServicioConsola, OPCIONES_CONSOLA, type OpcionesConsola } from './consola/servicio.js';
import { CorreoConsola, CorreoResend, listaSoloA, type Correo } from './correo/correo.js';
import { Notificador } from './correo/notificador.js';
import { registrarRutasInvitaciones } from './invitaciones/rutas.js';
import { ServicioInvitaciones } from './invitaciones/servicio.js';
import { ServicioConsumo } from './panel/consumo.js';
import { registrarRutasPanel } from './panel/rutas.js';
import type { Config } from './config.js';
import type { Llaves } from './crypto.js';

export interface Dependencias {
  pool: pg.Pool; // conectado con el rol archie_app
  llaves: Llaves;
  auth?: Partial<OpcionesAuth>;
  rutas?: OpcionesRutas;
  consola?: Partial<OpcionesConsola>;
  /** Solo pruebas: reloj para los códigos del equipo. */
  relojConsola?: () => number;
  /** Proveedor de correo. Si no se da, se elige según ARCHIE_CORREO (consola = no envía nada; resend = envío real). */
  correo?: Correo;
  /** Solo pruebas: forzar si las respuestas devuelven el enlace de invitación (por defecto solo en desarrollo con correo de consola). */
  devolverEnlace?: boolean;
  /** Proveedor de IA. Si no se da, se elige según ARCHIE_IA (simulado = no llama a nadie). */
  modelo?: ModeloIA;
  /** Solo pruebas: opciones de red para hablar con Archie Send (fetch falso, tiempos). */
  opcionesSend?: OpcionesSend;
  /** Cliente HTTP para las tiendas. Si no se da, se usa el real (solo https, direcciones públicas). Solo pruebas: uno simulado. */
  httpTiendas?: HttpSeguro;
  /** Solo pruebas: intentos de conectar tiendas por organización. */
  intentosTiendas?: { max: number; ventanaMs: number };
  /** Solo pruebas: límites del widget (pedir enlace por IP y por clave, canjear por IP). */
  limitesWidget?: { pedirPorIp: number; pedirPorClave: number; canjePorIp: number; ventanaMs: number };
  /** Solo pruebas: límites de mensajes del chat por minuto. */
  limitesChat?: { mensajesPorMinutoUsuario: number; mensajesPorMinutoOrg: number };
}

function crearModelo(config: Config): ModeloIA {
  if (config.ARCHIE_IA === 'archie') return new ModeloArchieIA({ apiKey: config.ARCHIE_IA_CLAVE!, modelo: config.ARCHIE_IA_MODELO! });
  return new ModeloSimulado();
}

function crearCorreo(config: Config): Correo {
  if (config.ARCHIE_CORREO === 'resend') {
    return new CorreoResend({ apiKey: config.RESEND_API_KEY!, remitente: config.ARCHIE_CORREO_REMITENTE!, soloA: listaSoloA(config.ARCHIE_CORREO_SOLO_A) });
  }
  return new CorreoConsola();
}

export function crearApp(config: Config, deps?: Dependencias): FastifyInstance {
  const app = Fastify({
    logger: config.NODE_ENV !== 'test' ? { redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    bodyLimit: 1_000_000,
    // Se confían solo los N proxies de confianza (de derecha a izquierda): un cliente no puede falsear su IP con X-Forwarded-For.
    trustProxy: (_direccion: string, salto: number) => salto < config.ARCHIE_PROXY_SALTOS,
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (config.NODE_ENV === 'production') reply.header('Strict-Transport-Security', 'max-age=31536000');
    // La interfaz es del mismo sitio: sin scripts, imágenes ni conexiones de terceros (las fuentes van incluidas en la interfaz).
    // La única excepción es la página del widget, que fija su propia política con los sitios autorizados de cada organización.
    if (reply.hasHeader('content-security-policy')) return;
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });

  // Chequeo de salud para Coolify y Uptime Kuma. No expone nada interno.
  app.get('/salud', async () => ({ ok: true, version: config.ARCHIE_VERSION }));

  let widget: ServicioWidget | undefined;
  if (deps) {
    // El enlace de invitación solo se devuelve en la respuesta en desarrollo con correo de consola (para poder probar sin enviar correos).
    const devolverEnlace = deps.devolverEnlace ?? (config.NODE_ENV !== 'production' && config.ARCHIE_CORREO === 'consola' && !deps.correo);
    const notificador = new Notificador(
      deps.correo ?? crearCorreo(config), config.ARCHIE_ORIGEN ?? `http://localhost:${config.PORT}`, devolverEnlace,
      { error: (o, m) => app.log.error(o, m) },
    );
    const servicio = new ServicioAuth(deps.pool, deps.llaves, { sesionHoras: 12, pendienteMinutos: 5, maxFallos: 5, bloqueoMinutos: 15, ...deps.auth },
      notificador, { error: (o, m) => app.log.error(o, m) });
    const { exigirSesion } = registrarRutasAuth(app, servicio, config, deps.rutas);
    registrarRutasConsola(app, new ServicioConsola(deps.pool, deps.llaves, { ...OPCIONES_CONSOLA, ...deps.consola }, deps.relojConsola, notificador), config, deps.rutas);
    registrarRutasPanel(app, { pool: deps.pool, consumo: new ServicioConsumo(deps.pool), exigirSesion });
    const conexiones = new ServicioConexiones(deps.pool, deps.llaves, config.ARCHIE_SEND_URL, deps.opcionesSend);
    const tiendas = new ServicioTiendas(deps.pool, deps.llaves, deps.httpTiendas ?? new HttpSeguro(), { error: (o, m) => app.log.error(o, m) }, deps.intentosTiendas);
    const pauta = new ServicioPauta(deps.pool, deps.llaves, deps.httpTiendas ?? new HttpSeguro(), { error: (o, m) => app.log.error(o, m) }, deps.intentosTiendas);
    const suite = new ServicioSuite(deps.pool, deps.llaves, deps.httpTiendas ?? new HttpSeguro(), { error: (o, m) => app.log.error(o, m) }, deps.intentosTiendas);
    const propuestas = new ServicioPropuestas(deps.pool, conexiones, { error: (o, m) => app.log.error(o, m) });
    const chat = new ServicioChat(deps.pool, deps.modelo ?? crearModelo(config), conexiones, propuestas, {
      maxPasos: config.ARCHIE_IA_MAX_PASOS, maxTokens: config.ARCHIE_IA_MAX_TOKENS, contactos: config.ARCHIE_IA_CONTACTOS === 'si',
      precios: { entrada: config.ARCHIE_IA_PRECIO_ENTRADA, salida: config.ARCHIE_IA_PRECIO_SALIDA, cache: config.ARCHIE_IA_PRECIO_CACHE },
    }, { error: (o, m) => app.log.error(o, m) }, new AlertasConsumo(deps.pool, notificador, { error: (o, m) => app.log.error(o, m) }), tiendas, pauta, suite);
    const { manejarChat } = registrarRutasChat(app, { chat, conexiones, tiendas, pauta, suite, propuestas, contexto: new ServicioContexto(deps.pool), acciones: new ServicioAcciones(deps.pool, conexiones), exigirSesion, limites: deps.limitesChat });
    widget = new ServicioWidget(deps.pool, config.ARCHIE_ORIGEN ?? `http://localhost:${config.PORT}`, deps.limitesWidget);
    registrarRutasWidget(app, { widget, chat, conexiones, tiendas, pauta, suite, guardiaPanel: exigirSesion(true), manejarChat });
    registrarRutasInvitaciones(app, { servicio: new ServicioInvitaciones(deps.pool, notificador), exigirSesion, limites: deps.rutas?.limites ? { porIp: deps.rutas.limites.porIp, ventanaMs: deps.rutas.limites.ventanaMs } : undefined });
  }

  // Interfaz (Vue) compilada: se sirve desde el mismo sitio. Cualquier ruta que no sea de la API vuelve a index.html.
  const web = resolve(config.ARCHIE_WEB_DIR ?? 'web/dist');
  if (existsSync(resolve(web, 'index.html'))) {
    void app.register(fastifyStatic, { root: web, wildcard: false, index: false, cacheControl: false, setHeaders: (res, ruta) => {
      res.header('Cache-Control', ruta.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    } });
    app.setNotFoundHandler((req, reply) => {
      const esApi = req.url.startsWith('/api/') || req.url.startsWith('/auth/') || req.url === '/salud';
      const m = /^\/widget\/([^/?#]+)\/?(?:\?.*)?$/.exec(req.url);
      if (req.method === 'GET' && m && widget) {
        // Página del widget: solo puede incrustarse en los sitios que la organización autorizó (y en ninguno si no registró ninguno).
        return widget.origenesDe(m[1]!).then((o) => reply.header('Content-Security-Policy', politicaIncrustacion(o)).type('text/html').sendFile('index.html'));
      }
      if (req.method === 'GET' && !esApi) return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'no_encontrado' });
    });
  }

  return app;
}

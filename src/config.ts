import { z } from 'zod';

// Configuración validada al arrancar: si falta algo o es débil, el servicio no inicia.
const esquema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8800),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    ARCHIE_VERSION: z.string().default('0.0.0-dev'),
    /** Conexión de la aplicación (rol archie_app, nunca el dueño ni un superusuario). */
    DATABASE_URL: z.string().min(1).optional(),
    /** Origen público del panel, p. ej. https://archieai.ejemplo.com. Se usa para rechazar peticiones de otros sitios. */
    ARCHIE_ORIGEN: z.string().url().optional(),
    /** Carpeta con la interfaz compilada (web/dist). Si no existe, solo se sirve la API. */
    ARCHIE_WEB_DIR: z.string().optional(),
    /**
     * Cómo se envían los correos del sistema (invitaciones). `consola` NO envía nada: escribe el correo en el registro (solo desarrollo).
     * `resend` envía de verdad por Resend y exige clave y remitente.
     */
    ARCHIE_CORREO: z.enum(['consola', 'resend']).default('consola'),
    RESEND_API_KEY: z.string().min(10).max(200).optional(),
    /** Remitente: "Archie AI <no-responder@tu-dominio>" o solo el correo. Sin saltos de línea. */
    ARCHIE_CORREO_REMITENTE: z.string().max(200).regex(/^(?:[^<>\r\n@]{1,100} <[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/).optional(),
    /** Lista de seguridad para pruebas: "a@x.com, @y.com". Si se define, solo se envía a esas direcciones o dominios. */
    ARCHIE_CORREO_SOLO_A: z.string().max(1000).optional(),
    /**
     * Proveedor de IA. `simulado` NO llama a ningún servicio (respuestas fijas, solo desarrollo y pruebas).
     * `archie` usa el proveedor de IA de Archie Tech y exige clave y nombre de modelo (los nombres de modelo cambian: nunca van en el código).
     */
    ARCHIE_IA: z.enum(['simulado', 'archie']).default('simulado'),
    ARCHIE_IA_CLAVE: z.string().min(10).max(300).optional(),
    ARCHIE_IA_MODELO: z.string().regex(/^[A-Za-z0-9._:-]{3,100}$/).optional(),
    /** Precios en micro-dólares por millón de tokens (1 USD = 1.000.000). Solo para estimar el costo registrado. */
    ARCHIE_IA_PRECIO_ENTRADA: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
    ARCHIE_IA_PRECIO_SALIDA: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
    ARCHIE_IA_PRECIO_CACHE: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
    ARCHIE_IA_MAX_TOKENS: z.coerce.number().int().min(64).max(8192).default(1024),
    /** Máximo de vueltas modelo→herramienta→modelo por mensaje. */
    ARCHIE_IA_MAX_PASOS: z.coerce.number().int().min(1).max(10).default(6),
    /** Origen de Archie Send (p. ej. https://send.ejemplo.com). Lo fija el servidor: los clientes no escriben URL (evita SSRF). */
    ARCHIE_SEND_URL: z.string().url().optional(),
    /** La herramienta de contactos queda apagada hasta la revisión legal (Ley 1581). Solo datos de prueba o internos. */
    // Segundo factor de los administradores de cada cuenta: en producción siempre obligatorio.
    ARCHIE_2FA_ADMIN: z.enum(['obligatorio', 'opcional']).default('obligatorio'),
    ARCHIE_IA_CONTACTOS: z.enum(['si', 'no']).default('no'),
    /** Cuántos proxies hay delante (Coolify/Traefik = 1; con Cloudflare delante = 2). Define de dónde se toma la IP real. */
    ARCHIE_PROXY_SALTOS: z.coerce.number().int().min(0).max(5).default(1),
  })
  .superRefine((c, ctx) => {
    if (c.ARCHIE_CORREO === 'resend') {
      if (!c.RESEND_API_KEY) ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'obligatoria con ARCHIE_CORREO=resend' });
      if (!c.ARCHIE_CORREO_REMITENTE) ctx.addIssue({ code: 'custom', path: ['ARCHIE_CORREO_REMITENTE'], message: 'obligatorio con ARCHIE_CORREO=resend' });
    }
    if (c.ARCHIE_IA === 'archie') {
      if (!c.ARCHIE_IA_CLAVE) ctx.addIssue({ code: 'custom', path: ['ARCHIE_IA_CLAVE'], message: 'obligatoria con ARCHIE_IA=archie' });
      if (!c.ARCHIE_IA_MODELO) ctx.addIssue({ code: 'custom', path: ['ARCHIE_IA_MODELO'], message: 'obligatorio con ARCHIE_IA=archie' });
    }
    if (c.ARCHIE_SEND_URL && c.NODE_ENV === 'production' && !c.ARCHIE_SEND_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['ARCHIE_SEND_URL'], message: 'debe usar https en producción' });
    }
    if (c.NODE_ENV !== 'production') return;
    if (c.ARCHIE_IA !== 'archie') ctx.addIssue({ code: 'custom', path: ['ARCHIE_IA'], message: 'en producción debe ser archie' });
    if (c.ARCHIE_2FA_ADMIN !== 'obligatorio') ctx.addIssue({ code: 'custom', path: ['ARCHIE_2FA_ADMIN'], message: 'en producción debe ser obligatorio' });
    if (c.ARCHIE_CORREO !== 'resend') ctx.addIssue({ code: 'custom', path: ['ARCHIE_CORREO'], message: 'en producción debe ser resend' });
    if (!c.DATABASE_URL) ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'obligatoria en producción' });
    if (!c.ARCHIE_ORIGEN) ctx.addIssue({ code: 'custom', path: ['ARCHIE_ORIGEN'], message: 'obligatoria en producción' });
    else if (!c.ARCHIE_ORIGEN.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['ARCHIE_ORIGEN'], message: 'debe usar https en producción' });
  });

export type Config = z.infer<typeof esquema>;

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = esquema.safeParse(env);
  if (!r.success) {
    // Solo nombres de variables, nunca valores (podrían ser secretos).
    const campos = [...new Set(r.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Configuración inválida en: ${campos}`);
  }
  return r.data;
}

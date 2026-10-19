import { z } from 'zod';
import type { Herramienta } from './send-herramientas.js';
import { limpiarTexto } from './send-herramientas.js';

/**
 * Herramientas de nivel 2 de Archie Send: crean BORRADORES que se pueden deshacer.
 * Ninguna envía, programa, pausa, edita ni borra. Enviar o programar es nivel 3 (con tarjeta de confirmación).
 */

export const MAX_CUERPO = 30_000;

// Lo único que se acepta dentro del correo: el cuerpo de una campaña es una plantilla de Archie Send (Go),
// así que solo se permiten las dos variables de nombre y nada que ejecute código o cargue contenido activo.
const VARIABLES_OK = /\{\{\s*\.Subscriber\.(FirstName|Name)\s*\}\}/g;
const PROHIBIDOS = [
  /<\s*(script|iframe|object|embed|form|style|link|meta|base|svg|math|applet|frame|frameset|noscript|template)\b/i,
  /(java|vb)script\s*:/i, /\bon\w+\s*=/i, /data\s*:\s*text\/html/i, /\bsrcdoc\s*=/i, /expression\s*\(/i,
];
const ESQUEMAS_OK = new Set(['http', 'https', 'mailto', 'tel']);
const ATRIBUTOS_URL = /\b(?:href|src|action|formaction|poster|background|xlink:href|srcset|codebase|cite|longdesc|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** Decodifica las entidades HTML que se usan para esconder esquemas (&colon;, &#106;, &#x6a;, &Tab;...). */
function decodificar(s: string): string {
  const nombradas: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", sol: '/', equals: '=' };
  return s
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d{1,7});?/g, (_m, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&([a-z]+);?/gi, (m, n: string) => nombradas[n.toLowerCase()] ?? m);
}

/**
 * Devuelve el motivo del rechazo o null si el cuerpo es aceptable. Es una defensa en capas, no un sanitizador completo:
 * quien aprueba el envío sigue viendo el inicio del contenido en la tarjeta y la campaña nace siempre en borrador.
 */
export function motivoCuerpoInseguro(cuerpo: string): string | null {
  const sinVariables = cuerpo.replace(VARIABLES_OK, '');
  if (sinVariables.includes('{{') || sinVariables.includes('{%')) return 'El contenido solo puede usar las variables {{ .Subscriber.FirstName }} y {{ .Subscriber.Name }}.';
  const MOTIVO = 'El contenido no puede incluir scripts, formularios, marcos incrustados, estilos, atributos de eventos ni enlaces con esquemas distintos de http, https, mailto o tel.';
  // Se revisa el texto tal cual y ya decodificado (dos pasadas, por entidades anidadas) y sin espacios ni controles dentro de los valores.
  const decodificado = decodificar(decodificar(cuerpo));
  for (const t of [cuerpo, decodificado]) {
    if (PROHIBIDOS.some((r) => r.test(t))) return MOTIVO;
    for (const m of t.matchAll(ATRIBUTOS_URL)) {
      const v = (m[1] ?? m[2] ?? m[3] ?? '').replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, '').toLowerCase();
      const e = /^([a-z][a-z0-9+.-]*):/.exec(v);
      if (e && !ESQUEMAS_OK.has(e[1]!)) return MOTIVO;
    }
  }
  return null;
}

const nombre = z.string().trim().min(1).max(100);
const etiquetas = z.array(z.string().trim().min(1).max(30)).max(5).optional();
const id = z.number().int().min(1).max(2_000_000_000);

const CAMPOS = ['email', 'name', 'status', 'created_at', 'updated_at', 'list', 'attrib'] as const;
const OPERADORES = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'is', 'is_not', 'on', 'before', 'after', 'in', 'not_in', 'none', 'has', 'has_not'] as const;

const regla = z.object({
  campo: z.enum(CAMPOS),
  operador: z.enum(OPERADORES),
  valor: z.string().trim().max(200).optional(),
  atributo: z.string().trim().max(64).optional(),
  lista_id: id.optional(),
  estado_suscripcion: z.enum(['unconfirmed', 'confirmed', 'unsubscribed']).optional(),
}).strict();

const sinPropiedadesVacias = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export const HERRAMIENTAS_BORRADORES: Herramienta[] = [
  {
    nivel: 2,
    nombre: 'send_crear_lista',
    descripcion: 'Crea una lista de contactos VACÍA en Archie Send. No agrega contactos. La persona puede deshacerlo desde la pantalla Acciones mientras la lista siga vacía.',
    schema: { type: 'object', properties: {
      nombre: { type: 'string', maxLength: 100 }, tipo: { type: 'string', enum: ['private', 'public'], description: 'private (por defecto) no aparece en formularios públicos' },
      doble_confirmacion: { type: 'boolean', description: 'true para pedir confirmación por correo a quien se suscriba' }, descripcion: { type: 'string', maxLength: 300 },
      etiquetas: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 5 } }, required: ['nombre'], additionalProperties: false },
    entrada: z.object({ nombre, tipo: z.enum(['private', 'public']).default('private'), doble_confirmacion: z.boolean().default(false), descripcion: z.string().trim().max(300).optional(), etiquetas }).strict(),
    async ejecutar(c, a) {
      const r = await c.send.crear('/api/lists', sinPropiedadesVacias({
        name: a.nombre, type: a.tipo, optin: a.doble_confirmacion ? 'double' : 'single', description: a.descripcion, tags: a.etiquetas ?? [] }));
      const o = (r ?? {}) as Record<string, unknown>;
      const idNuevo = typeof o.id === 'number' ? o.id : 0;
      if (!idNuevo) throw new Error('respuesta sin id');
      return { datos: { creada: true, id: idNuevo, nombre: limpiarTexto(a.nombre, 100) }, accion: { tipo: 'lista', id: idNuevo, nombre: limpiarTexto(a.nombre, 100) } };
    },
  },
  {
    nivel: 2,
    nombre: 'send_crear_segmento',
    descripcion: 'Guarda un segmento (filtro de contactos) en Archie Send. No modifica contactos. Se puede deshacer desde la pantalla Acciones.',
    schema: { type: 'object', properties: {
      nombre: { type: 'string', maxLength: 100 },
      coincidir: { type: 'string', enum: ['all', 'any'], description: 'all = cumplir todas las reglas; any = cualquiera' },
      reglas: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: {
        campo: { type: 'string', enum: [...CAMPOS] }, operador: { type: 'string', enum: [...OPERADORES] }, valor: { type: 'string', maxLength: 200 },
        atributo: { type: 'string', maxLength: 64 }, lista_id: { type: 'integer', minimum: 1 }, estado_suscripcion: { type: 'string', enum: ['unconfirmed', 'confirmed', 'unsubscribed'] } },
        required: ['campo', 'operador'], additionalProperties: false } } }, required: ['nombre', 'reglas'], additionalProperties: false },
    entrada: z.object({ nombre, coincidir: z.enum(['all', 'any']).default('all'), reglas: z.array(regla).min(1).max(10) }).strict(),
    async ejecutar(c, a) {
      const rules = (a.reglas as z.infer<typeof regla>[]).map((r) => sinPropiedadesVacias({
        field: r.campo, op: r.operador, value: r.valor, key: r.atributo, list_id: r.lista_id, status: r.estado_suscripcion }));
      const r = await c.send.crear('/api/segments', { name: a.nombre, filter: { match: a.coincidir, rules } });
      const o = (r ?? {}) as Record<string, unknown>;
      const idNuevo = typeof o.id === 'number' ? o.id : 0;
      if (!idNuevo) throw new Error('respuesta sin id');
      return { datos: { creado: true, id: idNuevo, nombre: limpiarTexto(a.nombre, 100) }, accion: { tipo: 'segmento', id: idNuevo, nombre: limpiarTexto(a.nombre, 100) } };
    },
  },
  {
    nivel: 2,
    nombre: 'send_crear_borrador_campana',
    descripcion: 'Crea una campaña en estado BORRADOR en Archie Send. No la envía ni la programa: queda para que una persona la revise y la envíe desde Archie Send. Se puede deshacer desde Acciones mientras siga en borrador. Antes de usarla, confirma con la persona el nombre, el asunto, las listas y el contenido.',
    schema: { type: 'object', properties: {
      nombre: { type: 'string', maxLength: 100 }, asunto: { type: 'string', maxLength: 200 },
      lista_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 5 },
      cuerpo: { type: 'string', maxLength: MAX_CUERPO, description: 'HTML simple del correo. Solo se permiten las variables {{ .Subscriber.FirstName }} y {{ .Subscriber.Name }}.' },
      tipo_contenido: { type: 'string', enum: ['richtext', 'html', 'plain'] }, segmento_id: { type: 'integer', minimum: 1 },
      etiquetas: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 5 } },
      required: ['nombre', 'asunto', 'lista_ids', 'cuerpo'], additionalProperties: false },
    entrada: z.object({ nombre, asunto: z.string().trim().min(1).max(200), lista_ids: z.array(id).min(1).max(5), cuerpo: z.string().min(1).max(MAX_CUERPO),
      tipo_contenido: z.enum(['richtext', 'html', 'plain']).default('richtext'), segmento_id: id.optional(), etiquetas }).strict()
      .superRefine((v, ctx) => { const m = motivoCuerpoInseguro(v.cuerpo); if (m) ctx.addIssue({ code: 'custom', message: m, path: ['cuerpo'] }); }),
    async ejecutar(c, a) {
      const r = await c.send.crear('/api/campaigns', sinPropiedadesVacias({
        name: a.nombre, subject: a.asunto, lists: a.lista_ids, body: a.cuerpo, content_type: a.tipo_contenido, type: 'regular',
        messenger: 'email', segment_id: a.segmento_id, tags: a.etiquetas ?? [] }));
      const o = (r ?? {}) as Record<string, unknown>;
      const idNuevo = typeof o.id === 'number' ? o.id : 0;
      if (!idNuevo) throw new Error('respuesta sin id');
      const estado = typeof o.status === 'string' ? o.status : 'draft';
      return { datos: { creada_en_borrador: estado === 'draft', estado: limpiarTexto(estado, 20), id: idNuevo, nombre: limpiarTexto(a.nombre, 100), aviso: 'NO se ha enviado nada. Una persona debe revisarla y enviarla desde Archie Send.' },
        accion: { tipo: 'campana', id: idNuevo, nombre: limpiarTexto(a.nombre, 100) } };
    },
  },
];

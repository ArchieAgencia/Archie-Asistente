import { z } from 'zod';
import type { ClienteSend } from './send.js';
import type { ResolutorTiendas } from './tiendas/herramientas.js';
import type { ResolutorPauta } from './pauta/herramientas.js';
import type { ResolutorSuite } from './suite/herramientas.js';
import { HERRAMIENTAS_BORRADORES } from './send-borradores.js';
import { HERRAMIENTAS_CONFIRMACION, type PropuestaCreada } from './send-confirmaciones.js';

/** Herramientas de LECTURA de Archie Send (nivel 1: automáticas). Ninguna escribe nada. */

export interface ContextoHerramienta { send: ClienteSend; contactosRestantes: number; /** Tiendas conectadas (si hay). */ tiendas?: ResolutorTiendas; /** Cuentas de pauta (si hay). */ pauta?: ResolutorPauta; /** Talk, Meet y Booking conectados (si hay). */ suite?: ResolutorSuite }
export interface AccionCreada { tipo: 'lista' | 'segmento' | 'campana'; id: number; nombre: string }
export interface ResultadoHerramienta { datos: unknown; contactos?: number; accion?: AccionCreada; propuesta?: PropuestaCreada }
export interface Herramienta {
  /** 1 = lectura automática (por defecto). 2 = crea un borrador reversible. 3 = solo PROPONE; ejecuta una persona con una tarjeta. */
  nivel?: 1 | 2 | 3;
  nombre: string;
  descripcion: string;
  schema: Record<string, unknown>; // JSON Schema que ve el modelo
  entrada: z.ZodType<Record<string, unknown>>; // lo que realmente se acepta (el modelo puede equivocarse)
  ejecutar(c: ContextoHerramienta, a: any): Promise<ResultadoHerramienta>;
}

export const MAX_FILAS = 20;
export const MAX_CONTACTOS_POR_CONVERSACION = 100;

// ---- Limpieza de lo que viene de terceros (nombres, asuntos, textos de errores) ----
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export const limpiarTexto = (s: string, max = 200) => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export const enmascarar = (email: string): string => {
  const [u, d] = email.split('@');
  return u && d ? `${limpiarTexto(u, 1)}***@${limpiarTexto(d, 100)}` : '***';
};

const txt = (v: unknown, max = 200): string | null => (typeof v === 'string' ? limpiarTexto(v, max) : null);
const entero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const objeto = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const resultados = (v: unknown): { filas: unknown[]; total: number | null } => {
  const o = objeto(v);
  return { filas: lista(o.results ?? v).slice(0, MAX_FILAS), total: entero(o.total) };
};

const porPagina = z.number().int().min(1).max(MAX_FILAS).default(10);
const pagina = z.number().int().min(1).max(50).default(1);
const consulta = z.string().trim().max(100).optional();

const sinId = { type: 'integer', minimum: 1 };

function campana(c: unknown) {
  const o = objeto(c);
  return {
    id: entero(o.id), nombre: txt(o.name), asunto: txt(o.subject), estado: txt(o.status), programada_para: txt(o.send_at, 40),
    creada: txt(o.created_at, 40), iniciada: txt(o.started_at, 40),
    por_enviar: entero(o.to_send), enviados: entero(o.sent), vistas: entero(o.views), clics: entero(o.clicks), rebotes: entero(o.bounces),
    listas: lista(o.lists).slice(0, 10).map((l) => ({ id: entero(objeto(l).id ?? objeto(l).list_id), nombre: txt(objeto(l).name) })),
  };
}

export const HERRAMIENTAS_SEND: Herramienta[] = [
  {
    nombre: 'send_listas',
    descripcion: 'Lista las listas de contactos de Archie Send con su cantidad de contactos por estado. Solo lectura.',
    schema: { type: 'object', properties: { buscar: { type: 'string', maxLength: 100 }, por_pagina: { type: 'integer', minimum: 1, maximum: MAX_FILAS }, pagina: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    entrada: z.object({ buscar: consulta, por_pagina: porPagina, pagina }).strict(),
    async ejecutar(c, a) {
      const r = resultados(await c.send.get('/api/lists', { query: a.buscar, per_page: a.por_pagina, page: a.pagina }));
      return { datos: { total: r.total, listas: r.filas.map((l) => { const o = objeto(l); return { id: entero(o.id), nombre: txt(o.name), tipo: txt(o.type, 20), doble_confirmacion: txt(o.optin, 20), estado: txt(o.status, 20), contactos: entero(o.subscriber_count), contactos_por_estado: objeto(o.subscriber_statuses) }; }) } };
    },
  },
  {
    nombre: 'send_campanas',
    descripcion: 'Lista campañas de Archie Send (las más recientes primero) con su estado y estadísticas. Se puede filtrar por estado. Solo lectura.',
    schema: { type: 'object', properties: { estado: { type: 'string', enum: ['draft', 'scheduled', 'running', 'paused', 'cancelled', 'finished'] }, buscar: { type: 'string', maxLength: 100 }, por_pagina: { type: 'integer', minimum: 1, maximum: MAX_FILAS }, pagina: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    entrada: z.object({ estado: z.enum(['draft', 'scheduled', 'running', 'paused', 'cancelled', 'finished']).optional(), buscar: consulta, por_pagina: porPagina, pagina }).strict(),
    async ejecutar(c, a) {
      const r = resultados(await c.send.get('/api/campaigns', { status: a.estado, query: a.buscar, per_page: a.por_pagina, page: a.pagina, no_body: 'true', order_by: 'created_at', order: 'desc' }));
      return { datos: { total: r.total, campanas: r.filas.map(campana) } };
    },
  },
  {
    nombre: 'send_campana',
    descripcion: 'Detalle de una campaña de Archie Send por su id: estado, asunto, listas, estadísticas. No incluye el contenido del correo. Solo lectura.',
    schema: { type: 'object', properties: { id: sinId }, required: ['id'], additionalProperties: false },
    entrada: z.object({ id: z.number().int().min(1).max(2_000_000_000) }).strict(),
    async ejecutar(c, a) {
      const o = objeto(await c.send.get(`/api/campaigns/${a.id}`));
      const seg = objeto(o.segment);
      return { datos: { ...campana(o), remitente: txt(o.from_email), etiquetas: lista(o.tags).slice(0, 10).map((t) => txt(t, 40)), tipo_contenido: txt(o.content_type, 20), segmento: seg.name ? { nombre: txt(seg.name), estado: txt(seg.status, 20) } : null } };
    },
  },
  {
    nombre: 'send_campanas_en_curso',
    descripcion: 'Progreso de las campañas que se están enviando ahora mismo en Archie Send (enviados, por enviar, velocidad). Solo lectura.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    entrada: z.object({}).strict(),
    async ejecutar(c) {
      const filas = lista(await c.send.get('/api/campaigns/running/stats')).slice(0, MAX_FILAS);
      return { datos: { en_curso: filas.map((f) => { const o = objeto(f); return { id: entero(o.id), estado: txt(o.status, 20), enviados: entero(o.sent), por_enviar: entero(o.to_send), iniciada: txt(o.started_at, 40), correos_por_minuto_ahora: entero(o.rate), correos_por_minuto_promedio: entero(o.net_rate) }; }) } };
    },
  },
  {
    nombre: 'send_segmentos',
    descripcion: 'Lista los segmentos guardados de Archie Send (grupos de contactos por reglas). Solo lectura.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    entrada: z.object({}).strict(),
    async ejecutar(c) {
      const filas = lista(await c.send.get('/api/segments')).slice(0, MAX_FILAS);
      return { datos: { segmentos: filas.map((f) => { const o = objeto(f); return { id: entero(o.id), nombre: txt(o.name), reglas: txt(JSON.stringify(o.filter ?? null), 600), actualizado: txt(o.updated_at, 40) }; }) } };
    },
  },
  {
    nombre: 'send_creditos',
    descripcion: 'Saldo de créditos de envío de Archie Send, vencimiento, topes del plan y los últimos movimientos. Solo lectura.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    entrada: z.object({}).strict(),
    async ejecutar(c) {
      const o = objeto(await c.send.get('/api/credits'));
      const st = objeto(o.status);
      return { datos: {
        ilimitado: st.unlimited === true, saldo: entero(st.balance), paquete_total: entero(st.package_total), vence: txt(st.expires_at, 40), vencido: st.expired === true,
        topes: lista(o.quotas).slice(0, 10).map((q) => { const x = objeto(q); return { recurso: txt(x.resource, 30), limite: entero(x.limit), usado: entero(x.used), ilimitado: x.unlimited === true }; }),
        ultimos_movimientos: lista(o.movements).slice(0, 10).map((m) => { const x = objeto(m); return { tipo: txt(x.kind, 30), cantidad: entero(x.amount), saldo_despues: entero(x.balance_after), nota: txt(x.note, 120), fecha: txt(x.created_at, 40) }; }),
      } };
    },
  },
  {
    nombre: 'send_errores_envio',
    descripcion: 'Errores recientes de envío de Archie Send (últimos 30 días) con un mensaje claro de qué pasó y resumen por tipo. Se puede filtrar por origen o campaña. Solo lectura.',
    schema: { type: 'object', properties: { origen: { type: 'string', enum: ['campaign', 'optin', 'tx'] }, campana_id: sinId, por_pagina: { type: 'integer', minimum: 1, maximum: MAX_FILAS } }, additionalProperties: false },
    entrada: z.object({ origen: z.enum(['campaign', 'optin', 'tx']).optional(), campana_id: z.number().int().min(1).max(2_000_000_000).optional(), por_pagina: porPagina }).strict(),
    async ejecutar(c, a) {
      const o = objeto(await c.send.get('/api/send-errors', { source: a.origen, campaign_id: a.campana_id, per_page: a.por_pagina }));
      return { datos: {
        dias_de_historial: entero(o.retention_days),
        resumen: lista(o.counts).slice(0, 20).map((x) => { const q = objeto(x); return { codigo: txt(q.code, 40), cantidad: entero(q.n), mensaje: txt(q.message, 300) }; }),
        errores: lista(o.results).slice(0, MAX_FILAS).map((e) => { const q = objeto(e); return { fecha: txt(q.at, 40), origen: txt(q.source, 20), campana_id: entero(q.campaign_id), destinatario: typeof q.recipient === 'string' ? enmascarar(q.recipient) : null, codigo: txt(q.code, 40), mensaje: txt(q.message, 300) }; }),
      } };
    },
  },
  {
    nombre: 'send_contactos',
    descripcion: `Busca contactos en Archie Send (máximo ${MAX_FILAS} por llamada). Los correos salen parcialmente ocultos. Solo lectura.`,
    schema: { type: 'object', properties: { buscar: { type: 'string', maxLength: 100 }, lista_id: sinId, estado_suscripcion: { type: 'string', enum: ['unconfirmed', 'confirmed', 'unsubscribed'] }, por_pagina: { type: 'integer', minimum: 1, maximum: MAX_FILAS } }, additionalProperties: false },
    entrada: z.object({ buscar: consulta, lista_id: z.number().int().min(1).max(2_000_000_000).optional(), estado_suscripcion: z.enum(['unconfirmed', 'confirmed', 'unsubscribed']).optional(), por_pagina: porPagina }).strict(),
    async ejecutar(c, a) {
      if (c.contactosRestantes <= 0) throw new Error('tope_contactos');
      const tope = Math.min(a.por_pagina as number, c.contactosRestantes);
      const r = resultados(await c.send.get('/api/subscribers', { search: a.buscar, list_id: a.lista_id, subscription_status: a.estado_suscripcion, per_page: tope }));
      const filas = r.filas.slice(0, tope);
      return { contactos: filas.length, datos: { total_que_coinciden: r.total, mostrados: filas.length, contactos: filas.map((s) => { const o = objeto(s); return {
        id: entero(o.id), nombre: txt(o.name, 80), correo: typeof o.email === 'string' ? enmascarar(o.email) : null, estado: txt(o.status, 20),
        listas: lista(o.lists).slice(0, 10).map((l) => ({ id: entero(objeto(l).id), nombre: txt(objeto(l).name), estado_suscripcion: txt(objeto(l).subscription_status, 20) })),
      }; }) } };
    },
  },
];

export interface OpcionesCatalogo { contactos: boolean; borradores?: boolean; confirmacion?: boolean }
export const catalogoSend = (o: OpcionesCatalogo): Herramienta[] => [
  ...HERRAMIENTAS_SEND.filter((h) => o.contactos || h.nombre !== 'send_contactos'),
  ...(o.borradores ? HERRAMIENTAS_BORRADORES : []),
  ...(o.confirmacion ? HERRAMIENTAS_CONFIRMACION : []),
];

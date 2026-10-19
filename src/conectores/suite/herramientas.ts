import { z } from 'zod';
import type { ContextoHerramienta, Herramienta } from '../send-herramientas.js';
import { periodoAnterior, periodoFechas, variacionPct } from '../pauta/herramientas.js';
import { PERIODOS } from '../tiendas/herramientas.js';
import { ID_SUITE } from './adaptador.js';
import { ESTADOS_CONVERSACION, ESTADOS_RESERVA, ESTADOS_REUNION, ErrorSuite, type AdaptadorSuite, type ProductoSuite } from './tipos.js';

/** Herramientas de LECTURA de Archie Talk, Archie Meet y Archie Booking (nivel 1). Solo datos de gestión, nunca datos de personas. */

export interface ResolutorSuite {
  productos(): ProductoSuite[];
  /** Lanza ErrorSuite('no_conectada') si ese producto no está conectado. */
  obtener(producto: ProductoSuite): Promise<AdaptadorSuite>;
}

const MAX_FILAS = 20;
const MAX_DIAS_DISPONIBILIDAD = 14;
const DIA = 86_400_000;
const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const esquemaPeriodo = {
  periodo: { type: 'string', enum: [...PERIODOS] },
  desde: { type: 'string', description: 'AAAA-MM-DD, solo con periodo personalizado' },
  hasta: { type: 'string', description: 'AAAA-MM-DD, solo con periodo personalizado' },
};
const entradaPeriodo = { periodo: z.enum(PERIODOS).default('7_dias'), desde: FECHA.optional(), hasta: FECHA.optional() };
const limiteSchema = { type: 'integer', minimum: 1, maximum: MAX_FILAS };
const limiteZod = z.number().int().min(1).max(MAX_FILAS).default(10);
const idArg = z.string().trim().regex(ID_SUITE);
const AVISO = 'Las fechas siguen la zona horaria de la herramienta conectada.';

type Contexto = Pick<ContextoHerramienta, 'suite'>;
const sinConectar = (nombre: string) => ({ datos: { error: 'sin_conectar', mensaje: `${nombre} no está conectado.` } });
async function con(c: Contexto, p: ProductoSuite): Promise<AdaptadorSuite | null> {
  if (!c.suite || !c.suite.productos().includes(p)) return null;
  return c.suite.obtener(p);
}
const periodoOError = (a: { periodo: (typeof PERIODOS)[number]; desde?: string; hasta?: string }) =>
  periodoFechas(a) ?? { aviso: { error: 'periodo_invalido', mensaje: 'Con periodo personalizado indica "desde" y "hasta" (AAAA-MM-DD, máximo 366 días, desde antes que hasta).' } };
const NOMBRES: Record<ProductoSuite, string> = { talk: 'Archie Talk', meet: 'Archie Meet', booking: 'Archie Booking' };

function def(producto: ProductoSuite, h: Omit<Herramienta, 'ejecutar'> & { ejecutar: (a: AdaptadorSuite, args: any) => Promise<unknown> }): Herramienta & { producto: ProductoSuite } {
  const { ejecutar, ...resto } = h;
  return {
    ...resto, producto,
    async ejecutar(c: Contexto, a) {
      const ad = await con(c, producto); if (!ad) return sinConectar(NOMBRES[producto]);
      return { datos: await ejecutar(ad, a) };
    },
  };
}

export const HERRAMIENTAS_SUITE: (Herramienta & { producto: ProductoSuite })[] = [
  // ---------------- Archie Booking ----------------
  def('booking', {
    nombre: 'booking_tipos', descripcion: 'Lista los tipos de cita de Archie Booking (nombre, duración, precio y si está activo). Solo lectura.',
    schema: { type: 'object', properties: {}, additionalProperties: false }, entrada: z.object({}).strict(),
    ejecutar: async (ad) => ({ tipos: await ad.tiposDeCita() }),
  }),
  def('booking', {
    nombre: 'booking_disponibilidad', descripcion: 'Espacios libres de un tipo de cita en un rango de fechas (máximo 14 días). Usa primero booking_tipos para conocer el id. Solo lectura: no reserva nada.',
    schema: { type: 'object', properties: { tipo: { type: 'string', maxLength: 200, description: 'id del tipo de cita' }, desde: { type: 'string', description: 'AAAA-MM-DD' }, hasta: { type: 'string', description: 'AAAA-MM-DD' } }, required: ['tipo', 'desde', 'hasta'], additionalProperties: false },
    entrada: z.object({ tipo: idArg, desde: FECHA, hasta: FECHA }).strict(),
    ejecutar: async (ad, a: { tipo: string; desde: string; hasta: string }) => {
      const dias = (Date.parse(`${a.hasta}T00:00:00Z`) - Date.parse(`${a.desde}T00:00:00Z`)) / DIA;
      if (!Number.isFinite(dias) || dias < 0 || dias + 1 > MAX_DIAS_DISPONIBILIDAD) return { error: 'rango_invalido', mensaje: `Indica un rango válido de máximo ${MAX_DIAS_DISPONIBILIDAD} días (desde antes que hasta).` };
      const r = await ad.disponibilidad(a.tipo, { desde: a.desde, hasta: a.hasta });
      return { tipo: a.tipo, desde: a.desde, hasta: a.hasta, ...r, aviso: AVISO };
    },
  }),
  def('booking', {
    nombre: 'booking_reservas', descripcion: 'Reservas de Archie Booking en un periodo: fecha, tipo de cita, estado y si está pagada. NO incluye datos de quien reservó. Máximo 20 filas. Solo lectura.',
    schema: { type: 'object', properties: { ...esquemaPeriodo, estado: { type: 'string', enum: ESTADOS_RESERVA }, limite: limiteSchema }, additionalProperties: false },
    entrada: z.object({ ...entradaPeriodo, estado: z.enum(ESTADOS_RESERVA as [string, ...string[]]).optional(), limite: limiteZod }).strict(),
    ejecutar: async (ad, a) => {
      const p = periodoOError(a); if ('aviso' in p) return p.aviso;
      const r = await ad.reservas({ periodo: p.fechas, estado: a.estado, limite: a.limite });
      return { periodo: p.etiqueta, fechas: p.fechas, truncado: r.truncado, total: r.total, reservas: r.items, aviso: AVISO };
    },
  }),
  def('booking', {
    nombre: 'booking_resumen', descripcion: 'Resumen de Archie Booking en un periodo: total de reservas, por estado e ingresos, y comparación con el periodo anterior. Solo lectura.',
    schema: { type: 'object', properties: { ...esquemaPeriodo }, additionalProperties: false },
    entrada: z.object({ ...entradaPeriodo }).strict(),
    ejecutar: async (ad, a) => {
      const p = periodoOError(a); if ('aviso' in p) return p.aviso;
      const previo = periodoAnterior(p.fechas);
      const [actual, anterior] = [await ad.resumenBooking(p.fechas), await ad.resumenBooking(previo)];
      return { periodo: p.etiqueta, fechas: p.fechas, periodo_anterior: previo, actual, anterior, variacion_total_pct: variacionPct(actual.total, anterior.total), aviso: AVISO };
    },
  }),

  // ---------------- Archie Talk ----------------
  def('talk', {
    nombre: 'talk_metricas', descripcion: 'Métricas de atención de Archie Talk en un periodo: conversaciones por canal y estado, sin asignar, mediana de primera respuesta y de resolución (en segundos), y comparación con el periodo anterior. Solo lectura.',
    schema: { type: 'object', properties: { ...esquemaPeriodo }, additionalProperties: false },
    entrada: z.object({ ...entradaPeriodo }).strict(),
    ejecutar: async (ad, a) => {
      const p = periodoOError(a); if ('aviso' in p) return p.aviso;
      const previo = periodoAnterior(p.fechas);
      const [actual, anterior] = [await ad.metricasTalk(p.fechas), await ad.metricasTalk(previo)];
      return { periodo: p.etiqueta, fechas: p.fechas, periodo_anterior: previo, actual, anterior, variacion_total_pct: variacionPct(actual.total, anterior.total), aviso: AVISO };
    },
  }),
  def('talk', {
    nombre: 'talk_conversaciones', descripcion: 'Conversaciones de Archie Talk en un periodo: canal, estado, quién las atiende, fechas, cantidad de mensajes y etiquetas. NO incluye el contenido de los mensajes ni datos de quien escribió. Máximo 20 filas. Solo lectura.',
    schema: { type: 'object', properties: { ...esquemaPeriodo, estado: { type: 'string', enum: ESTADOS_CONVERSACION }, canal: { type: 'string', maxLength: 40 }, limite: limiteSchema }, additionalProperties: false },
    entrada: z.object({ ...entradaPeriodo, estado: z.enum(ESTADOS_CONVERSACION as [string, ...string[]]).optional(), canal: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(), limite: limiteZod }).strict(),
    ejecutar: async (ad, a) => {
      const p = periodoOError(a); if ('aviso' in p) return p.aviso;
      const r = await ad.conversaciones({ periodo: p.fechas, estado: a.estado, canal: a.canal, limite: a.limite });
      return { periodo: p.etiqueta, fechas: p.fechas, truncado: r.truncado, total: r.total, conversaciones: r.items, aviso: AVISO };
    },
  }),
  def('talk', {
    nombre: 'talk_embudo', descripcion: 'Embudo de ventas del CRM de Archie Talk: etapas con cantidad de tratos y valor. Solo lectura.',
    schema: { type: 'object', properties: {}, additionalProperties: false }, entrada: z.object({}).strict(),
    ejecutar: async (ad) => ({ etapas: await ad.embudo() }),
  }),
  def('talk', {
    nombre: 'talk_tratos', descripcion: 'Tratos del CRM de Archie Talk (título, etapa, valor y fechas), opcionalmente de una etapa. NO incluye datos de contactos. Máximo 20 filas. Solo lectura.',
    schema: { type: 'object', properties: { etapa: { type: 'string', maxLength: 200, description: 'id de la etapa (de talk_embudo)' }, limite: limiteSchema }, additionalProperties: false },
    entrada: z.object({ etapa: idArg.optional(), limite: limiteZod }).strict(),
    ejecutar: async (ad, a) => { const r = await ad.tratos({ etapa: a.etapa, limite: a.limite }); return { truncado: r.truncado, total: r.total, tratos: r.items }; },
  }),

  // ---------------- Archie Meet ----------------
  def('meet', {
    nombre: 'meet_reuniones', descripcion: 'Reuniones de Archie Meet en un periodo: título, fecha, duración, estado, cantidad de participantes y si se grabó. NO incluye nombres ni correos de participantes ni el contenido. Máximo 20 filas. Solo lectura.',
    schema: { type: 'object', properties: { ...esquemaPeriodo, estado: { type: 'string', enum: ESTADOS_REUNION }, limite: limiteSchema }, additionalProperties: false },
    entrada: z.object({ ...entradaPeriodo, estado: z.enum(ESTADOS_REUNION as [string, ...string[]]).optional(), limite: limiteZod }).strict(),
    ejecutar: async (ad, a) => {
      const p = periodoOError(a); if ('aviso' in p) return p.aviso;
      const r = await ad.reuniones({ periodo: p.fechas, estado: a.estado, limite: a.limite });
      return { periodo: p.etiqueta, fechas: p.fechas, truncado: r.truncado, total: r.total, reuniones: r.items, aviso: AVISO };
    },
  }),
  def('meet', {
    nombre: 'meet_uso', descripcion: 'Uso de Archie Meet en un periodo: reuniones, minutos, grabaciones y participantes promedio, comparado con el periodo anterior. Solo lectura.',
    schema: { type: 'object', properties: { ...esquemaPeriodo }, additionalProperties: false },
    entrada: z.object({ ...entradaPeriodo }).strict(),
    ejecutar: async (ad, a) => {
      const p = periodoOError(a); if ('aviso' in p) return p.aviso;
      const previo = periodoAnterior(p.fechas);
      const [actual, anterior] = [await ad.usoMeet(p.fechas), await ad.usoMeet(previo)];
      return { periodo: p.etiqueta, fechas: p.fechas, periodo_anterior: previo, actual, anterior, variacion_minutos_pct: variacionPct(actual.minutos, anterior.minutos), aviso: AVISO };
    },
  }),
];

/** Solo se ofrecen al modelo las herramientas de los productos conectados. */
export const herramientasSuiteDe = (productos: ProductoSuite[]): Herramienta[] => HERRAMIENTAS_SUITE.filter((h) => productos.includes(h.producto));
export { ErrorSuite };

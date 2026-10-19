import { z } from 'zod';
import type { ContextoHerramienta, Herramienta } from '../send-herramientas.js';
import { ESTADOS_COMUNES, ESTADOS_DE_VENTA, sumarDinero, type AdaptadorTienda, type Dinero, type EstadoComun, type Plataforma } from './tipos.js';

/** Herramientas de LECTURA de tiendas (nivel 1). Iguales para WooCommerce, Shopify y VTEX. Sin datos personales de compradores. */

export interface TiendaElegida { nombre: string; plataforma: Plataforma; adaptador: AdaptadorTienda }
export interface ResolutorTiendas {
  listar(): { nombre: string; plataforma: Plataforma }[];
  /** Lanza ErrorTienda('no_conectada') si no existe. */
  obtener(nombre: string): Promise<TiendaElegida>;
}

const MAX_FILAS = 20;
const TOPE_PEDIDOS_RESUMEN = 250;
const DIA = 86_400_000;
const OFFSET_BOGOTA = 5 * 3_600_000; // Colombia: UTC-5 todo el año

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nombreTienda = z.string().trim().min(1).max(60).optional();
export const PERIODOS = ['hoy', 'ayer', '7_dias', '30_dias', 'mes_actual', 'mes_anterior', 'personalizado'] as const;

const esFechaReal = (s: string): boolean => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); };
/** Medianoche de Bogotá de la fecha dada, como instante UTC. */
const inicioBogota = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m, d) + OFFSET_BOGOTA);

export interface Rango { desde: Date; hasta: Date; etiqueta: string }
/** Calcula el periodo en hora de Bogotá. `hasta` es exclusivo en la práctica (instante final). Devuelve null si los datos no sirven. */
export function rangoPeriodo(periodo: (typeof PERIODOS)[number], ahora: Date, desde?: string, hasta?: string): Rango | null {
  const b = new Date(ahora.getTime() - OFFSET_BOGOTA); // reloj de Bogotá leído en UTC
  const y = b.getUTCFullYear(); const m = b.getUTCMonth(); const d = b.getUTCDate();
  const hoy = inicioBogota(y, m, d);
  switch (periodo) {
    case 'hoy': return { desde: hoy, hasta: ahora, etiqueta: 'hoy' };
    case 'ayer': return { desde: new Date(hoy.getTime() - DIA), hasta: new Date(hoy.getTime() - 1), etiqueta: 'ayer' };
    case '7_dias': return { desde: new Date(hoy.getTime() - 6 * DIA), hasta: ahora, etiqueta: 'últimos 7 días (incluido hoy)' };
    case '30_dias': return { desde: new Date(hoy.getTime() - 29 * DIA), hasta: ahora, etiqueta: 'últimos 30 días (incluido hoy)' };
    case 'mes_actual': return { desde: inicioBogota(y, m, 1), hasta: ahora, etiqueta: 'mes actual' };
    case 'mes_anterior': return { desde: inicioBogota(y, m - 1, 1), hasta: new Date(inicioBogota(y, m, 1).getTime() - 1), etiqueta: 'mes anterior' };
    case 'personalizado': {
      if (!desde || !hasta || !esFechaReal(desde) || !esFechaReal(hasta)) return null;
      const [y1, m1, d1] = desde.split('-').map(Number) as [number, number, number];
      const [y2, m2, d2] = hasta.split('-').map(Number) as [number, number, number];
      const a = inicioBogota(y1, m1 - 1, d1); const z = new Date(inicioBogota(y2, m2 - 1, d2).getTime() + DIA - 1);
      if (z.getTime() < a.getTime() || z.getTime() - a.getTime() > 366 * DIA) return null;
      return { desde: a, hasta: z, etiqueta: `${desde} a ${hasta}` };
    }
  }
}

/** Promedio exacto a 2 decimales (redondeo hacia el más cercano) de un monto entre n. */
export function promedioDinero(d: Dinero, n: number): Dinero | null {
  if (n <= 0) return null;
  const neg = d.monto.startsWith('-');
  const [e, f = ''] = d.monto.replace('-', '').split('.');
  const centesimas = BigInt(e! + f.padEnd(6, '0')) / 10_000n; // 6 decimales -> 2 (trunca; el resto se pierde antes de dividir)
  const medio = (centesimas * 2n + BigInt(n)) / (BigInt(n) * 2n);
  const s = medio.toString().padStart(3, '0');
  return { moneda: d.moneda, monto: `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}` };
}

const esquemaTienda = { type: 'string', maxLength: 60, description: 'Nombre de la tienda conectada. Opcional si solo hay una.' };
const esquemaPeriodo = {
  periodo: { type: 'string', enum: [...PERIODOS] },
  desde: { type: 'string', description: 'AAAA-MM-DD, solo con periodo personalizado (hora de Bogotá)' },
  hasta: { type: 'string', description: 'AAAA-MM-DD, solo con periodo personalizado (hora de Bogotá)' },
};
const entradaPeriodo = { periodo: z.enum(PERIODOS).default('7_dias'), desde: FECHA.optional(), hasta: FECHA.optional() };
const limite = z.number().int().min(1).max(MAX_FILAS).default(10);

type Contexto = Pick<ContextoHerramienta, 'tiendas'>;
const AYUDA_ELEGIR = 'Hay varias tiendas conectadas: indica cuál usar con el argumento "tienda".';

/** Resuelve la tienda del argumento; sin argumento solo si hay una. Devuelve datos de aviso si no se puede elegir. */
async function elegir(c: Contexto, nombre: string | undefined): Promise<{ t: TiendaElegida } | { aviso: unknown }> {
  const r = c.tiendas;
  if (!r) return { aviso: { error: 'sin_tiendas', mensaje: 'No hay tiendas conectadas.' } };
  const lista = r.listar();
  if (lista.length === 0) return { aviso: { error: 'sin_tiendas', mensaje: 'No hay tiendas conectadas.' } };
  if (!nombre) {
    if (lista.length > 1) return { aviso: { error: 'indica_tienda', mensaje: AYUDA_ELEGIR, tiendas: lista } };
    return { t: await r.obtener(lista[0]!.nombre) };
  }
  return { t: await r.obtener(nombre) };
}

const marca = (t: TiendaElegida) => ({ tienda: t.nombre, plataforma: t.plataforma });

function rangoOError(a: { periodo: (typeof PERIODOS)[number]; desde?: string; hasta?: string }): Rango | { aviso: unknown } {
  const r = rangoPeriodo(a.periodo, new Date(), a.desde, a.hasta);
  return r ?? { aviso: { error: 'periodo_invalido', mensaje: 'Con periodo personalizado indica "desde" y "hasta" (AAAA-MM-DD, máximo 366 días, desde antes que hasta).' } };
}

export const HERRAMIENTAS_TIENDA: Herramienta[] = [
  {
    nombre: 'tiendas_conectadas',
    descripcion: 'Lista las tiendas en línea conectadas (nombre y plataforma). Solo lectura.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    entrada: z.object({}).strict(),
    async ejecutar(c: Contexto) { return { datos: { tiendas: c.tiendas?.listar() ?? [] } }; },
  },
  {
    nombre: 'tienda_resumen_ventas',
    descripcion: 'Resumen de ventas de una tienda en un periodo (hora de Bogotá): pedidos pagados o completados, total vendido por moneda y ticket promedio. Solo lectura, sin datos de compradores.',
    schema: { type: 'object', properties: { tienda: esquemaTienda, ...esquemaPeriodo }, additionalProperties: false },
    entrada: z.object({ tienda: nombreTienda, ...entradaPeriodo }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.tienda); if ('aviso' in e) return { datos: e.aviso };
      const r = rangoOError(a); if ('aviso' in r) return { datos: r.aviso };
      const res = await e.t.adaptador.pedidos({ desde: r.desde, hasta: r.hasta, estados: ESTADOS_DE_VENTA }, TOPE_PEDIDOS_RESUMEN, false);
      const ventas = sumarDinero(res.pedidos.map((p) => p.total));
      return { datos: { ...marca(e.t), periodo: r.etiqueta, pedidos_contados: res.pedidos.length, truncado: res.truncado,
        aviso: res.truncado ? `Hay más de ${TOPE_PEDIDOS_RESUMEN} pedidos en el periodo: las cifras son parciales (los más recientes).` : undefined,
        ventas_por_moneda: ventas.map((v) => ({ ...v, ticket_promedio: promedioDinero(v, res.pedidos.filter((p) => p.total.moneda === v.moneda).length) })),
        criterio: 'Cuenta pedidos en estado pagado o completado.' } };
    },
  },
  {
    nombre: 'tienda_pedidos',
    descripcion: 'Lista pedidos recientes de una tienda (número, estado, fecha, total, cantidad de artículos). Sin nombres, correos, teléfonos ni direcciones. Solo lectura.',
    schema: { type: 'object', properties: { tienda: esquemaTienda, estado: { type: 'string', enum: ESTADOS_COMUNES }, ...esquemaPeriodo, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS } }, additionalProperties: false },
    entrada: z.object({ tienda: nombreTienda, estado: z.enum(ESTADOS_COMUNES as [EstadoComun, ...EstadoComun[]]).optional(), ...entradaPeriodo, limite }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.tienda); if ('aviso' in e) return { datos: e.aviso };
      const r = rangoOError(a); if ('aviso' in r) return { datos: r.aviso };
      const res = await e.t.adaptador.pedidos({ desde: r.desde, hasta: r.hasta, estados: a.estado ? [a.estado] : undefined }, a.limite, false);
      return { datos: { ...marca(e.t), periodo: r.etiqueta, total: res.total, truncado: res.truncado, pedidos: res.pedidos } };
    },
  },
  {
    nombre: 'tienda_pedido',
    descripcion: 'Detalle de un pedido por su id interno (el campo "id" de tienda_pedidos): productos, totales, envío, descuento, impuestos y método de pago. Sin datos del comprador. Solo lectura.',
    schema: { type: 'object', properties: { tienda: esquemaTienda, id: { type: 'string', maxLength: 200 } }, required: ['id'], additionalProperties: false },
    entrada: z.object({ tienda: nombreTienda, id: z.string().trim().min(1).max(200) }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.tienda); if ('aviso' in e) return { datos: e.aviso };
      return { datos: { ...marca(e.t), pedido: await e.t.adaptador.pedido(a.id) } };
    },
  },
  {
    nombre: 'tienda_productos',
    descripcion: 'Busca o lista productos de una tienda con precio, estado y stock. Solo lectura.',
    schema: { type: 'object', properties: { tienda: esquemaTienda, buscar: { type: 'string', maxLength: 100 }, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS } }, additionalProperties: false },
    entrada: z.object({ tienda: nombreTienda, buscar: z.string().trim().max(100).optional(), limite }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.tienda); if ('aviso' in e) return { datos: e.aviso };
      const r = await e.t.adaptador.productos({ buscar: a.buscar || undefined, limite: a.limite });
      return { datos: { ...marca(e.t), total: r.total, productos: r.productos } };
    },
  },
  {
    nombre: 'tienda_producto',
    descripcion: 'Detalle de un producto por su id interno (el campo "id" de tienda_productos). Solo lectura.',
    schema: { type: 'object', properties: { tienda: esquemaTienda, id: { type: 'string', maxLength: 200 } }, required: ['id'], additionalProperties: false },
    entrada: z.object({ tienda: nombreTienda, id: z.string().trim().min(1).max(200) }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.tienda); if ('aviso' in e) return { datos: e.aviso };
      return { datos: { ...marca(e.t), producto: await e.t.adaptador.producto(a.id) } };
    },
  },
  {
    nombre: 'tienda_stock_bajo',
    descripcion: 'Productos agotados o con stock igual o menor al umbral (por defecto 5). No disponible en todas las plataformas. Solo lectura.',
    schema: { type: 'object', properties: { tienda: esquemaTienda, umbral: { type: 'integer', minimum: 0, maximum: 1000 }, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS } }, additionalProperties: false },
    entrada: z.object({ tienda: nombreTienda, umbral: z.number().int().min(0).max(1000).default(5), limite }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.tienda); if ('aviso' in e) return { datos: e.aviso };
      const r = await e.t.adaptador.stockBajo({ umbral: a.umbral, limite: a.limite });
      return { datos: { ...marca(e.t), umbral: a.umbral, truncado: r.truncado, productos: r.productos } };
    },
  },
  {
    nombre: 'tienda_mas_vendidos',
    descripcion: 'Productos más vendidos en un periodo (hora de Bogotá), por unidades, calculado desde pedidos pagados o completados. No disponible en todas las plataformas. Solo lectura.',
    schema: { type: 'object', properties: { tienda: esquemaTienda, ...esquemaPeriodo, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS } }, additionalProperties: false },
    entrada: z.object({ tienda: nombreTienda, ...entradaPeriodo, limite }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.tienda); if ('aviso' in e) return { datos: e.aviso };
      const r = rangoOError(a); if ('aviso' in r) return { datos: r.aviso };
      const res = await e.t.adaptador.pedidos({ desde: r.desde, hasta: r.hasta, estados: ESTADOS_DE_VENTA }, TOPE_PEDIDOS_RESUMEN, true);
      const por = new Map<string, { productoId: string | null; nombre: string; sku: string | null; unidades: number; pedidos: number }>();
      for (const p of res.pedidos) {
        const vistos = new Set<string>();
        for (const l of p.lineas ?? []) {
          const k = l.productoId ?? `n:${l.nombre}`;
          const x = por.get(k) ?? { productoId: l.productoId, nombre: l.nombre, sku: l.sku, unidades: 0, pedidos: 0 };
          x.unidades += l.cantidad; if (!vistos.has(k)) { x.pedidos++; vistos.add(k); }
          por.set(k, x);
        }
      }
      const orden = [...por.values()].sort((x, y) => y.unidades - x.unidades).slice(0, a.limite);
      return { datos: { ...marca(e.t), periodo: r.etiqueta, pedidos_revisados: res.pedidos.length, truncado: res.truncado,
        aviso: res.truncado ? `Hay más de ${TOPE_PEDIDOS_RESUMEN} pedidos en el periodo: el ranking es parcial (los más recientes).` : undefined, productos: orden } };
    },
  },
  {
    nombre: 'tienda_cupones',
    descripcion: 'Cupones de descuento de una tienda con uso, límite y vencimiento. No disponible en todas las plataformas. Solo lectura.',
    schema: { type: 'object', properties: { tienda: esquemaTienda, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS } }, additionalProperties: false },
    entrada: z.object({ tienda: nombreTienda, limite }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.tienda); if ('aviso' in e) return { datos: e.aviso };
      return { datos: { ...marca(e.t), cupones: await e.t.adaptador.cupones({ limite: a.limite }) } };
    },
  },
];

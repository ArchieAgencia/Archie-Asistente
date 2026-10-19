/**
 * Formato común de tiendas en línea (WooCommerce, Shopify, VTEX).
 * Regla de privacidad: este formato NO tiene campos para nombre, correo, teléfono ni dirección de compradores;
 * por eso ningún adaptador puede devolverlos aunque la API de la tienda los entregue.
 */

export type Plataforma = 'woocommerce' | 'shopify' | 'vtex';
export const PLATAFORMAS: Plataforma[] = ['woocommerce', 'shopify', 'vtex'];

export type CodigoTienda =
  | 'credencial_rechazada' | 'sin_permiso' | 'no_encontrado' | 'limite' | 'tiempo_agotado' | 'no_disponible'
  | 'respuesta_invalida' | 'direccion_no_permitida' | 'no_soportado' | 'periodo_fuera_de_alcance' | 'no_conectada';

export const MENSAJES_TIENDA: Record<CodigoTienda, string> = {
  credencial_rechazada: 'La tienda rechazó las credenciales conectadas. Un administrador debe revisarlas o crear unas nuevas en Conexiones.',
  sin_permiso: 'Las credenciales conectadas no tienen permiso para ver esto en la tienda.',
  no_encontrado: 'La tienda no encontró lo que se pidió.',
  limite: 'La tienda pidió esperar un momento (límite de peticiones). Inténtalo en un minuto.',
  tiempo_agotado: 'La tienda tardó demasiado en responder.',
  no_disponible: 'No se pudo conectar con la tienda en este momento.',
  respuesta_invalida: 'La tienda respondió algo que no se pudo leer.',
  direccion_no_permitida: 'La dirección de la tienda no es válida o no está permitida.',
  no_soportado: 'Esa consulta todavía no está disponible para este tipo de tienda.',
  periodo_fuera_de_alcance: 'La tienda no permite consultar pedidos de ese periodo con los permisos conectados.',
  no_conectada: 'Esa tienda no está conectada. Un administrador debe conectarla en Conexiones.',
};

export class ErrorTienda extends Error {
  constructor(readonly codigo: CodigoTienda, readonly http?: number) { super(MENSAJES_TIENDA[codigo]); }
}

/** Dinero exacto: monto como texto decimal (nunca un número de punto flotante) y moneda ISO. */
export interface Dinero { moneda: string; monto: string }

export type EstadoComun = 'pendiente' | 'pagado' | 'completado' | 'cancelado' | 'reembolsado' | 'fallido' | 'otro';
export const ESTADOS_COMUNES: EstadoComun[] = ['pendiente', 'pagado', 'completado', 'cancelado', 'reembolsado', 'fallido', 'otro'];
/** Los pedidos que cuentan como venta efectiva en los resúmenes. */
export const ESTADOS_DE_VENTA: EstadoComun[] = ['pagado', 'completado'];

export interface LineaPedido { productoId: string | null; nombre: string; sku: string | null; cantidad: number; precioUnitario: Dinero | null }
export interface PedidoResumen {
  id: string; numero: string; estado: EstadoComun; estadoOriginal: string; creado: string; total: Dinero; articulos: number;
  /** Solo cuando se pidió con líneas. */
  lineas?: LineaPedido[];
}
export interface PedidoDetalle extends PedidoResumen {
  lineas: LineaPedido[]; subtotal: Dinero | null; envio: Dinero | null; descuento: Dinero | null; impuestos: Dinero | null;
  metodoPago: string | null; metodoEnvio: string | null;
}
export interface ProductoResumen {
  id: string; nombre: string; sku: string | null; precio: Dinero | null; precioRebajado: Dinero | null;
  estado: string; /** null = no se gestiona o no se pudo saber */ stock: number | null; agotado: boolean | null;
}
export interface Cupon { codigo: string; tipo: string; valor: string; usos: number; limiteUsos: number | null; vence: string | null }

export interface FiltroPedidos { desde?: Date; hasta?: Date; estados?: EstadoComun[] }
export interface ResultadoPedidos { pedidos: PedidoResumen[]; /** true si había más de los pedidos devueltos */ truncado: boolean; total: number | null }

export interface InfoTienda { nombre: string | null; moneda: string | null }

/** Lo que cada plataforma debe saber hacer. Todo es lectura. */
export interface AdaptadorTienda {
  readonly plataforma: Plataforma;
  /** Consulta mínima para validar las credenciales al conectar. */
  probar(): Promise<InfoTienda>;
  /** Hasta `limite` pedidos, recorriendo páginas internamente. `conLineas` pide también los productos de cada pedido. */
  pedidos(filtro: FiltroPedidos, limite: number, conLineas: boolean): Promise<ResultadoPedidos>;
  pedido(id: string): Promise<PedidoDetalle>;
  productos(opc: { buscar?: string; limite: number }): Promise<{ productos: ProductoResumen[]; total: number | null }>;
  producto(id: string): Promise<ProductoResumen>;
  stockBajo(opc: { umbral: number; limite: number }): Promise<{ productos: ProductoResumen[]; truncado: boolean }>;
  cupones(opc: { limite: number }): Promise<Cupon[]>;
}

// ---------- Utilidades compartidas por los adaptadores ----------

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** Limpia texto que viene de la tienda (nombres de productos, etc.): sin caracteres de control y con largo máximo. */
export const limpiar = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : null);
export const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const ent = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
};
/** Identificadores que luego van en rutas: solo caracteres seguros. */
export const idSeguro = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v : null;
  return s !== null && /^[A-Za-z0-9._:/=-]{1,200}$/.test(s) ? s : null;
};

const MONTO = /^-?\d{1,15}(?:\.\d{1,6})?$/;
const MONEDA = /^[A-Z]{3}$/;
/** Dinero desde un texto decimal de la tienda; null si no es un monto válido (nunca se adivina). */
export function dinero(monto: unknown, moneda: unknown): Dinero | null {
  const m = typeof monto === 'number' && Number.isFinite(monto) ? String(monto) : typeof monto === 'string' ? monto.trim() : null;
  const c = typeof moneda === 'string' ? moneda.trim().toUpperCase() : null;
  if (m === null || c === null || !MONTO.test(m) || !MONEDA.test(c)) return null;
  return { monto: m, moneda: c };
}
/** Dinero desde unidades menores (centavos) con `decimales` decimales. */
export function dineroDeMenor(menor: unknown, moneda: unknown, decimales = 2): Dinero | null {
  const n = typeof menor === 'number' && Number.isSafeInteger(menor) ? menor : typeof menor === 'string' && /^-?\d{1,15}$/.test(menor) ? Number(menor) : null;
  if (n === null) return null;
  const neg = n < 0; const a = String(Math.abs(n)).padStart(decimales + 1, '0');
  const texto = decimales === 0 ? a : `${a.slice(0, -decimales)}.${a.slice(-decimales)}`;
  return dinero(`${neg ? '-' : ''}${texto}`, moneda);
}

const ESCALA = 6;
/** Suma exacta de montos de la misma moneda (enteros grandes, sin errores de redondeo). Monedas distintas se separan. */
export function sumarDinero(items: (Dinero | null)[]): Dinero[] {
  const por = new Map<string, bigint>();
  for (const d of items) {
    if (!d) continue;
    const neg = d.monto.startsWith('-');
    const [e, f = ''] = d.monto.replace('-', '').split('.');
    const v = BigInt(e! + f.padEnd(ESCALA, '0')) * (neg ? -1n : 1n);
    por.set(d.moneda, (por.get(d.moneda) ?? 0n) + v);
  }
  return [...por].map(([moneda, v]) => {
    const neg = v < 0n; const s = (neg ? -v : v).toString().padStart(ESCALA + 1, '0');
    const dec = s.slice(-ESCALA).replace(/0+$/, '');
    return { moneda, monto: `${neg ? '-' : ''}${s.slice(0, -ESCALA)}${dec ? `.${dec}` : ''}` };
  });
}

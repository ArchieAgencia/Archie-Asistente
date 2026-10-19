import type { HttpSeguro } from '../http-seguro.js';
import { nombreDeDominioValido } from '../http-seguro.js';
import { ClienteApi } from './base.js';
import {
  arr, dinero, ent, ErrorTienda, idSeguro, limpiar, obj,
  type AdaptadorTienda, type Cupon, type EstadoComun, type FiltroPedidos, type InfoTienda, type LineaPedido, type PedidoDetalle,
  type PedidoResumen, type ProductoResumen, type ResultadoPedidos,
} from './tipos.js';

export interface CredencialWoo { dominio: string; clave: string; secreto: string }
export const CLAVE_WOO = /^ck_[A-Za-z0-9]{20,80}$/;
export const SECRETO_WOO = /^cs_[A-Za-z0-9]{20,80}$/;

/** Valida lo que escribe el administrador. Devuelve el dominio normalizado (solo el nombre, sin esquema ni ruta). */
export function dominioWoo(entrada: string): string | null {
  let t = entrada.trim();
  if (/^https?:\/\//i.test(t)) {
    let u: URL;
    try { u = new URL(t); } catch { return null; }
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
    t = u.hostname;
  } else if (/[/:@?#\s]/.test(t)) return null;
  return nombreDeDominioValido(t);
}

const RUTAS = [
  /^\/wp-json\/wc\/v3\/products$/, /^\/wp-json\/wc\/v3\/products\/\d{1,12}$/, /^\/wp-json\/wc\/v3\/orders$/, /^\/wp-json\/wc\/v3\/orders\/\d{1,12}$/,
  /^\/wp-json\/wc\/v3\/coupons$/, /^\/wp-json\/wc\/v3\/data\/currencies\/current$/,
];
const BASE = '/wp-json/wc/v3';
const POR_PAGINA = 50;
/** Pide a la tienda solo los campos que usamos: así los datos del comprador (facturación, envío, notas) ni siquiera salen de la tienda.
 * `_fields` es una función estándar de la API REST de WordPress; si algún sitio la ignorara, el formato común igual no tiene dónde guardarlos. Por verificar en una tienda real. */
const CAMPOS_PEDIDO = 'id,number,status,currency,total,date_created,date_created_gmt,total_tax,shipping_total,discount_total,payment_method_title,shipping_lines,line_items';

const ESTADO_WOO: Record<string, EstadoComun> = {
  pending: 'pendiente', 'on-hold': 'pendiente', processing: 'pagado', completed: 'completado', cancelled: 'cancelado', refunded: 'reembolsado', failed: 'fallido',
};
const A_WOO: Record<EstadoComun, string[]> = {
  pendiente: ['pending', 'on-hold'], pagado: ['processing'], completado: ['completed'], cancelado: ['cancelled'], reembolsado: ['refunded'], fallido: ['failed'], otro: [],
};

export class AdaptadorWooCommerce implements AdaptadorTienda {
  readonly plataforma = 'woocommerce' as const;
  private readonly api: ClienteApi;
  private monedaCache: string | null | undefined;

  constructor(http: HttpSeguro, cred: CredencialWoo) {
    const host = dominioWoo(cred.dominio);
    if (!host || !CLAVE_WOO.test(cred.clave) || !SECRETO_WOO.test(cred.secreto)) throw new ErrorTienda('credencial_rechazada');
    this.api = new ClienteApi(http, host, { Authorization: `Basic ${Buffer.from(`${cred.clave}:${cred.secreto}`).toString('base64')}` }, RUTAS);
  }

  private async moneda(): Promise<string | null> {
    if (this.monedaCache !== undefined) return this.monedaCache;
    let m: string | null = null;
    try { m = limpiar(obj((await this.api.json('GET', `${BASE}/data/currencies/current`)).datos).code, 3); } catch (e) { if (e instanceof ErrorTienda && e.codigo === 'credencial_rechazada') throw e; }
    if (!m) {
      try { m = limpiar(obj(arr((await this.api.json('GET', `${BASE}/orders`, { per_page: 1 })).datos)[0]).currency, 3); } catch { /* sin moneda conocida */ }
    }
    return (this.monedaCache = m && /^[A-Za-z]{3}$/.test(m) ? m.toUpperCase() : null);
  }

  async probar(): Promise<InfoTienda> {
    await this.api.json('GET', `${BASE}/products`, { per_page: 1 }); // valida clave, permiso de lectura y que la API exista
    return { nombre: null, moneda: await this.moneda() };
  }

  private resumen(o: Record<string, unknown>, lineas: boolean): PedidoResumen | null {
    const id = idSeguro(o.id);
    const total = dinero(o.total, o.currency);
    if (!id || !total) return null;
    const estadoOriginal = limpiar(o.status, 40) ?? 'desconocido';
    const ls = arr(o.line_items).slice(0, 100).map((l) => this.linea(obj(l), o.currency));
    const fecha = typeof o.date_created_gmt === 'string' && o.date_created_gmt ? `${o.date_created_gmt.replace(/Z$/, '')}Z` : limpiar(o.date_created, 40) ?? '';
    return {
      id, numero: limpiar(o.number, 40) ?? id, estado: ESTADO_WOO[estadoOriginal] ?? 'otro', estadoOriginal, creado: limpiar(fecha, 40) ?? '', total,
      articulos: ls.reduce((a, l) => a + l.cantidad, 0),
      ...(lineas ? { lineas: ls } : {}),
    };
  }
  private linea(l: Record<string, unknown>, moneda: unknown): LineaPedido {
    return { productoId: idSeguro(l.product_id), nombre: limpiar(l.name) ?? '(sin nombre)', sku: limpiar(l.sku, 80) || null, cantidad: Math.max(0, ent(l.quantity) ?? 0), precioUnitario: dinero(l.price, moneda) };
  }

  async pedidos(f: FiltroPedidos, limite: number, conLineas: boolean): Promise<ResultadoPedidos> {
    const status = f.estados?.length ? [...new Set(f.estados.flatMap((e) => A_WOO[e]))].join(',') : undefined;
    const out: PedidoResumen[] = []; let total: number | null = null; let pagina = 1; let paginas = 1;
    while (out.length < limite && pagina <= paginas && pagina <= 10) {
      const r = await this.api.json('GET', `${BASE}/orders`, {
        per_page: Math.min(POR_PAGINA, Math.max(1, limite - out.length + 1)), page: pagina, orderby: 'date', order: 'desc', _fields: CAMPOS_PEDIDO,
        after: f.desde?.toISOString(), before: f.hasta?.toISOString(), dates_are_gmt: f.desde || f.hasta ? 'true' : undefined, status,
      });
      total = ent(r.cabeceras['x-wp-total']) ?? total; paginas = ent(r.cabeceras['x-wp-totalpages']) ?? paginas;
      for (const o of arr(r.datos)) { const p = this.resumen(obj(o), conLineas); if (p) out.push(p); }
      if (arr(r.datos).length === 0) break;
      pagina++;
    }
    return { pedidos: out.slice(0, limite), truncado: out.length > limite || (total !== null && total > limite), total };
  }

  async pedido(id: string): Promise<PedidoDetalle> {
    if (!/^\d{1,12}$/.test(id)) throw new ErrorTienda('no_encontrado');
    const o = obj((await this.api.json('GET', `${BASE}/orders/${id}`, { _fields: CAMPOS_PEDIDO })).datos);
    const base = this.resumen(o, true);
    if (!base) throw new ErrorTienda('respuesta_invalida');
    const mon = o.currency;
    const imp = dinero(o.total_tax, mon); const env = dinero(o.shipping_total, mon); const desc = dinero(o.discount_total, mon);
    return {
      ...base, lineas: base.lineas ?? [], subtotal: null /* WooCommerce no entrega el subtotal: no se inventa */, envio: env, descuento: desc, impuestos: imp,
      metodoPago: limpiar(o.payment_method_title, 100), metodoEnvio: limpiar(obj(arr(o.shipping_lines)[0]).method_title, 100),
    };
  }

  private async producto_(p: Record<string, unknown>): Promise<ProductoResumen | null> {
    const id = idSeguro(p.id);
    if (!id) return null;
    const moneda = await this.moneda();
    const gestiona = p.manage_stock === true;
    const stockEstado = limpiar(p.stock_status, 20);
    return {
      id, nombre: limpiar(p.name) ?? '(sin nombre)', sku: limpiar(p.sku, 80) || null,
      precio: moneda ? dinero(p.regular_price || p.price, moneda) : null,
      precioRebajado: moneda && p.on_sale === true ? dinero(p.sale_price, moneda) : null,
      estado: limpiar(p.status, 20) ?? 'desconocido',
      stock: gestiona ? ent(p.stock_quantity) : null,
      agotado: stockEstado ? stockEstado === 'outofstock' : null,
    };
  }

  async productos(o: { buscar?: string; limite: number }) {
    const r = await this.api.json('GET', `${BASE}/products`, { per_page: Math.min(o.limite, POR_PAGINA), search: o.buscar, orderby: 'date', order: 'desc' });
    const lista = (await Promise.all(arr(r.datos).slice(0, o.limite).map((p) => this.producto_(obj(p))))).filter((p): p is ProductoResumen => p !== null);
    return { productos: lista, total: ent(r.cabeceras['x-wp-total']) };
  }

  async producto(id: string): Promise<ProductoResumen> {
    if (!/^\d{1,12}$/.test(id)) throw new ErrorTienda('no_encontrado');
    const p = await this.producto_(obj((await this.api.json('GET', `${BASE}/products/${id}`)).datos));
    if (!p) throw new ErrorTienda('respuesta_invalida');
    return p;
  }

  async stockBajo(o: { umbral: number; limite: number }) {
    const bajos: ProductoResumen[] = []; let truncado = false;
    for (let pagina = 1; pagina <= 6; pagina++) {
      const r = await this.api.json('GET', `${BASE}/products`, { per_page: POR_PAGINA, page: pagina, status: 'publish' });
      const filas = arr(r.datos);
      for (const f of filas) {
        const p = await this.producto_(obj(f));
        if (p && (p.agotado === true || (p.stock !== null && p.stock <= o.umbral))) { if (bajos.length < o.limite) bajos.push(p); else truncado = true; }
      }
      const paginas = ent(r.cabeceras['x-wp-totalpages']) ?? 1;
      if (pagina >= paginas || filas.length === 0) break;
      if (pagina === 6 && paginas > 6) truncado = true; // no se revisó todo el catálogo
    }
    bajos.sort((a, b) => (a.stock ?? -1) - (b.stock ?? -1));
    return { productos: bajos, truncado };
  }

  async cupones(o: { limite: number }): Promise<Cupon[]> {
    const r = await this.api.json('GET', `${BASE}/coupons`, { per_page: Math.min(o.limite, POR_PAGINA), orderby: 'date', order: 'desc' });
    return arr(r.datos).slice(0, o.limite).map((c) => {
      const x = obj(c);
      return { codigo: limpiar(x.code, 60) ?? '', tipo: limpiar(x.discount_type, 30) ?? '', valor: limpiar(x.amount, 20) ?? '', usos: Math.max(0, ent(x.usage_count) ?? 0), limiteUsos: ent(x.usage_limit), vence: limpiar(x.date_expires_gmt, 40) };
    }).filter((c) => c.codigo);
  }
}

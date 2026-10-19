import type { HttpSeguro } from '../http-seguro.js';
import { ClienteApi } from './base.js';
import {
  arr, dinero, dineroDeMenor, ent, ErrorTienda, idSeguro, limpiar, obj,
  type AdaptadorTienda, type Cupon, type EstadoComun, type FiltroPedidos, type InfoTienda, type PedidoDetalle, type PedidoResumen,
  type ProductoResumen, type ResultadoPedidos,
} from './tipos.js';

export interface CredencialVtex { cuenta: string; appKey: string; appToken: string }
export const APP_KEY_VTEX = /^[A-Za-z0-9._-]{8,100}$/;
export const APP_TOKEN_VTEX = /^[A-Za-z0-9._-]{16,300}$/;
const CUENTA = /^[a-z0-9][a-z0-9-]{0,60}$/;
/** Dominio de producción de VTEX. Por verificar con una tienda real. */
export const SUFIJO_VTEX = '.vtexcommercestable.com.br';

export function cuentaVtex(entrada: string): string | null {
  let t = entrada.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (t.endsWith(SUFIJO_VTEX)) t = t.slice(0, -SUFIJO_VTEX.length);
  return CUENTA.test(t) ? t : null;
}

const RUTAS = [/^\/api\/oms\/pvt\/orders$/, /^\/api\/oms\/pvt\/orders\/[A-Za-z0-9-]{4,60}$/, /^\/api\/catalog_system\/pub\/products\/search$/];
const ESTADO_VTEX: Record<string, EstadoComun> = {
  'payment-pending': 'pendiente', 'waiting-for-sellers-confirmation': 'pagado', 'payment-approved': 'pagado', 'approve-payment': 'pagado', 'ready-for-handling': 'pagado',
  'start-handling': 'pagado', handling: 'pagado', invoice: 'pagado', 'window-to-cancel': 'pagado', invoiced: 'completado',
  canceled: 'cancelado', cancel: 'cancelado', 'cancellation-requested': 'cancelado', replaced: 'otro',
};
const A_VTEX: Record<EstadoComun, string[]> = {
  pendiente: ['payment-pending'],
  pagado: ['waiting-for-sellers-confirmation', 'payment-approved', 'approve-payment', 'ready-for-handling', 'start-handling', 'handling', 'invoice', 'window-to-cancel'],
  completado: ['invoiced'], cancelado: ['canceled', 'cancel', 'cancellation-requested'], reembolsado: [], fallido: [], otro: ['replaced'],
};
const POR_PAGINA = 30;
const TOPE_PAGINAS = 10;

export class AdaptadorVtex implements AdaptadorTienda {
  readonly plataforma = 'vtex' as const;
  private readonly api: ClienteApi;
  private monedaCache: string | null | undefined;

  constructor(http: HttpSeguro, cred: CredencialVtex) {
    const cuenta = cuentaVtex(cred.cuenta);
    if (!cuenta || !APP_KEY_VTEX.test(cred.appKey) || !APP_TOKEN_VTEX.test(cred.appToken)) throw new ErrorTienda('credencial_rechazada');
    this.api = new ClienteApi(http, `${cuenta}${SUFIJO_VTEX}`, { 'X-VTEX-API-AppKey': cred.appKey, 'X-VTEX-API-AppToken': cred.appToken }, RUTAS);
  }

  async probar(): Promise<InfoTienda> {
    const r = await this.api.json('GET', '/api/oms/pvt/orders', { per_page: 1 });
    const m = limpiar(obj(arr(obj(r.datos).list)[0]).currencyCode, 3);
    this.monedaCache = m && /^[A-Za-z]{3}$/.test(m) ? m.toUpperCase() : null;
    return { nombre: null, moneda: this.monedaCache };
  }

  private async moneda(): Promise<string | null> {
    if (this.monedaCache === undefined) await this.probar().catch((e) => { if (e instanceof ErrorTienda && e.codigo === 'credencial_rechazada') throw e; this.monedaCache = null; });
    return this.monedaCache ?? null;
  }

  private resumen(o: Record<string, unknown>): PedidoResumen | null {
    const id = idSeguro(o.orderId);
    const total = dineroDeMenor(o.totalValue ?? o.value, o.currencyCode ?? obj(o.storePreferencesData).currencyCode);
    if (!id || !total) return null;
    const original = limpiar(o.status, 60) ?? 'desconocido';
    return {
      id, numero: limpiar(o.sequence, 40) ?? id, estado: ESTADO_VTEX[original] ?? 'otro', estadoOriginal: original, creado: limpiar(o.creationDate, 40) ?? '', total,
      articulos: Math.max(0, ent(o.totalItems) ?? arr(o.items).reduce<number>((a, i) => a + Math.max(0, ent(obj(i).quantity) ?? 0), 0)),
    };
  }

  async pedidos(f: FiltroPedidos, limite: number, conLineas: boolean): Promise<ResultadoPedidos> {
    if (conLineas) throw new ErrorTienda('no_soportado'); // la lista de VTEX no trae los productos de cada pedido: pedir uno por uno sería lento y caro
    const estados = f.estados?.length ? [...new Set(f.estados.flatMap((e) => A_VTEX[e]))] : null;
    if (estados && estados.length === 0) return { pedidos: [], truncado: false, total: 0 };
    const rango = f.desde || f.hasta ? `creationDate:[${(f.desde ?? new Date(0)).toISOString()} TO ${(f.hasta ?? new Date()).toISOString()}]` : undefined;
    const out: PedidoResumen[] = []; let total: number | null = null; let pagina = 1; let paginas = 1;
    while (out.length <= limite && pagina <= paginas && pagina <= TOPE_PAGINAS) {
      const r = obj((await this.api.json('GET', '/api/oms/pvt/orders', { page: pagina, per_page: POR_PAGINA, orderBy: 'creationDate,desc', f_creationDate: rango, f_status: estados?.join(',') })).datos);
      const pg = obj(r.paging);
      total = ent(pg.total) ?? total; paginas = ent(pg.pages) ?? paginas;
      const lista = arr(r.list);
      for (const o of lista) { const p = this.resumen(obj(o)); if (p) out.push(p); }
      if (lista.length === 0) break;
      pagina++;
    }
    return { pedidos: out.slice(0, limite), truncado: out.length > limite || (total !== null && total > limite), total };
  }

  async pedido(id: string): Promise<PedidoDetalle> {
    if (!/^[A-Za-z0-9-]{4,60}$/.test(id)) throw new ErrorTienda('no_encontrado');
    const o = obj((await this.api.json('GET', `/api/oms/pvt/orders/${id}`)).datos);
    const base = this.resumen(o);
    if (!base) throw new ErrorTienda('respuesta_invalida');
    const mon = base.total.moneda;
    const t = (clave: string) => dineroDeMenor(obj(arr(o.totals).find((x) => obj(x).id === clave)).value, mon);
    const pago = obj(arr(obj(arr(obj(o.paymentData).transactions)[0]).payments)[0]);
    return {
      ...base,
      lineas: arr(o.items).slice(0, 100).map((i) => { const x = obj(i); return { productoId: idSeguro(x.productId), nombre: limpiar(x.name) ?? '(sin nombre)', sku: limpiar(x.refId, 80) || null, cantidad: Math.max(0, ent(x.quantity) ?? 0), precioUnitario: dineroDeMenor(x.sellingPrice ?? x.price, mon) }; }),
      subtotal: t('Items'), envio: t('Shipping'), descuento: t('Discounts'), impuestos: t('Tax'),
      metodoPago: limpiar(pago.paymentSystemName, 100), metodoEnvio: limpiar(obj(arr(obj(o.shippingData).logisticsInfo)[0]).selectedSla, 100),
    };
  }

  private async prod(p: Record<string, unknown>): Promise<ProductoResumen | null> {
    const id = idSeguro(p.productId);
    if (!id) return null;
    const moneda = await this.moneda();
    const items = arr(p.items).map(obj);
    const ofertas = items.map((i) => obj(obj(arr(i.sellers)[0]).commertialOffer));
    const disponibles = ofertas.map((o) => ent(o.AvailableQuantity)).filter((n): n is number => n !== null);
    const precios = ofertas.map((o) => (typeof o.Price === 'number' ? o.Price : null)).filter((n): n is number => n !== null && n > 0);
    const lista = ofertas.map((o) => (typeof o.ListPrice === 'number' ? o.ListPrice : null)).filter((n): n is number => n !== null && n > 0);
    const min = precios.length ? Math.min(...precios) : null; const minLista = lista.length ? Math.min(...lista) : null;
    const rebajado = min !== null && minLista !== null && min < minLista;
    const sku = limpiar(obj(arr(items[0]?.referenceId)[0]).Value, 80) || null;
    const stock = disponibles.length ? disponibles.reduce((a, b) => a + b, 0) : null;
    return {
      id, nombre: limpiar(p.productName) ?? '(sin nombre)', sku,
      precio: moneda && (rebajado ? minLista : min) !== null ? dinero(String(rebajado ? minLista : min), moneda) : null,
      precioRebajado: moneda && rebajado ? dinero(String(min), moneda) : null,
      estado: 'visible', stock, agotado: stock === null ? null : stock <= 0,
    };
  }

  async productos(o: { buscar?: string; limite: number }) {
    const t = o.buscar?.normalize('NFC').replace(/[^\p{L}\p{N} ._-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const r = await this.api.json('GET', '/api/catalog_system/pub/products/search', { ft: t || undefined, _from: 0, _to: Math.min(o.limite, 50) - 1 });
    const lista = (await Promise.all(arr(r.datos).slice(0, o.limite).map((p) => this.prod(obj(p))))).filter((p): p is ProductoResumen => p !== null);
    return { productos: lista, total: null };
  }

  async producto(id: string): Promise<ProductoResumen> {
    if (!/^\d{1,15}$/.test(id)) throw new ErrorTienda('no_encontrado');
    const r = await this.api.json('GET', '/api/catalog_system/pub/products/search', { fq: `productId:${id}` });
    const p = arr(r.datos)[0] ? await this.prod(obj(arr(r.datos)[0])) : null;
    if (!p) throw new ErrorTienda('no_encontrado');
    return p;
  }

  async stockBajo(_o: { umbral: number; limite: number }): Promise<{ productos: ProductoResumen[]; truncado: boolean }> { throw new ErrorTienda('no_soportado'); }
  async cupones(_o: { limite: number }): Promise<Cupon[]> { throw new ErrorTienda('no_soportado'); }
}

import type { HttpSeguro } from '../http-seguro.js';
import { ClienteApi } from './base.js';
import {
  arr, dinero, ent, ErrorTienda, limpiar, obj,
  type AdaptadorTienda, type Cupon, type Dinero, type EstadoComun, type FiltroPedidos, type InfoTienda, type LineaPedido, type PedidoDetalle,
  type PedidoResumen, type ProductoResumen, type ResultadoPedidos,
} from './tipos.js';

export interface CredencialShopify { tienda: string; token: string }
/** Versión de la API de administración (trimestral). Por verificar la vigente al probar con una tienda real. */
export const VERSION_SHOPIFY = '2026-07';
export const TOKEN_SHOPIFY = /^[A-Za-z0-9_-]{16,200}$/;
const SUBDOMINIO = /^[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$|^[a-z0-9]$/;

/** «mi-tienda», «mi-tienda.myshopify.com» o «https://mi-tienda.myshopify.com» → «mi-tienda»; null si no es válido. */
export function subdominioShopify(entrada: string): string | null {
  let t = entrada.trim().toLowerCase();
  t = t.replace(/^https:\/\//, '').replace(/\/$/, '');
  if (t.endsWith('.myshopify.com')) t = t.slice(0, -'.myshopify.com'.length);
  return SUBDOMINIO.test(t) ? t : null;
}

const TOPE_ESCANEO = 250;
const RUTA = new RegExp(`^/admin/api/${VERSION_SHOPIFY}/graphql\\.json$`);

// Consultas FIJAS escritas por el servidor: solo «query» (nunca «mutation»). El modelo solo aporta valores, siempre como variables.
const Q_TIENDA = 'query { shop { name currencyCode } }';
const Q_ALCANCES = 'query { currentAppInstallation { accessScopes { handle } } }';
const CAMPOS_PEDIDO = 'id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } }';
const Q_PEDIDOS = `query($first: Int!, $after: String, $q: String) { orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) { pageInfo { hasNextPage endCursor } nodes { ${CAMPOS_PEDIDO} subtotalLineItemsQuantity } } }`;
const Q_PEDIDOS_LINEAS = `query($first: Int!, $after: String, $q: String) { orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) { pageInfo { hasNextPage endCursor } nodes { ${CAMPOS_PEDIDO} lineItems(first: 20) { nodes { title sku quantity product { id } originalUnitPriceSet { shopMoney { amount currencyCode } } } } } } }`;
const Q_PEDIDO = `query($id: ID!) { order(id: $id) { ${CAMPOS_PEDIDO} paymentGatewayNames shippingLine { title } currentSubtotalPriceSet { shopMoney { amount currencyCode } } totalShippingPriceSet { shopMoney { amount currencyCode } } totalDiscountsSet { shopMoney { amount currencyCode } } currentTotalTaxSet { shopMoney { amount currencyCode } } lineItems(first: 50) { nodes { title sku quantity product { id } originalUnitPriceSet { shopMoney { amount currencyCode } } } } } }`;
const CAMPOS_PRODUCTO = 'id title status totalInventory tracksInventory priceRangeV2 { minVariantPrice { amount currencyCode } } variants(first: 1) { nodes { sku compareAtPrice } }';
const Q_PRODUCTOS = `query($first: Int!, $after: String, $q: String) { products(first: $first, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) { pageInfo { hasNextPage endCursor } nodes { ${CAMPOS_PRODUCTO} } } }`;
const Q_PRODUCTO = `query($id: ID!) { product(id: $id) { ${CAMPOS_PRODUCTO} } }`;

const numeroDeGid = (gid: unknown): string | null => { const m = typeof gid === 'string' ? /\/(\d{1,15})$/.exec(gid) : null; return m ? m[1]! : null; };
const dineroSet = (v: unknown): Dinero | null => { const m = obj(obj(v).shopMoney); return dinero(m.amount, m.currencyCode); };

function estado(o: Record<string, unknown>): { comun: EstadoComun; original: string } {
  const fin = limpiar(o.displayFinancialStatus, 30) ?? 'DESCONOCIDO';
  const ful = limpiar(o.displayFulfillmentStatus, 30) ?? '';
  const original = `${fin}${ful ? `/${ful}` : ''}`;
  if (o.cancelledAt) return { comun: 'cancelado', original };
  switch (fin) {
    case 'PENDING': case 'AUTHORIZED': case 'PARTIALLY_PAID': return { comun: 'pendiente', original };
    case 'VOIDED': return { comun: 'cancelado', original };
    case 'EXPIRED': return { comun: 'fallido', original };
    case 'REFUNDED': return { comun: 'reembolsado', original };
    case 'PAID': case 'PARTIALLY_REFUNDED': return { comun: ful === 'FULFILLED' ? 'completado' : 'pagado', original };
    default: return { comun: 'otro', original };
  }
}

/** Cada palabra se busca por separado en el título; se descartan los operadores de la búsqueda de Shopify (and, or, not) para que el texto del modelo no cambie la consulta. */
const sanearBusqueda = (t: string) => t.normalize('NFC').replace(/[^\p{L}\p{N} ._-]/gu, ' ').split(/\s+/).filter((w) => w && !/^(and|or|not)$/i.test(w)).slice(0, 6).map((w) => `title:*${w.slice(0, 40)}*`).join(' ');

export class AdaptadorShopify implements AdaptadorTienda {
  readonly plataforma = 'shopify' as const;
  private readonly api: ClienteApi;
  private alcances: Set<string> | undefined;

  constructor(http: HttpSeguro, cred: CredencialShopify) {
    const sub = subdominioShopify(cred.tienda);
    if (!sub || !TOKEN_SHOPIFY.test(cred.token)) throw new ErrorTienda('credencial_rechazada');
    this.api = new ClienteApi(http, `${sub}.myshopify.com`, { 'X-Shopify-Access-Token': cred.token }, [RUTA]);
  }

  /** Ejecuta una consulta GraphQL fija. Los errores de GraphQL llegan con HTTP 200: se traducen aquí. */
  private async gql(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!query.trimStart().startsWith('query')) throw new Error('solo se permiten consultas');
    const { datos } = await this.api.json('POST', `/admin/api/${VERSION_SHOPIFY}/graphql.json`, {}, { query, variables });
    const r = obj(datos);
    const errores = arr(r.errors);
    if (errores.length) {
      const cod = String(obj(obj(errores[0]).extensions).code ?? '');
      throw new ErrorTienda(cod === 'THROTTLED' ? 'limite' : cod === 'ACCESS_DENIED' ? 'sin_permiso' : 'respuesta_invalida');
    }
    return obj(r.data);
  }

  async probar(): Promise<InfoTienda> {
    const s = obj((await this.gql(Q_TIENDA)).shop);
    return { nombre: limpiar(s.name, 100), moneda: limpiar(s.currencyCode, 3) };
  }

  private async tieneLeerTodos(): Promise<boolean> {
    if (!this.alcances) {
      const h = arr(obj(obj(await this.gql(Q_ALCANCES)).currentAppInstallation).accessScopes).map((x) => limpiar(obj(x).handle, 60) ?? '');
      this.alcances = new Set(h);
    }
    return this.alcances.has('read_all_orders');
  }

  private resumen(o: Record<string, unknown>): PedidoResumen | null {
    const id = numeroDeGid(o.id); const total = dineroSet(o.currentTotalPriceSet);
    if (!id || !total) return null;
    const e = estado(o);
    const ls = arr(obj(o.lineItems).nodes).map((l) => this.linea(obj(l)));
    return {
      id, numero: limpiar(o.name, 40) ?? id, estado: e.comun, estadoOriginal: e.original, creado: limpiar(o.createdAt, 40) ?? '', total,
      articulos: o.lineItems ? ls.reduce((a, l) => a + l.cantidad, 0) : Math.max(0, ent(o.subtotalLineItemsQuantity) ?? 0),
      ...(o.lineItems ? { lineas: ls } : {}),
    };
  }
  private linea(l: Record<string, unknown>): LineaPedido {
    return { productoId: numeroDeGid(obj(l.product).id), nombre: limpiar(l.title) ?? '(sin nombre)', sku: limpiar(l.sku, 80) || null, cantidad: Math.max(0, ent(l.quantity) ?? 0), precioUnitario: dineroSet(l.originalUnitPriceSet) };
  }

  async pedidos(f: FiltroPedidos, limite: number, conLineas: boolean): Promise<ResultadoPedidos> {
    // Con solo read_orders Shopify entrega los últimos 60 días y calla lo demás: mejor avisar que dar un número incompleto.
    if (f.desde && f.desde.getTime() < Date.now() - 60 * 86_400_000 && !(await this.tieneLeerTodos())) throw new ErrorTienda('periodo_fuera_de_alcance');
    const partes: string[] = [];
    if (f.desde) partes.push(`created_at:>=${f.desde.toISOString()}`);
    if (f.hasta) partes.push(`created_at:<=${f.hasta.toISOString()}`);
    const q = partes.join(' ') || undefined;
    const filtrar = f.estados?.length ? new Set<EstadoComun>(f.estados) : null;
    const tope = filtrar ? Math.max(limite, TOPE_ESCANEO) : limite;
    const out: PedidoResumen[] = []; let escaneados = 0; let despues: string | null = null; let hayMas = false;
    while (escaneados < tope) {
      const lote: number = Math.min(conLineas ? 25 : 50, tope - escaneados);
      const d = obj((await this.gql(conLineas ? Q_PEDIDOS_LINEAS : Q_PEDIDOS, { first: lote, after: despues, q })).orders);
      const nodos = arr(d.nodes);
      for (const n of nodos) { escaneados++; const p = this.resumen(obj(n)); if (p && (!filtrar || filtrar.has(p.estado))) out.push(p); }
      const pi = obj(d.pageInfo);
      hayMas = pi.hasNextPage === true;
      despues = limpiar(pi.endCursor, 300);
      if (!hayMas || !despues || nodos.length === 0) break;
    }
    return { pedidos: out.slice(0, limite), truncado: out.length > limite || hayMas, total: null };
  }

  async pedido(id: string): Promise<PedidoDetalle> {
    if (!/^\d{1,15}$/.test(id)) throw new ErrorTienda('no_encontrado');
    const o = obj((await this.gql(Q_PEDIDO, { id: `gid://shopify/Order/${id}` })).order);
    if (!Object.keys(o).length) throw new ErrorTienda('no_encontrado');
    const base = this.resumen(o);
    if (!base) throw new ErrorTienda('respuesta_invalida');
    return {
      ...base, lineas: base.lineas ?? [], subtotal: dineroSet(o.currentSubtotalPriceSet), envio: dineroSet(o.totalShippingPriceSet), descuento: dineroSet(o.totalDiscountsSet),
      impuestos: dineroSet(o.currentTotalTaxSet), metodoPago: limpiar(arr(o.paymentGatewayNames)[0], 100), metodoEnvio: limpiar(obj(o.shippingLine).title, 100),
    };
  }

  private prod(p: Record<string, unknown>): ProductoResumen | null {
    const id = numeroDeGid(p.id);
    if (!id) return null;
    const v = obj(arr(obj(p.variants).nodes)[0]);
    const rango = obj(obj(p.priceRangeV2).minVariantPrice);
    const sigue = p.tracksInventory === true; const inv = ent(p.totalInventory);
    const comparar = dinero(v.compareAtPrice, rango.currencyCode);
    const precio = dinero(rango.amount, rango.currencyCode);
    return {
      id, nombre: limpiar(p.title) ?? '(sin nombre)', sku: limpiar(v.sku, 80) || null,
      precio: comparar ? comparar : precio, precioRebajado: comparar ? precio : null,
      estado: (limpiar(p.status, 20) ?? 'desconocido').toLowerCase(), stock: sigue ? inv : null, agotado: sigue && inv !== null ? inv <= 0 : null,
    };
  }

  async productos(o: { buscar?: string; limite: number }) {
    const b = o.buscar ? sanearBusqueda(o.buscar) : '';
    const d = obj((await this.gql(Q_PRODUCTOS, { first: Math.min(o.limite, 50), after: null, q: b || undefined })).products);
    return { productos: arr(d.nodes).slice(0, o.limite).map((p) => this.prod(obj(p))).filter((p): p is ProductoResumen => p !== null), total: null };
  }

  async producto(id: string): Promise<ProductoResumen> {
    if (!/^\d{1,15}$/.test(id)) throw new ErrorTienda('no_encontrado');
    const p = obj((await this.gql(Q_PRODUCTO, { id: `gid://shopify/Product/${id}` })).product);
    const r = Object.keys(p).length ? this.prod(p) : null;
    if (!r) throw new ErrorTienda('no_encontrado');
    return r;
  }

  async stockBajo(o: { umbral: number; limite: number }) {
    const d = obj((await this.gql(Q_PRODUCTOS, { first: Math.min(o.limite + 1, 50), after: null, q: `inventory_total:<=${Math.trunc(o.umbral)} status:active` })).products);
    const todos = arr(d.nodes).map((p) => this.prod(obj(p))).filter((p): p is ProductoResumen => p !== null && p.stock !== null);
    todos.sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0));
    return { productos: todos.slice(0, o.limite), truncado: todos.length > o.limite || obj(d.pageInfo).hasNextPage === true };
  }

  async cupones(_o: { limite: number }): Promise<Cupon[]> { throw new ErrorTienda('no_soportado'); }
}

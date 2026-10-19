import { describe, expect, it } from 'vitest';
import { ErrorHttpSeguro, type HttpSeguro, type PeticionSegura, type RespuestaSegura } from '../src/conectores/http-seguro.js';
import { AdaptadorWooCommerce, dominioWoo } from '../src/conectores/tiendas/woocommerce.js';
import { AdaptadorShopify, subdominioShopify, VERSION_SHOPIFY } from '../src/conectores/tiendas/shopify.js';
import { AdaptadorVtex, cuentaVtex } from '../src/conectores/tiendas/vtex.js';
import { crearAdaptador } from '../src/conectores/tiendas/fabrica.js';
import { HERRAMIENTAS_TIENDA, promedioDinero, rangoPeriodo, type ResolutorTiendas } from '../src/conectores/tiendas/herramientas.js';
import { dineroDeMenor, ErrorTienda, sumarDinero, type AdaptadorTienda } from '../src/conectores/tiendas/tipos.js';

type Manejador = (p: PeticionSegura) => Partial<RespuestaSegura> | Promise<Partial<RespuestaSegura>>;
function falso(m: Manejador) {
  const llamadas: PeticionSegura[] = [];
  const http = { pedir: async (p: PeticionSegura): Promise<RespuestaSegura> => { llamadas.push(p); const r = await m(p); return { estado: 200, cuerpo: '', cabeceras: {}, ...r }; } } as unknown as HttpSeguro;
  return { http, llamadas };
}
const json = (v: unknown, cabeceras: Record<string, string> = {}, estado = 200) => ({ estado, cuerpo: JSON.stringify(v), cabeceras });
const codigo = async (f: () => Promise<unknown>) => { try { await f(); return 'sin_error'; } catch (e) { return e instanceof ErrorTienda ? e.codigo : `otro:${String(e)}`; } };

const CK = `ck_${'a'.repeat(32)}`; const CS = `cs_${'b'.repeat(32)}`;
const PII = ['Juan Perez', 'juan@correo.com', '3001234567', 'Calle 123 #45-67'];

describe('WooCommerce', () => {
  const pedidoWoo = (id: number, status = 'processing', total = '100000.50') => ({
    id, number: String(id), status, currency: 'COP', total, date_created_gmt: '2026-10-01T10:00:00', total_tax: '0', shipping_total: '5000', discount_total: '0',
    billing: { first_name: 'Juan', last_name: 'Perez', email: 'juan@correo.com', phone: '3001234567', address_1: 'Calle 123 #45-67' },
    shipping: { first_name: 'Juan Perez', address_1: 'Calle 123 #45-67' },
    customer_note: 'Juan Perez 3001234567', payment_method_title: 'Wompi', shipping_lines: [{ method_title: 'Envío' }],
    line_items: [{ product_id: 7, name: 'Camiseta\u202e roja', sku: 'CAM-1', quantity: 2, price: 50000 }],
  });
  it('valida dominio y claves', () => {
    expect(dominioWoo('https://Tienda.Ejemplo.com/')).toBe('tienda.ejemplo.com');
    for (const x of ['http://a.com', 'https://a.com:8443', 'https://a.com/wp', 'https://u:p@a.com', '10.0.0.1', 'localhost', 'a.com/x', 'https://a.com?x=1']) expect(dominioWoo(x), x).toBeNull();
    const { http } = falso(() => ({}));
    expect(() => new AdaptadorWooCommerce(http, { dominio: 'a.com', clave: 'x', secreto: CS })).toThrow(ErrorTienda);
    expect(() => new AdaptadorWooCommerce(http, { dominio: 'http://a.com', clave: CK, secreto: CS })).toThrow(ErrorTienda);
  });
  it('autentica por cabecera, solo GET a rutas permitidas y nunca pone claves en la URL', async () => {
    const { http, llamadas } = falso((p) => (p.ruta.includes('currencies') ? json({ code: 'COP' }) : json([])));
    const a = new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS });
    await a.probar(); await a.pedidos({}, 5, false); await a.productos({ limite: 3 });
    for (const l of llamadas) {
      expect(l.metodo).toBe('GET'); expect(l.host).toBe('tienda.ejemplo.com'); expect(l.ruta).toMatch(/^\/wp-json\/wc\/v3\//);
      expect(l.cabeceras.Authorization).toBe(`Basic ${Buffer.from(`${CK}:${CS}`).toString('base64')}`);
      expect(l.ruta).not.toContain('ck_'); expect(l.ruta).not.toContain('cs_');
    }
  });
  it('no devuelve datos personales aunque la tienda los envíe, y sanea texto', async () => {
    const { http } = falso((p) => (p.ruta.startsWith('/wp-json/wc/v3/orders/') ? json(pedidoWoo(5)) : json([pedidoWoo(5), pedidoWoo(6, 'completed')], { 'x-wp-total': '2', 'x-wp-totalpages': '1' })));
    const a = new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS });
    const r = await a.pedidos({}, 10, true); const d = await a.pedido('5');
    const todo = JSON.stringify([r, d]);
    for (const x of PII) expect(todo).not.toContain(x);
    expect(todo).not.toContain('\u202e');
    expect(r.pedidos[0]).toMatchObject({ id: '5', estado: 'pagado', total: { moneda: 'COP', monto: '100000.50' }, articulos: 2 });
    expect(r.pedidos[1]!.estado).toBe('completado'); expect(r.truncado).toBe(false);
    expect(d.subtotal).toBeNull(); expect(d.envio?.monto).toBe('5000'); expect(d.metodoPago).toBe('Wompi');
  });
  it('pide solo los campos usados: los datos del comprador no se solicitan a la tienda', async () => {
    const { http, llamadas } = falso(() => json([pedidoWoo(1)], { 'x-wp-total': '1', 'x-wp-totalpages': '1' }));
    const a = new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS });
    await a.pedidos({}, 5, false); await a.pedido('1').catch(() => undefined);
    const pedidos = llamadas.filter((l) => l.ruta.startsWith('/wp-json/wc/v3/orders'));
    expect(pedidos).toHaveLength(2);
    for (const l of pedidos) { const f = new URLSearchParams(l.ruta.split('?')[1]).get('_fields')!; expect(f).toContain('line_items'); expect(f).not.toMatch(/billing|shipping\b|email|phone|customer|meta/); }
  });
  it('marca truncado y respeta el límite', async () => {
    const { http } = falso(() => json([1, 2, 3, 4].map((i) => pedidoWoo(i)), { 'x-wp-total': '90', 'x-wp-totalpages': '2' }));
    const a = new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS });
    const r = await a.pedidos({}, 2, false);
    expect(r.pedidos).toHaveLength(2); expect(r.truncado).toBe(true); expect(r.total).toBe(90);
  });
  it('traduce errores HTTP y de red sin exponer el cuerpo', async () => {
    const casos: [number, string][] = [[401, 'credencial_rechazada'], [403, 'sin_permiso'], [404, 'no_encontrado'], [429, 'limite'], [500, 'no_disponible'], [418, 'respuesta_invalida']];
    for (const [estado, esperado] of casos) {
      const { http } = falso(() => ({ estado, cuerpo: 'SECRETO-INTERNO' }));
      const a = new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS });
      expect(await codigo(() => a.productos({ limite: 1 })), String(estado)).toBe(esperado);
    }
    for (const [c, e] of [['direccion_no_permitida', 'direccion_no_permitida'], ['tiempo_agotado', 'tiempo_agotado'], ['no_disponible', 'no_disponible'], ['respuesta_demasiado_grande', 'respuesta_invalida'], ['redireccion', 'respuesta_invalida']] as const) {
      const { http } = falso(() => { throw new ErrorHttpSeguro(c); });
      expect(await codigo(() => new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS }).productos({ limite: 1 }))).toBe(e);
    }
    const { http } = falso(() => ({ cuerpo: '<html>no es json</html>' }));
    expect(await codigo(() => new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS }).productos({ limite: 1 }))).toBe('respuesta_invalida');
  });
  it('rechaza ids con caracteres de ruta', async () => {
    const { http, llamadas } = falso(() => json({}));
    const a = new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS });
    for (const id of ['../products', '1/../2', '1?x=1', '']) { expect(await codigo(() => a.pedido(id))).toBe('no_encontrado'); expect(await codigo(() => a.producto(id))).toBe('no_encontrado'); }
    expect(llamadas).toHaveLength(0);
  });
  it('stock bajo, productos y cupones', async () => {
    const prod = (id: number, stock: number | null, estado = 'instock') => ({ id, name: `P${id}`, sku: `S${id}`, regular_price: '1000', price: '1000', on_sale: false, status: 'publish', manage_stock: stock !== null, stock_quantity: stock, stock_status: estado });
    const { http } = falso((p) => {
      if (p.ruta.includes('currencies')) return json({ code: 'COP' });
      if (p.ruta.includes('coupons')) return json([{ code: 'HOLA10', discount_type: 'percent', amount: '10.00', usage_count: 3, usage_limit: null, date_expires_gmt: null }]);
      return json([prod(1, 2), prod(2, 50), prod(3, null, 'outofstock'), prod(4, 0)], { 'x-wp-totalpages': '1' });
    });
    const a = new AdaptadorWooCommerce(http, { dominio: 'tienda.ejemplo.com', clave: CK, secreto: CS });
    const r = await a.stockBajo({ umbral: 5, limite: 10 });
    expect(r.productos.map((p) => p.id).sort()).toEqual(['1', '3', '4']); expect(r.truncado).toBe(false);
    expect((await a.cupones({ limite: 5 }))[0]).toMatchObject({ codigo: 'HOLA10', usos: 3, limiteUsos: null });
    expect((await a.productos({ limite: 2 })).productos).toHaveLength(2);
  });
});

describe('Shopify', () => {
  const nodoPedido = (n: number, fin = 'PAID', ful = 'UNFULFILLED', extra: object = {}) => ({
    id: `gid://shopify/Order/${n}`, name: `#${1000 + n}`, createdAt: '2026-10-01T10:00:00Z', cancelledAt: null, displayFinancialStatus: fin, displayFulfillmentStatus: ful,
    currentTotalPriceSet: { shopMoney: { amount: '150000.00', currencyCode: 'COP' } }, subtotalLineItemsQuantity: 3,
    email: 'juan@correo.com', customer: { firstName: 'Juan', lastName: 'Perez', phone: '3001234567' }, shippingAddress: { address1: 'Calle 123 #45-67' },
    lineItems: { nodes: [{ title: 'Taza', sku: 'T1', quantity: 3, product: { id: 'gid://shopify/Product/9' }, originalUnitPriceSet: { shopMoney: { amount: '50000.00', currencyCode: 'COP' } } }] }, ...extra,
  });
  const gql = (m: (q: string, v: Record<string, unknown>) => unknown) => falso((p) => { const c = JSON.parse(p.cuerpo!); return json({ data: m(c.query, c.variables) }); });
  it('valida nombres y credenciales', () => {
    expect(subdominioShopify('https://Mi-Tienda.myshopify.com/')).toBe('mi-tienda');
    expect(subdominioShopify('mi-tienda.myshopify.com')).toBe('mi-tienda');
    for (const x of ['a.com', 'mi tienda', '../x', 'a/b', 'mi-tienda.myshopify.com.evil.com', '-x', 'http://x.myshopify.com:80']) expect(subdominioShopify(x), x).toBeNull();
    const { http } = falso(() => ({}));
    expect(() => new AdaptadorShopify(http, { tienda: 'x', token: 'corto' })).toThrow(ErrorTienda);
  });
  it('arma el dominio en el servidor, solo envía consultas fijas y pone el token en la cabecera', async () => {
    const { http, llamadas } = gql((q) => (q.includes('shop {') ? { shop: { name: 'Mi Tienda', currencyCode: 'COP' } } : { orders: { pageInfo: { hasNextPage: false }, nodes: [] } }));
    const a = new AdaptadorShopify(http, { tienda: 'Mi-Tienda', token: 'shpat_' + 'x'.repeat(30) });
    expect(await a.probar()).toEqual({ nombre: 'Mi Tienda', moneda: 'COP' });
    await a.pedidos({}, 5, false);
    for (const l of llamadas) {
      expect(l.host).toBe('mi-tienda.myshopify.com'); expect(l.metodo).toBe('POST'); expect(l.ruta).toBe(`/admin/api/${VERSION_SHOPIFY}/graphql.json`);
      expect(l.cabeceras['X-Shopify-Access-Token']).toMatch(/^shpat_/); expect(JSON.parse(l.cuerpo!).query).toMatch(/^query/); expect(l.cuerpo).not.toContain('mutation');
    }
  });
  it('mapea estados, no filtra datos personales y calcula artículos', async () => {
    const { http } = gql((q) => (q.includes('order(id') ? { order: nodoPedido(1, 'PAID', 'FULFILLED', { paymentGatewayNames: ['wompi'], shippingLine: { title: 'Estándar' }, currentSubtotalPriceSet: { shopMoney: { amount: '150000', currencyCode: 'COP' } }, totalShippingPriceSet: { shopMoney: { amount: '0', currencyCode: 'COP' } }, totalDiscountsSet: { shopMoney: { amount: '0', currencyCode: 'COP' } }, currentTotalTaxSet: { shopMoney: { amount: '0', currencyCode: 'COP' } } }) }
      : { orders: { pageInfo: { hasNextPage: false }, nodes: [nodoPedido(1, 'PAID', 'FULFILLED'), nodoPedido(2, 'PAID'), nodoPedido(3, 'PENDING'), nodoPedido(4, 'REFUNDED'), nodoPedido(5, 'PAID', 'UNFULFILLED', { cancelledAt: '2026-10-02T00:00:00Z' })] } }));
    const a = new AdaptadorShopify(http, { tienda: 'mi-tienda', token: 'shpat_' + 'x'.repeat(30) });
    const r = await a.pedidos({}, 10, true);
    expect(r.pedidos.map((p) => p.estado)).toEqual(['completado', 'pagado', 'pendiente', 'reembolsado', 'cancelado']);
    expect(r.pedidos[0]).toMatchObject({ id: '1', numero: '#1001', articulos: 3 });
    expect(r.pedidos[0]!.lineas![0]).toMatchObject({ productoId: '9', cantidad: 3 });
    const d = await a.pedido('1');
    for (const x of [...PII, 'Perez']) expect(JSON.stringify([r, d])).not.toContain(x);
    expect(d.metodoPago).toBe('wompi');
    const solo = await a.pedidos({ estados: ['pendiente'] }, 10, false);
    expect(solo.pedidos).toHaveLength(1);
  });
  it('traduce errores de GraphQL que llegan con HTTP 200 y errores HTTP', async () => {
    const err = (code: string) => falso(() => json({ errors: [{ message: 'x', extensions: { code } }] }));
    for (const [c, e] of [['THROTTLED', 'limite'], ['ACCESS_DENIED', 'sin_permiso'], ['OTRO', 'respuesta_invalida']] as const) {
      expect(await codigo(() => new AdaptadorShopify(err(c).http, { tienda: 'mi-tienda', token: 'shpat_' + 'x'.repeat(30) }).probar())).toBe(e);
    }
    expect(await codigo(() => new AdaptadorShopify(falso(() => ({ estado: 401 })).http, { tienda: 'mi-tienda', token: 'shpat_' + 'x'.repeat(30) }).probar())).toBe('credencial_rechazada');
  });
  it('avisa cuando el periodo supera 60 días y no hay read_all_orders', async () => {
    const hace90 = new Date(Date.now() - 90 * 86_400_000);
    const sin = gql((q) => (q.includes('accessScopes') ? { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }] } } : { orders: { pageInfo: { hasNextPage: false }, nodes: [] } }));
    const a = new AdaptadorShopify(sin.http, { tienda: 'mi-tienda', token: 'shpat_' + 'x'.repeat(30) });
    expect(await codigo(() => a.pedidos({ desde: hace90 }, 5, false))).toBe('periodo_fuera_de_alcance');
    expect(sin.llamadas.some((l) => l.cuerpo!.includes('orders('))).toBe(false);
    const con = gql((q) => (q.includes('accessScopes') ? { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'read_all_orders' }] } } : { orders: { pageInfo: { hasNextPage: false }, nodes: [] } }));
    expect(await codigo(() => new AdaptadorShopify(con.http, { tienda: 'mi-tienda', token: 'shpat_' + 'x'.repeat(30) }).pedidos({ desde: hace90 }, 5, false))).toBe('sin_error');
    // dentro de 60 días no se consulta el alcance
    const rec = gql(() => ({ orders: { pageInfo: { hasNextPage: false }, nodes: [] } }));
    await new AdaptadorShopify(rec.http, { tienda: 'mi-tienda', token: 'shpat_' + 'x'.repeat(30) }).pedidos({ desde: new Date(Date.now() - 5 * 86_400_000) }, 5, false);
    expect(rec.llamadas.some((l) => l.cuerpo!.includes('accessScopes'))).toBe(false);
  });
  it('productos: sanea la búsqueda y marca no soportado lo que no hay', async () => {
    const { http, llamadas } = gql(() => ({ products: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/Product/9', title: 'Taza', status: 'ACTIVE', totalInventory: 2, tracksInventory: true, priceRangeV2: { minVariantPrice: { amount: '50000', currencyCode: 'COP' } }, variants: { nodes: [{ sku: 'T1', compareAtPrice: null }] } }] } }));
    const a = new AdaptadorShopify(http, { tienda: 'mi-tienda', token: 'shpat_' + 'x'.repeat(30) });
    const r = await a.productos({ buscar: 'taza" OR status:any \\ {', limite: 5 });
    expect(r.productos[0]).toMatchObject({ id: '9', stock: 2, agotado: false, estado: 'active' });
    expect(JSON.parse(llamadas[0]!.cuerpo!).variables.q).toBe('title:*taza* title:*status* title:*any*');
    expect((await a.stockBajo({ umbral: 5, limite: 5 })).productos).toHaveLength(1);
    expect(await codigo(() => a.cupones({ limite: 5 }))).toBe('no_soportado');
    expect(await codigo(() => a.pedido('abc'))).toBe('no_encontrado');
    expect(await codigo(() => a.producto('1/2'))).toBe('no_encontrado');
  });
});

describe('VTEX', () => {
  const K = 'vtexappkey-archie-ABCDEF'; const T = 'T'.repeat(40);
  const pedidoV = (id: string, status = 'invoiced', total = 15990000) => ({ orderId: id, sequence: '5001', status, creationDate: '2026-10-01T10:00:00Z', totalValue: total, currencyCode: 'COP', totalItems: 2, clientName: 'Juan Perez', email: 'juan@correo.com', phone: '3001234567' });
  it('valida cuenta y arma el dominio', async () => {
    expect(cuentaVtex('https://Mi-Cuenta.vtexcommercestable.com.br/')).toBe('mi-cuenta');
    for (const x of ['a.com', 'mi cuenta', 'x/../y', '-x', 'mi-cuenta.evil.com']) expect(cuentaVtex(x), x).toBeNull();
    const { http, llamadas } = falso(() => json({ list: [pedidoV('1234-01')], paging: { total: 1, pages: 1 } }));
    const a = new AdaptadorVtex(http, { cuenta: 'mi-cuenta', appKey: K, appToken: T });
    await a.probar();
    expect(llamadas[0]).toMatchObject({ host: 'mi-cuenta.vtexcommercestable.com.br', metodo: 'GET' });
    expect(llamadas[0]!.cabeceras['X-VTEX-API-AppKey']).toBe(K); expect(llamadas[0]!.ruta).not.toContain(T);
    expect(() => new AdaptadorVtex(http, { cuenta: 'x', appKey: 'c', appToken: T })).toThrow(ErrorTienda);
  });
  it('convierte centavos a decimal exacto, mapea estados y no filtra datos personales', async () => {
    const { http, llamadas } = falso((p) => (p.ruta.startsWith('/api/oms/pvt/orders/') ? json({ ...pedidoV('1234-01'), items: [{ productId: '77', name: 'Zapato', refId: 'Z1', quantity: 2, sellingPrice: 7995000 }], totals: [{ id: 'Items', value: 15990000 }, { id: 'Shipping', value: 0 }], paymentData: { transactions: [{ payments: [{ paymentSystemName: 'Visa', cardNumber: '4111111111111111' }] }] }, shippingData: { address: { street: 'Calle 123 #45-67' }, logisticsInfo: [{ selectedSla: 'Normal' }] } })
      : json({ list: [pedidoV('1234-01'), pedidoV('1235-01', 'payment-pending', 100), pedidoV('1236-01', 'canceled')], paging: { total: 3, pages: 1 } })));
    const a = new AdaptadorVtex(http, { cuenta: 'mi-cuenta', appKey: K, appToken: T });
    const r = await a.pedidos({ estados: ['completado', 'pendiente'] }, 10, false);
    expect(r.pedidos.map((p) => [p.estado, p.total.monto])).toEqual([['completado', '159900.00'], ['pendiente', '1.00'], ['cancelado', '1.00']].map((x, i) => (i === 2 ? ['cancelado', '159900.00'] : x)));
    expect(llamadas[0]!.ruta).toContain('f_status=invoiced%2Cpayment-pending');
    const d = await a.pedido('1234-01');
    for (const x of [...PII, '4111111111111111']) expect(JSON.stringify([r, d])).not.toContain(x);
    expect(d).toMatchObject({ subtotal: { monto: '159900.00' }, metodoPago: 'Visa', metodoEnvio: 'Normal' });
  });
  it('lo no soportado lo dice claro', async () => {
    const { http } = falso(() => json({ list: [], paging: { total: 0, pages: 0 } }));
    const a = new AdaptadorVtex(http, { cuenta: 'mi-cuenta', appKey: K, appToken: T });
    expect(await codigo(() => a.pedidos({}, 5, true))).toBe('no_soportado');
    expect(await codigo(() => a.stockBajo({ umbral: 5, limite: 5 }))).toBe('no_soportado');
    expect(await codigo(() => a.cupones({ limite: 5 }))).toBe('no_soportado');
    expect(await codigo(() => a.pedido('../x'))).toBe('no_encontrado');
    expect((await a.pedidos({ estados: ['reembolsado'] }, 5, false)).pedidos).toEqual([]);
  });
  it('traduce errores', async () => {
    for (const [s, e] of [[401, 'credencial_rechazada'], [403, 'sin_permiso'], [429, 'limite'], [503, 'no_disponible']] as const) {
      expect(await codigo(() => new AdaptadorVtex(falso(() => ({ estado: s })).http, { cuenta: 'mi-cuenta', appKey: K, appToken: T }).pedidos({}, 1, false))).toBe(e);
    }
  });
});

describe('fábrica', () => {
  it('crea el adaptador de cada plataforma y valida credenciales', () => {
    const { http } = falso(() => ({}));
    expect(crearAdaptador({ plataforma: 'woocommerce', dominio: 'a.com', clave: CK, secreto: CS }, http).plataforma).toBe('woocommerce');
    expect(crearAdaptador({ plataforma: 'shopify', tienda: 'x', token: 'shpat_' + 'x'.repeat(30) }, http).plataforma).toBe('shopify');
    expect(crearAdaptador({ plataforma: 'vtex', cuenta: 'x', appKey: 'vtexappkey-1', appToken: 'T'.repeat(40) }, http).plataforma).toBe('vtex');
    expect(() => crearAdaptador({ plataforma: 'otra' } as never, http)).toThrow(ErrorTienda);
  });
});

describe('dinero', () => {
  it('suma exacta, centavos y promedio', () => {
    expect(sumarDinero([{ moneda: 'COP', monto: '0.1' }, { moneda: 'COP', monto: '0.2' }, { moneda: 'USD', monto: '5' }])).toEqual([{ moneda: 'COP', monto: '0.3' }, { moneda: 'USD', monto: '5' }]);
    expect(dineroDeMenor(5, 'COP')).toEqual({ moneda: 'COP', monto: '0.05' });
    expect(dineroDeMenor(-1234, 'COP')).toEqual({ moneda: 'COP', monto: '-12.34' });
    expect(promedioDinero({ moneda: 'COP', monto: '100' }, 3)).toEqual({ moneda: 'COP', monto: '33.33' });
    expect(promedioDinero({ moneda: 'COP', monto: '100' }, 0)).toBeNull();
  });
});

describe('periodos en hora de Bogotá', () => {
  it('hoy empieza a las 05:00 UTC y ayer cierra antes', () => {
    const ahora = new Date('2026-10-17T03:00:00Z'); // 16 oct 22:00 en Bogotá
    expect(rangoPeriodo('hoy', ahora)!.desde.toISOString()).toBe('2026-10-16T05:00:00.000Z');
    const ay = rangoPeriodo('ayer', ahora)!;
    expect(ay.desde.toISOString()).toBe('2026-10-15T05:00:00.000Z'); expect(ay.hasta.toISOString()).toBe('2026-10-16T04:59:59.999Z');
    expect(rangoPeriodo('mes_actual', ahora)!.desde.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(rangoPeriodo('mes_anterior', new Date('2026-01-10T12:00:00Z'))!.desde.toISOString()).toBe('2025-12-01T05:00:00.000Z');
    expect(rangoPeriodo('7_dias', ahora)!.desde.toISOString()).toBe('2026-10-10T05:00:00.000Z');
  });
  it('personalizado exige fechas reales, orden y máximo 366 días', () => {
    const ahora = new Date();
    expect(rangoPeriodo('personalizado', ahora, '2026-10-01', '2026-10-02')!.hasta.toISOString()).toBe('2026-10-03T04:59:59.999Z');
    for (const [d, h] of [['2026-02-30', '2026-03-01'], ['2026-10-05', '2026-10-01'], ['2024-01-01', '2026-01-01'], ['x', 'y']] as const) expect(rangoPeriodo('personalizado', ahora, d, h), `${d} ${h}`).toBeNull();
    expect(rangoPeriodo('personalizado', ahora)).toBeNull();
  });
});

describe('herramientas comunes', () => {
  const herr = (n: string) => HERRAMIENTAS_TIENDA.find((h) => h.nombre === n)!;
  const pedido = (id: string, monto: string, lineas: { productoId: string; nombre: string; cantidad: number }[] = []) => ({ id, numero: id, estado: 'pagado' as const, estadoOriginal: 'x', creado: '', total: { moneda: 'COP', monto }, articulos: 1, lineas: lineas.map((l) => ({ ...l, sku: null, precioUnitario: null })) });
  const adaptador = (over: Partial<AdaptadorTienda> = {}): AdaptadorTienda => ({
    plataforma: 'woocommerce', probar: async () => ({ nombre: null, moneda: null }),
    pedidos: async () => ({ pedidos: [pedido('1', '100'), pedido('2', '50.5')], truncado: false, total: 2 }),
    pedido: async () => { throw new ErrorTienda('no_encontrado'); }, productos: async () => ({ productos: [], total: 0 }), producto: async () => { throw new ErrorTienda('no_encontrado'); },
    stockBajo: async () => ({ productos: [], truncado: false }), cupones: async () => [], ...over,
  });
  const resolutor = (tiendas: Record<string, AdaptadorTienda>): ResolutorTiendas => ({
    listar: () => Object.keys(tiendas).map((nombre) => ({ nombre, plataforma: tiendas[nombre]!.plataforma })),
    obtener: async (nombre) => { const a = tiendas[nombre]; if (!a) throw new ErrorTienda('no_conectada'); return { nombre, plataforma: a.plataforma, adaptador: a }; },
  });
  const ctx = (r?: ResolutorTiendas) => ({ send: {} as never, contactosRestantes: 0, tiendas: r });
  const correr = async (n: string, entrada: object, r?: ResolutorTiendas) => { const h = herr(n); return (await h.ejecutar(ctx(r), h.entrada.parse(entrada))).datos as Record<string, any>; };

  it('todas son de lectura (nivel 1) y rechazan argumentos desconocidos', () => {
    for (const h of HERRAMIENTAS_TIENDA) {
      expect(h.nivel ?? 1).toBe(1); expect(h.nombre).toMatch(/^tiendas?_/);
      expect(h.entrada.safeParse({ inventado: 1 }).success, h.nombre).toBe(false);
      expect(JSON.stringify(h.schema)).not.toMatch(/email|correo|telefono|direccion|cliente/i);
    }
  });
  it('resumen de ventas: total exacto, ticket promedio y aviso de truncado', async () => {
    const d = await correr('tienda_resumen_ventas', { periodo: 'hoy' }, resolutor({ Principal: adaptador() }));
    expect(d).toMatchObject({ tienda: 'Principal', pedidos_contados: 2, truncado: false });
    expect(d.ventas_por_moneda[0]).toMatchObject({ moneda: 'COP', monto: '150.5', ticket_promedio: { monto: '75.25' } });
    const t = await correr('tienda_resumen_ventas', {}, resolutor({ A: adaptador({ pedidos: async () => ({ pedidos: [pedido('1', '1')], truncado: true, total: 999 }) }) }));
    expect(t.truncado).toBe(true); expect(t.aviso).toMatch(/parciales/);
  });
  it('pide la tienda cuando hay varias y falla claro si no existe', async () => {
    const r = resolutor({ A: adaptador(), B: adaptador({ plataforma: 'shopify' }) });
    expect((await correr('tienda_pedidos', {}, r)).error).toBe('indica_tienda');
    expect((await correr('tienda_pedidos', { tienda: 'B' }, r)).plataforma).toBe('shopify');
    await expect(correr('tienda_pedidos', { tienda: 'Z' }, r)).rejects.toMatchObject({ codigo: 'no_conectada' });
    expect((await correr('tienda_pedidos', {}, resolutor({}))).error).toBe('sin_tiendas');
    expect((await correr('tienda_pedidos', {}, undefined)).error).toBe('sin_tiendas');
    expect((await correr('tiendas_conectadas', {}, r)).tiendas).toHaveLength(2);
  });
  it('periodo personalizado inválido no consulta la tienda', async () => {
    let llamado = false;
    const r = resolutor({ A: adaptador({ pedidos: async () => { llamado = true; return { pedidos: [], truncado: false, total: 0 }; } }) });
    expect((await correr('tienda_resumen_ventas', { periodo: 'personalizado', desde: '2026-02-31', hasta: '2026-03-01' }, r)).error).toBe('periodo_invalido');
    expect(llamado).toBe(false);
  });
  it('más vendidos agrupa por producto, ordena por unidades y respeta el límite', async () => {
    const a = adaptador({ pedidos: async () => ({ pedidos: [
      pedido('1', '1', [{ productoId: '1', nombre: 'A', cantidad: 2 }, { productoId: '2', nombre: 'B', cantidad: 1 }]),
      pedido('2', '1', [{ productoId: '2', nombre: 'B', cantidad: 5 }]),
    ], truncado: false, total: 2 }) });
    const d = await correr('tienda_mas_vendidos', { limite: 1 }, resolutor({ A: a }));
    expect(d.productos).toEqual([{ productoId: '2', nombre: 'B', sku: null, unidades: 6, pedidos: 2 }]);
  });
  it('un error de la plataforma (no soportado) sube como ErrorTienda', async () => {
    const a = adaptador({ cupones: async () => { throw new ErrorTienda('no_soportado'); } });
    await expect(correr('tienda_cupones', {}, resolutor({ A: a }))).rejects.toMatchObject({ codigo: 'no_soportado' });
  });
});

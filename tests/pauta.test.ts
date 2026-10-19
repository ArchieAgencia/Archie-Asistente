import { describe, expect, it } from 'vitest';
import { ErrorHttpSeguro, type HttpSeguro, type PeticionSegura, type RespuestaSegura } from '../src/conectores/http-seguro.js';
import { AdaptadorMeta, cuentaMeta, VERSION_META } from '../src/conectores/pauta/meta.js';
import { AdaptadorTiktok } from '../src/conectores/pauta/tiktok.js';
import { crearAdaptadorPauta } from '../src/conectores/pauta/fabrica.js';
import { HERRAMIENTAS_PAUTA, periodoAnterior, periodoFechas, variacionPct, type ResolutorPauta } from '../src/conectores/pauta/herramientas.js';
import { dividirDinero, ErrorPauta, ordenar, porcentaje, type AdaptadorPauta, type Metricas } from '../src/conectores/pauta/tipos.js';

type Manejador = (p: PeticionSegura) => Partial<RespuestaSegura>;
function falso(m: Manejador) {
  const llamadas: PeticionSegura[] = [];
  const http = { pedir: async (p: PeticionSegura): Promise<RespuestaSegura> => { llamadas.push(p); return { estado: 200, cuerpo: '', cabeceras: {}, ...m(p) }; } } as unknown as HttpSeguro;
  return { http, llamadas };
}
const json = (v: unknown, estado = 200) => ({ estado, cuerpo: JSON.stringify(v), cabeceras: {} });
const codigo = async (f: () => Promise<unknown>) => { try { await f(); return 'sin_error'; } catch (e) { return e instanceof ErrorPauta ? e.codigo : `otro:${String(e)}`; } };

const TOKEN_M = `EAA${'x'.repeat(40)}`; const TOKEN_T = 'T'.repeat(40);
const P = { desde: '2026-10-01', hasta: '2026-10-07' };

describe('Meta Ads', () => {
  const fila = (id: string, nombre: string, spend: string, clicks: string, msgs: string | null) => ({
    campaign_id: id, campaign_name: nombre, spend, impressions: '10000', reach: '7000', clicks,
    actions: msgs ? [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: msgs }, { action_type: 'link_click', value: '120' }] : [],
    // datos que Meta nunca debería mandar aquí, pero que no deben salir si llegaran
    audience: 'Mujeres 25-34 Bogotá', lead_email: 'juan@correo.com',
  });
  const meta = (m: Manejador) => { const f = falso((p) => (p.ruta.includes('/insights') ? m(p) : json({ name: 'Cuenta Casa', currency: 'COP', timezone_name: 'America/Bogota' }))); return { ...f, a: new AdaptadorMeta(f.http, { cuenta: 'act_123456789', token: TOKEN_M }) }; };

  it('valida cuenta y token', () => {
    expect(cuentaMeta('act_123456789')).toBe('123456789'); expect(cuentaMeta(' 123456 ')).toBe('123456');
    for (const x of ['abc', '12', 'act_', '../x', '123/456', '12345678901234567890123']) expect(cuentaMeta(x), x).toBeNull();
    const { http } = falso(() => ({}));
    expect(() => new AdaptadorMeta(http, { cuenta: 'x', token: TOKEN_M })).toThrow(ErrorPauta);
    expect(() => new AdaptadorMeta(http, { cuenta: '123456', token: 'corto' })).toThrow(ErrorPauta);
  });
  it('host fijo, solo GET a rutas permitidas y el token nunca va en la URL', async () => {
    const { a, llamadas } = meta(() => json({ data: [] }));
    await a.probar(); await a.resumen(P); await a.ranking({ nivel: 'campana', periodo: P, orden: 'gasto', limite: 5 });
    for (const l of llamadas) {
      expect(l.host).toBe('graph.facebook.com'); expect(l.metodo).toBe('GET');
      expect(l.ruta).toMatch(new RegExp(`^/${VERSION_META.replace('.', '\\.')}/act_123456789(/insights)?\\?`));
      expect(l.cabeceras.Authorization).toBe(`Bearer ${TOKEN_M}`); expect(l.ruta).not.toContain(TOKEN_M);
    }
  });
  it('calcula CTR, CPC, CPM y costo por resultado con decimales exactos', async () => {
    const { a } = meta(() => json({ data: [fila('1', 'C', '1234.56', '250', '30')] }));
    const m = await a.resumen(P, 'mensajes');
    expect(m).toMatchObject({ gasto: { moneda: 'COP', monto: '1234.56' }, impresiones: 10000, alcance: 7000, clics: 250, ctrPct: '2.50', cpc: { monto: '4.94' }, cpm: { monto: '123.46' }, resultados: 30, costoPorResultado: { monto: '41.15' } });
    expect((await a.resumen(P)).resultados).toBeNull(); // sin tipo de resultado no se inventa
    expect((await a.resumen(P, 'compras')).resultados).toBe(0);
  });
  it('sin datos devuelve ceros y no revienta; no filtra audiencias ni datos de personas', async () => {
    const { a: vacio } = meta(() => json({ data: [] }));
    expect(await vacio.resumen(P)).toMatchObject({ impresiones: 0, clics: 0, ctrPct: null, cpc: null, cpm: null });
    const { a } = meta(() => json({ data: [fila('1', 'C', '10', '5', '1')], paging: {} }));
    const r = await a.ranking({ nivel: 'campana', periodo: P, resultado: 'mensajes', orden: 'gasto', limite: 5 });
    const s = JSON.stringify(r); for (const x of ['Mujeres', 'juan@correo.com', 'audience', 'lead_email']) expect(s).not.toContain(x);
  });
  it('ranking: pagina con cursor, ordena y marca truncado', async () => {
    let n = 0;
    const { a, llamadas } = meta(() => { n++; return json({ data: [fila(`${n}1`, `A${n}`, `${n * 100}`, '10', '10'), fila(`${n}2`, `B${n}`, `${n * 10}`, '10', '2')], paging: { cursors: { after: `cur${n}` }, ...(n < 2 ? { next: 'https://graph.facebook.com/lo-que-sea' } : {}) } }); });
    const r = await a.ranking({ nivel: 'campana', periodo: P, resultado: 'mensajes', orden: 'costo_por_resultado', limite: 2 });
    expect(llamadas.filter((l) => l.ruta.includes('/insights'))).toHaveLength(2);
    expect(new URLSearchParams(llamadas.filter((l) => l.ruta.includes('/insights'))[1]!.ruta.split('?')[1]).get('after')).toBe('cur1'); // usa el cursor, nunca la URL «next»
    expect(llamadas.every((l) => l.host === 'graph.facebook.com')).toBe(true);
    expect(r.filas).toHaveLength(2); expect(r.truncado).toBe(true);
    expect(r.filas[0]!.nombre).toBe('B1'); expect(Number(r.filas[0]!.metricas.costoPorResultado!.monto)).toBeLessThanOrEqual(Number(r.filas[1]!.metricas.costoPorResultado!.monto));
    const topes = meta(() => json({ data: [fila('1', 'X', '1', '1', '1')], paging: { cursors: { after: 'c' }, next: 'x' } }));
    await topes.a.ranking({ nivel: 'anuncio', periodo: P, orden: 'gasto', limite: 5 });
    expect(topes.llamadas.filter((l) => l.ruta.includes('/insights')).length).toBeLessThanOrEqual(5);
  });
  it('traduce errores por el código de Meta sin exponer el cuerpo', async () => {
    const casos: [number, number, string][] = [[400, 190, 'credencial_rechazada'], [400, 10, 'sin_permiso'], [400, 200, 'sin_permiso'], [400, 17, 'limite'], [400, 4, 'limite'], [500, 2, 'no_disponible'], [400, 999, 'respuesta_invalida'], [401, 0, 'credencial_rechazada'], [429, 0, 'limite']];
    for (const [estado, code, esperado] of casos) {
      const f = falso(() => ({ estado, cuerpo: JSON.stringify({ error: { code, message: 'SECRETO-INTERNO token EAAxx' } }) }));
      const a = new AdaptadorMeta(f.http, { cuenta: '123456', token: TOKEN_M });
      let msg = ''; const c = await codigo(async () => { try { await a.probar(); } catch (e) { msg = (e as Error).message; throw e; } });
      expect(c, `${estado}/${code}`).toBe(esperado); expect(msg).not.toContain('SECRETO');
    }
    for (const [c, e] of [['direccion_no_permitida', 'direccion_no_permitida'], ['tiempo_agotado', 'tiempo_agotado'], ['no_disponible', 'no_disponible'], ['redireccion', 'respuesta_invalida']] as const) {
      const { http } = falso(() => { throw new ErrorHttpSeguro(c); });
      expect(await codigo(() => new AdaptadorMeta(http, { cuenta: '123456', token: TOKEN_M }).probar())).toBe(e);
    }
  });
});

describe('TikTok Ads', () => {
  const tk = (m: (p: PeticionSegura) => unknown) => {
    const f = falso((p) => json(p.ruta.includes('advertiser/info') ? { code: 0, data: { list: [{ name: 'Anunciante', currency: 'COP', timezone: 'America/Bogota' }] } } : m(p)));
    return { ...f, a: new AdaptadorTiktok(f.http, { anunciante: '7000000001', token: TOKEN_T }) };
  };
  const fila = (id: string, nombre: string, spend: string, result: string) => ({ dimensions: { campaign_id: id }, metrics: { campaign_name: nombre, spend, impressions: '5000', reach: '4000', clicks: '100', result } });
  it('host fijo, cabecera Access-Token y rutas permitidas', async () => {
    const { a, llamadas } = tk(() => ({ code: 0, data: { list: [] } }));
    await a.probar(); await a.resumen(P);
    for (const l of llamadas) { expect(l.host).toBe('business-api.tiktok.com'); expect(l.metodo).toBe('GET'); expect(l.cabeceras['Access-Token']).toBe(TOKEN_T); expect(l.ruta).not.toContain(TOKEN_T); expect(l.ruta).toMatch(/^\/open_api\/v1\.3\/(advertiser\/info|report\/integrated\/get)\/\?/); }
  });
  it('ranking con paginación y métricas exactas', async () => {
    let pag = 0;
    const { a } = tk(() => { pag++; return { code: 0, data: { list: [fila(`${pag}1`, `Camp ${pag}`, '100.50', '10')], page_info: { total_page: 2 } } }; });
    const r = await a.ranking({ nivel: 'campana', periodo: P, orden: 'gasto', limite: 5 });
    expect(r.filas).toHaveLength(2); expect(r.truncado).toBe(false);
    expect(r.filas[0]!.metricas).toMatchObject({ gasto: { monto: '100.50' }, clics: 100, ctrPct: '2.00', resultados: 10, costoPorResultado: { monto: '10.05' } });
  });
  it('un resultado concreto aún no está soportado en TikTok y los códigos de error se traducen', async () => {
    const { a } = tk(() => ({ code: 0, data: { list: [] } }));
    expect(await codigo(() => a.resumen(P, 'compras'))).toBe('no_soportado');
    for (const [c, e] of [[40100, 'limite'], [40105, 'credencial_rechazada'], [40300, 'sin_permiso'], [50000, 'no_disponible'], [40001, 'respuesta_invalida']] as const) {
      const { a: b } = tk(() => ({ code: c, message: 'SECRETO-INTERNO' }));
      expect(await codigo(() => b.resumen(P)), String(c)).toBe(e);
    }
    const f = falso(() => json({ code: 0, data: { list: [] } }));
    expect(await codigo(() => new AdaptadorTiktok(f.http, { anunciante: '7000000001', token: TOKEN_T }).probar())).toBe('no_encontrado');
    expect(() => new AdaptadorTiktok(f.http, { anunciante: 'abc', token: TOKEN_T })).toThrow(ErrorPauta);
  });
  it('la fábrica crea cada plataforma', () => {
    const { http } = falso(() => ({}));
    expect(crearAdaptadorPauta({ plataforma: 'meta', cuenta: '123456', token: TOKEN_M }, http).plataforma).toBe('meta');
    expect(crearAdaptadorPauta({ plataforma: 'tiktok', anunciante: '7000000001', token: TOKEN_T }, http).plataforma).toBe('tiktok');
    expect(() => crearAdaptadorPauta({ plataforma: 'otra' } as never, http)).toThrow(ErrorPauta);
  });
});

describe('números y periodos', () => {
  it('divisiones y porcentajes exactos', () => {
    expect(dividirDinero({ moneda: 'COP', monto: '100' }, 3)).toEqual({ moneda: 'COP', monto: '33.33' });
    expect(dividirDinero({ moneda: 'COP', monto: '100' }, 0)).toBeNull(); expect(dividirDinero(null, 5)).toBeNull();
    expect(porcentaje(1, 3)).toBe('33.33'); expect(porcentaje(5, 0)).toBeNull();
  });
  it('periodos en fechas de Bogotá y periodo anterior de igual duración', () => {
    const ahora = new Date('2026-10-17T03:00:00Z'); // 16 oct 22:00 en Bogotá
    expect(periodoFechas({ periodo: 'hoy' }, ahora)!.fechas).toEqual({ desde: '2026-10-16', hasta: '2026-10-16' });
    expect(periodoFechas({ periodo: 'ayer' }, ahora)!.fechas).toEqual({ desde: '2026-10-15', hasta: '2026-10-15' });
    expect(periodoFechas({ periodo: '7_dias' }, ahora)!.fechas).toEqual({ desde: '2026-10-10', hasta: '2026-10-16' });
    expect(periodoFechas({ periodo: 'personalizado', desde: '2026-02-30', hasta: '2026-03-01' }, ahora)).toBeNull();
    expect(periodoAnterior({ desde: '2026-10-10', hasta: '2026-10-16' })).toEqual({ desde: '2026-10-03', hasta: '2026-10-09' });
    expect(periodoAnterior({ desde: '2026-03-01', hasta: '2026-03-01' })).toEqual({ desde: '2026-02-28', hasta: '2026-02-28' });
    expect(variacionPct(150, 100)).toBe('50.0'); expect(variacionPct(5, 0)).toBeNull();
  });
  it('ordena: el costo por resultado va de menor a mayor y sin resultados al final', () => {
    const m = (cpr: string | null): Metricas => ({ gasto: null, impresiones: 0, alcance: null, clics: 0, ctrPct: null, cpc: null, cpm: null, resultados: cpr ? 1 : 0, costoPorResultado: cpr ? { moneda: 'COP', monto: cpr } : null });
    const f = (id: string, cpr: string | null) => ({ id, nombre: id, metricas: m(cpr) });
    expect(ordenar([f('a', '30'), f('b', null), f('c', '5')], 'costo_por_resultado').map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('herramientas de pauta', () => {
  const herr = (n: string) => HERRAMIENTAS_PAUTA.find((h) => h.nombre === n)!;
  const met = (gasto: string, clics: number, res: number | null = null): Metricas => ({ gasto: { moneda: 'COP', monto: gasto }, impresiones: 1000, alcance: null, clics, ctrPct: null, cpc: null, cpm: null, resultados: res, costoPorResultado: null });
  const adaptador = (over: Partial<AdaptadorPauta> = {}): AdaptadorPauta => ({
    plataforma: 'meta', probar: async () => ({ nombre: null, moneda: 'COP', zonaHoraria: null }),
    resumen: async (p) => (p.desde < '2026-10-05' ? met('100', 10) : met('150', 30)), ranking: async () => ({ filas: [], truncado: false }), ...over,
  });
  const resolutor = (c: Record<string, AdaptadorPauta>): ResolutorPauta => ({
    listar: () => Object.keys(c).map((nombre) => ({ nombre, plataforma: c[nombre]!.plataforma })),
    obtener: async (n) => { const a = c[n]; if (!a) throw new ErrorPauta('no_conectada'); return { nombre: n, plataforma: a.plataforma, adaptador: a }; },
  });
  const correr = async (n: string, entrada: object, r?: ResolutorPauta) => { const h = herr(n); return (await h.ejecutar({ send: {} as never, contactosRestantes: 0, pauta: r }, h.entrada.parse(entrada))).datos as Record<string, any>; };

  it('son de lectura, rechazan argumentos desconocidos y no mencionan personas', () => {
    for (const h of HERRAMIENTAS_PAUTA) {
      expect(h.nivel ?? 1).toBe(1); expect(h.entrada.safeParse({ inventado: 1 }).success, h.nombre).toBe(false);
      expect(JSON.stringify(h.schema)).not.toMatch(/email|correo|telefono|audiencia|lead\b/i);
    }
  });
  it('pide elegir cuenta cuando hay varias; error claro si no existe o no hay ninguna', async () => {
    const r = resolutor({ A: adaptador(), B: adaptador({ plataforma: 'tiktok' }) });
    expect((await correr('pauta_resumen', {}, r)).error).toBe('indica_cuenta');
    expect((await correr('pauta_resumen', { cuenta: 'B' }, r)).plataforma).toBe('tiktok');
    await expect(correr('pauta_resumen', { cuenta: 'Z' }, r)).rejects.toMatchObject({ codigo: 'no_conectada' });
    expect((await correr('pauta_resumen', {}, resolutor({}))).error).toBe('sin_cuentas');
    expect((await correr('pauta_cuentas', {}, r)).cuentas).toHaveLength(2);
  });
  it('comparar calcula variaciones contra el periodo anterior', async () => {
    const d = await correr('pauta_comparar', { periodo: 'personalizado', desde: '2026-10-05', hasta: '2026-10-11' }, resolutor({ A: adaptador() }));
    expect(d.periodo_anterior).toEqual({ desde: '2026-09-28', hasta: '2026-10-04' });
    expect(d.variacion_pct).toMatchObject({ gasto: '50.0', clics: '200.0' });
  });
  it('periodo inválido no consulta; un error de la plataforma sube como ErrorPauta', async () => {
    let llamado = false;
    const r = resolutor({ A: adaptador({ resumen: async () => { llamado = true; throw new ErrorPauta('credencial_rechazada'); } }) });
    expect((await correr('pauta_resumen', { periodo: 'personalizado', desde: '2026-10-09', hasta: '2026-10-01' }, r)).error).toBe('periodo_invalido');
    expect(llamado).toBe(false);
    await expect(correr('pauta_resumen', {}, r)).rejects.toMatchObject({ codigo: 'credencial_rechazada' });
  });
});

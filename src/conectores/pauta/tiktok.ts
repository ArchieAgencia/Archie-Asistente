import type { HttpSeguro } from '../http-seguro.js';
import { ClienteApi } from '../tiendas/base.js';
import { arr, limpiar, obj } from '../tiendas/tipos.js';
import {
  armarMetricas, cuentaOpc, errorDesdeCodigo, ErrorPauta, ordenar, type AdaptadorPauta, type CodigoPauta, type FilaPauta, type InfoCuenta, type Metricas,
  type NivelPauta, type OrdenPauta, type PeriodoFechas, type ResultadoFilas, type TipoResultado,
} from './tipos.js';

export interface CredencialTiktok { anunciante: string; token: string }
export const TOKEN_TIKTOK = /^[A-Za-z0-9_.-]{16,300}$/;
/** Por verificar con una cuenta real: host, versión y rutas de la API de TikTok for Business (no se pudo leer su documentación desde aquí). */
const HOST = 'business-api.tiktok.com';
const BASE = '/open_api/v1.3';
const RUTAS = [/^\/open_api\/v1\.3\/advertiser\/info\/$/, /^\/open_api\/v1\.3\/report\/integrated\/get\/$/];
const TOPE_PAGINAS = 5;
const POR_PAGINA = 100;

export const anuncianteTiktok = (entrada: string): string | null => (/^\d{5,25}$/.test(entrada.trim()) ? entrada.trim() : null);

const NIVEL: Record<NivelPauta, { data_level: string; id: string; nombre: string }> = {
  campana: { data_level: 'AUCTION_CAMPAIGN', id: 'campaign_id', nombre: 'campaign_name' },
  conjunto: { data_level: 'AUCTION_ADGROUP', id: 'adgroup_id', nombre: 'adgroup_name' },
  anuncio: { data_level: 'AUCTION_AD', id: 'ad_id', nombre: 'ad_name' },
};

/** TikTok responde HTTP 200 con un «code» distinto de 0 cuando falla. Códigos por verificar. */
function codigoDe(c: number): CodigoPauta {
  if (c === 40100) return 'limite';
  if ([40102, 40104, 40105, 40106].includes(c)) return 'credencial_rechazada';
  if (c >= 40300 && c < 40400) return 'sin_permiso';
  if (c >= 50000 && c < 60000) return 'no_disponible';
  return 'respuesta_invalida';
}

export class AdaptadorTiktok implements AdaptadorPauta {
  readonly plataforma = 'tiktok' as const;
  private readonly api: ClienteApi;
  private readonly id: string;
  private monedaCache: string | null | undefined;

  constructor(http: HttpSeguro, cred: CredencialTiktok) {
    const id = anuncianteTiktok(cred.anunciante);
    if (!id || !TOKEN_TIKTOK.test(cred.token)) throw new ErrorPauta('credencial_rechazada');
    this.id = id;
    this.api = new ClienteApi(http, HOST, { 'Access-Token': cred.token }, RUTAS, undefined, errorDesdeCodigo);
  }

  private async llamar(ruta: string, consulta: Record<string, string | number>): Promise<Record<string, unknown>> {
    const r = obj((await this.api.json('GET', ruta, consulta)).datos);
    const codigo = typeof r.code === 'number' ? r.code : -1;
    if (codigo !== 0) throw new ErrorPauta(codigoDe(codigo));
    return obj(r.data);
  }

  async probar(): Promise<InfoCuenta> {
    const d = await this.llamar(`${BASE}/advertiser/info/`, { advertiser_ids: JSON.stringify([this.id]), fields: JSON.stringify(['name', 'currency', 'timezone']) });
    const a = obj(arr(d.list)[0]);
    if (!Object.keys(a).length) throw new ErrorPauta('no_encontrado');
    const m = limpiar(a.currency, 3);
    this.monedaCache = m && /^[A-Za-z]{3}$/.test(m) ? m.toUpperCase() : null;
    return { nombre: limpiar(a.name, 100), moneda: this.monedaCache, zonaHoraria: limpiar(a.timezone, 60) };
  }

  private async moneda(): Promise<string | null> {
    if (this.monedaCache === undefined) await this.probar();
    return this.monedaCache ?? null;
  }

  private metricas(m: Record<string, unknown>, moneda: string | null, resultado: TipoResultado | undefined): Metricas {
    // Sin tipo de resultado se usa el «result» del objetivo de la campaña (por verificar); con tipo concreto, TikTok aún no está soportado.
    return armarMetricas({ gasto: m.spend ?? '0', moneda, impresiones: m.impressions, alcance: m.reach, clics: m.clicks, resultados: resultado ? null : cuentaOpc(m.result) });
  }

  private async reporte(o: { nivel: 'AUCTION_ADVERTISER' | NivelPauta; periodo: PeriodoFechas; pagina: number; resultado?: TipoResultado }) {
    if (o.resultado) throw new ErrorPauta('no_soportado');
    const n = o.nivel === 'AUCTION_ADVERTISER' ? { data_level: 'AUCTION_ADVERTISER', id: 'advertiser_id', nombre: '' } : NIVEL[o.nivel];
    return this.llamar(`${BASE}/report/integrated/get/`, {
      advertiser_id: this.id, report_type: 'BASIC', data_level: n.data_level, dimensions: JSON.stringify([n.id]),
      metrics: JSON.stringify(['spend', 'impressions', 'reach', 'clicks', 'result', ...(n.nombre ? [n.nombre] : [])]),
      start_date: o.periodo.desde, end_date: o.periodo.hasta, page: o.pagina, page_size: POR_PAGINA,
    });
  }

  async resumen(p: PeriodoFechas, resultado?: TipoResultado): Promise<Metricas> {
    const moneda = await this.moneda();
    const d = await this.reporte({ nivel: 'AUCTION_ADVERTISER', periodo: p, pagina: 1, resultado });
    return this.metricas(obj(obj(arr(d.list)[0]).metrics), moneda, resultado);
  }

  async ranking(o: { nivel: NivelPauta; periodo: PeriodoFechas; resultado?: TipoResultado; orden: OrdenPauta; limite: number }): Promise<ResultadoFilas> {
    const moneda = await this.moneda();
    const n = NIVEL[o.nivel];
    const filas: FilaPauta[] = []; let hayMas = false;
    for (let pagina = 1; pagina <= TOPE_PAGINAS; pagina++) {
      const d = await this.reporte({ nivel: o.nivel, periodo: o.periodo, pagina, resultado: o.resultado });
      for (const f of arr(d.list)) {
        const x = obj(f); const id = limpiar(obj(x.dimensions)[n.id], 40); const m = obj(x.metrics);
        if (id && /^\d{1,25}$/.test(id)) filas.push({ id, nombre: limpiar(m[n.nombre]) ?? '(sin nombre)', metricas: this.metricas(m, moneda, o.resultado) });
      }
      const total = cuentaOpc(obj(d.page_info).total_page) ?? 1;
      hayMas = pagina < total;
      if (!hayMas) break;
    }
    const orden = ordenar(filas, o.orden);
    return { filas: orden.slice(0, o.limite), truncado: orden.length > o.limite || hayMas };
  }
}

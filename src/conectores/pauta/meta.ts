import type { HttpSeguro } from '../http-seguro.js';
import { ClienteApi } from '../tiendas/base.js';
import { arr, limpiar, obj, type CodigoTienda } from '../tiendas/tipos.js';
import {
  armarMetricas, errorDesdeCodigo, ErrorPauta, ordenar, type AdaptadorPauta, type FilaPauta, type InfoCuenta, type Metricas, type NivelPauta, type OrdenPauta,
  type PeriodoFechas, type ResultadoFilas, type TipoResultado,
} from './tipos.js';

export interface CredencialMeta { cuenta: string; token: string }
/** Versión de la API de marketing de Meta (vista en su documentación). Constante fácil de actualizar; por verificar al probar con una cuenta real. */
export const VERSION_META = 'v25.0';
export const TOKEN_META = /^[A-Za-z0-9_|.-]{20,500}$/;
const HOST = 'graph.facebook.com';

/** «act_123456», «123456» → «123456»; null si no es válido. */
export function cuentaMeta(entrada: string): string | null {
  const t = entrada.trim().toLowerCase().replace(/^act_/, '');
  return /^\d{5,20}$/.test(t) ? t : null;
}

const NIVEL: Record<NivelPauta, { level: string; id: string; nombre: string }> = {
  campana: { level: 'campaign', id: 'campaign_id', nombre: 'campaign_name' },
  conjunto: { level: 'adset', id: 'adset_id', nombre: 'adset_name' },
  anuncio: { level: 'ad', id: 'ad_id', nombre: 'ad_name' },
};
/** Qué tipo de acción de Meta cuenta como cada resultado; se toma el primero que exista para no duplicar. Por verificar con una cuenta real. */
const ACCION: Record<TipoResultado, string[]> = {
  mensajes: ['onsite_conversion.messaging_conversation_started_7d'],
  compras: ['purchase', 'omni_purchase'],
  leads: ['lead', 'onsite_conversion.lead_grouped'],
  clics_enlace: ['link_click'],
};
const TOPE_PAGINAS = 5;
const POR_PAGINA = 100;

/** Meta devuelve el motivo en el cuerpo (HTTP 400): se traduce a un código y el cuerpo no se muestra a nadie. Códigos por verificar. */
function interpretar(estado: number, cuerpo: string): CodigoTienda | undefined {
  let e: Record<string, unknown>;
  try { e = obj(obj(JSON.parse(cuerpo)).error); } catch { return undefined; }
  const c = typeof e.code === 'number' ? e.code : NaN;
  if (c === 190 || c === 102) return 'credencial_rechazada';
  if (c === 10 || c === 200 || (c >= 200 && c <= 299)) return 'sin_permiso';
  if ([4, 17, 32, 613, 80000, 80003, 80004].includes(c)) return 'limite';
  if (c === 100 && estado === 400 && /does not exist|unsupported get request/i.test(String(e.message ?? ''))) return 'no_encontrado';
  if (c === 1 || c === 2) return 'no_disponible';
  return undefined;
}

export class AdaptadorMeta implements AdaptadorPauta {
  readonly plataforma = 'meta' as const;
  private readonly api: ClienteApi;
  private readonly act: string;
  private monedaCache: string | null | undefined;

  constructor(http: HttpSeguro, cred: CredencialMeta) {
    const id = cuentaMeta(cred.cuenta);
    if (!id || !TOKEN_META.test(cred.token)) throw new ErrorPauta('credencial_rechazada');
    this.act = `act_${id}`;
    const v = VERSION_META.replace('.', '\\.');
    this.api = new ClienteApi(http, HOST, { Authorization: `Bearer ${cred.token}` }, [new RegExp(`^/${v}/act_\\d{5,20}$`), new RegExp(`^/${v}/act_\\d{5,20}/insights$`)],
      interpretar, errorDesdeCodigo);
  }

  async probar(): Promise<InfoCuenta> {
    const d = obj((await this.api.json('GET', `/${VERSION_META}/${this.act}`, { fields: 'name,currency,timezone_name' })).datos);
    const moneda = limpiar(d.currency, 3);
    this.monedaCache = moneda && /^[A-Za-z]{3}$/.test(moneda) ? moneda.toUpperCase() : null;
    return { nombre: limpiar(d.name, 100), moneda: this.monedaCache, zonaHoraria: limpiar(d.timezone_name, 60) };
  }

  private async moneda(): Promise<string | null> {
    if (this.monedaCache === undefined) await this.probar();
    return this.monedaCache ?? null;
  }

  private resultados(o: Record<string, unknown>, r?: TipoResultado): number | null {
    if (!r) return null;
    const acciones = arr(o.actions).map(obj);
    for (const tipo of ACCION[r]) {
      const a = acciones.find((x) => x.action_type === tipo);
      if (a) { const n = Number(a.value); return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0; }
    }
    return 0;
  }

  private metricas(o: Record<string, unknown>, moneda: string | null, r?: TipoResultado): Metricas {
    return armarMetricas({ gasto: o.spend ?? '0', moneda, impresiones: o.impressions, alcance: o.reach, clics: o.clicks, resultados: this.resultados(o, r) });
  }

  async resumen(p: PeriodoFechas, resultado?: TipoResultado): Promise<Metricas> {
    const moneda = await this.moneda();
    const d = obj((await this.api.json('GET', `/${VERSION_META}/${this.act}/insights`, {
      fields: 'spend,impressions,reach,clicks,actions', level: 'account', time_range: JSON.stringify({ since: p.desde, until: p.hasta }), limit: 1,
    })).datos);
    return this.metricas(obj(arr(d.data)[0]), moneda, resultado);
  }

  async ranking(o: { nivel: NivelPauta; periodo: PeriodoFechas; resultado?: TipoResultado; orden: OrdenPauta; limite: number }): Promise<ResultadoFilas> {
    const moneda = await this.moneda();
    const n = NIVEL[o.nivel];
    const filas: FilaPauta[] = []; let despues: string | undefined; let hayMas = false;
    for (let pagina = 0; pagina < TOPE_PAGINAS; pagina++) {
      const d = obj((await this.api.json('GET', `/${VERSION_META}/${this.act}/insights`, {
        fields: `${n.id},${n.nombre},spend,impressions,reach,clicks,actions`, level: n.level, time_range: JSON.stringify({ since: o.periodo.desde, until: o.periodo.hasta }), limit: POR_PAGINA, after: despues,
      })).datos);
      for (const f of arr(d.data)) {
        const x = obj(f); const id = limpiar(x[n.id], 40);
        if (id && /^\d{1,25}$/.test(id)) filas.push({ id, nombre: limpiar(x[n.nombre]) ?? '(sin nombre)', metricas: this.metricas(x, moneda, o.resultado) });
      }
      const pg = obj(d.paging);
      despues = limpiar(obj(pg.cursors).after, 300) ?? undefined;
      hayMas = typeof pg.next === 'string' && Boolean(despues);
      if (!hayMas) break;
    }
    const orden = ordenar(filas, o.orden);
    return { filas: orden.slice(0, o.limite), truncado: orden.length > o.limite || hayMas };
  }
}

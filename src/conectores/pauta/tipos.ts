/**
 * Formato común de pauta digital (Meta Ads, TikTok Ads). Solo métricas agregadas: no hay campos para personas
 * (ni audiencias, ni leads, ni nombres), así que ningún adaptador puede devolverlos.
 */
import { dinero, type CodigoTienda, type Dinero } from '../tiendas/tipos.js';

export type PlataformaPauta = 'meta' | 'tiktok';
export const PLATAFORMAS_PAUTA: PlataformaPauta[] = ['meta', 'tiktok'];

export type CodigoPauta =
  | 'credencial_rechazada' | 'sin_permiso' | 'no_encontrado' | 'limite' | 'tiempo_agotado' | 'no_disponible'
  | 'respuesta_invalida' | 'direccion_no_permitida' | 'no_soportado' | 'no_conectada';

export const MENSAJES_PAUTA: Record<CodigoPauta, string> = {
  credencial_rechazada: 'La plataforma rechazó el acceso conectado (token vencido o revocado). Un administrador debe crear uno nuevo en Conexiones.',
  sin_permiso: 'El acceso conectado no tiene permiso para ver esto en la cuenta publicitaria.',
  no_encontrado: 'La plataforma no encontró la cuenta publicitaria.',
  limite: 'La plataforma pidió esperar un momento (límite de peticiones). Inténtalo en un minuto.',
  tiempo_agotado: 'La plataforma tardó demasiado en responder.',
  no_disponible: 'No se pudo conectar con la plataforma en este momento.',
  respuesta_invalida: 'La plataforma respondió algo que no se pudo leer.',
  direccion_no_permitida: 'La dirección de la plataforma no es válida o no está permitida.',
  no_soportado: 'Esa consulta todavía no está disponible para esta plataforma.',
  no_conectada: 'Esa cuenta publicitaria no está conectada. Un administrador debe conectarla en Conexiones.',
};

export class ErrorPauta extends Error {
  constructor(readonly codigo: CodigoPauta, readonly http?: number) { super(MENSAJES_PAUTA[codigo]); }
}

/** Para el cliente HTTP común: los códigos de tienda se traducen a los de pauta. */
export const errorDesdeCodigo = (c: CodigoTienda, h?: number): ErrorPauta => new ErrorPauta(c === 'periodo_fuera_de_alcance' ? 'no_soportado' : c, h);

/** Qué cuenta como «resultado» de una campaña. Cada plataforma lo traduce a su propia métrica. */
export type TipoResultado = 'mensajes' | 'compras' | 'leads' | 'clics_enlace';
export const TIPOS_RESULTADO: TipoResultado[] = ['mensajes', 'compras', 'leads', 'clics_enlace'];

export interface Metricas {
  gasto: Dinero | null;
  impresiones: number;
  /** Personas únicas alcanzadas. No se puede sumar entre filas ni periodos. */
  alcance: number | null;
  clics: number;
  /** Porcentaje con 2 decimales, calculado aquí: clics ÷ impresiones. */
  ctrPct: string | null;
  cpc: Dinero | null;
  cpm: Dinero | null;
  /** null = no se pidió un tipo de resultado o la plataforma no lo entrega. */
  resultados: number | null;
  costoPorResultado: Dinero | null;
}
export interface FilaPauta { id: string; nombre: string; metricas: Metricas }

export type NivelPauta = 'campana' | 'conjunto' | 'anuncio';
export type OrdenPauta = 'gasto' | 'resultados' | 'clics' | 'impresiones' | 'costo_por_resultado';
/** Fechas AAAA-MM-DD en la zona horaria de la cuenta publicitaria. */
export interface PeriodoFechas { desde: string; hasta: string }
export interface InfoCuenta { nombre: string | null; moneda: string | null; zonaHoraria: string | null }
export interface ResultadoFilas { filas: FilaPauta[]; truncado: boolean }

export interface AdaptadorPauta {
  readonly plataforma: PlataformaPauta;
  probar(): Promise<InfoCuenta>;
  resumen(p: PeriodoFechas, resultado?: TipoResultado): Promise<Metricas>;
  ranking(o: { nivel: NivelPauta; periodo: PeriodoFechas; resultado?: TipoResultado; orden: OrdenPauta; limite: number }): Promise<ResultadoFilas>;
}

// ---------- Números exactos ----------
const ESC = 6;
const aEscala = (d: Dinero): bigint => {
  const neg = d.monto.startsWith('-');
  const [e, f = ''] = d.monto.replace('-', '').split('.');
  return BigInt(e! + f.padEnd(ESC, '0')) * (neg ? -1n : 1n);
};
const texto = (q: bigint, dec: number): string => {
  const neg = q < 0n; const s = (neg ? -q : q).toString().padStart(dec + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, s.length - dec)}.${s.slice(-dec)}`;
};
/** d × por ÷ n con 2 decimales, redondeo al más cercano. null si n no es positivo. */
export function dividirDinero(d: Dinero | null, n: number, por = 1n): Dinero | null {
  if (!d || !Number.isSafeInteger(n) || n <= 0) return null;
  const num = aEscala(d) * 100n * por; const den = BigInt(n) * 10n ** BigInt(ESC);
  return { moneda: d.moneda, monto: texto((num * 2n + (num < 0n ? -den : den)) / (den * 2n), 2) };
}
/** Una fracción como porcentaje con 2 decimales: a ÷ b × 100. */
export function porcentaje(a: number, b: number): string | null {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= 0 || a < 0) return null;
  const num = BigInt(a) * 10_000n; const den = BigInt(b);
  return texto((num * 2n + den) / (den * 2n), 2);
}
/** Entero no negativo desde un texto o número de la plataforma; 0 si falta (sin datos). */
export const cuenta = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}(?:\.0+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
export const cuentaOpc = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : cuenta(v));

/** Arma las métricas completas con las derivadas calculadas aquí (no se confía en decimales de punto flotante de la plataforma). */
export function armarMetricas(o: { gasto: unknown; moneda: string | null; impresiones: unknown; alcance?: unknown; clics: unknown; resultados: number | null }): Metricas {
  const gasto = o.moneda ? dinero(o.gasto, o.moneda) : null;
  const impresiones = cuenta(o.impresiones); const clics = cuenta(o.clics);
  return {
    gasto, impresiones, alcance: cuentaOpc(o.alcance), clics,
    ctrPct: porcentaje(clics, impresiones),
    cpc: dividirDinero(gasto, clics),
    cpm: dividirDinero(gasto, impresiones, 1000n),
    resultados: o.resultados,
    costoPorResultado: o.resultados && o.resultados > 0 ? dividirDinero(gasto, o.resultados) : null,
  };
}

const valor = (m: Metricas, o: OrdenPauta): number => {
  switch (o) {
    case 'gasto': return m.gasto ? Number(aEscala(m.gasto)) : 0;
    case 'resultados': return m.resultados ?? 0;
    case 'clics': return m.clics;
    case 'impresiones': return m.impresiones;
    case 'costo_por_resultado': return m.costoPorResultado ? Number(aEscala(m.costoPorResultado)) : Number.POSITIVE_INFINITY;
  }
};
/** Orden local. El costo por resultado va de menor a mayor (el más barato primero); lo demás, de mayor a menor. */
export function ordenar(filas: FilaPauta[], orden: OrdenPauta): FilaPauta[] {
  const dir = orden === 'costo_por_resultado' ? 1 : -1;
  return [...filas].sort((a, b) => {
    const x = valor(a.metricas, orden); const y = valor(b.metricas, orden);
    return x === y ? 0 : (x < y ? -1 : 1) * dir;
  });
}

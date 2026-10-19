import { z } from 'zod';
import type { ContextoHerramienta, Herramienta } from '../send-herramientas.js';
import { PERIODOS, rangoPeriodo } from '../tiendas/herramientas.js';
import { TIPOS_RESULTADO, type AdaptadorPauta, type Metricas, type NivelPauta, type OrdenPauta, type PeriodoFechas, type PlataformaPauta } from './tipos.js';

/** Herramientas de LECTURA de pauta digital (nivel 1). Iguales para Meta y TikTok. Solo métricas agregadas. */

export interface CuentaElegida { nombre: string; plataforma: PlataformaPauta; adaptador: AdaptadorPauta }
export interface ResolutorPauta {
  listar(): { nombre: string; plataforma: PlataformaPauta }[];
  /** Lanza ErrorPauta('no_conectada') si no existe. */
  obtener(nombre: string): Promise<CuentaElegida>;
}

const MAX_FILAS = 20;
const OFFSET_BOGOTA = 5 * 3_600_000;
const DIA = 86_400_000;
const NIVELES: NivelPauta[] = ['campana', 'conjunto', 'anuncio'];
const ORDENES: OrdenPauta[] = ['gasto', 'resultados', 'clics', 'impresiones', 'costo_por_resultado'];
const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nombreCuenta = z.string().trim().min(1).max(60).optional();

const aFecha = (d: Date) => new Date(d.getTime() - OFFSET_BOGOTA).toISOString().slice(0, 10);
const sumarDias = (f: string, n: number) => new Date(Date.parse(`${f}T00:00:00Z`) + n * DIA).toISOString().slice(0, 10);

/** Periodo en fechas AAAA-MM-DD (calculadas en hora de Bogotá). null si los datos no sirven. */
export function periodoFechas(a: { periodo: (typeof PERIODOS)[number]; desde?: string; hasta?: string }, ahora = new Date()): { fechas: PeriodoFechas; etiqueta: string } | null {
  const r = rangoPeriodo(a.periodo, ahora, a.desde, a.hasta);
  return r ? { fechas: { desde: aFecha(r.desde), hasta: aFecha(r.hasta) }, etiqueta: r.etiqueta } : null;
}
/** El periodo inmediatamente anterior y de la misma duración. */
export function periodoAnterior(p: PeriodoFechas): PeriodoFechas {
  const dias = Math.round((Date.parse(`${p.hasta}T00:00:00Z`) - Date.parse(`${p.desde}T00:00:00Z`)) / DIA) + 1;
  return { desde: sumarDias(p.desde, -dias), hasta: sumarDias(p.desde, -1) };
}
/** Variación porcentual con 1 decimal; null si no hay base. */
export function variacionPct(actual: number, previo: number): string | null {
  if (!Number.isFinite(actual) || !Number.isFinite(previo) || previo <= 0) return null;
  return (((actual - previo) / previo) * 100).toFixed(1);
}
const num = (d: { monto: string } | null) => (d ? Number(d.monto) : 0);

const esquemaCuenta = { type: 'string', maxLength: 60, description: 'Nombre de la cuenta publicitaria conectada. Opcional si solo hay una.' };
const esquemaPeriodo = {
  periodo: { type: 'string', enum: [...PERIODOS] },
  desde: { type: 'string', description: 'AAAA-MM-DD, solo con periodo personalizado' },
  hasta: { type: 'string', description: 'AAAA-MM-DD, solo con periodo personalizado' },
};
const esquemaResultado = { type: 'string', enum: TIPOS_RESULTADO, description: 'Qué cuenta como resultado. En TikTok no se puede indicar: sin este dato usa el resultado del objetivo de la campaña.' };
const entradaPeriodo = { periodo: z.enum(PERIODOS).default('7_dias'), desde: FECHA.optional(), hasta: FECHA.optional() };
const resultado = z.enum(TIPOS_RESULTADO as [string, ...string[]]).optional();
const AVISO_ZONA = 'Las fechas se interpretan en la zona horaria de la cuenta publicitaria. Los resultados pueden cambiar unas horas después por atribución de la plataforma.';

type Contexto = Pick<ContextoHerramienta, 'pauta'>;
async function elegir(c: Contexto, nombre: string | undefined): Promise<{ t: CuentaElegida } | { aviso: unknown }> {
  const lista = c.pauta?.listar() ?? [];
  if (!c.pauta || lista.length === 0) return { aviso: { error: 'sin_cuentas', mensaje: 'No hay cuentas publicitarias conectadas.' } };
  if (!nombre) {
    if (lista.length > 1) return { aviso: { error: 'indica_cuenta', mensaje: 'Hay varias cuentas conectadas: indica cuál usar con el argumento "cuenta".', cuentas: lista } };
    return { t: await c.pauta.obtener(lista[0]!.nombre) };
  }
  return { t: await c.pauta.obtener(nombre) };
}
const marca = (t: CuentaElegida) => ({ cuenta: t.nombre, plataforma: t.plataforma });
const periodoOError = (a: { periodo: (typeof PERIODOS)[number]; desde?: string; hasta?: string }) =>
  periodoFechas(a) ?? { aviso: { error: 'periodo_invalido', mensaje: 'Con periodo personalizado indica "desde" y "hasta" (AAAA-MM-DD, máximo 366 días, desde antes que hasta).' } };

export const HERRAMIENTAS_PAUTA: Herramienta[] = [
  {
    nombre: 'pauta_cuentas',
    descripcion: 'Lista las cuentas publicitarias conectadas (nombre y plataforma: Meta o TikTok). Solo lectura.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    entrada: z.object({}).strict(),
    async ejecutar(c: Contexto) { return { datos: { cuentas: c.pauta?.listar() ?? [] } }; },
  },
  {
    nombre: 'pauta_resumen',
    descripcion: 'Resumen de pauta de una cuenta en un periodo: gasto, impresiones, alcance, clics, CTR, CPC, CPM y, si se indica el tipo de resultado, resultados y costo por resultado. Solo métricas agregadas. Solo lectura.',
    schema: { type: 'object', properties: { cuenta: esquemaCuenta, ...esquemaPeriodo, resultado: esquemaResultado }, additionalProperties: false },
    entrada: z.object({ cuenta: nombreCuenta, ...entradaPeriodo, resultado }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.cuenta); if ('aviso' in e) return { datos: e.aviso };
      const p = periodoOError(a); if ('aviso' in p) return { datos: p.aviso };
      return { datos: { ...marca(e.t), periodo: p.etiqueta, fechas: p.fechas, metricas: await e.t.adaptador.resumen(p.fechas, a.resultado as never), aviso: AVISO_ZONA } };
    },
  },
  {
    nombre: 'pauta_ranking',
    descripcion: 'Ranking de campañas, conjuntos de anuncios o anuncios de una cuenta en un periodo, ordenado por gasto, resultados, clics, impresiones o costo por resultado (el más barato primero). Máximo 20 filas. Solo lectura.',
    schema: { type: 'object', properties: { cuenta: esquemaCuenta, nivel: { type: 'string', enum: NIVELES }, orden: { type: 'string', enum: ORDENES }, ...esquemaPeriodo, resultado: esquemaResultado, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS } }, additionalProperties: false },
    entrada: z.object({ cuenta: nombreCuenta, nivel: z.enum(NIVELES as [NivelPauta, ...NivelPauta[]]).default('campana'), orden: z.enum(ORDENES as [OrdenPauta, ...OrdenPauta[]]).default('gasto'), ...entradaPeriodo, resultado, limite: z.number().int().min(1).max(MAX_FILAS).default(10) }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.cuenta); if ('aviso' in e) return { datos: e.aviso };
      const p = periodoOError(a); if ('aviso' in p) return { datos: p.aviso };
      const r = await e.t.adaptador.ranking({ nivel: a.nivel, periodo: p.fechas, resultado: a.resultado as never, orden: a.orden, limite: a.limite });
      return { datos: { ...marca(e.t), periodo: p.etiqueta, nivel: a.nivel, orden: a.orden, truncado: r.truncado, filas: r.filas, aviso: AVISO_ZONA } };
    },
  },
  {
    nombre: 'pauta_comparar',
    descripcion: 'Compara un periodo con el periodo anterior de la misma duración (gasto, impresiones, clics, resultados y su variación en %). Solo lectura.',
    schema: { type: 'object', properties: { cuenta: esquemaCuenta, ...esquemaPeriodo, resultado: esquemaResultado }, additionalProperties: false },
    entrada: z.object({ cuenta: nombreCuenta, ...entradaPeriodo, resultado }).strict(),
    async ejecutar(c: Contexto, a) {
      const e = await elegir(c, a.cuenta); if ('aviso' in e) return { datos: e.aviso };
      const p = periodoOError(a); if ('aviso' in p) return { datos: p.aviso };
      const previo = periodoAnterior(p.fechas);
      const [actual, anterior] = [await e.t.adaptador.resumen(p.fechas, a.resultado as never), await e.t.adaptador.resumen(previo, a.resultado as never)];
      const v = (f: (m: Metricas) => number) => variacionPct(f(actual), f(anterior));
      return { datos: { ...marca(e.t), periodo: p.etiqueta, fechas: p.fechas, periodo_anterior: previo, actual, anterior,
        variacion_pct: { gasto: v((m) => num(m.gasto)), impresiones: v((m) => m.impresiones), clics: v((m) => m.clics), resultados: v((m) => m.resultados ?? 0), costo_por_resultado: v((m) => num(m.costoPorResultado)) }, aviso: AVISO_ZONA } };
    },
  },
];

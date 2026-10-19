import { nombreDeDominioValido, type HttpSeguro } from '../http-seguro.js';
import { ClienteApi } from '../tiendas/base.js';
import { arr, dinero, ent, limpiar, obj, type Dinero } from '../tiendas/tipos.js';
import {
  errorSuiteDesde, ErrorSuite, ESTADOS_CONVERSACION, ESTADOS_RESERVA, ESTADOS_REUNION,
  type AdaptadorSuite, type ConversacionResumen, type EstadoConversacion, type EstadoReserva, type EstadoReunion, type EtapaEmbudo, type Espacio, type InfoSuite,
  type ListaTruncable, type MetricasTalk, type Periodo, type ProductoSuite, type ReservaResumen, type ReunionResumen, type ResumenBooking, type TipoCita, type TratoResumen, type UsoMeet,
} from './tipos.js';

export interface CredencialSuite { producto: ProductoSuite; dominio: string; clave: string }
/** Versión del contrato de conector que entiende este adaptador (docs/contrato-suite.md). */
export const CONTRATO_SUITE = 1;
export const CLAVE_SUITE = /^[A-Za-z0-9_.~+=-]{16,300}$/;
const BASE = '/archie-ai/v1';

/** Rutas permitidas por producto (lista cerrada; nunca se arma una ruta con texto del modelo). */
const RUTAS: Record<ProductoSuite, string[]> = {
  booking: ['info', 'tipos-de-cita', 'disponibilidad', 'reservas', 'resumen'],
  talk: ['info', 'conversaciones', 'metricas', 'embudo', 'tratos'],
  meet: ['info', 'reuniones', 'uso'],
};

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const iso = (v: unknown): string | null => (typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null);
/** Identificadores de la suite: sin barras ni puntos al inicio (aunque solo viajan en la consulta, nunca en la ruta). */
export const ID_SUITE = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,99}$/;
const idSeguro = (v: unknown): string | null => { const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v : null; return s !== null && ID_SUITE.test(s) ? s : null; };
const nat = (v: unknown): number | null => { const n = ent(v); return n !== null && n >= 0 ? n : null; };
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const din = (v: unknown): Dinero | null => { const o = obj(v); return dinero(o.monto, o.moneda); };
const dineros = (v: unknown): Dinero[] => arr(v).map(din).filter((d): d is Dinero => d !== null).slice(0, 10);
/** Mapa de conteos: claves cortas y limpias, valores enteros no negativos, máximo 30. */
function conteos(v: unknown): Record<string, number> {
  const r: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v)).slice(0, 30)) { const c = limpiar(k, 40); const n = nat(x); if (c && n !== null) r[c] = n; }
  return r;
}
const elegir = <T extends string>(v: unknown, validos: readonly T[], porDefecto: T | 'otro'): T | 'otro' => {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (validos as readonly string[]).includes(t) ? (t as T) : porDefecto;
};
const lista = <T>(datos: unknown, clave: string, mapa: (x: Record<string, unknown>) => T | null, limite: number): ListaTruncable<T> => {
  const o = obj(datos);
  const todos = arr(o[clave]).map((x) => mapa(obj(x))).filter((x): x is T => x !== null);
  const total = nat(o.total);
  return { items: todos.slice(0, limite), truncado: o.truncado === true || todos.length > limite || (total !== null && total > Math.min(todos.length, limite)), total };
};

export class AdaptadorHttpSuite implements AdaptadorSuite {
  private readonly api: ClienteApi;
  constructor(readonly producto: ProductoSuite, http: HttpSeguro, cred: CredencialSuite) {
    const host = nombreDeDominioValido(cred.dominio);
    if (!host) throw new ErrorSuite('direccion_no_permitida');
    if (!CLAVE_SUITE.test(cred.clave)) throw new ErrorSuite('credencial_rechazada');
    const ruta = RUTAS[producto].map((r) => r.replace('-', '\\-')).join('|');
    this.api = new ClienteApi(http, host, { Authorization: `Bearer ${cred.clave}` }, [new RegExp(`^${BASE}/${producto}/(?:${ruta})$`)], undefined, errorSuiteDesde);
  }

  private get = async (ruta: string, q: Record<string, string | number | undefined> = {}) => (await this.api.json('GET', `${BASE}/${this.producto}/${ruta}`, q)).datos;
  private soloPara(p: ProductoSuite): void { if (this.producto !== p) throw new ErrorSuite('no_soportado'); }

  async probar(): Promise<InfoSuite> {
    const o = obj(await this.get('info'));
    if (nat(o.contrato) !== CONTRATO_SUITE) throw new ErrorSuite('contrato_no_soportado');
    if (o.producto !== this.producto) throw new ErrorSuite('producto_incorrecto');
    return { producto: this.producto, nombre: limpiar(o.nombre, 80), zonaHoraria: typeof o.zona_horaria === 'string' && /^[A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2}$/.test(o.zona_horaria) ? o.zona_horaria : null };
  }

  // ---------- Booking ----------
  async tiposDeCita(): Promise<TipoCita[]> {
    this.soloPara('booking');
    return arr(obj(await this.get('tipos-de-cita')).tipos).slice(0, 50).flatMap((x) => {
      const o = obj(x); const id = idSeguro(o.id); const nombre = limpiar(o.nombre, 100);
      return id && nombre ? [{ id, nombre, duracionMin: nat(o.duracion_min), activo: o.activo !== false, precio: din(o.precio) }] : [];
    });
  }
  async disponibilidad(tipoId: string, p: Periodo): Promise<{ espacios: Espacio[]; truncado: boolean }> {
    this.soloPara('booking');
    const id = idSeguro(tipoId); if (!id) throw new ErrorSuite('no_encontrado');
    const o = obj(await this.get('disponibilidad', { tipo: id, desde: p.desde, hasta: p.hasta }));
    const todos = arr(o.espacios).flatMap((x) => { const e = obj(x); const i = iso(e.inicio); const f = iso(e.fin); return i && f ? [{ inicio: i, fin: f }] : []; });
    return { espacios: todos.slice(0, 40), truncado: o.truncado === true || todos.length > 40 };
  }
  async reservas(o: { periodo: Periodo; estado?: EstadoReserva; limite: number }): Promise<ListaTruncable<ReservaResumen>> {
    this.soloPara('booking');
    const d = await this.get('reservas', { desde: o.periodo.desde, hasta: o.periodo.hasta, estado: o.estado, limite: o.limite });
    return lista(d, 'reservas', (r) => {
      const id = idSeguro(r.id); const inicio = iso(r.inicio); if (!id || !inicio) return null;
      return { id, tipoId: idSeguro(r.tipo_id), tipo: limpiar(r.tipo, 100), inicio, fin: iso(r.fin), estado: elegir<EstadoReserva>(r.estado, ESTADOS_RESERVA, 'otro'), pagada: bool(r.pagada), monto: din(r.monto) };
    }, o.limite);
  }
  async resumenBooking(p: Periodo): Promise<ResumenBooking> {
    this.soloPara('booking');
    const o = obj(await this.get('resumen', { desde: p.desde, hasta: p.hasta }));
    return { total: nat(o.total) ?? 0, porEstado: conteos(o.por_estado), ingresos: dineros(o.ingresos) };
  }

  // ---------- Talk ----------
  async conversaciones(o: { periodo: Periodo; estado?: EstadoConversacion; canal?: string; limite: number }): Promise<ListaTruncable<ConversacionResumen>> {
    this.soloPara('talk');
    const d = await this.get('conversaciones', { desde: o.periodo.desde, hasta: o.periodo.hasta, estado: o.estado, canal: o.canal, limite: o.limite });
    return lista(d, 'conversaciones', (c) => {
      const id = idSeguro(c.id); const creada = iso(c.creada); const canal = limpiar(c.canal, 40); if (!id || !creada || !canal) return null;
      return { id, canal, estado: elegir<EstadoConversacion>(c.estado, ESTADOS_CONVERSACION, 'otro'), asignadoA: limpiar(c.asignado_a, 80), creada, ultimaActividad: iso(c.ultima_actividad), mensajes: nat(c.mensajes),
        etiquetas: arr(c.etiquetas).map((e) => limpiar(e, 40)).filter((e): e is string => Boolean(e)).slice(0, 10) };
    }, o.limite);
  }
  async metricasTalk(p: Periodo): Promise<MetricasTalk> {
    this.soloPara('talk');
    const o = obj(await this.get('metricas', { desde: p.desde, hasta: p.hasta }));
    return { total: nat(o.total) ?? 0, porCanal: conteos(o.por_canal), porEstado: conteos(o.por_estado), sinAsignar: nat(o.sin_asignar), primeraRespuestaSegMediana: nat(o.primera_respuesta_seg_mediana), resolucionSegMediana: nat(o.resolucion_seg_mediana) };
  }
  async embudo(): Promise<EtapaEmbudo[]> {
    this.soloPara('talk');
    return arr(obj(await this.get('embudo')).etapas).slice(0, 30).flatMap((x) => {
      const o = obj(x); const id = idSeguro(o.id); const nombre = limpiar(o.nombre, 80);
      return id && nombre ? [{ id, nombre, tratos: nat(o.tratos) ?? 0, valor: din(o.valor) }] : [];
    });
  }
  async tratos(o: { etapa?: string; limite: number }): Promise<ListaTruncable<TratoResumen>> {
    this.soloPara('talk');
    const etapa = o.etapa === undefined ? undefined : idSeguro(o.etapa) ?? undefined;
    const d = await this.get('tratos', { etapa, limite: o.limite });
    return lista(d, 'tratos', (t) => {
      const id = idSeguro(t.id); const titulo = limpiar(t.titulo, 120); if (!id || !titulo) return null;
      return { id, titulo, etapa: limpiar(t.etapa, 80), valor: din(t.valor), creado: iso(t.creado), ultimoMovimiento: iso(t.ultimo_movimiento) };
    }, o.limite);
  }

  // ---------- Meet ----------
  async reuniones(o: { periodo: Periodo; estado?: EstadoReunion; limite: number }): Promise<ListaTruncable<ReunionResumen>> {
    this.soloPara('meet');
    const d = await this.get('reuniones', { desde: o.periodo.desde, hasta: o.periodo.hasta, estado: o.estado, limite: o.limite });
    return lista(d, 'reuniones', (r) => {
      const id = idSeguro(r.id); const inicio = iso(r.inicio); const titulo = limpiar(r.titulo, 120); if (!id || !inicio || !titulo) return null;
      return { id, titulo, inicio, duracionMin: nat(r.duracion_min), estado: elegir<EstadoReunion>(r.estado, ESTADOS_REUNION, 'otro'), participantes: nat(r.participantes), grabada: bool(r.grabada) };
    }, o.limite);
  }
  async usoMeet(p: Periodo): Promise<UsoMeet> {
    this.soloPara('meet');
    const o = obj(await this.get('uso', { desde: p.desde, hasta: p.hasta }));
    return { reuniones: nat(o.reuniones) ?? 0, minutos: nat(o.minutos) ?? 0, grabaciones: nat(o.grabaciones), participantesPromedio: typeof o.participantes_promedio === 'number' && Number.isFinite(o.participantes_promedio) && o.participantes_promedio >= 0 ? Math.round(o.participantes_promedio * 10) / 10 : null };
  }
}

export function crearAdaptadorSuite(cred: CredencialSuite, http: HttpSeguro): AdaptadorSuite { return new AdaptadorHttpSuite(cred.producto, http, cred); }

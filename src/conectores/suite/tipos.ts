/**
 * Conectores de la suite Archie (Talk, Meet, Booking) sobre el «contrato de conector v1» (docs/contrato-suite.md).
 * Regla de privacidad: los formatos de abajo NO tienen campos para nombre, correo, teléfono ni mensajes de personas
 * que escribieron, reservaron o asistieron; por eso ningún adaptador puede devolverlos aunque el producto los entregue.
 */
import { dinero, type CodigoTienda, type Dinero } from '../tiendas/tipos.js';

export type ProductoSuite = 'talk' | 'meet' | 'booking';
export const PRODUCTOS_SUITE: ProductoSuite[] = ['talk', 'meet', 'booking'];
export const NOMBRE_PRODUCTO: Record<ProductoSuite, string> = { talk: 'Archie Talk', meet: 'Archie Meet', booking: 'Archie Booking' };
export const esProductoSuite = (v: unknown): v is ProductoSuite => v === 'talk' || v === 'meet' || v === 'booking';

export type CodigoSuite =
  | 'credencial_rechazada' | 'sin_permiso' | 'no_encontrado' | 'limite' | 'tiempo_agotado' | 'no_disponible'
  | 'respuesta_invalida' | 'direccion_no_permitida' | 'no_soportado' | 'no_conectada' | 'producto_incorrecto' | 'contrato_no_soportado';

export const MENSAJES_SUITE: Record<CodigoSuite, string> = {
  credencial_rechazada: 'La herramienta rechazó la clave conectada (vencida o revocada). Un administrador debe crear una nueva en Conexiones.',
  sin_permiso: 'La clave conectada no tiene permiso para ver esto en la herramienta.',
  no_encontrado: 'La herramienta no encontró lo que se pidió (o todavía no ofrece esa consulta).',
  limite: 'La herramienta pidió esperar un momento (límite de peticiones). Inténtalo en un minuto.',
  tiempo_agotado: 'La herramienta tardó demasiado en responder.',
  no_disponible: 'No se pudo conectar con la herramienta en este momento.',
  respuesta_invalida: 'La herramienta respondió algo que no se pudo leer.',
  direccion_no_permitida: 'La dirección de la herramienta no es válida o no está permitida.',
  no_soportado: 'Esa consulta todavía no está disponible para esta herramienta.',
  no_conectada: 'Esa herramienta no está conectada. Un administrador debe conectarla en Conexiones.',
  producto_incorrecto: 'Esa dirección responde como otra herramienta de la suite. Revisa que sea la de este producto.',
  contrato_no_soportado: 'La herramienta usa una versión del contrato que Archie AI todavía no entiende. Hay que actualizar uno de los dos.',
};

export class ErrorSuite extends Error {
  constructor(readonly codigo: CodigoSuite, readonly http?: number) { super(MENSAJES_SUITE[codigo]); }
}

/** Para el cliente HTTP común: los códigos de tienda se traducen a los de la suite. */
export const errorSuiteDesde = (c: CodigoTienda, h?: number): ErrorSuite => new ErrorSuite(c === 'periodo_fuera_de_alcance' ? 'no_soportado' : c, h);

export interface InfoSuite { producto: ProductoSuite; nombre: string | null; zonaHoraria: string | null }
export interface Periodo { desde: string; hasta: string }

// ---- Booking ----
export interface TipoCita { id: string; nombre: string; duracionMin: number | null; activo: boolean; precio: Dinero | null }
export interface Espacio { inicio: string; fin: string }
export interface ReservaResumen { id: string; tipoId: string | null; tipo: string | null; inicio: string; fin: string | null; estado: EstadoReserva; pagada: boolean | null; monto: Dinero | null }
export type EstadoReserva = 'pendiente' | 'confirmada' | 'completada' | 'cancelada' | 'no_asistio' | 'otro';
export const ESTADOS_RESERVA: EstadoReserva[] = ['pendiente', 'confirmada', 'completada', 'cancelada', 'no_asistio'];
export interface ResumenBooking { total: number; porEstado: Record<string, number>; ingresos: Dinero[] }

// ---- Talk ----
export type EstadoConversacion = 'abierta' | 'pendiente' | 'resuelta' | 'otro';
export const ESTADOS_CONVERSACION: EstadoConversacion[] = ['abierta', 'pendiente', 'resuelta'];
export interface ConversacionResumen { id: string; canal: string; estado: EstadoConversacion; asignadoA: string | null; creada: string; ultimaActividad: string | null; mensajes: number | null; etiquetas: string[] }
export interface MetricasTalk { total: number; porCanal: Record<string, number>; porEstado: Record<string, number>; sinAsignar: number | null; primeraRespuestaSegMediana: number | null; resolucionSegMediana: number | null }
export interface EtapaEmbudo { id: string; nombre: string; tratos: number; valor: Dinero | null }
export interface TratoResumen { id: string; titulo: string; etapa: string | null; valor: Dinero | null; creado: string | null; ultimoMovimiento: string | null }

// ---- Meet ----
export type EstadoReunion = 'programada' | 'en_curso' | 'finalizada' | 'cancelada' | 'otro';
export const ESTADOS_REUNION: EstadoReunion[] = ['programada', 'en_curso', 'finalizada', 'cancelada'];
export interface ReunionResumen { id: string; titulo: string; inicio: string; duracionMin: number | null; estado: EstadoReunion; participantes: number | null; grabada: boolean | null }
export interface UsoMeet { reuniones: number; minutos: number; grabaciones: number | null; participantesPromedio: number | null }

export interface ListaTruncable<T> { items: T[]; truncado: boolean; total: number | null }

/** Todo es lectura. Cada producto implementa solo lo suyo; lo demás lanza `no_soportado`. */
export interface AdaptadorSuite {
  readonly producto: ProductoSuite;
  probar(): Promise<InfoSuite>;
  // booking
  tiposDeCita(): Promise<TipoCita[]>;
  disponibilidad(tipoId: string, p: Periodo): Promise<{ espacios: Espacio[]; truncado: boolean }>;
  reservas(o: { periodo: Periodo; estado?: EstadoReserva; limite: number }): Promise<ListaTruncable<ReservaResumen>>;
  resumenBooking(p: Periodo): Promise<ResumenBooking>;
  // talk
  conversaciones(o: { periodo: Periodo; estado?: EstadoConversacion; canal?: string; limite: number }): Promise<ListaTruncable<ConversacionResumen>>;
  metricasTalk(p: Periodo): Promise<MetricasTalk>;
  embudo(): Promise<EtapaEmbudo[]>;
  tratos(o: { etapa?: string; limite: number }): Promise<ListaTruncable<TratoResumen>>;
  // meet
  reuniones(o: { periodo: Periodo; estado?: EstadoReunion; limite: number }): Promise<ListaTruncable<ReunionResumen>>;
  usoMeet(p: Periodo): Promise<UsoMeet>;
}

export { dinero };

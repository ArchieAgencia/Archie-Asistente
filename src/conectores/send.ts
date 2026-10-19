/** Cliente de solo lectura de la API de Archie Send. Solo GET, solo rutas conocidas, origen fijado por el servidor. */

export interface CredencialSend { usuario: string; token: string }

export const USUARIO_SEND = /^[A-Za-z0-9._@-]{1,100}$/;
export const TOKEN_SEND = /^[\x21-\x7E]{8,200}$/; // ASCII visible, sin espacios ni saltos de línea (no puede inyectar cabeceras)

export type CodigoConector = 'credencial_rechazada' | 'sin_permiso' | 'sin_permiso_escritura' | 'datos_rechazados' | 'no_encontrado' | 'limite' | 'tiempo_agotado' | 'no_disponible' | 'respuesta_invalida' | 'no_conectado';

/** Mensajes claros para la persona y para el modelo. Nunca llevan el cuerpo de la respuesta ni la clave. */
export const MENSAJES_CONECTOR: Record<CodigoConector, string> = {
  credencial_rechazada: 'Archie Send rechazó la clave de API. Hay que revisarla o crear una nueva en Conexiones.',
  sin_permiso: 'La clave de API conectada no tiene permiso para ver esto en Archie Send.',
  sin_permiso_escritura: 'La clave de API conectada no tiene permiso para crear o borrar esto en Archie Send. Hay que darle un rol con permiso de gestión en Archie Send.',
  datos_rechazados: 'Archie Send rechazó los datos enviados.',
  no_encontrado: 'Archie Send no encontró lo que se pidió.',
  limite: 'Archie Send pidió esperar un momento (límite de peticiones). Inténtalo en un minuto.',
  tiempo_agotado: 'Archie Send tardó demasiado en responder.',
  no_disponible: 'No se pudo conectar con Archie Send en este momento.',
  respuesta_invalida: 'Archie Send respondió algo que no se pudo leer.',
  no_conectado: 'Archie Send no está conectado. Un administrador debe conectarlo en Conexiones.',
};

export class ErrorConector extends Error {
  /** Texto corto que explica el rechazo (solo para 400/422, saneado). Va al modelo, nunca a la pantalla ni a los registros. */
  constructor(readonly codigo: CodigoConector, readonly http?: number, readonly detalle?: string) { super(MENSAJES_CONECTOR[codigo]); }
}

// Únicas rutas que este cliente puede pedir (todas son lecturas). Cualquier otra se rechaza antes de salir a la red.
const RUTAS_PERMITIDAS: RegExp[] = [
  /^\/api\/lists$/, /^\/api\/campaigns$/, /^\/api\/campaigns\/running\/stats$/, /^\/api\/campaigns\/\d{1,10}$/,
  /^\/api\/segments$/, /^\/api\/credits$/, /^\/api\/send-errors$/, /^\/api\/subscribers$/,
];
// Escrituras: SOLO borradores (crear) y su reversa (borrar lo creado). Nada de enviar, programar, pausar ni editar.
const CREAR_PERMITIDO: RegExp[] = [/^\/api\/lists$/, /^\/api\/segments$/, /^\/api\/campaigns$/];
const BORRAR_PERMITIDO: RegExp[] = [/^\/api\/lists\/\d{1,10}$/, /^\/api\/segments\/\d{1,10}$/, /^\/api\/campaigns\/\d{1,10}$/];
// Cambios de estado de una campaña: SOLO desde una confirmación humana (ver chat/propuestas.ts), nunca desde una herramienta del modelo.
const ESTADO_CAMPANA_PERMITIDO: RegExp[] = [/^\/api\/campaigns\/\d{1,10}\/status$/];
export const ESTADOS_CAMPANA = ['scheduled', 'running', 'paused', 'cancelled'] as const;
export type EstadoCampana = (typeof ESTADOS_CAMPANA)[number];
const LEER_EXTRA: RegExp[] = [/^\/api\/lists\/\d{1,10}$/];
const MAX_RESPUESTA = 1_000_000;

export interface OpcionesSend { fetchFn?: typeof fetch; timeoutMs?: number }

export class ClienteSend {
  private readonly origen: string;
  constructor(origen: string, private readonly cred: CredencialSend, private readonly o: OpcionesSend = {}) {
    const u = new URL(origen);
    this.origen = u.origin; // solo el origen: se descarta cualquier ruta o parámetro configurado
    if (!USUARIO_SEND.test(cred.usuario) || !TOKEN_SEND.test(cred.token)) throw new ErrorConector('credencial_rechazada');
  }

  async get(ruta: string, consulta: Record<string, string | number | undefined> = {}): Promise<unknown> {
    if (![...RUTAS_PERMITIDAS, ...LEER_EXTRA].some((r) => r.test(ruta))) throw new Error(`ruta no permitida: ${ruta}`);
    const url = new URL(ruta, this.origen);
    for (const [k, v] of Object.entries(consulta)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    return this.pedir('GET', url, undefined, false);
  }

  /** Crea un borrador (lista, segmento o campaña en borrador). Devuelve lo que Archie Send respondió. */
  async crear(ruta: string, cuerpo: object): Promise<unknown> {
    if (!CREAR_PERMITIDO.some((r) => r.test(ruta))) throw new Error(`ruta no permitida: ${ruta}`);
    return this.pedir('POST', new URL(ruta, this.origen), JSON.stringify(cuerpo), true);
  }

  /** Borra algo que Archie AI creó (deshacer). Solo se llama desde la acción humana "Deshacer", nunca desde una herramienta del modelo. */
  async borrar(ruta: string): Promise<void> {
    if (!BORRAR_PERMITIDO.some((r) => r.test(ruta))) throw new Error(`ruta no permitida: ${ruta}`);
    await this.pedir('DELETE', new URL(ruta, this.origen), undefined, true);
  }

  /** Programa, inicia, pausa o cancela una campaña. Solo lo llama una persona al aprobar una tarjeta de confirmación. */
  async cambiarEstadoCampana(id: number, estado: EstadoCampana): Promise<void> {
    const ruta = `/api/campaigns/${id}/status`;
    if (!Number.isInteger(id) || id < 1 || !ESTADOS_CAMPANA.includes(estado) || !ESTADO_CAMPANA_PERMITIDO.some((r) => r.test(ruta))) throw new Error(`ruta no permitida: ${ruta}`);
    await this.pedir('PUT', new URL(ruta, this.origen), JSON.stringify({ status: estado }), true);
  }

  private async pedir(metodo: 'GET' | 'POST' | 'PUT' | 'DELETE', url: URL, cuerpo: string | undefined, escritura: boolean): Promise<unknown> {
    const f = this.o.fetchFn ?? fetch;
    let resp: Response;
    try {
      resp = await f(url, {
        method: metodo, redirect: 'error', signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000), body: cuerpo,
        headers: { Authorization: `token ${this.cred.usuario}:${this.cred.token}`, Accept: 'application/json', 'User-Agent': 'ArchieAI-Conector/1', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      });
    } catch (e) {
      throw new ErrorConector(e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'tiempo_agotado' : 'no_disponible');
    }
    if (!resp.ok) {
      const s = resp.status;
      let detalle: string | undefined;
      if ((s === 400 || s === 422) && escritura) {
        try { const m = (JSON.parse((await leerLimitado(resp)).slice(0, 5000)) as { message?: unknown }).message; if (typeof m === 'string') detalle = m.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200); } catch { /* sin detalle */ }
      } else await resp.body?.cancel().catch(() => undefined);
      throw new ErrorConector(
        s === 401 ? 'credencial_rechazada' : s === 403 ? (escritura ? 'sin_permiso_escritura' : 'sin_permiso') : s === 404 ? 'no_encontrado' : s === 429 ? 'limite'
          : (s === 400 || s === 422) && escritura ? 'datos_rechazados' : 'no_disponible', s, detalle);
    }
    const texto = await leerLimitado(resp);
    try {
      const j = JSON.parse(texto) as { data?: unknown };
      if (j === null || typeof j !== 'object' || !('data' in j)) throw new Error('forma');
      return j.data;
    } catch { throw new ErrorConector('respuesta_invalida'); }
  }
}

async function leerLimitado(resp: Response): Promise<string> {
  if (!resp.body) return '';
  const dec = new TextDecoder();
  let total = 0; let out = '';
  for await (const t of resp.body as unknown as AsyncIterable<Uint8Array>) {
    total += t.length;
    if (total > MAX_RESPUESTA) { await resp.body.cancel().catch(() => undefined); throw new ErrorConector('respuesta_invalida'); }
    out += dec.decode(t, { stream: true });
  }
  return out + dec.decode();
}

import { ErrorHttpSeguro, type HttpSeguro, type RespuestaSegura } from '../http-seguro.js';
import { ErrorTienda, type CodigoTienda } from './tipos.js';

/** Pieza común de los adaptadores: pide a una lista cerrada de rutas, traduce errores y lee JSON. Nunca devuelve el cuerpo de un error. */
export class ClienteApi {
  constructor(
    private readonly http: HttpSeguro,
    private readonly host: string,
    private readonly cabecerasBase: Record<string, string>,
    private readonly permitidas: RegExp[],
    /** Para plataformas que devuelven el motivo en el cuerpo del error (el cuerpo nunca se expone: solo se traduce a un código). */
    private readonly interpretar?: (estado: number, cuerpo: string) => CodigoTienda | undefined,
    /** Para otros conectores con los mismos códigos (por ejemplo, pauta): qué error lanzar. */
    private readonly crearError: (codigo: CodigoTienda, http?: number) => Error = (c, h) => new ErrorTienda(c, h),
  ) {}

  async json(metodo: 'GET' | 'POST', ruta: string, consulta: Record<string, string | number | undefined> = {}, cuerpo?: object): Promise<{ datos: unknown; cabeceras: Record<string, string> }> {
    const [camino] = ruta.split('?');
    if (!this.permitidas.some((r) => r.test(camino!))) throw new Error(`ruta no permitida: ${camino}`);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(consulta)) if (v !== undefined && v !== '') q.set(k, String(v));
    const qs = q.toString();
    let r: RespuestaSegura;
    try {
      r = await this.http.pedir({
        metodo, host: this.host, ruta: qs ? `${camino}?${qs}` : camino!,
        cabeceras: { Accept: 'application/json', 'User-Agent': 'ArchieAI-Conector/1', ...this.cabecerasBase, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        cuerpo: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
    } catch (e) {
      if (e instanceof ErrorHttpSeguro) throw this.crearError(e.codigo === 'direccion_no_permitida' ? 'direccion_no_permitida' : e.codigo === 'tiempo_agotado' ? 'tiempo_agotado' : e.codigo === 'respuesta_demasiado_grande' || e.codigo === 'redireccion' ? 'respuesta_invalida' : 'no_disponible');
      throw e;
    }
    const s = r.estado;
    if (s < 200 || s >= 300) {
      const propio = this.interpretar?.(s, r.cuerpo);
      throw this.crearError(propio ?? (s === 401 ? 'credencial_rechazada' : s === 403 ? 'sin_permiso' : s === 404 ? 'no_encontrado' : s === 429 ? 'limite' : s >= 500 ? 'no_disponible' : 'respuesta_invalida'), s);
    }
    try { return { datos: JSON.parse(r.cuerpo), cabeceras: r.cabeceras ?? {} }; } catch { throw this.crearError('respuesta_invalida'); }
  }
}

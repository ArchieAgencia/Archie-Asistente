import type pg from 'pg';
import { z } from 'zod';
import { ErrorAuth, type SesionActiva } from '../auth/servicio.js';
import { Limitador } from '../auth/limitador.js';
import { cifrar, descifrar, type Llaves } from '../crypto.js';
import { conOrg } from '../db/pool.js';
import { nombreDeDominioValido, type HttpSeguro } from '../conectores/http-seguro.js';
import { CLAVE_SUITE, crearAdaptadorSuite } from '../conectores/suite/adaptador.js';
import type { ResolutorSuite } from '../conectores/suite/herramientas.js';
import { ErrorSuite, esProductoSuite, type AdaptadorSuite, type ProductoSuite } from '../conectores/suite/tipos.js';

const NOMBRE = 'principal';
const conectorDe = (p: ProductoSuite) => `suite_${p}`;
const contextoDe = (p: ProductoSuite) => `conector:suite_${p}`;

export interface ConexionSuite { producto: ProductoSuite; dominio: string | null; probadaEn: Date | null; pruebaOk: boolean | null }

export const esquemaConexionSuite = z.object({
  producto: z.enum(['talk', 'meet', 'booking']),
  dominio: z.string().trim().min(4).max(253),
  clave: z.string().trim().min(1).max(300),
}).strict();
export type EntradaConexionSuite = z.infer<typeof esquemaConexionSuite>;

/** Conexiones de Archie Talk, Meet y Booking de cada organización. La clave se guarda cifrada (con la organización atada al cifrado) y NUNCA vuelve al navegador, al modelo ni a los registros. */
export class ServicioSuite {
  private readonly limite: Limitador;
  constructor(private readonly pool: pg.Pool, private readonly llaves: Llaves, private readonly http: HttpSeguro, private readonly log: { error: (o: object, m: string) => void } = { error: () => undefined }, intentos = { max: 10, ventanaMs: 15 * 60_000 }) {
    this.limite = new Limitador(intentos.max, intentos.ventanaMs);
  }

  async listar(orgId: string): Promise<ConexionSuite[]> {
    const filas = await conOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT conector, origen, probada_en, prueba_ok FROM credenciales_conector WHERE conector LIKE 'suite\\_%' ORDER BY conector`)).rows);
    return filas.flatMap((f) => {
      const p = String(f.conector).slice('suite_'.length);
      return esProductoSuite(p) ? [{ producto: p, dominio: (f.origen as string | null) ?? null, probadaEn: f.probada_en ?? null, pruebaOk: f.prueba_ok ?? null }] : [];
    });
  }

  async conectar(s: SesionActiva, e: EntradaConexionSuite, ctx: { ip: string }): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las conexiones');
    if (!this.limite.permitir(s.orgId)) throw new ErrorAuth(429, 'demasiados_intentos', 'Demasiados intentos');
    const dominio = nombreDeDominioValido(e.dominio.replace(/^https:\/\//i, '').replace(/\/+$/, ''));
    if (!dominio || !CLAVE_SUITE.test(e.clave)) throw new ErrorAuth(400, 'suite_formato_invalido', 'La dirección o la clave no tienen un formato válido');
    try {
      await crearAdaptadorSuite({ producto: e.producto, dominio, clave: e.clave }, this.http).probar();
    } catch (err) {
      if (err instanceof ErrorSuite) throw new ErrorAuth(422, `suite_${err.codigo}`, err.message);
      throw err;
    }
    const sec = cifrar(this.llaves, JSON.stringify({ dominio, clave: e.clave }), s.orgId, contextoDe(e.producto));
    await conOrg(this.pool, s.orgId, async (c) => {
      await c.query(
        `INSERT INTO credenciales_conector (org_id, conector, nombre, secreto, clave_version, creada_por, origen, probada_en, prueba_ok)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), true)
         ON CONFLICT (org_id, conector, nombre)
         DO UPDATE SET secreto = EXCLUDED.secreto, clave_version = EXCLUDED.clave_version, origen = EXCLUDED.origen, rotada_en = now(), probada_en = now(), prueba_ok = true`,
        [s.orgId, conectorDe(e.producto), NOMBRE, sec.datos, sec.version, s.usuarioId, dominio]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'conexion_suite_guardada', JSON.stringify({ producto: e.producto, dominio, ip: ctx.ip })]);
    });
  }

  async desconectar(s: SesionActiva, producto: ProductoSuite, ctx: { ip: string }): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las conexiones');
    await conOrg(this.pool, s.orgId, async (c) => {
      const r = await c.query('DELETE FROM credenciales_conector WHERE conector = $1 AND nombre = $2', [conectorDe(producto), NOMBRE]);
      if (!r.rowCount) throw new ErrorAuth(404, 'no_encontrado', 'Esa herramienta no está conectada');
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'conexion_suite_quitada', JSON.stringify({ producto, ip: ctx.ip })]);
    });
  }

  async marcarFallo(orgId: string, producto: ProductoSuite): Promise<void> {
    await conOrg(this.pool, orgId, (c) => c.query(
      'UPDATE credenciales_conector SET prueba_ok = false, probada_en = now() WHERE conector = $1 AND nombre = $2', [conectorDe(producto), NOMBRE])).catch(() => undefined);
  }

  /** Resolutor para el chat: lista los productos conectados y, al pedir uno, descifra la clave en memoria. Si la herramienta rechaza la clave, se marca la conexión. */
  async resolutor(orgId: string): Promise<ResolutorSuite | null> {
    const conectadas = await this.listar(orgId);
    if (conectadas.length === 0) return null;
    const productos = conectadas.map((c) => c.producto);
    return {
      productos: () => productos,
      obtener: async (producto) => {
        if (!productos.includes(producto)) throw new ErrorSuite('no_conectada');
        const f = await conOrg(this.pool, orgId, async (c) => (await c.query(
          'SELECT secreto, clave_version FROM credenciales_conector WHERE conector = $1 AND nombre = $2', [conectorDe(producto), NOMBRE])).rows[0]);
        if (!f) throw new ErrorSuite('no_conectada');
        let adaptador: AdaptadorSuite;
        try {
          const cred = JSON.parse(descifrar(this.llaves, { version: f.clave_version, datos: f.secreto }, orgId, contextoDe(producto))) as { dominio: string; clave: string };
          adaptador = crearAdaptadorSuite({ producto, dominio: cred.dominio, clave: cred.clave }, this.http);
        } catch (err) {
          if (err instanceof ErrorSuite) throw err;
          this.log.error({ producto }, 'no se pudieron leer las credenciales de una herramienta de la suite');
          throw new ErrorSuite('no_conectada');
        }
        return this.vigilar(adaptador, orgId, producto);
      },
    };
  }

  private vigilar(a: AdaptadorSuite, orgId: string, producto: ProductoSuite): AdaptadorSuite {
    const v = async <T>(f: () => Promise<T>): Promise<T> => {
      try { return await f(); } catch (e) { if (e instanceof ErrorSuite && e.codigo === 'credencial_rechazada') await this.marcarFallo(orgId, producto); throw e; }
    };
    return {
      producto: a.producto,
      probar: () => v(() => a.probar()), tiposDeCita: () => v(() => a.tiposDeCita()), disponibilidad: (t, p) => v(() => a.disponibilidad(t, p)),
      reservas: (o) => v(() => a.reservas(o)), resumenBooking: (p) => v(() => a.resumenBooking(p)),
      conversaciones: (o) => v(() => a.conversaciones(o)), metricasTalk: (p) => v(() => a.metricasTalk(p)), embudo: () => v(() => a.embudo()), tratos: (o) => v(() => a.tratos(o)),
      reuniones: (o) => v(() => a.reuniones(o)), usoMeet: (p) => v(() => a.usoMeet(p)),
    };
  }
}

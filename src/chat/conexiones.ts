import type pg from 'pg';
import { ErrorAuth, type SesionActiva } from '../auth/servicio.js';
import { Limitador } from '../auth/limitador.js';
import { MENSAJES_CONECTOR, ClienteSend, ErrorConector, TOKEN_SEND, USUARIO_SEND, type OpcionesSend } from '../conectores/send.js';
import { cifrar, descifrar, type Llaves } from '../crypto.js';
import { conOrg } from '../db/pool.js';

const CONECTOR = 'send';
const NOMBRE = 'principal';
const CONTEXTO = 'conector:send';

export interface EstadoConexion { disponible: boolean; conectado: boolean; probadaEn: Date | null; pruebaOk: boolean | null }

/** Conexión de cada organización con Archie Send. La clave se guarda cifrada y NUNCA vuelve al navegador, al modelo ni a los registros. */
export class ServicioConexiones {
  private readonly limite = new Limitador(10, 15 * 60_000);
  constructor(private readonly pool: pg.Pool, private readonly llaves: Llaves, private readonly origenSend: string | undefined, private readonly opciones: OpcionesSend = {}) {}

  async estado(orgId: string): Promise<EstadoConexion> {
    const f = await conOrg(this.pool, orgId, async (c) => (await c.query(
      'SELECT probada_en, prueba_ok FROM credenciales_conector WHERE conector = $1 AND nombre = $2', [CONECTOR, NOMBRE])).rows[0]);
    return { disponible: Boolean(this.origenSend), conectado: Boolean(f), probadaEn: f?.probada_en ?? null, pruebaOk: f?.prueba_ok ?? null };
  }

  /** Prueba la clave contra Archie Send y, solo si funciona, la guarda cifrada. Solo administradores. */
  async conectar(s: SesionActiva, usuario: string, token: string, ctx: { ip: string }): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las conexiones');
    if (!this.origenSend) throw new ErrorAuth(503, 'conector_no_disponible', 'La conexión con Archie Send aún no está habilitada');
    if (!this.limite.permitir(s.orgId)) throw new ErrorAuth(429, 'demasiados_intentos', 'Demasiados intentos');
    if (!USUARIO_SEND.test(usuario) || !TOKEN_SEND.test(token)) throw new ErrorAuth(400, 'credencial_invalida', 'El usuario o la clave no tienen un formato válido');
    try {
      await new ClienteSend(this.origenSend, { usuario, token }, this.opciones).get('/api/lists', { per_page: 1, minimal: 'true' });
    } catch (e) {
      if (e instanceof ErrorConector) throw new ErrorAuth(422, `send_${e.codigo}`, e.message);
      throw e;
    }
    const sec = cifrar(this.llaves, JSON.stringify({ usuario, token }), s.orgId, CONTEXTO);
    await conOrg(this.pool, s.orgId, async (c) => {
      await c.query(
        `INSERT INTO credenciales_conector (org_id, conector, nombre, secreto, clave_version, creada_por, probada_en, prueba_ok)
         VALUES ($1,$2,$3,$4,$5,$6, now(), true)
         ON CONFLICT (org_id, conector, nombre)
         DO UPDATE SET secreto = EXCLUDED.secreto, clave_version = EXCLUDED.clave_version, rotada_en = now(), probada_en = now(), prueba_ok = true`,
        [s.orgId, CONECTOR, NOMBRE, sec.datos, sec.version, s.usuarioId]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)', [s.orgId, s.usuarioId, 'conexion_send_guardada', JSON.stringify({ ip: ctx.ip })]);
    });
  }

  async desconectar(s: SesionActiva, ctx: { ip: string }): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las conexiones');
    await conOrg(this.pool, s.orgId, async (c) => {
      const r = await c.query('DELETE FROM credenciales_conector WHERE conector = $1 AND nombre = $2', [CONECTOR, NOMBRE]);
      if (r.rowCount) await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)', [s.orgId, s.usuarioId, 'conexion_send_quitada', JSON.stringify({ ip: ctx.ip })]);
    });
  }

  /** Cliente listo para consultar. La clave se descifra aquí, en memoria, y no sale de este objeto. */
  async cliente(orgId: string): Promise<ClienteSend> {
    if (!this.origenSend) throw new ErrorConector('no_conectado');
    const f = await conOrg(this.pool, orgId, async (c) => (await c.query(
      'SELECT secreto, clave_version FROM credenciales_conector WHERE conector = $1 AND nombre = $2', [CONECTOR, NOMBRE])).rows[0]);
    if (!f) throw new ErrorConector('no_conectado');
    let cred: { usuario: string; token: string };
    try { cred = JSON.parse(descifrar(this.llaves, { version: f.clave_version, datos: f.secreto }, orgId, CONTEXTO)); }
    catch { throw new ErrorConector('no_conectado'); }
    return new ClienteSend(this.origenSend, cred, this.opciones);
  }

  /** Marca que la clave dejó de funcionar (para avisar en Conexiones). */
  async marcarFallo(orgId: string): Promise<void> {
    await conOrg(this.pool, orgId, (c) => c.query(
      'UPDATE credenciales_conector SET prueba_ok = false, probada_en = now() WHERE conector = $1 AND nombre = $2', [CONECTOR, NOMBRE])).catch(() => undefined);
  }
}

export { MENSAJES_CONECTOR };

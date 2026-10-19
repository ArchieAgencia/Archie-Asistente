import type pg from 'pg';
import { z } from 'zod';
import { ErrorAuth, type SesionActiva } from '../auth/servicio.js';
import { Limitador } from '../auth/limitador.js';
import { cifrar, descifrar, type Llaves } from '../crypto.js';
import { conOrg } from '../db/pool.js';
import type { HttpSeguro } from '../conectores/http-seguro.js';
import { crearAdaptadorPauta, esPlataformaPauta, type CredencialPauta } from '../conectores/pauta/fabrica.js';
import type { ResolutorPauta } from '../conectores/pauta/herramientas.js';
import { cuentaMeta, TOKEN_META } from '../conectores/pauta/meta.js';
import { anuncianteTiktok, TOKEN_TIKTOK } from '../conectores/pauta/tiktok.js';
import { ErrorPauta, type AdaptadorPauta, type PlataformaPauta } from '../conectores/pauta/tipos.js';

export const MAX_CUENTAS_PAUTA_POR_ORG = 20;
const NOMBRE = /^[\p{L}\p{N} ._-]{1,60}$/u;
const conectorDe = (p: PlataformaPauta) => `pauta_${p}`;
const contextoDe = (p: PlataformaPauta) => `conector:pauta_${p}`;

export interface CuentaPautaConectada { nombre: string; plataforma: PlataformaPauta; origen: string | null; probadaEn: Date | null; pruebaOk: boolean | null }

export const esquemaConexionPauta = z.discriminatedUnion('plataforma', [
  z.object({ plataforma: z.literal('meta'), nombre: z.string().trim().min(1).max(60), cuenta: z.string().trim().min(1).max(60), token: z.string().trim().min(1).max(600) }).strict(),
  z.object({ plataforma: z.literal('tiktok'), nombre: z.string().trim().min(1).max(60), anunciante: z.string().trim().min(1).max(60), token: z.string().trim().min(1).max(400) }).strict(),
]);
export type EntradaConexionPauta = z.infer<typeof esquemaConexionPauta>;

function preparar(e: EntradaConexionPauta): { cred: CredencialPauta; secretos: object; origen: string } | null {
  if (e.plataforma === 'meta') {
    const c = cuentaMeta(e.cuenta);
    if (!c || !TOKEN_META.test(e.token)) return null;
    return { cred: { plataforma: 'meta', cuenta: c, token: e.token }, secretos: { cuenta: c, token: e.token }, origen: `act_${c}` };
  }
  const a = anuncianteTiktok(e.anunciante);
  if (!a || !TOKEN_TIKTOK.test(e.token)) return null;
  return { cred: { plataforma: 'tiktok', anunciante: a, token: e.token }, secretos: { anunciante: a, token: e.token }, origen: a };
}

/** Cuentas publicitarias de cada organización. Los tokens se guardan cifrados (con la organización atada al cifrado) y NUNCA vuelven al navegador, al modelo ni a los registros. */
export class ServicioPauta {
  private readonly limite: Limitador;
  constructor(private readonly pool: pg.Pool, private readonly llaves: Llaves, private readonly http: HttpSeguro, private readonly log: { error: (o: object, m: string) => void } = { error: () => undefined }, intentos = { max: 10, ventanaMs: 15 * 60_000 }) {
    this.limite = new Limitador(intentos.max, intentos.ventanaMs);
  }

  async listar(orgId: string): Promise<CuentaPautaConectada[]> {
    const filas = await conOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT nombre, conector, origen, probada_en, prueba_ok FROM credenciales_conector WHERE conector LIKE 'pauta\\_%' ORDER BY lower(nombre)`)).rows);
    return filas.flatMap((f) => {
      const p = String(f.conector).slice('pauta_'.length);
      return esPlataformaPauta(p) ? [{ nombre: f.nombre as string, plataforma: p, origen: (f.origen as string | null) ?? null, probadaEn: f.probada_en ?? null, pruebaOk: f.prueba_ok ?? null }] : [];
    });
  }

  async conectar(s: SesionActiva, entrada: EntradaConexionPauta, ctx: { ip: string }): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las conexiones');
    if (!this.limite.permitir(s.orgId)) throw new ErrorAuth(429, 'demasiados_intentos', 'Demasiados intentos');
    if (!NOMBRE.test(entrada.nombre)) throw new ErrorAuth(400, 'nombre_invalido', 'El nombre solo puede tener letras, números, espacios, punto, guion y guion bajo (máximo 60)');
    const prep = preparar(entrada);
    if (!prep) throw new ErrorAuth(400, 'credencial_invalida', 'Los datos de la cuenta no tienen un formato válido');
    try {
      await crearAdaptadorPauta(prep.cred, this.http).probar();
    } catch (e) {
      if (e instanceof ErrorPauta) throw new ErrorAuth(422, `pauta_${e.codigo}`, e.message);
      throw e;
    }
    const conector = conectorDe(entrada.plataforma);
    const sec = cifrar(this.llaves, JSON.stringify(prep.secretos), s.orgId, contextoDe(entrada.plataforma));
    await conOrg(this.pool, s.orgId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pauta:${s.orgId}`]);
      const otras = (await c.query(`SELECT conector, nombre FROM credenciales_conector WHERE conector LIKE 'pauta\\_%'`)).rows as { conector: string; nombre: string }[];
      const mismo = otras.find((o) => o.nombre.toLowerCase() === entrada.nombre.toLowerCase());
      if (mismo && mismo.conector !== conector) throw new ErrorAuth(409, 'nombre_en_uso', 'Ya hay una cuenta con ese nombre. Elige otro.');
      if (!mismo && otras.length >= MAX_CUENTAS_PAUTA_POR_ORG) throw new ErrorAuth(409, 'demasiadas_cuentas', `Se alcanzó el máximo de ${MAX_CUENTAS_PAUTA_POR_ORG} cuentas publicitarias conectadas`);
      await c.query(
        `INSERT INTO credenciales_conector (org_id, conector, nombre, secreto, clave_version, creada_por, origen, probada_en, prueba_ok)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), true)
         ON CONFLICT (org_id, conector, nombre)
         DO UPDATE SET secreto = EXCLUDED.secreto, clave_version = EXCLUDED.clave_version, origen = EXCLUDED.origen, rotada_en = now(), probada_en = now(), prueba_ok = true`,
        [s.orgId, conector, mismo?.nombre ?? entrada.nombre, sec.datos, sec.version, s.usuarioId, prep.origen]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'conexion_pauta_guardada', JSON.stringify({ plataforma: entrada.plataforma, nombre: entrada.nombre, ip: ctx.ip })]);
    });
  }

  async desconectar(s: SesionActiva, nombre: string, ctx: { ip: string }): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las conexiones');
    await conOrg(this.pool, s.orgId, async (c) => {
      const r = await c.query(`DELETE FROM credenciales_conector WHERE conector LIKE 'pauta\\_%' AND lower(nombre) = lower($1) RETURNING conector, nombre`, [nombre]);
      if (!r.rowCount) throw new ErrorAuth(404, 'no_encontrado', 'Esa cuenta no está conectada');
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'conexion_pauta_quitada', JSON.stringify({ plataforma: String(r.rows[0].conector).slice('pauta_'.length), nombre: r.rows[0].nombre, ip: ctx.ip })]);
    });
  }

  async marcarFallo(orgId: string, nombre: string): Promise<void> {
    await conOrg(this.pool, orgId, (c) => c.query(
      `UPDATE credenciales_conector SET prueba_ok = false, probada_en = now() WHERE conector LIKE 'pauta\\_%' AND nombre = $1`, [nombre])).catch(() => undefined);
  }

  /** Resolutor para el chat: lista nombres y plataformas y, al pedir una cuenta, descifra el token en memoria. Si la plataforma rechaza el token, se marca la conexión. */
  async resolutor(orgId: string): Promise<ResolutorPauta | null> {
    const cuentas = await this.listar(orgId);
    if (cuentas.length === 0) return null;
    const porClave = new Map(cuentas.map((t) => [t.nombre.toLowerCase(), t]));
    return {
      listar: () => cuentas.map((t) => ({ nombre: t.nombre, plataforma: t.plataforma })),
      obtener: async (nombre) => {
        const t = porClave.get(nombre.trim().toLowerCase());
        if (!t) throw new ErrorPauta('no_conectada');
        const f = await conOrg(this.pool, orgId, async (c) => (await c.query(
          'SELECT secreto, clave_version FROM credenciales_conector WHERE conector = $1 AND nombre = $2', [conectorDe(t.plataforma), t.nombre])).rows[0]);
        if (!f) throw new ErrorPauta('no_conectada');
        let adaptador: AdaptadorPauta;
        try {
          const cred = JSON.parse(descifrar(this.llaves, { version: f.clave_version, datos: f.secreto }, orgId, contextoDe(t.plataforma))) as Record<string, string>;
          adaptador = crearAdaptadorPauta({ plataforma: t.plataforma, ...cred } as CredencialPauta, this.http);
        } catch (e) {
          if (e instanceof ErrorPauta) throw e;
          this.log.error({ plataforma: t.plataforma }, 'no se pudieron leer las credenciales de una cuenta de pauta');
          throw new ErrorPauta('no_conectada');
        }
        return { nombre: t.nombre, plataforma: t.plataforma, adaptador: this.vigilar(adaptador, orgId, t.nombre) };
      },
    };
  }

  private vigilar(a: AdaptadorPauta, orgId: string, nombre: string): AdaptadorPauta {
    const v = async <T>(f: () => Promise<T>): Promise<T> => {
      try { return await f(); } catch (e) { if (e instanceof ErrorPauta && e.codigo === 'credencial_rechazada') await this.marcarFallo(orgId, nombre); throw e; }
    };
    return { plataforma: a.plataforma, probar: () => v(() => a.probar()), resumen: (p, r) => v(() => a.resumen(p, r)), ranking: (o) => v(() => a.ranking(o)) };
  }
}

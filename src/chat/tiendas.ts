import type pg from 'pg';
import { z } from 'zod';
import { ErrorAuth, type SesionActiva } from '../auth/servicio.js';
import { Limitador } from '../auth/limitador.js';
import { cifrar, descifrar, type Llaves } from '../crypto.js';
import { conOrg } from '../db/pool.js';
import type { HttpSeguro } from '../conectores/http-seguro.js';
import { crearAdaptador, esPlataforma, type CredencialTienda } from '../conectores/tiendas/fabrica.js';
import type { ResolutorTiendas } from '../conectores/tiendas/herramientas.js';
import { CLAVE_WOO, dominioWoo, SECRETO_WOO } from '../conectores/tiendas/woocommerce.js';
import { subdominioShopify, TOKEN_SHOPIFY } from '../conectores/tiendas/shopify.js';
import { APP_KEY_VTEX, APP_TOKEN_VTEX, cuentaVtex } from '../conectores/tiendas/vtex.js';
import { ErrorTienda, type AdaptadorTienda, type Plataforma } from '../conectores/tiendas/tipos.js';

export const MAX_TIENDAS_POR_ORG = 10;
const NOMBRE = /^[\p{L}\p{N} ._-]{1,60}$/u;
const conectorDe = (p: Plataforma) => `tienda_${p}`;
const contextoDe = (p: Plataforma) => `conector:tienda_${p}`;

export interface TiendaConectada { nombre: string; plataforma: Plataforma; origen: string | null; probadaEn: Date | null; pruebaOk: boolean | null }

/** Lo que escribe el administrador. Cada plataforma pide cosas distintas; los textos se validan de nuevo al crear el adaptador. */
export const esquemaConexionTienda = z.discriminatedUnion('plataforma', [
  z.object({ plataforma: z.literal('woocommerce'), nombre: z.string().trim().min(1).max(60), dominio: z.string().trim().min(1).max(300), clave: z.string().trim().min(1).max(200), secreto: z.string().trim().min(1).max(200) }).strict(),
  z.object({ plataforma: z.literal('shopify'), nombre: z.string().trim().min(1).max(60), tienda: z.string().trim().min(1).max(300), token: z.string().trim().min(1).max(300) }).strict(),
  z.object({ plataforma: z.literal('vtex'), nombre: z.string().trim().min(1).max(60), cuenta: z.string().trim().min(1).max(300), appKey: z.string().trim().min(1).max(200), appToken: z.string().trim().min(1).max(400) }).strict(),
]);
export type EntradaConexionTienda = z.infer<typeof esquemaConexionTienda>;

/** Qué se guarda cifrado (todo lo de la credencial) y qué se muestra (el origen). Devuelve null si el formato no es válido. */
function preparar(e: EntradaConexionTienda): { cred: CredencialTienda; secretos: object; origen: string } | null {
  switch (e.plataforma) {
    case 'woocommerce': {
      const d = dominioWoo(e.dominio);
      if (!d || !CLAVE_WOO.test(e.clave) || !SECRETO_WOO.test(e.secreto)) return null;
      return { cred: { plataforma: 'woocommerce', dominio: d, clave: e.clave, secreto: e.secreto }, secretos: { dominio: d, clave: e.clave, secreto: e.secreto }, origen: d };
    }
    case 'shopify': {
      const t = subdominioShopify(e.tienda);
      if (!t || !TOKEN_SHOPIFY.test(e.token)) return null;
      return { cred: { plataforma: 'shopify', tienda: t, token: e.token }, secretos: { tienda: t, token: e.token }, origen: `${t}.myshopify.com` };
    }
    case 'vtex': {
      const c = cuentaVtex(e.cuenta);
      if (!c || !APP_KEY_VTEX.test(e.appKey) || !APP_TOKEN_VTEX.test(e.appToken)) return null;
      return { cred: { plataforma: 'vtex', cuenta: c, appKey: e.appKey, appToken: e.appToken }, secretos: { cuenta: c, appKey: e.appKey, appToken: e.appToken }, origen: c };
    }
  }
}

/** Conexiones de cada organización con sus tiendas. Las credenciales se guardan cifradas (con la organización atada al cifrado) y NUNCA vuelven al navegador, al modelo ni a los registros. */
export class ServicioTiendas {
  private readonly limite: Limitador;
  constructor(private readonly pool: pg.Pool, private readonly llaves: Llaves, private readonly http: HttpSeguro, private readonly log: { error: (o: object, m: string) => void } = { error: () => undefined }, intentos = { max: 10, ventanaMs: 15 * 60_000 }) {
    this.limite = new Limitador(intentos.max, intentos.ventanaMs);
  }

  async listar(orgId: string): Promise<TiendaConectada[]> {
    const filas = await conOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT nombre, conector, origen, probada_en, prueba_ok FROM credenciales_conector WHERE conector LIKE 'tienda\\_%' ORDER BY lower(nombre)`)).rows);
    return filas.flatMap((f) => {
      const p = String(f.conector).slice('tienda_'.length);
      return esPlataforma(p) ? [{ nombre: f.nombre as string, plataforma: p, origen: (f.origen as string | null) ?? null, probadaEn: f.probada_en ?? null, pruebaOk: f.prueba_ok ?? null }] : [];
    });
  }

  /** Prueba las credenciales contra la tienda y, solo si funcionan, las guarda cifradas. Solo administradores. */
  async conectar(s: SesionActiva, entrada: EntradaConexionTienda, ctx: { ip: string }): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las conexiones');
    if (!this.limite.permitir(s.orgId)) throw new ErrorAuth(429, 'demasiados_intentos', 'Demasiados intentos');
    if (!NOMBRE.test(entrada.nombre)) throw new ErrorAuth(400, 'nombre_invalido', 'El nombre solo puede tener letras, números, espacios, punto, guion y guion bajo (máximo 60)');
    const prep = preparar(entrada);
    if (!prep) throw new ErrorAuth(400, 'credencial_invalida', 'Los datos de la tienda no tienen un formato válido');
    try {
      await crearAdaptador(prep.cred, this.http).probar();
    } catch (e) {
      if (e instanceof ErrorTienda) throw new ErrorAuth(422, `tienda_${e.codigo}`, e.message);
      throw e;
    }
    const conector = conectorDe(entrada.plataforma);
    const sec = cifrar(this.llaves, JSON.stringify(prep.secretos), s.orgId, contextoDe(entrada.plataforma));
    await conOrg(this.pool, s.orgId, async (c) => {
      // Un solo cambio de conexiones por organización a la vez: el tope y el nombre único se comprueban sin carreras.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tiendas:${s.orgId}`]);
      const otras = (await c.query(
        `SELECT conector, nombre FROM credenciales_conector WHERE conector LIKE 'tienda\\_%'`)).rows as { conector: string; nombre: string }[];
      const mismo = otras.find((o) => o.nombre.toLowerCase() === entrada.nombre.toLowerCase());
      if (mismo && mismo.conector !== conector) throw new ErrorAuth(409, 'nombre_en_uso', 'Ya hay una tienda con ese nombre. Elige otro.');
      if (!mismo && otras.length >= MAX_TIENDAS_POR_ORG) throw new ErrorAuth(409, 'demasiadas_tiendas', `Se alcanzó el máximo de ${MAX_TIENDAS_POR_ORG} tiendas conectadas`);
      await c.query(
        `INSERT INTO credenciales_conector (org_id, conector, nombre, secreto, clave_version, creada_por, origen, probada_en, prueba_ok)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), true)
         ON CONFLICT (org_id, conector, nombre)
         DO UPDATE SET secreto = EXCLUDED.secreto, clave_version = EXCLUDED.clave_version, origen = EXCLUDED.origen, rotada_en = now(), probada_en = now(), prueba_ok = true`,
        [s.orgId, conector, mismo?.nombre ?? entrada.nombre, sec.datos, sec.version, s.usuarioId, prep.origen]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'conexion_tienda_guardada', JSON.stringify({ plataforma: entrada.plataforma, nombre: entrada.nombre, ip: ctx.ip })]);
    });
  }

  async desconectar(s: SesionActiva, nombre: string, ctx: { ip: string }): Promise<void> {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar las conexiones');
    await conOrg(this.pool, s.orgId, async (c) => {
      const r = await c.query(`DELETE FROM credenciales_conector WHERE conector LIKE 'tienda\\_%' AND lower(nombre) = lower($1) RETURNING conector, nombre`, [nombre]);
      if (!r.rowCount) throw new ErrorAuth(404, 'no_encontrado', 'Esa tienda no está conectada');
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'conexion_tienda_quitada', JSON.stringify({ plataforma: String(r.rows[0].conector).slice('tienda_'.length), nombre: r.rows[0].nombre, ip: ctx.ip })]);
    });
  }

  async marcarFallo(orgId: string, nombre: string): Promise<void> {
    await conOrg(this.pool, orgId, (c) => c.query(
      `UPDATE credenciales_conector SET prueba_ok = false, probada_en = now() WHERE conector LIKE 'tienda\\_%' AND nombre = $1`, [nombre])).catch(() => undefined);
  }

  /**
   * Resolutor para el chat de una organización: lista nombres y plataformas y, al pedir una tienda, descifra sus credenciales en memoria.
   * Si la tienda rechaza las credenciales, se marca la conexión como fallida (para avisar en Conexiones).
   */
  async resolutor(orgId: string): Promise<ResolutorTiendas | null> {
    const tiendas = await this.listar(orgId);
    if (tiendas.length === 0) return null;
    const porClave = new Map(tiendas.map((t) => [t.nombre.toLowerCase(), t]));
    return {
      listar: () => tiendas.map((t) => ({ nombre: t.nombre, plataforma: t.plataforma })),
      obtener: async (nombre) => {
        const t = porClave.get(nombre.trim().toLowerCase());
        if (!t) throw new ErrorTienda('no_conectada');
        const f = await conOrg(this.pool, orgId, async (c) => (await c.query(
          'SELECT secreto, clave_version FROM credenciales_conector WHERE conector = $1 AND nombre = $2', [conectorDe(t.plataforma), t.nombre])).rows[0]);
        if (!f) throw new ErrorTienda('no_conectada');
        let adaptador: AdaptadorTienda;
        try {
          const cred = JSON.parse(descifrar(this.llaves, { version: f.clave_version, datos: f.secreto }, orgId, contextoDe(t.plataforma))) as Record<string, string>;
          adaptador = crearAdaptador({ plataforma: t.plataforma, ...cred } as CredencialTienda, this.http);
        } catch (e) {
          if (e instanceof ErrorTienda) throw e;
          this.log.error({ plataforma: t.plataforma }, 'no se pudieron leer las credenciales de una tienda');
          throw new ErrorTienda('no_conectada');
        }
        return { nombre: t.nombre, plataforma: t.plataforma, adaptador: this.vigilar(adaptador, orgId, t.nombre) };
      },
    };
  }

  /** Mismo adaptador, pero si la tienda rechaza las credenciales deja constancia. No cambia ni filtra nada más. */
  private vigilar(a: AdaptadorTienda, orgId: string, nombre: string): AdaptadorTienda {
    const v = async <T>(f: () => Promise<T>): Promise<T> => {
      try { return await f(); } catch (e) { if (e instanceof ErrorTienda && e.codigo === 'credencial_rechazada') await this.marcarFallo(orgId, nombre); throw e; }
    };
    return {
      plataforma: a.plataforma,
      probar: () => v(() => a.probar()),
      pedidos: (f, l, c) => v(() => a.pedidos(f, l, c)),
      pedido: (id) => v(() => a.pedido(id)),
      productos: (o) => v(() => a.productos(o)),
      producto: (id) => v(() => a.producto(id)),
      stockBajo: (o) => v(() => a.stockBajo(o)),
      cupones: (o) => v(() => a.cupones(o)),
    };
  }
}

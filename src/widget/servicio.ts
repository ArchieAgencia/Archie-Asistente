import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { ErrorAuth, type SesionActiva } from '../auth/servicio.js';
import { Limitador } from '../auth/limitador.js';
import { hashToken, nuevoToken } from '../crypto.js';
import { conOrg } from '../db/pool.js';

export const MAX_ORIGENES = 10;
export const MAX_CLAVES = 5;
export const CANJE_SEGUNDOS = 120;       // el enlace de un solo uso dura 2 minutos
export const SESION_SEGUNDOS = 2 * 3600; // la sesión del widget dura 2 horas y no se renueva sola: la herramienta anfitriona pide otra
const PREFIJO_CLAVE = 'aiw_';
const NOMBRE = /^[\p{L}\p{N} ._-]{1,60}$/u;
const ORIGEN_BD = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,250}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAVE = /^aiw_[A-Za-z0-9_-]{43}$/;

export const esquemaOrigen = z.object({ origen: z.string().trim().min(1).max(260) }).strict();
export const esquemaClaveNueva = z.object({ nombre: z.string().trim().min(1).max(60) }).strict();
export const esquemaClaveQuitar = z.object({ id: z.string().uuid() }).strict();
export const esquemaPedirSesion = z.object({ email: z.string().trim().toLowerCase().min(3).max(320) }).strict();
export const esquemaCanje = z.object({ canje: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

/** «https://archiesend.com» → el mismo, normalizado. Solo https y solo el nombre del sitio: sin puerto, ruta, usuario ni parámetros. */
export function normalizarOrigen(entrada: string): string | null {
  const t = entrada.trim();
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (/[^a-z0-9.-]/i.test(u.hostname) || u.hostname.startsWith('xn--') === false && /[^\x00-\x7f]/.test(u.hostname)) return null;
  const o = `https://${u.hostname.toLowerCase()}`;
  if (!ORIGEN_BD.test(o) || !u.hostname.includes('.') || /^\d+(\.\d+){3}$/.test(u.hostname)) return null;
  return o;
}

export interface Ctx { ip: string }
export interface ClaveIncrustacion { id: string; nombre: string; prefijo: string; creadaEn: Date; ultimoUso: Date | null; revocada: boolean }

/** Origen de la página del widget: `frame-ancestors` con los sitios autorizados de esa organización (nada si no hay ninguno). */
export function politicaIncrustacion(origenes: string[]): string {
  const ancestros = origenes.length ? origenes.join(' ') : "'none'";
  return `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors ${ancestros}; base-uri 'none'; form-action 'none'`;
}

/** Widget embebible. La herramienta anfitriona (servidor) se identifica con una clave de incrustación y pide un enlace de un solo uso para
 *  una persona que YA es usuaria de la organización. El navegador nunca recibe una credencial de larga vida: canjea el enlace por una sesión de 2 horas
 *  que vive solo en memoria del iframe. Esa sesión sirve únicamente para las rutas del widget (conversar), nunca para el panel. */
export class ServicioWidget {
  private readonly limPedir: Limitador;
  private readonly limPedirClave: Limitador;
  private readonly limCanje: Limitador;
  constructor(private readonly pool: pg.Pool, private readonly origenPublico: string, limites = { pedirPorIp: 60, pedirPorClave: 120, canjePorIp: 60, ventanaMs: 60_000 }) {
    this.limPedir = new Limitador(limites.pedirPorIp, limites.ventanaMs);
    this.limPedirClave = new Limitador(limites.pedirPorClave, limites.ventanaMs);
    this.limCanje = new Limitador(limites.canjePorIp, limites.ventanaMs);
  }

  // ---------- Administración (solo administradores, con sesión completa del panel) ----------

  async listar(orgId: string): Promise<{ origenes: string[]; claves: ClaveIncrustacion[] }> {
    return conOrg(this.pool, orgId, async (c) => ({
      origenes: (await c.query('SELECT origen FROM incrustacion_origenes ORDER BY origen')).rows.map((f) => f.origen as string),
      claves: (await c.query('SELECT id, nombre, prefijo, creada_en, ultimo_uso, revocada_en FROM incrustacion_claves ORDER BY creada_en DESC')).rows
        .map((f) => ({ id: f.id as string, nombre: f.nombre as string, prefijo: f.prefijo as string, creadaEn: f.creada_en as Date, ultimoUso: (f.ultimo_uso as Date | null) ?? null, revocada: f.revocada_en !== null })),
    }));
  }

  private soloAdmin(s: SesionActiva): void {
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo un administrador puede cambiar el widget');
  }

  async agregarOrigen(s: SesionActiva, entrada: string, ctx: Ctx): Promise<string> {
    this.soloAdmin(s);
    const origen = normalizarOrigen(entrada);
    if (!origen) throw new ErrorAuth(400, 'origen_invalido', 'Escribe solo la dirección del sitio con https, por ejemplo https://tuherramienta.com (sin ruta, sin puerto y sin IP)');
    await conOrg(this.pool, s.orgId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`widget:${s.orgId}`]);
      const n = Number((await c.query('SELECT count(*) AS n FROM incrustacion_origenes')).rows[0].n);
      if (n >= MAX_ORIGENES) throw new ErrorAuth(409, 'demasiados_origenes', `Se alcanzó el máximo de ${MAX_ORIGENES} sitios autorizados`);
      await c.query('INSERT INTO incrustacion_origenes (org_id, origen, creado_por) VALUES ($1,$2,$3) ON CONFLICT (org_id, origen) DO NOTHING', [s.orgId, origen, s.usuarioId]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)', [s.orgId, s.usuarioId, 'widget_origen_agregado', JSON.stringify({ origen, ip: ctx.ip })]);
    });
    return origen;
  }

  async quitarOrigen(s: SesionActiva, entrada: string, ctx: Ctx): Promise<void> {
    this.soloAdmin(s);
    const origen = normalizarOrigen(entrada);
    if (!origen) throw new ErrorAuth(404, 'no_encontrado', 'Ese sitio no está autorizado');
    await conOrg(this.pool, s.orgId, async (c) => {
      const r = await c.query('DELETE FROM incrustacion_origenes WHERE origen = $1', [origen]);
      if (!r.rowCount) throw new ErrorAuth(404, 'no_encontrado', 'Ese sitio no está autorizado');
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)', [s.orgId, s.usuarioId, 'widget_origen_quitado', JSON.stringify({ origen, ip: ctx.ip })]);
    });
  }

  /** Devuelve la clave UNA sola vez; en la base solo queda su hash. */
  async crearClave(s: SesionActiva, nombre: string, ctx: Ctx): Promise<{ id: string; nombre: string; clave: string }> {
    this.soloAdmin(s);
    if (!NOMBRE.test(nombre)) throw new ErrorAuth(400, 'nombre_invalido', 'El nombre solo puede tener letras, números, espacios, punto, guion y guion bajo (máximo 60)');
    const clave = `${PREFIJO_CLAVE}${randomBytes(32).toString('base64url')}`;
    const id = await conOrg(this.pool, s.orgId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`widget:${s.orgId}`]);
      const n = Number((await c.query('SELECT count(*) AS n FROM incrustacion_claves WHERE revocada_en IS NULL')).rows[0].n);
      if (n >= MAX_CLAVES) throw new ErrorAuth(409, 'demasiadas_claves', `Se alcanzó el máximo de ${MAX_CLAVES} claves vigentes. Revoca una para crear otra.`);
      const r = await c.query('INSERT INTO incrustacion_claves (org_id, nombre, prefijo, clave_hash, creada_por) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [s.orgId, nombre, clave.slice(0, 8), hashToken(clave), s.usuarioId]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'widget_clave_creada', JSON.stringify({ nombre, prefijo: clave.slice(0, 8), ip: ctx.ip })]);
      return r.rows[0].id as string;
    });
    return { id, nombre, clave };
  }

  /** Revoca la clave y cierra de inmediato todas las sesiones que se abrieron con ella. */
  async revocarClave(s: SesionActiva, id: string, ctx: Ctx): Promise<void> {
    this.soloAdmin(s);
    await conOrg(this.pool, s.orgId, async (c) => {
      const r = await c.query('UPDATE incrustacion_claves SET revocada_en = now() WHERE id = $1 AND revocada_en IS NULL RETURNING nombre, prefijo', [id]);
      if (!r.rowCount) throw new ErrorAuth(404, 'no_encontrado', 'Esa clave no existe o ya estaba revocada');
      await c.query('DELETE FROM sesiones_widget WHERE clave_id = $1', [id]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, 'widget_clave_revocada', JSON.stringify({ nombre: r.rows[0].nombre, prefijo: r.rows[0].prefijo, ip: ctx.ip })]);
    });
  }

  // ---------- De servidor a servidor ----------

  /** La herramienta anfitriona pide un enlace de un solo uso para una persona. Respuestas iguales ante claves malas (no se revela nada). */
  async pedirSesion(claveEntrada: string, email: string, ctx: Ctx): Promise<{ url: string; expiraEnSegundos: number }> {
    if (!this.limPedir.permitir(ctx.ip)) throw new ErrorAuth(429, 'demasiados_intentos', 'Demasiados intentos');
    const rechazo = () => new ErrorAuth(401, 'clave_invalida', 'Clave inválida');
    if (!CLAVE.test(claveEntrada)) throw rechazo();
    const hash = hashToken(claveEntrada);
    if (!this.limPedirClave.permitir(hash.toString('hex'))) throw new ErrorAuth(429, 'demasiados_intentos', 'Demasiados intentos');
    const r = (await this.pool.query('SELECT clave_id, org_id FROM widget_clave_resolver($1)', [hash])).rows[0] as { clave_id: string; org_id: string } | undefined;
    if (!r) throw rechazo();
    const canje = nuevoToken();
    await conOrg(this.pool, r.org_id, async (c) => {
      const u = (await c.query('SELECT id FROM usuarios WHERE email = $1 AND activo', [email])).rows[0] as { id: string } | undefined;
      if (!u) throw new ErrorAuth(404, 'usuario_no_encontrado', 'Esa persona no es usuaria de Archie AI en esta organización');
      await c.query("INSERT INTO sesiones_widget (org_id, usuario_id, clave_id, tipo, token_hash, expira_en) VALUES ($1,$2,$3,'canje',$4, now() + make_interval(secs => $5))",
        [r.org_id, u.id, r.clave_id, hashToken(canje), CANJE_SEGUNDOS]);
      await c.query('UPDATE incrustacion_claves SET ultimo_uso = now() WHERE id = $1', [r.clave_id]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [r.org_id, u.id, 'widget_enlace_creado', JSON.stringify({ clave: claveEntrada.slice(0, 8), ip: ctx.ip })]);
    });
    // El enlace va en el fragmento (#): no viaja al servidor ni queda en registros de acceso.
    return { url: `${this.origenPublico}/widget/${r.org_id}#c=${canje}`, expiraEnSegundos: CANJE_SEGUNDOS };
  }

  // ---------- Desde el navegador (iframe) ----------

  async canjear(canje: string, ctx: Ctx): Promise<{ token: string; segundos: number }> {
    if (!this.limCanje.permitir(ctx.ip)) throw new ErrorAuth(429, 'demasiados_intentos', 'Demasiados intentos');
    const token = nuevoToken();
    try {
      await this.pool.query('SELECT * FROM widget_canjear($1,$2,$3)', [hashToken(canje), hashToken(token), SESION_SEGUNDOS]);
    } catch (e) {
      if ((e as { code?: string }).code === 'P0002') throw new ErrorAuth(401, 'enlace_invalido', 'El enlace no sirve: ya se usó o venció');
      throw e;
    }
    return { token, segundos: SESION_SEGUNDOS };
  }

  async resolver(token: string): Promise<SesionActiva | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const f = (await this.pool.query('SELECT * FROM widget_resolver($1)', [hashToken(token)])).rows[0];
    // Mínimo privilegio: dentro del widget TODAS las sesiones rigen como 'miembro', incluso si la persona es administradora.
    // Así una clave filtrada no da visión de administrador (tarjetas ni acciones de otras personas); lo administrativo se hace solo en el panel con 2FA.
    return f ? { sesionId: f.sesion_id, usuarioId: f.usuario_id, orgId: f.org_id, rol: 'miembro', mfaOk: true } : null;
  }

  async origenesDe(orgId: string): Promise<string[]> {
    if (!UUID.test(orgId)) return [];
    return (await this.pool.query('SELECT origen FROM widget_origenes_org($1)', [orgId])).rows.map((f) => f.origen as string);
  }

  async cerrar(token: string): Promise<void> {
    const s = await this.resolver(token);
    if (s) await conOrg(this.pool, s.orgId, (c) => c.query('DELETE FROM sesiones_widget WHERE id = $1', [s.sesionId]));
  }
}

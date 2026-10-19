import type pg from 'pg';
import { ErrorAuth, type Contexto, type SesionActiva } from '../auth/servicio.js';
import { hashPassword, hashToken, nuevoToken, validarPassword } from '../crypto.js';
import type { Notificador } from '../correo/notificador.js';
import { conOrg } from '../db/pool.js';

/** Cuánto dura una invitación. */
export const DIAS_INVITACION = 7;
/** Topes que frenan abusos (spam de correos a nombre de Archie): por organización. */
export const MAX_INVITACIONES_POR_HORA = 10;
export const MAX_PENDIENTES = 25;
export const MAX_EQUIPO = 25;

export type Rol = 'admin' | 'miembro';
export interface FilaInvitacion { id: string; email: string; rol: Rol; creada: string; expira: string; estado: 'pendiente' | 'vencida' | 'aceptada' | 'revocada' }
export interface Miembro { id: string; email: string; nombre: string | null; rol: Rol; totpActivo: boolean; activo: boolean; yo: boolean }

const INVALIDA = () => new ErrorAuth(404, 'invitacion_invalida', 'La invitación no es válida o ya venció');

/**
 * Invitaciones y equipo del cliente.
 *  - Públicas (sin sesión): ver y aceptar una invitación con el token del enlace.
 *  - Con sesión de administrador: invitar, reenviar, revocar, cambiar rol y activar o desactivar personas de su propia organización.
 * La organización siempre sale de la sesión, nunca de la entrada. Toda acción queda en la auditoría de la cuenta.
 */
export class ServicioInvitaciones {
  constructor(private readonly pool: pg.Pool, private readonly notificador: Notificador) {}

  // ---------- Públicas ----------

  async ver(token: string) {
    const r = await this.pool.query('SELECT * FROM invitacion_ver($1)', [hashToken(token)]);
    const f = r.rows[0] as { organizacion: string; email: string; rol: Rol; nombre_sugerido: string | null; expira_en: Date; ya_tiene_cuenta: boolean } | undefined;
    if (!f) throw INVALIDA();
    return { organizacion: f.organizacion, email: f.email, rol: f.rol, nombreSugerido: f.nombre_sugerido, expira: f.expira_en, yaTieneCuenta: f.ya_tiene_cuenta };
  }

  /** Crea la contraseña y la cuenta. No inicia sesión: la persona entra después con su correo y su contraseña (y activa los dos pasos). */
  async aceptar(token: string, nombre: string, password: string): Promise<void> {
    const err = validarPassword(password);
    if (err) throw new ErrorAuth(400, 'password_debil', err);
    const hash = await hashPassword(password);
    try {
      await this.pool.query('SELECT * FROM invitacion_aceptar($1,$2,$3)', [hashToken(token), nombre, hash]);
    } catch (e) {
      const x = e as { code?: string; message?: string };
      if (x.code === 'P0002') throw INVALIDA();
      if (x.code === '23505') throw new ErrorAuth(409, 'ya_existe', 'Ese correo ya tiene una cuenta en Archie AI'); // la invitación sigue pendiente (todo se deshizo)
      if (x.code === '22023') throw new ErrorAuth(400, 'datos_invalidos', 'Dato no válido');
      throw e;
    }
  }

  // ---------- Equipo del cliente (administradores) ----------

  private exigirAdmin(s: SesionActiva) {
    if (!s.mfaOk) throw new ErrorAuth(403, 'sesion_incompleta', 'Falta completar el segundo factor');
    if (s.rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo las personas administradoras pueden hacer esto');
  }

  /** Dentro de la transacción: quien actúa sigue siendo administrador activo (otra petición pudo desactivarlo justo antes). */
  private async exigirVigente(c: pg.PoolClient, s: SesionActiva): Promise<void> {
    const r = await c.query('SELECT rol, activo FROM usuarios WHERE id = $1 AND org_id = $2', [s.usuarioId, s.orgId]);
    if (!r.rows[0] || !r.rows[0].activo || r.rows[0].rol !== 'admin') throw new ErrorAuth(403, 'no_autorizado', 'Solo las personas administradoras pueden hacer esto');
  }

  async listar(s: SesionActiva): Promise<{ miembros: Miembro[]; invitaciones: FilaInvitacion[]; puedeAdministrar: boolean }> {
    return conOrg(this.pool, s.orgId, async (c) => {
      const m = await c.query('SELECT id, email, nombre, rol, totp_activo, activo FROM usuarios WHERE org_id = $1 ORDER BY creado_en', [s.orgId]);
      const i = await c.query(
        `SELECT id, email, rol, creada_en, expira_en, usada_en, revocada_en FROM invitaciones WHERE org_id = $1
         ORDER BY creada_en DESC LIMIT 30`, [s.orgId]);
      return {
        puedeAdministrar: s.rol === 'admin',
        miembros: m.rows.map((f) => ({ id: f.id, email: f.email, nombre: f.nombre, rol: f.rol, totpActivo: f.totp_activo, activo: f.activo, yo: f.id === s.usuarioId })),
        invitaciones: i.rows.map((f) => ({
          id: f.id, email: f.email, rol: f.rol, creada: f.creada_en, expira: f.expira_en,
          estado: f.usada_en ? 'aceptada' : f.revocada_en ? 'revocada' : new Date(f.expira_en).getTime() <= Date.now() ? 'vencida' : 'pendiente',
        } as FilaInvitacion)),
      };
    });
  }

  async invitar(s: SesionActiva, email: string, rol: Rol, ctx: Contexto): Promise<{ enviado: boolean; enlace?: string }> {
    this.exigirAdmin(s);
    const correo = email.trim().toLowerCase();
    const token = nuevoToken();
    const dat = await conOrg(this.pool, s.orgId, async (c) => {
      // Un solo cambio de equipo a la vez por organización (los topes y la regla del último administrador no se saltan con peticiones simultáneas).
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 728))', [s.orgId]);
      await this.exigirVigente(c, s);
      if ((await c.query('SELECT 1 FROM usuarios WHERE org_id = $1 AND email = $2', [s.orgId, correo])).rowCount) {
        throw new ErrorAuth(409, 'ya_en_equipo', 'Esa persona ya está en tu equipo');
      }
      const cnt = (await c.query(
        `SELECT (SELECT count(*) FROM usuarios WHERE org_id = $1 AND activo) AS equipo,
                (SELECT count(*) FROM invitaciones WHERE org_id = $1 AND usada_en IS NULL AND revocada_en IS NULL AND expira_en > now() AND email <> $2) AS pendientes,
                (SELECT count(*) FROM invitaciones WHERE org_id = $1 AND creada_en > now() - interval '1 hour') AS ultima_hora`, [s.orgId, correo])).rows[0];
      if (Number(cnt.ultima_hora) >= MAX_INVITACIONES_POR_HORA) throw new ErrorAuth(429, 'demasiadas_invitaciones', 'Enviaste muchas invitaciones. Espera un rato e inténtalo otra vez.');
      if (Number(cnt.pendientes) >= MAX_PENDIENTES) throw new ErrorAuth(409, 'demasiadas_pendientes', 'Hay demasiadas invitaciones pendientes. Revoca algunas primero.');
      if (Number(cnt.equipo) + Number(cnt.pendientes) >= MAX_EQUIPO) throw new ErrorAuth(409, 'equipo_lleno', 'Tu equipo llegó al máximo de personas.');
      // Reinvitar al mismo correo reemplaza la invitación anterior (el enlace viejo deja de servir).
      await c.query('UPDATE invitaciones SET revocada_en = now() WHERE org_id = $1 AND email = $2 AND usada_en IS NULL AND revocada_en IS NULL', [s.orgId, correo]);
      const expira = new Date(Date.now() + DIAS_INVITACION * 86_400_000);
      const ins = await c.query(
        `INSERT INTO invitaciones (org_id, email, rol, token_hash, invitado_por_usuario, expira_en) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, expira_en`,
        [s.orgId, correo, rol, hashToken(token), s.usuarioId, expira]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)', [s.orgId, s.usuarioId, 'invitacion_creada', JSON.stringify({ ip: ctx.ip, rol })]);
      const o = (await c.query(
        `SELECT (SELECT nombre FROM organizaciones WHERE id = $1) AS org, (SELECT coalesce(nombre, email) FROM usuarios WHERE id = $2) AS quien`, [s.orgId, s.usuarioId])).rows[0];
      return { id: ins.rows[0].id as string, expira: ins.rows[0].expira_en as Date, org: o.org as string, quien: o.quien as string };
    });
    return this.notificador.invitacion({ para: correo, organizacion: dat.org, invitador: dat.quien, rol, token, expira: dat.expira, clave: dat.id });
  }

  /** Genera un enlace nuevo para una invitación pendiente o vencida (el anterior deja de servir). */
  async reenviar(s: SesionActiva, id: string, ctx: Contexto): Promise<{ enviado: boolean; enlace?: string }> {
    this.exigirAdmin(s);
    const token = nuevoToken();
    const dat = await conOrg(this.pool, s.orgId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 728))', [s.orgId]);
      await this.exigirVigente(c, s);
      const v = (await c.query('SELECT email, rol, usada_en, revocada_en FROM invitaciones WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, s.orgId])).rows[0];
      if (!v || v.usada_en) throw new ErrorAuth(404, 'no_encontrado', 'No encontramos esa invitación');
      const ult = (await c.query(`SELECT count(*) AS n FROM invitaciones WHERE org_id = $1 AND creada_en > now() - interval '1 hour'`, [s.orgId])).rows[0];
      if (Number(ult.n) >= MAX_INVITACIONES_POR_HORA) throw new ErrorAuth(429, 'demasiadas_invitaciones', 'Enviaste muchas invitaciones. Espera un rato e inténtalo otra vez.');
      await c.query('UPDATE invitaciones SET revocada_en = now() WHERE org_id = $1 AND email = $2 AND usada_en IS NULL AND revocada_en IS NULL', [s.orgId, v.email]);
      const expira = new Date(Date.now() + DIAS_INVITACION * 86_400_000);
      const ins = await c.query(
        `INSERT INTO invitaciones (org_id, email, rol, token_hash, invitado_por_usuario, expira_en) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [s.orgId, v.email, v.rol, hashToken(token), s.usuarioId, expira]);
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)', [s.orgId, s.usuarioId, 'invitacion_reenviada', JSON.stringify({ ip: ctx.ip })]);
      const o = (await c.query(
        `SELECT (SELECT nombre FROM organizaciones WHERE id = $1) AS org, (SELECT coalesce(nombre, email) FROM usuarios WHERE id = $2) AS quien`, [s.orgId, s.usuarioId])).rows[0];
      return { nuevoId: ins.rows[0].id as string, email: v.email as string, rol: v.rol as Rol, expira, org: o.org as string, quien: o.quien as string };
    });
    return this.notificador.invitacion({ para: dat.email, organizacion: dat.org, invitador: dat.quien, rol: dat.rol, token, expira: dat.expira, clave: dat.nuevoId });
  }

  async revocar(s: SesionActiva, id: string, ctx: Contexto): Promise<void> {
    this.exigirAdmin(s);
    await conOrg(this.pool, s.orgId, async (c) => {
      await this.exigirVigente(c, s);
      const r = await c.query(
        'UPDATE invitaciones SET revocada_en = now() WHERE id = $1 AND org_id = $2 AND usada_en IS NULL AND revocada_en IS NULL RETURNING id', [id, s.orgId]);
      if (!r.rowCount) throw new ErrorAuth(404, 'no_encontrado', 'No encontramos esa invitación pendiente');
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)', [s.orgId, s.usuarioId, 'invitacion_revocada', JSON.stringify({ ip: ctx.ip })]);
    });
  }

  /**
   * Cambia el rol o activa/desactiva a una persona del equipo. Reglas: nadie se cambia a sí mismo (evita quedarse fuera por error)
   * y siempre debe quedar al menos una persona administradora activa. Desactivar cierra sus sesiones.
   */
  async cambiarMiembro(s: SesionActiva, usuarioId: string, cambio: { rol?: Rol; activo?: boolean }, ctx: Contexto): Promise<void> {
    this.exigirAdmin(s);
    if (usuarioId === s.usuarioId) throw new ErrorAuth(409, 'no_a_ti_mismo', 'No puedes cambiar tu propio rol ni desactivarte');
    await conOrg(this.pool, s.orgId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 728))', [s.orgId]);
      await this.exigirVigente(c, s);
      const u = (await c.query('SELECT id, rol, activo FROM usuarios WHERE id = $1 AND org_id = $2 FOR UPDATE', [usuarioId, s.orgId])).rows[0];
      if (!u) throw new ErrorAuth(404, 'no_encontrado', 'No encontramos a esa persona');
      const nuevoRol = cambio.rol ?? (u.rol as Rol);
      const nuevoActivo = cambio.activo ?? (u.activo as boolean);
      if (nuevoRol === u.rol && nuevoActivo === u.activo) return;
      if (nuevoActivo && !u.activo) {
        const n = (await c.query('SELECT count(*) AS n FROM usuarios WHERE org_id = $1 AND activo', [s.orgId])).rows[0];
        if (Number(n.n) >= MAX_EQUIPO) throw new ErrorAuth(409, 'equipo_lleno', 'Tu equipo llegó al máximo de personas.');
      }
      // Siempre queda al menos una persona administradora activa: quien actúa lo es (verificado arriba) y es distinta de la modificada.
      await c.query('UPDATE usuarios SET rol = $2, activo = $3 WHERE id = $1', [usuarioId, nuevoRol, nuevoActivo]);
      if (!nuevoActivo && u.activo) await c.query('DELETE FROM sesiones WHERE usuario_id = $1', [usuarioId]);
      if (nuevoRol !== u.rol) await c.query('DELETE FROM sesiones WHERE usuario_id = $1', [usuarioId]); // el rol nuevo rige desde el siguiente acceso
      const accion = nuevoActivo !== u.activo ? (nuevoActivo ? 'miembro_reactivado' : 'miembro_desactivado') : 'rol_cambiado';
      await c.query('INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
        [s.orgId, s.usuarioId, accion, JSON.stringify({ ip: ctx.ip, objetivo: usuarioId, rol: nuevoRol })]);
    });
  }
}

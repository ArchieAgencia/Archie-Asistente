import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { hashPassword } from '../crypto.js';
import { conOrg } from './pool.js';

/**
 * Crea una organización con su primer administrador. Es una operación de operador (se ejecuta con el rol dueño),
 * no una ruta de la API: nadie puede registrarse solo.
 */
export async function crearOrganizacionConAdmin(
  owner: pg.Pool,
  datos: { nombre: string; email: string; password: string; nombreAdmin?: string; plan?: string },
): Promise<{ orgId: string; usuarioId: string }> {
  const orgId = randomUUID();
  const usuarioId = randomUUID();
  const hash = await hashPassword(datos.password); // valida largo mínimo y máximo
  await conOrg(owner, orgId, async (c) => {
    await c.query('INSERT INTO organizaciones (id, nombre, plan_id) VALUES ($1,$2,$3)', [orgId, datos.nombre, datos.plan ?? 'prueba']);
    await c.query('INSERT INTO usuarios (id, org_id, email, password_hash, rol, nombre) VALUES ($1,$2,$3,$4,$5,$6)',
      [usuarioId, orgId, datos.email.trim().toLowerCase(), hash, 'admin', datos.nombreAdmin ?? null]);
    // Consultas del plan inicial (idempotente por mes y plan).
    await c.query(
      `INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia, detalle)
       SELECT o.id, 'plan', p.cuota_mensual, 'plan:' || to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM') || ':' || p.id, 'Consultas del plan inicial'
       FROM organizaciones o JOIN planes p ON p.id = o.plan_id WHERE o.id = $1 AND p.cuota_mensual > 0`, [orgId]);
    await c.query("INSERT INTO auditoria (org_id, usuario_id, accion) VALUES ($1,$2,'organizacion_creada')", [orgId, usuarioId]);
  });
  return { orgId, usuarioId };
}

/** Operador: desactiva el 2FA de un usuario (teléfono perdido), lo desbloquea y cierra todas sus sesiones. */
export async function resetear2fa(owner: pg.Pool, email: string): Promise<boolean> {
  const busca = await owner.query<{ id: string; org_id: string }>('SELECT id, org_id FROM usuarios WHERE email = $1', [email.trim().toLowerCase()]);
  const u = busca.rows[0];
  if (!u) return false;
  await conOrg(owner, u.org_id, async (c) => {
    await c.query(
      `UPDATE usuarios SET totp_activo = false, totp_secreto = NULL, totp_clave_version = NULL, totp_ultimo_paso = NULL,
         intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`, [u.id]);
    await c.query('DELETE FROM sesiones WHERE usuario_id = $1', [u.id]);
    await c.query("INSERT INTO auditoria (org_id, usuario_id, accion) VALUES ($1,$2,'2fa_reseteado_por_operador')", [u.org_id, u.id]);
  });
  return true;
}

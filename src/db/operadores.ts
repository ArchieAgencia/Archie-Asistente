import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { cifrar, hashPassword, type Llaves } from '../crypto.js';
import { nuevoSecretoTotp, uriTotp } from '../auth/totp.js';

/** Organización "nula" para atar el cifrado del secreto de un operador (los operadores no pertenecen a ninguna organización). */
export const ORG_OPERADORES = '00000000-0000-0000-0000-000000000000';
export const contextoTotpOperador = (id: string) => `totp-operador:${id}`;

export type RolOperador = 'admin' | 'soporte' | 'finanzas';

/**
 * Crea un operador del equipo de Archie Tech. Es una tarea de operador (rol dueño en el servidor), no una ruta de la API.
 * El segundo factor es obligatorio: el secreto se genera aquí y se entrega UNA sola vez (para la app de autenticación).
 */
export async function crearOperador(
  owner: pg.Pool, llaves: Llaves, d: { email: string; nombre: string; rol: RolOperador; password: string },
): Promise<{ id: string; secretoTotp: string; uri: string }> {
  const id = randomUUID();
  const email = d.email.trim().toLowerCase();
  const hash = await hashPassword(d.password);
  const secreto = nuevoSecretoTotp();
  const cif = cifrar(llaves, secreto, ORG_OPERADORES, contextoTotpOperador(id));
  await owner.query(
    `INSERT INTO operadores (id, email, nombre, rol, password_hash, totp_secreto, totp_clave_version) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, email, d.nombre.trim(), d.rol, hash, cif.datos, cif.version]);
  return { id, secretoTotp: secreto, uri: uriTotp(secreto, email) };
}

/** Operador perdió su teléfono: se genera un secreto nuevo, se cierran sus sesiones y se desbloquea. Devuelve el secreto nuevo (una sola vez). */
export async function regenerar2faOperador(owner: pg.Pool, llaves: Llaves, email: string): Promise<{ secretoTotp: string; uri: string } | null> {
  const r = await owner.query<{ id: string }>('SELECT id FROM operadores WHERE email = $1', [email.trim().toLowerCase()]);
  const id = r.rows[0]?.id;
  if (!id) return null;
  const secreto = nuevoSecretoTotp();
  const cif = cifrar(llaves, secreto, ORG_OPERADORES, contextoTotpOperador(id));
  await owner.query('UPDATE operadores SET totp_secreto=$2, totp_clave_version=$3, totp_ultimo_paso=NULL, intentos_fallidos=0, bloqueado_hasta=NULL WHERE id=$1', [id, cif.datos, cif.version]);
  await owner.query('DELETE FROM sesiones_operador WHERE operador_id = $1', [id]);
  return { secretoTotp: secreto, uri: uriTotp(secreto, email.trim().toLowerCase()) };
}

export async function desactivarOperador(owner: pg.Pool, email: string): Promise<boolean> {
  const r = await owner.query('UPDATE operadores SET activo = false WHERE email = $1 RETURNING id', [email.trim().toLowerCase()]);
  if (r.rowCount) await owner.query('DELETE FROM sesiones_operador WHERE operador_id = $1', [r.rows[0].id]);
  return Boolean(r.rowCount);
}

/**
 * Marca una organización como la cuenta propia de Archie Tech (la que el equipo usa como si fuera un cliente, desde "Mi cuenta").
 * Es una tarea de operador (rol dueño en el servidor), no una ruta de la API. Solo puede haber una.
 */
export async function marcarCuentaPropia(owner: pg.Pool, orgId: string): Promise<boolean> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await c.query('UPDATE organizaciones SET es_propia = false WHERE es_propia AND id <> $1', [orgId]);
    const r = await c.query('UPDATE organizaciones SET es_propia = true WHERE id = $1', [orgId]);
    await c.query('COMMIT');
    return Boolean(r.rowCount);
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

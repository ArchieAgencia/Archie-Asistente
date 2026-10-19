import pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function crearPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

/**
 * Ejecuta `fn` dentro de una transacción con la organización fijada para la seguridad por filas.
 * La organización la decide el servidor (sesión), nunca la entrada del usuario ni un modelo de IA.
 */
export async function conOrg<T>(pool: pg.Pool, orgId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!UUID.test(orgId)) throw new Error('Organización inválida');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

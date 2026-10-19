import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/** Aplica las migraciones numeradas una sola vez, con candado, y detecta si una ya aplicada fue modificada. */
export async function migrar(pool: pg.Pool, carpeta: string): Promise<string[]> {
  const c = await pool.connect();
  const aplicadas: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(727272)');
    await c.query(`CREATE TABLE IF NOT EXISTS migraciones (
      nombre text PRIMARY KEY, checksum text NOT NULL, aplicada_en timestamptz NOT NULL DEFAULT now())`);
    const archivos = (await readdir(carpeta)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const f of archivos) {
      const sql = await readFile(join(carpeta, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const previa = await c.query<{ checksum: string }>('SELECT checksum FROM migraciones WHERE nombre = $1', [f]);
      if (previa.rows[0]) {
        if (previa.rows[0].checksum !== sum) throw new Error(`La migración ${f} ya aplicada fue modificada`);
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO migraciones (nombre, checksum) VALUES ($1, $2)', [f, sum]);
        await c.query('COMMIT');
        aplicadas.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727272)').catch(() => undefined);
    c.release();
  }
  return aplicadas;
}

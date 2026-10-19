// Aplica las migraciones pendientes con el rol dueño (se puede repetir sin riesgo):
//   ARCHIE_OWNER_URL=... node dist/cli/migrar.js
// Antes de migrar en producción: copia de seguridad de la base de datos.
import { join } from 'node:path';
import { crearPool } from '../db/pool.js';
import { migrar } from '../db/migrar.js';

const url = process.env.ARCHIE_OWNER_URL;
if (!url) {
  console.error('Falta la variable ARCHIE_OWNER_URL');
  process.exit(1);
}
const pool = crearPool(url, 2);
try {
  const aplicadas = await migrar(pool, process.env.ARCHIE_MIGRACIONES ?? join(process.cwd(), 'migrations'));
  console.log(aplicadas.length ? `Migraciones aplicadas: ${aplicadas.join(', ')}` : 'Sin migraciones pendientes.');
} catch (e) {
  console.error('No se pudo migrar:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}

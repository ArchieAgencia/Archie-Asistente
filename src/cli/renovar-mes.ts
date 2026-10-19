// Tarea mensual (día 1), en el servidor, con el rol dueño:
//   ARCHIE_OWNER_URL=... node dist/cli/renovar-mes.js
// Se puede repetir sin riesgo: no suma dos veces en el mismo mes.
import { crearPool } from '../db/pool.js';
import { renovarMes } from '../db/renovacion.js';

const url = process.env.ARCHIE_OWNER_URL;
if (!url) { console.error('Falta la variable ARCHIE_OWNER_URL'); process.exit(1); }
const pool = crearPool(url, 2);
try {
  const r = await renovarMes(pool);
  console.log(`Renovadas: ${r.renovadas}. Ya renovadas este mes: ${r.yaRenovadas}. Omitidas: ${r.omitidas}.`);
} catch (e) {
  console.error('No se pudo renovar:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}

// Marca una organización como la cuenta propia de Archie Tech ("Mi cuenta" en la consola). Solo puede haber una; marcar otra mueve la marca.
//   ARCHIE_OWNER_URL=... ARCHIE_ORG_ID=<uuid de la organización> node dist/cli/marcar-cuenta-propia.js
import { crearPool } from '../db/pool.js';
import { marcarCuentaPropia } from '../db/operadores.js';

const { ARCHIE_OWNER_URL: url, ARCHIE_ORG_ID: orgId } = process.env;
if (!url || !orgId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
  console.error('Faltan o son inválidas: ARCHIE_OWNER_URL, ARCHIE_ORG_ID (uuid)');
  process.exit(1);
}
const pool = crearPool(url, 2);
try {
  const ok = await marcarCuentaPropia(pool, orgId);
  console.log(ok ? 'Listo: esa organización es ahora la cuenta propia de Archie Tech.' : 'No existe una organización con ese identificador.');
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('No se pudo marcar:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}

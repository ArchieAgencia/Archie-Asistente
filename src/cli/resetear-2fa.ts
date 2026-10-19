// Si una persona pierde su teléfono: el operador desactiva su segundo factor y cierra sus sesiones.
//   ARCHIE_OWNER_URL=... ARCHIE_ADMIN_EMAIL=ana@ejemplo.com node dist/cli/resetear-2fa.js
// La persona entra con su contraseña y vuelve a configurar el 2FA. Verifica su identidad por otro canal antes.
import { crearPool } from '../db/pool.js';
import { resetear2fa } from '../db/semilla.js';

const url = process.env.ARCHIE_OWNER_URL;
const email = process.env.ARCHIE_ADMIN_EMAIL;
if (!url || !email) {
  console.error('Faltan variables: ARCHIE_OWNER_URL, ARCHIE_ADMIN_EMAIL');
  process.exit(1);
}
const pool = crearPool(url, 2);
try {
  console.log((await resetear2fa(pool, email)) ? 'Segundo factor desactivado y sesiones cerradas.' : 'No se encontró ese usuario.');
} catch (e) {
  console.error('No se pudo:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}

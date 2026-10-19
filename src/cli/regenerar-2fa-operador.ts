// Un operador perdió su teléfono (en el servidor, con el rol dueño; verifica su identidad por otro canal antes):
//   ARCHIE_OWNER_URL=... ARCHIE_CLAVES_MAESTRAS=... ARCHIE_CLAVE_ACTIVA=1 ARCHIE_OP_EMAIL=ana@archietechnology.com node dist/cli/regenerar-2fa-operador.js
// Genera un secreto nuevo (se muestra una sola vez), cierra todas sus sesiones y lo desbloquea.
import { cargarLlaves } from '../crypto.js';
import { crearPool } from '../db/pool.js';
import { regenerar2faOperador } from '../db/operadores.js';

const { ARCHIE_OWNER_URL: url, ARCHIE_OP_EMAIL: email } = process.env;
if (!url || !email) { console.error('Faltan variables: ARCHIE_OWNER_URL, ARCHIE_OP_EMAIL'); process.exit(1); }
const pool = crearPool(url, 2);
try {
  const r = await regenerar2faOperador(pool, cargarLlaves(), email);
  if (!r) { console.error('No existe ese operador.'); process.exitCode = 1; }
  else {
    console.log(`Segundo factor regenerado para ${email.trim().toLowerCase()}. Sus sesiones se cerraron.`);
    console.log(`Secreto nuevo (se muestra una sola vez): ${r.secretoTotp}`);
    console.log(`O abre este enlace en la app: ${r.uri}`);
  }
} catch (e) {
  console.error('No se pudo regenerar:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}

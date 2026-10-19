// Uso (en el servidor, con el rol dueño):
//   ARCHIE_OWNER_URL=... ARCHIE_ORG_NOMBRE="Mi empresa" ARCHIE_ADMIN_EMAIL=ana@ejemplo.com node dist/cli/crear-admin.js
// La contraseña inicial se genera al azar y se muestra una sola vez; se debe cambiar al entrar.
// Si se define ARCHIE_ADMIN_PASSWORD se usa esa (no se pasa por argumentos para que no quede en el historial).
import { randomBytes } from 'node:crypto';
import { crearPool } from '../db/pool.js';
import { crearOrganizacionConAdmin } from '../db/semilla.js';

const url = process.env.ARCHIE_OWNER_URL;
const nombre = process.env.ARCHIE_ORG_NOMBRE;
const email = process.env.ARCHIE_ADMIN_EMAIL;
if (!url || !nombre || !email) {
  console.error('Faltan variables: ARCHIE_OWNER_URL, ARCHIE_ORG_NOMBRE, ARCHIE_ADMIN_EMAIL');
  process.exit(1);
}
const generada = !process.env.ARCHIE_ADMIN_PASSWORD;
const password = process.env.ARCHIE_ADMIN_PASSWORD ?? randomBytes(15).toString('base64url');

const pool = crearPool(url, 2);
try {
  const r = await crearOrganizacionConAdmin(pool, { nombre, email, password });
  console.log(`Organización creada (${r.orgId}). Administrador: ${email.trim().toLowerCase()}`);
  if (generada) console.log(`Contraseña inicial (se muestra una sola vez): ${password}`);
} catch (e) {
  console.error('No se pudo crear:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}

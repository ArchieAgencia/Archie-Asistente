// Una sola vez, con el administrador de PostgreSQL (nunca la aplicación):
//   ARCHIE_ADMIN_URL=... ARCHIE_DB_NOMBRE=archie ARCHIE_DB_CLAVE_OWNER=... ARCHIE_DB_CLAVE_APP=... node dist/cli/aprovisionar.js
// Las contraseñas llegan por variables de entorno (mínimo 16 caracteres) y no se escriben en ningún registro.
import { aprovisionar } from '../db/aprovisionar.js';

const { ARCHIE_ADMIN_URL: adminUrl, ARCHIE_DB_NOMBRE: base, ARCHIE_DB_CLAVE_OWNER: owner, ARCHIE_DB_CLAVE_APP: app } = process.env;
if (!adminUrl || !base || !owner || !app) {
  console.error('Faltan variables: ARCHIE_ADMIN_URL, ARCHIE_DB_NOMBRE, ARCHIE_DB_CLAVE_OWNER, ARCHIE_DB_CLAVE_APP');
  process.exit(1);
}
try {
  await aprovisionar(adminUrl, base, { owner, app });
  console.log(`Roles y base "${base}" listos.`);
} catch (e) {
  console.error('No se pudo aprovisionar:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
}

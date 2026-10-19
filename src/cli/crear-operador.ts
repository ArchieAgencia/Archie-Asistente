// Crea una persona del equipo de Archie Tech (en el servidor, con el rol dueño):
//   ARCHIE_OWNER_URL=... ARCHIE_CLAVES_MAESTRAS=... ARCHIE_CLAVE_ACTIVA=1 \
//   ARCHIE_OP_EMAIL=ana@archietechnology.com ARCHIE_OP_NOMBRE="Ana Pérez" ARCHIE_OP_ROL=admin node dist/cli/crear-operador.js
// La contraseña inicial se genera al azar y el secreto del segundo factor se muestra UNA sola vez: guárdalos en Bitwarden.
// Si se define ARCHIE_OP_PASSWORD se usa esa (no se pasa por argumentos para que no quede en el historial).
import { randomBytes } from 'node:crypto';
import { cargarLlaves } from '../crypto.js';
import { crearPool } from '../db/pool.js';
import { crearOperador, type RolOperador } from '../db/operadores.js';

const { ARCHIE_OWNER_URL: url, ARCHIE_OP_EMAIL: email, ARCHIE_OP_NOMBRE: nombre, ARCHIE_OP_ROL: rol } = process.env;
if (!url || !email || !nombre || !rol || !['admin', 'soporte', 'finanzas'].includes(rol)) {
  console.error('Faltan o son inválidas: ARCHIE_OWNER_URL, ARCHIE_OP_EMAIL, ARCHIE_OP_NOMBRE, ARCHIE_OP_ROL (admin | soporte | finanzas)');
  process.exit(1);
}
const generada = !process.env.ARCHIE_OP_PASSWORD;
const password = process.env.ARCHIE_OP_PASSWORD ?? randomBytes(18).toString('base64url');
const pool = crearPool(url, 2);
try {
  const r = await crearOperador(pool, cargarLlaves(), { email, nombre, rol: rol as RolOperador, password });
  console.log(`Operador creado: ${email.trim().toLowerCase()} (${rol}).`);
  if (generada) console.log(`Contraseña inicial (se muestra una sola vez): ${password}`);
  console.log(`Secreto del segundo factor (se muestra una sola vez; agrégalo a tu app de autenticación): ${r.secretoTotp}`);
  console.log(`O abre este enlace en la app: ${r.uri}`);
} catch (e) {
  console.error('No se pudo crear:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}

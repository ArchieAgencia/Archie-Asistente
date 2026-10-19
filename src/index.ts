import { crearApp } from './app.js';
import { cargarConfig } from './config.js';
import { cargarLlaves } from './crypto.js';
import { crearPool } from './db/pool.js';

const config = cargarConfig();
const deps = config.DATABASE_URL
  ? { pool: crearPool(config.DATABASE_URL, 10), llaves: cargarLlaves() }
  : undefined;
if (!deps) console.warn('Sin DATABASE_URL: solo se sirve /salud (modo desarrollo).');

const app = crearApp(config, deps);
const cerrar = async () => { await app.close(); await deps?.pool.end(); process.exit(0); };
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((e) => {
  console.error('No se pudo iniciar:', e instanceof Error ? e.message : e);
  process.exit(1);
});

import { crearPool } from '../db/pool.js';
import { TAREAS_LIMPIEZA } from '../db/limpieza.js';

/**
 * Tarea programada (diaria). Corre con el rol dueño. Borra: conversaciones vencidas (30 días) con sus mensajes, sesiones (de clientes y del equipo) vencidas hace más de 1 día,
 * enlaces de recuperación vencidos hace más de 1 día e invitaciones aceptadas o revocadas hace más de 90 días
 * (las vencidas sin aceptar se conservan: la consola las usa para reenviar).
 */
const url = process.env.ARCHIE_OWNER_URL;
if (!url) { console.error('Falta ARCHIE_OWNER_URL (conexión del rol archie_owner).'); process.exit(1); }
const pool = crearPool(url, 1);
let fallos = 0;
try {
  for (const t of TAREAS_LIMPIEZA) {
    try { console.log(`${t.nombre}, borradas: ${(await pool.query(t.sql)).rowCount ?? 0}`); }
    catch (e) { fallos++; console.error(`${t.nombre}: falló (${(e as { code?: string }).code ?? 'error'})`); }
  }
} finally {
  await pool.end();
}
if (fallos) process.exit(1);

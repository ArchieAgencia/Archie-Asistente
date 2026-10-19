/**
 * Tareas de la limpieza diaria (`npm run limpiar`). Se ejecutan con el rol dueño, que por las políticas de la base
 * solo puede borrar filas ya sin uso (ver migraciones 0006 y 0011).
 */
export const TAREAS_LIMPIEZA: ReadonlyArray<{ nombre: string; sql: string }> = [
  { nombre: 'Conversaciones vencidas', sql: 'DELETE FROM conversaciones WHERE vence_en < now()' },
  { nombre: 'Sesiones vencidas', sql: "DELETE FROM sesiones WHERE expira_en < now() - interval '1 day'" },
  { nombre: 'Sesiones del equipo vencidas', sql: "DELETE FROM sesiones_operador WHERE expira_en < now() - interval '1 day'" },
  { nombre: 'Enlaces de recuperación vencidos', sql: "DELETE FROM recuperaciones_password WHERE expira_en < now() - interval '1 day'" },
  { nombre: 'Sesiones del widget vencidas', sql: "DELETE FROM sesiones_widget WHERE expira_en < now() - interval '1 day'" },
  {
    nombre: 'Invitaciones aceptadas o revocadas (90 días)',
    sql: "DELETE FROM invitaciones WHERE (usada_en IS NOT NULL AND usada_en < now() - interval '90 days') OR (revocada_en IS NOT NULL AND revocada_en < now() - interval '90 days')",
  },
];

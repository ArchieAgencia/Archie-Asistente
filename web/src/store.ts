import { reactive } from 'vue';
import { api, ErrorApi } from './api';

export interface Yo { id: string; email: string; nombre: string | null; rol: string; totpActivo: boolean; organizacion: string; codigosRestantes: number; puente?: boolean }
export interface Consumo {
  plan: { id: string; nombre: string; cuotaMensual: number; topeDiario: number };
  estado: string; modo: string; autonomia: string; saldo: number; sinSaldo: boolean;
  consumidoMes: number; consumidoHoy: number; topeDiario: number; renueva: string; alerta: 80 | 100 | null;
}
export interface PlanListado { id: string; nombre: string; cuotaMensual: number; topeDiario: number }
export interface Resumen {
  organizacion: string; asistenciaHasta: string | null;
  usuario: { nombre: string | null; email: string; rol: string; totpActivo: boolean };
  consumo: Consumo; conexiones: number; accionesPendientes: number; pasos: Array<{ id: string; hecho: boolean }>;
}
export interface Operador { nombre: string; email: string; rol: 'admin' | 'soporte' | 'finanzas'; cuentaPropia?: boolean }

export const sesion = reactive<{ yo: Yo | null; resumen: Resumen | null; operador: Operador | null }>({ yo: null, resumen: null, operador: null });

/** Carga el usuario del cliente. Devuelve false si no hay sesión completa. */
export async function cargarYo(): Promise<boolean> {
  try { sesion.yo = await api<Yo>('GET', '/auth/yo'); return true; }
  catch (e) { if (e instanceof ErrorApi && e.estado === 401) { sesion.yo = null; return false; } throw e; }
}
export async function cargarResumen(): Promise<Resumen> {
  const r = await api<Resumen>('GET', '/api/panel/resumen');
  sesion.resumen = r;
  return r;
}
export async function cargarOperador(): Promise<boolean> {
  try { sesion.operador = await api<Operador>('GET', '/api/consola/yo'); return true; }
  catch (e) { if (e instanceof ErrorApi && e.estado === 401) { sesion.operador = null; return false; } throw e; }
}

/** Planes vigentes (desde la base de datos, vía la consola). */
export async function cargarPlanes(): Promise<PlanListado[]> { return api<PlanListado[]>('GET', '/api/consola/planes'); }

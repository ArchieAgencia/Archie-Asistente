import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ErrorConector, type ClienteSend, type EstadoCampana } from './send.js';
import { limpiarTexto, type Herramienta } from './send-herramientas.js';

/**
 * Nivel 3: acciones sensibles sobre campañas. El modelo SOLO puede proponerlas; nada de esto se ejecuta hasta que una persona
 * aprueba una tarjeta cuyo texto escribe el servidor con datos reales de Archie Send (no el modelo).
 */

export const ACCIONES_CAMPANA = ['enviar_ahora', 'programar', 'pausar', 'reanudar', 'cancelar', 'borrar'] as const;
export type AccionCampana = (typeof ACCIONES_CAMPANA)[number];

export const ETIQUETA_ACCION: Record<AccionCampana, string> = {
  enviar_ahora: 'ENVIAR AHORA', programar: 'PROGRAMAR el envío', pausar: 'PAUSAR', reanudar: 'REANUDAR el envío', cancelar: 'CANCELAR', borrar: 'BORRAR',
};

/** A qué estado de Archie Send pasa la campaña (borrar no cambia estado: elimina). */
const ESTADO_DESTINO: Record<Exclude<AccionCampana, 'borrar'>, EstadoCampana> = { enviar_ahora: 'running', programar: 'scheduled', pausar: 'paused', reanudar: 'running', cancelar: 'cancelled' };

export interface Instantanea {
  id: number; nombre: string; asunto: string; estado: string; programadaPara: string | null;
  listas: { id: number; nombre: string; contactos: number | null }[]; creditos: number | null;
  /** SHA-256 del cuerpo de la campaña (si cambia el contenido entre la tarjeta y la aprobación, no se ejecuta). */
  cuerpoHash: string;
  /** Inicio del contenido en texto plano, para que quien aprueba vea qué se va a enviar. */
  extracto: string;
}

const objeto = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const entero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const texto = (v: unknown, max = 200): string => (typeof v === 'string' ? limpiarTexto(v, max) : '');

/** Texto plano del inicio del contenido (sin etiquetas, scripts ni estilos), para mostrarlo en la tarjeta. */
export function extractoPlano(html: string, max = 300): string {
  const t = html.replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ');
  return limpiarTexto(t, max);
}

/** Lee la campaña TAL COMO ESTÁ AHORA en Archie Send (con las listas y los créditos). */
export async function instantanea(send: ClienteSend, id: number): Promise<Instantanea> {
  const c = objeto(await send.get(`/api/campaigns/${id}`));
  if (entero(c.id) !== id) throw new ErrorConector('respuesta_invalida');
  const listasCrudas = (Array.isArray(c.lists) ? c.lists : []).slice(0, 10).map(objeto);
  const listas: Instantanea['listas'] = [];
  for (const l of listasCrudas) {
    const lid = entero(l.id ?? l.list_id);
    if (!lid) continue;
    let contactos: number | null = null;
    try { contactos = entero(objeto(await send.get(`/api/lists/${lid}`)).subscriber_count); } catch (e) { if (!(e instanceof ErrorConector)) throw e; }
    listas.push({ id: lid, nombre: texto(l.name, 100), contactos });
  }
  let creditos: number | null = null;
  try { creditos = entero(objeto(objeto(await send.get('/api/credits')).status).balance); } catch (e) { if (!(e instanceof ErrorConector)) throw e; }
  const cuerpo = typeof c.body === 'string' ? c.body : '';
  return { id, nombre: texto(c.name, 100), asunto: texto(c.subject), estado: texto(c.status, 20), programadaPara: typeof c.send_at === 'string' ? texto(c.send_at, 40) : null, listas, creditos,
    cuerpoHash: createHash('sha256').update(cuerpo).digest('hex'), extracto: extractoPlano(cuerpo) };
}

/** Resumen de lo que se le mostró a la persona. Si algo de esto cambia entre la tarjeta y la aprobación, NO se ejecuta. */
export const huella = (i: Instantanea, accion: AccionCampana): string => createHash('sha256').update(JSON.stringify({
  accion, id: i.id, nombre: i.nombre, asunto: i.asunto, estado: i.estado, programadaPara: i.programadaPara, listas: i.listas.map((l) => l.id).sort((a, b) => a - b), cuerpoHash: i.cuerpoHash,
})).digest('hex');

/** Motivo por el que la acción no aplica al estado actual de la campaña, o null si es válida. */
export function motivoNoValida(accion: AccionCampana, i: Instantanea, ahora = new Date()): string | null {
  const e = i.estado;
  switch (accion) {
    case 'enviar_ahora':
      if (e !== 'draft' && e !== 'scheduled') return `La campaña está en estado «${e}»; solo se puede enviar ahora una campaña en borrador o programada.`;
      if (!i.listas.length) return 'La campaña no tiene listas.';
      return null;
    case 'programar': {
      if (e !== 'draft') return `La campaña está en estado «${e}»; solo se programa una campaña en borrador.`;
      if (!i.programadaPara) return 'La campaña no tiene fecha de envío. Defínela en Archie Send y vuelve a pedirlo (desde aquí no se cambian fechas).';
      if (!(new Date(i.programadaPara) > ahora)) return 'La fecha de envío de la campaña ya pasó. Cámbiala en Archie Send.';
      if (!i.listas.length) return 'La campaña no tiene listas.';
      return null;
    }
    case 'pausar': return e === 'running' ? null : `Solo se puede pausar una campaña que se está enviando (estado actual: «${e}»).`;
    case 'reanudar': return e === 'paused' ? null : `Solo se puede reanudar una campaña pausada (estado actual: «${e}»).`;
    case 'cancelar': return e === 'running' || e === 'paused' || e === 'scheduled' ? null : `Solo se cancela una campaña en envío, pausada o programada (estado actual: «${e}»).`;
    case 'borrar': return e === 'running' || e === 'paused' ? `Una campaña en estado «${e}» no se borra; primero hay que cancelarla.` : null;
  }
}

const num = (n: number) => new Intl.NumberFormat('es-CO').format(n);
const fechaHora = (iso: string) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date(iso));

/** Texto de la tarjeta. Lo escribe el servidor con los datos de Archie Send: el modelo no puede cambiarlo ni adornarlo. */
export function textoTarjeta(accion: AccionCampana, i: Instantanea): string {
  const L: string[] = [`Acción: ${ETIQUETA_ACCION[accion]} la campaña «${i.nombre}»`, `Asunto: ${i.asunto || '(sin asunto)'}`, `Estado actual: ${i.estado}`];
  if (accion === 'enviar_ahora' || accion === 'programar' || accion === 'reanudar') {
    L.push(`Listas: ${i.listas.length ? i.listas.map((l) => `${l.nombre} (${l.contactos === null ? 'contactos sin datos' : `${num(l.contactos)} contactos`})`).join(', ') : 'ninguna'}`);
    const conocidos = i.listas.filter((l) => l.contactos !== null);
    if (conocidos.length) L.push(`Destinatarios: como máximo ${num(conocidos.reduce((a, l) => a + (l.contactos ?? 0), 0))} (suma de las listas; hay menos si hay repetidos, bajas o un segmento)`);
    if (i.creditos !== null) L.push(`Créditos de envío disponibles: ${num(i.creditos)}`);
    L.push(`Contenido (inicio): ${i.extracto ? `«${i.extracto}»` : '(vacío)'}`);
  }
  if (accion === 'programar' && i.programadaPara) L.push(`Se enviará: ${fechaHora(i.programadaPara)} (hora de Bogotá)`);
  L.push(accion === 'borrar' ? 'Se borra la campaña de Archie Send. No se puede deshacer.'
    : accion === 'cancelar' ? 'La campaña queda cancelada y no se puede reanudar.'
      : accion === 'pausar' ? 'El envío se detiene; se puede reanudar después.'
        : accion === 'programar' ? 'El correo saldrá a la fecha indicada. Una vez enviado, no se puede traer de vuelta.'
          : 'Un correo enviado no se puede traer de vuelta.');
  return L.join('\n');
}

/** Ejecuta lo aprobado. Lo llama SOLO la ruta humana de aprobación. */
export async function ejecutarAccion(send: ClienteSend, accion: AccionCampana, id: number): Promise<void> {
  if (accion === 'borrar') return send.borrar(`/api/campaigns/${id}`);
  return send.cambiarEstadoCampana(id, ESTADO_DESTINO[accion]);
}

export interface PropuestaCreada { accion: AccionCampana; campanaId: number; nombre: string; texto: string; huella: string }

export const HERRAMIENTAS_CONFIRMACION: Herramienta[] = [{
  nivel: 3,
  nombre: 'send_proponer_accion_campana',
  descripcion: 'PROPONE una acción sensible sobre una campaña de Archie Send: enviar_ahora, programar (solo si ya tiene fecha de envío), pausar, reanudar, cancelar o borrar. NO la ejecuta: crea una tarjeta de confirmación que una persona debe aprobar. Antes de proponerla, confirma con la persona cuál campaña y qué acción. Nunca digas que se ejecutó: solo que dejaste la tarjeta para que la apruebe.',
  schema: { type: 'object', properties: { campana_id: { type: 'integer', minimum: 1 }, accion: { type: 'string', enum: [...ACCIONES_CAMPANA] } }, required: ['campana_id', 'accion'], additionalProperties: false },
  entrada: z.object({ campana_id: z.number().int().min(1).max(2_000_000_000), accion: z.enum(ACCIONES_CAMPANA) }).strict(),
  async ejecutar(c, a) {
    const accion = a.accion as AccionCampana;
    const i = await instantanea(c.send, a.campana_id);
    const motivo = motivoNoValida(accion, i);
    if (motivo) return { datos: { propuesta_creada: false, motivo } };
    const propuesta: PropuestaCreada = { accion, campanaId: i.id, nombre: i.nombre || `Campaña ${i.id}`, texto: textoTarjeta(accion, i), huella: huella(i, accion) };
    return { datos: { propuesta_creada: true, aviso: 'NO se ejecutó nada. Se mostró una tarjeta de confirmación; una persona debe aprobarla. Dile que la revise y que vence en 15 minutos.' }, propuesta };
  },
}];

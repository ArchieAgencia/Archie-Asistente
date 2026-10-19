import { randomUUID } from 'node:crypto';
import type { Bloque, EventoIA, ModeloIA, PeticionIA } from './modelo.js';

/** Guion: dado lo que llegó al modelo, devuelve lo que "responde" (texto y/o usos de herramientas). */
export type Guion = (p: PeticionIA, paso: number) => Bloque[] | Promise<Bloque[]>;

/**
 * Modelo simulado: NO llama a ningún servicio. Se usa en pruebas (con guiones a medida) y en desarrollo (guion por defecto).
 */
export class ModeloSimulado implements ModeloIA {
  readonly nombre = 'simulado';
  readonly peticiones: PeticionIA[] = [];
  constructor(private readonly guion: Guion = guionDemo) {}

  async *responder(p: PeticionIA): AsyncGenerator<EventoIA> {
    this.peticiones.push(structuredClone({ ...p, senal: undefined }));
    // Paso = cuántos resultados de herramientas hay DESPUÉS del último mensaje escrito por la persona.
    let desde = 0;
    p.mensajes.forEach((m, i) => { if (m.role === 'user' && m.content.some((b) => b.type === 'text')) desde = i; });
    const paso = p.mensajes.slice(desde + 1).filter((m) => m.content.some((b) => b.type === 'tool_result')).length;
    const bloques = await this.guion(p, paso);
    for (const b of bloques) {
      if (b.type === 'text') for (let i = 0; i < b.text.length; i += 24) yield { tipo: 'texto', delta: b.text.slice(i, i + 24) };
    }
    const usaHerramienta = bloques.some((b) => b.type === 'tool_use');
    const textoEntrada = JSON.stringify(p.mensajes).length;
    yield {
      tipo: 'fin', bloques, parada: usaHerramienta ? 'tool_use' : 'end_turn',
      uso: { entrada: Math.ceil(textoEntrada / 4), salida: Math.ceil(JSON.stringify(bloques).length / 4), cache: 0 },
    };
  }
}

const ultimoTexto = (p: PeticionIA): string => {
  for (let i = p.mensajes.length - 1; i >= 0; i--) {
    const m = p.mensajes[i]!;
    if (m.role !== 'user') continue;
    const t = m.content.find((b): b is Extract<Bloque, { type: 'text' }> => b.type === 'text');
    if (t) return t.text.toLowerCase();
  }
  return '';
};

/** Guion por defecto para probar la interfaz sin IA real: consulta una herramienta según palabras clave y resume el resultado. */
export const guionDemo: Guion = (p, paso) => {
  const hay = (n: string) => p.herramientas.some((h) => h.name === n);
  if (paso === 0) {
    const t = ultimoTexto(p);
    const elegir = /cr[eé]dito|saldo/.test(t) ? 'send_creditos' : /error|rebot|fall/.test(t) ? 'send_errores_envio'
      : /campa/.test(t) ? 'send_campanas' : /lista/.test(t) ? 'send_listas' : /segment/.test(t) ? 'send_segmentos' : null;
    const crear = /crea(r)? (una )?lista (llamada )?(.{1,60})/.exec(t);
    if (crear && hay('send_crear_lista')) return [{ type: 'text', text: 'Preparo la lista. ' }, { type: 'tool_use', id: `toolu_${randomUUID()}`, name: 'send_crear_lista', input: { nombre: crear[4]!.replace(/[.?!]+$/, '').trim() } }];
    const sens = /(env[ií]a|pausa|cancela|borra|reanuda|programa)\w* la campa[ñn]a (\d+)/.exec(t);
    if (sens && hay('send_proponer_accion_campana')) {
      const acc = ({ env: 'enviar_ahora', pau: 'pausar', can: 'cancelar', bor: 'borrar', rea: 'reanudar', pro: 'programar' } as Record<string, string>)[sens[1]!.replace(/^envi/, 'env').slice(0, 3)] ?? 'enviar_ahora';
      return [{ type: 'text', text: 'Preparo la confirmación. ' }, { type: 'tool_use', id: `toolu_${randomUUID()}`, name: 'send_proponer_accion_campana', input: { campana_id: Number(sens[2]), accion: acc } }];
    }
    if (elegir && hay(elegir)) return [{ type: 'text', text: 'Reviso en Archie Send. ' }, { type: 'tool_use', id: `toolu_${randomUUID()}`, name: elegir, input: {} }];
    return [{ type: 'text', text: 'Respuesta simulada (sin IA real). Pregúntame por créditos, campañas, listas, segmentos o errores de envío.' }];
  }
  const r = p.mensajes.at(-1)?.content.find((b): b is Extract<Bloque, { type: 'tool_result' }> => b.type === 'tool_result');
  if (r?.is_error) return [{ type: 'text', text: 'No pude consultar Archie Send ahora mismo. Revisa la conexión e inténtalo de nuevo.' }];
  return [{ type: 'text', text: `Listo, consulté Archie Send (respuesta simulada). Datos recibidos: ${(r?.content ?? '').slice(0, 300)}` }];
};

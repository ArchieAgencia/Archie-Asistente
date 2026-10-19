/** Contrato con el proveedor de IA. Todo lo demás (bucle del agente, pruebas) depende de esta interfaz, no de un proveedor. */

export type Bloque =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface MensajeIA { role: 'user' | 'assistant'; content: Bloque[] }
export interface HerramientaIA { name: string; description: string; input_schema: Record<string, unknown> }

export interface PeticionIA {
  sistema: string;
  mensajes: MensajeIA[];
  herramientas: HerramientaIA[];
  maxTokens: number;
  senal?: AbortSignal;
}

export interface UsoIA { entrada: number; salida: number; cache: number }

export type EventoIA =
  | { tipo: 'texto'; delta: string }
  | { tipo: 'fin'; bloques: Bloque[]; parada: string; uso: UsoIA };

export interface ModeloIA {
  /** Nombre que se registra en el uso (p. ej. el modelo configurado). */
  readonly nombre: string;
  responder(p: PeticionIA): AsyncIterable<EventoIA>;
}

/** Error del proveedor. Nunca lleva el cuerpo de la respuesta (podría traer datos del cliente). */
export class ErrorIA extends Error {
  constructor(readonly codigo: 'proveedor_no_disponible' | 'proveedor_rechazo' | 'tiempo_agotado' | 'respuesta_invalida' | 'cancelado') { super(codigo); }
}

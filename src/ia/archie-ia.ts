import { ErrorIA, type Bloque, type EventoIA, type ModeloIA, type PeticionIA, type UsoIA } from './modelo.js';

export interface OpcionesArchieIA {
  apiKey: string;
  modelo: string;
  /** Solo pruebas: otro servidor o una función `fetch` falsa. */
  url?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const URL_API = 'https://api.anthropic.com/v1/messages';
const VERSION_API = '2023-06-01';
const MAX_LINEA = 1_000_000; // una línea de SSE no debería acercarse a esto

/**
 * Cliente mínimo de la API de mensajes del proveedor de IA de Archie Tech con respuesta en streaming (SSE). Sin SDK: menos dependencias que revisar.
 * La clave solo viaja en la cabecera x-api-key y nunca se escribe en registros ni en errores.
 * NO probado contra la API real (ver docs/chat.md): las pruebas usan una respuesta simulada con el mismo formato.
 */
export class ModeloArchieIA implements ModeloIA {
  readonly nombre: string;
  constructor(private readonly o: OpcionesArchieIA) { this.nombre = o.modelo; }

  async *responder(p: PeticionIA): AsyncGenerator<EventoIA> {
    const f = this.o.fetchFn ?? fetch;
    const tiempo = AbortSignal.timeout(this.o.timeoutMs ?? 90_000);
    const senal = p.senal ? AbortSignal.any([p.senal, tiempo]) : tiempo;
    const cuerpo = {
      model: this.o.modelo,
      max_tokens: p.maxTokens,
      stream: true,
      // Las instrucciones y el catálogo casi no cambian entre llamadas: se piden con caché de prompt (lectura mucho más barata).
      system: [{ type: 'text', text: p.sistema, cache_control: { type: 'ephemeral' } }],
      tools: p.herramientas.map((h, i) => (i === p.herramientas.length - 1 ? { ...h, cache_control: { type: 'ephemeral' } } : h)),
      messages: p.mensajes,
    };
    let resp: Response;
    try {
      resp = await f(this.o.url ?? URL_API, {
        method: 'POST', redirect: 'error', signal: senal,
        headers: { 'content-type': 'application/json', 'x-api-key': this.o.apiKey, 'anthropic-version': VERSION_API },
        body: JSON.stringify(cuerpo),
      });
    } catch (e) { throw traducir(e, p.senal); }
    if (!resp.ok || !resp.body) {
      await resp.body?.cancel().catch(() => undefined); // el cuerpo del error no se lee ni se guarda
      throw new ErrorIA(resp.status === 429 || resp.status >= 500 ? 'proveedor_no_disponible' : 'proveedor_rechazo');
    }

    const bloques: (Bloque & { json?: string })[] = [];
    const uso: UsoIA = { entrada: 0, salida: 0, cache: 0 };
    let parada = 'end_turn';
    try {
      for await (const { evento, datos } of eventosSse(resp.body)) {
        if (evento === 'error') throw new ErrorIA('proveedor_no_disponible');
        let d: any;
        try { d = JSON.parse(datos); } catch { throw new ErrorIA('respuesta_invalida'); }
        if (evento === 'message_start') {
          const u = d?.message?.usage ?? {};
          uso.entrada = num(u.input_tokens) + num(u.cache_creation_input_tokens);
          uso.cache = num(u.cache_read_input_tokens);
        } else if (evento === 'content_block_start') {
          const b = d?.content_block;
          if (b?.type === 'text') bloques[d.index] = { type: 'text', text: '' };
          else if (b?.type === 'tool_use') bloques[d.index] = { type: 'tool_use', id: String(b.id), name: String(b.name), input: {}, json: '' };
        } else if (evento === 'content_block_delta') {
          const b = bloques[d.index];
          if (b?.type === 'text' && d.delta?.type === 'text_delta') {
            b.text += String(d.delta.text); yield { tipo: 'texto', delta: String(d.delta.text) };
          } else if (b?.type === 'tool_use' && d.delta?.type === 'input_json_delta') {
            b.json = (b.json ?? '') + String(d.delta.partial_json);
            if (b.json.length > 100_000) throw new ErrorIA('respuesta_invalida');
          }
        } else if (evento === 'message_delta') {
          if (d.delta?.stop_reason) parada = String(d.delta.stop_reason);
          if (d.usage?.output_tokens != null) uso.salida = num(d.usage.output_tokens);
        }
      }
    } catch (e) { throw traducir(e, p.senal); }

    const out: Bloque[] = [];
    for (const b of bloques) {
      if (!b) continue;
      if (b.type === 'tool_use') {
        let input: unknown = {};
        try { input = b.json ? JSON.parse(b.json) : {}; } catch { throw new ErrorIA('respuesta_invalida'); }
        if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ErrorIA('respuesta_invalida');
        out.push({ type: 'tool_use', id: b.id, name: b.name, input: input as Record<string, unknown> });
      } else if (b.type === 'text') { if (b.text) out.push({ type: 'text', text: b.text }); }
    }
    yield { tipo: 'fin', bloques: out, parada, uso };
  }
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);

function traducir(e: unknown, usuario?: AbortSignal): Error {
  if (e instanceof ErrorIA) return e;
  if (usuario?.aborted) return new ErrorIA('cancelado');
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return new ErrorIA('tiempo_agotado');
  return new ErrorIA('proveedor_no_disponible');
}

/** Lee un flujo SSE y entrega cada evento {evento, datos}. */
export async function* eventosSse(cuerpo: ReadableStream<Uint8Array>): AsyncGenerator<{ evento: string; datos: string }> {
  const dec = new TextDecoder();
  let resto = '';
  let evento = 'message';
  let datos: string[] = [];
  for await (const trozo of cuerpo as unknown as AsyncIterable<Uint8Array>) {
    resto += dec.decode(trozo, { stream: true });
    if (resto.length > MAX_LINEA) throw new ErrorIA('respuesta_invalida');
    let i: number;
    while ((i = resto.indexOf('\n')) >= 0) {
      const linea = resto.slice(0, i).replace(/\r$/, '');
      resto = resto.slice(i + 1);
      if (linea === '') {
        if (datos.length) yield { evento, datos: datos.join('\n') };
        evento = 'message'; datos = [];
      } else if (linea.startsWith('event:')) evento = linea.slice(6).trim();
      else if (linea.startsWith('data:')) datos.push(linea.slice(5).replace(/^ /, ''));
    }
  }
  if (datos.length) yield { evento, datos: datos.join('\n') };
}

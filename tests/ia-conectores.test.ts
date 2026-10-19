import { describe, expect, it } from 'vitest';
import { cargarConfig } from '../src/config.js';
import { ClienteSend, ErrorConector } from '../src/conectores/send.js';
import { catalogoSend, enmascarar, limpiarTexto } from '../src/conectores/send-herramientas.js';
import { ModeloArchieIA } from '../src/ia/archie-ia.js';
import { ErrorIA, type EventoIA } from '../src/ia/modelo.js';

const sse = (partes: [string, object | string][]) => partes.map(([e, d]) => `event: ${e}\ndata: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`).join('');
const respuesta = (texto: string, init: ResponseInit = { status: 200 }) => new Response(texto, init);
const TOKEN = 'abcdefgh12345678'; // gitleaks:allow (valor falso de prueba)

async function todo(g: AsyncIterable<EventoIA>) { const out: EventoIA[] = []; for await (const e of g) out.push(e); return out; }

describe('ModeloArchieIA (formato de la API simulado; no probado contra la API real)', () => {
  const base = { apiKey: 'clave-ia-prueba-123456', modelo: 'modelo-de-prueba' }; // gitleaks:allow (valor falso de prueba)
  const flujo = sse([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 1 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hola ' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'mundo' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'send_creditos', input: {} } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"por_' } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'pagina": 5}' } }],
    ['content_block_stop', { index: 1 }],
    ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 } }],
    ['message_stop', {}],
  ]);

  it('arma texto, uso de herramienta, parada y consumo; envía clave, caché y sin redirecciones', async () => {
    let visto: { url: string; init: RequestInit } | undefined;
    const m = new ModeloArchieIA({ ...base, fetchFn: (async (url: string, init: RequestInit) => { visto = { url, init }; return respuesta(flujo); }) as unknown as typeof fetch });
    const ev = await todo(m.responder({ sistema: 'sis', mensajes: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }], herramientas: [{ name: 'a', description: 'd', input_schema: { type: 'object' } }, { name: 'b', description: 'd', input_schema: { type: 'object' } }], maxTokens: 100 }));
    expect(ev.filter((e) => e.tipo === 'texto').map((e: any) => e.delta).join('')).toBe('Hola mundo');
    const fin = ev.at(-1) as Extract<EventoIA, { tipo: 'fin' }>;
    expect(fin.parada).toBe('tool_use');
    expect(fin.uso).toEqual({ entrada: 100, salida: 33, cache: 40 });
    expect(fin.bloques).toEqual([{ type: 'text', text: 'Hola mundo' }, { type: 'tool_use', id: 'toolu_1', name: 'send_creditos', input: { por_pagina: 5 } }]);
    const h = visto!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(base.apiKey);
    expect(visto!.init.redirect).toBe('error');
    const cuerpo = JSON.parse(visto!.init.body as string);
    expect(cuerpo.model).toBe('modelo-de-prueba');
    expect(cuerpo.stream).toBe(true);
    expect(cuerpo.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(cuerpo.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(cuerpo.tools[0].cache_control).toBeUndefined();
  });

  it('los errores del proveedor no llevan su cuerpo ni la clave', async () => {
    const mk = (status: number) => new ModeloArchieIA({ ...base, fetchFn: (async () => respuesta('{"error":"detalle sensible clave-ia-prueba-123456"}', { status })) as unknown as typeof fetch });
    const pedir = (m: ModeloArchieIA) => todo(m.responder({ sistema: 's', mensajes: [], herramientas: [], maxTokens: 10 }));
    for (const [st, cod] of [[429, 'proveedor_no_disponible'], [503, 'proveedor_no_disponible'], [400, 'proveedor_rechazo'], [401, 'proveedor_rechazo']] as const) {
      const e = await pedir(mk(st)).catch((x) => x);
      expect(e).toBeInstanceOf(ErrorIA);
      expect(e.codigo).toBe(cod);
      expect(String(e.message) + JSON.stringify(e)).not.toContain('clave-ia-prueba');
    }
    const red = await pedir(new ModeloArchieIA({ ...base, fetchFn: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch })).catch((x) => x);
    expect(red.codigo).toBe('proveedor_no_disponible');
  });

  it('rechaza respuestas mal formadas y cancela cuando la persona se va', async () => {
    const malo = sse([['message_start', 'esto no es json']]);
    const e = await todo(new ModeloArchieIA({ ...base, fetchFn: (async () => respuesta(malo)) as unknown as typeof fetch }).responder({ sistema: 's', mensajes: [], herramientas: [], maxTokens: 10 })).catch((x) => x);
    expect(e.codigo).toBe('respuesta_invalida');
    const jsonRoto = sse([['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'x' } }], ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{rota' } }], ['message_delta', { delta: { stop_reason: 'tool_use' } }]]);
    const e2 = await todo(new ModeloArchieIA({ ...base, fetchFn: (async () => respuesta(jsonRoto)) as unknown as typeof fetch }).responder({ sistema: 's', mensajes: [], herramientas: [], maxTokens: 10 })).catch((x) => x);
    expect(e2.codigo).toBe('respuesta_invalida');
    const ctl = new AbortController(); ctl.abort();
    const e3 = await todo(new ModeloArchieIA({ ...base, fetchFn: (async (_u: string, i: RequestInit) => { if (i.signal?.aborted) throw new DOMException('x', 'AbortError'); return respuesta(''); }) as unknown as typeof fetch }).responder({ sistema: 's', mensajes: [], herramientas: [], maxTokens: 10, senal: ctl.signal })).catch((x) => x);
    expect(e3.codigo).toBe('cancelado');
  });
});

describe('ClienteSend', () => {
  const json = (o: unknown, status = 200) => respuesta(JSON.stringify(o), { status });
  const mk = (f: (url: URL, init: RequestInit) => Response | Promise<Response>, opts: object = {}) =>
    new ClienteSend('https://send.ejemplo.test/ruta-que-se-descarta?x=1', { usuario: 'api-user', token: TOKEN }, { fetchFn: (async (u: URL, i: RequestInit) => f(u, i)) as unknown as typeof fetch, ...opts });

  it('usa solo el origen configurado, solo GET, la cabecera de Archie Send y desenvuelve data', async () => {
    let visto!: { url: URL; init: RequestInit };
    const c = mk((url, init) => { visto = { url, init }; return json({ data: { ok: 1 } }); });
    expect(await c.get('/api/lists', { per_page: 5, query: undefined, buscar: '' })).toEqual({ ok: 1 });
    expect(visto.url.toString()).toBe('https://send.ejemplo.test/api/lists?per_page=5');
    expect(visto.init.method).toBe('GET');
    expect((visto.init.headers as Record<string, string>).Authorization).toBe(`token api-user:${TOKEN}`);
    expect(visto.init.redirect).toBe('error');
  });

  it('rechaza rutas fuera de la lista (nunca sale a la red) y formatos de clave peligrosos', async () => {
    let llamadas = 0;
    const c = mk(() => { llamadas++; return json({ data: 1 }); });
    for (const r of ['/api/users', '/api/campaigns/5/test', '/api/campaigns/abc', '/api/../admin', 'https://evil.test/x', '/api/subscribers/1']) {
      await expect(c.get(r)).rejects.toThrow(/ruta no permitida/);
    }
    expect(llamadas).toBe(0);
    expect(() => new ClienteSend('https://s.test', { usuario: 'a:b', token: TOKEN })).toThrow(ErrorConector);
    expect(() => new ClienteSend('https://s.test', { usuario: 'ok', token: 'corta' })).toThrow(ErrorConector);
    expect(() => new ClienteSend('https://s.test', { usuario: 'ok', token: `${TOKEN}\r\nX: 1` })).toThrow(ErrorConector);
  });

  it('traduce los códigos HTTP a mensajes claros y valida el tamaño y la forma de la respuesta', async () => {
    const caso = async (r: Response): Promise<ErrorConector> => mk(() => r).get('/api/credits').then(() => { throw new Error('debía fallar'); }, (e: ErrorConector) => e);
    expect((await caso(json({}, 401))).codigo).toBe('credencial_rechazada');
    expect((await caso(json({}, 403))).codigo).toBe('sin_permiso');
    expect((await caso(json({}, 404))).codigo).toBe('no_encontrado');
    expect((await caso(json({}, 429))).codigo).toBe('limite');
    expect((await caso(json({ message: 'secreto' }, 502))).codigo).toBe('no_disponible');
    expect((await caso(respuesta('no es json'))).codigo).toBe('respuesta_invalida');
    expect((await caso(json({ sinData: 1 }))).codigo).toBe('respuesta_invalida');
    expect((await caso(respuesta(JSON.stringify({ data: 'x'.repeat(1_100_000) })))).codigo).toBe('respuesta_invalida');
    const tiempo: ErrorConector = await mk(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }).get('/api/credits').then(() => { throw new Error('x'); }, (e: ErrorConector) => e);
    expect(tiempo.codigo).toBe('tiempo_agotado');
    const red: ErrorConector = await mk(() => { throw new TypeError('fetch failed'); }).get('/api/credits').then(() => { throw new Error('x'); }, (e: ErrorConector) => e);
    expect(red.codigo).toBe('no_disponible');
    expect(`${(await caso(json({ message: 'secreto' }, 502))).message}`).not.toContain('secreto');
  });
});

describe('herramientas de Archie Send', () => {
  it('todas son lecturas con nombre send_*, y contactos solo si se enciende', () => {
    const sin = catalogoSend({ contactos: false }).map((h) => h.nombre);
    const con = catalogoSend({ contactos: true }).map((h) => h.nombre);
    expect(sin).not.toContain('send_contactos');
    expect(con).toContain('send_contactos');
    expect(con.every((n) => /^send_[a-z_]+$/.test(n))).toBe(true);
    expect(con.some((n) => /crear|borrar|enviar|programar|pausar|editar|importar|eliminar/.test(n))).toBe(false);
    for (const h of catalogoSend({ contactos: true })) expect((h.schema as any).additionalProperties).toBe(false);
  });

  it('los argumentos se validan estrictamente (tope de filas, campos desconocidos)', () => {
    const h = Object.fromEntries(catalogoSend({ contactos: true }).map((x) => [x.nombre, x]));
    expect(h.send_campanas!.entrada.safeParse({ por_pagina: 21 }).success).toBe(false);
    expect(h.send_campanas!.entrada.safeParse({ estado: 'borrar' }).success).toBe(false);
    expect(h.send_campanas!.entrada.safeParse({ sql: '1' }).success).toBe(false);
    expect(h.send_contactos!.entrada.safeParse({ por_pagina: 20 }).success).toBe(true);
    expect(h.send_contactos!.entrada.safeParse({ por_pagina: 100 }).success).toBe(false);
    expect(h.send_campana!.entrada.safeParse({ id: -1 }).success).toBe(false);
    expect(h.send_campana!.entrada.safeParse({ id: '5' }).success).toBe(false);
  });

  it('limpiarTexto y enmascarar', () => {
    expect(limpiarTexto('a\u0000b‮c\n\n d', 10)).toBe('a b c d');
    expect(limpiarTexto('x'.repeat(500), 200)).toHaveLength(200);
    expect(enmascarar('maria@ejemplo.com')).toBe('m***@ejemplo.com');
    expect(enmascarar('sin-arroba')).toBe('***');
  });
});

describe('configuración de IA', () => {
  it('ARCHIE_IA=archie exige clave y modelo; en producción exige archie', () => {
    expect(() => cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_IA: 'archie' })).toThrow(/ARCHIE_IA_CLAVE.*ARCHIE_IA_MODELO|ARCHIE_IA_MODELO.*ARCHIE_IA_CLAVE/);
    expect(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_IA: 'archie', ARCHIE_IA_CLAVE: 'clave-ia-1234567890', ARCHIE_IA_MODELO: 'modelo-x' }).ARCHIE_IA).toBe('archie');
    expect(() => cargarConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ARCHIE_ORIGEN: 'https://a.test', ARCHIE_CORREO: 'resend', RESEND_API_KEY: 'x'.repeat(12), ARCHIE_CORREO_REMITENTE: 'a@b.co' })).toThrow(/ARCHIE_IA/);
    expect(() => cargarConfig({ NODE_ENV: 'production', ARCHIE_SEND_URL: 'http://send.test' })).toThrow(/ARCHIE_SEND_URL/);
    expect(() => cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_IA_MODELO: 'con espacios no' })).toThrow(/ARCHIE_IA_MODELO/);
  });
});

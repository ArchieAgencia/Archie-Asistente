/**
 * Cliente HTTP seguro para conectores cuya dirección escribe el cliente (tiendas).
 * Defensas contra SSRF: solo https y puerto 443, solo nombres de dominio, todas las direcciones resueltas deben ser públicas,
 * la conexión se hace a la IP ya validada (sin segunda resolución), sin redirecciones y con tope de tiempo y de tamaño.
 */
import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export class ErrorHttpSeguro extends Error {
  constructor(readonly codigo: 'direccion_no_permitida' | 'tiempo_agotado' | 'no_disponible' | 'respuesta_demasiado_grande' | 'redireccion') { super(codigo); }
}

// ---------- Validación de nombres y direcciones ----------

const ETIQUETA = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUFIJOS_INTERNOS = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.localdomain', '.arpa'];

/** Devuelve el nombre normalizado o null si no es un nombre de dominio público razonable (nunca una IP, nunca con puerto ni ruta). */
export function nombreDeDominioValido(valor: string): string | null {
  const h = valor.trim().toLowerCase().replace(/\.$/, '');
  if (h.length < 4 || h.length > 253 || isIP(h) !== 0) return null;
  const partes = h.split('.');
  if (partes.length < 2 || !partes.every((p) => ETIQUETA.test(p))) return null;
  if (/^[0-9]+$/.test(partes[partes.length - 1]!)) return null; // 1.2.3.4 y parecidos
  if (h === 'localhost' || SUFIJOS_INTERNOS.some((s) => h.endsWith(s))) return null;
  return h;
}

function v4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

function v4Publica(n: number[]): boolean {
  const [a, b, c] = n as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;         // red actual, privada, loopback, multicast y reservadas
  if (a === 100 && b >= 64 && b <= 127) return false;                     // CGNAT
  if (a === 169 && b === 254) return false;                               // local de enlace y metadatos de nube
  if (a === 172 && b >= 16 && b <= 31) return false;                      // privada
  if (a === 192 && b === 168) return false;                               // privada
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;         // protocolo IETF y documentación
  if (a === 192 && b === 88 && c === 99) return false;                    // 6to4 relé
  if (a === 198 && (b === 18 || b === 19)) return false;                  // pruebas de rendimiento
  if (a === 198 && b === 51 && c === 100) return false;                   // documentación
  if (a === 203 && b === 0 && c === 113) return false;                    // documentación
  return true;
}

/** Expande una dirección IPv6 a ocho grupos de 16 bits, o null si no es válida. */
function v6Grupos(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zona = s.indexOf('%');
  if (zona >= 0) s = s.slice(0, zona);
  const cola = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (cola) {
    const n = v4(cola[1]!);
    if (!n) return null;
    s = s.slice(0, cola.index) + ((n[0]! << 8) | n[1]!).toString(16) + ':' + ((n[2]! << 8) | n[3]!).toString(16);
  }
  const dobles = s.split('::');
  if (dobles.length > 2) return null;
  const izq = dobles[0] ? dobles[0].split(':') : [];
  const der = dobles.length === 2 && dobles[1] ? dobles[1].split(':') : [];
  const faltan = 8 - izq.length - der.length;
  if (dobles.length === 1 ? faltan !== 0 : faltan < 1) return null;
  const todos = [...izq, ...Array(dobles.length === 2 ? faltan : 0).fill('0'), ...der];
  if (todos.length !== 8 || !todos.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return todos.map((g) => parseInt(g, 16));
}

/** ¿Es una dirección IP pública (enrutable en Internet)? Lo dudoso se rechaza. */
export function ipEsPublica(ip: string): boolean {
  const n4 = v4(ip);
  if (n4) return v4Publica(n4);
  const g = v6Grupos(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const incrustada = [(g6 >> 8) & 255, g6 & 255, (g7 >> 8) & 255, g7 & 255];
  if (g.every((x) => x === 0)) return false;                              // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return false;      // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return v4Publica(incrustada); // IPv4 mapeada
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false;                      // IPv4 compatible (obsoleta)
  if (g0 === 0x64 && g1 === 0xff9b) return v4Publica(incrustada);         // NAT64: se evalúa la IPv4 que lleva dentro
  if (g0 === 0x2002) return v4Publica([(g1 >> 8) & 255, g1 & 255, (g2 >> 8) & 255, g2 & 255]); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return false;                             // única local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false;                             // local de enlace
  if ((g0 & 0xffc0) === 0xfec0) return false;                             // local de sitio (obsoleta)
  if ((g0 & 0xff00) === 0xff00) return false;                             // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false;                       // documentación
  if (g0 === 0x2001 && g1 === 0) return false;                            // Teredo
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false;    // descarte
  return (g0 & 0xe000) === 0x2000;                                        // solo unicast global 2000::/3
}

// ---------- Cliente ----------

export interface DireccionResuelta { address: string; family: number }
export type Resolutor = (host: string) => Promise<DireccionResuelta[]>;

export interface PeticionSegura {
  metodo: 'GET' | 'POST';
  host: string;
  ruta: string; // ya incluye la consulta (?a=b); empieza por "/"
  cabeceras: Record<string, string>;
  cuerpo?: string;
}
export interface RespuestaSegura { estado: number; cuerpo: string; /** Cabeceras de la respuesta, con el nombre en minúsculas (solo las de valor simple). */ cabeceras?: Record<string, string> }

/** Transporte real. Recibe la IP ya validada: la conexión va a esa IP y el certificado se valida contra el nombre. */
export type Transporte = (ip: DireccionResuelta, p: PeticionSegura, o: { timeoutMs: number; maxBytes: number }) => Promise<RespuestaSegura>;

export interface OpcionesHttpSeguro {
  resolutor?: Resolutor;
  transporte?: Transporte;
  timeoutMs?: number;
  maxBytes?: number;
  /** SOLO pruebas locales. En producción la configuración se niega a arrancar con esto activo. */
  permitirPrivadas?: boolean;
  /** SOLO pruebas: certificado de una autoridad propia. */
  ca?: string | Buffer;
  puerto?: number; // SOLO pruebas (con permitirPrivadas)
}

const resolutorReal: Resolutor = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

export class HttpSeguro {
  constructor(private readonly o: OpcionesHttpSeguro = {}) {}

  async pedir(p: PeticionSegura): Promise<RespuestaSegura> {
    const host = nombreDeDominioValido(p.host);
    if (!host || !p.ruta.startsWith('/') || /[\s\u0000-\u001f]/.test(p.ruta)) throw new ErrorHttpSeguro('direccion_no_permitida');
    let direcciones: DireccionResuelta[];
    try { direcciones = await (this.o.resolutor ?? resolutorReal)(host); } catch { throw new ErrorHttpSeguro('no_disponible'); }
    // Todas las respuestas del DNS deben ser públicas: una sola privada basta para rechazar (evita mezclas a propósito).
    if (direcciones.length === 0 || (!this.o.permitirPrivadas && !direcciones.every((d) => ipEsPublica(d.address)))) throw new ErrorHttpSeguro('direccion_no_permitida');
    const destino = direcciones.find((d) => d.family === 4) ?? direcciones[0]!;
    const op = { timeoutMs: this.o.timeoutMs ?? 10_000, maxBytes: this.o.maxBytes ?? 1_000_000 };
    return (this.o.transporte ?? transporteReal(this.o))(destino, { ...p, host }, op);
  }
}

function transporteReal(o: OpcionesHttpSeguro): Transporte {
  return (ip, p, { timeoutMs, maxBytes }) => new Promise<RespuestaSegura>((resolve, reject) => {
    let cerrado = false;
    const fin = (f: () => void) => { if (!cerrado) { cerrado = true; clearTimeout(reloj); f(); } };
    const req = request({
      host: p.host, port: o.puerto ?? 443, method: p.metodo, path: p.ruta, servername: p.host, ca: o.ca, rejectUnauthorized: true,
      headers: { ...p.cabeceras, Host: p.host, ...(p.cuerpo !== undefined ? { 'Content-Length': String(Buffer.byteLength(p.cuerpo)) } : {}) },
      // La conexión va a la IP validada, no a una segunda resolución (Node 22 puede pedir la forma con lista).
      lookup: ((_h: string, op: { all?: boolean }, cb: (...a: unknown[]) => void) => (op?.all ? cb(null, [{ address: ip.address, family: ip.family }]) : cb(null, ip.address, ip.family))) as never,
      agent: false,
    }, (res: IncomingMessage) => {
      const estado = res.statusCode ?? 0;
      if (estado >= 300 && estado < 400) { res.destroy(); return fin(() => reject(new ErrorHttpSeguro('redireccion'))); }
      const trozos: Buffer[] = []; let total = 0;
      res.on('data', (t: Buffer) => {
        total += t.length;
        if (total > maxBytes) { res.destroy(); req.destroy(); return fin(() => reject(new ErrorHttpSeguro('respuesta_demasiado_grande'))); }
        trozos.push(t);
      });
      res.on('end', () => fin(() => {
        const cabeceras: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') cabeceras[k.toLowerCase()] = v.slice(0, 500);
        resolve({ estado, cuerpo: Buffer.concat(trozos).toString('utf8'), cabeceras });
      }));
      res.on('error', () => fin(() => reject(new ErrorHttpSeguro('no_disponible'))));
    });
    const reloj = setTimeout(() => { req.destroy(); fin(() => reject(new ErrorHttpSeguro('tiempo_agotado'))); }, timeoutMs);
    req.on('error', () => fin(() => reject(new ErrorHttpSeguro('no_disponible'))));
    if (p.cuerpo !== undefined) req.write(p.cuerpo);
    req.end();
  });
}

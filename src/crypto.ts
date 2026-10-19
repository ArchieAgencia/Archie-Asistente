import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// ---------- Cifrado de secretos (credenciales de conectores, secretos 2FA) ----------

export interface Llaves {
  activa: number;
  porVersion: Map<number, Buffer>;
}

/** ARCHIE_CLAVES_MAESTRAS="1:<base64 de 32 bytes>,2:<...>" y ARCHIE_CLAVE_ACTIVA="2". Rotar = agregar versión y activarla. */
export function cargarLlaves(env: NodeJS.ProcessEnv = process.env): Llaves {
  const crudo = env.ARCHIE_CLAVES_MAESTRAS ?? '';
  const porVersion = new Map<number, Buffer>();
  for (const par of crudo.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [v, k] = par.split(':');
    const version = Number(v);
    const llave = Buffer.from(k ?? '', 'base64');
    if (!Number.isInteger(version) || version < 1 || llave.length !== 32) {
      throw new Error('ARCHIE_CLAVES_MAESTRAS inválida (cada clave debe ser de 32 bytes en base64)');
    }
    porVersion.set(version, llave);
  }
  const activa = Number(env.ARCHIE_CLAVE_ACTIVA);
  if (!porVersion.has(activa)) throw new Error('ARCHIE_CLAVE_ACTIVA no corresponde a ninguna clave cargada');
  return { activa, porVersion };
}

export interface Cifrado {
  version: number;
  datos: Buffer; // nonce(12) | texto cifrado | etiqueta(16)
}

// El contexto (organización y propósito) queda atado al cifrado: un secreto copiado a otra fila no se puede descifrar.
const aad = (orgId: string, contexto: string) => Buffer.from(`${orgId}|${contexto}`, 'utf8');

export function cifrar(llaves: Llaves, texto: string, orgId: string, contexto: string): Cifrado {
  const llave = llaves.porVersion.get(llaves.activa)!;
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', llave, nonce);
  c.setAAD(aad(orgId, contexto));
  const cifrado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return { version: llaves.activa, datos: Buffer.concat([nonce, cifrado, c.getAuthTag()]) };
}

export function descifrar(llaves: Llaves, c: Cifrado, orgId: string, contexto: string): string {
  const llave = llaves.porVersion.get(c.version);
  if (!llave || c.datos.length < 12 + 16) throw new Error('No se pudo descifrar');
  try {
    const d = createDecipheriv('aes-256-gcm', llave, c.datos.subarray(0, 12));
    d.setAAD(aad(orgId, contexto));
    d.setAuthTag(c.datos.subarray(c.datos.length - 16));
    return Buffer.concat([d.update(c.datos.subarray(12, c.datos.length - 16)), d.final()]).toString('utf8');
  } catch {
    throw new Error('No se pudo descifrar'); // mensaje único: no revela la causa
  }
}

// ---------- Contraseñas ----------

const N = 32768, R = 8, P = 1, LARGO = 64, MAXMEM = 64 * 1024 * 1024;
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200; // evita usar contraseñas enormes para agotar CPU

export function validarPassword(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`;
  if (pw.length > MAX_PASSWORD) return 'La contraseña es demasiado larga';
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const err = validarPassword(pw);
  if (err) throw new Error(err);
  const salt = randomBytes(16);
  const h = await scryptAsync(pw, salt, LARGO, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verificarPassword(pw: string, guardado: string): Promise<boolean> {
  if (pw.length > MAX_PASSWORD) return false;
  const partes = guardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, n, r, p, sal, hash] = partes;
  const esperado = Buffer.from(hash ?? '', 'base64');
  const calculado = await scryptAsync(pw, Buffer.from(sal ?? '', 'base64'), esperado.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  }).catch(() => null);
  return calculado !== null && calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

// ---------- Tokens de sesión ----------

export const nuevoToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (t: string): Buffer => createHash('sha256').update(t).digest();

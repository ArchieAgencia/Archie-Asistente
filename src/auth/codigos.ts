import { randomBytes } from 'node:crypto';
import { hashToken } from '../crypto.js';

/** Sin 0/O/1/I/L para que se lean bien en papel. 32 símbolos = 5 bits cada uno, sin sesgo al tomar bytes. */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LARGO = 16; // 80 bits
export const CANTIDAD_CODIGOS = 10;

/** Un código de recuperación: 16 caracteres en grupos de 4 (XXXX-XXXX-XXXX-XXXX). */
export function nuevoCodigoRecuperacion(): string {
  const b = randomBytes(LARGO);
  let s = '';
  for (let i = 0; i < LARGO; i++) s += ALFABETO[b[i]! % ALFABETO.length];
  return s.match(/.{4}/g)!.join('-');
}

/** Quita espacios y guiones y pasa a mayúsculas. Devuelve null si no tiene la forma de un código. */
export function normalizarCodigo(texto: string): string | null {
  const t = texto.replace(/[\s-]/g, '').toUpperCase();
  return t.length === LARGO && [...t].every((c) => ALFABETO.includes(c)) ? t : null;
}

export const hashCodigo = (normalizado: string): Buffer => hashToken(`recuperacion:${normalizado}`);

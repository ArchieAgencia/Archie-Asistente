import * as OTPAuth from 'otpauth';

const EMISOR = 'Archie';
const PERIODO = 30;

export function nuevoSecretoTotp(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function uriTotp(secretoBase32: string, email: string): string {
  return new OTPAuth.TOTP({
    issuer: EMISOR, label: email, algorithm: 'SHA1', digits: 6, period: PERIODO,
    secret: OTPAuth.Secret.fromBase32(secretoBase32),
  }).toString();
}

/**
 * Verifica un código con tolerancia de ±1 intervalo (desfase de reloj).
 * Devuelve el número de intervalo aceptado, o null. `ultimoPaso` impide reutilizar un código ya aceptado.
 */
export function verificarTotp(secretoBase32: string, codigo: string, ultimoPaso: number | null, ahoraMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(codigo)) return null;
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: PERIODO, secret: OTPAuth.Secret.fromBase32(secretoBase32),
  });
  const delta = totp.validate({ token: codigo, timestamp: ahoraMs, window: 1 });
  if (delta === null) return null;
  const paso = Math.floor(ahoraMs / 1000 / PERIODO) + delta;
  if (ultimoPaso !== null && paso <= ultimoPaso) return null;
  return paso;
}

/** Solo para pruebas: genera el código vigente. */
export function codigoActual(secretoBase32: string, ahoraMs = Date.now()): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: PERIODO, secret: OTPAuth.Secret.fromBase32(secretoBase32),
  }).generate({ timestamp: ahoraMs });
}

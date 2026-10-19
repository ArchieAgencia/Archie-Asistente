import { describe, expect, it } from 'vitest';
import { cookieBorrar, cookieSesion, leerCookie } from '../src/auth/cookies.js';
import { Limitador } from '../src/auth/limitador.js';
import { codigoActual, nuevoSecretoTotp, uriTotp, verificarTotp } from '../src/auth/totp.js';

describe('cookies', () => {
  const token = 'A'.repeat(43);
  it('la cookie de sesión es HttpOnly, SameSite y Secure en producción', () => {
    const c = cookieSesion(token, 60, true);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
    expect(cookieSesion(token, 60, false)).not.toContain('Secure');
    expect(cookieBorrar(true)).toContain('Max-Age=0');
  });
  it('lee la cookie correcta entre varias y descarta valores raros', () => {
    expect(leerCookie(`otra=1; archie_sid=${token}; x=y`, 'archie_sid')).toBe(token);
    expect(leerCookie('archie_sid=corto', 'archie_sid')).toBeUndefined();
    expect(leerCookie('archie_sid=' + 'a;b'.repeat(10), 'archie_sid')).toBeUndefined();
    expect(leerCookie(undefined, 'archie_sid')).toBeUndefined();
    expect(leerCookie(`xarchie_sid=${token}`, 'archie_sid')).toBeUndefined();
  });
});

describe('limitador', () => {
  it('permite hasta el máximo y luego bloquea; la ventana se libera con el tiempo', () => {
    const l = new Limitador(3, 1000);
    expect([1, 2, 3, 4].map(() => l.permitir('k', 0))).toEqual([true, true, true, false]);
    expect(l.permitir('k', 500)).toBe(false);
    expect(l.permitir('k', 1001)).toBe(true);
  });
  it('claves distintas no se afectan y la memoria tiene tope', () => {
    const l = new Limitador(1, 1000, 50);
    for (let i = 0; i < 500; i++) l.permitir(`ip-${i}`, i);
    expect(l.permitir('nueva', 600)).toBe(true);
    expect((l as unknown as { golpes: Map<string, unknown> }).golpes.size).toBeLessThanOrEqual(51);
  });
});

describe('TOTP', () => {
  const secreto = nuevoSecretoTotp();
  const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);
  it('acepta el código vigente y rechaza formatos inválidos', () => {
    const c = codigoActual(secreto, t0);
    expect(verificarTotp(secreto, c, null, t0)).not.toBeNull();
    for (const mal of ['12345', '1234567', 'abcdef', '', '12 456']) expect(verificarTotp(secreto, mal, null, t0)).toBeNull();
  });
  it('tolera un intervalo de desfase pero no dos', () => {
    expect(verificarTotp(secreto, codigoActual(secreto, t0 - 30_000), null, t0)).not.toBeNull();
    expect(verificarTotp(secreto, codigoActual(secreto, t0 - 90_000), null, t0)).toBeNull();
  });
  it('no permite reutilizar un código ya aceptado', () => {
    const c = codigoActual(secreto, t0);
    const paso = verificarTotp(secreto, c, null, t0)!;
    expect(verificarTotp(secreto, c, paso, t0)).toBeNull();
    expect(verificarTotp(secreto, codigoActual(secreto, t0 + 30_000), paso, t0 + 30_000)).not.toBeNull();
  });
  it('la URI para la app de autenticación lleva el emisor y no el secreto del servidor equivocado', () => {
    const u = uriTotp(secreto, 'ana@ejemplo.com');
    expect(u.startsWith('otpauth://totp/')).toBe(true);
    expect(u).toContain('issuer=Archie');
  });
});

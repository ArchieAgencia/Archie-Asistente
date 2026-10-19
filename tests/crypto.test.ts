import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cargarLlaves, cifrar, descifrar, hashPassword, hashToken, nuevoToken, validarPassword, verificarPassword,
} from '../src/crypto.js';

const k = () => randomBytes(32).toString('base64');
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('cifrado de secretos', () => {
  const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${k()}`, ARCHIE_CLAVE_ACTIVA: '1' });

  it('cifra y descifra, y el texto plano no aparece en los datos', () => {
    const c = cifrar(llaves, 'clave-api-de-prueba-123', ORG_A, 'send');
    expect(c.datos.toString('utf8')).not.toContain('clave-api-de-prueba');
    expect(descifrar(llaves, c, ORG_A, 'send')).toBe('clave-api-de-prueba-123');
  });
  it('dos cifrados del mismo texto son distintos (nonce aleatorio)', () => {
    const a = cifrar(llaves, 'x', ORG_A, 'send');
    const b = cifrar(llaves, 'x', ORG_A, 'send');
    expect(a.datos.equals(b.datos)).toBe(false);
  });
  it('un secreto de una organización no se descifra como de otra ni con otro propósito', () => {
    const c = cifrar(llaves, 'secreto', ORG_A, 'send');
    expect(() => descifrar(llaves, c, ORG_B, 'send')).toThrowError('No se pudo descifrar');
    expect(() => descifrar(llaves, c, ORG_A, 'talk')).toThrowError('No se pudo descifrar');
  });
  it('detecta datos alterados', () => {
    const c = cifrar(llaves, 'secreto', ORG_A, 'send');
    c.datos[20] = (c.datos[20] ?? 0) ^ 1;
    expect(() => descifrar(llaves, c, ORG_A, 'send')).toThrowError('No se pudo descifrar');
  });
  it('rotación: lo cifrado con la versión 1 sigue leyéndose cuando la 2 es la activa', () => {
    const k1 = k();
    const v1 = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${k1}`, ARCHIE_CLAVE_ACTIVA: '1' });
    const viejo = cifrar(v1, 'dato', ORG_A, 'send');
    const v2 = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${k1},2:${k()}`, ARCHIE_CLAVE_ACTIVA: '2' });
    expect(descifrar(v2, viejo, ORG_A, 'send')).toBe('dato');
    expect(cifrar(v2, 'nuevo', ORG_A, 'send').version).toBe(2);
  });
  it('rechaza claves de tamaño incorrecto o versión activa inexistente, sin mostrar el valor', () => {
    expect(() => cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: '1:corta', ARCHIE_CLAVE_ACTIVA: '1' })).toThrowError(/inválida/);
    expect(() => cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${k()}`, ARCHIE_CLAVE_ACTIVA: '3' })).toThrowError(/ACTIVA/);
    try {
      cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: '1:valor-secreto-corto', ARCHIE_CLAVE_ACTIVA: '1' });
    } catch (e) {
      expect(String(e)).not.toContain('valor-secreto-corto');
    }
  });
});

describe('contraseñas', () => {
  it('verifica la correcta y rechaza la incorrecta', async () => {
    const h = await hashPassword('una-contraseña-larga-123');
    expect(await verificarPassword('una-contraseña-larga-123', h)).toBe(true);
    expect(await verificarPassword('otra-contraseña-larga-1', h)).toBe(false);
  });
  it('el mismo texto produce hashes distintos (sal aleatoria) y el hash no contiene la contraseña', async () => {
    const a = await hashPassword('una-contraseña-larga-123');
    const b = await hashPassword('una-contraseña-larga-123');
    expect(a).not.toBe(b);
    expect(a).not.toContain('una-contraseña');
  });
  it('exige largo mínimo y máximo', async () => {
    expect(validarPassword('corta')).not.toBeNull();
    expect(validarPassword('x'.repeat(201))).not.toBeNull();
    await expect(hashPassword('corta')).rejects.toThrow();
    expect(await verificarPassword('x'.repeat(5000), 'scrypt$32768$8$1$AA==$AA==')).toBe(false);
  });
  it('rechaza formatos de hash desconocidos o corruptos sin lanzar error', async () => {
    expect(await verificarPassword('lo-que-sea-123456', 'md5$abc')).toBe(false);
    expect(await verificarPassword('lo-que-sea-123456', '')).toBe(false);
    expect(await verificarPassword('lo-que-sea-123456', 'scrypt$1$1$1$AA==$AA==')).toBe(false);
  });
});

describe('tokens de sesión', () => {
  it('son únicos, largos y su hash es estable', () => {
    const a = nuevoToken(), b = nuevoToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a).equals(hashToken(a))).toBe(true);
    expect(hashToken(a).equals(hashToken(b))).toBe(false);
  });
});

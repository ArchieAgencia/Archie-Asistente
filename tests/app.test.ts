import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cargarConfig } from '../src/config.js';
import { crearApp } from '../src/app.js';

describe('configuración', () => {
  it('usa valores por defecto', () => {
    const c = cargarConfig({ NODE_ENV: 'development' });
    expect(c.PORT).toBe(8800);
  });
  it('rechaza un puerto inválido sin mostrar el valor', () => {
    expect(() => cargarConfig({ PORT: 'abc-secreto' })).toThrowError(/PORT/);
    try {
      cargarConfig({ PORT: 'abc-secreto' });
    } catch (e) {
      expect(String(e)).not.toContain('abc-secreto');
    }
  });
});

describe('/salud', () => {
  it('responde ok con la versión y cabeceras de seguridad', async () => {
    const app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_VERSION: '1.2.3' }));
    const r = await app.inject({ method: 'GET', url: '/salud' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, version: '1.2.3' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });
  it('no existe otra ruta pública', async () => {
    const app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_WEB_DIR: '/ruta/que/no/existe' })); // sin interfaz compilada solo existe la API
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});

describe('interfaz web', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archie-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Archie AI</title>');
  writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');

  it('sirve la interfaz, vuelve a index.html en rutas del panel y no lo hace en la API', async () => {
    const app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_WEB_DIR: dir }));
    const raiz = await app.inject({ method: 'GET', url: '/administracion/clientes/123' });
    expect(raiz.statusCode).toBe(200);
    expect(raiz.body).toContain('Archie AI');
    expect(raiz.headers['cache-control']).toBe('no-cache'); // el HTML siempre se revalida; los archivos con huella en el nombre se guardan un año
    expect((await app.inject({ method: 'GET', url: '/assets/a.js' })).headers['cache-control']).toContain('immutable');
    const api = await app.inject({ method: 'GET', url: '/api/no-existe' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'no_encontrado' });
    expect((await app.inject({ method: 'POST', url: '/otra-cosa' })).statusCode).toBe(404);
    await app.close();
  });

  it('manda una política de contenido estricta y prohíbe incrustar el sitio en otro', async () => {
    const app = crearApp(cargarConfig({ NODE_ENV: 'test', ARCHIE_2FA_ADMIN: 'opcional', ARCHIE_WEB_DIR: dir }));
    const r = await app.inject({ method: 'GET', url: '/' });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    await app.close();
  });
});

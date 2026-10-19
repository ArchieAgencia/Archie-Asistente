import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpSeguro, ErrorHttpSeguro, ipEsPublica, nombreDeDominioValido } from '../src/conectores/http-seguro.js';

describe('direcciones IP públicas', () => {
  const publicas = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8'];
  const privadas = [
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255',
    '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.9', '240.0.0.1',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:a9fe:a9fe::1',
    '::127.0.0.1', 'no-es-ip', '1.2.3', '999.1.1.1', '300.1.1.1', '', '2000::1::2',
  ];
  it.each(publicas)('%s es pública', (ip) => expect(ipEsPublica(ip)).toBe(true));
  it.each(privadas)('"%s" se rechaza', (ip) => expect(ipEsPublica(ip)).toBe(false));
});

describe('nombres de dominio', () => {
  it('acepta nombres públicos y normaliza', () => {
    expect(nombreDeDominioValido('Tienda.Ejemplo.com')).toBe('tienda.ejemplo.com');
    expect(nombreDeDominioValido('mi-tienda.myshopify.com.')).toBe('mi-tienda.myshopify.com');
    expect(nombreDeDominioValido('xn--tienda-9ya.co')).toBe('xn--tienda-9ya.co');
  });
  it.each(['localhost', 'a.localhost', 'servidor.local', 'db.internal', '127.0.0.1', '10.0.0.1', '[::1]', '1.2.3.4', 'tienda.com:8080', 'tienda.com/ruta', 'user@tienda.com', 'sin-punto', '-malo.com', 'malo-.com', 'a..com', 'tienda.com ', 'tienda com.co', 'x.1234', ''.padEnd(260, 'a') + '.com', 'tienda.com\n.evil.com', 'tienda\u0000.com'])('rechaza %j', (h) => {
    if (h === 'tienda.com ') expect(nombreDeDominioValido(h)).toBe('tienda.com'); // los espacios de los bordes se recortan
    else expect(nombreDeDominioValido(h)).toBeNull();
  });
});

describe('HttpSeguro con resolutor y transporte simulados', () => {
  const ok = { estado: 200, cuerpo: '{}' };
  const pet = { metodo: 'GET' as const, host: 'tienda.ejemplo.com', ruta: '/wp-json/wc/v3/orders', cabeceras: {} };

  it('conecta a la IP validada y no a otra', async () => {
    let usada = '';
    const h = new HttpSeguro({ resolutor: async () => [{ address: '93.184.216.34', family: 4 }], transporte: async (ip) => { usada = ip.address; return ok; } });
    expect(await h.pedir(pet)).toEqual(ok);
    expect(usada).toBe('93.184.216.34');
  });
  it('rechaza si UNA sola de las direcciones es privada (mezcla pública y privada)', async () => {
    const h = new HttpSeguro({ resolutor: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], transporte: async () => ok });
    await expect(h.pedir(pet)).rejects.toMatchObject({ codigo: 'direccion_no_permitida' });
  });
  it.each(['127.0.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd00::1'])('rechaza un dominio que resuelve a %s', async (address) => {
    let llamado = false;
    const h = new HttpSeguro({ resolutor: async () => [{ address, family: address.includes(':') ? 6 : 4 }], transporte: async () => { llamado = true; return ok; } });
    await expect(h.pedir(pet)).rejects.toBeInstanceOf(ErrorHttpSeguro);
    expect(llamado).toBe(false);
  });
  it('rechaza IP escrita a mano, nombres internos, rutas raras y no resuelve ni conecta', async () => {
    let resueltos = 0;
    const h = new HttpSeguro({ resolutor: async () => { resueltos++; return [{ address: '93.184.216.34', family: 4 }]; }, transporte: async () => ok });
    for (const host of ['127.0.0.1', 'localhost', 'a.internal', '[::1]', 'x.com:22']) await expect(h.pedir({ ...pet, host })).rejects.toMatchObject({ codigo: 'direccion_no_permitida' });
    for (const ruta of ['http://otro.com/', 'sin-barra', '/a b', '/a\r\nHost: x']) await expect(h.pedir({ ...pet, ruta })).rejects.toMatchObject({ codigo: 'direccion_no_permitida' });
    expect(resueltos).toBe(0);
  });
  it('un fallo del DNS o una lista vacía se tratan como no disponibles / no permitidas', async () => {
    await expect(new HttpSeguro({ resolutor: async () => { throw new Error('ENOTFOUND'); } }).pedir(pet)).rejects.toMatchObject({ codigo: 'no_disponible' });
    await expect(new HttpSeguro({ resolutor: async () => [] }).pedir(pet)).rejects.toMatchObject({ codigo: 'direccion_no_permitida' });
  });
  it('vuelve a resolver en cada petición (no guarda la primera respuesta del DNS)', async () => {
    let n = 0;
    const h = new HttpSeguro({ resolutor: async () => [{ address: n++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }], transporte: async () => ok });
    await h.pedir(pet);
    await expect(h.pedir(pet)).rejects.toMatchObject({ codigo: 'direccion_no_permitida' }); // rebinding
  });
});

describe('transporte real contra un servidor HTTPS local', () => {
  let srv: Server; let puerto = 0; let ca = '';
  const visto: { host?: string; auth?: string; metodo?: string; cuerpo?: string }[] = [];
  beforeAll(async () => {
    const d = mkdtempSync(join(tmpdir(), 'cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(d, 'k.pem'), '-out', join(d, 'c.pem'), '-days', '2', '-subj', '/CN=tienda.ejemplo.com', '-addext', 'subjectAltName=DNS:tienda.ejemplo.com'], { stdio: 'ignore' });
    ca = readFileSync(join(d, 'c.pem'), 'utf8');
    srv = createServer({ key: readFileSync(join(d, 'k.pem')), cert: ca }, (req, res) => {
      let cuerpo = ''; req.on('data', (t) => (cuerpo += t));
      req.on('end', () => {
        visto.push({ host: req.headers.host, auth: req.headers.authorization as string | undefined, metodo: req.method, cuerpo });
        if (req.url === '/redir') { res.writeHead(302, { Location: 'https://127.0.0.1/' }); return res.end(); }
        if (req.url === '/grande') { res.writeHead(200); return res.end('x'.repeat(5000)); }
        if (req.url === '/lento') return; // nunca responde
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    puerto = (srv.address() as { port: number }).port;
  });
  afterAll(() => { srv?.close(); });

  const cliente = (extra = {}) => new HttpSeguro({ permitirPrivadas: true, ca, puerto, resolutor: async () => [{ address: '127.0.0.1', family: 4 }], ...extra });
  const pet = { metodo: 'GET' as const, host: 'tienda.ejemplo.com', ruta: '/x', cabeceras: { Authorization: 'Basic abc' } };

  it('GET y POST: valida el certificado contra el nombre, envía el Host y el cuerpo', async () => {
    const r = await cliente().pedir(pet);
    expect(r).toMatchObject({ estado: 200, cuerpo: '{"ok":true}' });
    expect(r.cabeceras?.['content-type']).toBe('application/json');
    await cliente().pedir({ ...pet, metodo: 'POST', cuerpo: '{"q":"1"}' });
    expect(visto.at(-2)).toMatchObject({ host: 'tienda.ejemplo.com', auth: 'Basic abc', metodo: 'GET' });
    expect(visto.at(-1)).toMatchObject({ metodo: 'POST', cuerpo: '{"q":"1"}' });
  });
  it('un certificado que no corresponde al nombre se rechaza', async () => {
    await expect(new HttpSeguro({ permitirPrivadas: true, ca, puerto, resolutor: async () => [{ address: '127.0.0.1', family: 4 }] }).pedir({ ...pet, host: 'otra.ejemplo.com' })).rejects.toMatchObject({ codigo: 'no_disponible' });
  });
  it('no sigue redirecciones', async () => { await expect(cliente().pedir({ ...pet, ruta: '/redir' })).rejects.toMatchObject({ codigo: 'redireccion' }); });
  it('corta las respuestas demasiado grandes', async () => { await expect(cliente({ maxBytes: 1000 }).pedir({ ...pet, ruta: '/grande' })).rejects.toMatchObject({ codigo: 'respuesta_demasiado_grande' }); });
  it('corta por tiempo', async () => { await expect(cliente({ timeoutMs: 300 }).pedir({ ...pet, ruta: '/lento' })).rejects.toMatchObject({ codigo: 'tiempo_agotado' }); });
  it('sin permitirPrivadas, aunque el servidor exista en 127.0.0.1, no se conecta', async () => {
    const n = visto.length;
    await expect(new HttpSeguro({ ca, puerto, resolutor: async () => [{ address: '127.0.0.1', family: 4 }] }).pedir(pet)).rejects.toMatchObject({ codigo: 'direccion_no_permitida' });
    expect(visto.length).toBe(n);
  });
});

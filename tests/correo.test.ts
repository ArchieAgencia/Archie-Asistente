import { describe, expect, it } from 'vitest';
import { cargarConfig } from '../src/config.js';
import { CorreoMemoria, CorreoResend, DestinatarioNoPermitido, listaSoloA } from '../src/correo/correo.js';
import { Notificador } from '../src/correo/notificador.js';
import { correoInvitacion, esc } from '../src/correo/plantillas.js';

const expira = new Date('2026-10-23T17:00:00Z');
const enlace = 'https://archie.ejemplo.test/invitacion#t=abc';

describe('plantilla de invitación', () => {
  it('escapa todo lo que escriben las personas y no deja saltos de línea en el asunto', () => {
    const c = correoInvitacion({ organizacion: 'Clínica <script>alert(1)</script>\r\nBcc: x@malo.test', invitador: 'Ana "la jefa" <b>', rol: 'miembro', nombre: '<img src=x>', enlace, expira });
    expect(c.html).not.toContain('<script>');
    expect(c.html).not.toContain('<img src=x>');
    expect(c.html).not.toContain('<b>');
    expect(c.html).toContain('&lt;script&gt;');
    expect(c.asunto).not.toMatch(/[\r\n]/);
    expect(c.html).toContain('Crear mi contraseña');
    expect(c.texto).toContain(enlace);
  });
  it('dice cuándo vence en hora de Bogotá y a nombre de quien invita', () => {
    const c = correoInvitacion({ organizacion: 'Sol', invitador: 'Ana', rol: 'admin', enlace, expira });
    expect(c.texto).toContain('23 de octubre de 2026');
    expect(c.asunto).toBe('Ana te invitó a Sol en Archie AI');
    expect(correoInvitacion({ organizacion: 'Sol', rol: 'admin', enlace, expira }).asunto).toBe('Te invitamos a Archie AI para Sol');
  });
  it('esc escapa los cinco caracteres peligrosos', () => { expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;'); });
});

describe('CorreoResend', () => {
  const base = { apiKey: 'clave-falsa-1234567890', remitente: 'Archie AI <no-responder@ejemplo.test>' }; // gitleaks:allow (valor falso de prueba)
  it('envía a la API con la clave en la cabecera y la clave de idempotencia', async () => {
    let visto: { url: string; init: RequestInit } | undefined;
    const c = new CorreoResend({ ...base, fetch: (async (url: string, init: RequestInit) => { visto = { url, init }; return new Response('{}', { status: 200 }); }) as typeof fetch });
    await c.enviar({ para: 'a@x.test', asunto: 'Hola', html: '<p>h</p>', texto: 'h', clave: 'inv-1' });
    expect(visto!.url).toBe('https://api.resend.com/emails');
    const h = visto!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${base.apiKey}`);
    expect(h['Idempotency-Key']).toBe('inv-1');
    expect(JSON.parse(String(visto!.init.body))).toMatchObject({ from: base.remitente, to: ['a@x.test'], subject: 'Hola' });
  });
  it('si Resend rechaza, el error no incluye el cuerpo ni el enlace', async () => {
    const c = new CorreoResend({ ...base, fetch: (async () => new Response('{"detalle":"a@x.test enlace #t=secreto"}', { status: 422 })) as typeof fetch });
    const e = await c.enviar({ para: 'a@x.test', asunto: 's', html: 'h', texto: 'https://x/#t=secreto' }).catch((x: Error) => x);
    expect(String((e as Error).message)).toBe('Resend respondió 422');
  });
  it('la lista de seguridad bloquea destinatarios que no estén en ella', async () => {
    let llamadas = 0;
    const c = new CorreoResend({ ...base, soloA: listaSoloA('delivered@resend.dev, @archieagencia.com'), fetch: (async () => { llamadas++; return new Response('{}'); }) as typeof fetch });
    await c.enviar({ para: 'Delivered@resend.dev', asunto: 's', html: 'h', texto: 't' });
    await c.enviar({ para: 'gerencia@archieagencia.com', asunto: 's', html: 'h', texto: 't' });
    await expect(c.enviar({ para: 'cliente@real.com', asunto: 's', html: 'h', texto: 't' })).rejects.toBeInstanceOf(DestinatarioNoPermitido);
    await expect(c.enviar({ para: 'x@archieagencia.com.malo.test', asunto: 's', html: 'h', texto: 't' })).rejects.toBeInstanceOf(DestinatarioNoPermitido);
    expect(llamadas).toBe(2);
  });
});

describe('Notificador', () => {
  it('pone el token en el fragmento (#t=), que no viaja al servidor, y solo devuelve el enlace si se pide', async () => {
    const m = new CorreoMemoria();
    const sin = new Notificador(m, 'https://archie.ejemplo.test/', false);
    const r = await sin.invitacion({ para: 'a@x.test', organizacion: 'Sol', rol: 'admin', token: 'T'.repeat(43), expira, clave: 'k' });
    expect(r).toEqual({ enviado: true });
    expect(m.enviados[0]!.texto).toContain(`https://archie.ejemplo.test/invitacion#t=${'T'.repeat(43)}`);
    const con = await new Notificador(m, 'https://archie.ejemplo.test', true).invitacion({ para: 'a@x.test', organizacion: 'Sol', rol: 'admin', token: 'T'.repeat(43), expira, clave: 'k' });
    expect(con.enlace).toContain('/invitacion#t=');
  });
  it('un fallo de envío no lanza, se registra sin el token ni el correo y devuelve enviado=false', async () => {
    const m = new CorreoMemoria(); m.falla = true;
    const registros: string[] = [];
    const n = new Notificador(m, 'https://archie.ejemplo.test', false, { error: (o, msg) => registros.push(JSON.stringify(o) + msg) });
    const r = await n.invitacion({ para: 'privado@x.test', organizacion: 'Sol', rol: 'admin', token: 'S'.repeat(43), expira, clave: 'k' });
    expect(r.enviado).toBe(false);
    expect(registros).toHaveLength(1);
    expect(registros[0]).not.toContain('privado@x.test');
    expect(registros[0]).not.toContain('S'.repeat(43));
  });
});

describe('configuración de correo', () => {
  const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ARCHIE_ORIGEN: 'https://archie.ejemplo.test', ARCHIE_IA: 'archie', ARCHIE_IA_CLAVE: 'clave-ia-falsa-1234567890', ARCHIE_IA_MODELO: 'modelo-de-prueba' };
  it('en producción exige envío real con clave y remitente', () => {
    expect(() => cargarConfig(prod)).toThrowError(/ARCHIE_CORREO/);
    expect(() => cargarConfig({ ...prod, ARCHIE_CORREO: 'resend' })).toThrowError(/RESEND_API_KEY/);
    expect(cargarConfig({ ...prod, ARCHIE_CORREO: 'resend', RESEND_API_KEY: 'clave-falsa-1234567890', ARCHIE_CORREO_REMITENTE: 'Archie AI <no-responder@ejemplo.test>' }).ARCHIE_CORREO).toBe('resend'); // gitleaks:allow (valor falso de prueba)
  });
  it('rechaza un remitente con saltos de línea y no revela valores en el error', () => {
    expect(() => cargarConfig({ NODE_ENV: 'development', ARCHIE_CORREO: 'resend', RESEND_API_KEY: 'clave-falsa-1234567890', ARCHIE_CORREO_REMITENTE: 'a@b.test\r\nBcc: x@y.test' })).toThrowError(/ARCHIE_CORREO_REMITENTE/); // gitleaks:allow (valor falso de prueba)
  });
  it('en desarrollo, el correo de consola no necesita nada', () => { expect(cargarConfig({ NODE_ENV: 'development' }).ARCHIE_CORREO).toBe('consola'); });
});

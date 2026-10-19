/** Un correo listo para enviar. `clave` evita duplicados si se reintenta el mismo envío. */
export interface Mensaje { para: string; asunto: string; html: string; texto: string; clave?: string }

/** Proveedor de correo. Las pruebas usan CorreoMemoria; en desarrollo, CorreoConsola; en producción, CorreoResend. */
export interface Correo { enviar(m: Mensaje): Promise<void> }

/** Quita saltos de línea para que ningún dato de entrada pueda inyectar cabeceras de correo. */
const sinSaltos = (s: string) => s.replace(/[\r\n]+/g, ' ');

/** Solo desarrollo: no envía nada; escribe el correo en el registro del servidor para poder probar el enlace. */
export class CorreoConsola implements Correo {
  constructor(private readonly escribir: (linea: string) => void = (l) => console.log(l)) {}
  async enviar(m: Mensaje): Promise<void> {
    this.escribir(`[correo de prueba, no enviado] para=${sinSaltos(m.para)} asunto=${sinSaltos(m.asunto)}\n${m.texto}`);
  }
}

/** Solo pruebas automáticas: guarda los correos en memoria. */
export class CorreoMemoria implements Correo {
  readonly enviados: Mensaje[] = [];
  falla = false;
  async enviar(m: Mensaje): Promise<void> {
    if (this.falla) throw new Error('fallo simulado');
    this.enviados.push(m);
  }
}

export interface OpcionesResend {
  apiKey: string;
  remitente: string;
  /**
   * Lista de seguridad para la etapa de pruebas: si se define, solo se envía a esas direcciones ("a@x.com") o dominios ("@x.com").
   * Cualquier otro destinatario se descarta sin enviar.
   */
  soloA?: string[];
  /** Solo pruebas: reemplaza fetch. */
  fetch?: typeof fetch;
  url?: string;
}

export class DestinatarioNoPermitido extends Error {}

/** Envío real por la API de Resend (sin librería: una sola llamada HTTPS). La clave solo vive en la variable de entorno. */
export class CorreoResend implements Correo {
  constructor(private readonly o: OpcionesResend) {}

  permitido(para: string): boolean {
    if (!this.o.soloA || this.o.soloA.length === 0) return true;
    const p = para.trim().toLowerCase();
    if (p.split('@').length !== 2) return false; // una sola @: así un sufijo de dominio no se puede simular con direcciones raras
    return this.o.soloA.some((x) => (x.startsWith('@') ? p.endsWith(x) : p === x));
  }

  async enviar(m: Mensaje): Promise<void> {
    if (!this.permitido(m.para)) throw new DestinatarioNoPermitido('destinatario fuera de la lista de pruebas');
    const f = this.o.fetch ?? fetch;
    const r = await f(this.o.url ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.o.apiKey}`,
        'Content-Type': 'application/json',
        ...(m.clave ? { 'Idempotency-Key': m.clave } : {}),
      },
      body: JSON.stringify({ from: this.o.remitente, to: [m.para], subject: m.asunto, html: m.html, text: m.texto }),
      signal: AbortSignal.timeout(10_000),
    });
    // Nunca se incluye el cuerpo de la respuesta ni de la petición en el error: podrían traer datos del destinatario o del enlace.
    if (!r.ok) throw new Error(`Resend respondió ${r.status}`);
  }
}

/** Interpreta ARCHIE_CORREO_SOLO_A ("a@x.com, @y.com"). */
export function listaSoloA(valor: string | undefined): string[] | undefined {
  const l = (valor ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return l.length ? l : undefined;
}

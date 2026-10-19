import type { Correo } from './correo.js';
import { RECUPERACION_MINUTOS, type AvisosAuth } from '../auth/servicio.js';
import { correoAlertaConsola, correoAlertaConsumo, correoInvitacionOperador, correoCodigoRecuperacionUsado, correoInvitacion, correoPasswordCambiada, correoRecuperacionPassword } from './plantillas.js';

export interface Registro { error: (o: object, msg: string) => void }

export interface PedidoInvitacion {
  para: string;
  organizacion: string;
  invitador?: string;
  rol: 'admin' | 'miembro';
  nombre?: string;
  token: string;
  expira: Date;
  /** Identificador estable del envío (p. ej. el de la invitación) para no duplicar si se reintenta. */
  clave: string;
}

/**
 * Arma y envía los correos del sistema. Un fallo de envío NUNCA tumba la acción que lo pidió: se registra (sin el token ni el correo)
 * y se devuelve `enviado: false` para que la persona pueda reenviar.
 */
export class Notificador implements AvisosAuth {
  /**
   * @param origen dirección pública del panel (sin barra final)
   * @param devolverEnlace solo desarrollo: devuelve el enlace en la respuesta para poder probar sin correo real. Nunca en producción.
   */
  constructor(
    private readonly correo: Correo,
    private readonly origen: string,
    private readonly devolverEnlace: boolean,
    private readonly log: Registro = { error: () => undefined },
  ) {}

  /** El token va en el fragmento (#t=): no viaja al servidor ni queda en registros de acceso ni en el encabezado Referer. */
  enlaceInvitacion(token: string): string {
    return `${this.origen.replace(/\/+$/, '')}/invitacion#t=${encodeURIComponent(token)}`;
  }

  async invitacion(p: PedidoInvitacion): Promise<{ enviado: boolean; enlace?: string }> {
    const enlace = this.enlaceInvitacion(p.token);
    const c = correoInvitacion({ organizacion: p.organizacion, invitador: p.invitador, rol: p.rol, nombre: p.nombre, enlace, expira: p.expira });
    try {
      await this.correo.enviar({ para: p.para, asunto: c.asunto, html: c.html, texto: c.texto, clave: `invitacion-${p.clave}` });
      return { enviado: true, ...(this.devolverEnlace ? { enlace } : {}) };
    } catch (e) {
      this.log.error({ tipo: 'correo_invitacion', causa: e instanceof Error ? e.constructor.name : 'desconocida' }, 'No se pudo enviar la invitación');
      return { enviado: false, ...(this.devolverEnlace ? { enlace } : {}) };
    }
  }

  /** Aviso de consumo (80 % o 100 %) a una persona administradora. Un fallo se registra y no afecta a nadie más. */
  async alertaConsumo(p: { para: string; organizacion: string; umbral: 80 | 100; consumidas: number; cuota: number; renueva: Date | null; clave: string }): Promise<boolean> {
    const c = correoAlertaConsumo({ organizacion: p.organizacion, umbral: p.umbral, consumidas: p.consumidas, cuota: p.cuota, renueva: p.renueva, enlace: `${this.origen.replace(/\/+$/, '')}/consumo` });
    try { await this.correo.enviar({ para: p.para, asunto: c.asunto, html: c.html, texto: c.texto, clave: `consumo-${p.clave}` }); return true; }
    catch (e) { this.log.error({ tipo: 'correo_alerta_consumo', causa: e instanceof Error ? e.constructor.name : 'desconocida' }, 'No se pudo enviar la alerta de consumo'); return false; }
  }

  /** Aviso de una acción sensible de la consola a las personas administradoras del equipo. Un fallo se registra y no afecta la acción ni a los demás destinatarios. */
  async alertaConsola(p: { para: string[]; quien: string; que: string; cuando: Date; clave: string }): Promise<number> {
    const c = correoAlertaConsola({ quien: p.quien, que: p.que, cuando: p.cuando });
    let enviados = 0;
    for (const [i, para] of p.para.entries()) {
      try { await this.correo.enviar({ para, asunto: c.asunto, html: c.html, texto: c.texto, clave: `consola-${p.clave}-${i}` }); enviados++; }
      catch (e) { this.log.error({ tipo: 'correo_alerta_consola', causa: e instanceof Error ? e.constructor.name : 'desconocida' }, 'No se pudo enviar la alerta de la consola'); }
    }
    return enviados;
  }

  /** El token va en el fragmento (#t=), igual que en las invitaciones de clientes. */
  async invitacionOperador(p: { para: string; nombre: string; rol: 'admin' | 'soporte' | 'finanzas'; invitador: string; token: string; expira: Date; clave: string }): Promise<{ enviado: boolean; enlace?: string }> {
    const enlace = `${this.origen.replace(/\/+$/, '')}/equipo-archie/activar#t=${encodeURIComponent(p.token)}`;
    const c = correoInvitacionOperador({ nombre: p.nombre, rol: p.rol, invitador: p.invitador, enlace, expira: p.expira });
    try {
      await this.correo.enviar({ para: p.para, asunto: c.asunto, html: c.html, texto: c.texto, clave: `invitacion-operador-${p.clave}` });
      return { enviado: true, ...(this.devolverEnlace ? { enlace } : {}) };
    } catch (e) {
      this.log.error({ tipo: 'correo_invitacion_operador', causa: e instanceof Error ? e.constructor.name : 'desconocida' }, 'No se pudo enviar la invitación del operador');
      return { enviado: false, ...(this.devolverEnlace ? { enlace } : {}) };
    }
  }

  // ---------- Avisos de seguridad de la autenticación. Aquí un fallo SÍ se propaga: quien llama decide (se registra sin datos personales). ----------

  /** El token va en el fragmento (#t=), igual que en las invitaciones. */
  async enlaceRecuperacion(p: { para: string; nombre: string | null; token: string; expira: Date; clave: string }): Promise<void> {
    const enlace = `${this.origen.replace(/\/+$/, '')}/restablecer#t=${encodeURIComponent(p.token)}`;
    const c = correoRecuperacionPassword({ nombre: p.nombre, enlace, expira: p.expira, minutos: RECUPERACION_MINUTOS });
    await this.correo.enviar({ para: p.para, asunto: c.asunto, html: c.html, texto: c.texto, clave: `recuperacion-${p.clave}` });
  }

  async passwordCambiada(p: { para: string; nombre: string | null; motivo: 'restablecida' | 'cambiada'; clave: string }): Promise<void> {
    const c = correoPasswordCambiada({ nombre: p.nombre, motivo: p.motivo });
    await this.correo.enviar({ para: p.para, asunto: c.asunto, html: c.html, texto: c.texto, clave: `password-${p.clave}` });
  }

  async codigoRecuperacionUsado(p: { para: string; nombre: string | null; restantes: number; clave: string }): Promise<void> {
    const c = correoCodigoRecuperacionUsado({ nombre: p.nombre, restantes: p.restantes });
    await this.correo.enviar({ para: p.para, asunto: c.asunto, html: c.html, texto: c.texto, clave: `codigo-${p.clave}` });
  }
}

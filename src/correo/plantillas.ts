/** Plantillas de correo de Archie AI. Maquetadas con tablas y estilos en línea (los clientes de correo no entienden CSS moderno). */

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fechaBogota = (d: Date) =>
  new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'America/Bogota' }).format(d);

export interface DatosInvitacion {
  organizacion: string;
  /** Quién invitó: el nombre de una persona del cliente, o vacío cuando invita el equipo de Archie. */
  invitador?: string;
  rol: 'admin' | 'miembro';
  nombre?: string;
  enlace: string;
  expira: Date;
}

const FUENTE = "'Dosis','Trebuchet MS',Arial,sans-serif";

const limpio = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

export function correoInvitacion(entrada: DatosInvitacion): { asunto: string; html: string; texto: string } {
  // Datos escritos por personas: sin saltos de línea (no pueden romper la cabecera del asunto) y siempre escapados en el HTML.
  const d = { ...entrada, organizacion: limpio(entrada.organizacion), invitador: entrada.invitador ? limpio(entrada.invitador) : undefined, nombre: entrada.nombre ? limpio(entrada.nombre) : undefined };
  const rolTxt = d.rol === 'admin' ? 'administrador' : 'miembro del equipo';
  const asunto = d.invitador
    ? `${d.invitador.slice(0, 60)} te invitó a ${d.organizacion.slice(0, 80)} en Archie AI`
    : `Te invitamos a Archie AI para ${d.organizacion.slice(0, 80)}`;
  const saludo = d.nombre ? `Hola, ${d.nombre}.` : 'Hola.';
  const quien = d.invitador ? `${d.invitador} te invitó` : 'Te invitamos';
  const intro = `${quien} a entrar a Archie AI como ${rolTxt} de ${d.organizacion}. Crea tu contraseña con el botón de abajo y listo.`;
  const vence = `El enlace sirve una sola vez y vence el ${fechaBogota(d.expira)}.`;
  const ignora = 'Si no esperabas este correo, ignóralo: sin tu clic no pasa nada y tu correo no queda registrado.';

  const texto = [saludo, '', intro, '', `Crear mi contraseña: ${d.enlace}`, '', vence, ignora, '', 'Archie AI, by Archie Tech'].join('\n');

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(asunto)}</title></head>
<body style="margin:0;padding:0;background-color:#F4EEFF" bgcolor="#F4EEFF">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#F4EEFF">Crea tu contraseña de Archie AI. El enlace sirve una sola vez.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4EEFF" style="background-color:#F4EEFF"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td bgcolor="#131126" style="background-color:#131126;border-radius:12px 12px 0 0;padding:22px 28px;font-family:${FUENTE};font-size:28px;font-weight:800;color:#FFFFFF">Archie <span style="color:#C9B0FF">AI</span></td></tr>
<tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #E3D8FF;border-top:0;border-radius:0 0 12px 12px;padding:28px;font-family:${FUENTE};color:#131126">
<p style="margin:0 0 14px;font-size:20px;font-weight:700">${esc(saludo)}</p>
<p style="margin:0 0 22px;font-size:17px;line-height:1.5">${esc(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#7A3FF2" style="background-color:#7A3FF2;border-radius:100px"><a href="${esc(d.enlace)}" style="display:inline-block;padding:14px 28px;font-family:${FUENTE};font-size:18px;font-weight:700;color:#FFFFFF;text-decoration:none">Crear mi contraseña</a></td></tr></table>
<p style="margin:22px 0 6px;font-size:15px;line-height:1.5;color:#4A4668">${esc(vence)}</p>
<p style="margin:0 0 6px;font-size:15px;line-height:1.5;color:#4A4668">Si el botón no abre, copia este enlace en tu navegador:</p>
<p style="margin:0 0 18px;font-size:13px;line-height:1.5;word-break:break-all;color:#6B2FE0">${esc(d.enlace)}</p>
<p style="margin:0;font-size:15px;line-height:1.5;color:#4A4668">${esc(ignora)}</p>
</td></tr>
<tr><td align="center" style="padding:16px;font-family:${FUENTE};font-size:13px;color:#4A4668">Archie AI, by Archie Tech</td></tr>
</table></td></tr></table></body></html>`;
  return { asunto, html, texto };
}

export interface DatosAlertaConsumo { organizacion: string; umbral: 80 | 100; consumidas: number; cuota: number; renueva: Date | null; enlace: string }

const num = (n: number) => new Intl.NumberFormat('es-CO').format(n);

export function correoAlertaConsumo(entrada: DatosAlertaConsumo): { asunto: string; html: string; texto: string } {
  const org = limpio(entrada.organizacion).slice(0, 80);
  const lleno = entrada.umbral === 100;
  const periodo = entrada.renueva ? 'este mes' : 'en tu prueba';
  const asunto = lleno ? `Se acabaron las consultas de ${org} ${periodo} en Archie AI` : `Ya usaste el 80 % de las consultas de ${org} en Archie AI`;
  const detalle = `Llevan ${num(entrada.consumidas)} de ${num(entrada.cuota)} consultas ${periodo}.`;
  const hasta = entrada.renueva ? `Hasta que se renueven el ${fechaBogota(entrada.renueva)}, ` : 'Mientras no se amplíe el plan, ';
  const siguiente = lleno
    ? `${hasta}Archie AI no podrá responder más preguntas. Si necesitan más, escríbenos y vemos cómo ampliar el plan.`
    : `${entrada.renueva ? `Se renuevan el ${fechaBogota(entrada.renueva)}. ` : 'Las consultas de la prueba no se renuevan. '}Si prevén usar más, escríbenos y vemos cómo ampliar el plan antes de que se acaben.`;
  const texto = [`Hola.`, '', lleno ? `Las consultas de ${org} en Archie AI se acabaron${entrada.renueva ? ' por este mes' : ''}.` : `Las consultas de ${org} en Archie AI van en el 80 %.`, detalle, siguiente, '', `Ver mi consumo: ${entrada.enlace}`, '', 'Archie AI, by Archie Tech'].join('\n');
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(asunto)}</title></head>
<body style="margin:0;padding:0;background-color:#F4EEFF" bgcolor="#F4EEFF">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4EEFF" style="background-color:#F4EEFF"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td bgcolor="#131126" style="background-color:#131126;border-radius:12px 12px 0 0;padding:22px 28px;font-family:${FUENTE};font-size:28px;font-weight:800;color:#FFFFFF">Archie <span style="color:#C9B0FF">AI</span></td></tr>
<tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #E3D8FF;border-top:0;border-radius:0 0 12px 12px;padding:28px;font-family:${FUENTE};color:#131126">
<p style="margin:0 0 14px;font-size:20px;font-weight:700">${esc(lleno ? `Las consultas de ${org} se acabaron ${entrada.renueva ? 'este mes' : 'en la prueba'}` : `Van en el 80 % de las consultas ${entrada.renueva ? 'del mes' : 'de la prueba'}`)}</p>
<p style="margin:0 0 14px;font-size:17px;line-height:1.5">${esc(detalle)}</p>
<p style="margin:0 0 22px;font-size:17px;line-height:1.5">${esc(siguiente)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#7A3FF2" style="background-color:#7A3FF2;border-radius:100px"><a href="${esc(entrada.enlace)}" style="display:inline-block;padding:14px 28px;font-family:${FUENTE};font-size:18px;font-weight:700;color:#FFFFFF;text-decoration:none">Ver mi consumo</a></td></tr></table>
</td></tr>
<tr><td align="center" style="padding:16px;font-family:${FUENTE};font-size:13px;color:#4A4668">Archie AI, by Archie Tech</td></tr>
</table></td></tr></table></body></html>`;
  return { asunto, html, texto };
}

/** Envoltura común de los correos de seguridad: saludo, párrafos y (opcional) un botón. Todo texto se escapa. */
function correoSimple(o: { asunto: string; saludo: string; parrafos: string[]; boton?: { texto: string; enlace: string }; pie?: string }): { asunto: string; html: string; texto: string } {
  const texto = [o.saludo, '', ...o.parrafos.flatMap((p) => [p, '']), ...(o.boton ? [`${o.boton.texto}: ${o.boton.enlace}`, ''] : []), ...(o.pie ? [o.pie, ''] : []), 'Archie AI, by Archie Tech'].join('\n');
  const boton = o.boton
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#7A3FF2" style="background-color:#7A3FF2;border-radius:100px"><a href="${esc(o.boton.enlace)}" style="display:inline-block;padding:14px 28px;font-family:${FUENTE};font-size:18px;font-weight:700;color:#FFFFFF;text-decoration:none">${esc(o.boton.texto)}</a></td></tr></table>
<p style="margin:22px 0 6px;font-size:15px;line-height:1.5;color:#4A4668">Si el botón no abre, copia este enlace en tu navegador:</p>
<p style="margin:0 0 18px;font-size:13px;line-height:1.5;word-break:break-all;color:#6B2FE0">${esc(o.boton.enlace)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.asunto)}</title></head>
<body style="margin:0;padding:0;background-color:#F4EEFF" bgcolor="#F4EEFF">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4EEFF" style="background-color:#F4EEFF"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td bgcolor="#131126" style="background-color:#131126;border-radius:12px 12px 0 0;padding:22px 28px;font-family:${FUENTE};font-size:28px;font-weight:800;color:#FFFFFF">Archie <span style="color:#C9B0FF">AI</span></td></tr>
<tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #E3D8FF;border-top:0;border-radius:0 0 12px 12px;padding:28px;font-family:${FUENTE};color:#131126">
<p style="margin:0 0 14px;font-size:20px;font-weight:700">${esc(o.saludo)}</p>
${o.parrafos.map((p) => `<p style="margin:0 0 16px;font-size:17px;line-height:1.5">${esc(p)}</p>`).join('\n')}
${boton}${o.pie ? `<p style="margin:0;font-size:15px;line-height:1.5;color:#4A4668">${esc(o.pie)}</p>` : ''}
</td></tr>
<tr><td align="center" style="padding:16px;font-family:${FUENTE};font-size:13px;color:#4A4668">Archie AI, by Archie Tech</td></tr>
</table></td></tr></table></body></html>`;
  return { asunto: o.asunto, html, texto };
}

const saludoDe = (nombre: string | null) => (nombre ? `Hola, ${limpio(nombre).slice(0, 80)}.` : 'Hola.');

export function correoRecuperacionPassword(e: { nombre: string | null; enlace: string; expira: Date; minutos: number }) {
  return correoSimple({
    asunto: 'Restablece tu contraseña de Archie AI',
    saludo: saludoDe(e.nombre),
    parrafos: [`Recibimos una solicitud para restablecer tu contraseña. Usa el botón de abajo para crear una nueva. El enlace sirve una sola vez y vence en ${e.minutos} minutos.`],
    boton: { texto: 'Crear una contraseña nueva', enlace: e.enlace },
    pie: 'Si no fuiste tú, ignora este correo: tu contraseña no cambia sin ese clic. Si te preocupa, escríbenos.',
  });
}

export function correoPasswordCambiada(e: { nombre: string | null; motivo: 'restablecida' | 'cambiada' }) {
  return correoSimple({
    asunto: 'Cambió la contraseña de tu cuenta de Archie AI',
    saludo: saludoDe(e.nombre),
    parrafos: [
      e.motivo === 'restablecida' ? 'Tu contraseña de Archie AI se restableció con el enlace de recuperación y cerramos todas tus sesiones abiertas.' : 'Tu contraseña de Archie AI se cambió desde tu cuenta.',
      'Si fuiste tú, no tienes que hacer nada.',
    ],
    pie: 'Si no fuiste tú, escríbenos de inmediato para proteger tu cuenta.',
  });
}

export function correoCodigoRecuperacionUsado(e: { nombre: string | null; restantes: number }) {
  return correoSimple({
    asunto: 'Entraron a tu cuenta de Archie AI con un código de recuperación',
    saludo: saludoDe(e.nombre),
    parrafos: [
      'Se usó uno de tus códigos de recuperación del segundo factor para entrar a tu cuenta de Archie AI.',
      `Te quedan ${e.restantes} código${e.restantes === 1 ? '' : 's'}. Cuando quieras, genera un juego nuevo en Seguridad.`,
    ],
    pie: 'Si no fuiste tú, cambia tu contraseña y escríbenos de inmediato.',
  });
}

/** Aviso al equipo cuando alguien hace una acción sensible en la consola. No lleva datos personales de los clientes: solo qué se hizo, quién y cuándo. */
export function correoAlertaConsola(e: { quien: string; que: string; cuando: Date }) {
  const quien = limpio(e.quien).slice(0, 120);
  return correoSimple({
    asunto: `Consola de Archie AI: ${limpio(e.que).slice(0, 90)}`,
    saludo: 'Hola.',
    parrafos: [
      `${quien} hizo esto en la consola: ${limpio(e.que).slice(0, 300)}.`,
      `Fecha y hora: ${fechaBogota(e.cuando)}.`,
    ],
    pie: 'Si no reconoces esta acción, desactiva a esa persona desde Equipo de Archie y revisa la bitácora de la consola.',
  });
}

export function correoInvitacionOperador(e: { nombre: string; rol: 'admin' | 'soporte' | 'finanzas'; invitador: string; enlace: string; expira: Date }) {
  const rol = { admin: 'administración', soporte: 'soporte', finanzas: 'finanzas' }[e.rol];
  return correoSimple({
    asunto: 'Te invitaron al equipo de Archie AI',
    saludo: saludoDe(e.nombre),
    parrafos: [
      `${limpio(e.invitador).slice(0, 120)} te invitó a la consola del equipo de Archie AI con el rol de ${rol}.`,
      `Crea tu contraseña y activa tu segundo factor con el botón de abajo. El enlace sirve hasta el ${fechaBogota(e.expira)} y puedes usarlo para una sola activación.`,
    ],
    boton: { texto: 'Activar mi cuenta del equipo', enlace: e.enlace },
    pie: 'Si no esperabas esta invitación, ignora el correo: sin tu clic no pasa nada.',
  });
}

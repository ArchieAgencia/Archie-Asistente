export class ErrorApi extends Error {
  constructor(readonly estado: number, readonly codigo: string) { super(codigo); }
}

const MENSAJES: Record<string, string> = {
  credenciales_invalidas: 'Correo o contraseña incorrectos.',
  codigo_invalido: 'El código no es válido. Revisa que lo escribiste bien (si es de la aplicación, espera a que cambie).',
  demasiados_intentos: 'Demasiados intentos. Espera unos minutos.',
  password_incorrecta: 'La contraseña no es correcta.',
  password_debil: 'La contraseña debe tener al menos 12 caracteres.',
  no_autenticado: 'Tu sesión terminó. Entra de nuevo.',
  sesion_invalida: 'Tu sesión terminó. Entra de nuevo.',
  requiere_codigo: 'Falta confirmar con un código nuevo.',
  requiere_asistencia: 'Primero activa el modo asistencia, o deja la cuenta en modo gestionada.',
  saldo_negativo: 'El saldo no puede quedar negativo.',
  datos_invalidos: 'Revisa los datos: hay algo que no es válido.',
  entrada_invalida: 'Revisa los datos: hay algo que no es válido.',
  ya_existe: 'Ese correo ya tiene una cuenta en Archie AI (o una invitación pendiente).',
  no_autorizado: 'Tu rol no tiene permiso para esta acción.',
  plan_invalido: 'Ese plan no existe.',
  cliente_no_encontrado: 'No se encontró ese cliente.',
  enlace_invalido: 'El enlace no sirve: ya se usó o venció. Pide uno nuevo.',
  '2fa_obligatoria': 'Para continuar, activa la verificación en dos pasos.',
  '2fa_no_activo': 'Primero activa la verificación en dos pasos.',
  '2fa_ya_activo': 'La verificación en dos pasos ya está activa.',
  invitacion_invalida: 'Esta invitación no es válida o ya venció. Pide que te la envíen de nuevo.',
  ya_en_equipo: 'Esa persona ya está en tu equipo.',
  demasiadas_invitaciones: 'Enviaste muchas invitaciones. Espera un rato e inténtalo otra vez.',
  demasiadas_pendientes: 'Hay demasiadas invitaciones pendientes. Revoca algunas primero.',
  equipo_lleno: 'Tu equipo llegó al máximo de personas.',
  no_a_ti_mismo: 'No puedes cambiar tu propio rol ni desactivarte.',
  ultimo_admin: 'Debe quedar al menos una persona administradora activa en el equipo.',
  pendiente_de_activar: 'Esa persona todavía no activó su cuenta. Reenvíale la invitación.',
  ya_activado: 'Esa persona ya activó su cuenta.',
  mes_invalido: 'Escoge un mes válido.',
  activacion_incompleta: 'Primero elige tu contraseña.',
  conexion_sana: 'Esa conexión funciona o no se ha probado: solo se quitan las que están fallando. Si hace falta, el cliente puede quitarla desde su cuenta.',
  conexion_no_encontrada: 'Esa conexión ya no existe. Recarga la página.',
  clave_no_encontrada: 'Esa clave no existe o ya estaba revocada.',
  operador_no_encontrado: 'No se encontró a esa persona del equipo.',
  cuenta_propia_no_configurada: 'Todavía no hay una cuenta propia de Archie Tech marcada en el servidor. Pídele a quien administra el servidor que la marque.',
  no_encontrado: 'No encontramos lo que buscabas. Recarga la página.',
  no_hay_invitacion: 'Este cliente no tiene una invitación pendiente que reenviar.',
  sesion_incompleta: 'Falta completar la verificación en dos pasos.',
  sin_conexion: 'Primero conecta Archie Send, una tienda, una cuenta de pauta o una herramienta de la suite en Conexiones.',
  no_se_puede_deshacer: 'No se puede deshacer desde aquí.',
  autonomia_cambiada: 'La autonomía de tu cuenta cambió: ya no se permiten acciones con confirmación. No se hizo nada.',
  ya_resuelta: 'Esta tarjeta ya se resolvió.',
  expirada: 'La tarjeta venció. Pídele a Archie AI una nueva.',
  cambio_la_campana: 'La campaña cambió en Archie Send después de mostrar la tarjeta. No se hizo nada.',
  ya_no_aplica: 'La campaña ya no está en un estado donde se pueda hacer eso. No se hizo nada.',
  ya_deshecha: 'Esta acción ya se había deshecho.',
  send_sin_permiso_escritura: 'La clave de Archie Send conectada no tiene permiso para borrar esto. Dale un rol con permiso de gestión en Archie Send.',
  respuesta_en_curso: 'Todavía estoy respondiendo en esta conversación. Espera a que termine.',
  sin_saldo: 'Se acabaron tus consultas. Escríbenos para recargar.',
  tope_diario: 'Llegaste al tope de consultas de hoy. Mañana se renuevan.',
  suspendido: 'Tu cuenta está suspendida. Escríbenos para ayudarte.',
  conector_no_disponible: 'La conexión con Archie Send aún no está habilitada en este servidor.',
  credencial_invalida: 'El usuario o la clave no tienen un formato válido. Cópialos de nuevo, sin espacios.',
  send_credencial_rechazada: 'Archie Send rechazó esa clave. Revisa que el usuario y la clave sean los correctos y que la clave no haya vencido.',
  send_sin_permiso: 'La clave funciona, pero no tiene permiso para leer listas. Crea la clave con un rol que pueda consultar.',
  send_no_disponible: 'No pudimos comunicarnos con Archie Send. Inténtalo en unos minutos.',
  send_tiempo_agotado: 'Archie Send tardó demasiado en responder. Inténtalo de nuevo.',
  send_limite: 'Archie Send pidió esperar un momento. Inténtalo en un minuto.',
  send_respuesta_invalida: 'Archie Send respondió algo que no pudimos leer.',
  nombre_invalido: 'El nombre solo puede tener letras, números, espacios, punto, guion y guion bajo (máximo 60).',
  nombre_en_uso: 'Ya hay una conexión con ese nombre. Elige otro.',
  origen_invalido: 'Escribe solo la dirección del sitio con https, por ejemplo https://tuherramienta.com (sin ruta, sin puerto y sin IP).',
  demasiados_origenes: 'Llegaste al máximo de sitios autorizados. Quita uno para agregar otro.',
  demasiadas_claves: 'Llegaste al máximo de claves vigentes. Revoca una para crear otra.',
  demasiadas_cuentas: 'Llegaste al máximo de cuentas publicitarias conectadas. Desconecta una para agregar otra.',
  demasiadas_tiendas: 'Llegaste al máximo de tiendas conectadas. Desconecta una para agregar otra.',
  tienda_credencial_rechazada: 'La tienda rechazó esas credenciales. Revisa que sean las correctas, que no hayan vencido y que el permiso sea de lectura.',
  tienda_sin_permiso: 'Las credenciales funcionan, pero no tienen permiso de lectura sobre la tienda. Crea la clave con permiso de lectura.',
  tienda_no_encontrado: 'No encontramos la API en esa dirección. Revisa que sea la tienda correcta.',
  tienda_limite: 'La tienda pidió esperar un momento. Inténtalo en un minuto.',
  tienda_tiempo_agotado: 'La tienda tardó demasiado en responder. Inténtalo de nuevo.',
  tienda_no_disponible: 'No pudimos conectar con la tienda. Revisa la dirección e inténtalo en unos minutos.',
  tienda_respuesta_invalida: 'La tienda respondió algo que no pudimos leer. Revisa que la dirección sea la de la tienda.',
  pauta_credencial_rechazada: 'La plataforma rechazó ese token. Revisa que sea el correcto, que no haya vencido y que tenga permiso de lectura de anuncios.',
  pauta_sin_permiso: 'El token funciona, pero no tiene permiso de lectura sobre esa cuenta publicitaria. Revisa los permisos y que la cuenta esté asignada al token.',
  pauta_no_encontrado: 'La plataforma no encontró esa cuenta publicitaria. Revisa el número.',
  pauta_limite: 'La plataforma pidió esperar un momento. Inténtalo en un minuto.',
  pauta_tiempo_agotado: 'La plataforma tardó demasiado en responder. Inténtalo de nuevo.',
  pauta_no_disponible: 'No pudimos conectar con la plataforma. Inténtalo en unos minutos.',
  pauta_respuesta_invalida: 'La plataforma respondió algo que no pudimos leer. Revisa el número de la cuenta.',
  pauta_direccion_no_permitida: 'No se pudo conectar de forma segura con la plataforma.',
  tienda_direccion_no_permitida: 'Esa dirección no es válida o no está permitida.',
  suite_formato_invalido: 'La dirección o la clave no tienen un formato válido. Escribe solo el dominio público (por ejemplo talk.tuempresa.com), sin https, rutas ni puertos, y copia la clave sin espacios.',
  suite_credencial_rechazada: 'La herramienta rechazó esa clave. Revisa que sea la correcta, que no haya vencido y que sea de solo lectura.',
  suite_sin_permiso: 'La clave funciona, pero no tiene permiso de lectura en esa herramienta. Crea la clave con permiso de lectura.',
  suite_no_encontrado: 'No encontramos el conector de Archie AI en esa dirección. Revisa que sea la dirección correcta y que la herramienta ya lo ofrezca.',
  suite_limite: 'La herramienta pidió esperar un momento. Inténtalo en un minuto.',
  suite_tiempo_agotado: 'La herramienta tardó demasiado en responder. Inténtalo de nuevo.',
  suite_no_disponible: 'No pudimos conectar con la herramienta. Revisa la dirección e inténtalo en unos minutos.',
  suite_respuesta_invalida: 'La herramienta respondió algo que no pudimos leer. Revisa que la dirección sea la de esa herramienta.',
  suite_direccion_no_permitida: 'Esa dirección no es válida o no está permitida.',
  suite_producto_incorrecto: 'Esa dirección responde como otra herramienta de la suite. Revisa que sea la de este producto.',
  suite_contrato_no_soportado: 'Esa herramienta usa una versión del conector que Archie AI todavía no entiende. Avísanos para actualizarlo.',
};

export function mensajeError(e: unknown): string {
  if (e instanceof ErrorApi) return MENSAJES[e.codigo] ?? 'No pudimos completar la acción. Inténtalo de nuevo.';
  return 'No pudimos conectar con el servicio. Revisa tu conexión.';
}

/** Llamada a la API del mismo sitio (la cookie de sesión viaja sola; el JavaScript nunca la ve). */
export async function api<T = unknown>(metodo: 'GET' | 'POST', url: string, cuerpo?: object): Promise<T> {
  const r = await fetch(url, {
    method: metodo,
    credentials: 'same-origin',
    headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) {
    // Un administrador sin segundo factor solo puede activarlo: se le lleva a Seguridad.
    if (r.status === 403 && datos.error === '2fa_obligatoria' && location.pathname !== '/seguridad') location.assign('/seguridad');
    throw new ErrorApi(r.status, datos.error ?? 'error');
  }
  return datos as T;
}

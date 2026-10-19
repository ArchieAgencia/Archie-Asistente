export const NOMBRE_COOKIE = 'archie_sid';
/** Cookie del equipo (consola). Distinta de la del cliente: una sesión de cliente nunca abre la consola ni al revés. */
export const NOMBRE_COOKIE_OPERADOR = 'archie_op';

/** Lee una cookie del encabezado Cookie. Devuelve undefined si no está o está mal formada. */
export function leerCookie(cabecera: string | undefined, nombre: string): string | undefined {
  if (!cabecera) return undefined;
  for (const parte of cabecera.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nombre) {
      const v = parte.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{16,128}$/.test(v) ? v : undefined; // el token es base64url: cualquier otra cosa se descarta
    }
  }
  return undefined;
}

export function cookieSesion(token: string, segundos: number, seguro: boolean, nombre = NOMBRE_COOKIE): string {
  return [
    `${nombre}=${token}`, 'Path=/', `Max-Age=${segundos}`, 'HttpOnly', 'SameSite=Lax',
    ...(seguro ? ['Secure'] : []),
  ].join('; ');
}

export function cookieBorrar(seguro: boolean, nombre = NOMBRE_COOKIE): string {
  return [`${nombre}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', ...(seguro ? ['Secure'] : [])].join('; ');
}

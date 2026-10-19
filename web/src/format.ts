const ZONA = 'America/Bogota';
export const num = (n: number) => new Intl.NumberFormat('es-CO').format(n);
/** Acepta fechas completas o solo día (AAAA-MM-DD, que se toma al mediodía para que la zona horaria no la corra de día). */
export const fecha = (iso: string | Date) =>
  new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', timeZone: ZONA }).format(new Date(typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T17:00:00Z` : iso));
export const fechaHora = (iso: string | Date) =>
  new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ZONA }).format(new Date(iso));
export const diaCorto = (yyyyMmDd: string) => new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${yyyyMmDd}T12:00:00Z`));
export const ETIQUETA_ESTADO: Record<string, string> = { activo: 'Activo', prueba: 'Prueba', suspendido: 'Suspendido', baja: 'Baja', sin_saldo: 'Sin saldo' };
export const ETIQUETA_AUTONOMIA: Record<string, string> = { lectura: 'Solo leer', borradores: 'Leer y preparar borradores', confirmacion: 'Actuar con confirmación' };
export const ETIQUETA_MODO: Record<string, string> = { autoservicio: 'Autoservicio', gestionada: 'Gestionada por Archie Tech' };
/** Planes provisionales (deben coincidir con la tabla `planes`). Pendiente: leerlos de la API. */
export const ETIQUETA_ROL_OP: Record<string, string> = { admin: 'Administración', soporte: 'Soporte', finanzas: 'Finanzas' };

/** Dólares estimados a partir de millonésimas de dólar. */
export const usd = (micro: number) => `US$ ${new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(micro / 1_000_000)}`;
/** Mes actual en Bogotá como AAAA-MM. */
export const mesActual = () => new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 7);
export const ETIQUETA_CONECTOR: Record<string, string> = {
  send: 'Archie Send', tienda_woocommerce: 'Tienda WooCommerce', tienda_shopify: 'Tienda Shopify', tienda_vtex: 'Tienda VTEX',
  pauta_meta: 'Meta Ads', pauta_tiktok: 'TikTok Ads', suite_talk: 'Archie Talk', suite_meet: 'Archie Meet', suite_booking: 'Archie Booking',
};

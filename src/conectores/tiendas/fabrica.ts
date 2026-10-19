import type { HttpSeguro } from '../http-seguro.js';
import { AdaptadorShopify } from './shopify.js';
import { AdaptadorVtex } from './vtex.js';
import { AdaptadorWooCommerce } from './woocommerce.js';
import { ErrorTienda, type AdaptadorTienda, type Plataforma } from './tipos.js';

/** Credenciales tal como se guardan (cifradas) por plataforma. Siempre se validan al crear el adaptador. */
export type CredencialTienda =
  | { plataforma: 'woocommerce'; dominio: string; clave: string; secreto: string }
  | { plataforma: 'shopify'; tienda: string; token: string }
  | { plataforma: 'vtex'; cuenta: string; appKey: string; appToken: string };

export function crearAdaptador(cred: CredencialTienda, http: HttpSeguro): AdaptadorTienda {
  switch (cred.plataforma) {
    case 'woocommerce': return new AdaptadorWooCommerce(http, cred);
    case 'shopify': return new AdaptadorShopify(http, cred);
    case 'vtex': return new AdaptadorVtex(http, cred);
    default: throw new ErrorTienda('no_soportado');
  }
}

export const esPlataforma = (v: unknown): v is Plataforma => v === 'woocommerce' || v === 'shopify' || v === 'vtex';

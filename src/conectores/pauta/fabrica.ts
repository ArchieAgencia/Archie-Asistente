import type { HttpSeguro } from '../http-seguro.js';
import { AdaptadorMeta } from './meta.js';
import { AdaptadorTiktok } from './tiktok.js';
import { ErrorPauta, type AdaptadorPauta, type PlataformaPauta } from './tipos.js';

export type CredencialPauta =
  | { plataforma: 'meta'; cuenta: string; token: string }
  | { plataforma: 'tiktok'; anunciante: string; token: string };

export function crearAdaptadorPauta(cred: CredencialPauta, http: HttpSeguro): AdaptadorPauta {
  switch (cred.plataforma) {
    case 'meta': return new AdaptadorMeta(http, cred);
    case 'tiktok': return new AdaptadorTiktok(http, cred);
    default: throw new ErrorPauta('no_soportado');
  }
}
export const esPlataformaPauta = (v: unknown): v is PlataformaPauta => v === 'meta' || v === 'tiktok';

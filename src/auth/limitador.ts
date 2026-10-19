/**
 * Limitador de frecuencia en memoria (ventana deslizante). Suficiente para una sola instancia.
 * Si Archie se escala a varias instancias, hay que moverlo a PostgreSQL o Redis.
 */
export class Limitador {
  private readonly golpes = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly ventanaMs: number, private readonly maxClaves = 10_000) {}

  /** Registra un intento. Devuelve false si ya superó el límite en la ventana. */
  permitir(clave: string, ahora = Date.now()): boolean {
    const desde = ahora - this.ventanaMs;
    const lista = (this.golpes.get(clave) ?? []).filter((t) => t > desde);
    if (lista.length >= this.max) {
      this.golpes.set(clave, lista);
      return false;
    }
    lista.push(ahora);
    this.golpes.set(clave, lista);
    if (this.golpes.size > this.maxClaves) this.purgar(desde);
    return true;
  }

  private purgar(desde: number): void {
    for (const [k, v] of this.golpes) if (!v.some((t) => t > desde)) this.golpes.delete(k);
    // Si aun así hay demasiadas claves (ataque con muchas claves distintas), se descartan las más antiguas.
    while (this.golpes.size > this.maxClaves) this.golpes.delete(this.golpes.keys().next().value as string);
  }
}

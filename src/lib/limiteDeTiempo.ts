/**
 * ActivaUC · límite de tiempo para una espera que puede no volver
 * ---------------------------------------------------------------------
 * Una promesa que nunca se resuelve no lanza ningún error: deja la
 * interfaz esperando para siempre. Pasó al volver del consentimiento de
 * Google: la consulta del estado de la conexión se quedó colgada y la
 * insignia se quedó en «Consultando…» hasta recargar la página, aunque
 * la conexión había funcionado.
 *
 * `try/catch` no cubre ese caso, porque no hay nada que capturar. Hace
 * falta decidir que, pasado un tiempo, se deja de esperar.
 *
 * Esto no cancela la operación de fondo —no se puede, sin que quien la
 * hizo la cancele— pero sí libera a quien esperaba, de modo que la
 * interfaz pueda decir «no obtuve respuesta» y ofrecer reintentar, que
 * es información verdadera, en lugar de fingir que sigue cargando.
 */

export class TiempoExcedidoError extends Error {
  readonly ms: number;

  constructor(queEra: string, ms: number) {
    super(`No obtuvimos respuesta al ${queEra} (más de ${Math.round(ms / 1000)} s).`);
    this.name = "TiempoExcedidoError";
    this.ms = ms;
  }
}

/**
 * Devuelve lo que devuelva `promesa`, o lanza `TiempoExcedidoError` si
 * tarda más de `ms`.
 *
 * `queEra` completa el mensaje: «No obtuvimos respuesta al consultar tu
 * conexión…», así que se escribe en infinitivo y sin mayúscula.
 */
export function conLimiteDeTiempo<T>(
  promesa: Promise<T>,
  ms: number,
  queEra: string,
): Promise<T> {
  // El temporizador se limpia en los dos caminos: si no, una espera que
  // sí respondió dejaría el proceso vivo en Node y un temporizador
  // suelto en el navegador.
  let id: ReturnType<typeof setTimeout> | undefined;

  const reloj = new Promise<never>((_, rechazar) => {
    id = setTimeout(() => rechazar(new TiempoExcedidoError(queEra, ms)), ms);
  });

  return Promise.race([promesa, reloj]).finally(() => {
    if (id !== undefined) clearTimeout(id);
  }) as Promise<T>;
}

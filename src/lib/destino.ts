/**
 * ActivaUC · a dónde volver después de iniciar sesión
 * ---------------------------------------------------------------------
 * La consulta de disponibilidad es pública: se puede mirar el catálogo
 * sin cuenta, y la sesión se pide recién al apretar «Reservar». Para que
 * eso no se sienta como un castigo, la persona tiene que volver al
 * bloque que había elegido, y no a una lista donde buscarlo de nuevo.
 *
 * Ese destino viaja en el estado de navegación y atraviesa varias
 * pantallas —inicio de sesión, registro, código de confirmación—, así
 * que conviene tener un solo sitio donde se decida si es aceptable.
 *
 * Sólo se aceptan rutas internas. Una ruta que empiece por `//` o por
 * `/\` la resuelve el navegador como otro sitio (`//ejemplo.com`), de
 * modo que se descarta aunque hoy el valor sólo lo escriba la propia
 * aplicación: el día que llegue de un enlace compartido, el filtro ya
 * está puesto.
 */

/** Ruta a la que se vuelve cuando no hay un destino que respetar. */
export const DESTINO_POR_OMISION = "/catalogo";

/** Devuelve el destino si es una ruta interna; si no, el de omisión. */
export function destinoSeguro(
  valor: unknown,
  porOmision: string = DESTINO_POR_OMISION,
): string {
  if (typeof valor !== "string") return porOmision;

  const ruta = valor.trim();
  if (!ruta.startsWith("/")) return porOmision;
  if (ruta.startsWith("//") || ruta.startsWith("/\\")) return porOmision;

  return ruta;
}

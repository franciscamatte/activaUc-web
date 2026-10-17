/**
 * Código de verificación de correo (REQ-5, REQ-6).
 *
 * La longitud NO es fija: Supabase la configura por proyecto, entre 6 y
 * 10 dígitos (Authentication → Providers → Email → Email OTP Length).
 * Dar por hecho que son 6 fue un error real: el proyecto estaba en 8 y
 * la interfaz rechazaba códigos válidos antes de consultar al servidor,
 * con un mensaje que además culpaba a la persona por poner espacios.
 *
 * Así que aquí sólo se comprueba lo que se puede afirmar sin conocer la
 * configuración: que haya dígitos y que la cantidad esté en el rango que
 * Supabase admite. Quién decide si el código es correcto es el servidor.
 */

export const CODIGO_MIN = 6;
export const CODIGO_MAX = 10;

/** Deja sólo los dígitos: la gente pega el código con espacios. */
export function normalizarCodigo(entrada: string): string {
  return entrada.replace(/\D/g, "");
}

export function codigoTieneFormato(entrada: string): boolean {
  const limpio = normalizarCodigo(entrada);
  return limpio.length >= CODIGO_MIN && limpio.length <= CODIGO_MAX;
}

/** Mensaje único, para que cliente y repositorios no divergan. */
export const MENSAJE_CODIGO_INVALIDO =
  `El código son entre ${CODIGO_MIN} y ${CODIGO_MAX} dígitos. ` +
  "Cópialo del correo tal como aparece.";

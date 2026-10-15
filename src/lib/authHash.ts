/**
 * Lectura del fragmento (#) que dejan los enlaces de Supabase Auth.
 *
 * Supabase devuelve el resultado de confirmar un correo o de un enlace
 * de recuperación en el fragmento de la URL. Se lee una sola vez, de
 * forma sincrónica, para poder derivar el estado durante el render en
 * lugar de hacerlo dentro de un efecto.
 */

export interface ResultadoEnlaceAuth {
  /** Código de error que entregó Supabase, si hubo alguno. */
  codigo: string | null;
  /** Mensaje de error en bruto (en inglés) de Supabase. */
  descripcion: string | null;
  hayError: boolean;
}

export function leerResultadoEnlace(): ResultadoEnlaceAuth {
  if (typeof window === "undefined") {
    return { codigo: null, descripcion: null, hayError: false };
  }

  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const codigo = hash.get("error_code");
  const descripcion = hash.get("error_description");

  return {
    codigo,
    descripcion,
    hayError: Boolean(codigo || descripcion),
  };
}

/**
 * Limpia el fragmento de la URL para que los tokens no queden visibles
 * ni en el historial del navegador. Es un efecto secundario sobre el
 * DOM, no un cambio de estado de React.
 */
export function limpiarFragmento(): void {
  if (typeof window === "undefined") return;
  if (!window.location.hash) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

/** Mensaje en español para el resultado de un enlace de confirmación. */
export function mensajeEnlaceConfirmacion(resultado: ResultadoEnlaceAuth): string | null {
  if (!resultado.hayError) return null;
  return resultado.codigo === "otp_expired"
    ? "El enlace de confirmación caducó. Solicita uno nuevo desde la pantalla de ingreso."
    : "El enlace de confirmación no es válido o ya fue utilizado.";
}

/** Mensaje en español para el resultado de un enlace de recuperación. */
export function mensajeEnlaceRecuperacion(resultado: ResultadoEnlaceAuth): string | null {
  if (!resultado.hayError) return null;
  return resultado.codigo === "otp_expired"
    ? "El enlace de recuperación caducó. Solicita uno nuevo."
    : "El enlace de recuperación no es válido o ya fue utilizado. Solicita uno nuevo.";
}

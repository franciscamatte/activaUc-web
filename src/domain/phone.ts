/**
 * Validación de teléfonos en formato E.164.
 *
 * El mismo patrón está replicado en tres capas, a propósito:
 *   · PostgreSQL  → restricción CHECK de profiles.phone
 *   · Edge Function → supabase/functions/_shared/phone.ts
 *   · Frontend    → este archivo
 *
 * El frontend valida sólo para dar retroalimentación inmediata; la
 * validación que cuenta es la del backend.
 */

export const PATRON_E164 = /^\+[1-9]\d{7,14}$/;

/** Deja únicamente `+` y dígitos. */
export function normalizarTelefono(valor: string): string {
  return (valor ?? "").replace(/[^0-9+]/g, "");
}

export function esE164(valor: string): boolean {
  return PATRON_E164.test(normalizarTelefono(valor));
}

/**
 * Mensaje de ayuda para el usuario, en español y específico según el
 * problema detectado.
 */
export function validarTelefono(valor: string): string | null {
  const limpio = normalizarTelefono(valor);

  if (limpio === "") {
    return "Ingresa un número de teléfono.";
  }
  if (!limpio.startsWith("+")) {
    return "El número debe comenzar con el código de país, por ejemplo +56 para Chile.";
  }
  if (limpio.length < 9) {
    return "El número es demasiado corto. Formato esperado: +56912345678.";
  }
  if (limpio.length > 16) {
    return "El número es demasiado largo. Formato esperado: +56912345678.";
  }
  if (!PATRON_E164.test(limpio)) {
    return "Usa el formato internacional sin espacios ni guiones, por ejemplo +56912345678.";
  }
  return null;
}

/** Oculta el número dejando visibles sólo los últimos 4 dígitos. */
export function enmascararTelefono(valor: string | null): string {
  if (!valor) return "sin número registrado";
  return `••• ••• ${valor.slice(-4)}`;
}

/**
 * Validación y normalización de números en formato E.164.
 *
 * El mismo patrón se replica en la restricción CHECK de las tablas
 * public.profiles y public.whatsapp_messages, y en el frontend
 * (src/domain/phone.ts), de modo que las tres capas coinciden.
 */

export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Quita espacios, guiones y paréntesis dejando sólo `+` y dígitos. */
export function normalizePhone(input: string): string {
  return (input ?? "").replace(/[^0-9+]/g, "");
}

export function isE164(input: string): boolean {
  return E164_PATTERN.test(normalizePhone(input));
}

/** Destinatario de WhatsApp tal como lo espera la API de Twilio. */
export function toWhatsAppAddress(phone: string): string {
  const clean = normalizePhone(phone);
  if (!isE164(clean)) {
    throw new Error("El número de destino no está en formato E.164.");
  }
  return `whatsapp:${clean}`;
}

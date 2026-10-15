/**
 * Lectura estricta de variables de entorno para las Edge Functions.
 *
 * Nunca se imprime el valor de un secreto: si falta, el error menciona
 * únicamente el nombre de la variable.
 */

export class ConfigError extends Error {
  constructor(name: string) {
    super(`Falta la variable de entorno requerida: ${name}`);
    this.name = "ConfigError";
  }
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.trim() === "") {
    throw new ConfigError(name);
  }
  return value.trim();
}

export function optionalEnv(name: string, fallback = ""): string {
  return Deno.env.get(name)?.trim() || fallback;
}

/** Comprueba la presencia de un grupo de variables sin revelar valores. */
export function missingEnv(names: readonly string[]): string[] {
  return names.filter((name) => !Deno.env.get(name)?.trim());
}

export const SUPABASE_URL_VAR = "SUPABASE_URL";
export const SERVICE_ROLE_VAR = "SUPABASE_SERVICE_ROLE_KEY";

export const GOOGLE_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "ENCRYPTION_KEY",
] as const;

export const TWILIO_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
] as const;

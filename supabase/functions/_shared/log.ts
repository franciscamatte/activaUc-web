/**
 * Registro estructurado con redacción obligatoria.
 *
 * Reglas (ver docs/SEGURIDAD.md):
 *   · Nunca se registran tokens, claves, firmas ni cuerpos completos.
 *   · Los teléfonos se reducen a sus últimos 4 dígitos.
 *   · Los correos se reducen al dominio.
 */

const SENSITIVE_KEY = /(token|secret|password|authorization|signature|key|credential|code)/i;

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "sin-telefono";
  return `***${phone.slice(-4)}`;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "sin-correo";
  return `***@${email.split("@")[1]}`;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[profundidad-maxima]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[redactado]";
      } else if (/phone|telefono|to\b/i.test(key) && typeof raw === "string") {
        out[key] = maskPhone(raw);
      } else if (/email|correo/i.test(key) && typeof raw === "string") {
        out[key] = maskEmail(raw);
      } else {
        out[key] = redact(raw, depth + 1);
      }
    }
    return out;
  }
  return "[no-serializable]";
}

type Level = "info" | "warn" | "error";

function emit(level: Level, fn: string, message: string, context?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    fn,
    message,
    ...(context ? { context: redact(context) as Record<string, unknown> } : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(fn: string) {
  return {
    info: (message: string, context?: Record<string, unknown>) => emit("info", fn, message, context),
    warn: (message: string, context?: Record<string, unknown>) => emit("warn", fn, message, context),
    error: (message: string, context?: Record<string, unknown>) => emit("error", fn, message, context),
  };
}

/** Mensaje de error seguro: nunca propaga cuerpos de respuesta completos. */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  if (typeof error === "string") return error.slice(0, 300);
  return "Error desconocido";
}

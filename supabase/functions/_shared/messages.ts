/**
 * Plantillas de mensajes de WhatsApp, íntegramente en español.
 *
 * En producción con WhatsApp Business los mensajes salientes iniciados
 * por la plataforma deben usar una plantilla aprobada. Por eso cada tipo
 * de mensaje puede resolverse de dos maneras:
 *
 *   1. ContentSid aprobado (TWILIO_CONTENT_SID_CONFIRMACION, …) junto con
 *      las variables numeradas de la plantilla. Es el camino de producción.
 *   2. Cuerpo de texto plano, válido en el Sandbox de Twilio y durante la
 *      ventana de 24 horas de servicio al cliente.
 *
 * El texto y el orden de las variables deben coincidir exactamente con la
 * plantilla registrada en Twilio (ver docs/CONFIGURACION_TWILIO_WHATSAPP.md).
 */

export type NotificationKind = "confirmacion" | "recordatorio" | "cancelacion_admin";

export interface MessageContext {
  nombre: string;
  recinto: string;
  fechaHora: string;
  motivo?: string | null;
}

/** Fecha y hora legibles en español de Chile. */
export function formatSpanishDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es-CL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    // Formato de 24 horas: "18:00" es inequívoco, mientras que
    // "06:00 p. m." se lee mal en un mensaje corto.
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

export function buildBody(kind: NotificationKind, ctx: MessageContext): string {
  switch (kind) {
    case "confirmacion":
      return `Hola ${ctx.nombre}: tu reserva en ${ctx.recinto} quedó confirmada para el ${ctx.fechaHora}. ` +
        `Puedes revisarla o cancelarla en ActivaUC (hasta 2 horas antes del inicio).`;
    case "recordatorio":
      return `Hola ${ctx.nombre}: te recordamos tu reserva en ${ctx.recinto} hoy a las ${ctx.fechaHora}. ` +
        `¡Te esperamos en Deportes UC!`;
    case "cancelacion_admin":
      return `Hola ${ctx.nombre}: lamentamos informarte que tu reserva en ${ctx.recinto} del ${ctx.fechaHora} ` +
        `fue cancelada por la administración del recinto` +
        (ctx.motivo ? ` (motivo: ${ctx.motivo})` : "") +
        `. Puedes reservar otro bloque disponible en ActivaUC.`;
  }
}

/** Variables numeradas que espera la plantilla aprobada equivalente. */
export function buildContentVariables(
  kind: NotificationKind,
  ctx: MessageContext,
): Record<string, string> {
  const base: Record<string, string> = {
    "1": ctx.nombre,
    "2": ctx.recinto,
    "3": ctx.fechaHora,
  };
  if (kind === "cancelacion_admin") {
    base["4"] = ctx.motivo ?? "mantención del recinto";
  }
  return base;
}

/** Nombre de la variable de entorno con el ContentSid de cada plantilla. */
export function contentSidEnvVar(kind: NotificationKind): string {
  switch (kind) {
    case "confirmacion":
      return "TWILIO_CONTENT_SID_CONFIRMACION";
    case "recordatorio":
      return "TWILIO_CONTENT_SID_RECORDATORIO";
    case "cancelacion_admin":
      return "TWILIO_CONTENT_SID_CANCELACION";
  }
}

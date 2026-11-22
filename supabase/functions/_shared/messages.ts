/**
 * Textos de las notificaciones de ActivaUC, íntegramente en español.
 *
 * Un solo sitio donde se decide qué dice la plataforma en cada aviso:
 * `buildBody` da el texto, `buildSubject` el asunto y `buildEmailHtml`
 * la envoltura mínima del correo. Tenerlo junto evita que el asunto
 * prometa una cosa y el cuerpo diga otra.
 */

export type NotificationKind =
  | "confirmacion"
  | "recordatorio"
  | "cancelacion_admin"
  /** Aviso de que se liberó un cupo en un bloque que estaba lleno. */
  | "cupo_liberado";

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
    case "cupo_liberado":
      // Se dice explícitamente que no está reservado: el aviso avisa, no
      // guarda el cupo, y prometer lo contrario sería engañoso.
      return `Hola ${ctx.nombre}: se liberó un cupo en ${ctx.recinto} para el ${ctx.fechaHora}. ` +
        `Todavía no es tuyo: entra a ActivaUC y resérvalo, lo toma quien reserve primero.`;
  }
}

// =====================================================================
// Envoltura del correo
// ---------------------------------------------------------------------
// El texto de `buildBody` es el mismo que se registra en la bitácora:
// una sola fuente de verdad para lo que dice la plataforma. Lo que añade
// el correo es el asunto y una envoltura HTML mínima.
// =====================================================================

export function buildSubject(kind: NotificationKind, ctx: MessageContext): string {
  switch (kind) {
    case "confirmacion":
      return `Reserva confirmada · ${ctx.recinto}`;
    case "recordatorio":
      return `Recordatorio · tu reserva en ${ctx.recinto} es hoy`;
    case "cancelacion_admin":
      return `Reserva cancelada · ${ctx.recinto}`;
    case "cupo_liberado":
      return `Se liberó un cupo · ${ctx.recinto}`;
  }
}

/** Escapa lo que vaya a quedar dentro del HTML del correo. */
function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Cuerpo HTML del correo.
 *
 * Deliberadamente sobrio: estilos en línea y nada de imágenes ni
 * scripts, que es lo que sobrevive a los clientes de correo y lo que
 * menos probabilidades tiene de acabar marcado como sospechoso.
 */
export function buildEmailHtml(
  kind: NotificationKind,
  ctx: MessageContext,
  urlAplicacion?: string | null,
): string {
  const cuerpo = escaparHtml(buildBody(kind, ctx));
  const enlace = (urlAplicacion ?? "").trim();

  const boton = enlace
    ? `<p style="margin:24px 0 0">
         <a href="${escaparHtml(enlace)}/mis-reservas"
            style="display:inline-block;padding:10px 18px;border-radius:8px;
                   background:#065f46;color:#ffffff;text-decoration:none;
                   font-family:system-ui,sans-serif;font-size:14px">
           Ver mis reservas
         </a>
       </p>`
    : "";

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;
                      max-width:520px;color:#0f172a;line-height:1.55">
  <p style="margin:0 0 4px;font-size:13px;color:#64748b">Deportes UC · ActivaUC</p>
  <p style="margin:0;font-size:16px">${cuerpo}</p>
  ${boton}
  <hr style="margin:28px 0 12px;border:none;border-top:1px solid #e2e8f0">
  <p style="margin:0;font-size:12px;color:#64748b">
    Recibes este correo porque activaste los avisos de tus reservas en
    ActivaUC. Puedes desactivarlos en «Datos personales».
  </p>
</div>`;
}

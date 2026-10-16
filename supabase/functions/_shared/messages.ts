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

/** Campos del contexto que pueden ocupar una variable de la plantilla. */
export const CAMPOS_PLANTILLA = ["nombre", "recinto", "fechaHora", "motivo"] as const;
export type CampoPlantilla = typeof CAMPOS_PLANTILLA[number];

/** Palabras que indican que la plantilla no lleva ninguna variable. */
const SIN_VARIABLES = new Set(["ninguna", "ninguno", "none", "sin"]);

/** Orden de variables por omisión de cada tipo de mensaje. */
function ordenPorOmision(kind: NotificationKind): CampoPlantilla[] {
  const base: CampoPlantilla[] = ["nombre", "recinto", "fechaHora"];
  return kind === "cancelacion_admin" ? [...base, "motivo"] : base;
}

function valorDeCampo(campo: CampoPlantilla, ctx: MessageContext): string {
  switch (campo) {
    case "nombre":
      return ctx.nombre;
    case "recinto":
      return ctx.recinto;
    case "fechaHora":
      return ctx.fechaHora;
    case "motivo":
      return ctx.motivo ?? "mantención del recinto";
  }
}

/**
 * Variables numeradas que espera la plantilla aprobada equivalente.
 *
 * `orden` permite adaptarse a la plantilla sin tocar el código, que hace
 * falta por dos motivos reales:
 *
 *   · Las plantillas de muestra de Twilio (las únicas disponibles en una
 *     cuenta Trial) traen el texto fijo y no aceptan variable alguna;
 *     enviarles tres provoca un 63028.
 *   · Una plantilla aprobada por Meta puede quedar con las variables en
 *     otro orden que el de docs/CONFIGURACION_TWILIO_WHATSAPP.md § 4.
 *
 * Formatos aceptados:
 *   · vacío o ausente → el orden por omisión del tipo de mensaje.
 *   · «ninguna» → sin variables (devuelve null).
 *   · «recinto,nombre,fechaHora» → ese orden exacto.
 *
 * Un nombre de campo desconocido lanza: es un error de configuración, y
 * es mejor que el trabajo falle con un mensaje claro que enviar un
 * mensaje con los datos en el lugar equivocado.
 */
export function buildContentVariables(
  kind: NotificationKind,
  ctx: MessageContext,
  orden?: string | null,
): Record<string, string> | null {
  const crudo = (orden ?? "").trim();

  if (crudo && SIN_VARIABLES.has(crudo.toLowerCase())) {
    return null;
  }

  const campos: CampoPlantilla[] = crudo
    ? crudo.split(",").map((parte) => {
      const campo = parte.trim();
      if (!(CAMPOS_PLANTILLA as readonly string[]).includes(campo)) {
        throw new Error(
          `Campo de plantilla desconocido: «${campo}». Admitidos: ` +
            `${CAMPOS_PLANTILLA.join(", ")}, o «ninguna» para una plantilla sin variables.`,
        );
      }
      return campo as CampoPlantilla;
    })
    : ordenPorOmision(kind);

  if (campos.length === 0) return null;

  const vars: Record<string, string> = {};
  campos.forEach((campo, i) => {
    vars[String(i + 1)] = valorDeCampo(campo, ctx);
  });
  return vars;
}

/** Nombre de la variable de entorno con el orden de variables. */
export function contentVarsEnvVar(kind: NotificationKind): string {
  switch (kind) {
    case "confirmacion":
      return "TWILIO_CONTENT_VARS_CONFIRMACION";
    case "recordatorio":
      return "TWILIO_CONTENT_VARS_RECORDATORIO";
    case "cancelacion_admin":
      return "TWILIO_CONTENT_VARS_CANCELACION";
  }
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

// =====================================================================
// Canal de correo
// ---------------------------------------------------------------------
// El texto es el mismo que va por WhatsApp: una sola fuente de verdad
// para lo que dice la plataforma. Lo que añade el correo es asunto y
// una envoltura HTML mínima.
// =====================================================================

export function buildSubject(kind: NotificationKind, ctx: MessageContext): string {
  switch (kind) {
    case "confirmacion":
      return `Reserva confirmada · ${ctx.recinto}`;
    case "recordatorio":
      return `Recordatorio · tu reserva en ${ctx.recinto} es hoy`;
    case "cancelacion_admin":
      return `Reserva cancelada · ${ctx.recinto}`;
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

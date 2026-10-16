/**
 * Envío de correo por la API de Twilio (`comms.twilio.com/v1/Emails`).
 *
 * Es el canal alternativo a WhatsApp para las notificaciones de reserva
 * (REQ-24 a REQ-26). Dos diferencias con WhatsApp que condicionan el
 * diseño:
 *
 *   · En cuenta Trial el contenido NO es libre: tiene que coincidir
 *     exactamente con una de las plantillas de muestra de Twilio, o
 *     responde 400 «Invalid template: email content does not match any
 *     approved template». El worker lo sortea con
 *     TWILIO_EMAIL_ASUNTO_FIJO y TWILIO_EMAIL_HTML_FIJO, que permiten
 *     fijar ese contenido para ejercer la cadena; al salir de Trial se
 *     vacían y pasan a enviarse los textos de ActivaUC.
 *   · La API es asíncrona. No devuelve el identificador de un mensaje,
 *     sino un `operationId` de la operación encolada, y no hay webhook
 *     de estados: se sabe que Twilio lo aceptó, no que se entregó. El
 *     `operationId` se guarda como identificador del proveedor, que es
 *     lo que permite seguir el envío en la consola de Twilio.
 *
 * El remitente en el plan de prueba es fijo, `<AccountSid>@twilio.email`,
 * un dominio que no controlamos. Para producción hay que verificar un
 * dominio propio en Twilio y fijarlo en TWILIO_EMAIL_FROM: un correo
 * desde un dominio ajeno llega mal a destinatarios institucionales (ver
 * docs/CONFIGURACION_CORREO.md).
 */

export class TwilioEmailError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "TwilioEmailError";
    this.status = status;
    this.code = code;
    // Igual que en WhatsApp: 429 y 5xx son transitorios, un 4xx es un
    // problema de la solicitud o del plan y no mejora reintentando.
    this.retryable = status === 429 || status === 408 || status >= 500;
  }
}

export interface SendEmailParams {
  accountSid: string;
  authToken: string;
  /** Dirección del remitente; por omisión la del Sandbox de la cuenta. */
  from?: string | null;
  fromName?: string | null;
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  /** `operationId` de Twilio: lo más parecido a un id de mensaje que hay. */
  operationId: string;
}

/** Remitente del plan de prueba, derivado del propio Account SID. */
export function defaultEmailSender(accountSid: string): string {
  return `${accountSid}@twilio.email`;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const cuerpo = {
    from: {
      address: params.from?.trim() || defaultEmailSender(params.accountSid),
      name: params.fromName?.trim() || "ActivaUC",
    },
    to: [{ address: params.to.trim() }],
    content: {
      subject: params.subject,
      html: params.html,
    },
  };

  const response = await fetch("https://comms.twilio.com/v1/Emails", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${params.accountSid}:${params.authToken}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cuerpo),
  });

  const texto = await response.text();

  if (!response.ok) {
    let code: string | null = null;
    let mensaje = `Twilio Email respondió HTTP ${response.status}.`;
    try {
      const leido = JSON.parse(texto) as { code?: number; message?: string };
      code = leido.code ? String(leido.code) : null;
      if (leido.message) mensaje = leido.message.slice(0, 300);
    } catch {
      // Se mantiene el mensaje genérico: el cuerpo no era JSON.
    }
    throw new TwilioEmailError(response.status, code, mensaje);
  }

  const leido = JSON.parse(texto) as { operationId?: string };
  if (!leido.operationId) {
    // Sin identificador no hay forma de registrar el envío de manera
    // idempotente, así que se trata como fallo reintentable.
    throw new TwilioEmailError(
      response.status,
      null,
      "Twilio Email aceptó la solicitud pero no devolvió operationId.",
    );
  }

  return { operationId: leido.operationId };
}

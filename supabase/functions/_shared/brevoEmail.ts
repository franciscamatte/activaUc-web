/**
 * Envío de correo por la API transaccional de Brevo.
 *
 * Reemplaza a `twilioEmail.ts` como canal de notificaciones. El motivo
 * no es preferencia: en el plan de prueba de Twilio ese canal tiene dos
 * restricciones que lo dejan inservible con terceros, y las dos se
 * comprobaron contra la cuenta real:
 *
 *   · el contenido tiene que coincidir con una plantilla de muestra
 *     («Invalid template: email content does not match any approved
 *     template»), y
 *   · sólo entrega a destinatarios verificados en la cuenta
 *     (`574002 · The recipient email address is not verified for this
 *     trial`).
 *
 * Brevo no tiene ninguna de las dos en su plan gratuito: contenido
 * propio y 300 correos al día a quien sea. Y ya está configurado para
 * los correos de autenticación de Supabase, así que no añade una cuenta
 * más que mantener.
 *
 * Se usa la API HTTP y no SMTP a propósito: las Edge Functions no
 * pueden abrir conexiones salientes en los puertos de SMTP, cosa que
 * Brevo advierte en su propia documentación.
 *
 * Ojo con las dos claves de Brevo, que se confunden: aquí va la **API
 * key** (`xkeysib-…`), no la SMTP key que usa Supabase para sus correos.
 */

const ENDPOINT = "https://api.brevo.com/v3/smtp/email";

export class BrevoEmailError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "BrevoEmailError";
    this.status = status;
    this.code = code;
    // Igual que en los otros emisores: 429 y 5xx son transitorios; un
    // 4xx es un problema de la solicitud o del plan y no mejora
    // reintentando.
    this.retryable = status === 429 || status === 408 || status >= 500;
  }
}

export interface SendBrevoEmailParams {
  apiKey: string;
  from: string;
  fromName?: string | null;
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
}

export interface SendBrevoEmailResult {
  /** `messageId` de Brevo; se guarda como identificador del proveedor. */
  messageId: string;
}

export async function sendBrevoEmail(
  params: SendBrevoEmailParams,
): Promise<SendBrevoEmailResult> {
  // El nombre del remitente y del destinatario los limita Brevo a 70
  // caracteres. Se recortan aquí en lugar de dejar que lo rechace.
  const recortar = (texto: string) => texto.slice(0, 70);

  if (!params.apiKey.trim()) {
    throw new BrevoEmailError(0, null, "Falta BREVO_API_KEY.");
  }
  if (!params.from.trim()) {
    throw new BrevoEmailError(
      0,
      null,
      "Falta BREVO_EMAIL_FROM: debe ser un remitente verificado en Brevo.",
    );
  }

  const cuerpo: Record<string, unknown> = {
    sender: {
      email: params.from.trim(),
      name: recortar((params.fromName ?? "ActivaUC").trim() || "ActivaUC"),
    },
    to: [
      params.toName?.trim()
        ? { email: params.to.trim(), name: recortar(params.toName.trim()) }
        : { email: params.to.trim() },
    ],
    subject: params.subject,
    htmlContent: params.html,
  };

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "api-key": params.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(cuerpo),
  });

  const texto = await response.text();

  if (!response.ok) {
    let code: string | null = null;
    let mensaje = `Brevo respondió HTTP ${response.status}.`;
    try {
      const leido = JSON.parse(texto) as { code?: string; message?: string };
      if (leido.code) code = leido.code;
      if (leido.message) mensaje = leido.message.slice(0, 300);
    } catch {
      // El cuerpo no era JSON: se mantiene el mensaje genérico.
    }
    throw new BrevoEmailError(response.status, code, mensaje);
  }

  const leido = JSON.parse(texto) as { messageId?: string; messageIds?: string[] };
  const id = leido.messageId ?? leido.messageIds?.[0];
  if (!id) {
    // Brevo aceptó la petición, así que lo más probable es que el correo
    // haya salido; lo que falta es poder trazarlo. Por eso NO se
    // reintenta: un reintento mandaría un segundo correo a la misma
    // persona, y recibir el aviso dos veces es peor que perder la
    // trazabilidad de uno. El estado 2xx hace que `retryable` sea falso,
    // y aquí queda dicho que eso es intencional y no una casualidad.
    throw new BrevoEmailError(
      response.status,
      "sin_message_id",
      "Brevo aceptó el envío pero no devolvió messageId: el correo " +
        "probablemente salió, pero no queda trazado. No se reintenta " +
        "para no enviarlo dos veces.",
    );
  }

  return { messageId: id };
}

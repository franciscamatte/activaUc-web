/**
 * Cliente mínimo de la API de Twilio para WhatsApp Business.
 *
 * El navegador nunca habla con Twilio: estas credenciales existen sólo
 * como secretos de Edge Functions (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * TWILIO_WHATSAPP_FROM).
 */

import { hmacSha1Base64, timingSafeEqual } from "./crypto.ts";
import { toWhatsAppAddress } from "./phone.ts";

export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "TwilioApiError";
    this.status = status;
    this.code = code;
    // 429 y 5xx son transitorios. Un número inválido o sin WhatsApp
    // (21211, 21614, 63003, 63024) no mejora reintentando.
    const permanent = new Set(["21211", "21614", "21610", "63003", "63024", "21408"]);
    this.retryable = !(code && permanent.has(code)) &&
      (status === 429 || status === 408 || status >= 500);
  }
}

export interface SendWhatsAppParams {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
  contentSid?: string | null;
  contentVariables?: Record<string, string> | null;
  statusCallbackUrl?: string | null;
}

export interface SendWhatsAppResult {
  sid: string;
  status: string;
}

export async function sendWhatsApp(
  params: SendWhatsAppParams,
): Promise<SendWhatsAppResult> {
  const form = new URLSearchParams();
  form.set("To", toWhatsAppAddress(params.to));
  form.set("From", params.from.startsWith("whatsapp:") ? params.from : `whatsapp:${params.from}`);

  if (params.contentSid) {
    // Camino de producción: plantilla aprobada por Meta/WhatsApp.
    form.set("ContentSid", params.contentSid);
    if (params.contentVariables) {
      form.set("ContentVariables", JSON.stringify(params.contentVariables));
    }
  } else {
    // Sandbox o ventana de 24 h: cuerpo de texto libre.
    form.set("Body", params.body);
  }

  if (params.statusCallbackUrl) {
    form.set("StatusCallback", params.statusCallbackUrl);
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${params.accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${params.accountSid}:${params.authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );

  const text = await response.text();

  if (!response.ok) {
    let code: string | null = null;
    let message = `Twilio respondió HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(text) as { code?: number; message?: string };
      code = parsed.code ? String(parsed.code) : null;
      if (parsed.message) message = parsed.message.slice(0, 300);
    } catch { /* se mantiene el mensaje genérico */ }
    throw new TwilioApiError(response.status, code, message);
  }

  const parsed = JSON.parse(text) as { sid: string; status: string };
  return { sid: parsed.sid, status: parsed.status };
}

/**
 * Validación de la firma X-Twilio-Signature de un webhook con cuerpo
 * `application/x-www-form-urlencoded`.
 *
 * Algoritmo de Twilio: HMAC-SHA1 del URL completo concatenado con los
 * pares clave+valor ordenados alfabéticamente por clave, en base64.
 */
export async function isValidTwilioSignature(params: {
  authToken: string;
  url: string;
  formParams: Record<string, string>;
  signature: string | null;
}): Promise<boolean> {
  if (!params.signature) return false;

  const sortedKeys = Object.keys(params.formParams).sort();
  let data = params.url;
  for (const key of sortedKeys) {
    data += key + params.formParams[key];
  }

  const expected = await hmacSha1Base64(params.authToken, data);
  return timingSafeEqual(params.signature, expected);
}

/**
 * URL pública que Twilio firmó. Detrás de un proxy el host puede llegar
 * en x-forwarded-*, así que se reconstruye con esos encabezados y se
 * permite fijarla explícitamente con TWILIO_WEBHOOK_URL cuando haga falta.
 */
/**
 * URL contra el que Twilio calculó la firma.
 *
 * `override` es el camino normal, no la excepción: debe recibir el URL
 * que se registró como `StatusCallback`, porque es ése el que Twilio
 * firma. La reconstrucción a partir de la solicitud queda como último
 * recurso, y en una Edge Function de Supabase no basta por sí sola:
 * `request.url` llega sin el prefijo `/functions/v1`.
 */
export function webhookUrlForSignature(request: Request, override: string): string {
  if (override) return override;

  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) url.host = forwardedHost;
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  return url.toString();
}

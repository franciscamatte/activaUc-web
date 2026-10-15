/**
 * REQ-27 · Webhook de estados de mensaje de Twilio.
 *
 * Endpoint público (verify_jwt = false) porque lo llama Twilio, pero
 * nunca sin autenticar:
 *   1. Se valida la firma X-Twilio-Signature (HMAC-SHA1 con el Auth Token).
 *   2. register_webhook_event registra (provider, MessageSid, estado) con
 *      restricción única: una reentrega del mismo evento no vuelve a
 *      aplicarse (idempotencia y protección anti-replay).
 *   3. apply_whatsapp_status traduce el estado de Twilio al enum interno
 *      y nunca retrocede de "entregado" a un estado anterior.
 *
 * Responde 200 incluso cuando el evento es duplicado, para que Twilio no
 * reintente indefinidamente. Una firma inválida devuelve 403.
 */

import { isValidTwilioSignature, webhookUrlForSignature } from "../_shared/twilio.ts";
import { missingEnv, optionalEnv, requireEnv } from "../_shared/env.ts";
import { adminClient } from "../_shared/supabase.ts";
import { createLogger, safeErrorMessage } from "../_shared/log.ts";

const log = createLogger("twilio-status-webhook");

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return textResponse("Método no permitido", 405);
  }

  if (missingEnv(["TWILIO_AUTH_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"]).length > 0) {
    log.error("Configuración incompleta para el webhook");
    return textResponse("Webhook no configurado", 503);
  }

  let formParams: Record<string, string>;
  try {
    const form = await request.formData();
    formParams = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") formParams[key] = value;
    }
  } catch (cause) {
    log.warn("Cuerpo no interpretable", { detalle: safeErrorMessage(cause) });
    return textResponse("Cuerpo inválido", 400);
  }

  // 1) Firma. Sin firma válida no se procesa nada.
  const valid = await isValidTwilioSignature({
    authToken: requireEnv("TWILIO_AUTH_TOKEN"),
    url: webhookUrlForSignature(request, optionalEnv("TWILIO_WEBHOOK_URL")),
    formParams,
    signature: request.headers.get("X-Twilio-Signature"),
  });

  if (!valid) {
    log.warn("Firma de Twilio inválida: solicitud descartada", {
      sid_presente: Boolean(formParams.MessageSid),
    });
    return textResponse("Firma inválida", 403);
  }

  const messageSid = formParams.MessageSid ?? formParams.SmsSid ?? "";
  const messageStatus = formParams.MessageStatus ?? formParams.SmsStatus ?? "";
  const errorCode = formParams.ErrorCode ?? null;

  if (!messageSid || !messageStatus) {
    return textResponse("Parámetros incompletos", 400);
  }

  const admin = adminClient();

  try {
    // 2) Idempotencia: sólo la primera llegada de este evento se aplica.
    const { data: isNew, error: registerError } = await admin.rpc("register_webhook_event", {
      _provider: "twilio",
      _external_id: messageSid,
      _event_type: messageStatus,
      _signature_valid: true,
      _payload: {
        MessageStatus: messageStatus,
        ErrorCode: errorCode,
        To: formParams.To ? `***${formParams.To.slice(-4)}` : null,
      },
    });

    if (registerError) {
      log.error("No se pudo registrar el evento", { detalle: registerError.message });
      return textResponse("Error interno", 500);
    }

    if (isNew === false) {
      log.info("Evento duplicado ignorado", { estado: messageStatus });
      return textResponse("Evento ya procesado", 200);
    }

    // 3) Aplicación del estado al mensaje.
    const { data: applied, error: applyError } = await admin.rpc("apply_whatsapp_status", {
      _provider_sid: messageSid,
      _status: messageStatus,
      _error_code: errorCode,
    });

    if (applyError) {
      log.error("No se pudo aplicar el estado", { detalle: applyError.message });
      return textResponse("Error interno", 500);
    }

    log.info("Estado actualizado", { estado: messageStatus, aplicado: applied === true });
    return textResponse("OK", 200);
  } catch (cause) {
    log.error("Fallo al procesar el webhook", { detalle: safeErrorMessage(cause) });
    return textResponse("Error interno", 500);
  }
});

/**
 * REQ-24, REQ-25, REQ-26, REQ-27 · Worker de WhatsApp (Twilio).
 *
 * El navegador nunca llama a Twilio. Este worker es el único punto de
 * salida y lo invoca `cron-dispatch` (pg_cron) con CRON_SECRET.
 *
 * Reglas aplicadas en el backend, no en la interfaz:
 *   · claim_notification_jobs sólo entrega trabajos de usuarios con
 *     consentimiento vigente y teléfono registrado.
 *   · Vuelve a validarse el formato E.164 antes de enviar; un número
 *     inválido se omite sin consumir reintentos.
 *   · Los recordatorios cuya reserva fue cancelada se descartan.
 *   · Reintentos con backoff exponencial y tope de intentos.
 *   · No se registran credenciales ni el teléfono completo.
 */

import { sendWhatsApp, TwilioApiError } from "../_shared/twilio.ts";
import { isE164, normalizePhone } from "../_shared/phone.ts";
import {
  buildBody,
  buildContentVariables,
  contentSidEnvVar,
  contentVarsEnvVar,
  formatSpanishDateTime,
  type NotificationKind,
} from "../_shared/messages.ts";
import { missingEnv, optionalEnv, requireEnv } from "../_shared/env.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { adminClient } from "../_shared/supabase.ts";
import { createLogger, maskPhone, safeErrorMessage } from "../_shared/log.ts";
import { assertWorkerAuthorized } from "../_shared/worker_auth.ts";

const log = createLogger("process-notification-jobs");
const DEFAULT_BATCH = 10;

interface ClaimedJob {
  job_id: string;
  reservation_id: string | null;
  user_id: string;
  kind: NotificationKind;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown> | null;
  to_phone: string | null;
  full_name: string | null;
  facility_name: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

Deno.serve(async (request) => {
  const pre = preflight(request);
  if (pre) return pre;

  const authError = assertWorkerAuthorized(request);
  if (authError) return fail(request, authError.code, authError.mensaje, authError.status);

  const faltantes = missingEnv([
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_WHATSAPP_FROM",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  if (faltantes.length > 0) {
    log.error("Configuración incompleta", { faltantes });
    return fail(
      request,
      "integracion_no_configurada",
      "Faltan secretos de Twilio en el servidor.",
      503,
    );
  }

  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const from = requireEnv("TWILIO_WHATSAPP_FROM");
  const statusCallbackUrl = optionalEnv("TWILIO_STATUS_CALLBACK_URL") || null;
  const timeZone = optionalEnv("APP_TIME_ZONE", "America/Santiago");

  const admin = adminClient();

  let batch = DEFAULT_BATCH;
  try {
    const body = await request.json() as { limit?: number };
    if (typeof body?.limit === "number") batch = Math.min(Math.max(body.limit, 1), 50);
  } catch { /* sin cuerpo: tamaño por defecto */ }

  const { data: jobs, error } = await admin.rpc("claim_notification_jobs", { _limit: batch });

  if (error) {
    log.error("No se pudieron reclamar notificaciones", { detalle: error.message });
    return fail(request, "error_interno", "No se pudieron reclamar notificaciones.", 500);
  }

  const claimed = (jobs ?? []) as ClaimedJob[];
  const resumen = { reclamados: claimed.length, enviados: 0, fallidos: 0, omitidos: 0 };

  for (const job of claimed) {
    const phone = normalizePhone(job.to_phone ?? "");

    // Doble verificación del número: la BD ya lo restringe, pero el
    // worker no confía en un único control (REQ: no enviar a inválidos).
    if (!isE164(phone)) {
      await admin.rpc("skip_notification_job", {
        _job_id: job.job_id,
        _reason: "Número de teléfono no válido en formato E.164.",
      });
      resumen.omitidos += 1;
      log.warn("Notificación omitida por teléfono inválido", { job_id: job.job_id });
      continue;
    }

    if (!job.starts_at || !job.facility_name) {
      await admin.rpc("skip_notification_job", {
        _job_id: job.job_id,
        _reason: "La reserva asociada ya no está disponible.",
      });
      resumen.omitidos += 1;
      continue;
    }

    const ctx = {
      nombre: (job.full_name ?? "deportista").split(" ")[0],
      recinto: job.facility_name,
      fechaHora: formatSpanishDateTime(job.starts_at, timeZone),
      motivo: typeof job.payload?.motivo === "string" ? job.payload.motivo : null,
    };

    const contentSid = optionalEnv(contentSidEnvVar(job.kind)) || null;
    // Un orden de variables mal escrito es un error de configuración: se
    // deja escapar para que el trabajo falle con el mensaje de la
    // excepción, en lugar de enviar los datos en el lugar equivocado.
    const contentVariables = contentSid
      ? buildContentVariables(job.kind, ctx, optionalEnv(contentVarsEnvVar(job.kind)) || null)
      : null;

    try {
      const result = await sendWhatsApp({
        accountSid,
        authToken,
        from,
        to: phone,
        body: buildBody(job.kind, ctx),
        contentSid,
        contentVariables,
        statusCallbackUrl,
      });

      await admin.rpc("complete_notification_job", {
        _job_id: job.job_id,
        _provider_sid: result.sid,
        _to_phone: phone,
      });

      resumen.enviados += 1;
      log.info("Mensaje enviado", {
        job_id: job.job_id,
        tipo: job.kind,
        destino: maskPhone(phone),
        plantilla: contentSid ? "aprobada" : "texto_libre",
        variables: contentVariables ? Object.keys(contentVariables).length : 0,
        estado_twilio: result.status,
      });
    } catch (cause) {
      const retryable = cause instanceof TwilioApiError ? cause.retryable : true;
      const errorCode = cause instanceof TwilioApiError ? cause.code : null;

      await admin.rpc("fail_notification_job", {
        _job_id: job.job_id,
        _error: safeErrorMessage(cause),
        _error_code: errorCode,
        _retryable: retryable,
      });

      resumen.fallidos += 1;
      log.warn("Envío fallido", {
        job_id: job.job_id,
        tipo: job.kind,
        destino: maskPhone(phone),
        codigo: errorCode,
        reintentable: retryable,
        intentos: job.attempts,
      });
    }
  }

  log.info("Lote de notificaciones procesado", resumen);
  return json(request, { ok: true, ...resumen });
});

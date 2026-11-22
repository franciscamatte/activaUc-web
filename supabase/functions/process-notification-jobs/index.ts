/**
 * REQ-24, REQ-25, REQ-26, REQ-27 · Worker de notificaciones por correo.
 *
 * El navegador nunca llama al proveedor de correo. Este worker es el
 * único punto de salida y lo invoca `cron-dispatch` (pg_cron) con
 * CRON_SECRET, o el despacho inmediato en cuanto se encola un trabajo.
 *
 * Reglas aplicadas en el backend, no en la interfaz:
 *   · `claim_notification_jobs` sólo entrega trabajos de personas con el
 *     consentimiento de correo vigente en el momento del reclamo.
 *   · Vuelve a comprobarse la dirección antes de enviar; una cuenta sin
 *     correo utilizable se omite sin consumir reintentos.
 *   · Los recordatorios cuya reserva fue cancelada se descartan, y los
 *     avisos de cupo cuyo bloque ya empezó también.
 *   · Reintentos con retroceso exponencial y tope de intentos.
 *   · No se registran credenciales ni la dirección completa.
 */

import { BrevoEmailError, sendBrevoEmail } from "../_shared/brevoEmail.ts";
import {
  buildEmailHtml,
  buildSubject,
  formatSpanishDateTime,
  type NotificationKind,
} from "../_shared/messages.ts";
import { missingEnv, optionalEnv, requireEnv } from "../_shared/env.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { adminClient } from "../_shared/supabase.ts";
import { createLogger, maskEmail, safeErrorMessage } from "../_shared/log.ts";
import { assertWorkerAuthorized } from "../_shared/worker_auth.ts";

const log = createLogger("process-notification-jobs");
const DEFAULT_BATCH = 10;

/** Mismo patrón que valida el formulario, para no enviar a una dirección imposible. */
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ClaimedJob {
  job_id: string;
  reservation_id: string | null;
  block_id: string | null;
  user_id: string;
  kind: NotificationKind;
  channel: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown> | null;
  to_email: string | null;
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
    "BREVO_API_KEY",
    "BREVO_EMAIL_FROM",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  if (faltantes.length > 0) {
    log.error("Configuración incompleta", { faltantes });
    return fail(
      request,
      "integracion_no_configurada",
      "El canal de correo no está configurado en el servidor.",
      503,
    );
  }

  const apiKey = requireEnv("BREVO_API_KEY");
  const remitente = requireEnv("BREVO_EMAIL_FROM");
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
    const correo = (job.to_email ?? "").trim();

    // Doble comprobación del destino: la base ya lo restringe, pero el
    // worker no confía en un único control.
    if (!CORREO.test(correo)) {
      await admin.rpc("skip_notification_job", {
        _job_id: job.job_id,
        _reason: "La cuenta no tiene una dirección de correo utilizable.",
      });
      resumen.omitidos += 1;
      log.warn("Notificación omitida por correo inválido", { job_id: job.job_id });
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

    try {
      const { messageId } = await sendBrevoEmail({
        apiKey,
        from: remitente,
        fromName: optionalEnv("BREVO_EMAIL_FROM_NAME") || null,
        to: correo,
        toName: job.full_name,
        subject: buildSubject(job.kind, ctx),
        html: buildEmailHtml(job.kind, ctx, optionalEnv("APP_URL") || null),
      });

      await admin.rpc("complete_notification_job", {
        _job_id: job.job_id,
        _provider_sid: messageId,
        _destino: correo,
      });

      resumen.enviados += 1;
      log.info("Correo enviado", {
        job_id: job.job_id,
        tipo: job.kind,
        destino: maskEmail(correo),
      });
    } catch (cause) {
      // La API de correo es asíncrona y no tiene webhook de estados: se
      // sabe que el proveedor aceptó el envío, no que lo entregó.
      const esErrorDeProveedor = cause instanceof BrevoEmailError;
      const retryable = esErrorDeProveedor ? cause.retryable : true;
      const errorCode = esErrorDeProveedor ? cause.code : null;

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
        destino: maskEmail(correo),
        codigo: errorCode,
        reintentable: retryable,
        intentos: job.attempts,
      });
    }
  }

  log.info("Lote de notificaciones procesado", resumen);
  return json(request, { ok: true, ...resumen });
});

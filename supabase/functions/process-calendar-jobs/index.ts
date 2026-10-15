/**
 * REQ-18, REQ-19, REQ-20, REQ-21 · Worker de sincronización con Google Calendar.
 *
 * Lo invoca `cron-dispatch` (pg_cron) o un operador con CRON_SECRET.
 * No acepta JWT de usuario: es infraestructura, no una API pública.
 *
 * Garantías:
 *   · Idempotencia: el id del evento se deriva del id de la reserva, de
 *     modo que recrear el mismo evento devuelve 409 y se trata como éxito.
 *   · Reintentos con backoff exponencial y tope de intentos (en la BD).
 *   · Concurrencia segura: claim_calendar_jobs usa FOR UPDATE SKIP LOCKED.
 *   · Un fallo de Google nunca invalida la reserva: sólo cambia el estado
 *     informativo calendar_sync_status.
 */

import { calendarEventId } from "../_shared/crypto.ts";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  GoogleApiError,
} from "../_shared/google.ts";
import { CalendarConnectionError, getValidAccessToken } from "../_shared/calendar_tokens.ts";
import { missingEnv, optionalEnv } from "../_shared/env.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { adminClient } from "../_shared/supabase.ts";
import { createLogger, safeErrorMessage } from "../_shared/log.ts";
import { formatSpanishDateTime } from "../_shared/messages.ts";
import { assertWorkerAuthorized } from "../_shared/worker_auth.ts";

const log = createLogger("process-calendar-jobs");
const DEFAULT_BATCH = 10;

interface CalendarJob {
  id: string;
  reservation_id: string;
  user_id: string;
  kind: "crear_evento" | "eliminar_evento";
  attempts: number;
  max_attempts: number;
}

interface ReservationInfo {
  id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  calendar_event_id: string | null;
  facilities: { name: string; operation_hours: string | null } | null;
}

Deno.serve(async (request) => {
  const pre = preflight(request);
  if (pre) return pre;

  const authError = assertWorkerAuthorized(request);
  if (authError) return fail(request, authError.code, authError.mensaje, authError.status);

  const faltantes = missingEnv([
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ENCRYPTION_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  if (faltantes.length > 0) {
    log.error("Configuración incompleta", { faltantes });
    return fail(
      request,
      "integracion_no_configurada",
      "Faltan secretos de Google Calendar en el servidor.",
      503,
    );
  }

  const timeZone = optionalEnv("APP_TIME_ZONE", "America/Santiago");
  const admin = adminClient();

  let batch = DEFAULT_BATCH;
  try {
    const body = await request.json() as { limit?: number };
    if (typeof body?.limit === "number") batch = Math.min(Math.max(body.limit, 1), 50);
  } catch { /* sin cuerpo: tamaño por defecto */ }

  const { data: jobs, error } = await admin.rpc("claim_calendar_jobs", { _limit: batch });

  if (error) {
    log.error("No se pudieron reclamar trabajos", { detalle: error.message });
    return fail(request, "error_interno", "No se pudieron reclamar trabajos.", 500);
  }

  const claimed = (jobs ?? []) as CalendarJob[];
  const resumen = { reclamados: claimed.length, completados: 0, fallidos: 0, omitidos: 0 };

  for (const job of claimed) {
    try {
      const { data: reservation, error: resError } = await admin
        .from("reservations")
        .select("id, status, starts_at, ends_at, calendar_event_id, facilities(name, operation_hours)")
        .eq("id", job.reservation_id)
        .maybeSingle<ReservationInfo>();

      if (resError) throw new Error(`Lectura de reserva: ${resError.message}`);

      if (!reservation) {
        await admin.rpc("fail_calendar_job", {
          _job_id: job.id,
          _error: "La reserva asociada ya no existe.",
          _retryable: false,
        });
        resumen.omitidos += 1;
        continue;
      }

      const accessToken = await getValidAccessToken(admin, job.user_id);
      const eventId = reservation.calendar_event_id ?? calendarEventId(reservation.id);

      if (job.kind === "crear_evento") {
        // No crear eventos de reservas canceladas ni ya finalizadas.
        if (reservation.status !== "vigente") {
          await admin.rpc("fail_calendar_job", {
            _job_id: job.id,
            _error: "La reserva fue cancelada antes de sincronizar.",
            _retryable: false,
          });
          resumen.omitidos += 1;
          continue;
        }

        const recinto = reservation.facilities?.name ?? "Recinto deportivo";
        const result = await createCalendarEvent(accessToken, {
          eventId,
          summary: `Reserva ActivaUC · ${recinto}`,
          description:
            `Reserva confirmada en ActivaUC (Deportes UC).\n` +
            `Recinto: ${recinto}\n` +
            `Inicio: ${formatSpanishDateTime(reservation.starts_at, timeZone)}\n` +
            `Puedes cancelarla en ActivaUC hasta 2 horas antes del inicio.`,
          location: recinto,
          startsAt: reservation.starts_at,
          endsAt: reservation.ends_at,
          timeZone,
        });

        await admin.rpc("complete_calendar_job", {
          _job_id: job.id,
          _event_id: result.eventId,
        });
        resumen.completados += 1;
        log.info("Evento sincronizado", {
          reservation_id: reservation.id,
          ya_existia: result.alreadyExisted,
          intentos: job.attempts,
        });
      } else {
        await deleteCalendarEvent(accessToken, eventId);
        await admin.rpc("complete_calendar_job", { _job_id: job.id, _event_id: null });
        resumen.completados += 1;
        log.info("Evento eliminado", { reservation_id: reservation.id, intentos: job.attempts });
      }
    } catch (cause) {
      const retryable = cause instanceof GoogleApiError
        ? cause.retryable
        : cause instanceof CalendarConnectionError
        ? cause.retryable
        : true;

      await admin.rpc("fail_calendar_job", {
        _job_id: job.id,
        _error: safeErrorMessage(cause),
        _retryable: retryable,
      });

      resumen.fallidos += 1;
      log.warn("Trabajo de calendario fallido", {
        job_id: job.id,
        reservation_id: job.reservation_id,
        reintentable: retryable,
        intentos: job.attempts,
        detalle: safeErrorMessage(cause),
      });
    }
  }

  log.info("Lote procesado", resumen);
  return json(request, { ok: true, ...resumen });
});

/**
 * Punto único de entrada de las tareas programadas.
 *
 * pg_cron (private.dispatch_integration_workers) llama esta función cada
 * minuto con el encabezado x-cron-secret. A su vez invoca los workers:
 *
 *   · process-calendar-jobs      → crea/elimina eventos de Google Calendar
 *   · process-notification-jobs  → envía confirmaciones y los recordatorios
 *                                  cuyo scheduled_for ya venció (REQ-25)
 *
 * Mantener un solo disparador evita que pg_cron necesite conocer la lista
 * de funciones y simplifica la rotación del secreto.
 */

import { fail, json, preflight } from "../_shared/http.ts";
import { optionalEnv, requireEnv } from "../_shared/env.ts";
import { createLogger, safeErrorMessage } from "../_shared/log.ts";
import { assertWorkerAuthorized } from "../_shared/worker_auth.ts";
import { adminClient } from "../_shared/supabase.ts";

const log = createLogger("cron-dispatch");

const WORKERS = ["process-calendar-jobs", "process-notification-jobs"] as const;

Deno.serve(async (request) => {
  const pre = preflight(request);
  if (pre) return pre;

  const authError = assertWorkerAuthorized(request);
  if (authError) return fail(request, authError.code, authError.mensaje, authError.status);

  const baseUrl = optionalEnv("SUPABASE_URL");
  if (!baseUrl) {
    return fail(request, "no_configurado", "Falta SUPABASE_URL.", 503);
  }

  const cronSecret = optionalEnv("CRON_SECRET");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const resultados: Record<string, unknown> = {};

  for (const worker of WORKERS) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/functions/v1/${worker}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceRoleKey}`,
          ...(cronSecret ? { "x-cron-secret": cronSecret } : {}),
        },
        body: JSON.stringify({ limit: 25 }),
      });

      const text = await response.text();
      let parsed: unknown = text.slice(0, 300);
      try { parsed = JSON.parse(text); } catch { /* texto plano */ }

      resultados[worker] = { status: response.status, resultado: parsed };

      if (!response.ok) {
        log.warn("Worker respondió con error", { worker, status: response.status });
      }
    } catch (cause) {
      resultados[worker] = { error: safeErrorMessage(cause) };
      log.error("No se pudo invocar el worker", { worker, detalle: safeErrorMessage(cause) });
    }
  }

  // Limpieza de datos efímeros una vez cada ~60 ejecuciones (≈1 hora).
  if (Math.random() < 1 / 60) {
    try {
      await adminClient().schema("private").rpc("cleanup_ephemeral_data");
    } catch (cause) {
      log.warn("Limpieza omitida", { detalle: safeErrorMessage(cause) });
    }
  }

  log.info("Despacho completado", { workers: WORKERS.length });
  return json(request, { ok: true, resultados });
});

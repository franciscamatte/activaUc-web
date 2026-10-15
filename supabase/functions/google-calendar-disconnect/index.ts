/**
 * REQ-17 · Desconexión de Google Calendar.
 *
 * Requiere JWT de usuario. Revoca el refresh token contra Google, borra
 * los tokens almacenados y deja la conexión como `revocado`.
 *
 * Regla de negocio: desconectar NO invalida ni altera las reservas. Los
 * trabajos de sincronización pendientes se cancelan y las reservas
 * quedan con calendar_sync_status = 'no_aplica'.
 */

import { decryptSecret } from "../_shared/crypto.ts";
import { revokeToken } from "../_shared/google.ts";
import { missingEnv, requireEnv } from "../_shared/env.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { adminClient, requireUser } from "../_shared/supabase.ts";
import { createLogger, safeErrorMessage } from "../_shared/log.ts";

const log = createLogger("google-calendar-disconnect");

Deno.serve(async (request) => {
  const pre = preflight(request);
  if (pre) return pre;

  if (request.method !== "POST") {
    return fail(request, "metodo_no_permitido", "Usa POST para desconectar la cuenta.", 405);
  }

  if (missingEnv(["ENCRYPTION_KEY"]).length > 0) {
    return fail(
      request,
      "integracion_no_configurada",
      "La integración con Google Calendar no está configurada en el servidor.",
      503,
    );
  }

  const user = await requireUser(request);
  if (!user) {
    return fail(request, "no_autenticado", "Debes iniciar sesión.", 401);
  }

  const admin = adminClient();

  const { data: connection, error } = await admin
    .from("calendar_connections")
    .select("id, status, refresh_token_encrypted")
    .eq("user_id", user.id)
    .maybeSingle<{ id: string; status: string; refresh_token_encrypted: string | null }>();

  if (error) {
    log.error("No se pudo leer la conexión", { detalle: error.message });
    return fail(request, "error_interno", "No pudimos completar la desconexión.", 500);
  }

  if (!connection || connection.status === "revocado") {
    return json(request, {
      ok: true,
      estado: "revocado",
      mensaje: "Tu cuenta de Google Calendar ya estaba desconectada.",
    });
  }

  // Revocación en Google. Si falla, igualmente se eliminan los tokens
  // locales: la plataforma deja de poder actuar sobre el calendario.
  let revocadoEnGoogle = false;
  if (connection.refresh_token_encrypted) {
    try {
      const refreshToken = await decryptSecret(
        connection.refresh_token_encrypted,
        requireEnv("ENCRYPTION_KEY"),
      );
      revocadoEnGoogle = await revokeToken(refreshToken);
    } catch (cause) {
      log.warn("No se pudo revocar en Google", { detalle: safeErrorMessage(cause) });
    }
  }

  const { error: updateError } = await admin
    .from("calendar_connections")
    .update({
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      access_token_expires_at: null,
      google_account_email: null,
      status: "revocado",
      revoked_at: new Date().toISOString(),
      last_error: revocadoEnGoogle ? null : "Revocación remota no confirmada por Google.",
    })
    .eq("user_id", user.id);

  if (updateError) {
    log.error("No se pudo actualizar la conexión", { detalle: updateError.message });
    return fail(request, "error_interno", "No pudimos completar la desconexión.", 500);
  }

  // Los trabajos pendientes ya no pueden ejecutarse: se cancelan.
  await admin
    .from("calendar_sync_jobs")
    .update({ status: "cancelado", last_error: "Conexión de Google Calendar revocada." })
    .eq("user_id", user.id)
    .in("status", ["pendiente", "error"]);

  // Las reservas siguen siendo válidas: sólo cambia el estado informativo.
  await admin
    .from("reservations")
    .update({ calendar_sync_status: "no_aplica", calendar_event_id: null })
    .eq("user_id", user.id)
    .eq("status", "vigente")
    .gt("starts_at", new Date().toISOString());

  await admin.from("reservation_audit_log").insert({
    action: "calendar_desconectado",
    actor_id: user.id,
    actor_role: "usuario",
    details: { revocado_en_google: revocadoEnGoogle },
  });

  log.info("Google Calendar desconectado", { user_id: user.id, revocadoEnGoogle });

  return json(request, {
    ok: true,
    estado: "revocado",
    revocadoEnGoogle,
    mensaje: revocadoEnGoogle
      ? "Desconectamos tu cuenta de Google Calendar y revocamos el permiso. Tus reservas siguen vigentes."
      : "Eliminamos el acceso guardado. Revisa también los permisos de tu cuenta Google. Tus reservas siguen vigentes.",
  });
});

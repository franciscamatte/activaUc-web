/**
 * REQ-17 · Callback del flujo OAuth 2.0 de Google Calendar.
 *
 * Endpoint público (verify_jwt = false): Google redirige al navegador
 * aquí y no puede adjuntar el JWT de Supabase. La identidad se demuestra
 * con el `state` firmado, no con una sesión.
 *
 * Controles aplicados, en orden:
 *   1. Firma HMAC del `state`  → descarta un state fabricado sin tocar la BD.
 *   2. Fila de oauth_states no vencida y no consumida → anti-replay.
 *   3. Marca de consumo atómica (update ... is null) → un state sirve una vez.
 *   4. Intercambio del code por tokens contra Google.
 *   5. Cifrado AES-256-GCM antes de persistir.
 *
 * Termina siempre con una redirección al frontend; nunca devuelve tokens.
 */

import { emailFromIdToken, exchangeCode, GOOGLE_SCOPES } from "../_shared/google.ts";
import { encryptSecret, sha256Hex, verifyState } from "../_shared/crypto.ts";
import { missingEnv, requireEnv } from "../_shared/env.ts";
import { redirectToApp } from "../_shared/http.ts";
import { adminClient } from "../_shared/supabase.ts";
import { createLogger, safeErrorMessage } from "../_shared/log.ts";

const log = createLogger("google-oauth-callback");
const FALLBACK_PATH = "/datos-personales";

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  if (googleError) {
    log.warn("Google rechazó la autorización", { motivo: googleError });
    return redirectToApp(FALLBACK_PATH, {
      calendar: "error",
      motivo: googleError === "access_denied" ? "permiso_denegado" : "google_error",
    });
  }

  if (!code || !state) {
    return redirectToApp(FALLBACK_PATH, { calendar: "error", motivo: "parametros_incompletos" });
  }

  const faltantes = missingEnv([
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "ENCRYPTION_KEY",
  ]);
  if (faltantes.length > 0) {
    log.error("Configuración incompleta", { faltantes });
    return redirectToApp(FALLBACK_PATH, { calendar: "error", motivo: "no_configurado" });
  }

  const encryptionKey = requireEnv("ENCRYPTION_KEY");

  // 1) Verificación de la firma antes de cualquier consulta.
  const verified = await verifyState(state, encryptionKey);
  if (!verified) {
    log.warn("State con firma inválida: posible intento de CSRF");
    return redirectToApp(FALLBACK_PATH, { calendar: "error", motivo: "state_invalido" });
  }

  const admin = adminClient();
  const stateHash = await sha256Hex(verified.nonce);

  // 2) y 3) Consumo atómico del state: sólo una petición puede ganarlo.
  const { data: consumed, error: consumeError } = await admin
    .from("oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state_hash", stateHash)
    .eq("user_id", verified.userId)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("id, user_id, redirect_path")
    .maybeSingle<{ id: string; user_id: string; redirect_path: string }>();

  if (consumeError) {
    log.error("Error al consumir el state", { detalle: consumeError.message });
    return redirectToApp(FALLBACK_PATH, { calendar: "error", motivo: "error_interno" });
  }

  if (!consumed) {
    log.warn("State ya usado o vencido", { user_id: verified.userId });
    return redirectToApp(FALLBACK_PATH, { calendar: "error", motivo: "state_expirado" });
  }

  const redirectPath = consumed.redirect_path || FALLBACK_PATH;

  try {
    // 4) Intercambio del código de autorización.
    const tokens = await exchangeCode({
      code,
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirectUri: requireEnv("GOOGLE_REDIRECT_URI"),
    });

    if (!tokens.refreshToken) {
      // Sin refresh token no es posible renovar el acceso más adelante.
      log.warn("Google no entregó refresh token", { user_id: consumed.user_id });
      return redirectToApp(redirectPath, { calendar: "error", motivo: "sin_refresh_token" });
    }

    // Verificación de alcance: debe incluir calendar.events.
    if (!tokens.scope.includes("calendar.events")) {
      log.warn("Alcance insuficiente", { user_id: consumed.user_id });
      return redirectToApp(redirectPath, { calendar: "error", motivo: "permisos_insuficientes" });
    }

    // 5) Persistencia cifrada. Nunca en texto claro, nunca en el cliente.
    const { error: upsertError } = await admin
      .from("calendar_connections")
      .upsert({
        user_id: consumed.user_id,
        provider: "google",
        google_account_email: emailFromIdToken(tokens.idToken),
        access_token_encrypted: await encryptSecret(tokens.accessToken, encryptionKey),
        refresh_token_encrypted: await encryptSecret(tokens.refreshToken, encryptionKey),
        access_token_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
        scope: GOOGLE_SCOPES.join(" "),
        status: "conectado",
        last_error: null,
        connected_at: new Date().toISOString(),
        revoked_at: null,
      }, { onConflict: "user_id" });

    if (upsertError) {
      log.error("No se pudo guardar la conexión", { detalle: upsertError.message });
      return redirectToApp(redirectPath, { calendar: "error", motivo: "error_interno" });
    }

    await admin.from("reservation_audit_log").insert({
      action: "calendar_conectado",
      actor_id: consumed.user_id,
      actor_role: "usuario",
      details: { proveedor: "google" },
    });

    // Las reservas vigentes creadas antes de conectar se sincronizan ahora.
    await encolarReservasPendientes(admin, consumed.user_id);

    log.info("Google Calendar conectado", { user_id: consumed.user_id });
    return redirectToApp(redirectPath, { calendar: "conectado" });
  } catch (cause) {
    log.error("Fallo al completar OAuth", { detalle: safeErrorMessage(cause) });
    return redirectToApp(redirectPath, { calendar: "error", motivo: "google_error" });
  }
});

/**
 * Encola la creación de eventos para las reservas vigentes futuras que
 * todavía no tienen evento. La clave de idempotencia evita duplicados si
 * el usuario conecta y desconecta varias veces.
 */
async function encolarReservasPendientes(
  admin: ReturnType<typeof adminClient>,
  userId: string,
): Promise<void> {
  const { data: reservas, error } = await admin
    .from("reservations")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "vigente")
    .is("calendar_event_id", null)
    .gt("starts_at", new Date().toISOString())
    .limit(100);

  if (error || !reservas || reservas.length === 0) return;

  const jobs = reservas.map((r) => ({
    reservation_id: r.id,
    user_id: userId,
    kind: "crear_evento" as const,
    idempotency_key: `cal:create:${r.id}`,
    payload: { reservation_id: r.id },
  }));

  await admin.from("calendar_sync_jobs").upsert(jobs, {
    onConflict: "idempotency_key",
    ignoreDuplicates: true,
  });

  await admin
    .from("reservations")
    .update({ calendar_sync_status: "pendiente" })
    .in("id", reservas.map((r) => r.id));
}

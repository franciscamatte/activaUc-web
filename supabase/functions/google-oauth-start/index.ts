/**
 * REQ-17 · Inicio del flujo OAuth 2.0 de Google Calendar.
 *
 * Requiere JWT de usuario (verify_jwt = true en supabase/config.toml).
 *
 * Seguridad:
 *   · El `state` es <nonce>.<userId>.<HMAC-SHA256>, firmado con
 *     ENCRYPTION_KEY. El callback verifica la firma antes de consultar
 *     la base de datos.
 *   · Sólo se persiste el SHA-256 del nonce, con vencimiento a 10
 *     minutos y uso único, de modo que un `state` robado de la base no
 *     sirve para falsificar la redirección.
 *   · El client_secret jamás sale del backend.
 */

import { buildAuthUrl } from "../_shared/google.ts";
import { randomToken, sha256Hex, signState } from "../_shared/crypto.ts";
import { missingEnv, requireEnv } from "../_shared/env.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { adminClient, requireUser } from "../_shared/supabase.ts";
import { createLogger, safeErrorMessage } from "../_shared/log.ts";

const log = createLogger("google-oauth-start");
const STATE_TTL_MINUTES = 10;
const SAFE_PATH = /^\/[A-Za-z0-9/_-]*$/;

Deno.serve(async (request) => {
  const pre = preflight(request);
  if (pre) return pre;

  if (request.method !== "POST") {
    return fail(request, "metodo_no_permitido", "Usa POST para iniciar la conexión.", 405);
  }

  const faltantes = missingEnv([
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "ENCRYPTION_KEY",
  ]);
  if (faltantes.length > 0) {
    log.error("Configuración incompleta", { faltantes });
    return fail(
      request,
      "integracion_no_configurada",
      "La integración con Google Calendar aún no está configurada en el servidor.",
      503,
    );
  }

  const user = await requireUser(request);
  if (!user) {
    return fail(request, "no_autenticado", "Debes iniciar sesión para conectar Google Calendar.", 401);
  }

  let redirectPath = "/datos-personales";
  try {
    const body = await request.json() as { redirectPath?: string };
    if (body?.redirectPath && SAFE_PATH.test(body.redirectPath)) {
      redirectPath = body.redirectPath;
    }
  } catch {
    // Sin cuerpo: se usa la ruta por defecto.
  }

  const admin = adminClient();

  // Rate limiting: como máximo 5 inicios de OAuth por minuto y usuario.
  const { data: allowed, error: rateError } = await admin.rpc("consume_rate_limit", {
    _bucket: "oauth_start",
    _subject: user.id,
    _limit: 5,
    _window: "00:01:00",
  });
  if (rateError) {
    log.warn("No se pudo evaluar el límite de solicitudes", { detalle: rateError.message });
  } else if (allowed === false) {
    return fail(
      request,
      "limite_solicitudes",
      "Demasiados intentos de conexión. Espera un minuto e inténtalo otra vez.",
      429,
    );
  }

  try {
    const nonce = randomToken(32);
    const state = await signState(nonce, user.id, requireEnv("ENCRYPTION_KEY"));
    const stateHash = await sha256Hex(nonce);

    const { error: insertError } = await admin.from("oauth_states").insert({
      state_hash: stateHash,
      user_id: user.id,
      redirect_path: redirectPath,
      expires_at: new Date(Date.now() + STATE_TTL_MINUTES * 60_000).toISOString(),
    });

    if (insertError) {
      log.error("No se pudo registrar el state de OAuth", { detalle: insertError.message });
      return fail(
        request,
        "error_interno",
        "No pudimos iniciar la conexión con Google. Inténtalo nuevamente.",
        500,
      );
    }

    const authUrl = buildAuthUrl({
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      redirectUri: requireEnv("GOOGLE_REDIRECT_URI"),
      state,
      loginHint: user.email,
    });

    log.info("Flujo OAuth iniciado", { user_id: user.id, redirectPath });

    return json(request, {
      ok: true,
      authorizationUrl: authUrl,
      expiraEn: STATE_TTL_MINUTES * 60,
    });
  } catch (cause) {
    log.error("Fallo al iniciar OAuth", { detalle: safeErrorMessage(cause) });
    return fail(
      request,
      "error_interno",
      "No pudimos iniciar la conexión con Google. Inténtalo nuevamente.",
      500,
    );
  }
});

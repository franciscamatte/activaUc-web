/**
 * Obtención de un access token de Google válido para un usuario.
 *
 * Los tokens viven cifrados en public.calendar_connections y sólo el
 * service_role puede leerlos. Si el access token está vencido (o le
 * quedan menos de 2 minutos) se renueva con el refresh token y se
 * vuelve a guardar cifrado.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { GoogleApiError, refreshAccessToken } from "./google.ts";
import { requireEnv } from "./env.ts";
import { safeErrorMessage } from "./log.ts";

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export class CalendarConnectionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CalendarConnectionError";
    this.retryable = retryable;
  }
}

interface ConnectionRow {
  id: string;
  user_id: string;
  status: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
}

export async function getValidAccessToken(
  admin: SupabaseClient,
  userId: string,
): Promise<string> {
  const encryptionKey = requireEnv("ENCRYPTION_KEY");

  const { data, error } = await admin
    .from("calendar_connections")
    .select("id, user_id, status, access_token_encrypted, refresh_token_encrypted, access_token_expires_at")
    .eq("user_id", userId)
    .maybeSingle<ConnectionRow>();

  if (error) {
    throw new CalendarConnectionError(
      `No se pudo leer la conexión de calendario: ${error.message}`,
      true,
    );
  }

  if (!data || data.status !== "conectado") {
    throw new CalendarConnectionError(
      "El usuario no tiene Google Calendar conectado.",
      false,
    );
  }

  const expiresAt = data.access_token_expires_at
    ? new Date(data.access_token_expires_at).getTime()
    : 0;

  if (data.access_token_encrypted && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return await decryptSecret(data.access_token_encrypted, encryptionKey);
  }

  if (!data.refresh_token_encrypted) {
    await markConnectionError(admin, userId, "Sin refresh token: se requiere reconectar.");
    throw new CalendarConnectionError(
      "La conexión con Google Calendar expiró y debe volver a autorizarse.",
      false,
    );
  }

  const refreshToken = await decryptSecret(data.refresh_token_encrypted, encryptionKey);

  try {
    const tokens = await refreshAccessToken({
      refreshToken,
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    });

    const newExpiry = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();

    await admin
      .from("calendar_connections")
      .update({
        access_token_encrypted: await encryptSecret(tokens.accessToken, encryptionKey),
        access_token_expires_at: newExpiry,
        // Google puede rotar el refresh token; si lo manda, se reemplaza.
        ...(tokens.refreshToken
          ? { refresh_token_encrypted: await encryptSecret(tokens.refreshToken, encryptionKey) }
          : {}),
        status: "conectado",
        last_error: null,
      })
      .eq("user_id", userId);

    return tokens.accessToken;
  } catch (cause) {
    const retryable = cause instanceof GoogleApiError ? cause.retryable : false;
    if (!retryable) {
      // invalid_grant: el usuario revocó el acceso desde su cuenta Google.
      await markConnectionError(admin, userId, safeErrorMessage(cause));
    }
    throw new CalendarConnectionError(
      `No se pudo renovar el acceso a Google Calendar: ${safeErrorMessage(cause)}`,
      retryable,
    );
  }
}

export async function markConnectionError(
  admin: SupabaseClient,
  userId: string,
  reason: string,
): Promise<void> {
  await admin
    .from("calendar_connections")
    .update({ status: "error", last_error: reason.slice(0, 300) })
    .eq("user_id", userId);
}

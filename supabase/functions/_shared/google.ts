/**
 * Cliente mínimo de Google OAuth 2.0 + Google Calendar API.
 *
 * Alcance solicitado: únicamente `calendar.events`, el permiso mínimo
 * necesario para crear y eliminar los eventos de las reservas (REQ-17).
 * No se piden permisos de lectura del calendario completo ni de perfil
 * más allá del correo de la cuenta conectada.
 */

import { safeErrorMessage } from "./log.ts";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
] as const;

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const CALENDAR_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
  idToken: string | null;
}

/** Distingue errores recuperables (5xx, 429) de los definitivos (4xx). */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.retryable = status === 429 || status === 408 || status >= 500;
  }
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string | null;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  // access_type=offline + prompt=consent garantizan refresh_token.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

async function tokenRequest(body: URLSearchParams): Promise<GoogleTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    // El cuerpo de Google puede incluir el code; se registra sólo el campo error.
    let detail = "respuesta no interpretable";
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      detail = parsed.error_description ?? parsed.error ?? detail;
    } catch { /* se mantiene el detalle genérico */ }
    throw new GoogleApiError(response.status, `Google OAuth: ${detail}`);
  }

  const parsed = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    id_token?: string;
  };

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresInSeconds: parsed.expires_in ?? 3600,
    scope: parsed.scope ?? GOOGLE_SCOPES.join(" "),
    idToken: parsed.id_token ?? null,
  };
}

export function exchangeCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokens> {
  return tokenRequest(new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  }));
}

/** Renovación automática del access token (REQ-17). */
export function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleTokens> {
  return tokenRequest(new URLSearchParams({
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
  }));
}

/** Revocación efectiva al desconectar (REQ-17). */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    // 400 "invalid_token" significa que ya no era válido: objetivo cumplido.
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}

/** Correo de la cuenta conectada, extraído del id_token sin verificar firma
 *  (se usa sólo como dato informativo para mostrarlo en la interfaz). */
export function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const payload = JSON.parse(json) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

export interface CalendarEventInput {
  eventId: string;
  summary: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
}

export interface CalendarEventResult {
  eventId: string;
  alreadyExisted: boolean;
}

/**
 * Crea el evento usando un id determinístico derivado de la reserva.
 * Si el evento ya existe Google responde 409 y lo tratamos como éxito:
 * así un reintento nunca produce eventos duplicados (REQ-20).
 */
export async function createCalendarEvent(
  accessToken: string,
  input: CalendarEventInput,
): Promise<CalendarEventResult> {
  const response = await fetch(CALENDAR_EVENTS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: input.eventId,
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startsAt, timeZone: input.timeZone },
      end: { dateTime: input.endsAt, timeZone: input.timeZone },
      source: { title: "ActivaUC" },
      reminders: { useDefault: true },
    }),
  });

  if (response.status === 409) {
    await response.body?.cancel();
    return { eventId: input.eventId, alreadyExisted: true };
  }

  if (!response.ok) {
    throw new GoogleApiError(
      response.status,
      `Google Calendar rechazó la creación del evento (HTTP ${response.status}).`,
    );
  }

  const created = await response.json() as { id?: string };
  return { eventId: created.id ?? input.eventId, alreadyExisted: false };
}

/**
 * Elimina el evento. 404/410 significan que ya no existe, lo que para
 * nuestros fines es el resultado deseado (REQ-19).
 */
export async function deleteCalendarEvent(
  accessToken: string,
  eventId: string,
): Promise<{ alreadyGone: boolean }> {
  const response = await fetch(`${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.ok || response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return { alreadyGone: response.status === 404 || response.status === 410 };
  }

  throw new GoogleApiError(
    response.status,
    `Google Calendar rechazó la eliminación del evento (HTTP ${response.status}).`,
  );
}

export { safeErrorMessage };

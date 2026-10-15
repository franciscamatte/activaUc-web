/**
 * Utilidades HTTP compartidas: CORS restringido por lista blanca y
 * respuestas JSON con mensajes en español.
 */

import { optionalEnv } from "./env.ts";

/**
 * Orígenes permitidos. Se configura con APP_ALLOWED_ORIGINS
 * (lista separada por comas). Sin configuración explícita se permite
 * únicamente APP_URL, y en su defecto el desarrollo local.
 */
function allowedOrigins(): string[] {
  const configured = optionalEnv("APP_ALLOWED_ORIGINS");
  if (configured) {
    return configured.split(",").map((o) => o.trim()).filter(Boolean);
  }
  const appUrl = optionalEnv("APP_URL");
  if (appUrl) {
    return [appUrl.replace(/\/$/, "")];
  }
  return ["http://localhost:5173"];
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = allowedOrigins();
  const match = allowed.includes(origin) ? origin : "";

  const headers: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
  };

  if (match) {
    headers["Access-Control-Allow-Origin"] = match;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

export function preflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function json(
  request: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function fail(
  request: Request,
  code: string,
  mensaje: string,
  status = 400,
): Response {
  return json(request, { ok: false, error: code, mensaje }, status);
}

/** Redirección al frontend con un resultado legible en la query string. */
export function redirectToApp(path: string, params: Record<string, string>): Response {
  const base = optionalEnv("APP_URL", "http://localhost:5173").replace(/\/$/, "");
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}

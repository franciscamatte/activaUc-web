/**
 * Autorización de los workers de integración.
 *
 * Los workers no son una API pública: se invocan desde pg_cron (a través
 * de `cron-dispatch`) o manualmente por un operador. Se aceptan dos
 * credenciales, ambas comparadas en tiempo constante:
 *
 *   · x-cron-secret: CRON_SECRET
 *   · Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 *
 * Si CRON_SECRET no está configurado se rechaza todo: es preferible que
 * el worker no funcione a que quede abierto.
 */

import { timingSafeEqual } from "./crypto.ts";
import { optionalEnv } from "./env.ts";

export interface WorkerAuthError {
  code: string;
  mensaje: string;
  status: number;
}

export function assertWorkerAuthorized(request: Request): WorkerAuthError | null {
  const cronSecret = optionalEnv("CRON_SECRET");
  const serviceRoleKey = optionalEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!cronSecret && !serviceRoleKey) {
    return {
      code: "no_configurado",
      mensaje: "El worker no está configurado (falta CRON_SECRET).",
      status: 503,
    };
  }

  const provided = request.headers.get("x-cron-secret");
  if (cronSecret && provided && timingSafeEqual(provided, cronSecret)) {
    return null;
  }

  const authorization = request.headers.get("Authorization") ?? "";
  if (serviceRoleKey && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length);
    if (timingSafeEqual(token, serviceRoleKey)) {
      return null;
    }
  }

  return {
    code: "no_autorizado",
    mensaje: "Credencial de worker inválida.",
    status: 401,
  };
}

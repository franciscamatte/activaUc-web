/**
 * Clientes de Supabase para Edge Functions.
 *
 *  · adminClient()  → service_role. Sólo para lógica de backend de
 *                     confianza (workers, webhooks, OAuth). Jamás se
 *                     devuelve su clave al navegador.
 *  · userClient()   → propaga el JWT del usuario, de modo que RLS sigue
 *                     aplicándose y la función no puede actuar en nombre
 *                     de otra persona por error.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { requireEnv, SERVICE_ROLE_VAR, SUPABASE_URL_VAR } from "./env.ts";

export function adminClient(): SupabaseClient {
  return createClient(requireEnv(SUPABASE_URL_VAR), requireEnv(SERVICE_ROLE_VAR), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "activauc-edge" } },
  });
}

export function userClient(authorizationHeader: string): SupabaseClient {
  return createClient(
    requireEnv(SUPABASE_URL_VAR),
    requireEnv("SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorizationHeader } },
    },
  );
}

/** Devuelve el usuario autenticado a partir del encabezado Authorization. */
export async function requireUser(
  request: Request,
): Promise<{ id: string; email: string | null } | null> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const client = userClient(authorization);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * Cliente de Supabase para el navegador.
 *
 * Usa exclusivamente la clave pública (anon). Todo el acceso a datos
 * queda sujeto a RLS, y las operaciones sensibles pasan por funciones
 * SECURITY DEFINER o por Edge Functions.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./env";
import { AppError } from "./errors";

let instancia: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (instancia) return instancia;

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new AppError(
      "configuracion",
      "Supabase no está configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.",
    );
  }

  instancia = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      // Persistencia y renovación de sesión (REQ-2: la sesión sobrevive
      // a una recarga; el token se renueva de forma transparente).
      persistSession: true,
      autoRefreshToken: true,
      // Necesario para procesar los enlaces de confirmación de correo y
      // de recuperación de contraseña que llegan con el token en el hash.
      detectSessionInUrl: true,
      flowType: "pkce",
      storageKey: "activauc.auth",
    },
    realtime: {
      params: { eventsPerSecond: 10 },
    },
    global: {
      headers: { "X-Client-Info": "activauc-web" },
    },
  });

  return instancia;
}

/**
 * Invoca una Edge Function con el JWT del usuario.
 *
 * Se usa `functions.invoke` para que el SDK adjunte la cabecera de
 * autorización. Las funciones devuelven siempre `{ ok, error, mensaje }`.
 */
export async function invocarFuncion<T>(
  nombre: string,
  cuerpo: Record<string, unknown> = {},
): Promise<T> {
  const supabase = getSupabase();
  const { data, error } = await supabase.functions.invoke<T>(nombre, { body: cuerpo });

  if (error) {
    // El cuerpo de error de una Edge Function trae nuestro mensaje en
    // español; se intenta recuperar antes de caer en el genérico.
    const contexto = error as unknown as { context?: Response };
    if (contexto.context && typeof contexto.context.json === "function") {
      try {
        const detalle = await contexto.context.json() as {
          error?: string;
          mensaje?: string;
        };
        if (detalle?.mensaje) {
          throw new AppError(
            detalle.error === "integracion_no_configurada" ? "integracion" : "desconocido",
            detalle.mensaje,
          );
        }
      } catch (interno) {
        if (interno instanceof AppError) throw interno;
      }
    }
    throw error;
  }

  if (data === null || data === undefined) {
    throw new AppError("desconocido", "El servidor no devolvió una respuesta.");
  }

  return data;
}

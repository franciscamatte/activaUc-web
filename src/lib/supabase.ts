import { createClient } from "@supabase/supabase-js";
import { env, hasSupabaseConfig } from "./env";

export function getSupabaseClient() {
  if (!hasSupabaseConfig()) {
    throw new Error(
      "Supabase no está configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.",
    );
  }

  return createClient(env.supabaseUrl!, env.supabaseAnonKey!, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

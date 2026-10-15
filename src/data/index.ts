import { env, hasSupabaseConfig } from "../lib/env";
import { getSupabaseClient } from "../lib/supabase";
import { repository as mockRepository } from "./mockRepository";
import type { ActivaRepository } from "./repository";
import { SupabaseRepository } from "./supabaseRepository";

const useSupabase = env.dataMode === "supabase";

export const isMockMode = !useSupabase || !hasSupabaseConfig();

export const activeRepository: ActivaRepository = isMockMode
  ? mockRepository
  : new SupabaseRepository(getSupabaseClient());

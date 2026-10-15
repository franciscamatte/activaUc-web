import { env, hasSupabaseConfig } from "../lib/env";
import { repository as mockRepository } from "./mockRepository";
import type { ActivaRepository } from "./repository";
import { SupabaseRepositoryNotConfigured } from "./supabaseRepository";

const useSupabase = env.dataMode === "supabase";

export const activeRepository: ActivaRepository = useSupabase
  ? hasSupabaseConfig()
    ? new SupabaseRepositoryNotConfigured()
    : new SupabaseRepositoryNotConfigured()
  : mockRepository;

export const isMockMode = !useSupabase;

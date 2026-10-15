import { env } from "../lib/env";
import { repository as mockRepository } from "./mockRepository";
import type { ActivaRepository } from "./repository";
import { SupabaseRepositoryNotConfigured } from "./supabaseRepository";

const useSupabase = env.dataMode === "supabase";

export const activeRepository: ActivaRepository = useSupabase
  ? new SupabaseRepositoryNotConfigured()
  : mockRepository;

export const isMockMode = !useSupabase;

import type { ActivaRepository } from "./repository";

export class SupabaseRepositoryNotConfigured implements ActivaRepository {
  private error(): never {
    throw new Error(
      "Supabase no está configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY o usa modo mock.",
    );
  }

  async getSnapshot() { this.error(); }
  async login() { this.error(); }
  async register() { this.error(); }
  async recoverPassword() { this.error(); }
  async logout() { this.error(); }
  async saveProfile() { this.error(); }
  async getBloquesFiltrados() { this.error(); }
  async reservar() { this.error(); }
  async cancelarReservaComoUsuario() { this.error(); }
  async cancelarReservaComoAdmin() { this.error(); }
  async saveRecinto() { this.error(); }
  async saveBloque() { this.error(); }
}

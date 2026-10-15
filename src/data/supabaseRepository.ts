import type { Bloque, FiltrosCatalogo, Recinto, Usuario } from "../domain/types";
import type { ActivaRepository, AppSnapshot } from "./repository";

export class SupabaseRepositoryNotConfigured implements ActivaRepository {
  private error(): never {
    throw new Error(
      "Supabase no está configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY o usa modo mock.",
    );
  }

  async getSnapshot(): Promise<AppSnapshot> { return this.error(); }
  async login(_email: string, _password: string): Promise<void> { return this.error(); }
  async register(_nombre: string, _email: string, _password: string): Promise<void> { return this.error(); }
  async recoverPassword(_email: string): Promise<void> { return this.error(); }
  async logout(): Promise<void> { return this.error(); }
  async saveProfile(_data: Partial<Usuario>): Promise<void> { return this.error(); }
  async getBloquesFiltrados(_filters: FiltrosCatalogo): Promise<Bloque[]> { return this.error(); }
  async reservar(_bloqueId: string): Promise<void> { return this.error(); }
  async cancelarReservaComoUsuario(_reservaId: string): Promise<void> { return this.error(); }
  async cancelarReservaComoAdmin(_reservaId: string): Promise<void> { return this.error(); }
  async saveRecinto(_recinto: Omit<Recinto, "id"> & { id?: string }): Promise<void> { return this.error(); }
  async saveBloque(_bloque: Omit<Bloque, "id"> & { id?: string }): Promise<void> { return this.error(); }
}

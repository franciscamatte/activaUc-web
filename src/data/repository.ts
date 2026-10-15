import type {
  AsignacionAdministrador,
  AuditoriaReserva,
  Bloque,
  FiltrosCatalogo,
  Recinto,
  Reserva,
  Sesion,
  Usuario,
} from "../domain/types";

export interface AppSnapshot {
  usuarios: Usuario[];
  recintos: Recinto[];
  bloques: Bloque[];
  reservas: Reserva[];
  asignaciones: AsignacionAdministrador[];
  auditoria: AuditoriaReserva[];
  sesion: Sesion | null;
}

export interface ActivaRepository {
  getSnapshot(): Promise<AppSnapshot>;
  login(email: string, password: string): Promise<void>;
  register(nombre: string, email: string, password: string): Promise<void>;
  recoverPassword(email: string): Promise<void>;
  logout(): Promise<void>;
  saveProfile(data: Partial<Usuario>): Promise<void>;
  getBloquesFiltrados(filters: FiltrosCatalogo): Promise<Bloque[]>;
  reservar(bloqueId: string): Promise<void>;
  cancelarReservaComoUsuario(reservaId: string): Promise<void>;
  cancelarReservaComoAdmin(reservaId: string): Promise<void>;
  saveRecinto(recinto: Omit<Recinto, "id"> & { id?: string }): Promise<void>;
  saveBloque(bloque: Omit<Bloque, "id"> & { id?: string }): Promise<void>;
}

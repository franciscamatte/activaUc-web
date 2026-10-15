import { canReserveBlock, canUserCancelReservation } from "../domain/reservationRules";
import type {
  AuditoriaReserva,
  Bloque,
  EstadoMensaje,
  EstadoSincronizacion,
  FiltrosCatalogo,
  NotificacionResultado,
  Recinto,
  Reserva,
  Sesion,
  Usuario,
} from "../domain/types";
import { isPast, toTimeValue } from "../lib/date";
import { withRetry } from "../services/retry";
import { asignacionesSeed, bloquesSeed, recintosSeed, reservasSeed, usuariosSeed } from "./seed";
import type { ActivaRepository, AppSnapshot } from "./repository";

const STORAGE_KEY = "activauc-mock-state-v1";

interface PersistedState {
  usuarios: Usuario[];
  recintos: Recinto[];
  bloques: Bloque[];
  reservas: Reserva[];
  asignaciones: AppSnapshot["asignaciones"];
  auditoria: AuditoriaReserva[];
  sesion: Sesion | null;
}

const initialState: PersistedState = {
  usuarios: usuariosSeed,
  recintos: recintosSeed,
  bloques: bloquesSeed,
  reservas: reservasSeed.map((r) => ({
    ...r,
    whatsappRecordatorio: r.whatsappRecordatorio === "entregado" ? "entregado" : "omitido",
  })),
  asignaciones: asignacionesSeed,
  auditoria: [],
  sesion: null,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readState(): PersistedState {
  if (typeof window === "undefined") {
    return clone(initialState);
  }

  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return clone(initialState);
  }

  try {
    return JSON.parse(saved) as PersistedState;
  } catch {
    return clone(initialState);
  }
}

function writeState(state: PersistedState): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function evaluateIntegrations(user: Usuario, inicio: string): NotificacionResultado {
  const shouldRemind = new Date(inicio).getTime() - Date.now() >= 2 * 3600000;
  const calendarSync: EstadoSincronizacion = user.googleCalendarConectado
    ? "pendiente"
    : "error";
  const whatsappConfirmacion: EstadoMensaje = user.whatsappConsentido && user.telefono
    ? "enviado"
    : "omitido";
  const whatsappRecordatorio: EstadoMensaje = shouldRemind
    ? user.whatsappConsentido && user.telefono
      ? "pendiente"
      : "omitido"
    : "omitido";

  return { calendarSync, whatsappConfirmacion, whatsappRecordatorio };
}

async function simulateExternalSync(value: EstadoSincronizacion): Promise<EstadoSincronizacion> {
  if (value === "error") {
    return "error";
  }
  await withRetry(async () => {
    if (Math.random() < 0.1) {
      throw new Error("Error transitorio");
    }
    return true;
  });
  return "sincronizado";
}

export class MockRepository implements ActivaRepository {
  async getSnapshot(): Promise<AppSnapshot> {
    const state = readState();
    return clone(state);
  }

  async login(email: string, password: string): Promise<void> {
    const state = readState();
    const user = state.usuarios.find((u) => u.email.toLowerCase() === email.toLowerCase());

    if (!user) {
      throw new Error("Correo no registrado.");
    }
    if (user.password !== password) {
      throw new Error("Contraseña incorrecta.");
    }

    state.sesion = { usuarioId: user.id, rol: user.rol };
    writeState(state);
  }

  async register(nombre: string, email: string, password: string): Promise<void> {
    const state = readState();
    if (password.length < 8) {
      throw new Error("La contraseña debe tener al menos 8 caracteres.");
    }
    const exists = state.usuarios.some((u) => u.email.toLowerCase() === email.toLowerCase());
    if (exists) {
      throw new Error("El correo ya está registrado.");
    }

    const user: Usuario = {
      id: createId("u"),
      nombre,
      email,
      password,
      telefono: "",
      whatsappConsentido: false,
      googleCalendarConectado: false,
      rol: "usuario",
    };

    state.usuarios.push(user);
    state.sesion = { usuarioId: user.id, rol: user.rol };
    writeState(state);
  }

  async recoverPassword(email: string): Promise<void> {
    const state = readState();
    const found = state.usuarios.some((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!found) {
      throw new Error("No existe una cuenta asociada a ese correo.");
    }
  }

  async logout(): Promise<void> {
    const state = readState();
    state.sesion = null;
    writeState(state);
  }

  async saveProfile(data: Partial<Usuario>): Promise<void> {
    const state = readState();
    if (!state.sesion) {
      throw new Error("Debes iniciar sesión.");
    }
    const index = state.usuarios.findIndex((u) => u.id === state.sesion?.usuarioId);
    if (index < 0) {
      throw new Error("Usuario no encontrado.");
    }
    state.usuarios[index] = { ...state.usuarios[index], ...data };
    writeState(state);
  }

  async getBloquesFiltrados(filters: FiltrosCatalogo): Promise<Bloque[]> {
    const state = readState();
    const recintoById = new Map(state.recintos.map((r) => [r.id, r]));

    return state.bloques.filter((bloque) => {
      if (!bloque.activo) {
        return false;
      }

      const recinto = recintoById.get(bloque.recintoId);
      if (!recinto || !recinto.activo) {
        return false;
      }
      if (filters.tipoRecinto && recinto.tipo !== filters.tipoRecinto) {
        return false;
      }

      const startDate = new Date(bloque.inicio);
      if (filters.fecha && startDate.toISOString().slice(0, 10) !== filters.fecha) {
        return false;
      }

      if (filters.desde) {
        const blockStart = toTimeValue(startDate.toTimeString().slice(0, 5));
        if (blockStart < toTimeValue(filters.desde)) {
          return false;
        }
      }
      if (filters.hasta) {
        const blockEnd = toTimeValue(new Date(bloque.fin).toTimeString().slice(0, 5));
        if (blockEnd > toTimeValue(filters.hasta)) {
          return false;
        }
      }

      return true;
    });
  }

  async reservar(bloqueId: string): Promise<void> {
    const state = readState();
    if (!state.sesion) {
      throw new Error("Debes iniciar sesión para reservar.");
    }
    const bloque = state.bloques.find((b) => b.id === bloqueId && b.activo);
    if (!bloque) {
      throw new Error("Bloque no disponible.");
    }

    const validation = canReserveBlock(
      state.reservas,
      bloque,
      bloque.recintoId,
      state.sesion.usuarioId,
    );
    if (!validation.ok) {
      throw new Error(validation.reason);
    }

    const user = state.usuarios.find((u) => u.id === state.sesion?.usuarioId);
    if (!user) {
      throw new Error("Usuario no encontrado.");
    }

    const integrations = evaluateIntegrations(user, bloque.inicio);
    const reserva: Reserva = {
      id: createId("res"),
      usuarioId: state.sesion.usuarioId,
      recintoId: bloque.recintoId,
      bloqueId: bloque.id,
      inicio: bloque.inicio,
      fin: bloque.fin,
      estado: "vigente",
      creadaEn: new Date().toISOString(),
      ...integrations,
    };

    reserva.calendarSync = await simulateExternalSync(reserva.calendarSync);

    state.reservas.push(reserva);
    state.auditoria.push({
      id: createId("aud"),
      reservaId: reserva.id,
      accion: "creada",
      detalle: "Reserva creada por usuario.",
      actorId: user.id,
      fecha: new Date().toISOString(),
    });

    writeState(state);
  }

  async cancelarReservaComoUsuario(reservaId: string): Promise<void> {
    const state = readState();
    if (!state.sesion) {
      throw new Error("Debes iniciar sesión.");
    }

    const reserva = state.reservas.find((r) => r.id === reservaId);
    if (!reserva || reserva.estado !== "vigente") {
      throw new Error("No se encontró una reserva vigente.");
    }
    if (reserva.usuarioId !== state.sesion.usuarioId) {
      throw new Error("Solo puedes cancelar tus propias reservas.");
    }

    const validation = canUserCancelReservation(reserva.inicio, new Date().toISOString());
    if (!validation.ok) {
      throw new Error(validation.reason);
    }

    reserva.estado = "cancelada";
    state.auditoria.push({
      id: createId("aud"),
      reservaId: reserva.id,
      accion: "cancelada_usuario",
      detalle: "Cancelación realizada por usuario respetando regla de 2 horas.",
      actorId: state.sesion.usuarioId,
      fecha: new Date().toISOString(),
    });
    writeState(state);
  }

  async cancelarReservaComoAdmin(reservaId: string): Promise<void> {
    const state = readState();
    if (!state.sesion || state.sesion.rol !== "administrador") {
      throw new Error("Acceso restringido a administradores.");
    }

    const reserva = state.reservas.find((r) => r.id === reservaId);
    if (!reserva || reserva.estado !== "vigente") {
      throw new Error("No se encontró una reserva vigente.");
    }

    const allowed = state.asignaciones.some(
      (a) =>
        a.administradorId === state.sesion?.usuarioId && a.recintoId === reserva.recintoId,
    );
    if (!allowed) {
      throw new Error("Solo puedes gestionar recintos asignados.");
    }

    reserva.estado = "cancelada";
    reserva.whatsappConfirmacion = reserva.whatsappConfirmacion === "omitido" ? "omitido" : "enviado";
    state.auditoria.push({
      id: createId("aud"),
      reservaId: reserva.id,
      accion: "cancelada_admin",
      detalle: "Cancelación administrativa sin restricción de anticipación.",
      actorId: state.sesion.usuarioId,
      fecha: new Date().toISOString(),
    });

    writeState(state);
  }

  async saveRecinto(recinto: Omit<Recinto, "id"> & { id?: string }): Promise<void> {
    const state = readState();
    if (!state.sesion || state.sesion.rol !== "administrador") {
      throw new Error("Acceso restringido.");
    }

    if (recinto.id) {
      const idx = state.recintos.findIndex((r) => r.id === recinto.id);
      if (idx >= 0) {
        state.recintos[idx] = { ...state.recintos[idx], ...recinto };
      }
    } else {
      state.recintos.push({ ...recinto, id: createId("r") });
    }

    writeState(state);
  }

  async saveBloque(bloque: Omit<Bloque, "id"> & { id?: string }): Promise<void> {
    const state = readState();
    if (!state.sesion || state.sesion.rol !== "administrador") {
      throw new Error("Acceso restringido.");
    }

    if (bloque.id) {
      const idx = state.bloques.findIndex((b) => b.id === bloque.id);
      if (idx >= 0) {
        state.bloques[idx] = { ...state.bloques[idx], ...bloque };
      }
    } else {
      state.bloques.push({ ...bloque, id: createId("b") });
    }

    writeState(state);
  }
}

export const repository = new MockRepository();

export function computeReservationStatus(reserva: Reserva): Reserva {
  if (reserva.estado !== "vigente") {
    return reserva;
  }
  if (isPast(reserva.fin)) {
    return { ...reserva, estado: "pasada" };
  }
  return reserva;
}

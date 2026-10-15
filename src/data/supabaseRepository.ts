import type { SupabaseClient } from "@supabase/supabase-js";
import { canUserCancelReservation } from "../domain/reservationRules";
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
import { toTimeValue } from "../lib/date";
import type { ActivaRepository, AppSnapshot } from "./repository";

interface ProfileRow {
  id: string;
  full_name: string;
  phone: string | null;
  whatsapp_consent: boolean;
  google_calendar_connected: boolean;
  role: "usuario" | "administrador";
}

interface FacilityRow {
  id: string;
  name: string;
  facility_type: string;
  description: string;
  operation_hours: string;
  active: boolean;
}

interface BlockRow {
  id: string;
  facility_id: string;
  starts_at: string;
  ends_at: string;
  max_capacity: number;
  active: boolean;
}

interface ReservationRow {
  id: string;
  user_id: string;
  facility_id: string;
  block_id: string;
  starts_at: string;
  ends_at: string;
  status: "vigente" | "cancelada" | "pasada";
  created_at: string;
  calendar_sync_status: "sincronizado" | "pendiente" | "error";
  whatsapp_confirmation_status:
    | "enviado"
    | "entregado"
    | "fallido"
    | "omitido"
    | "pendiente";
  whatsapp_reminder_status:
    | "enviado"
    | "entregado"
    | "fallido"
    | "omitido"
    | "pendiente";
}

function mapProfile(row: ProfileRow, email = ""): Usuario {
  return {
    id: row.id,
    nombre: row.full_name,
    email,
    password: "",
    telefono: row.phone ?? "",
    whatsappConsentido: row.whatsapp_consent,
    googleCalendarConectado: row.google_calendar_connected,
    rol: row.role,
  };
}

function mapFacility(row: FacilityRow): Recinto {
  return {
    id: row.id,
    nombre: row.name,
    tipo: row.facility_type,
    descripcion: row.description,
    horarioFuncionamiento: row.operation_hours,
    activo: row.active,
  };
}

function mapBlock(row: BlockRow): Bloque {
  return {
    id: row.id,
    recintoId: row.facility_id,
    inicio: row.starts_at,
    fin: row.ends_at,
    capacidadMaxima: row.max_capacity,
    activo: row.active,
  };
}

function mapReservation(row: ReservationRow): Reserva {
  return {
    id: row.id,
    usuarioId: row.user_id,
    recintoId: row.facility_id,
    bloqueId: row.block_id,
    inicio: row.starts_at,
    fin: row.ends_at,
    estado: row.status,
    creadaEn: row.created_at,
    calendarSync: row.calendar_sync_status,
    whatsappConfirmacion: row.whatsapp_confirmation_status,
    whatsappRecordatorio: row.whatsapp_reminder_status,
  };
}

export class SupabaseRepository implements ActivaRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async getCurrentSession(): Promise<Sesion | null> {
    const { data } = await this.client.auth.getSession();
    if (!data.session?.user) {
      return null;
    }

    const { data: profile, error } = await this.client
      .from("profiles")
      .select("role")
      .eq("id", data.session.user.id)
      .single();

    if (error || !profile) {
      return { usuarioId: data.session.user.id, rol: "usuario" };
    }

    return {
      usuarioId: data.session.user.id,
      rol: profile.role,
    };
  }

  private async getCurrentUserId(): Promise<string> {
    const { data } = await this.client.auth.getUser();
    if (!data.user) {
      throw new Error("Debes iniciar sesión.");
    }
    return data.user.id;
  }

  async getSnapshot(): Promise<AppSnapshot> {
    const sesion = await this.getCurrentSession();

    const [facilitiesRes, blocksRes, reservationsRes] = await Promise.all([
      this.client.from("facilities").select("*").order("name", { ascending: true }),
      this.client.from("time_blocks").select("*").order("starts_at", { ascending: true }),
      this.client
        .from("reservations")
        .select("*")
        .order("starts_at", { ascending: false }),
    ]);

    if (facilitiesRes.error) {
      throw new Error(facilitiesRes.error.message);
    }
    if (blocksRes.error) {
      throw new Error(blocksRes.error.message);
    }
    if (reservationsRes.error) {
      throw new Error(reservationsRes.error.message);
    }

    const recintos = (facilitiesRes.data as FacilityRow[]).map(mapFacility);
    const bloques = (blocksRes.data as BlockRow[]).map(mapBlock);
    const reservas = (reservationsRes.data as ReservationRow[]).map(mapReservation);

    let usuarios: Usuario[] = [];
    let asignaciones: AsignacionAdministrador[] = [];
    let auditoria: AuditoriaReserva[] = [];

    if (sesion) {
      const [{ data: profiles }, { data: assignments }, { data: logs }] = await Promise.all([
        this.client
          .from("profiles")
          .select("id, full_name, phone, whatsapp_consent, google_calendar_connected, role"),
        this.client.from("facility_admin_assignments").select("*").eq("admin_id", sesion.usuarioId),
        this.client
          .from("reservation_audit_log")
          .select("id, reservation_id, action, actor_id, details, created_at")
          .order("created_at", { ascending: false })
          .limit(200),
      ]);

      const { data: authUser } = await this.client.auth.getUser();

      usuarios = (profiles ?? []).map((profile) =>
        mapProfile(profile as ProfileRow, profile.id === authUser.user?.id ? authUser.user.email ?? "" : ""),
      );

      asignaciones = (assignments ?? []).map((a) => ({
        id: a.id,
        administradorId: a.admin_id,
        recintoId: a.facility_id,
      }));

      auditoria = (logs ?? []).map((log) => ({
        id: log.id,
        reservaId: log.reservation_id,
        accion: log.action,
        actorId: log.actor_id,
        detalle: log.details ?? "",
        fecha: log.created_at,
      }));
    }

    return {
      usuarios,
      recintos,
      bloques,
      reservas,
      asignaciones,
      auditoria,
      sesion,
    };
  }

  async login(email: string, password: string): Promise<void> {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.toLowerCase().includes("invalid login")) {
        throw new Error("Correo o contraseña inválidos.");
      }
      throw new Error(error.message);
    }
  }

  async register(nombre: string, email: string, password: string): Promise<void> {
    if (password.length < 8) {
      throw new Error("La contraseña debe tener al menos 8 caracteres.");
    }

    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: nombre,
        },
      },
    });

    if (error) {
      throw new Error(error.message);
    }

    if (data.user) {
      const { error: profileError } = await this.client.from("profiles").upsert(
        {
          id: data.user.id,
          full_name: nombre,
          role: "usuario",
        },
        { onConflict: "id" },
      );
      if (profileError) {
        throw new Error(profileError.message);
      }
    }
  }

  async recoverPassword(email: string): Promise<void> {
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    if (error) {
      throw new Error(error.message);
    }
  }

  async logout(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) {
      throw new Error(error.message);
    }
  }

  async saveProfile(data: Partial<Usuario>): Promise<void> {
    const userId = await this.getCurrentUserId();
    const payload: Record<string, unknown> = {};

    if (typeof data.nombre === "string") {
      payload.full_name = data.nombre;
    }
    if (typeof data.telefono === "string") {
      payload.phone = data.telefono;
    }
    if (typeof data.whatsappConsentido === "boolean") {
      payload.whatsapp_consent = data.whatsappConsentido;
    }
    if (typeof data.googleCalendarConectado === "boolean") {
      payload.google_calendar_connected = data.googleCalendarConectado;
    }

    const { error } = await this.client.from("profiles").update(payload).eq("id", userId);
    if (error) {
      throw new Error(error.message);
    }
  }

  async getBloquesFiltrados(filters: FiltrosCatalogo): Promise<Bloque[]> {
    let query = this.client
      .from("time_blocks")
      .select("id, facility_id, starts_at, ends_at, max_capacity, active, facilities!inner(facility_type, active)")
      .eq("active", true)
      .eq("facilities.active", true)
      .order("starts_at", { ascending: true });

    if (filters.tipoRecinto) {
      query = query.eq("facilities.facility_type", filters.tipoRecinto);
    }

    if (filters.fecha) {
      const start = new Date(`${filters.fecha}T00:00:00`).toISOString();
      const end = new Date(`${filters.fecha}T23:59:59`).toISOString();
      query = query.gte("starts_at", start).lte("starts_at", end);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }

    let blocks = (data as BlockRow[]).map(mapBlock);

    if (filters.desde) {
      const min = toTimeValue(filters.desde);
      blocks = blocks.filter((b) => toTimeValue(new Date(b.inicio).toTimeString().slice(0, 5)) >= min);
    }

    if (filters.hasta) {
      const max = toTimeValue(filters.hasta);
      blocks = blocks.filter((b) => toTimeValue(new Date(b.fin).toTimeString().slice(0, 5)) <= max);
    }

    return blocks;
  }

  async reservar(bloqueId: string): Promise<void> {
    const { error } = await this.client.rpc("create_reservation_strict", {
      _block_id: bloqueId,
    });
    if (error) {
      throw new Error(error.message);
    }
  }

  async cancelarReservaComoUsuario(reservaId: string): Promise<void> {
    const userId = await this.getCurrentUserId();
    const { data, error } = await this.client
      .from("reservations")
      .select("id, starts_at, user_id, status")
      .eq("id", reservaId)
      .single();

    if (error || !data) {
      throw new Error("No se encontró la reserva.");
    }

    if (data.user_id !== userId) {
      throw new Error("Solo puedes cancelar tus propias reservas.");
    }

    const validation = canUserCancelReservation(data.starts_at, new Date().toISOString());
    if (!validation.ok) {
      throw new Error(validation.reason);
    }

    const { error: updateError } = await this.client
      .from("reservations")
      .update({ status: "cancelada" })
      .eq("id", reservaId)
      .eq("status", "vigente");

    if (updateError) {
      throw new Error(updateError.message);
    }
  }

  async cancelarReservaComoAdmin(reservaId: string): Promise<void> {
    const { error } = await this.client
      .from("reservations")
      .update({ status: "cancelada" })
      .eq("id", reservaId)
      .eq("status", "vigente");

    if (error) {
      throw new Error(error.message);
    }
  }

  async saveRecinto(recinto: Omit<Recinto, "id"> & { id?: string }): Promise<void> {
    const payload = {
      name: recinto.nombre,
      facility_type: recinto.tipo,
      description: recinto.descripcion,
      operation_hours: recinto.horarioFuncionamiento,
      active: recinto.activo,
    };

    if (recinto.id) {
      const { error } = await this.client.from("facilities").update(payload).eq("id", recinto.id);
      if (error) {
        throw new Error(error.message);
      }
      return;
    }

    const { data, error } = await this.client.from("facilities").insert(payload).select("id").single();
    if (error) {
      throw new Error(error.message);
    }

    const adminId = await this.getCurrentUserId();
    await this.client.from("facility_admin_assignments").upsert(
      {
        admin_id: adminId,
        facility_id: data.id,
      },
      { onConflict: "admin_id,facility_id" },
    );
  }

  async saveBloque(bloque: Omit<Bloque, "id"> & { id?: string }): Promise<void> {
    const payload = {
      facility_id: bloque.recintoId,
      starts_at: bloque.inicio,
      ends_at: bloque.fin,
      max_capacity: bloque.capacidadMaxima,
      active: bloque.activo,
    };

    if (bloque.id) {
      const { error } = await this.client.from("time_blocks").update(payload).eq("id", bloque.id);
      if (error) {
        throw new Error(error.message);
      }
      return;
    }

    const { error } = await this.client.from("time_blocks").insert(payload);
    if (error) {
      throw new Error(error.message);
    }
  }
}

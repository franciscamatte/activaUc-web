/**
 * Implementación real del acceso a datos sobre Supabase.
 *
 * Principios aplicados:
 *   · Las escrituras de reservas nunca son UPDATE/INSERT directos: van
 *     por create_reservation_strict y cancel_reservation, que son
 *     transaccionales y validan identidad y rol en el servidor.
 *   · La disponibilidad pública se lee de la vista block_availability,
 *     que sólo expone agregados.
 *   · Las integraciones (OAuth de Google, WhatsApp) se operan mediante
 *     Edge Functions; el navegador nunca ve una credencial externa.
 */

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { AppError, aAppError } from "../lib/errors";
import { conReintentos } from "../lib/retry";
import { config } from "../lib/env";
import { invocarFuncion } from "../lib/supabase";
import { dentroDelRangoHorario } from "../domain/reservationRules";
import { normalizarTelefono } from "../domain/phone";
import type {
  Bloque,
  ConexionCalendario,
  Disponibilidad,
  EntradaAuditoria,
  EstadoSincronizacion,
  FiltrosCatalogo,
  IncidenciaIntegracion,
  Perfil,
  Recinto,
  Reserva,
  ReservaAdmin,
  ResultadoCancelacion,
  ResultadoReserva,
  Rol,
} from "../domain/types";
import type {
  TipoVerificacion,
  ActivaRepository,
  DatosBloque,
  DatosRecinto,
  DatosSerieBloques,
  OyenteSesion,
  ResultadoDesactivacionSerie,
  ResultadoSerie,
  SesionActual,
} from "./repository";
import {
  aAuditoria,
  aBloque,
  aConexionCalendario,
  aDisponibilidad,
  aIncidencia,
  aPerfil,
  aRecinto,
  aReserva,
  aReservaAdmin,
  type FilaAuditoria,
  type FilaBloque,
  type FilaConexionCalendario,
  type FilaDisponibilidad,
  type FilaIncidencia,
  type FilaPerfil,
  type FilaRecinto,
  type FilaReserva,
  type FilaReservaAdmin,
} from "./rows";

/** Respuesta cruda de create_reservation_strict. */
interface RespuestaCrearReserva {
  ok: boolean;
  duplicada?: boolean;
  reservation_id?: string;
  error?: string;
  mensaje: string;
  calendar_sync_status?: EstadoSincronizacion;
  whatsapp_confirmacion?: string;
  whatsapp_recordatorio?: string;
  recordatorio_programado_para?: string | null;
  cupos_disponibles?: number;
}

/** Respuesta cruda de admin_create_block_series. */
interface RespuestaSerie {
  ok: boolean;
  simulado?: boolean;
  creados?: number;
  omitidos_existentes?: number;
  omitidos_pasado?: number;
  previstos?: number;
  primer_bloque?: string | null;
  ultimo_bloque?: string | null;
  muestra?: Array<{ inicio: string; fin: string }>;
  error?: string;
  mensaje: string;
}

/** Respuesta cruda de admin_deactivate_block_series. */
interface RespuestaDesactivacionSerie {
  ok: boolean;
  simulado?: boolean;
  afectados?: number;
  con_reservas_vigentes?: number;
  error?: string;
  mensaje: string;
}

/** Respuesta cruda de cancel_reservation. */
interface RespuestaCancelar {
  ok: boolean;
  ya_cancelada?: boolean;
  error?: string;
  mensaje: string;
  cancelado_por?: Rol;
  notificacion_whatsapp?: boolean;
}

export class SupabaseRepository implements ActivaRepository {
  // Campo explícito en lugar de una propiedad de parámetro, porque el
  // proyecto compila con erasableSyntaxOnly (sin sintaxis que requiera
  // transformación en tiempo de ejecución).
  private readonly cliente: SupabaseClient;

  constructor(cliente: SupabaseClient) {
    this.cliente = cliente;
  }

  // =================================================================
  // Sesión
  // =================================================================

  async obtenerSesion(): Promise<SesionActual | null> {
    const { data, error } = await this.cliente.auth.getSession();
    if (error) throw aAppError(error, "recuperar la sesión");
    if (!data.session?.user) return null;

    return {
      usuarioId: data.session.user.id,
      correo: data.session.user.email ?? "",
      expiraEn: data.session.expires_at ?? null,
    };
  }

  escucharSesion(oyente: OyenteSesion): () => void {
    const { data } = this.cliente.auth.onAuthStateChange((evento, sesion) => {
      const actual: SesionActual | null = sesion?.user
        ? {
          usuarioId: sesion.user.id,
          correo: sesion.user.email ?? "",
          expiraEn: sesion.expires_at ?? null,
        }
        : null;

      switch (evento) {
        case "SIGNED_IN":
        case "INITIAL_SESSION":
          if (actual) oyente("iniciada", actual);
          break;
        case "TOKEN_REFRESHED":
          oyente("renovada", actual);
          break;
        case "USER_UPDATED":
          oyente("renovada", actual);
          break;
        case "SIGNED_OUT":
          oyente("cerrada", null);
          break;
        default:
          break;
      }
    });

    return () => data.subscription.unsubscribe();
  }

  async registrarse(datos: {
    nombre: string;
    correo: string;
    contrasena: string;
  }): Promise<{ requiereConfirmacion: boolean }> {
    if (datos.contrasena.length < 8) {
      throw new AppError("contrasena_debil", "La contraseña debe tener al menos 8 caracteres.");
    }
    if (datos.nombre.trim().length < 2) {
      throw new AppError("conflicto", "Ingresa tu nombre completo.");
    }

    const { data, error } = await this.cliente.auth.signUp({
      email: datos.correo.trim().toLowerCase(),
      password: datos.contrasena,
      options: {
        // El perfil lo crea el disparador on_auth_user_created leyendo
        // este metadato; el cliente no escribe en public.profiles.
        data: { full_name: datos.nombre.trim() },
        emailRedirectTo: `${config.appUrl}/auth/callback`,
      },
    });

    if (error) throw aAppError(error, "crear la cuenta");

    // Supabase devuelve un usuario sin sesión cuando la confirmación de
    // correo está activada. Si además devuelve identities vacío, el
    // correo ya existía (no lo revela por seguridad, pero lo deducimos).
    if (data.user && data.user.identities?.length === 0) {
      throw new AppError(
        "correo_en_uso",
        "Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.",
      );
    }

    return { requiereConfirmacion: data.session === null };
  }

  async iniciarSesion(correo: string, contrasena: string): Promise<void> {
    const { error } = await this.cliente.auth.signInWithPassword({
      email: correo.trim().toLowerCase(),
      password: contrasena,
    });
    if (error) throw aAppError(error, "iniciar sesión");
  }

  async cerrarSesion(): Promise<void> {
    const { error } = await this.cliente.auth.signOut();
    // Si la sesión ya no existía en el servidor, el cierre local basta.
    if (error && !/session|not found/i.test(error.message)) {
      throw aAppError(error, "cerrar sesión");
    }
  }

  async solicitarRecuperacion(correo: string): Promise<void> {
    const { error } = await this.cliente.auth.resetPasswordForEmail(
      correo.trim().toLowerCase(),
      { redirectTo: `${config.appUrl}/restablecer-contrasena` },
    );
    if (error) throw aAppError(error, "solicitar la recuperación");
  }

  async definirNuevaContrasena(contrasena: string): Promise<void> {
    if (contrasena.length < 8) {
      throw new AppError("contrasena_debil", "La contraseña debe tener al menos 8 caracteres.");
    }
    const { error } = await this.cliente.auth.updateUser({ password: contrasena });
    if (error) throw aAppError(error, "actualizar la contraseña");
  }

  async verificarCodigo(datos: {
    correo: string;
    codigo: string;
    tipo: TipoVerificacion;
  }): Promise<void> {
    const codigo = datos.codigo.replace(/\D/g, "");
    if (codigo.length !== 6) {
      throw new AppError("conflicto", "El código son 6 dígitos.");
    }

    const { error } = await this.cliente.auth.verifyOtp({
      email: datos.correo.trim().toLowerCase(),
      token: codigo,
      // 'email' confirma el alta; 'recovery' abre la sesión temporal
      // que permite definir una contraseña nueva.
      type: datos.tipo === "registro" ? "email" : "recovery",
    });

    if (error) throw aAppError(error, "verificar el código");
  }

  async reenviarConfirmacion(correo: string): Promise<void> {
    const { error } = await this.cliente.auth.resend({
      type: "signup",
      email: correo.trim().toLowerCase(),
      options: { emailRedirectTo: `${config.appUrl}/auth/callback` },
    });
    if (error) throw aAppError(error, "reenviar la confirmación");
  }

  // =================================================================
  // Perfil
  // =================================================================

  async obtenerPerfil(): Promise<Perfil | null> {
    const sesion = await this.obtenerSesion();
    if (!sesion) return null;

    return await conReintentos(async () => {
      const { data, error } = await this.cliente
        .from("profiles")
        .select("id, full_name, phone, whatsapp_consent, whatsapp_consent_at, role")
        .eq("id", sesion.usuarioId)
        .maybeSingle<FilaPerfil>();

      if (error) throw aAppError(error, "cargar tu perfil");
      if (!data) {
        // El disparador crea el perfil al confirmarse el registro; si
        // todavía no existe, lo informamos sin inventar datos.
        throw new AppError(
          "no_encontrado",
          "Tu perfil aún se está creando. Recarga la página en unos segundos.",
          true,
        );
      }
      return aPerfil(data, sesion.correo);
    });
  }

  async actualizarNombre(nombre: string): Promise<void> {
    const limpio = nombre.trim();
    if (limpio.length < 2 || limpio.length > 120) {
      throw new AppError("conflicto", "El nombre debe tener entre 2 y 120 caracteres.");
    }

    const sesion = await this.exigirSesion();
    const { error } = await this.cliente
      .from("profiles")
      .update({ full_name: limpio })
      .eq("id", sesion.usuarioId);

    if (error) throw aAppError(error, "guardar tu nombre");
  }

  async definirConsentimientoWhatsapp(
    telefono: string | null,
    consentido: boolean,
  ): Promise<{ ok: boolean; mensaje: string }> {
    await this.exigirSesion();

    const { data, error } = await this.cliente.rpc("set_whatsapp_consent", {
      _phone: consentido ? normalizarTelefono(telefono ?? "") : null,
      _consent: consentido,
    });

    if (error) throw aAppError(error, "guardar tus preferencias de WhatsApp");

    const respuesta = data as { ok: boolean; mensaje?: string; error?: string };
    if (!respuesta.ok) {
      return {
        ok: false,
        mensaje: respuesta.mensaje ?? "No pudimos guardar tus preferencias de WhatsApp.",
      };
    }

    return {
      ok: true,
      mensaje: consentido
        ? "Registramos tu número. Recibirás confirmaciones y recordatorios por WhatsApp."
        : "Eliminamos tu número y revocamos el consentimiento. No recibirás más mensajes.",
    };
  }

  // =================================================================
  // Catálogo y disponibilidad
  // =================================================================

  async listarRecintos(): Promise<Recinto[]> {
    return await conReintentos(async () => {
      const { data, error } = await this.cliente
        .from("facilities")
        .select("id, name, facility_type, description, operation_hours, active")
        .eq("active", true)
        .order("name", { ascending: true });

      if (error) throw aAppError(error, "cargar los recintos");
      return (data as FilaRecinto[]).map(aRecinto);
    });
  }

  /**
   * REQ-9, REQ-10, REQ-11 · disponibilidad con filtros.
   *
   * Fecha, tipo de recinto y recinto se filtran en PostgreSQL. El rango
   * horario se aplica en el cliente porque depende de la zona horaria de
   * presentación y la vista almacena instantes en UTC.
   */
  async consultarDisponibilidad(filtros: FiltrosCatalogo): Promise<Disponibilidad[]> {
    return await conReintentos(async () => {
      let consulta = this.cliente
        .from("block_availability")
        .select(
          "block_id, facility_id, facility_name, facility_type, facility_description, " +
          "facility_operation_hours, starts_at, ends_at, max_capacity, reserved_count, " +
          "available_count, is_full, is_past",
        )
        .order("starts_at", { ascending: true })
        .limit(500);

      if (filtros.tipoRecinto) {
        consulta = consulta.eq("facility_type", filtros.tipoRecinto);
      }
      if (filtros.recintoId) {
        consulta = consulta.eq("facility_id", filtros.recintoId);
      }

      if (filtros.fechaDesde) {
        consulta = consulta.gte("starts_at", inicioDelDia(filtros.fechaDesde));
        const hasta = filtros.fechaHasta || filtros.fechaDesde;
        consulta = consulta.lte("starts_at", finDelDia(hasta));
      } else {
        // Sin filtro de fecha se muestran los bloques que aún no empiezan.
        consulta = consulta.gte("starts_at", new Date().toISOString());
      }

      const { data, error } = await consulta;
      if (error) throw aAppError(error, "consultar la disponibilidad");

      let bloques = ((data ?? []) as unknown as FilaDisponibilidad[]).map(aDisponibilidad);

      if (filtros.horaDesde || filtros.horaHasta) {
        bloques = bloques.filter((b) =>
          dentroDelRangoHorario(b, filtros.horaDesde, filtros.horaHasta, config.timeZone),
        );
      }
      if (filtros.soloConCupos) {
        bloques = bloques.filter((b) => !b.agotado && !b.iniciado);
      }

      return bloques;
    });
  }

  /**
   * REQ-9 · disponibilidad en vivo mediante Supabase Realtime.
   *
   * Se escuchan las tablas cuyos cambios alteran los cupos mostrados:
   *   · reservations → creación y cancelación de reservas
   *   · time_blocks  → cambios de capacidad y desactivación de bloques
   *   · facilities   → desactivación de recintos
   *
   * Realtime respeta RLS, así que un visitante anónimo no recibe eventos
   * de reservations. El llamador complementa con un refresco periódico
   * (ver src/state/useDisponibilidad.ts).
   */
  observarDisponibilidad(alCambiar: () => void): () => void {
    let canal: RealtimeChannel | null = null;
    let cancelado = false;

    // Un nombre único por suscripción evita canales duplicados cuando
    // React monta el componente dos veces en modo estricto.
    const nombre = `disponibilidad:${Math.random().toString(36).slice(2)}`;

    canal = this.cliente
      .channel(nombre)
      .on("postgres_changes", { event: "*", schema: "public", table: "reservations" }, alCambiar)
      .on("postgres_changes", { event: "*", schema: "public", table: "time_blocks" }, alCambiar)
      .on("postgres_changes", { event: "*", schema: "public", table: "facilities" }, alCambiar)
      .subscribe();

    return () => {
      if (cancelado) return;
      cancelado = true;
      if (canal) {
        void this.cliente.removeChannel(canal);
        canal = null;
      }
    };
  }

  // =================================================================
  // Reservas
  // =================================================================

  async listarMisReservas(): Promise<Reserva[]> {
    const sesion = await this.obtenerSesion();
    if (!sesion) return [];

    return await conReintentos(async () => {
      const { data, error } = await this.cliente
        .from("my_reservations")
        .select("*")
        .eq("user_id", sesion.usuarioId)
        .order("starts_at", { ascending: false })
        .limit(300);

      if (error) throw aAppError(error, "cargar tus reservas");
      return ((data ?? []) as unknown as FilaReserva[]).map(aReserva);
    });
  }

  /** REQ-12, REQ-13, REQ-16 · única vía de creación de reservas. */
  async crearReserva(bloqueId: string, idSolicitud?: string): Promise<ResultadoReserva> {
    await this.exigirSesion();

    const { data, error } = await this.cliente.rpc("create_reservation_strict", {
      _block_id: bloqueId,
      _client_request_id: idSolicitud ?? null,
    });

    if (error) throw aAppError(error, "confirmar la reserva");

    const r = data as RespuestaCrearReserva;
    return {
      ok: r.ok,
      duplicada: r.duplicada,
      reservaId: r.reservation_id,
      error: r.error,
      mensaje: r.mensaje,
      calendarSync: r.calendar_sync_status,
      whatsappConfirmacion: r.whatsapp_confirmacion,
      whatsappRecordatorio: r.whatsapp_recordatorio,
      recordatorioProgramadoPara: r.recordatorio_programado_para ?? null,
      cuposDisponibles: r.cupos_disponibles,
    };
  }

  /** REQ-15, REQ-32 · el backend decide según el rol real del solicitante. */
  async cancelarReserva(reservaId: string, motivo?: string): Promise<ResultadoCancelacion> {
    await this.exigirSesion();

    const { data, error } = await this.cliente.rpc("cancel_reservation", {
      _reservation_id: reservaId,
      _reason: motivo?.trim() || null,
    });

    if (error) throw aAppError(error, "cancelar la reserva");

    const r = data as RespuestaCancelar;
    return {
      ok: r.ok,
      yaCancelada: r.ya_cancelada,
      error: r.error,
      mensaje: r.mensaje,
      canceladoPor: r.cancelado_por,
      notificacionWhatsapp: r.notificacion_whatsapp,
    };
  }

  // =================================================================
  // Google Calendar (REQ-17)
  // =================================================================

  async obtenerConexionCalendario(): Promise<ConexionCalendario> {
    const sesion = await this.obtenerSesion();
    if (!sesion) return aConexionCalendario(null);

    const { data, error } = await this.cliente
      .from("calendar_connections")
      .select("status, google_account_email, connected_at, revoked_at, last_error")
      .eq("user_id", sesion.usuarioId)
      .maybeSingle<FilaConexionCalendario>();

    if (error) throw aAppError(error, "consultar tu conexión con Google Calendar");
    return aConexionCalendario(data);
  }

  async iniciarConexionCalendario(rutaRetorno: string): Promise<string> {
    await this.exigirSesion();

    const respuesta = await invocarFuncion<{
      ok: boolean;
      authorizationUrl?: string;
      mensaje?: string;
    }>("google-oauth-start", { redirectPath: rutaRetorno });

    if (!respuesta.ok || !respuesta.authorizationUrl) {
      throw new AppError(
        "integracion",
        respuesta.mensaje ?? "No pudimos iniciar la conexión con Google Calendar.",
      );
    }

    return respuesta.authorizationUrl;
  }

  async desconectarCalendario(): Promise<{ mensaje: string }> {
    await this.exigirSesion();

    const respuesta = await invocarFuncion<{ ok: boolean; mensaje?: string }>(
      "google-calendar-disconnect",
    );

    if (!respuesta.ok) {
      throw new AppError(
        "integracion",
        respuesta.mensaje ?? "No pudimos desconectar tu cuenta de Google Calendar.",
      );
    }

    return {
      mensaje: respuesta.mensaje ??
        "Desconectamos tu cuenta de Google Calendar. Tus reservas siguen vigentes.",
    };
  }

  // =================================================================
  // Administración (REQ-28 a REQ-33)
  // =================================================================

  /**
   * Recintos asignados al administrador. La política RLS
   * facilities_select_assigned_admin permite ver también los
   * desactivados, de modo que pueda reactivarlos.
   */
  async listarRecintosAsignados(): Promise<Recinto[]> {
    const sesion = await this.exigirSesion();

    const { data: asignaciones, error: errorAsignaciones } = await this.cliente
      .from("facility_admin_assignments")
      .select("facility_id")
      .eq("admin_id", sesion.usuarioId);

    if (errorAsignaciones) {
      throw aAppError(errorAsignaciones, "cargar tus recintos asignados");
    }

    const ids = (asignaciones ?? []).map((a) => (a as { facility_id: string }).facility_id);
    if (ids.length === 0) return [];

    const { data, error } = await this.cliente
      .from("facilities")
      .select("id, name, facility_type, description, operation_hours, active")
      .in("id", ids)
      .order("name", { ascending: true });

    if (error) throw aAppError(error, "cargar tus recintos asignados");
    return (data as FilaRecinto[]).map(aRecinto);
  }

  /** Crea el recinto y lo autoasigna de forma atómica (REQ-28, REQ-29). */
  async crearRecinto(datos: DatosRecinto): Promise<{ ok: boolean; mensaje: string }> {
    await this.exigirSesion();

    const { data, error } = await this.cliente.rpc("admin_create_facility", {
      _name: datos.nombre.trim(),
      _facility_type: datos.tipo.trim(),
      _description: datos.descripcion.trim(),
      _operation_hours: datos.horarioFuncionamiento.trim(),
    });

    if (error) throw aAppError(error, "crear el recinto");

    const r = data as { ok: boolean; mensaje?: string };
    return {
      ok: r.ok,
      mensaje: r.mensaje ?? (r.ok ? "Recinto creado." : "No pudimos crear el recinto."),
    };
  }

  async actualizarRecinto(recintoId: string, datos: Partial<DatosRecinto>): Promise<void> {
    await this.exigirSesion();

    const payload: Record<string, unknown> = {};
    if (datos.nombre !== undefined) payload.name = datos.nombre.trim();
    if (datos.tipo !== undefined) payload.facility_type = datos.tipo.trim();
    if (datos.descripcion !== undefined) payload.description = datos.descripcion.trim();
    if (datos.horarioFuncionamiento !== undefined) {
      payload.operation_hours = datos.horarioFuncionamiento.trim();
    }
    if (datos.activo !== undefined) payload.active = datos.activo;

    if (Object.keys(payload).length === 0) return;

    // RLS acota la actualización a los recintos asignados; si el
    // administrador no lo tiene asignado, no se afecta ninguna fila.
    const { data, error } = await this.cliente
      .from("facilities")
      .update(payload)
      .eq("id", recintoId)
      .select("id");

    if (error) throw aAppError(error, "actualizar el recinto");
    if (!data || data.length === 0) {
      throw new AppError("permisos", "No administras ese recinto.");
    }
  }

  async listarBloques(recintoId: string): Promise<Bloque[]> {
    await this.exigirSesion();

    const { data, error } = await this.cliente
      .from("time_blocks")
      .select("id, facility_id, starts_at, ends_at, max_capacity, active")
      .eq("facility_id", recintoId)
      .order("starts_at", { ascending: true })
      .limit(500);

    if (error) throw aAppError(error, "cargar los bloques horarios");
    return (data as FilaBloque[]).map(aBloque);
  }

  async crearBloque(datos: DatosBloque): Promise<void> {
    await this.exigirSesion();

    const { error } = await this.cliente.from("time_blocks").insert({
      facility_id: datos.recintoId,
      starts_at: datos.inicio,
      ends_at: datos.fin,
      max_capacity: datos.capacidadMaxima,
      active: datos.activo,
    });

    if (error) {
      if (error.code === "23505") {
        throw new AppError(
          "conflicto",
          "Ya existe un bloque activo que comienza a esa hora en este recinto.",
        );
      }
      throw aAppError(error, "crear el bloque horario");
    }
  }

  async actualizarBloque(bloqueId: string, datos: Partial<DatosBloque>): Promise<void> {
    await this.exigirSesion();

    const payload: Record<string, unknown> = {};
    if (datos.inicio !== undefined) payload.starts_at = datos.inicio;
    if (datos.fin !== undefined) payload.ends_at = datos.fin;
    if (datos.capacidadMaxima !== undefined) payload.max_capacity = datos.capacidadMaxima;
    if (datos.activo !== undefined) payload.active = datos.activo;

    if (Object.keys(payload).length === 0) return;

    const { data, error } = await this.cliente
      .from("time_blocks")
      .update(payload)
      .eq("id", bloqueId)
      .select("id");

    if (error) throw aAppError(error, "actualizar el bloque horario");
    if (!data || data.length === 0) {
      throw new AppError("permisos", "No administras el recinto de ese bloque.");
    }
  }

  /**
   * REQ-30 · serie de bloques.
   *
   * Toda la generación ocurre en la base, en una sola transacción: un
   * bucle de inserciones desde el navegador dejaría series a medias si
   * se corta la conexión a la mitad.
   */
  async crearSerieBloques(datos: DatosSerieBloques): Promise<ResultadoSerie> {
    await this.exigirSesion();

    const { data, error } = await this.cliente.rpc("admin_create_block_series", {
      _facility_id: datos.recintoId,
      _fecha_desde: datos.fechaDesde,
      _fecha_hasta: datos.fechaHasta,
      _horas: datos.horas,
      _duracion_minutos: datos.duracionMinutos,
      _capacidad: datos.capacidadMaxima,
      _dias_semana: datos.diasSemana.length > 0 ? datos.diasSemana : null,
      _zona: config.timeZone,
      _simular: datos.simular,
    });

    if (error) throw aAppError(error, "crear la serie de bloques");

    const r = data as RespuestaSerie;
    return {
      ok: r.ok,
      simulado: r.simulado ?? datos.simular,
      creados: r.creados ?? 0,
      omitidosExistentes: r.omitidos_existentes ?? 0,
      omitidosPasado: r.omitidos_pasado ?? 0,
      previstos: r.previstos ?? 0,
      primerBloque: r.primer_bloque ?? null,
      ultimoBloque: r.ultimo_bloque ?? null,
      muestra: r.muestra ?? [],
      error: r.error,
      mensaje: r.mensaje,
    };
  }

  async desactivarSerieBloques(
    recintoId: string,
    fechaDesde: string,
    fechaHasta: string,
    simular: boolean,
  ): Promise<ResultadoDesactivacionSerie> {
    await this.exigirSesion();

    const { data, error } = await this.cliente.rpc("admin_deactivate_block_series", {
      _facility_id: recintoId,
      _fecha_desde: fechaDesde,
      _fecha_hasta: fechaHasta,
      _zona: config.timeZone,
      _simular: simular,
    });

    if (error) throw aAppError(error, "desactivar los bloques");

    const r = data as RespuestaDesactivacionSerie;
    return {
      ok: r.ok,
      simulado: r.simulado ?? simular,
      afectados: r.afectados ?? 0,
      conReservasVigentes: r.con_reservas_vigentes ?? 0,
      error: r.error,
      mensaje: r.mensaje,
    };
  }

  /** REQ-31 · devuelve el nombre de quien reservó, nunca su correo ni teléfono. */
  async listarReservasAdmin(
    recintoId: string | null,
    alcance: "vigentes" | "historial" | "todas",
  ): Promise<ReservaAdmin[]> {
    await this.exigirSesion();

    const { data, error } = await this.cliente.rpc("admin_list_reservations", {
      _facility_id: recintoId,
      _scope: alcance,
      _limit: 300,
    });

    if (error) throw aAppError(error, "cargar las reservas del recinto");
    return ((data ?? []) as FilaReservaAdmin[]).map(aReservaAdmin);
  }

  /** REQ-33 · estado de las integraciones por reserva. */
  async listarIncidenciasIntegracion(): Promise<IncidenciaIntegracion[]> {
    await this.exigirSesion();

    const { data, error } = await this.cliente.rpc("admin_integration_report", { _limit: 200 });
    if (error) throw aAppError(error, "cargar el estado de las integraciones");
    return ((data ?? []) as FilaIncidencia[]).map(aIncidencia);
  }

  async listarAuditoria(recintoId: string | null): Promise<EntradaAuditoria[]> {
    await this.exigirSesion();

    let consulta = this.cliente
      .from("reservation_audit_log")
      .select("id, reservation_id, facility_id, action, actor_role, details, created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (recintoId) consulta = consulta.eq("facility_id", recintoId);

    const { data, error } = await consulta;
    if (error) throw aAppError(error, "cargar la auditoría");
    return (data as FilaAuditoria[]).map(aAuditoria);
  }

  // =================================================================
  // Auxiliares
  // =================================================================

  private async exigirSesion(): Promise<SesionActual> {
    const sesion = await this.obtenerSesion();
    if (!sesion) {
      throw new AppError("sesion_expirada", "Necesitas iniciar sesión para continuar.");
    }
    return sesion;
  }
}

/** Inicio del día local (yyyy-mm-dd) como instante ISO. */
function inicioDelDia(fecha: string): string {
  return new Date(`${fecha}T00:00:00`).toISOString();
}

/** Fin del día local (yyyy-mm-dd) como instante ISO. */
function finDelDia(fecha: string): string {
  return new Date(`${fecha}T23:59:59.999`).toISOString();
}

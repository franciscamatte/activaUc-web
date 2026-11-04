/**
 * Tipos de dominio de ActivaUC.
 *
 * Reflejan el modelo de datos de PostgreSQL, pero con nombres en
 * español y sin ningún campo sensible: aquí no existen contraseñas,
 * tokens ni correos de terceros.
 */

/**
 * Roles del sistema.
 *
 * `administrador` gestiona sólo los recintos que tiene asignados
 * (REQ-29); `administrador_general` todos los de la organización, y es
 * quien otorga el rol de administrador y asigna los recintos.
 */
export type Rol = "usuario" | "administrador" | "administrador_general";

/** Una cuenta con rol de administración, para el panel general. */
export interface AdministradorListado {
  correo: string;
  nombre: string;
  rol: Rol;
  /** Nombres de los recintos a su cargo. */
  recintos: string[];
}

/**
 * Resultado de crear la cuenta de un administrador (REQ-29).
 *
 * `correoEnviado` se informa aparte a propósito: la cuenta puede quedar
 * creada aunque el aviso no salga, y el panel tiene que poder decir «la
 * cuenta está, avísale tú» en lugar de dar por enviado un correo que no
 * salió.
 */
export interface ResultadoCrearAdministrador {
  ok: boolean;
  mensaje: string;
  cuentaCreada: boolean;
  correoEnviado: boolean;
  motivoCorreo?: string;
}

/** Recinto tal como lo ve el administrador general al asignar. */
export interface RecintoAsignable {
  id: string;
  nombre: string;
  activo: boolean;
}

/** Un administrador general también administra, con más alcance. */
export function esAdministrador(rol: Rol): boolean {
  return rol === "administrador" || rol === "administrador_general";
}

/**
 * Cómo se nombra cada rol en pantalla. Está aquí y no en la barra de
 * navegación porque lo necesitan varias pantallas, y porque añadir un
 * rol sin añadir su nombre dejaría a alguien viendo «Sesión activa» en
 * lugar de lo que es.
 */
export function etiquetaRol(rol: Rol): string {
  switch (rol) {
    case "administrador_general":
      return "Administradora/or general";
    case "administrador":
      return "Administradora/or de recintos";
    default:
      return "Sesión activa";
  }
}

/** Estado almacenado. "pasada" no se guarda: se deriva del tiempo. */
export type EstadoReserva = "vigente" | "cancelada";

export type EstadoSincronizacion =
  | "no_aplica"
  | "pendiente"
  | "sincronizado"
  | "error";

export type EstadoMensaje =
  | "pendiente"
  | "enviado"
  | "entregado"
  | "fallido"
  | "omitido";

export type EstadoConexionCalendario = "conectado" | "revocado" | "error";

export type TipoNotificacion = "confirmacion" | "recordatorio" | "cancelacion_admin";

/**
 * Perfil del usuario autenticado. El correo proviene de la sesión de
 * Supabase Auth, no de la tabla de perfiles, y sólo se muestra a su
 * propio dueño.
 */
export interface Perfil {
  id: string;
  nombre: string;
  correo: string;
  telefono: string | null;
  whatsappConsentido: boolean;
  whatsappConsentidoEn: string | null;
  /** REQ-22/REQ-23 aplicados al correo: avisos de reserva por correo. */
  correoConsentido: boolean;
  correoConsentidoEn: string | null;
  rol: Rol;
}

export interface Recinto {
  id: string;
  nombre: string;
  tipo: string;
  descripcion: string;
  horarioFuncionamiento: string;
  activo: boolean;
}

export interface Bloque {
  id: string;
  recintoId: string;
  inicio: string;
  fin: string;
  capacidadMaxima: number;
  activo: boolean;
}

/**
 * Fila de disponibilidad tal como la expone public.block_availability:
 * sólo agregados, sin identificadores de usuarios.
 */
export interface Disponibilidad {
  bloqueId: string;
  recintoId: string;
  recintoNombre: string;
  recintoTipo: string;
  recintoDescripcion: string;
  recintoHorario: string;
  inicio: string;
  fin: string;
  capacidadMaxima: number;
  reservados: number;
  disponibles: number;
  agotado: boolean;
  iniciado: boolean;
}

export interface Reserva {
  id: string;
  usuarioId: string;
  recintoId: string;
  recintoNombre: string;
  recintoTipo: string;
  bloqueId: string;
  inicio: string;
  fin: string;
  estado: EstadoReserva;
  esPasada: boolean;
  calendarSync: EstadoSincronizacion;
  tieneEventoCalendario: boolean;
  whatsappConfirmacion: EstadoMensaje;
  whatsappRecordatorio: EstadoMensaje;
  canceladaEn: string | null;
  canceladaPorRol: Rol | null;
  motivoCancelacion: string | null;
  creadaEn: string;
}

/** Vista de una reserva para el panel de administración (REQ-31). */
export interface ReservaAdmin {
  id: string;
  recintoId: string;
  recintoNombre: string;
  bloqueId: string;
  inicio: string;
  fin: string;
  estado: EstadoReserva;
  esPasada: boolean;
  /** Nombre de quien reservó. Nunca su correo ni su teléfono. */
  usuarioNombre: string;
  calendarSync: EstadoSincronizacion;
  tieneEventoCalendario: boolean;
  whatsappEstado: EstadoMensaje;
  canceladaPorRol: Rol | null;
  motivoCancelacion: string | null;
  creadaEn: string;
}

export interface ConexionCalendario {
  estado: EstadoConexionCalendario;
  cuentaGoogle: string | null;
  conectadaEn: string | null;
  revocadaEn: string | null;
  ultimoError: string | null;
}

export interface IncidenciaIntegracion {
  tipo: "google_calendar" | "whatsapp";
  referenciaId: string;
  recintoId: string;
  recintoNombre: string;
  reservaInicio: string;
  estado: string;
  intentos: number;
  ultimoError: string | null;
  ocurridoEn: string;
}

export interface EntradaAuditoria {
  id: string;
  reservaId: string | null;
  recintoId: string | null;
  accion: string;
  actorRol: Rol | null;
  detalles: Record<string, unknown>;
  fecha: string;
}

export interface FiltrosCatalogo {
  /** Fecha exacta (yyyy-mm-dd) o inicio del rango. */
  fechaDesde: string;
  /** Fin del rango (yyyy-mm-dd). Vacío = sólo fechaDesde. */
  fechaHasta: string;
  tipoRecinto: string;
  recintoId: string;
  /** Hora de inicio mínima (HH:mm). */
  horaDesde: string;
  /** Hora de término máxima (HH:mm). */
  horaHasta: string;
  soloConCupos: boolean;
}

export const filtrosVacios: FiltrosCatalogo = {
  fechaDesde: "",
  fechaHasta: "",
  tipoRecinto: "",
  recintoId: "",
  horaDesde: "",
  horaHasta: "",
  soloConCupos: false,
};

/** Resultado estructurado de create_reservation_strict. */
export interface ResultadoReserva {
  ok: boolean;
  duplicada?: boolean;
  reservaId?: string;
  error?: string;
  mensaje: string;
  calendarSync?: EstadoSincronizacion;
  whatsappConfirmacion?: string;
  whatsappRecordatorio?: string;
  recordatorioProgramadoPara?: string | null;
  cuposDisponibles?: number;
}

/** Resultado estructurado de cancel_reservation. */
export interface ResultadoCancelacion {
  ok: boolean;
  yaCancelada?: boolean;
  error?: string;
  mensaje: string;
  canceladoPor?: Rol;
  notificacionWhatsapp?: boolean;
}

export type Rol = "usuario" | "administrador";

export type EstadoReserva = "vigente" | "cancelada" | "pasada";

export type EstadoSincronizacion = "sincronizado" | "pendiente" | "error";

export type EstadoMensaje = "enviado" | "entregado" | "fallido" | "omitido";

export interface Usuario {
  id: string;
  nombre: string;
  email: string;
  password: string;
  telefono: string;
  whatsappConsentido: boolean;
  googleCalendarConectado: boolean;
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

export interface Reserva {
  id: string;
  usuarioId: string;
  recintoId: string;
  bloqueId: string;
  inicio: string;
  fin: string;
  estado: EstadoReserva;
  creadaEn: string;
  calendarSync: EstadoSincronizacion;
  whatsappConfirmacion: EstadoMensaje;
  whatsappRecordatorio: EstadoMensaje;
}

export interface AsignacionAdministrador {
  id: string;
  administradorId: string;
  recintoId: string;
}

export interface AuditoriaReserva {
  id: string;
  reservaId: string;
  accion: "creada" | "cancelada_usuario" | "cancelada_admin" | "sincronizacion";
  detalle: string;
  actorId: string;
  fecha: string;
}

export interface FiltrosCatalogo {
  fecha: string;
  tipoRecinto: string;
  desde: string;
  hasta: string;
}

export interface Sesion {
  usuarioId: string;
  rol: Rol;
}

export interface NotificacionResultado {
  calendarSync: EstadoSincronizacion;
  whatsappConfirmacion: EstadoMensaje;
  whatsappRecordatorio: EstadoMensaje;
}

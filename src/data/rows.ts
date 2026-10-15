/**
 * Tipos de las filas que devuelve PostgreSQL y las funciones de
 * conversión al dominio.
 *
 * Mantener la conversión en un solo lugar evita que los nombres de
 * columna de la base se filtren a los componentes.
 */

import type {
  Bloque,
  ConexionCalendario,
  Disponibilidad,
  EntradaAuditoria,
  EstadoConexionCalendario,
  EstadoMensaje,
  EstadoReserva,
  EstadoSincronizacion,
  IncidenciaIntegracion,
  Perfil,
  Recinto,
  Reserva,
  ReservaAdmin,
  Rol,
} from "../domain/types";

export interface FilaPerfil {
  id: string;
  full_name: string;
  phone: string | null;
  whatsapp_consent: boolean;
  whatsapp_consent_at: string | null;
  role: Rol;
}

export interface FilaRecinto {
  id: string;
  name: string;
  facility_type: string;
  description: string;
  operation_hours: string;
  active: boolean;
}

export interface FilaBloque {
  id: string;
  facility_id: string;
  starts_at: string;
  ends_at: string;
  max_capacity: number;
  active: boolean;
}

export interface FilaDisponibilidad {
  block_id: string;
  facility_id: string;
  facility_name: string;
  facility_type: string;
  facility_description: string;
  facility_operation_hours: string;
  starts_at: string;
  ends_at: string;
  max_capacity: number;
  reserved_count: number;
  available_count: number;
  is_full: boolean;
  is_past: boolean;
}

export interface FilaReserva {
  id: string;
  user_id: string;
  facility_id: string;
  facility_name: string;
  facility_type: string;
  block_id: string;
  starts_at: string;
  ends_at: string;
  status: EstadoReserva;
  is_past: boolean;
  calendar_sync_status: EstadoSincronizacion;
  has_calendar_event: boolean;
  whatsapp_confirmation_status: EstadoMensaje;
  whatsapp_reminder_status: EstadoMensaje;
  cancelled_at: string | null;
  cancelled_by_role: Rol | null;
  cancel_reason: string | null;
  created_at: string;
}

export interface FilaReservaAdmin {
  reservation_id: string;
  facility_id: string;
  facility_name: string;
  block_id: string;
  starts_at: string;
  ends_at: string;
  status: EstadoReserva;
  is_past: boolean;
  user_display_name: string;
  calendar_sync_status: EstadoSincronizacion;
  has_calendar_event: boolean;
  whatsapp_status: EstadoMensaje;
  cancelled_by_role: Rol | null;
  cancel_reason: string | null;
  created_at: string;
}

export interface FilaConexionCalendario {
  status: EstadoConexionCalendario;
  google_account_email: string | null;
  connected_at: string | null;
  revoked_at: string | null;
  last_error: string | null;
}

export interface FilaIncidencia {
  kind: "google_calendar" | "whatsapp";
  reference_id: string;
  facility_id: string;
  facility_name: string;
  reservation_starts_at: string;
  status: string;
  attempts: number;
  last_error: string | null;
  occurred_at: string;
}

export interface FilaAuditoria {
  id: string;
  reservation_id: string | null;
  facility_id: string | null;
  action: string;
  actor_role: Rol | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

// ---------------------------------------------------------------------
// Conversión
// ---------------------------------------------------------------------

export function aPerfil(fila: FilaPerfil, correo: string): Perfil {
  return {
    id: fila.id,
    nombre: fila.full_name,
    correo,
    telefono: fila.phone,
    whatsappConsentido: fila.whatsapp_consent,
    whatsappConsentidoEn: fila.whatsapp_consent_at,
    rol: fila.role,
  };
}

export function aRecinto(fila: FilaRecinto): Recinto {
  return {
    id: fila.id,
    nombre: fila.name,
    tipo: fila.facility_type,
    descripcion: fila.description,
    horarioFuncionamiento: fila.operation_hours,
    activo: fila.active,
  };
}

export function aBloque(fila: FilaBloque): Bloque {
  return {
    id: fila.id,
    recintoId: fila.facility_id,
    inicio: fila.starts_at,
    fin: fila.ends_at,
    capacidadMaxima: fila.max_capacity,
    activo: fila.active,
  };
}

export function aDisponibilidad(fila: FilaDisponibilidad): Disponibilidad {
  return {
    bloqueId: fila.block_id,
    recintoId: fila.facility_id,
    recintoNombre: fila.facility_name,
    recintoTipo: fila.facility_type,
    recintoDescripcion: fila.facility_description,
    recintoHorario: fila.facility_operation_hours,
    inicio: fila.starts_at,
    fin: fila.ends_at,
    capacidadMaxima: fila.max_capacity,
    reservados: fila.reserved_count,
    disponibles: fila.available_count,
    agotado: fila.is_full,
    iniciado: fila.is_past,
  };
}

export function aReserva(fila: FilaReserva): Reserva {
  return {
    id: fila.id,
    usuarioId: fila.user_id,
    recintoId: fila.facility_id,
    recintoNombre: fila.facility_name,
    recintoTipo: fila.facility_type,
    bloqueId: fila.block_id,
    inicio: fila.starts_at,
    fin: fila.ends_at,
    estado: fila.status,
    esPasada: fila.is_past,
    calendarSync: fila.calendar_sync_status,
    tieneEventoCalendario: fila.has_calendar_event,
    whatsappConfirmacion: fila.whatsapp_confirmation_status,
    whatsappRecordatorio: fila.whatsapp_reminder_status,
    canceladaEn: fila.cancelled_at,
    canceladaPorRol: fila.cancelled_by_role,
    motivoCancelacion: fila.cancel_reason,
    creadaEn: fila.created_at,
  };
}

export function aReservaAdmin(fila: FilaReservaAdmin): ReservaAdmin {
  return {
    id: fila.reservation_id,
    recintoId: fila.facility_id,
    recintoNombre: fila.facility_name,
    bloqueId: fila.block_id,
    inicio: fila.starts_at,
    fin: fila.ends_at,
    estado: fila.status,
    esPasada: fila.is_past,
    usuarioNombre: fila.user_display_name,
    calendarSync: fila.calendar_sync_status,
    tieneEventoCalendario: fila.has_calendar_event,
    whatsappEstado: fila.whatsapp_status,
    canceladaPorRol: fila.cancelled_by_role,
    motivoCancelacion: fila.cancel_reason,
    creadaEn: fila.created_at,
  };
}

export function aConexionCalendario(
  fila: FilaConexionCalendario | null,
): ConexionCalendario {
  if (!fila) {
    return {
      estado: "revocado",
      cuentaGoogle: null,
      conectadaEn: null,
      revocadaEn: null,
      ultimoError: null,
    };
  }
  return {
    estado: fila.status,
    cuentaGoogle: fila.google_account_email,
    conectadaEn: fila.connected_at,
    revocadaEn: fila.revoked_at,
    ultimoError: fila.last_error,
  };
}

export function aIncidencia(fila: FilaIncidencia): IncidenciaIntegracion {
  return {
    tipo: fila.kind,
    referenciaId: fila.reference_id,
    recintoId: fila.facility_id,
    recintoNombre: fila.facility_name,
    reservaInicio: fila.reservation_starts_at,
    estado: fila.status,
    intentos: fila.attempts,
    ultimoError: fila.last_error,
    ocurridoEn: fila.occurred_at,
  };
}

export function aAuditoria(fila: FilaAuditoria): EntradaAuditoria {
  return {
    id: fila.id,
    reservaId: fila.reservation_id,
    recintoId: fila.facility_id,
    accion: fila.action,
    actorRol: fila.actor_role,
    detalles: fila.details ?? {},
    fecha: fila.created_at,
  };
}

/** Etiqueta legible de una acción de auditoría. */
export function etiquetaAccionAuditoria(accion: string): string {
  const mapa: Record<string, string> = {
    reserva_creada: "Reserva creada",
    reserva_cancelada_usuario: "Cancelada por el usuario",
    reserva_cancelada_admin: "Cancelada por administración",
    calendar_evento_creado: "Evento creado en Google Calendar",
    calendar_evento_eliminado: "Evento eliminado de Google Calendar",
    calendar_error: "Error de sincronización con Google Calendar",
    calendar_conectado: "Google Calendar conectado",
    calendar_desconectado: "Google Calendar desconectado",
    whatsapp_enviado: "Mensaje de WhatsApp enviado",
    whatsapp_fallido: "Falló el envío de WhatsApp",
    whatsapp_omitido: "Mensaje de WhatsApp omitido",
    consentimiento_otorgado: "Consentimiento de WhatsApp otorgado",
    consentimiento_revocado: "Consentimiento de WhatsApp revocado",
    recinto_creado: "Recinto creado",
    recinto_actualizado: "Recinto actualizado",
    recinto_desactivado: "Recinto desactivado",
    bloque_creado: "Bloque horario creado",
    bloque_actualizado: "Bloque horario actualizado",
    bloque_desactivado: "Bloque horario desactivado",
  };
  return mapa[accion] ?? accion.replace(/_/g, " ");
}

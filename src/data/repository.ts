/**
 * Contrato del acceso a datos.
 *
 * Existen dos implementaciones:
 *   · SupabaseRepository → la real, usada en producción y por defecto.
 *   · MockRepository     → sólo para desarrollo local sin backend.
 *
 * El contrato no expone ninguna operación que el backend no autorice:
 * crear y cancelar reservas pasan por funciones transaccionales, y las
 * integraciones por Edge Functions.
 */

import type {
  Bloque,
  ConexionCalendario,
  Disponibilidad,
  EntradaAuditoria,
  FiltrosCatalogo,
  IncidenciaIntegracion,
  Perfil,
  Recinto,
  Reserva,
  ReservaAdmin,
  ResultadoCancelacion,
  ResultadoReserva,
} from "../domain/types";

export interface SesionActual {
  usuarioId: string;
  correo: string;
  /** Marca de tiempo (segundos) de expiración del token de acceso. */
  expiraEn: number | null;
}

export type OyenteSesion = (
  evento: "iniciada" | "cerrada" | "renovada" | "expirada",
  sesion: SesionActual | null,
) => void;

export interface DatosRecinto {
  nombre: string;
  tipo: string;
  descripcion: string;
  horarioFuncionamiento: string;
  activo: boolean;
}

export interface DatosBloque {
  recintoId: string;
  inicio: string;
  fin: string;
  capacidadMaxima: number;
  activo: boolean;
}

export interface ActivaRepository {
  // --- Sesión -------------------------------------------------------
  obtenerSesion(): Promise<SesionActual | null>;
  escucharSesion(oyente: OyenteSesion): () => void;
  registrarse(datos: {
    nombre: string;
    correo: string;
    contrasena: string;
  }): Promise<{ requiereConfirmacion: boolean }>;
  iniciarSesion(correo: string, contrasena: string): Promise<void>;
  cerrarSesion(): Promise<void>;
  solicitarRecuperacion(correo: string): Promise<void>;
  definirNuevaContrasena(contrasena: string): Promise<void>;
  reenviarConfirmacion(correo: string): Promise<void>;

  // --- Perfil -------------------------------------------------------
  obtenerPerfil(): Promise<Perfil | null>;
  actualizarNombre(nombre: string): Promise<void>;
  /** REQ-22 / REQ-23 · otorgar o revocar el consentimiento de WhatsApp. */
  definirConsentimientoWhatsapp(
    telefono: string | null,
    consentido: boolean,
  ): Promise<{ ok: boolean; mensaje: string }>;

  // --- Catálogo y disponibilidad ------------------------------------
  listarRecintos(): Promise<Recinto[]>;
  consultarDisponibilidad(filtros: FiltrosCatalogo): Promise<Disponibilidad[]>;
  /** Suscripción en vivo a los cambios que afectan la disponibilidad. */
  observarDisponibilidad(alCambiar: () => void): () => void;

  // --- Reservas -----------------------------------------------------
  listarMisReservas(): Promise<Reserva[]>;
  crearReserva(bloqueId: string, idSolicitud?: string): Promise<ResultadoReserva>;
  cancelarReserva(reservaId: string, motivo?: string): Promise<ResultadoCancelacion>;

  // --- Google Calendar ----------------------------------------------
  obtenerConexionCalendario(): Promise<ConexionCalendario>;
  /** Devuelve la URL de autorización de Google a la que redirigir. */
  iniciarConexionCalendario(rutaRetorno: string): Promise<string>;
  desconectarCalendario(): Promise<{ mensaje: string }>;

  // --- Administración -----------------------------------------------
  listarRecintosAsignados(): Promise<Recinto[]>;
  crearRecinto(datos: DatosRecinto): Promise<{ ok: boolean; mensaje: string }>;
  actualizarRecinto(recintoId: string, datos: Partial<DatosRecinto>): Promise<void>;
  listarBloques(recintoId: string): Promise<Bloque[]>;
  crearBloque(datos: DatosBloque): Promise<void>;
  actualizarBloque(bloqueId: string, datos: Partial<DatosBloque>): Promise<void>;
  listarReservasAdmin(
    recintoId: string | null,
    alcance: "vigentes" | "historial" | "todas",
  ): Promise<ReservaAdmin[]>;
  listarIncidenciasIntegracion(): Promise<IncidenciaIntegracion[]>;
  listarAuditoria(recintoId: string | null): Promise<EntradaAuditoria[]>;
}

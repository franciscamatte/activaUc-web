/**
 * Contexto de autenticación.
 *
 * Vive en un archivo propio (sin JSX) para no romper la recarga en
 * caliente de React: un módulo .tsx debe exportar sólo componentes.
 */

import { createContext, useContext } from "react";
import type { ActivaRepository } from "../data";
import type { ConexionCalendario, Perfil } from "../domain/types";
import type { TipoVerificacion } from "../data/repository";

export type FaseSesion = "cargando" | "anonimo" | "autenticado" | "error_configuracion";

export interface EstadoAuth {
  fase: FaseSesion;
  perfil: Perfil | null;
  /** Mensaje de error de configuración, si la app no puede operar. */
  errorConfiguracion: string | null;
  /** True cuando la sesión caducó sin que el usuario cerrara sesión. */
  sesionExpirada: boolean;
  /** Estado de la conexión con Google Calendar del usuario actual. */
  calendario: ConexionCalendario | null;
  cargandoCalendario: boolean;

  repositorio: ActivaRepository | null;
  esAdministrador: boolean;

  registrarse: (datos: {
    nombre: string;
    correo: string;
    contrasena: string;
  }) => Promise<{ requiereConfirmacion: boolean }>;
  iniciarSesion: (correo: string, contrasena: string) => Promise<void>;
  cerrarSesion: () => Promise<void>;
  solicitarRecuperacion: (correo: string) => Promise<void>;
  definirNuevaContrasena: (contrasena: string) => Promise<void>;
  reenviarConfirmacion: (correo: string) => Promise<void>;
  verificarCodigo: (datos: {
    correo: string;
    codigo: string;
    tipo: TipoVerificacion;
  }) => Promise<void>;

  recargarPerfil: () => Promise<void>;
  recargarCalendario: () => Promise<void>;
  actualizarNombre: (nombre: string) => Promise<void>;
  definirConsentimientoWhatsapp: (
    telefono: string | null,
    consentido: boolean,
  ) => Promise<{ ok: boolean; mensaje: string }>;
  descartarAvisoExpiracion: () => void;
}

export const AuthContext = createContext<EstadoAuth | null>(null);

export function useAuth(): EstadoAuth {
  const contexto = useContext(AuthContext);
  if (!contexto) {
    throw new Error("useAuth debe usarse dentro de <AuthProvider>.");
  }
  return contexto;
}

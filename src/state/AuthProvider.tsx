import { useCallback, useEffect, useRef, useState } from "react";
import { getRepository } from "../data";
import type { ActivaRepository } from "../data";
import type { ConexionCalendario, Perfil } from "../domain/types";
import { aAppError } from "../lib/errors";
import { AuthContext, type EstadoAuth, type FaseSesion } from "./authContext";

/**
 * Proveedor de sesión y perfil.
 *
 * Responsabilidades:
 *   · Resolver el repositorio activo y detectar errores de configuración
 *     antes de que la aplicación intente operar.
 *   · Mantener el perfil sincronizado con la sesión de Supabase Auth.
 *   · Distinguir un cierre de sesión voluntario de una sesión expirada,
 *     para poder avisar al usuario (REQ-2 y estados de sesión).
 */
/** Resuelve el repositorio una sola vez, sin lanzar durante el render. */
function resolverRepositorio(): {
  repositorio: ActivaRepository | null;
  error: string | null;
} {
  try {
    return { repositorio: getRepository(), error: null };
  } catch (error) {
    return { repositorio: null, error: aAppError(error).message };
  }
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  // El inicializador perezoso corre una sola vez y permite derivar la
  // fase inicial sin llamar a setState durante el render.
  const [{ repositorio, error: errorConfiguracion }] = useState(resolverRepositorio);

  const [fase, setFase] = useState<FaseSesion>(
    errorConfiguracion ? "error_configuracion" : "cargando",
  );
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [sesionExpirada, setSesionExpirada] = useState(false);
  const [calendario, setCalendario] = useState<ConexionCalendario | null>(null);
  const [cargandoCalendario, setCargandoCalendario] = useState(false);

  // Cierre de sesión deliberado: evita mostrar "tu sesión expiró" cuando
  // es el propio usuario quien pulsó el botón.
  const cierreVoluntario = useRef(false);
  const habiaSesion = useRef(false);

  const cargarPerfil = useCallback(async (repo: ActivaRepository) => {
    const sesion = await repo.obtenerSesion();
    if (!sesion) {
      setPerfil(null);
      setCalendario(null);
      setFase("anonimo");
      return;
    }

    try {
      const datos = await repo.obtenerPerfil();
      setPerfil(datos);
      setFase(datos ? "autenticado" : "anonimo");
    } catch (error) {
      const appError = aAppError(error);
      if (appError.tipo === "sesion_expirada") {
        setPerfil(null);
        setFase("anonimo");
        setSesionExpirada(true);
        return;
      }
      // Un fallo de red al cargar el perfil no debe expulsar al usuario:
      // se queda autenticado y la vista mostrará el error con reintento.
      setFase("autenticado");
      throw appError;
    }
  }, []);

  const cargarCalendario = useCallback(async (repo: ActivaRepository) => {
    setCargandoCalendario(true);
    try {
      setCalendario(await repo.obtenerConexionCalendario());
    } catch {
      // El estado de una integración opcional no debe bloquear la app.
      setCalendario(null);
    } finally {
      setCargandoCalendario(false);
    }
  }, []);

  // Arranque y suscripción a los cambios de sesión. Sincronizar con un
  // sistema externo (Supabase Auth) es justamente para lo que existe un
  // efecto; el estado que se fija aquí no es derivable del render.
  useEffect(() => {
    if (!repositorio) return;

    let activo = true;

    void (async () => {
      try {
        await cargarPerfil(repositorio);
      } catch {
        // Ya se reflejó en la fase; la vista lo informará.
      }
      if (!activo) return;
      const sesion = await repositorio.obtenerSesion();
      habiaSesion.current = sesion !== null;
      if (sesion) await cargarCalendario(repositorio);
    })();

    const cancelar = repositorio.escucharSesion((evento, sesion) => {
      if (!activo) return;

      if (evento === "cerrada") {
        // Si había sesión y el usuario no pulsó "cerrar sesión", caducó.
        if (habiaSesion.current && !cierreVoluntario.current) {
          setSesionExpirada(true);
        }
        cierreVoluntario.current = false;
        habiaSesion.current = false;
        setPerfil(null);
        setCalendario(null);
        setFase("anonimo");
        return;
      }

      habiaSesion.current = sesion !== null;
      if (evento === "iniciada") {
        setSesionExpirada(false);
        void cargarPerfil(repositorio).catch(() => {});
        void cargarCalendario(repositorio);
      }
    });

    return () => {
      activo = false;
      cancelar();
    };
  }, [repositorio, cargarPerfil, cargarCalendario]);

  const valor: EstadoAuth = {
    fase,
    perfil,
    errorConfiguracion,
    sesionExpirada,
    calendario,
    cargandoCalendario,
    repositorio,
    esAdministrador: perfil?.rol === "administrador",

    registrarse: async (datos) => {
      if (!repositorio) throw aAppError(new Error("Repositorio no disponible."));
      return await repositorio.registrarse(datos);
    },

    iniciarSesion: async (correo, contrasena) => {
      if (!repositorio) throw aAppError(new Error("Repositorio no disponible."));
      setSesionExpirada(false);
      await repositorio.iniciarSesion(correo, contrasena);
      await cargarPerfil(repositorio);
      await cargarCalendario(repositorio);
    },

    cerrarSesion: async () => {
      if (!repositorio) return;
      cierreVoluntario.current = true;
      try {
        await repositorio.cerrarSesion();
      } finally {
        setPerfil(null);
        setCalendario(null);
        setFase("anonimo");
      }
    },

    solicitarRecuperacion: async (correo) => {
      if (!repositorio) throw aAppError(new Error("Repositorio no disponible."));
      await repositorio.solicitarRecuperacion(correo);
    },

    definirNuevaContrasena: async (contrasena) => {
      if (!repositorio) throw aAppError(new Error("Repositorio no disponible."));
      await repositorio.definirNuevaContrasena(contrasena);
    },

    reenviarConfirmacion: async (correo) => {
      if (!repositorio) throw aAppError(new Error("Repositorio no disponible."));
      await repositorio.reenviarConfirmacion(correo);
    },

    verificarCodigo: async (datos) => {
      if (!repositorio) throw aAppError(new Error("Repositorio no disponible."));
      await repositorio.verificarCodigo(datos);
      // verifyOtp deja sesión abierta en los dos casos, así que el
      // perfil debe cargarse para que la aplicación se entere.
      await cargarPerfil(repositorio);
    },

    recargarPerfil: async () => {
      if (!repositorio) return;
      await cargarPerfil(repositorio);
    },

    recargarCalendario: async () => {
      if (!repositorio) return;
      await cargarCalendario(repositorio);
    },

    actualizarNombre: async (nombre) => {
      if (!repositorio) throw aAppError(new Error("Repositorio no disponible."));
      await repositorio.actualizarNombre(nombre);
      await cargarPerfil(repositorio);
    },

    definirConsentimientoWhatsapp: async (telefono, consentido) => {
      if (!repositorio) throw aAppError(new Error("Repositorio no disponible."));
      const resultado = await repositorio.definirConsentimientoWhatsapp(telefono, consentido);
      if (resultado.ok) await cargarPerfil(repositorio);
      return resultado;
    },

    descartarAvisoExpiracion: () => setSesionExpirada(false),
  };

  return <AuthContext.Provider value={valor}>{children}</AuthContext.Provider>;
}

/**
 * Traducción de errores técnicos a mensajes en español para el usuario.
 *
 * Objetivos:
 *   · Nunca mostrar texto en inglés, códigos crudos ni trazas.
 *   · No filtrar detalles internos (nombres de tablas, políticas, SQL).
 *   · Distinguir los casos que requieren una acción distinta:
 *     sesión expirada, sin conexión, permisos, límite de solicitudes.
 */

export type TipoError =
  | "credenciales"
  | "correo_no_confirmado"
  | "correo_en_uso"
  | "contrasena_debil"
  | "sesion_expirada"
  | "sin_conexion"
  | "permisos"
  | "limite_solicitudes"
  | "no_encontrado"
  | "conflicto"
  | "configuracion"
  | "integracion"
  | "desconocido";

export class AppError extends Error {
  readonly tipo: TipoError;
  readonly reintentable: boolean;

  constructor(tipo: TipoError, mensaje: string, reintentable = false) {
    super(mensaje);
    this.name = "AppError";
    this.tipo = tipo;
    this.reintentable = reintentable;
  }
}

interface ErrorConCodigo {
  message?: string;
  code?: string;
  status?: number;
  name?: string;
}

function extraer(error: unknown): ErrorConCodigo {
  if (error && typeof error === "object") {
    const e = error as ErrorConCodigo;
    return {
      message: typeof e.message === "string" ? e.message : undefined,
      code: typeof e.code === "string" ? e.code : undefined,
      status: typeof e.status === "number" ? e.status : undefined,
      name: typeof e.name === "string" ? e.name : undefined,
    };
  }
  if (typeof error === "string") return { message: error };
  return {};
}

/**
 * Convierte cualquier error (de Supabase, de red o propio) en un
 * AppError con mensaje en español.
 */
export function aAppError(error: unknown, contexto = ""): AppError {
  if (error instanceof AppError) return error;

  const { message = "", code, status, name } = extraer(error);
  const texto = message.toLowerCase();

  // --- Conectividad ------------------------------------------------
  if (
    name === "TypeError" && texto.includes("fetch") ||
    texto.includes("failed to fetch") ||
    texto.includes("networkerror") ||
    texto.includes("network request failed") ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  ) {
    return new AppError(
      "sin_conexion",
      "No hay conexión con el servidor. Revisa tu conexión a internet e inténtalo de nuevo.",
      true,
    );
  }

  // --- Autenticación ------------------------------------------------
  if (texto.includes("invalid login credentials") || texto.includes("invalid credentials")) {
    return new AppError(
      "credenciales",
      "El correo o la contraseña no son correctos. Revísalos e inténtalo otra vez.",
    );
  }
  if (texto.includes("email not confirmed")) {
    return new AppError(
      "correo_no_confirmado",
      "Todavía no has confirmado tu correo. Busca el mensaje de ActivaUC en tu bandeja de entrada " +
      "(revisa también la carpeta de correo no deseado).",
    );
  }
  if (
    texto.includes("already registered") ||
    texto.includes("already been registered") ||
    texto.includes("user already exists") ||
    code === "user_already_exists"
  ) {
    return new AppError(
      "correo_en_uso",
      "Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.",
    );
  }
  if (texto.includes("password") && (texto.includes("short") || texto.includes("at least"))) {
    return new AppError(
      "contrasena_debil",
      "La contraseña debe tener al menos 8 caracteres.",
    );
  }
  if (texto.includes("weak password") || code === "weak_password") {
    return new AppError(
      "contrasena_debil",
      "Esa contraseña es demasiado fácil de adivinar. Usa al menos 8 caracteres combinando letras y números.",
    );
  }
  if (
    status === 401 ||
    texto.includes("jwt expired") ||
    texto.includes("token is expired") ||
    texto.includes("refresh token not found") ||
    texto.includes("invalid refresh token") ||
    code === "PGRST301"
  ) {
    return new AppError(
      "sesion_expirada",
      "Tu sesión expiró por seguridad. Vuelve a iniciar sesión para continuar.",
    );
  }

  // --- Límites y permisos -------------------------------------------
  if (status === 429 || texto.includes("rate limit") || texto.includes("too many requests")) {
    return new AppError(
      "limite_solicitudes",
      "Hiciste demasiadas solicitudes seguidas. Espera un momento e inténtalo de nuevo.",
      true,
    );
  }
  if (
    code === "42501" ||
    status === 403 ||
    texto.includes("row-level security") ||
    texto.includes("permission denied") ||
    texto.includes("insufficient")
  ) {
    return new AppError(
      "permisos",
      "No tienes permiso para realizar esta acción.",
    );
  }

  // --- Datos ---------------------------------------------------------
  if (code === "PGRST116" || texto.includes("no rows") || status === 404) {
    return new AppError("no_encontrado", "No encontramos la información solicitada.");
  }
  if (code === "23505" || texto.includes("duplicate key")) {
    return new AppError("conflicto", "Ese registro ya existe.");
  }
  if (code === "23514" || texto.includes("violates check constraint")) {
    return new AppError(
      "conflicto",
      "Alguno de los datos no cumple las reglas del sistema. Revisa el formulario.",
    );
  }
  if (code === "28000" || texto.includes("debes iniciar sesión")) {
    return new AppError(
      "sesion_expirada",
      "Necesitas iniciar sesión para continuar.",
    );
  }

  // --- Configuración e integraciones ---------------------------------
  if (texto.includes("integracion_no_configurada") || status === 503) {
    return new AppError(
      "integracion",
      "Esta integración aún no está configurada en el servidor. Avisa al equipo de Deportes UC.",
      true,
    );
  }
  if (texto.includes("supabase no está configurado")) {
    return new AppError(
      "configuracion",
      "La aplicación no está configurada correctamente. Revisa las variables de entorno.",
    );
  }

  // --- Mensajes del backend ya en español ----------------------------
  // Las funciones SQL devuelven mensajes pensados para el usuario final.
  if (message && /[áéíóúñ¿¡]|reserva|bloque|cupo|sesión|recinto/i.test(message)) {
    return new AppError("desconocido", message);
  }

  const sufijo = contexto ? ` al ${contexto}` : "";
  return new AppError(
    "desconocido",
    `Ocurrió un problema inesperado${sufijo}. Inténtalo de nuevo en unos segundos.`,
    true,
  );
}

/** Mensaje listo para mostrar en una alerta. */
export function mensajeDeError(error: unknown, contexto = ""): string {
  return aAppError(error, contexto).message;
}

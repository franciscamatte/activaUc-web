import { describe, expect, it } from "vitest";
import { AppError, aAppError, mensajeDeError } from "./errors";

/**
 * Requisito de idioma: ningún texto visible puede quedar en inglés.
 * Estas pruebas recorren los errores reales que devuelven Supabase, la
 * red y PostgreSQL, y verifican la traducción y la clasificación.
 */
describe("aAppError", () => {
  it("traduce credenciales inválidas", () => {
    const error = aAppError({ message: "Invalid login credentials" });
    expect(error.tipo).toBe("credenciales");
    expect(error.message).toContain("correo o la contraseña");
    expect(error.reintentable).toBe(false);
  });

  it("traduce un correo sin confirmar", () => {
    const error = aAppError({ message: "Email not confirmed" });
    expect(error.tipo).toBe("correo_no_confirmado");
    expect(error.message).toContain("confirmado tu correo");
  });

  it("traduce un correo ya registrado", () => {
    const error = aAppError({ message: "User already registered" });
    expect(error.tipo).toBe("correo_en_uso");
    expect(error.message).toContain("Ya existe una cuenta");
  });

  it("traduce una contraseña demasiado corta", () => {
    const error = aAppError({
      message: "Password should be at least 8 characters",
    });
    expect(error.tipo).toBe("contrasena_debil");
    expect(error.message).toContain("8 caracteres");
  });

  it("clasifica un token expirado como sesión expirada", () => {
    for (const mensaje of [
      "JWT expired",
      "Invalid Refresh Token: Refresh Token Not Found",
      "token is expired",
    ]) {
      const error = aAppError({ message: mensaje });
      expect(error.tipo).toBe("sesion_expirada");
      expect(error.message).toContain("sesión");
    }
  });

  it("clasifica un 401 como sesión expirada", () => {
    expect(aAppError({ status: 401, message: "Unauthorized" }).tipo).toBe("sesion_expirada");
  });

  it("clasifica un fallo de red como sin conexión y reintentable", () => {
    const error = aAppError(new TypeError("Failed to fetch"));
    expect(error.tipo).toBe("sin_conexion");
    expect(error.reintentable).toBe(true);
    expect(error.message).toContain("conexión");
  });

  it("clasifica un 429 como límite de solicitudes y reintentable", () => {
    const error = aAppError({ status: 429, message: "Too many requests" });
    expect(error.tipo).toBe("limite_solicitudes");
    expect(error.reintentable).toBe(true);
  });

  it("clasifica una violación de RLS como problema de permisos", () => {
    const error = aAppError({
      code: "42501",
      message: "new row violates row-level security policy for table \"reservations\"",
    });
    expect(error.tipo).toBe("permisos");
    expect(error.message).toBe("No tienes permiso para realizar esta acción.");
  });

  it("no filtra detalles internos en el mensaje de permisos", () => {
    const error = aAppError({
      code: "42501",
      message: "permission denied for table calendar_connections",
    });
    expect(error.message).not.toContain("calendar_connections");
    expect(error.message).not.toContain("permission denied");
  });

  it("traduce una clave duplicada", () => {
    const error = aAppError({ code: "23505", message: "duplicate key value violates…" });
    expect(error.tipo).toBe("conflicto");
    expect(error.message).toContain("ya existe");
  });

  it("traduce una restricción CHECK", () => {
    const error = aAppError({
      code: "23514",
      message: "new row violates check constraint \"profiles_phone_check\"",
    });
    expect(error.tipo).toBe("conflicto");
    expect(error.message).toContain("no cumple las reglas");
  });

  it("traduce la ausencia de filas", () => {
    expect(aAppError({ code: "PGRST116", message: "no rows returned" }).tipo)
      .toBe("no_encontrado");
  });

  it("clasifica un 503 como integración no disponible", () => {
    const error = aAppError({ status: 503, message: "Service unavailable" });
    expect(error.tipo).toBe("integracion");
    expect(error.reintentable).toBe(true);
  });

  it("conserva los mensajes en español que ya vienen del backend", () => {
    const mensaje = "Este bloque acaba de quedar sin cupos disponibles.";
    expect(aAppError({ message: mensaje }).message).toBe(mensaje);
  });

  it("conserva los mensajes de las funciones SQL de reserva", () => {
    const mensaje = "Las cancelaciones requieren al menos 2 horas de anticipación.";
    expect(aAppError({ message: mensaje }).message).toBe(mensaje);
  });

  it("devuelve un mensaje genérico en español ante lo desconocido", () => {
    const error = aAppError({ message: "ECONNRESET at internal handler" }, "guardar los datos");
    expect(error.tipo).toBe("desconocido");
    expect(error.message).toContain("guardar los datos");
    expect(error.message).toMatch(/inesperado/);
  });

  it("no envuelve dos veces un AppError", () => {
    const original = new AppError("permisos", "No tienes permiso.");
    expect(aAppError(original)).toBe(original);
  });

  it("acepta un error en forma de cadena", () => {
    expect(aAppError("Invalid login credentials").tipo).toBe("credenciales");
  });

  it("acepta valores que no son errores", () => {
    const error = aAppError(undefined);
    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toMatch(/problema inesperado/);
  });

  it("ningún mensaje traducido contiene texto en inglés", () => {
    const entradas: unknown[] = [
      { message: "Invalid login credentials" },
      { message: "Email not confirmed" },
      { message: "User already registered" },
      { message: "JWT expired" },
      new TypeError("Failed to fetch"),
      { status: 429, message: "Too many requests" },
      { code: "42501", message: "permission denied for table reservations" },
      { code: "23505", message: "duplicate key value" },
      { code: "PGRST116", message: "no rows returned" },
      { status: 503, message: "Service unavailable" },
      { message: "ECONNRESET" },
    ];

    const palabrasInglesas =
      /\b(invalid|credentials|email|password|token|expired|failed|fetch|permission|denied|duplicate|rows|service|unavailable|request)\b/i;

    for (const entrada of entradas) {
      expect(mensajeDeError(entrada)).not.toMatch(palabrasInglesas);
    }
  });
});

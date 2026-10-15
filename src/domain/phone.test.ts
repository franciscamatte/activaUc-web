import { describe, expect, it } from "vitest";
import {
  PATRON_E164,
  enmascararTelefono,
  esE164,
  normalizarTelefono,
  validarTelefono,
} from "./phone";

/**
 * El mismo patrón E.164 se aplica en tres capas (PostgreSQL, Edge
 * Function y frontend). Estas pruebas fijan el comportamiento del
 * frontend para que las tres no se separen.
 */
describe("normalizarTelefono", () => {
  it("elimina espacios, guiones y paréntesis", () => {
    expect(normalizarTelefono("+56 9 1234 5678")).toBe("+56912345678");
    expect(normalizarTelefono("+56-9-1234-5678")).toBe("+56912345678");
    expect(normalizarTelefono("+56 (9) 1234 5678")).toBe("+56912345678");
  });

  it("conserva el signo + y los dígitos", () => {
    expect(normalizarTelefono("+56912345678")).toBe("+56912345678");
  });

  it("tolera entradas vacías", () => {
    expect(normalizarTelefono("")).toBe("");
  });
});

describe("esE164", () => {
  it("acepta números internacionales válidos", () => {
    expect(esE164("+56912345678")).toBe(true);
    expect(esE164("+5491123456789")).toBe(true);
    expect(esE164("+14155552671")).toBe(true);
  });

  it("acepta números con separadores, tras normalizar", () => {
    expect(esE164("+56 9 1234 5678")).toBe(true);
  });

  it("rechaza números sin código de país", () => {
    expect(esE164("912345678")).toBe(false);
    expect(esE164("56912345678")).toBe(false);
  });

  it("rechaza un código de país que empieza en cero", () => {
    expect(esE164("+0912345678")).toBe(false);
  });

  it("rechaza números demasiado cortos o largos", () => {
    expect(esE164("+5691")).toBe(false);
    expect(esE164("+569123456789012345")).toBe(false);
  });

  it("rechaza texto y cadenas vacías", () => {
    expect(esE164("")).toBe(false);
    expect(esE164("no-es-telefono")).toBe(false);
    expect(esE164("+")).toBe(false);
  });

  it("el patrón coincide con el de la restricción SQL", () => {
    // La restricción CHECK de profiles.phone es '^\+[1-9][0-9]{7,14}$'.
    expect(PATRON_E164.source).toBe("^\\+[1-9]\\d{7,14}$");
  });
});

describe("validarTelefono", () => {
  it("no devuelve error para un número válido", () => {
    expect(validarTelefono("+56912345678")).toBeNull();
  });

  it("explica que falta el número", () => {
    expect(validarTelefono("")).toContain("Ingresa un número");
  });

  it("explica que falta el código de país", () => {
    expect(validarTelefono("912345678")).toContain("código de país");
  });

  it("explica que el número es demasiado corto", () => {
    expect(validarTelefono("+5691")).toContain("demasiado corto");
  });

  it("explica que el número es demasiado largo", () => {
    expect(validarTelefono("+56912345678901234")).toContain("demasiado largo");
  });

  it("entrega un mensaje con el formato esperado para casos raros", () => {
    expect(validarTelefono("+09123456789")).toContain("+56912345678");
  });

  it("todos los mensajes están en español", () => {
    const mensajes = [
      validarTelefono(""),
      validarTelefono("912345678"),
      validarTelefono("+5691"),
      validarTelefono("+56912345678901234"),
    ].filter((m): m is string => m !== null);

    expect(mensajes).toHaveLength(4);
    for (const mensaje of mensajes) {
      expect(mensaje).toMatch(/[áéíóúñ¿]|número|formato|Ingresa|código/);
    }
  });
});

describe("enmascararTelefono", () => {
  it("muestra sólo los últimos cuatro dígitos", () => {
    expect(enmascararTelefono("+56912345678")).toBe("••• ••• 5678");
  });

  it("informa cuando no hay número registrado", () => {
    expect(enmascararTelefono(null)).toBe("sin número registrado");
  });

  it("nunca revela el número completo", () => {
    const enmascarado = enmascararTelefono("+56987654321");
    expect(enmascarado).not.toContain("+56987");
    expect(enmascarado).toContain("4321");
  });
});

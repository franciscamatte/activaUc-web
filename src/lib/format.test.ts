import { describe, expect, it } from "vitest";
import { formatearDuracionHoras } from "./format";

/**
 * La anticipación de una cancelación se guarda en horas con decimales.
 * Los casos de abajo son valores reales de la bitácora, que es donde se
 * vio el problema: «297.3 h» no se entiende sin dividir por 24.
 */
describe("formatearDuracionHoras", () => {
  it("reparte las horas con decimales en días, horas y minutos", () => {
    expect(formatearDuracionHoras(297.3)).toBe("12 días, 9 horas y 18 minutos");
    expect(formatearDuracionHoras(87.15)).toBe("3 días, 15 horas y 9 minutos");
  });

  it("omite las unidades que valen cero", () => {
    expect(formatearDuracionHoras(18.06)).toBe("18 horas y 4 minutos");
    expect(formatearDuracionHoras(0.5)).toBe("30 minutos");
    expect(formatearDuracionHoras(24)).toBe("1 día");
    expect(formatearDuracionHoras(48.5)).toBe("2 días y 30 minutos");
  });

  it("usa el singular cuando corresponde", () => {
    expect(formatearDuracionHoras(25.02)).toBe("1 día, 1 hora y 1 minuto");
  });

  it("no dice «0 minutos» para una duración despreciable", () => {
    expect(formatearDuracionHoras(0)).toBe("menos de 1 minuto");
    expect(formatearDuracionHoras(0.004)).toBe("menos de 1 minuto");
  });

  it("trata lo negativo como cero en lugar de inventar un signo", () => {
    expect(formatearDuracionHoras(-5)).toBe("menos de 1 minuto");
  });

  it("no rompe la interfaz con un número que no existe", () => {
    expect(formatearDuracionHoras(Number.NaN)).toBe("—");
    expect(formatearDuracionHoras(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

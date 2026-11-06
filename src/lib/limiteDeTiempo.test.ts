import { describe, expect, it, vi } from "vitest";
import { conLimiteDeTiempo, TiempoExcedidoError } from "./limiteDeTiempo";

/**
 * Lo que importa aquí es el caso que `try/catch` no cubre: una promesa
 * que nunca se resuelve. Es lo que dejó la insignia de Google Calendar
 * en «Consultando…» para siempre.
 */
describe("límite de tiempo", () => {
  it("devuelve el valor cuando llega a tiempo", async () => {
    await expect(conLimiteDeTiempo(Promise.resolve(7), 50, "probar")).resolves.toBe(7);
  });

  it("propaga el error original sin tocarlo", async () => {
    const suyo = new Error("falló de verdad");
    await expect(conLimiteDeTiempo(Promise.reject(suyo), 50, "probar")).rejects.toBe(suyo);
  });

  it("deja de esperar una promesa que no vuelve nunca", async () => {
    vi.useFakeTimers();
    try {
      // Nada la resuelve: sin límite, esto no termina.
      const colgada = new Promise<string>(() => {});
      const esperando = conLimiteDeTiempo(colgada, 8_000, "consultar algo");

      const comprobacion = expect(esperando).rejects.toBeInstanceOf(TiempoExcedidoError);
      await vi.advanceTimersByTimeAsync(8_000);
      await comprobacion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("el mensaje dice qué se estaba esperando y cuánto", async () => {
    vi.useFakeTimers();
    try {
      const esperando = conLimiteDeTiempo(
        new Promise<void>(() => {}),
        3_000,
        "consultar tu conexión",
      );
      const comprobacion = expect(esperando).rejects.toThrow(
        /consultar tu conexión.*3 s/,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      await comprobacion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("no deja temporizadores sueltos cuando la promesa sí responde", async () => {
    vi.useFakeTimers();
    try {
      await conLimiteDeTiempo(Promise.resolve("listo"), 60_000, "probar");
      // Si el temporizador siguiera vivo, quedaría uno pendiente.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

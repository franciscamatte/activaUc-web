import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conReintentos, esperaConRetroceso } from "./retry";
import { AppError } from "./errors";

describe("esperaConRetroceso", () => {
  it("crece de forma exponencial", () => {
    // Con la fluctuación aleatoria, cada espera cae en [50%, 100%] del
    // valor exponencial; lo que importa es que el rango crezca.
    const rangos = [0, 1, 2, 3].map((intento) => {
      const valores = Array.from({ length: 200 }, () =>
        esperaConRetroceso(intento, 100, 60_000));
      return { min: Math.min(...valores), max: Math.max(...valores) };
    });

    expect(rangos[0].max).toBeLessThanOrEqual(100);
    expect(rangos[1].max).toBeLessThanOrEqual(200);
    expect(rangos[2].max).toBeLessThanOrEqual(400);
    expect(rangos[3].max).toBeLessThanOrEqual(800);

    expect(rangos[0].min).toBeGreaterThanOrEqual(50);
    expect(rangos[3].min).toBeGreaterThan(rangos[0].max);
  });

  it("respeta el tope máximo", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(esperaConRetroceso(20, 1_000, 5_000)).toBeLessThanOrEqual(5_000);
    }
  });

  it("introduce fluctuación para no sincronizar a todos los clientes", () => {
    const valores = new Set(
      Array.from({ length: 50 }, () => esperaConRetroceso(3, 1_000, 60_000)),
    );
    expect(valores.size).toBeGreaterThan(1);
  });
});

describe("conReintentos", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Ejecuta la operación adelantando los temporizadores de la espera.
   *
   * Se envuelve en allSettled antes de avanzar el reloj: así el rechazo
   * queda siempre con un manejador y no se reporta como "unhandled
   * rejection" cuando la promesa falla antes de que la esperemos.
   */
  async function ejecutar<T>(promesa: Promise<T>): Promise<T> {
    const resuelta = Promise.allSettled([promesa]);
    await vi.runAllTimersAsync();
    const [resultado] = await resuelta;
    if (resultado.status === "rejected") throw resultado.reason;
    return resultado.value;
  }

  it("no reintenta cuando la operación tiene éxito", async () => {
    const operacion = vi.fn().mockResolvedValue("listo");
    const salida = await ejecutar(conReintentos(operacion));

    expect(salida).toBe("listo");
    expect(operacion).toHaveBeenCalledTimes(1);
  });

  it("reintenta los errores transitorios y devuelve el resultado", async () => {
    const operacion = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue("recuperado");

    const salida = await ejecutar(conReintentos(operacion, { intentos: 2, esperaBaseMs: 10 }));

    expect(salida).toBe("recuperado");
    expect(operacion).toHaveBeenCalledTimes(3);
  });

  it("agota los intentos y propaga el error traducido", async () => {
    const operacion = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      ejecutar(conReintentos(operacion, { intentos: 2, esperaBaseMs: 10 })),
    ).rejects.toThrow(/conexión/i);

    expect(operacion).toHaveBeenCalledTimes(3);
  });

  it("no reintenta un error de permisos", async () => {
    const operacion = vi.fn().mockRejectedValue(
      new AppError("permisos", "No tienes permiso para realizar esta acción."),
    );

    await expect(
      ejecutar(conReintentos(operacion, { intentos: 3, esperaBaseMs: 10 })),
    ).rejects.toThrow(/permiso/);

    // Un error definitivo no debe repetirse: un solo intento.
    expect(operacion).toHaveBeenCalledTimes(1);
  });

  it("no reintenta una sesión expirada", async () => {
    const operacion = vi.fn().mockRejectedValue(
      new AppError("sesion_expirada", "Tu sesión expiró por seguridad."),
    );

    await expect(
      ejecutar(conReintentos(operacion, { intentos: 3, esperaBaseMs: 10 })),
    ).rejects.toThrow(/sesión expiró/);

    expect(operacion).toHaveBeenCalledTimes(1);
  });

  it("sí reintenta un límite de solicitudes", async () => {
    const operacion = vi.fn()
      .mockRejectedValueOnce(new AppError("limite_solicitudes", "Demasiadas solicitudes.", true))
      .mockResolvedValue("ok");

    const salida = await ejecutar(conReintentos(operacion, { intentos: 2, esperaBaseMs: 10 }));

    expect(salida).toBe("ok");
    expect(operacion).toHaveBeenCalledTimes(2);
  });

  it("se detiene si la señal de aborto se activa", async () => {
    const control = new AbortController();
    control.abort();

    const operacion = vi.fn().mockResolvedValue("no debería ejecutarse");

    await expect(
      ejecutar(conReintentos(operacion, { signal: control.signal })),
    ).rejects.toThrow(/cancelada/i);

    expect(operacion).not.toHaveBeenCalled();
  });
});

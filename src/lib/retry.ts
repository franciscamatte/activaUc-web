/**
 * Reintentos con retroceso exponencial para operaciones de lectura.
 *
 * Alcance deliberadamente limitado: sólo se reintenta lo que es seguro
 * repetir (consultas y recargas). Las escrituras no se reintentan de
 * forma automática en el cliente; la idempotencia y los reintentos de
 * las integraciones viven en el backend (colas calendar_sync_jobs y
 * notification_jobs), donde existe control transaccional.
 */

import { aAppError } from "./errors";

export interface OpcionesReintento {
  /** Número de reintentos tras el primer intento. */
  intentos?: number;
  /** Espera base en milisegundos. Crece de forma exponencial. */
  esperaBaseMs?: number;
  /** Espera máxima entre intentos. */
  esperaMaximaMs?: number;
  /** Señal para abortar (por ejemplo, al desmontar un componente). */
  signal?: AbortSignal;
}

export function esperaConRetroceso(
  intento: number,
  esperaBaseMs: number,
  esperaMaximaMs: number,
): number {
  const exponencial = esperaBaseMs * 2 ** intento;
  const tope = Math.min(exponencial, esperaMaximaMs);
  // Fluctuación aleatoria (jitter) para no sincronizar a todos los
  // clientes reintentando al mismo tiempo tras una caída.
  return Math.round(tope * (0.5 + Math.random() * 0.5));
}

function dormir(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Operación cancelada", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Operación cancelada", "AbortError"));
    }, { once: true });
  });
}

export async function conReintentos<T>(
  operacion: () => Promise<T>,
  opciones: OpcionesReintento = {},
): Promise<T> {
  const {
    intentos = 2,
    esperaBaseMs = 400,
    esperaMaximaMs = 5_000,
    signal,
  } = opciones;

  let ultimoError: unknown;

  for (let intento = 0; intento <= intentos; intento += 1) {
    if (signal?.aborted) {
      throw new DOMException("Operación cancelada", "AbortError");
    }

    try {
      return await operacion();
    } catch (error) {
      ultimoError = error;

      // Un error de permisos, de sesión o de datos no mejora al repetir.
      const appError = aAppError(error);
      if (!appError.reintentable || intento === intentos) {
        throw appError;
      }

      await dormir(esperaConRetroceso(intento, esperaBaseMs, esperaMaximaMs), signal);
    }
  }

  throw aAppError(ultimoError);
}

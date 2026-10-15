/**
 * REQ-9, REQ-10, REQ-11 · disponibilidad con filtros y actualización en vivo.
 *
 * Estrategia de actualización:
 *   1. Supabase Realtime (WebSockets) para los cambios de reservas,
 *      bloques y recintos. Es la vía principal.
 *   2. Respaldo por intervalo, porque Realtime no cubre todos los casos:
 *      un visitante anónimo no recibe eventos de public.reservations
 *      (RLS no se lo permite), y la conexión puede caerse.
 *   3. Refresco al recuperar el foco o la conectividad.
 *
 * Se evita el estado obsoleto descartando respuestas de peticiones que
 * ya fueron superadas por otra más reciente, y la suscripción se cancela
 * al desmontar para no dejar canales abiertos ni fugas de memoria.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivaRepository } from "../data";
import type { Disponibilidad, FiltrosCatalogo } from "../domain/types";
import { aAppError, type AppError } from "../lib/errors";

const INTERVALO_RESPALDO_MS = 45_000;

export interface EstadoDisponibilidad {
  bloques: Disponibilidad[];
  cargando: boolean;
  /** True mientras se refresca con datos ya en pantalla. */
  actualizando: boolean;
  error: AppError | null;
  ultimaActualizacion: Date | null;
  /** True cuando la suscripción en vivo está operativa. */
  envivo: boolean;
  recargar: () => void;
}

export function useDisponibilidad(
  repositorio: ActivaRepository | null,
  filtros: FiltrosCatalogo,
  opciones: { enLinea: boolean } = { enLinea: true },
): EstadoDisponibilidad {
  const [bloques, setBloques] = useState<Disponibilidad[]>([]);
  const [cargando, setCargando] = useState(true);
  const [actualizando, setActualizando] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [ultimaActualizacion, setUltimaActualizacion] = useState<Date | null>(null);

  const peticion = useRef(0);
  const hayDatos = useRef(false);

  // Los filtros se serializan para tener una dependencia estable: un
  // objeto nuevo en cada render dispararía consultas infinitas.
  const clave = JSON.stringify(filtros);

  const consultar = useCallback(
    async (silencioso: boolean) => {
      if (!repositorio) return;

      const propia = ++peticion.current;
      if (silencioso && hayDatos.current) setActualizando(true);
      else setCargando(true);

      try {
        const datos = await repositorio.consultarDisponibilidad(
          JSON.parse(clave) as FiltrosCatalogo,
        );
        if (propia !== peticion.current) return; // respuesta superada
        setBloques(datos);
        hayDatos.current = true;
        setError(null);
        setUltimaActualizacion(new Date());
      } catch (e) {
        if (propia !== peticion.current) return;
        setError(aAppError(e, "consultar la disponibilidad"));
      } finally {
        if (propia === peticion.current) {
          setCargando(false);
          setActualizando(false);
        }
      }
    },
    [repositorio, clave],
  );

  // Carga inicial y cada vez que cambian los filtros. Traer datos del
  // servidor al montar es el caso de uso legítimo de un efecto.
  useEffect(() => {
    hayDatos.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consulta inicial al servidor
    void consultar(false);
  }, [consultar]);

  // Suscripción en vivo. El efecto sólo se conecta y se desconecta: el
  // indicador "en vivo" se deriva durante el render, sin estado extra.
  useEffect(() => {
    if (!repositorio || !opciones.enLinea) return;

    const cancelar = repositorio.observarDisponibilidad(() => {
      void consultar(true);
    });

    return cancelar;
  }, [repositorio, consultar, opciones.enLinea]);

  // Respaldo por intervalo, sólo mientras la pestaña está visible para
  // no consumir cuota en segundo plano.
  useEffect(() => {
    if (!opciones.enLinea) return;

    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void consultar(true);
      }
    }, INTERVALO_RESPALDO_MS);

    return () => window.clearInterval(id);
  }, [consultar, opciones.enLinea]);

  // Refresco al volver a la pestaña o al recuperar conexión.
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState === "visible") void consultar(true);
    };
    const alReconectar = () => void consultar(true);

    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("online", alReconectar);

    return () => {
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("online", alReconectar);
    };
  }, [consultar]);

  return {
    bloques,
    cargando,
    actualizando,
    error,
    ultimaActualizacion,
    envivo: repositorio !== null && opciones.enLinea,
    recargar: () => void consultar(false),
  };
}

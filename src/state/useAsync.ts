/**
 * Carga asíncrona con los estados que la interfaz necesita distinguir:
 * cargando, con datos, vacío, error y reintento.
 *
 * `operacion` DEBE ser estable entre renders (envuélvela en useCallback)
 * o null para no cargar nada. De esa forma el efecto depende únicamente
 * de la operación y no hace falta guardarla en una referencia, lo que
 * mantiene el hook alineado con las reglas del compilador de React.
 *
 * Se usa en las vistas que sólo leen (mis reservas, panel de
 * administración, auditoría). La disponibilidad tiene su propio hook
 * porque además gestiona Realtime.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { aAppError, type AppError } from "../lib/errors";

export interface EstadoAsync<T> {
  datos: T | null;
  cargando: boolean;
  actualizando: boolean;
  error: AppError | null;
  recargar: () => Promise<void>;
}

export function useAsync<T>(operacion: (() => Promise<T>) | null): EstadoAsync<T> {
  const [datos, setDatos] = useState<T | null>(null);
  const [cargando, setCargando] = useState(operacion !== null);
  const [actualizando, setActualizando] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  // Contador de peticiones: sólo se acepta la respuesta de la última, de
  // modo que una respuesta lenta no sobreescriba a una más reciente.
  const peticion = useRef(0);
  const montado = useRef(true);
  const hayDatos = useRef(false);

  const ejecutar = useCallback(async (
    fn: (() => Promise<T>) | null,
    silencioso: boolean,
  ) => {
    if (!fn) {
      setDatos(null);
      setCargando(false);
      return;
    }

    const propia = ++peticion.current;
    if (silencioso && hayDatos.current) setActualizando(true);
    else setCargando(true);

    try {
      const resultado = await fn();
      if (!montado.current || propia !== peticion.current) return;
      setDatos(resultado);
      hayDatos.current = true;
      setError(null);
    } catch (e) {
      if (!montado.current || propia !== peticion.current) return;
      setError(aAppError(e));
    } finally {
      if (montado.current && propia === peticion.current) {
        setCargando(false);
        setActualizando(false);
      }
    }
  }, []);

  // Carga inicial y recarga cuando cambia la operación. Obtener datos de
  // un sistema externo al montar es, precisamente, para lo que existe un
  // efecto; la regla set-state-in-effect apunta a estados derivables, que
  // no es el caso de una respuesta del servidor.
  useEffect(() => {
    montado.current = true;
    hayDatos.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial desde el servidor
    void ejecutar(operacion, false);

    return () => { montado.current = false; };
  }, [ejecutar, operacion]);

  return {
    datos,
    cargando,
    actualizando,
    error,
    recargar: () => ejecutar(operacion, true),
  };
}

/**
 * Detección de conexión a internet, para el estado "sin conexión".
 */

import { useEffect, useState } from "react";

export function useOnline(): boolean {
  const [enLinea, setEnLinea] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const conectado = () => setEnLinea(true);
    const desconectado = () => setEnLinea(false);

    window.addEventListener("online", conectado);
    window.addEventListener("offline", desconectado);

    return () => {
      window.removeEventListener("online", conectado);
      window.removeEventListener("offline", desconectado);
    };
  }, []);

  return enLinea;
}

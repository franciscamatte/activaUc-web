import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

interface Props {
  abierto: boolean;
  titulo: string;
  descripcion?: string;
  onCerrar: () => void;
  children: ReactNode;
  acciones: ReactNode;
}

/**
 * Diálogo modal accesible.
 *
 *  · role="dialog" con aria-modal y etiquetas asociadas.
 *  · Cierra con la tecla Escape.
 *  · Mueve el foco al diálogo al abrirse y lo devuelve al cerrarse.
 *  · Atrapa el foco con Tab para no perderlo detrás del fondo.
 */
export default function Modal({
  abierto,
  titulo,
  descripcion,
  onCerrar,
  children,
  acciones,
}: Props) {
  const idTitulo = useId();
  const idDescripcion = useId();
  const contenedor = useRef<HTMLDivElement>(null);
  const foconAnterior = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!abierto) return;

    foconAnterior.current = document.activeElement as HTMLElement | null;
    contenedor.current?.focus();

    const alTeclear = (evento: KeyboardEvent) => {
      if (evento.key === "Escape") {
        evento.preventDefault();
        onCerrar();
        return;
      }

      if (evento.key !== "Tab" || !contenedor.current) return;

      const enfocables = contenedor.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (enfocables.length === 0) return;

      const primero = enfocables[0];
      const ultimo = enfocables[enfocables.length - 1];

      if (evento.shiftKey && document.activeElement === primero) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault();
        primero.focus();
      }
    };

    document.addEventListener("keydown", alTeclear);
    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", alTeclear);
      document.body.style.overflow = overflowPrevio;
      foconAnterior.current?.focus();
    };
  }, [abierto, onCerrar]);

  if (!abierto) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-0 sm:items-center sm:p-4">
      {/* Fondo: un clic fuera cierra el diálogo. */}
      <div
        className="absolute inset-0"
        onClick={onCerrar}
        aria-hidden="true"
      />

      <div
        ref={contenedor}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        aria-describedby={descripcion ? idDescripcion : undefined}
        tabIndex={-1}
        className="relative w-full max-w-lg rounded-t-2xl bg-white p-6 shadow-xl outline-none sm:rounded-2xl"
      >
        <h2 id={idTitulo} className="text-lg font-bold text-slate-900">
          {titulo}
        </h2>
        {descripcion ? (
          <p id={idDescripcion} className="mt-1 text-sm text-slate-600">
            {descripcion}
          </p>
        ) : null}

        <div className="mt-4 space-y-4 text-sm text-slate-700">{children}</div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {acciones}
        </div>
      </div>
    </div>
  );
}

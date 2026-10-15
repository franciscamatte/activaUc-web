/**
 * Indicador del flujo de reserva.
 *
 * Mostrar los pasos explícitamente ayuda a que la persona sepa dónde
 * está y cuánto le falta. La lista vive en src/domain/pasosReserva.ts.
 */

import { PASOS } from "../domain/pasosReserva";

export default function PasosReserva({ pasoActual }: { pasoActual: 1 | 2 | 3 | 4 }) {
  return (
    <nav aria-label="Pasos para reservar">
      <ol className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
        {PASOS.map((paso) => {
          const completado = paso.numero < pasoActual;
          const activo = paso.numero === pasoActual;

          return (
            <li
              key={paso.numero}
              aria-current={activo ? "step" : undefined}
              className={[
                "flex flex-1 items-center gap-3 rounded-xl border px-3 py-2.5",
                activo
                  ? "border-emerald-600 bg-emerald-50"
                  : completado
                    ? "border-emerald-200 bg-white"
                    : "border-slate-200 bg-white",
              ].join(" ")}
            >
              <span
                aria-hidden="true"
                className={[
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                  activo
                    ? "bg-emerald-700 text-white"
                    : completado
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-slate-100 text-slate-500",
                ].join(" ")}
              >
                {completado ? "✓" : paso.numero}
              </span>

              <span className="min-w-0">
                <span
                  className={[
                    "block text-sm font-semibold",
                    activo ? "text-emerald-900" : completado ? "text-emerald-800" : "text-slate-700",
                  ].join(" ")}
                >
                  <span className="sr-only">
                    Paso {paso.numero} de {PASOS.length}:{" "}
                  </span>
                  {paso.titulo}
                  {completado ? <span className="sr-only"> (completado)</span> : null}
                </span>
                <span className="block truncate text-xs text-slate-500">{paso.detalle}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

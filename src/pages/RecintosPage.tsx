import { useState } from "react";
import { bloques, recintos } from "../data/mock";
import type { Recinto } from "../data/mock";

function DetalleRecinto({
  recinto,
  onVolver,
}: {
  recinto: Recinto;
  onVolver: () => void;
}) {
  const bloquesDelRecinto = bloques.filter(
    (bloque) => bloque.recintoId === recinto.id,
  );

  return (
    <section>
      <button
        type="button"
        onClick={onVolver}
        className="text-sm font-medium text-emerald-700 hover:underline"
      >
        ← Volver a recintos
      </button>

      <p className="mt-4 text-xs font-medium uppercase text-emerald-700">
        {recinto.tipo}
      </p>
      <h1 className="text-2xl font-bold">{recinto.nombre}</h1>
      <p className="mt-2 text-slate-600">{recinto.descripcion}</p>
      <p className="mt-1 text-sm text-slate-500">{recinto.horario}</p>

      <h2 className="mt-8 text-lg font-semibold">Bloques</h2>
      <ul className="mt-3 space-y-3">
        {bloquesDelRecinto.map((bloque) => {
          const disponibles = bloque.capacidad - bloque.ocupados;

          return (
            <li
              key={bloque.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4"
            >
              <div>
                <p className="font-semibold">
                  {bloque.inicio} - {bloque.fin}
                </p>
                <p className="text-sm text-slate-500">{bloque.fecha}</p>
                <p
                  className={
                    disponibles === 0
                      ? "mt-1 text-sm text-red-600"
                      : "mt-1 text-sm text-slate-600"
                  }
                >
                  {disponibles === 0
                    ? "Sin cupos"
                    : `${disponibles} de ${bloque.capacidad} cupos disponibles`}
                </p>
              </div>
              <button
                type="button"
                disabled={disponibles === 0}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              >
                Reservar
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function RecintosPage() {
  const [seleccionado, setSeleccionado] = useState<Recinto | null>(null);

  if (seleccionado) {
    return (
      <DetalleRecinto
        recinto={seleccionado}
        onVolver={() => setSeleccionado(null)}
      />
    );
  }

  return (
    <section>
      <h1 className="text-2xl font-bold">Recintos</h1>
      <p className="mt-1 text-slate-600">
        Elige un recinto para ver sus bloques disponibles.
      </p>

      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {recintos.map((recinto) => (
          <li
            key={recinto.id}
            className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5"
          >
            <div>
              <p className="text-xs font-medium uppercase text-emerald-700">
                {recinto.tipo}
              </p>
              <h2 className="mt-1 text-lg font-semibold">{recinto.nombre}</h2>
              <p className="mt-2 text-sm text-slate-600">
                {recinto.descripcion}
              </p>
              <p className="mt-3 text-sm text-slate-500">{recinto.horario}</p>
            </div>
            <button
              type="button"
              onClick={() => setSeleccionado(recinto)}
              className="mt-4 self-start text-sm font-medium text-emerald-700 hover:underline"
            >
              Ver bloques →
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
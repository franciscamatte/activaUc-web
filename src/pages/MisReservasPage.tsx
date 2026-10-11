import { useState } from "react";
import { reservas } from "../data/mock";
import type { Reserva } from "../data/mock";

type Pestana = Reserva["estado"];

const pestanas: { id: Pestana; nombre: string }[] = [
  { id: "vigente", nombre: "Vigentes" },
  { id: "pasada", nombre: "Pasadas" },
];

function ReservaList({ items }: { items: Reserva[] }) {
  if (items.length === 0) {
    return <p className="mt-6 text-sm text-slate-500">No hay reservas.</p>;
  }

  return (
    <ul className="mt-6 space-y-3">
      {items.map((reserva) => (
        <li
          key={reserva.id}
          className="rounded-xl border border-slate-200 bg-white p-4"
        >
          <p className="font-semibold">{reserva.recinto}</p>
          <p className="text-sm text-slate-600">
            {reserva.fecha} · {reserva.bloque}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default function MisReservasPage() {
  const [pestana, setPestana] = useState<Pestana>("vigente");
  const items = reservas.filter((r) => r.estado === pestana);

  return (
    <section>
      <h1 className="text-2xl font-bold">Mis reservas</h1>

      <div role="tablist" className="mt-6 flex gap-1 border-b border-slate-200">
        {pestanas.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={pestana === p.id}
            onClick={() => setPestana(p.id)}
            className={
              pestana === p.id
                ? "-mb-px border-b-2 border-emerald-600 px-4 py-2 text-sm font-medium text-emerald-700"
                : "-mb-px border-b-2 border-transparent px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-800"
            }
          >
            {p.nombre}
          </button>
        ))}
      </div>

      <ReservaList items={items} />
    </section>
  );
}
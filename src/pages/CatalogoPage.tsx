import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Bloque, FiltrosCatalogo } from "../domain/types";
import { formatDateTime } from "../lib/date";
import { useAppState } from "../state/AppProvider";

function capacityLabel(total: number, used: number): string {
  const free = total - used;
  return free <= 0 ? "Sin cupos" : `${free} cupos disponibles`;
}

export default function CatalogoPage() {
  const { snapshot, filteredBlocks, bloquesFiltrados, reservar, error, currentUser } = useAppState();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Bloque | null>(null);
  const [filtros, setFiltros] = useState<FiltrosCatalogo>({
    fecha: "",
    tipoRecinto: "",
    desde: "",
    hasta: "",
  });

  const ocupacionMap = useMemo(() => {
    const map = new Map<string, number>();
    snapshot?.reservas
      .filter((r) => r.estado === "vigente")
      .forEach((reserva) => {
        map.set(reserva.bloqueId, (map.get(reserva.bloqueId) ?? 0) + 1);
      });
    return map;
  }, [snapshot?.reservas]);

  const recintosById = useMemo(
    () => new Map(snapshot?.recintos.map((r) => [r.id, r]) ?? []),
    [snapshot?.recintos],
  );

  async function onFilterSubmit(e: FormEvent) {
    e.preventDefault();
    await bloquesFiltrados(filtros);
  }

  async function confirmReservation() {
    if (!selected) {
      return;
    }
    if (!currentUser) {
      navigate("/login", { state: { from: "/catalogo" } });
      return;
    }
    try {
      await reservar(selected.id);
      setSelected(null);
    } catch {
      return;
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Catálogo de recintos</h1>
        <p className="text-slate-600">Paso 1: filtra · Paso 2: selecciona · Paso 3: confirma · Paso 4: revisa en Mis reservas.</p>
      </div>

      <form onSubmit={onFilterSubmit} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5">
        <input type="date" value={filtros.fecha} onChange={(e) => setFiltros((f) => ({ ...f, fecha: e.target.value }))} className="rounded-md border border-slate-300 px-3 py-2" />
        <select value={filtros.tipoRecinto} onChange={(e) => setFiltros((f) => ({ ...f, tipoRecinto: e.target.value }))} className="rounded-md border border-slate-300 px-3 py-2">
          <option value="">Todos los tipos</option>
          {[...new Set(snapshot?.recintos.map((r) => r.tipo) ?? [])].map((tipo) => (
            <option key={tipo} value={tipo}>{tipo}</option>
          ))}
        </select>
        <input type="time" value={filtros.desde} onChange={(e) => setFiltros((f) => ({ ...f, desde: e.target.value }))} className="rounded-md border border-slate-300 px-3 py-2" />
        <input type="time" value={filtros.hasta} onChange={(e) => setFiltros((f) => ({ ...f, hasta: e.target.value }))} className="rounded-md border border-slate-300 px-3 py-2" />
        <button type="submit" className="rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-700">Filtrar</button>
      </form>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <ul className="grid gap-4 lg:grid-cols-2">
        {filteredBlocks.map((bloque) => {
          const recinto = recintosById.get(bloque.recintoId);
          if (!recinto) {
            return null;
          }
          const used = ocupacionMap.get(bloque.id) ?? 0;
          const free = bloque.capacidadMaxima - used;

          return (
            <li key={bloque.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium uppercase text-emerald-700">{recinto.tipo}</p>
              <h2 className="text-lg font-semibold">{recinto.nombre}</h2>
              <p className="text-sm text-slate-600">{formatDateTime(bloque.inicio)} - {formatDateTime(bloque.fin)}</p>
              <p className={free <= 0 ? "mt-2 text-sm font-semibold text-red-600" : "mt-2 text-sm text-slate-600"}>
                {capacityLabel(bloque.capacidadMaxima, used)}
              </p>
              <button
                type="button"
                disabled={free <= 0}
                onClick={() => setSelected(bloque)}
                className="mt-3 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Reservar
              </button>
            </li>
          );
        })}
      </ul>

      {selected ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6">
            <h3 className="text-lg font-semibold">Confirmar reserva</h3>
            <p className="mt-2 text-sm text-slate-600">
              ¿Confirmas la reserva del bloque {formatDateTime(selected.inicio)}?
            </p>
            <div className="mt-6 flex gap-2">
              <button type="button" onClick={() => setSelected(null)} className="flex-1 rounded-md border border-slate-300 px-3 py-2">Volver</button>
              <button type="button" onClick={() => void confirmReservation()} className="flex-1 rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white">Confirmar</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

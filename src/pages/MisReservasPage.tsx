import { useMemo, useState } from "react";
import { formatDateTime } from "../lib/date";
import { splitReservations, useAppState } from "../state/AppProvider";

export default function MisReservasPage() {
  const { snapshot, currentUser, cancelarUsuario, error } = useAppState();
  const [tab, setTab] = useState<"vigentes" | "pasadas">("vigentes");

  const grouped = useMemo(() => {
    const own =
      snapshot?.reservas.filter((r) => r.usuarioId === currentUser?.id) ?? [];
    return splitReservations(own);
  }, [snapshot?.reservas, currentUser?.id]);

  const recintosById = useMemo(
    () => new Map(snapshot?.recintos.map((r) => [r.id, r.nombre]) ?? []),
    [snapshot?.recintos],
  );

  const items = tab === "vigentes" ? grouped.vigentes : grouped.pasadas;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Mis reservas</h1>
      <div className="flex gap-2 border-b border-slate-200">
        <button type="button" onClick={() => setTab("vigentes")} className={tab === "vigentes" ? "border-b-2 border-emerald-600 px-3 py-2 font-semibold text-emerald-700" : "px-3 py-2 text-slate-500"}>Vigentes</button>
        <button type="button" onClick={() => setTab("pasadas")} className={tab === "pasadas" ? "border-b-2 border-emerald-600 px-3 py-2 font-semibold text-emerald-700" : "px-3 py-2 text-slate-500"}>Reservas pasadas</button>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <ul className="space-y-3">
        {items.map((reserva) => (
          <li key={reserva.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="font-semibold">{recintosById.get(reserva.recintoId)}</p>
            <p className="text-sm text-slate-600">{formatDateTime(reserva.inicio)} - {formatDateTime(reserva.fin)}</p>
            <p className="text-xs text-slate-500">Calendar: {reserva.calendarSync} · WhatsApp: {reserva.whatsappConfirmacion}</p>
            {tab === "vigentes" ? (
              <button
                type="button"
                onClick={() => void cancelarUsuario(reserva.id)}
                className="mt-3 rounded-md border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50"
              >
                Cancelar reserva
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {items.length === 0 ? <p className="text-sm text-slate-500">No hay reservas en esta sección.</p> : null}
    </section>
  );
}

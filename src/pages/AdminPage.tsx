import { FormEvent, useMemo, useState } from "react";
import { formatDateTime } from "../lib/date";
import { useAppState } from "../state/AppProvider";

export default function AdminPage() {
  const { snapshot, currentUser, saveRecinto, saveBloque, cancelarAdmin, error } = useAppState();
  const [recintoNombre, setRecintoNombre] = useState("");
  const [tipo, setTipo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [horario, setHorario] = useState("");
  const [bloqueRecintoId, setBloqueRecintoId] = useState("");
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [capacidad, setCapacidad] = useState(1);

  const recintosAsignados = useMemo(() => {
    if (!snapshot || !currentUser) {
      return [];
    }
    const ids = snapshot.asignaciones
      .filter((a) => a.administradorId === currentUser.id)
      .map((a) => a.recintoId);
    return snapshot.recintos.filter((r) => ids.includes(r.id));
  }, [snapshot, currentUser]);

  const reservasRecintosAsignados = useMemo(() => {
    const allowed = new Set(recintosAsignados.map((r) => r.id));
    return (snapshot?.reservas ?? []).filter((r) => allowed.has(r.recintoId));
  }, [snapshot?.reservas, recintosAsignados]);

  async function onSaveRecinto(e: FormEvent) {
    e.preventDefault();
    await saveRecinto({
      nombre: recintoNombre,
      tipo,
      descripcion,
      horarioFuncionamiento: horario,
      activo: true,
    });
    setRecintoNombre("");
    setTipo("");
    setDescripcion("");
    setHorario("");
  }

  async function onSaveBloque(e: FormEvent) {
    e.preventDefault();
    await saveBloque({
      recintoId: bloqueRecintoId,
      inicio: new Date(inicio).toISOString(),
      fin: new Date(fin).toISOString(),
      capacidadMaxima: capacidad,
      activo: true,
    });
    setInicio("");
    setFin("");
  }

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-bold">Panel de administración</h1>
      <p className="text-sm text-slate-600">Gestiona solo recintos asignados y revisa estados de integraciones.</p>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <form onSubmit={(e) => void onSaveRecinto(e)} className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-semibold">Gestionar recintos</h2>
          <p className="text-xs text-slate-500">Crear/actualizar disponibilidad del recinto.</p>
          <div className="mt-3 space-y-2">
            <input required placeholder="Nombre" value={recintoNombre} onChange={(e) => setRecintoNombre(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" />
            <input required placeholder="Tipo" value={tipo} onChange={(e) => setTipo(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" />
            <textarea required placeholder="Descripción" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" />
            <input required placeholder="Horario" value={horario} onChange={(e) => setHorario(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" />
          </div>
          <button type="submit" className="mt-3 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white">Guardar recinto</button>
        </form>

        <form onSubmit={(e) => void onSaveBloque(e)} className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-semibold">Agregar disponibilidad</h2>
          <div className="mt-3 space-y-2">
            <select required value={bloqueRecintoId} onChange={(e) => setBloqueRecintoId(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2">
              <option value="">Selecciona recinto asignado</option>
              {recintosAsignados.map((recinto) => (
                <option key={recinto.id} value={recinto.id}>{recinto.nombre}</option>
              ))}
            </select>
            <input required type="datetime-local" value={inicio} onChange={(e) => setInicio(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" />
            <input required type="datetime-local" value={fin} onChange={(e) => setFin(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2" />
            <input required type="number" min={1} value={capacidad} onChange={(e) => setCapacidad(Number(e.target.value))} className="w-full rounded-md border border-slate-300 px-3 py-2" />
          </div>
          <button type="submit" className="mt-3 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white">Guardar bloque</button>
        </form>
      </div>

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Recinto</th>
              <th className="px-3 py-2">Horario</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Calendar</th>
              <th className="px-3 py-2">WhatsApp</th>
              <th className="px-3 py-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {reservasRecintosAsignados.map((reserva) => (
              <tr key={reserva.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{snapshot?.recintos.find((r) => r.id === reserva.recintoId)?.nombre}</td>
                <td className="px-3 py-2">{formatDateTime(reserva.inicio)}</td>
                <td className="px-3 py-2">{reserva.estado}</td>
                <td className="px-3 py-2">{reserva.calendarSync}</td>
                <td className="px-3 py-2">{reserva.whatsappConfirmacion}</td>
                <td className="px-3 py-2">
                  {reserva.estado === "vigente" ? (
                    <button type="button" onClick={() => void cancelarAdmin(reserva.id)} className="rounded border border-red-300 px-2 py-1 text-red-700">Cancelar</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

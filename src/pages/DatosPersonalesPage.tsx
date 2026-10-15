import { FormEvent, useEffect, useState } from "react";
import { useAppState } from "../state/AppProvider";

export default function DatosPersonalesPage() {
  const { currentUser, updateProfile, error } = useAppState();
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [whatsapp, setWhatsapp] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (!currentUser) {
      return;
    }
    setNombre(currentUser.nombre);
    setTelefono(currentUser.telefono);
    setWhatsapp(currentUser.whatsappConsentido);
    setCalendar(currentUser.googleCalendarConectado);
  }, [currentUser]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await updateProfile({
        nombre,
        telefono: whatsapp ? telefono : "",
        whatsappConsentido: whatsapp,
        googleCalendarConectado: calendar,
      });
      setOk(true);
    } catch {
      setOk(false);
    }
  }

  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-6">
      <h1 className="text-2xl font-bold">Datos personales</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="grid gap-1 text-sm">
          Nombre
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className="rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm">
          Teléfono para WhatsApp
          <input value={telefono} onChange={(e) => setTelefono(e.target.value)} className="rounded-md border border-slate-300 px-3 py-2" placeholder="+569..." />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} className="mt-1" />
          <span>Acepto recibir confirmaciones y recordatorios por WhatsApp.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} className="mt-1" />
          <span>Conectar Google Calendar (opcional).</span>
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {ok ? <p className="text-sm text-emerald-700">Datos guardados correctamente.</p> : null}
        <button type="submit" className="rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-700">Guardar cambios</button>
      </form>
    </section>
  );
}

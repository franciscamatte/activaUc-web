import { Link } from "react-router-dom";

export default function LandingPage() {
  return (
    <section className="grid gap-8 lg:grid-cols-2">
      <div className="space-y-4">
        <p className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
          Plataforma oficial Deportes UC
        </p>
        <h1 className="text-4xl font-bold leading-tight text-slate-900">
          Reserva espacios deportivos en minutos
        </h1>
        <p className="text-slate-600">
          ActivaUC centraliza recintos, cupos y reservas en un flujo simple, accesible y
          100% en español.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/catalogo"
            className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white hover:bg-emerald-700"
          >
            Ver catálogo
          </Link>
          <Link
            to="/registro"
            className="rounded-lg border border-slate-300 px-5 py-3 font-semibold text-slate-800 hover:bg-slate-100"
          >
            Crear cuenta
          </Link>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold">Qué incluye esta versión</h2>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-slate-600">
          <li>Consulta de cupos por fecha, tipo de recinto y rango horario.</li>
          <li>Reserva y cancelación con reglas de negocio validadas.</li>
          <li>Panel de administración por recintos asignados.</li>
          <li>Estados de integraciones Google Calendar y WhatsApp.</li>
        </ul>
      </div>
    </section>
  );
}

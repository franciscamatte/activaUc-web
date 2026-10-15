import { Link } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { PASOS } from "../domain/pasosReserva";

const CARACTERISTICAS = [
  {
    titulo: "Disponibilidad en tiempo real",
    detalle:
      "Los cupos se actualizan al instante cuando alguien reserva o cancela, así que no reservas algo que ya no está.",
  },
  {
    titulo: "Sin sobrecupos ni duplicados",
    detalle:
      "Cada reserva se crea con control transaccional en la base de datos, incluso cuando cientos de personas compiten por el mismo bloque.",
  },
  {
    titulo: "Recordatorios por WhatsApp",
    detalle:
      "Si registras tu número, te confirmamos la reserva y te recordamos el bloque 2 horas antes. Puedes revocarlo cuando quieras.",
  },
  {
    titulo: "Sincronización con Google Calendar",
    detalle:
      "Conecta tu calendario y cada reserva aparecerá como un evento. Desconectarlo no afecta tus reservas.",
  },
];

export default function LandingPage() {
  const { perfil } = useAuth();

  return (
    <div className="space-y-14">
      {/* Portada */}
      <section className="grid items-center gap-10 lg:grid-cols-2">
        <div className="space-y-5">
          <p className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-900">
            Plataforma oficial de Deportes UC
          </p>

          <h1 className="text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
            Reserva espacios deportivos en cuatro pasos
          </h1>

          <p className="max-w-xl text-lg leading-relaxed text-slate-600">
            ActivaUC centraliza los recintos, los bloques horarios y los cupos de Deportes UC
            en un solo lugar. Consulta la disponibilidad, reserva y cancela sin formularios
            ni correos.
          </p>

          <div className="flex flex-wrap gap-3">
            <Link
              to="/catalogo"
              className="rounded-lg bg-emerald-700 px-6 py-3 font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              Ver disponibilidad
            </Link>

            {perfil ? (
              <Link
                to="/mis-reservas"
                className="rounded-lg border border-slate-300 bg-white px-6 py-3 font-semibold text-slate-800 transition hover:bg-slate-50"
              >
                Mis reservas
              </Link>
            ) : (
              <Link
                to="/registro"
                className="rounded-lg border border-slate-300 bg-white px-6 py-3 font-semibold text-slate-800 transition hover:bg-slate-50"
              >
                Crear cuenta
              </Link>
            )}
          </div>
        </div>

        {/* Pasos del flujo de reserva */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Cómo funciona</h2>
          <ol className="mt-5 space-y-4">
            {PASOS.map((paso) => (
              <li key={paso.numero} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-sm font-bold text-white"
                >
                  {paso.numero}
                </span>
                <span>
                  <span className="block font-semibold text-slate-900">{paso.titulo}</span>
                  <span className="block text-sm text-slate-600">{paso.detalle}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Características */}
      <section>
        <h2 className="text-2xl font-bold text-slate-900">Qué incluye esta versión</h2>
        <ul className="mt-6 grid gap-5 sm:grid-cols-2">
          {CARACTERISTICAS.map((item) => (
            <li
              key={item.titulo}
              className="rounded-xl border border-slate-200 bg-white p-5"
            >
              <h3 className="font-semibold text-slate-900">{item.titulo}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{item.detalle}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Reglas que conviene conocer antes de reservar */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-bold text-slate-900">Antes de reservar</h2>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
          <li>Necesitas una cuenta con correo confirmado para poder reservar.</li>
          <li>
            Puedes tener una sola reserva vigente por bloque horario, fecha y recinto.
          </li>
          <li>
            Las cancelaciones se hacen con al menos <strong>2 horas de anticipación</strong>,
            para que el cupo quede disponible para otras personas.
          </li>
          <li>
            La administración del recinto puede cancelar reservas por mantención y te
            avisará por WhatsApp si tienes el número registrado.
          </li>
          <li>
            Tus datos personales (correo y teléfono) sólo son visibles para ti.
          </li>
        </ul>
      </section>
    </div>
  );
}

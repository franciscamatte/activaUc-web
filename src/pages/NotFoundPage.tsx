import { Link, useLocation } from "react-router-dom";

export default function NotFoundPage() {
  const ubicacion = useLocation();

  return (
    <section className="mx-auto max-w-lg py-10 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-emerald-800">
        Error 404
      </p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">Página no encontrada</h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        La dirección <code className="rounded bg-slate-100 px-1.5 py-0.5">{ubicacion.pathname}</code>{" "}
        no corresponde a ninguna sección de ActivaUC. Puede que el enlace esté desactualizado.
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          to="/"
          className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          Volver al inicio
        </Link>
        <Link
          to="/catalogo"
          className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          Ver catálogo
        </Link>
      </div>
    </section>
  );
}

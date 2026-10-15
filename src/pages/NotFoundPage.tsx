import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <section className="text-center">
      <h1 className="text-3xl font-bold">Página no encontrada</h1>
      <p className="mt-2 text-slate-600">La ruta que buscas no existe.</p>
      <Link to="/" className="mt-4 inline-block rounded-md bg-emerald-600 px-4 py-2 text-white">
        Volver al inicio
      </Link>
    </section>
  );
}

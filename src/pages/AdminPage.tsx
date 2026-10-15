import { useCallback, useState } from "react";
import { useAuth } from "../state/authContext";
import { useAsync } from "../state/useAsync";
import type { Recinto } from "../domain/types";
import RecintosSeccion from "./admin/RecintosSeccion";
import BloquesSeccion from "./admin/BloquesSeccion";
import ReservasSeccion from "./admin/ReservasSeccion";
import IntegracionesSeccion from "./admin/IntegracionesSeccion";
import AuditoriaSeccion from "./admin/AuditoriaSeccion";
import { Cargando, ErrorConReintento } from "../components/ui/Estados";

const SECCIONES = [
  { id: "recintos", titulo: "Recintos" },
  { id: "bloques", titulo: "Bloques y capacidad" },
  { id: "reservas", titulo: "Reservas" },
  { id: "integraciones", titulo: "Integraciones" },
  { id: "auditoria", titulo: "Auditoría" },
] as const;

type SeccionId = (typeof SECCIONES)[number]["id"];

/**
 * REQ-28 a REQ-33 · panel de administración.
 *
 * La ruta está protegida por rol, pero eso es sólo comodidad: cada
 * operación vuelve a autorizarse en el backend contra
 * facility_admin_assignments, así que un administrador nunca puede
 * actuar sobre un recinto que no tiene asignado.
 */
export default function AdminPage() {
  const { repositorio, perfil } = useAuth();
  const [seccion, setSeccion] = useState<SeccionId>("recintos");

  const cargarRecintos = useCallback(
    () => (repositorio ? repositorio.listarRecintosAsignados() : Promise.resolve([])),
    [repositorio],
  );
  const recintos = useAsync<Recinto[]>(repositorio ? cargarRecintos : null);

  if (!repositorio || !perfil) {
    return <Cargando texto="Cargando el panel…" />;
  }

  const claseTab = (activa: boolean) =>
    [
      "whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700",
      activa
        ? "border-emerald-700 text-emerald-900"
        : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800",
    ].join(" ");

  const listaRecintos = recintos.datos ?? [];

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Panel de administración</h1>
        <p className="text-sm text-slate-600">
          Hola {perfil.nombre.split(" ")[0]}. Gestionas{" "}
          {listaRecintos.length === 1
            ? "1 recinto asignado"
            : `${listaRecintos.length} recintos asignados`}
          .
        </p>
      </header>

      <div className="overflow-x-auto border-b border-slate-200">
        <div role="tablist" aria-label="Secciones del panel" className="flex">
          {SECCIONES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={seccion === item.id}
              aria-controls="panel-admin"
              className={claseTab(seccion === item.id)}
              onClick={() => setSeccion(item.id)}
            >
              {item.titulo}
            </button>
          ))}
        </div>
      </div>

      <div id="panel-admin" role="tabpanel" aria-labelledby={`tab-${seccion}`}>
        {recintos.error ? (
          <ErrorConReintento
            error={recintos.error}
            onReintentar={() => void recintos.recargar()}
            titulo="No pudimos cargar tus recintos"
          />
        ) : recintos.cargando ? (
          <Cargando texto="Cargando tus recintos…" />
        ) : seccion === "recintos" ? (
          <RecintosSeccion
            repositorio={repositorio}
            recintos={listaRecintos}
            onCambio={() => recintos.recargar()}
          />
        ) : seccion === "bloques" ? (
          <BloquesSeccion repositorio={repositorio} recintos={listaRecintos} />
        ) : seccion === "reservas" ? (
          <ReservasSeccion repositorio={repositorio} recintos={listaRecintos} />
        ) : seccion === "integraciones" ? (
          <IntegracionesSeccion repositorio={repositorio} />
        ) : (
          <AuditoriaSeccion repositorio={repositorio} recintos={listaRecintos} />
        )}
      </div>
    </section>
  );
}

import { useCallback, useState } from "react";
import type { ActivaRepository } from "../../data";
import { useAsync } from "../../state/useAsync";
import { etiquetaAccionAuditoria } from "../../data/rows";
import type { EntradaAuditoria, Recinto } from "../../domain/types";
import { formatearFechaHora } from "../../lib/format";
import Boton from "../../components/ui/Boton";
import { CampoSelect } from "../../components/ui/Campo";
import Insignia from "../../components/ui/Insignia";
import { Cargando, ErrorConReintento, SinDatos } from "../../components/ui/Estados";

interface Props {
  repositorio: ActivaRepository;
  recintos: Recinto[];
}

/** Detalles de auditoría que tienen sentido mostrar en la interfaz. */
function resumirDetalles(detalles: Record<string, unknown>): string {
  const partes: string[] = [];

  if (typeof detalles.motivo === "string" && detalles.motivo) {
    partes.push(`Motivo: ${detalles.motivo}`);
  }
  if (typeof detalles.horas_de_anticipacion === "number") {
    partes.push(`${detalles.horas_de_anticipacion} h de anticipación`);
  }
  if (typeof detalles.cupos_restantes === "number") {
    partes.push(`${detalles.cupos_restantes} cupos restantes`);
  }
  if (typeof detalles.intentos === "number") {
    partes.push(`${detalles.intentos} intentos`);
  }
  if (typeof detalles.tipo === "string") {
    partes.push(`Tipo: ${detalles.tipo}`);
  }
  if (typeof detalles.nombre === "string") {
    partes.push(detalles.nombre);
  }
  if (typeof detalles.capacidad === "number") {
    partes.push(`Capacidad: ${detalles.capacidad}`);
  }

  return partes.join(" · ");
}

/** Auditoría de acciones relevantes sobre los recintos asignados. */
export default function AuditoriaSeccion({ repositorio, recintos }: Props) {
  const [recintoId, setRecintoId] = useState("");

  const cargar = useCallback(
    () => repositorio.listarAuditoria(recintoId || null),
    [repositorio, recintoId],
  );
  const auditoria = useAsync<EntradaAuditoria[]>(cargar);

  const lista = auditoria.datos ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Auditoría</h2>
          <p className="text-sm text-slate-600">
            Registro de creaciones, cancelaciones y resultados de integración de tus
            recintos. No contiene datos personales ni credenciales.
          </p>
        </div>
        <Boton
          variante="secundario"
          tamano="pequeno"
          onClick={() => void auditoria.recargar()}
          cargando={auditoria.actualizando}
        >
          Actualizar
        </Boton>
      </div>

      <CampoSelect
        etiqueta="Recinto"
        value={recintoId}
        onChange={(e) => setRecintoId(e.target.value)}
      >
        <option value="">Todos mis recintos</option>
        {recintos.map((recinto) => (
          <option key={recinto.id} value={recinto.id}>{recinto.nombre}</option>
        ))}
      </CampoSelect>

      {auditoria.error ? (
        <ErrorConReintento error={auditoria.error} onReintentar={() => void auditoria.recargar()} />
      ) : auditoria.cargando ? (
        <Cargando texto="Cargando auditoría…" />
      ) : lista.length === 0 ? (
        <SinDatos
          titulo="Sin registros de auditoría"
          descripcion="Las acciones sobre tus recintos y sus reservas se registrarán aquí a medida que ocurran."
        />
      ) : (
        <ol className="space-y-2">
          {lista.map((entrada) => {
            const detalle = resumirDetalles(entrada.detalles);
            const esError = entrada.accion.includes("error") || entrada.accion.includes("fallido");
            const esCancelacion = entrada.accion.includes("cancelada");

            return (
              <li
                key={entrada.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Insignia tono={esError ? "error" : esCancelacion ? "aviso" : "neutro"}>
                      {etiquetaAccionAuditoria(entrada.accion)}
                    </Insignia>
                    {entrada.actorRol ? (
                      <span className="text-xs text-slate-500">
                        {entrada.actorRol === "administrador" ? "Administración" : "Usuario"}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">Sistema</span>
                    )}
                  </div>
                  {detalle ? (
                    <p className="mt-1 text-xs text-slate-600">{detalle}</p>
                  ) : null}
                </div>

                <time
                  dateTime={entrada.fecha}
                  className="shrink-0 text-xs text-slate-500"
                >
                  {formatearFechaHora(entrada.fecha)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

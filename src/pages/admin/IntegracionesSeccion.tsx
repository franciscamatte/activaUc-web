import { useCallback, useMemo, useState } from "react";
import type { ActivaRepository } from "../../data";
import { useAsync } from "../../state/useAsync";
import type { IncidenciaIntegracion } from "../../domain/types";
import { formatearFechaHora, formatearFechaMedia, formatearHora } from "../../lib/format";
import { aAppError } from "../../lib/errors";
import { esModoMock } from "../../data";
import Alerta from "../../components/ui/Alerta";
import Boton from "../../components/ui/Boton";
import Insignia, { type TonoInsignia } from "../../components/ui/Insignia";
import { Cargando, ErrorConReintento, SinDatos } from "../../components/ui/Estados";

interface Props {
  repositorio: ActivaRepository;
}

/** Estados de las colas, traducidos. */
const ETIQUETAS_ESTADO: Record<string, { texto: string; tono: TonoInsignia }> = {
  pendiente: { texto: "Pendiente", tono: "aviso" },
  procesando: { texto: "En proceso", tono: "info" },
  completado: { texto: "Completado", tono: "exito" },
  error: { texto: "Con error", tono: "error" },
  cancelado: { texto: "Cancelado", tono: "neutro" },
  enviado: { texto: "Enviado", tono: "info" },
  entregado: { texto: "Entregado", tono: "exito" },
  fallido: { texto: "Falló", tono: "error" },
  omitido: { texto: "Omitido", tono: "neutro" },
};

/** REQ-33 · estado de las sincronizaciones externas y sus errores. */
export default function IntegracionesSeccion({ repositorio }: Props) {
  const cargar = useCallback(
    () => repositorio.listarIncidenciasIntegracion(),
    [repositorio],
  );
  const incidencias = useAsync<IncidenciaIntegracion[]>(cargar);

  const lista = useMemo(() => incidencias.datos ?? [], [incidencias.datos]);

  // Descartar una incidencia la retira del informe sin borrar la fila:
  // el registro de envíos es la trazabilidad que pide REQ-27.
  const [descartando, setDescartando] = useState<string | null>(null);
  const [errorDescarte, setErrorDescarte] = useState<string | null>(null);

  async function descartar(incidencia: IncidenciaIntegracion) {
    const clave = `${incidencia.tipo}-${incidencia.referenciaId}`;
    setErrorDescarte(null);
    setDescartando(clave);
    try {
      const r = await repositorio.descartarIncidencia(
        incidencia.tipo,
        incidencia.referenciaId,
      );
      if (!r.ok) {
        setErrorDescarte(r.mensaje);
        return;
      }
      await incidencias.recargar();
    } catch (e) {
      setErrorDescarte(aAppError(e, "descartar la incidencia").message);
    } finally {
      setDescartando(null);
    }
  }

  const resumen = useMemo(() => {
    const contar = (predicado: (i: IncidenciaIntegracion) => boolean) =>
      lista.filter(predicado).length;

    return {
      total: lista.length,
      conError: contar((i) => i.estado === "error" || i.estado === "fallido"),
      pendientes: contar((i) => i.estado === "pendiente" || i.estado === "procesando"),
      calendario: contar((i) => i.tipo === "google_calendar"),
      whatsapp: contar((i) => i.tipo === "whatsapp"),
    };
  }, [lista]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Estado de integraciones</h2>
          <p className="text-sm text-slate-600">
            Sincronizaciones con Google Calendar y envíos de WhatsApp de las reservas de tus
            recintos. Una integración con error nunca invalida la reserva.
          </p>
        </div>
        <Boton
          variante="secundario"
          tamano="pequeno"
          onClick={() => void incidencias.recargar()}
          cargando={incidencias.actualizando}
        >
          Actualizar
        </Boton>
      </div>

      {esModoMock ? (
        <Alerta tono="aviso" titulo="Sin datos en modo demostración">
          Las colas de integración viven en el backend. En modo demostración no existen, así
          que esta sección no muestra información; preferimos dejarla vacía antes que
          inventar estados que no reflejan nada real.
        </Alerta>
      ) : null}

      {incidencias.error ? (
        <ErrorConReintento
          error={incidencias.error}
          onReintentar={() => void incidencias.recargar()}
        />
      ) : incidencias.cargando ? (
        <Cargando texto="Cargando estado de integraciones…" />
      ) : lista.length === 0 ? (
        <SinDatos
          titulo="No hay actividad de integraciones"
          descripcion="Cuando haya reservas con Google Calendar conectado o avisos por WhatsApp, su estado aparecerá aquí."
        />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { etiqueta: "Registros", valor: resumen.total },
              { etiqueta: "Con error", valor: resumen.conError },
              { etiqueta: "Pendientes", valor: resumen.pendientes },
              { etiqueta: "Google Calendar", valor: resumen.calendario },
            ].map((dato) => (
              <div
                key={dato.etiqueta}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <dt className="text-xs text-slate-500">{dato.etiqueta}</dt>
                <dd className="mt-0.5 text-xl font-bold text-slate-900">{dato.valor}</dd>
              </div>
            ))}
          </dl>

          {resumen.conError > 0 ? (
            <Alerta tono="aviso" titulo="Hay integraciones con error">
              Las reservas afectadas siguen siendo válidas. Revisa los detalles abajo y
              consulta <code className="rounded bg-amber-100 px-1">docs/OPERACION.md</code>{" "}
              para los pasos de recuperación. Cuando una ya esté resuelta o no haya nada
              que hacer, <strong>descártala</strong>: deja de contar aquí y la fila se
              conserva para la trazabilidad.
            </Alerta>
          ) : null}

          {errorDescarte ? (
            <Alerta
              tono="error"
              titulo="No pudimos descartar la incidencia"
              onCerrar={() => setErrorDescarte(null)}
            >
              {errorDescarte}
            </Alerta>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <caption className="sr-only">
                Registros de sincronización con Google Calendar y de envíos de WhatsApp
              </caption>
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Integración</th>
                  <th scope="col" className="px-4 py-3 font-medium">Recinto y reserva</th>
                  <th scope="col" className="px-4 py-3 font-medium">Estado</th>
                  <th scope="col" className="px-4 py-3 font-medium">Intentos</th>
                  <th scope="col" className="px-4 py-3 font-medium">Detalle</th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lista.map((incidencia) => {
                  const estado = ETIQUETAS_ESTADO[incidencia.estado] ?? {
                    texto: incidencia.estado,
                    tono: "neutro" as TonoInsignia,
                  };

                  return (
                    <tr key={`${incidencia.tipo}-${incidencia.referenciaId}`} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3">
                        <Insignia tono={incidencia.tipo === "google_calendar" ? "info" : "exito"}>
                          {incidencia.tipo === "google_calendar" ? "Google Calendar" : "WhatsApp"}
                        </Insignia>
                      </td>

                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{incidencia.recintoNombre}</p>
                        <p className="text-xs text-slate-600">
                          {formatearFechaMedia(incidencia.reservaInicio)} ·{" "}
                          {formatearHora(incidencia.reservaInicio)}
                        </p>
                      </td>

                      <td className="px-4 py-3">
                        <Insignia tono={estado.tono}>{estado.texto}</Insignia>
                        <p className="mt-1 text-xs text-slate-500">
                          {formatearFechaHora(incidencia.ocurridoEn)}
                        </p>
                      </td>

                      <td className="px-4 py-3 text-slate-700">
                        {incidencia.tipo === "google_calendar" ? incidencia.intentos : "—"}
                      </td>

                      <td className="max-w-xs px-4 py-3 text-xs text-slate-600">
                        {incidencia.ultimoError ?? "Sin incidencias"}
                      </td>

                      <td className="whitespace-nowrap px-4 py-3">
                        {incidencia.estado === "error" || incidencia.estado === "fallido" ? (
                          <Boton
                            variante="secundario"
                            tamano="pequeno"
                            cargando={
                              descartando === `${incidencia.tipo}-${incidencia.referenciaId}`
                            }
                            onClick={() => void descartar(incidencia)}
                          >
                            Descartar
                          </Boton>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

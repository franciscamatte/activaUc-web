import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { useAsync } from "../state/useAsync";
import { puedeCancelar, separarReservas } from "../domain/reservationRules";
import type { Reserva } from "../domain/types";
import { formatearFechaHora, formatearRango, tiempoRelativo } from "../lib/format";
import { aAppError } from "../lib/errors";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import Modal from "../components/ui/Modal";
import {
  InsigniaCalendario,
  InsigniaReserva,
  InsigniaWhatsapp,
} from "../components/ui/Insignia";
import { Cargando, ErrorConReintento, SinDatos } from "../components/ui/Estados";

type Pestana = "vigentes" | "pasadas";

/** REQ-14, REQ-15, REQ-21 · mis reservas vigentes, historial y cancelación. */
export default function MisReservasPage() {
  const { repositorio } = useAuth();
  const [pestana, setPestana] = useState<Pestana>("vigentes");
  const [aCancelar, setACancelar] = useState<Reserva | null>(null);
  const [cancelando, setCancelando] = useState(false);
  const [errorCancelacion, setErrorCancelacion] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(
    () => (repositorio ? repositorio.listarMisReservas() : Promise.resolve([])),
    [repositorio],
  );

  const reservas = useAsync<Reserva[]>(repositorio ? cargar : null);

  const { vigentes, pasadas } = useMemo(
    () => separarReservas(reservas.datos ?? []),
    [reservas.datos],
  );

  const lista = pestana === "vigentes" ? vigentes : pasadas;

  async function confirmarCancelacion() {
    if (!aCancelar || !repositorio) return;

    setCancelando(true);
    setErrorCancelacion(null);

    try {
      const resultado = await repositorio.cancelarReserva(aCancelar.id);

      if (!resultado.ok) {
        setErrorCancelacion(resultado.mensaje);
        await reservas.recargar();
        return;
      }

      setAviso(resultado.mensaje);
      setACancelar(null);
      await reservas.recargar();
    } catch (e) {
      setErrorCancelacion(aAppError(e, "cancelar la reserva").message);
    } finally {
      setCancelando(false);
    }
  }

  const clasePestana = (activa: boolean) =>
    [
      "border-b-2 px-4 py-2.5 text-sm font-medium transition",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700",
      activa
        ? "border-emerald-700 text-emerald-900"
        : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800",
    ].join(" ");

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Mis reservas</h1>
        <p className="text-sm text-slate-600">
          Revisa tus próximas reservas y el historial de las que ya pasaron.
        </p>
      </header>

      {aviso ? (
        <Alerta tono="exito" titulo="Reserva cancelada" onCerrar={() => setAviso(null)}>
          {aviso}
        </Alerta>
      ) : null}

      {/* REQ-14 · dos secciones separadas */}
      <div role="tablist" aria-label="Secciones de reservas" className="flex border-b border-slate-200">
        <button
          type="button"
          role="tab"
          id="tab-vigentes"
          aria-selected={pestana === "vigentes"}
          aria-controls="panel-reservas"
          className={clasePestana(pestana === "vigentes")}
          onClick={() => setPestana("vigentes")}
        >
          Mis reservas ({vigentes.length})
        </button>
        <button
          type="button"
          role="tab"
          id="tab-pasadas"
          aria-selected={pestana === "pasadas"}
          aria-controls="panel-reservas"
          className={clasePestana(pestana === "pasadas")}
          onClick={() => setPestana("pasadas")}
        >
          Reservas pasadas ({pasadas.length})
        </button>
      </div>

      <div
        id="panel-reservas"
        role="tabpanel"
        aria-labelledby={pestana === "vigentes" ? "tab-vigentes" : "tab-pasadas"}
        className="space-y-4"
      >
        {reservas.error ? (
          <ErrorConReintento
            error={reservas.error}
            onReintentar={() => void reservas.recargar()}
            titulo="No pudimos cargar tus reservas"
          />
        ) : reservas.cargando ? (
          <Cargando texto="Cargando tus reservas…" />
        ) : lista.length === 0 ? (
          <SinDatos
            titulo={
              pestana === "vigentes"
                ? "No tienes reservas vigentes"
                : "Todavía no tienes reservas pasadas"
            }
            descripcion={
              pestana === "vigentes"
                ? "Cuando reserves un bloque horario aparecerá aquí, con la opción de cancelarlo hasta 2 horas antes."
                : "Aquí quedará el historial de tus reservas finalizadas y canceladas."
            }
            accion={
              pestana === "vigentes" ? (
                <Link
                  to="/catalogo"
                  className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
                >
                  Ver catálogo de recintos
                </Link>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-4">
            {lista.map((reserva) => {
              const veredicto = puedeCancelar(reserva, "usuario");

              return (
                <li
                  key={reserva.id}
                  className="rounded-xl border border-slate-200 bg-white p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                        {reserva.recintoTipo}
                      </p>
                      <h2 className="mt-0.5 text-base font-semibold text-slate-900">
                        {reserva.recintoNombre}
                      </h2>
                      <p className="mt-1 text-sm text-slate-700">
                        {formatearRango(reserva.inicio, reserva.fin)}
                      </p>
                      {reserva.estado === "vigente" && !reserva.esPasada ? (
                        <p className="text-xs text-slate-500">
                          Comienza {tiempoRelativo(reserva.inicio)}
                        </p>
                      ) : null}
                    </div>

                    <InsigniaReserva estado={reserva.estado} esPasada={reserva.esPasada} />
                  </div>

                  {/* REQ-21 / REQ-27 · estado real de las integraciones */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <InsigniaCalendario estado={reserva.calendarSync} />
                    <InsigniaWhatsapp
                      estado={reserva.whatsappConfirmacion}
                      prefijo="Confirmación"
                    />
                    {reserva.whatsappRecordatorio !== "omitido" ? (
                      <InsigniaWhatsapp
                        estado={reserva.whatsappRecordatorio}
                        prefijo="Recordatorio"
                      />
                    ) : null}
                  </div>

                  {reserva.calendarSync === "error" ? (
                    <p className="mt-3 text-xs text-amber-800">
                      No pudimos sincronizar esta reserva con Google Calendar. Tu reserva
                      sigue siendo válida; puedes revisar la conexión en{" "}
                      <Link to="/datos-personales" className="font-medium underline">
                        Datos personales
                      </Link>
                      .
                    </p>
                  ) : null}

                  {reserva.estado === "cancelada" ? (
                    <p className="mt-3 text-xs text-slate-600">
                      Cancelada el {formatearFechaHora(reserva.canceladaEn ?? reserva.inicio)}
                      {reserva.canceladaPorRol === "administrador"
                        ? " por la administración del recinto"
                        : " por ti"}
                      {reserva.motivoCancelacion ? ` · Motivo: ${reserva.motivoCancelacion}` : ""}.
                    </p>
                  ) : null}

                  {pestana === "vigentes" ? (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <Boton
                        variante="peligro"
                        tamano="pequeno"
                        onClick={() => {
                          setACancelar(reserva);
                          setErrorCancelacion(null);
                        }}
                        disabled={!veredicto.permitido}
                        aria-describedby={
                          !veredicto.permitido ? `cancel-${reserva.id}` : undefined
                        }
                      >
                        Cancelar reserva
                      </Boton>

                      {!veredicto.permitido ? (
                        <p id={`cancel-${reserva.id}`} className="text-xs text-slate-600">
                          {veredicto.motivo}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal
        abierto={aCancelar !== null}
        titulo="Cancelar reserva"
        descripcion="El cupo quedará disponible de inmediato para otras personas."
        onCerrar={() => {
          setACancelar(null);
          setErrorCancelacion(null);
        }}
        acciones={
          <>
            <Boton
              variante="secundario"
              onClick={() => {
                setACancelar(null);
                setErrorCancelacion(null);
              }}
              disabled={cancelando}
            >
              Mantener la reserva
            </Boton>
            <Boton
              variante="peligro"
              onClick={() => void confirmarCancelacion()}
              cargando={cancelando}
            >
              Sí, cancelar
            </Boton>
          </>
        }
      >
        {aCancelar ? (
          <>
            <p>
              Vas a cancelar tu reserva en <strong>{aCancelar.recintoNombre}</strong> del{" "}
              <strong>{formatearRango(aCancelar.inicio, aCancelar.fin)}</strong>.
            </p>
            {aCancelar.tieneEventoCalendario ? (
              <p className="text-xs text-slate-600">
                También eliminaremos el evento de tu Google Calendar.
              </p>
            ) : null}
            {errorCancelacion ? (
              <Alerta tono="error" titulo="No pudimos cancelar la reserva">
                {errorCancelacion}
              </Alerta>
            ) : null}
          </>
        ) : null}
      </Modal>
    </section>
  );
}

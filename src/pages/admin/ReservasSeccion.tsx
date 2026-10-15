import { useCallback, useState } from "react";
import type { ActivaRepository } from "../../data";
import { useAsync } from "../../state/useAsync";
import { puedeCancelar } from "../../domain/reservationRules";
import type { Recinto, ReservaAdmin } from "../../domain/types";
import { formatearFechaMedia, formatearHora, tiempoRelativo } from "../../lib/format";
import { aAppError } from "../../lib/errors";
import Alerta from "../../components/ui/Alerta";
import Boton from "../../components/ui/Boton";
import { CampoSelect, CampoTextarea } from "../../components/ui/Campo";
import Insignia, {
  InsigniaCalendario,
  InsigniaReserva,
  InsigniaWhatsapp,
} from "../../components/ui/Insignia";
import Modal from "../../components/ui/Modal";
import { Cargando, ErrorConReintento, SinDatos } from "../../components/ui/Estados";

interface Props {
  repositorio: ActivaRepository;
  recintos: Recinto[];
}

type Alcance = "vigentes" | "historial" | "todas";

/** REQ-31, REQ-32, REQ-33 · monitoreo y cancelación administrativa. */
export default function ReservasSeccion({ repositorio, recintos }: Props) {
  const [recintoId, setRecintoId] = useState<string>("");
  const [alcance, setAlcance] = useState<Alcance>("vigentes");

  const cargar = useCallback(
    () => repositorio.listarReservasAdmin(recintoId || null, alcance),
    [repositorio, recintoId, alcance],
  );
  const reservas = useAsync<ReservaAdmin[]>(cargar);

  const [aCancelar, setACancelar] = useState<ReservaAdmin | null>(null);
  const [motivo, setMotivo] = useState("");
  const [cancelando, setCancelando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function cancelar() {
    if (!aCancelar) return;

    setCancelando(true);
    setError(null);

    try {
      const resultado = await repositorio.cancelarReserva(aCancelar.id, motivo);

      if (!resultado.ok) {
        setError(resultado.mensaje);
        await reservas.recargar();
        return;
      }

      setAviso(
        resultado.notificacionWhatsapp
          ? "Reserva cancelada. El cupo quedó libre y encolamos el aviso por WhatsApp al usuario."
          : "Reserva cancelada y cupo liberado. El usuario no tiene WhatsApp habilitado, así que no se envió aviso.",
      );
      setACancelar(null);
      setMotivo("");
      await reservas.recargar();
    } catch (e) {
      setError(aAppError(e, "cancelar la reserva").message);
    } finally {
      setCancelando(false);
    }
  }

  const lista = reservas.datos ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Reservas por recinto</h2>
        <p className="text-sm text-slate-600">
          Monitorea las reservas de tus recintos y cancélalas cuando sea necesario, por
          ejemplo por mantención. Como administradora/or no estás sujeta/o a la ventana de
          2 horas.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
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

        <CampoSelect
          etiqueta="Mostrar"
          value={alcance}
          onChange={(e) => setAlcance(e.target.value as Alcance)}
        >
          <option value="vigentes">Reservas vigentes</option>
          <option value="historial">Historial (pasadas y canceladas)</option>
          <option value="todas">Todas</option>
        </CampoSelect>
      </div>

      {aviso ? <Alerta tono="exito" onCerrar={() => setAviso(null)}>{aviso}</Alerta> : null}
      {error ? (
        <Alerta tono="error" titulo="No pudimos cancelar la reserva" onCerrar={() => setError(null)}>
          {error}
        </Alerta>
      ) : null}

      {reservas.error ? (
        <ErrorConReintento error={reservas.error} onReintentar={() => void reservas.recargar()} />
      ) : reservas.cargando ? (
        <Cargando texto="Cargando reservas…" />
      ) : lista.length === 0 ? (
        <SinDatos
          titulo={
            alcance === "vigentes"
              ? "No hay reservas vigentes"
              : "No hay reservas en el historial"
          }
          descripcion={
            alcance === "vigentes"
              ? "Cuando alguien reserve un bloque de tus recintos aparecerá aquí."
              : "Aquí se acumularán las reservas finalizadas y canceladas de tus recintos."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <caption className="sr-only">
              Reservas de los recintos asignados, con su estado y el de las integraciones
            </caption>
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Recinto y horario</th>
                <th scope="col" className="px-4 py-3 font-medium">Persona</th>
                <th scope="col" className="px-4 py-3 font-medium">Estado</th>
                <th scope="col" className="px-4 py-3 font-medium">Integraciones</th>
                <th scope="col" className="px-4 py-3 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lista.map((reserva) => {
                const veredicto = puedeCancelar(reserva, "administrador");

                return (
                  <tr key={reserva.id} className="align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{reserva.recintoNombre}</p>
                      <p className="text-xs text-slate-600">
                        {formatearFechaMedia(reserva.inicio)} ·{" "}
                        {formatearHora(reserva.inicio)} a {formatearHora(reserva.fin)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {tiempoRelativo(reserva.inicio)}
                      </p>
                    </td>

                    <td className="px-4 py-3">
                      {/* Sólo el nombre: el correo y el teléfono no se
                          exponen al panel, por protección de datos. */}
                      <p className="text-slate-800">{reserva.usuarioNombre}</p>
                    </td>

                    <td className="px-4 py-3">
                      <InsigniaReserva estado={reserva.estado} esPasada={reserva.esPasada} />
                      {reserva.estado === "cancelada" ? (
                        <p className="mt-1.5 text-xs text-slate-600">
                          {reserva.canceladaPorRol === "administrador"
                            ? "Por administración"
                            : "Por el usuario"}
                          {reserva.motivoCancelacion ? `: ${reserva.motivoCancelacion}` : ""}
                        </p>
                      ) : null}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1.5">
                        <InsigniaCalendario estado={reserva.calendarSync} />
                        <InsigniaWhatsapp estado={reserva.whatsappEstado} />
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      {veredicto.permitido ? (
                        <Boton
                          variante="peligro"
                          tamano="pequeno"
                          onClick={() => {
                            setACancelar(reserva);
                            setMotivo("");
                            setError(null);
                          }}
                        >
                          Cancelar
                        </Boton>
                      ) : (
                        <Insignia tono="neutro">{veredicto.motivo}</Insignia>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        abierto={aCancelar !== null}
        titulo="Cancelar reserva de un usuario"
        descripcion="El cupo se libera de inmediato y el usuario recibirá un aviso si habilitó WhatsApp."
        onCerrar={() => setACancelar(null)}
        acciones={
          <>
            <Boton variante="secundario" onClick={() => setACancelar(null)} disabled={cancelando}>
              Volver
            </Boton>
            <Boton variante="peligro" onClick={() => void cancelar()} cargando={cancelando}>
              Cancelar la reserva
            </Boton>
          </>
        }
      >
        {aCancelar ? (
          <>
            <p>
              Vas a cancelar la reserva de <strong>{aCancelar.usuarioNombre}</strong> en{" "}
              <strong>{aCancelar.recintoNombre}</strong>, del{" "}
              {formatearFechaMedia(aCancelar.inicio)} a las{" "}
              {formatearHora(aCancelar.inicio)}.
            </p>

            <CampoTextarea
              etiqueta="Motivo de la cancelación"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              maxLength={500}
              placeholder="Mantención programada de la cancha"
              ayuda="Se incluye en el aviso al usuario y queda registrado en la auditoría."
            />

            {error ? <Alerta tono="error">{error}</Alerta> : null}
          </>
        ) : null}
      </Modal>
    </div>
  );
}

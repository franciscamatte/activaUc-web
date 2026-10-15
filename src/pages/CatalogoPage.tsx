import { useCallback, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { useDisponibilidad } from "../state/useDisponibilidad";
import { useOnline } from "../state/useOnline";
import { useAsync } from "../state/useAsync";
import { puedeReservarBloque, tendraRecordatorio } from "../domain/reservationRules";
import {
  filtrosVacios,
  type Disponibilidad,
  type FiltrosCatalogo,
  type Reserva,
  type ResultadoReserva,
} from "../domain/types";
import { formatearHora, formatearRango, hoyComoValorFecha, tiempoRelativo } from "../lib/format";
import { aAppError } from "../lib/errors";
import PasosReserva from "../components/PasosReserva";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import { CampoCasilla, CampoSelect, CampoTexto } from "../components/ui/Campo";
import Insignia, { InsigniaCupos } from "../components/ui/Insignia";
import Modal from "../components/ui/Modal";
import { ErrorConReintento, EsqueletoTarjetas, SinDatos } from "../components/ui/Estados";

/** REQ-8 a REQ-13 · catálogo, filtros, disponibilidad en vivo y reserva. */
export default function CatalogoPage() {
  const { repositorio, perfil, calendario } = useAuth();
  const enLinea = useOnline();
  const navegar = useNavigate();

  const [filtros, setFiltros] = useState<FiltrosCatalogo>(filtrosVacios);
  const [borrador, setBorrador] = useState<FiltrosCatalogo>(filtrosVacios);
  const [seleccionado, setSeleccionado] = useState<Disponibilidad | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoReserva | null>(null);
  const [errorReserva, setErrorReserva] = useState<string | null>(null);

  const disponibilidad = useDisponibilidad(repositorio, filtros, { enLinea });

  const cargarRecintos = useCallback(
    () => (repositorio ? repositorio.listarRecintos() : Promise.resolve([])),
    [repositorio],
  );
  const recintos = useAsync(repositorio ? cargarRecintos : null);

  // Las reservas propias se usan para marcar los bloques ya reservados.
  const cargarMias = useCallback(
    () => (repositorio && perfil ? repositorio.listarMisReservas() : Promise.resolve([])),
    [repositorio, perfil],
  );
  const misReservas = useAsync<Reserva[]>(repositorio && perfil ? cargarMias : null);

  const tipos = useMemo(
    () => [...new Set((recintos.datos ?? []).map((r) => r.tipo))].sort((a, b) =>
      a.localeCompare(b, "es")),
    [recintos.datos],
  );

  const reservasPropias = misReservas.datos ?? [];

  // Bloques agrupados por día, para que la lista sea legible (REQ-10
  // permite rangos de varios días).
  const porDia = useMemo(() => {
    const grupos = new Map<string, Disponibilidad[]>();
    for (const bloque of disponibilidad.bloques) {
      const clave = bloque.inicio.slice(0, 10);
      const lista = grupos.get(clave) ?? [];
      lista.push(bloque);
      grupos.set(clave, lista);
    }
    return [...grupos.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [disponibilidad.bloques]);

  const filtrosAplicados = JSON.stringify(filtros) !== JSON.stringify(filtrosVacios);
  const paso: 1 | 2 | 3 | 4 = resultado?.ok ? 4 : seleccionado ? 3 : filtrosAplicados ? 2 : 1;

  function aplicarFiltros(evento: FormEvent) {
    evento.preventDefault();
    setFiltros(borrador);
  }

  function limpiarFiltros() {
    setBorrador(filtrosVacios);
    setFiltros(filtrosVacios);
  }

  function elegirBloque(bloque: Disponibilidad) {
    setErrorReserva(null);
    setResultado(null);

    if (!perfil) {
      navegar("/login", { state: { destino: "/catalogo" } });
      return;
    }
    setSeleccionado(bloque);
  }

  async function confirmarReserva() {
    if (!seleccionado || !repositorio) return;

    setConfirmando(true);
    setErrorReserva(null);

    try {
      const salida = await repositorio.crearReserva(seleccionado.bloqueId);

      if (!salida.ok) {
        // Fallo de negocio (sin cupos, bloque iniciado…): se muestra el
        // mensaje del backend y se refresca la disponibilidad, porque
        // probablemente otra persona tomó el cupo.
        setErrorReserva(salida.mensaje);
        disponibilidad.recargar();
        return;
      }

      setResultado(salida);
      setSeleccionado(null);
      disponibilidad.recargar();
      await misReservas.recargar();
    } catch (e) {
      setErrorReserva(aAppError(e, "confirmar la reserva").message);
    } finally {
      setConfirmando(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Catálogo de recintos</h1>
        <p className="text-sm text-slate-600">
          Consulta los bloques horarios disponibles y reserva en cuatro pasos.
        </p>
      </header>

      <PasosReserva pasoActual={paso} />

      {/* Paso 4 · confirmación de la reserva creada */}
      {resultado?.ok ? (
        <Alerta
          tono={resultado.duplicada ? "info" : "exito"}
          titulo={resultado.duplicada ? "Ya tenías esta reserva" : "Reserva confirmada"}
          onCerrar={() => setResultado(null)}
        >
          <p>{resultado.mensaje}</p>

          <ul className="mt-2 space-y-1 text-sm">
            {resultado.calendarSync === "pendiente" ? (
              <li>
                Estamos creando el evento en tu Google Calendar. El estado se actualiza en
                «Mis reservas» cuando la sincronización termina.
              </li>
            ) : null}
            {resultado.calendarSync === "no_aplica" && calendario?.estado !== "conectado" ? (
              <li>
                Si quieres que tus reservas aparezcan en tu calendario, conecta Google
                Calendar en{" "}
                <Link to="/datos-personales" className="font-medium underline">
                  Datos personales
                </Link>
                .
              </li>
            ) : null}
            {resultado.whatsappConfirmacion === "pendiente" ? (
              <li>Te enviaremos la confirmación por WhatsApp en unos instantes.</li>
            ) : null}
            {resultado.whatsappRecordatorio === "programado" ? (
              <li>Recibirás un recordatorio por WhatsApp 2 horas antes del bloque.</li>
            ) : null}
            {resultado.whatsappConfirmacion === "omitido" && !perfil?.whatsappConsentido ? (
              <li>
                Para recibir confirmaciones y recordatorios por WhatsApp, registra tu número
                en{" "}
                <Link to="/datos-personales" className="font-medium underline">
                  Datos personales
                </Link>
                .
              </li>
            ) : null}
          </ul>

          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              to="/mis-reservas"
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800"
            >
              Ver mis reservas
            </Link>
            <Boton variante="secundario" tamano="pequeno" onClick={() => setResultado(null)}>
              Reservar otro bloque
            </Boton>
          </div>
        </Alerta>
      ) : null}

      {/* Paso 1 · filtros (REQ-10) */}
      <form
        onSubmit={aplicarFiltros}
        className="rounded-2xl border border-slate-200 bg-white p-5"
        aria-label="Filtros de disponibilidad"
      >
        <h2 className="text-sm font-semibold text-slate-900">Filtrar disponibilidad</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <CampoTexto
            etiqueta="Desde la fecha"
            type="date"
            value={borrador.fechaDesde}
            min={hoyComoValorFecha()}
            onChange={(e) => setBorrador((f) => ({ ...f, fechaDesde: e.target.value }))}
            ayuda="Déjala vacía para ver todos los bloques próximos."
          />

          <CampoTexto
            etiqueta="Hasta la fecha"
            type="date"
            value={borrador.fechaHasta}
            min={borrador.fechaDesde || hoyComoValorFecha()}
            disabled={!borrador.fechaDesde}
            onChange={(e) => setBorrador((f) => ({ ...f, fechaHasta: e.target.value }))}
            ayuda="Para consultar un rango, por ejemplo una semana completa."
          />

          <CampoSelect
            etiqueta="Tipo de recinto"
            value={borrador.tipoRecinto}
            onChange={(e) => setBorrador((f) => ({ ...f, tipoRecinto: e.target.value }))}
          >
            <option value="">Todos los tipos</option>
            {tipos.map((tipo) => (
              <option key={tipo} value={tipo}>{tipo}</option>
            ))}
          </CampoSelect>

          <CampoSelect
            etiqueta="Recinto"
            value={borrador.recintoId}
            onChange={(e) => setBorrador((f) => ({ ...f, recintoId: e.target.value }))}
          >
            <option value="">Todos los recintos</option>
            {(recintos.datos ?? []).map((recinto) => (
              <option key={recinto.id} value={recinto.id}>{recinto.nombre}</option>
            ))}
          </CampoSelect>

          <CampoTexto
            etiqueta="Desde la hora"
            type="time"
            value={borrador.horaDesde}
            onChange={(e) => setBorrador((f) => ({ ...f, horaDesde: e.target.value }))}
            ayuda="Por ejemplo 09:00."
          />

          <CampoTexto
            etiqueta="Hasta la hora"
            type="time"
            value={borrador.horaHasta}
            onChange={(e) => setBorrador((f) => ({ ...f, horaHasta: e.target.value }))}
            ayuda="Por ejemplo 12:00."
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <CampoCasilla
            etiqueta="Mostrar sólo bloques con cupos disponibles"
            checked={borrador.soloConCupos}
            onChange={(e) => setBorrador((f) => ({ ...f, soloConCupos: e.target.checked }))}
          />

          <div className="flex gap-2">
            {filtrosAplicados ? (
              <Boton variante="secundario" tamano="pequeno" onClick={limpiarFiltros}>
                Limpiar filtros
              </Boton>
            ) : null}
            <Boton type="submit" tamano="pequeno">
              Aplicar filtros
            </Boton>
          </div>
        </div>
      </form>

      {/* Estado de la actualización en vivo (REQ-9) */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <p role="status" aria-live="polite">
          {disponibilidad.actualizando
            ? "Actualizando disponibilidad…"
            : disponibilidad.ultimaActualizacion
              ? `Disponibilidad actualizada ${tiempoRelativo(
                disponibilidad.ultimaActualizacion.toISOString(),
              )}.`
              : ""}
        </p>

        <span className="flex items-center gap-2">
          {disponibilidad.envivo && enLinea ? (
            <Insignia tono="exito">Actualización en vivo activa</Insignia>
          ) : (
            <Insignia tono="aviso">Actualización periódica</Insignia>
          )}
          <Boton variante="texto" tamano="pequeno" onClick={disponibilidad.recargar}>
            Actualizar ahora
          </Boton>
        </span>
      </div>

      {/* Resultados */}
      {disponibilidad.error ? (
        <ErrorConReintento
          error={disponibilidad.error}
          onReintentar={disponibilidad.recargar}
          titulo="No pudimos cargar la disponibilidad"
        />
      ) : disponibilidad.cargando ? (
        <EsqueletoTarjetas />
      ) : disponibilidad.bloques.length === 0 ? (
        <SinDatos
          titulo="No hay bloques que coincidan con tu búsqueda"
          descripcion={
            filtrosAplicados
              ? "Prueba con otra fecha, otro recinto o un rango horario más amplio."
              : "Por ahora no hay bloques horarios publicados. Vuelve a consultar más tarde o contacta a Deportes UC."
          }
          accion={
            filtrosAplicados ? (
              <Boton variante="secundario" onClick={limpiarFiltros}>
                Limpiar filtros
              </Boton>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-8">
          {porDia.map(([dia, bloques]) => (
            <div key={dia}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                {new Intl.DateTimeFormat("es-CL", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                }).format(new Date(`${dia}T12:00:00`))}
              </h2>

              <ul className="grid gap-4 sm:grid-cols-2">
                {bloques.map((bloque) => {
                  const veredicto = puedeReservarBloque(bloque, reservasPropias);
                  const yaReservado = reservasPropias.some(
                    (r) => r.bloqueId === bloque.bloqueId && r.estado === "vigente",
                  );

                  return (
                    <li
                      key={bloque.bloqueId}
                      className={[
                        "flex flex-col rounded-xl border bg-white p-5",
                        bloque.agotado ? "border-slate-200 opacity-80" : "border-slate-200",
                      ].join(" ")}
                    >
                      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                        {bloque.recintoTipo}
                      </p>
                      <h3 className="mt-1 text-base font-semibold text-slate-900">
                        {bloque.recintoNombre}
                      </h3>

                      <p className="mt-1 text-sm text-slate-700">
                        {formatearHora(bloque.inicio)} a {formatearHora(bloque.fin)}
                        <span className="text-slate-500">
                          {" · "}
                          {tiempoRelativo(bloque.inicio)}
                        </span>
                      </p>

                      {bloque.recintoDescripcion ? (
                        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-500">
                          {bloque.recintoDescripcion}
                        </p>
                      ) : null}

                      <div className="mt-3 flex flex-wrap gap-2">
                        <InsigniaCupos
                          disponibles={bloque.disponibles}
                          capacidad={bloque.capacidadMaxima}
                        />
                        {yaReservado ? <Insignia tono="info">Ya reservado por ti</Insignia> : null}
                      </div>

                      <div className="mt-4 flex items-center gap-3">
                        <Boton
                          onClick={() => elegirBloque(bloque)}
                          disabled={!veredicto.permitido}
                          tamano="pequeno"
                          aria-describedby={
                            !veredicto.permitido ? `motivo-${bloque.bloqueId}` : undefined
                          }
                        >
                          {perfil ? "Reservar" : "Ingresar para reservar"}
                        </Boton>

                        {!veredicto.permitido ? (
                          <p
                            id={`motivo-${bloque.bloqueId}`}
                            className="text-xs font-medium text-slate-500"
                          >
                            {veredicto.motivo}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Paso 3 · confirmación */}
      <Modal
        abierto={seleccionado !== null}
        titulo="Confirmar reserva"
        descripcion="Revisa los datos antes de confirmar."
        onCerrar={() => {
          setSeleccionado(null);
          setErrorReserva(null);
        }}
        acciones={
          <>
            <Boton
              variante="secundario"
              onClick={() => {
                setSeleccionado(null);
                setErrorReserva(null);
              }}
              disabled={confirmando}
            >
              Volver
            </Boton>
            <Boton onClick={() => void confirmarReserva()} cargando={confirmando}>
              Confirmar reserva
            </Boton>
          </>
        }
      >
        {seleccionado ? (
          <>
            <dl className="divide-y divide-slate-200 rounded-xl border border-slate-200">
              <div className="flex justify-between gap-4 px-4 py-2.5">
                <dt className="text-slate-500">Recinto</dt>
                <dd className="text-right font-medium text-slate-900">
                  {seleccionado.recintoNombre}
                </dd>
              </div>
              <div className="flex justify-between gap-4 px-4 py-2.5">
                <dt className="text-slate-500">Tipo</dt>
                <dd className="text-right font-medium text-slate-900">
                  {seleccionado.recintoTipo}
                </dd>
              </div>
              <div className="flex justify-between gap-4 px-4 py-2.5">
                <dt className="text-slate-500">Horario</dt>
                <dd className="text-right font-medium text-slate-900">
                  {formatearRango(seleccionado.inicio, seleccionado.fin)}
                </dd>
              </div>
              <div className="flex justify-between gap-4 px-4 py-2.5">
                <dt className="text-slate-500">Cupos restantes</dt>
                <dd className="text-right font-medium text-slate-900">
                  {seleccionado.disponibles} de {seleccionado.capacidadMaxima}
                </dd>
              </div>
            </dl>

            <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
              <li>
                Podrás cancelar esta reserva hasta 2 horas antes de su inicio desde «Mis
                reservas».
              </li>
              {calendario?.estado === "conectado" ? (
                <li>Crearemos el evento en tu Google Calendar automáticamente.</li>
              ) : null}
              {perfil?.whatsappConsentido ? (
                <li>
                  Te enviaremos la confirmación por WhatsApp
                  {tendraRecordatorio(seleccionado.inicio)
                    ? " y un recordatorio 2 horas antes."
                    : ". Como el bloque empieza en menos de 2 horas, no habrá recordatorio."}
                </li>
              ) : null}
            </ul>

            {errorReserva ? (
              <Alerta tono="error" titulo="No pudimos confirmar la reserva">
                {errorReserva}
              </Alerta>
            ) : null}
          </>
        ) : null}
      </Modal>
    </section>
  );
}

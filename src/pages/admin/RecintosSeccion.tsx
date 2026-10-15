import { useState } from "react";
import type { FormEvent } from "react";
import type { ActivaRepository } from "../../data";
import type { Recinto } from "../../domain/types";
import { aAppError } from "../../lib/errors";
import Alerta from "../../components/ui/Alerta";
import Boton from "../../components/ui/Boton";
import { CampoTexto, CampoTextarea } from "../../components/ui/Campo";
import Insignia from "../../components/ui/Insignia";
import Modal from "../../components/ui/Modal";
import { SinDatos } from "../../components/ui/Estados";

interface Props {
  repositorio: ActivaRepository;
  recintos: Recinto[];
  onCambio: () => void | Promise<void>;
}

const vacio = { nombre: "", tipo: "", descripcion: "", horarioFuncionamiento: "" };

/** REQ-28 · crear, editar y desactivar los recintos a cargo. */
export default function RecintosSeccion({ repositorio, recintos, onCambio }: Props) {
  const [formulario, setFormulario] = useState(vacio);
  const [creando, setCreando] = useState(false);
  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [editando, setEditando] = useState<Recinto | null>(null);
  const [edicion, setEdicion] = useState(vacio);
  const [guardando, setGuardando] = useState(false);

  const [aDesactivar, setADesactivar] = useState<Recinto | null>(null);

  async function crear(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setAviso(null);

    if (formulario.nombre.trim().length < 2 || formulario.tipo.trim().length < 2) {
      setError("El nombre y el tipo de recinto deben tener al menos 2 caracteres.");
      return;
    }

    setCreando(true);
    try {
      const resultado = await repositorio.crearRecinto({ ...formulario, activo: true });
      if (!resultado.ok) {
        setError(resultado.mensaje);
        return;
      }
      setAviso(resultado.mensaje);
      setFormulario(vacio);
      setMostrarFormulario(false);
      await onCambio();
    } catch (e) {
      setError(aAppError(e, "crear el recinto").message);
    } finally {
      setCreando(false);
    }
  }

  async function guardarEdicion() {
    if (!editando) return;
    setError(null);
    setGuardando(true);

    try {
      await repositorio.actualizarRecinto(editando.id, edicion);
      setAviso(`Actualizamos «${edicion.nombre}».`);
      setEditando(null);
      await onCambio();
    } catch (e) {
      setError(aAppError(e, "actualizar el recinto").message);
    } finally {
      setGuardando(false);
    }
  }

  async function cambiarActivo(recinto: Recinto, activo: boolean) {
    setError(null);
    setGuardando(true);
    try {
      await repositorio.actualizarRecinto(recinto.id, { activo });
      setAviso(
        activo
          ? `Reactivamos «${recinto.nombre}». Sus bloques activos vuelven a ser reservables.`
          : `Desactivamos «${recinto.nombre}». Dejará de aparecer en el catálogo; las reservas ya hechas se conservan.`,
      );
      setADesactivar(null);
      await onCambio();
    } catch (e) {
      setError(aAppError(e, "cambiar el estado del recinto").message);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Recintos a tu cargo</h2>
          <p className="text-sm text-slate-600">
            Sólo puedes gestionar los recintos que tienes asignados.
          </p>
        </div>
        <Boton onClick={() => setMostrarFormulario((v) => !v)} tamano="pequeno">
          {mostrarFormulario ? "Cancelar" : "Agregar recinto"}
        </Boton>
      </div>

      {aviso ? (
        <Alerta tono="exito" onCerrar={() => setAviso(null)}>{aviso}</Alerta>
      ) : null}
      {error ? (
        <Alerta tono="error" titulo="No pudimos completar la operación" onCerrar={() => setError(null)}>
          {error}
        </Alerta>
      ) : null}

      {mostrarFormulario ? (
        <form
          onSubmit={crear}
          noValidate
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5"
        >
          <h3 className="text-sm font-semibold text-slate-900">Nuevo recinto</h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <CampoTexto
              etiqueta="Nombre"
              required
              value={formulario.nombre}
              onChange={(e) => setFormulario((f) => ({ ...f, nombre: e.target.value }))}
              placeholder="Cancha de fútbol San Joaquín"
            />
            <CampoTexto
              etiqueta="Tipo de recinto"
              required
              value={formulario.tipo}
              onChange={(e) => setFormulario((f) => ({ ...f, tipo: e.target.value }))}
              placeholder="Fútbol"
              ayuda="Se usa como filtro en el catálogo."
            />
          </div>

          <CampoTextarea
            etiqueta="Descripción"
            value={formulario.descripcion}
            onChange={(e) => setFormulario((f) => ({ ...f, descripcion: e.target.value }))}
            placeholder="Superficie, iluminación, camarines, indicaciones de acceso…"
          />

          <CampoTexto
            etiqueta="Horario de funcionamiento"
            value={formulario.horarioFuncionamiento}
            onChange={(e) =>
              setFormulario((f) => ({ ...f, horarioFuncionamiento: e.target.value }))}
            placeholder="08:00 a 22:00, lunes a sábado"
            ayuda="Texto informativo que verán las personas en el catálogo."
          />

          <Boton type="submit" cargando={creando}>Crear recinto</Boton>
        </form>
      ) : null}

      {recintos.length === 0 ? (
        <SinDatos
          titulo="Todavía no tienes recintos asignados"
          descripcion="Crea tu primer recinto o pide a Deportes UC que te asigne uno existente."
          accion={<Boton onClick={() => setMostrarFormulario(true)}>Agregar recinto</Boton>}
        />
      ) : (
        <ul className="space-y-3">
          {recintos.map((recinto) => (
            <li key={recinto.id} className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-slate-900">{recinto.nombre}</h3>
                    {recinto.activo ? (
                      <Insignia tono="exito">Activo</Insignia>
                    ) : (
                      <Insignia tono="neutro">Desactivado</Insignia>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-emerald-800">
                    {recinto.tipo}
                  </p>
                  {recinto.descripcion ? (
                    <p className="mt-2 text-sm text-slate-600">{recinto.descripcion}</p>
                  ) : null}
                  {recinto.horarioFuncionamiento ? (
                    <p className="mt-1 text-xs text-slate-500">
                      Horario: {recinto.horarioFuncionamiento}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 gap-2">
                  <Boton
                    variante="secundario"
                    tamano="pequeno"
                    onClick={() => {
                      setEditando(recinto);
                      setEdicion({
                        nombre: recinto.nombre,
                        tipo: recinto.tipo,
                        descripcion: recinto.descripcion,
                        horarioFuncionamiento: recinto.horarioFuncionamiento,
                      });
                    }}
                  >
                    Editar
                  </Boton>

                  {recinto.activo ? (
                    <Boton
                      variante="peligro"
                      tamano="pequeno"
                      onClick={() => setADesactivar(recinto)}
                    >
                      Desactivar
                    </Boton>
                  ) : (
                    <Boton
                      variante="secundario"
                      tamano="pequeno"
                      onClick={() => void cambiarActivo(recinto, true)}
                      cargando={guardando}
                    >
                      Reactivar
                    </Boton>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        abierto={editando !== null}
        titulo="Editar recinto"
        onCerrar={() => setEditando(null)}
        acciones={
          <>
            <Boton variante="secundario" onClick={() => setEditando(null)} disabled={guardando}>
              Cancelar
            </Boton>
            <Boton onClick={() => void guardarEdicion()} cargando={guardando}>
              Guardar cambios
            </Boton>
          </>
        }
      >
        <div className="space-y-4">
          <CampoTexto
            etiqueta="Nombre"
            value={edicion.nombre}
            onChange={(e) => setEdicion((f) => ({ ...f, nombre: e.target.value }))}
          />
          <CampoTexto
            etiqueta="Tipo de recinto"
            value={edicion.tipo}
            onChange={(e) => setEdicion((f) => ({ ...f, tipo: e.target.value }))}
          />
          <CampoTextarea
            etiqueta="Descripción"
            value={edicion.descripcion}
            onChange={(e) => setEdicion((f) => ({ ...f, descripcion: e.target.value }))}
          />
          <CampoTexto
            etiqueta="Horario de funcionamiento"
            value={edicion.horarioFuncionamiento}
            onChange={(e) =>
              setEdicion((f) => ({ ...f, horarioFuncionamiento: e.target.value }))}
          />
        </div>
      </Modal>

      <Modal
        abierto={aDesactivar !== null}
        titulo="Desactivar recinto"
        descripcion="Dejará de aparecer en el catálogo."
        onCerrar={() => setADesactivar(null)}
        acciones={
          <>
            <Boton variante="secundario" onClick={() => setADesactivar(null)} disabled={guardando}>
              Mantener activo
            </Boton>
            <Boton
              variante="peligro"
              onClick={() => aDesactivar && void cambiarActivo(aDesactivar, false)}
              cargando={guardando}
            >
              Sí, desactivar
            </Boton>
          </>
        }
      >
        <p>
          No se elimina ningún dato: el recinto y su historial de reservas se conservan, y
          puedes reactivarlo cuando quieras. Las reservas ya confirmadas{" "}
          <strong>no se cancelan automáticamente</strong>; si necesitas liberar los bloques,
          cancélalas desde la pestaña «Reservas».
        </p>
      </Modal>
    </div>
  );
}

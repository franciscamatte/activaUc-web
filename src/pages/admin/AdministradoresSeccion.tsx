import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import type { ActivaRepository } from "../../data";
import type { AdministradorListado, RecintoAsignable } from "../../domain/types";
import { useAsync } from "../../state/useAsync";
import { aAppError } from "../../lib/errors";
import Alerta from "../../components/ui/Alerta";
import Boton from "../../components/ui/Boton";
import { CampoCasilla, CampoTexto } from "../../components/ui/Campo";
import Insignia from "../../components/ui/Insignia";
import Modal from "../../components/ui/Modal";
import { Cargando, ErrorConReintento, SinDatos } from "../../components/ui/Estados";

interface Props {
  repositorio: ActivaRepository;
}

/**
 * REQ-29 · el administrador general otorga el rol de administrador de
 * recintos y asigna los recintos a cargo.
 *
 * La cuenta tiene que existir antes: la persona se registra ella misma
 * por el flujo normal y aquí se le concede el rol. Es deliberado —así
 * nadie recibe una contraseña por un canal que no controla— y el
 * mensaje de error lo dice cuando el correo no corresponde a ninguna
 * cuenta.
 *
 * El rol de administrador general no se concede desde aquí: se asigna
 * con acceso directo a la base. Si la aplicación pudiera concederlo, una
 * cuenta comprometida podría crear más y no habría forma de acotarlo
 * desde fuera.
 */
export default function AdministradoresSeccion({ repositorio }: Props) {
  const cargarAdmins = useCallback(() => repositorio.listarAdministradores(), [repositorio]);
  const admins = useAsync<AdministradorListado[]>(cargarAdmins);

  const cargarRecintos = useCallback(() => repositorio.listarRecintosAsignables(), [repositorio]);
  const recintos = useAsync<RecintoAsignable[]>(cargarRecintos);

  const [correo, setCorreo] = useState("");
  const [elegidos, setElegidos] = useState<string[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [aRetirar, setARetirar] = useState<AdministradorListado | null>(null);
  const [retirando, setRetirando] = useState(false);

  function alternarRecinto(id: string) {
    setElegidos((previos) =>
      previos.includes(id) ? previos.filter((r) => r !== id) : [...previos, id],
    );
  }

  async function asignar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setAviso(null);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim())) {
      setError("Ingresa un correo válido.");
      return;
    }
    if (elegidos.length === 0) {
      setError("Elige al menos un recinto a su cargo.");
      return;
    }

    setGuardando(true);
    try {
      const r = await repositorio.asignarAdministrador(correo, elegidos);
      if (r.ok) {
        setAviso(r.mensaje);
        setCorreo("");
        setElegidos([]);
        await admins.recargar();
      } else {
        setError(r.mensaje);
      }
    } catch (e) {
      setError(aAppError(e, "asignar el administrador").message);
    } finally {
      setGuardando(false);
    }
  }

  async function retirar() {
    if (!aRetirar) return;
    setError(null);
    setAviso(null);
    setRetirando(true);
    try {
      const r = await repositorio.quitarAdministrador(aRetirar.correo);
      if (r.ok) {
        setAviso(r.mensaje);
        await admins.recargar();
      } else {
        setError(r.mensaje);
      }
      setARetirar(null);
    } catch (e) {
      setError(aAppError(e, "quitar el administrador").message);
    } finally {
      setRetirando(false);
    }
  }

  if (admins.cargando || recintos.cargando) {
    return <Cargando texto="Cargando los administradores…" />;
  }

  if (admins.error) {
    return (
      <ErrorConReintento
        error={admins.error}
        onReintentar={() => void admins.recargar()}
      />
    );
  }

  const lista = admins.datos ?? [];
  const asignables = recintos.datos ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Administradores de recintos</h2>
        <p className="mt-1 text-sm text-slate-600">
          Concede el rol de administrador a una cuenta existente y define los recintos
          a su cargo. La persona debe haberse registrado antes en ActivaUC.
        </p>
      </div>

      {aviso ? (
        <Alerta tono="exito" onCerrar={() => setAviso(null)}>
          {aviso}
        </Alerta>
      ) : null}

      {error ? (
        <Alerta tono="error" titulo="No pudimos completar la operación" onCerrar={() => setError(null)}>
          {error}
        </Alerta>
      ) : null}

      <form
        onSubmit={asignar}
        noValidate
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6"
      >
        <CampoTexto
          etiqueta="Correo de la cuenta"
          type="email"
          name="email"
          autoComplete="off"
          required
          value={correo}
          onChange={(e) => setCorreo(e.target.value)}
          placeholder="nombre@uc.cl"
          ayuda="Tiene que ser una cuenta ya registrada en la plataforma."
        />

        <fieldset>
          <legend className="text-sm font-medium text-slate-800">Recintos a su cargo</legend>
          {asignables.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">
              Todavía no hay recintos. Créalos en la sección «Recintos».
            </p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {asignables.map((recinto) => (
                <CampoCasilla
                  key={recinto.id}
                  etiqueta={recinto.activo ? recinto.nombre : `${recinto.nombre} (inactivo)`}
                  checked={elegidos.includes(recinto.id)}
                  onChange={() => alternarRecinto(recinto.id)}
                />
              ))}
            </div>
          )}
        </fieldset>

        <Boton type="submit" cargando={guardando} disabled={asignables.length === 0}>
          Conceder el rol
        </Boton>
      </form>

      <div>
        <h3 className="text-base font-semibold text-slate-900">Con rol de administración</h3>

        {lista.length === 0 ? (
          <SinDatos
            titulo="Todavía no hay administradores"
            descripcion="Concede el rol a una cuenta registrada con el formulario de arriba."
          />
        ) : (
          <ul className="mt-3 space-y-3">
            {lista.map((admin) => (
              <li
                key={admin.correo}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{admin.nombre}</p>
                  <p className="truncate text-sm text-slate-600">{admin.correo}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {admin.rol === "administrador_general"
                      ? "Todos los recintos de la organización"
                      : admin.recintos.length > 0
                        ? admin.recintos.join(" · ")
                        : "Sin recintos asignados"}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {admin.rol === "administrador_general" ? (
                    <Insignia tono="info">Administrador general</Insignia>
                  ) : (
                    <>
                      <Insignia tono="exito">Administrador</Insignia>
                      <Boton
                        variante="peligro"
                        tamano="pequeno"
                        onClick={() => setARetirar(admin)}
                      >
                        Quitar rol
                      </Boton>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        abierto={aRetirar !== null}
        titulo="Quitar el rol de administrador"
        onCerrar={() => setARetirar(null)}
        acciones={
          <>
            <Boton variante="secundario" onClick={() => setARetirar(null)}>
              Cancelar
            </Boton>
            <Boton variante="peligro" cargando={retirando} onClick={() => void retirar()}>
              Quitar el rol
            </Boton>
          </>
        }
      >
        {aRetirar ? (
          <p className="text-sm text-slate-700">
            <strong>{aRetirar.nombre}</strong> dejará de administrar sus recintos y
            volverá a ser un usuario común. Las reservas de los usuarios de esos
            recintos no se modifican.
          </p>
        ) : null}
      </Modal>
    </div>
  );
}

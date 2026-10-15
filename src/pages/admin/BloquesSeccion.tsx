import { useCallback, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { ActivaRepository } from "../../data";
import { useAsync } from "../../state/useAsync";
import { validarBloqueHorario } from "../../domain/reservationRules";
import type { Bloque, Recinto } from "../../domain/types";
import { formatearFechaMedia, formatearHora } from "../../lib/format";
import { aAppError } from "../../lib/errors";
import Alerta from "../../components/ui/Alerta";
import Boton from "../../components/ui/Boton";
import { CampoSelect, CampoTexto } from "../../components/ui/Campo";
import Insignia from "../../components/ui/Insignia";
import Modal from "../../components/ui/Modal";
import { Cargando, ErrorConReintento, SinDatos } from "../../components/ui/Estados";

interface Props {
  repositorio: ActivaRepository;
  recintos: Recinto[];
}

/** Convierte un valor de <input type="datetime-local"> a ISO. */
function aIso(valorLocal: string): string {
  return new Date(valorLocal).toISOString();
}

/** Convierte un instante ISO al formato de <input type="datetime-local">. */
function aLocal(iso: string): string {
  const fecha = new Date(iso);
  const desplazado = new Date(fecha.getTime() - fecha.getTimezoneOffset() * 60_000);
  return desplazado.toISOString().slice(0, 16);
}

/** REQ-30 · definir y modificar bloques horarios y su capacidad. */
export default function BloquesSeccion({ repositorio, recintos }: Props) {
  const [recintoId, setRecintoId] = useState(recintos[0]?.id ?? "");

  const cargar = useCallback(
    () => (recintoId ? repositorio.listarBloques(recintoId) : Promise.resolve([])),
    [repositorio, recintoId],
  );
  const bloques = useAsync<Bloque[]>(recintoId ? cargar : null);

  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [capacidad, setCapacidad] = useState("10");
  const [errorFormulario, setErrorFormulario] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editando, setEditando] = useState<Bloque | null>(null);
  const [edicionInicio, setEdicionInicio] = useState("");
  const [edicionFin, setEdicionFin] = useState("");
  const [edicionCapacidad, setEdicionCapacidad] = useState("10");
  const [guardando, setGuardando] = useState(false);

  // Los bloques se agrupan por día para que la lista sea manejable.
  const porDia = useMemo(() => {
    const grupos = new Map<string, Bloque[]>();
    for (const bloque of bloques.datos ?? []) {
      const clave = bloque.inicio.slice(0, 10);
      const lista = grupos.get(clave) ?? [];
      lista.push(bloque);
      grupos.set(clave, lista);
    }
    return [...grupos.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [bloques.datos]);

  async function crear(evento: FormEvent) {
    evento.preventDefault();
    setErrorFormulario(null);
    setError(null);
    setAviso(null);

    if (!recintoId) {
      setErrorFormulario("Selecciona primero un recinto.");
      return;
    }

    const capacidadNumero = Number(capacidad);
    const problema = validarBloqueHorario({
      inicio,
      fin,
      capacidadMaxima: capacidadNumero,
    });
    if (problema) {
      setErrorFormulario(problema);
      return;
    }

    setCreando(true);
    try {
      await repositorio.crearBloque({
        recintoId,
        inicio: aIso(inicio),
        fin: aIso(fin),
        capacidadMaxima: capacidadNumero,
        activo: true,
      });
      setAviso("Bloque horario creado y disponible en el catálogo.");
      setInicio("");
      setFin("");
      await bloques.recargar();
    } catch (e) {
      setErrorFormulario(aAppError(e, "crear el bloque").message);
    } finally {
      setCreando(false);
    }
  }

  async function guardarEdicion() {
    if (!editando) return;

    const capacidadNumero = Number(edicionCapacidad);
    const problema = validarBloqueHorario({
      inicio: edicionInicio,
      fin: edicionFin,
      capacidadMaxima: capacidadNumero,
    });
    if (problema) {
      setError(problema);
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      await repositorio.actualizarBloque(editando.id, {
        inicio: aIso(edicionInicio),
        fin: aIso(edicionFin),
        capacidadMaxima: capacidadNumero,
      });
      setAviso("Bloque actualizado. La disponibilidad se recalcula al instante.");
      setEditando(null);
      await bloques.recargar();
    } catch (e) {
      setError(aAppError(e, "actualizar el bloque").message);
    } finally {
      setGuardando(false);
    }
  }

  async function cambiarActivo(bloque: Bloque, activo: boolean) {
    setError(null);
    setGuardando(true);
    try {
      await repositorio.actualizarBloque(bloque.id, { activo });
      setAviso(
        activo
          ? "Bloque reactivado: vuelve a aparecer en el catálogo."
          : "Bloque desactivado: ya no admite nuevas reservas. Las existentes se conservan.",
      );
      await bloques.recargar();
    } catch (e) {
      setError(aAppError(e, "cambiar el estado del bloque").message);
    } finally {
      setGuardando(false);
    }
  }

  if (recintos.length === 0) {
    return (
      <SinDatos
        titulo="Primero necesitas un recinto"
        descripcion="Crea un recinto en la pestaña «Recintos» para poder publicar bloques horarios."
      />
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Bloques horarios y capacidad</h2>
        <p className="text-sm text-slate-600">
          Publica los bloques reservables de cada recinto y define cuántas personas admite
          cada uno.
        </p>
      </div>

      <CampoSelect
        etiqueta="Recinto"
        value={recintoId}
        onChange={(e) => setRecintoId(e.target.value)}
      >
        {recintos.map((recinto) => (
          <option key={recinto.id} value={recinto.id}>
            {recinto.nombre}
            {recinto.activo ? "" : " (desactivado)"}
          </option>
        ))}
      </CampoSelect>

      {aviso ? <Alerta tono="exito" onCerrar={() => setAviso(null)}>{aviso}</Alerta> : null}
      {error ? (
        <Alerta tono="error" onCerrar={() => setError(null)} titulo="No pudimos completar la operación">
          {error}
        </Alerta>
      ) : null}

      <form
        onSubmit={crear}
        noValidate
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-5"
      >
        <h3 className="text-sm font-semibold text-slate-900">Agregar disponibilidad</h3>

        <div className="grid gap-4 sm:grid-cols-3">
          <CampoTexto
            etiqueta="Inicio"
            type="datetime-local"
            required
            value={inicio}
            onChange={(e) => setInicio(e.target.value)}
          />
          <CampoTexto
            etiqueta="Término"
            type="datetime-local"
            required
            value={fin}
            onChange={(e) => setFin(e.target.value)}
          />
          <CampoTexto
            etiqueta="Capacidad máxima"
            type="number"
            min={1}
            max={1000}
            required
            value={capacidad}
            onChange={(e) => setCapacidad(e.target.value)}
            ayuda="Personas por bloque."
          />
        </div>

        {errorFormulario ? <Alerta tono="error">{errorFormulario}</Alerta> : null}

        <Boton type="submit" cargando={creando}>Crear bloque</Boton>
      </form>

      {bloques.error ? (
        <ErrorConReintento error={bloques.error} onReintentar={() => void bloques.recargar()} />
      ) : bloques.cargando ? (
        <Cargando texto="Cargando bloques horarios…" />
      ) : porDia.length === 0 ? (
        <SinDatos
          titulo="Este recinto no tiene bloques publicados"
          descripcion="Usa el formulario de arriba para agregar el primer bloque horario."
        />
      ) : (
        <div className="space-y-6">
          {porDia.map(([dia, lista]) => (
            <div key={dia}>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">
                {formatearFechaMedia(`${dia}T12:00:00`)}
              </h3>

              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">
                    Bloques horarios del {dia} con su capacidad y estado
                  </caption>
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 font-medium">Horario</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Capacidad</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Estado</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lista.map((bloque) => (
                      <tr key={bloque.id}>
                        <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                          {formatearHora(bloque.inicio)} a {formatearHora(bloque.fin)}
                        </td>
                        <td className="px-4 py-2.5 text-slate-700">
                          {bloque.capacidadMaxima}
                        </td>
                        <td className="px-4 py-2.5">
                          {bloque.activo ? (
                            <Insignia tono="exito">Activo</Insignia>
                          ) : (
                            <Insignia tono="neutro">Desactivado</Insignia>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex gap-2">
                            <Boton
                              variante="secundario"
                              tamano="pequeno"
                              onClick={() => {
                                setEditando(bloque);
                                setEdicionInicio(aLocal(bloque.inicio));
                                setEdicionFin(aLocal(bloque.fin));
                                setEdicionCapacidad(String(bloque.capacidadMaxima));
                                setError(null);
                              }}
                            >
                              Editar
                            </Boton>
                            <Boton
                              variante={bloque.activo ? "peligro" : "secundario"}
                              tamano="pequeno"
                              onClick={() => void cambiarActivo(bloque, !bloque.activo)}
                              disabled={guardando}
                            >
                              {bloque.activo ? "Desactivar" : "Reactivar"}
                            </Boton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        abierto={editando !== null}
        titulo="Editar bloque horario"
        descripcion="Los cambios de capacidad se reflejan de inmediato en el catálogo."
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
            etiqueta="Inicio"
            type="datetime-local"
            value={edicionInicio}
            onChange={(e) => setEdicionInicio(e.target.value)}
          />
          <CampoTexto
            etiqueta="Término"
            type="datetime-local"
            value={edicionFin}
            onChange={(e) => setEdicionFin(e.target.value)}
          />
          <CampoTexto
            etiqueta="Capacidad máxima"
            type="number"
            min={1}
            max={1000}
            value={edicionCapacidad}
            onChange={(e) => setEdicionCapacidad(e.target.value)}
          />

          <Alerta tono="aviso">
            Si reduces la capacidad por debajo de las reservas ya confirmadas, esas reservas
            se mantienen: el sistema simplemente no aceptará nuevas hasta que haya cupos.
          </Alerta>

          {error ? <Alerta tono="error">{error}</Alerta> : null}
        </div>
      </Modal>
    </div>
  );
}

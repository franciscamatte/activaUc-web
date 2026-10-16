import { useState } from "react";
import type { FormEvent } from "react";
import type { ActivaRepository } from "../../data";
import type { ResultadoSerie } from "../../data/repository";
import type { Recinto } from "../../domain/types";
import { formatearFechaMedia, formatearHora, hoyComoValorFecha } from "../../lib/format";
import { aAppError } from "../../lib/errors";
import Alerta from "../../components/ui/Alerta";
import Boton from "../../components/ui/Boton";
import { CampoSelect, CampoTexto } from "../../components/ui/Campo";

interface Props {
  repositorio: ActivaRepository;
  recinto: Recinto;
  onCreada: () => void | Promise<void>;
}

/** 0 = domingo, para coincidir con extract(dow) de PostgreSQL. */
const DIAS = [
  { valor: 1, etiqueta: "Lu", nombre: "lunes" },
  { valor: 2, etiqueta: "Ma", nombre: "martes" },
  { valor: 3, etiqueta: "Mi", nombre: "miércoles" },
  { valor: 4, etiqueta: "Ju", nombre: "jueves" },
  { valor: 5, etiqueta: "Vi", nombre: "viernes" },
  { valor: 6, etiqueta: "Sá", nombre: "sábado" },
  { valor: 0, etiqueta: "Do", nombre: "domingo" },
];

const ATAJOS = [
  { etiqueta: "Lunes a viernes", dias: [1, 2, 3, 4, 5] },
  { etiqueta: "Todos los días", dias: [0, 1, 2, 3, 4, 5, 6] },
  { etiqueta: "Fin de semana", dias: [6, 0] },
];

/** Suma días a una fecha en formato yyyy-mm-dd. */
function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00`);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * REQ-30 · publicación de bloques en serie.
 *
 * Crear los bloques uno a uno no escala: una temporada son cientos. Este
 * formulario genera una serie (diaria o por días de la semana) en una
 * sola operación, y obliga a pasar por una vista previa antes de
 * escribir, porque publicar 300 bloques equivocados es muy molesto de
 * deshacer.
 */
export default function SerieBloquesForm({ repositorio, recinto, onCreada }: Props) {
  const hoy = hoyComoValorFecha();

  const [fechaDesde, setFechaDesde] = useState(sumarDias(hoy, 1));
  const [fechaHasta, setFechaHasta] = useState(sumarDias(hoy, 28));
  const [dias, setDias] = useState<number[]>([1, 2, 3, 4, 5]);
  const [horas, setHoras] = useState<string[]>(["08:00"]);
  const [duracion, setDuracion] = useState("60");
  const [capacidad, setCapacidad] = useState("20");

  const [previa, setPrevia] = useState<ResultadoSerie | null>(null);
  const [procesando, setProcesando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // Cualquier cambio invalida la vista previa: así nunca se confirma una
  // serie distinta de la que se revisó.
  function alCambiar<T>(aplicar: (valor: T) => void) {
    return (valor: T) => {
      aplicar(valor);
      setPrevia(null);
      setError(null);
      setAviso(null);
    };
  }

  const datosSerie = (simular: boolean) => ({
    recintoId: recinto.id,
    fechaDesde,
    fechaHasta,
    horas: horas.filter((h) => h.trim() !== ""),
    duracionMinutos: Number(duracion),
    capacidadMaxima: Number(capacidad),
    diasSemana: dias,
    simular,
  });

  async function verPrevia(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setAviso(null);
    setProcesando(true);

    try {
      const resultado = await repositorio.crearSerieBloques(datosSerie(true));
      if (!resultado.ok) {
        setError(resultado.mensaje);
        setPrevia(null);
        return;
      }
      setPrevia(resultado);
    } catch (e) {
      setError(aAppError(e, "calcular la vista previa").message);
    } finally {
      setProcesando(false);
    }
  }

  async function confirmar() {
    setError(null);
    setProcesando(true);

    try {
      const resultado = await repositorio.crearSerieBloques(datosSerie(false));
      if (!resultado.ok) {
        setError(resultado.mensaje);
        return;
      }
      setAviso(resultado.mensaje);
      setPrevia(null);
      await onCreada();
    } catch (e) {
      setError(aAppError(e, "crear la serie").message);
    } finally {
      setProcesando(false);
    }
  }

  function alternarDia(valor: number) {
    setPrevia(null);
    setDias((actuales) =>
      actuales.includes(valor)
        ? actuales.filter((d) => d !== valor)
        : [...actuales, valor],
    );
  }

  return (
    <form
      onSubmit={verPrevia}
      noValidate
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-5"
    >
      <div>
        <h3 className="text-sm font-semibold text-slate-900">
          Publicar una serie de bloques
        </h3>
        <p className="mt-1 text-xs text-slate-600">
          Genera de una vez todos los bloques de un período. Puedes volver a
          aplicar la misma serie más adelante para extenderla: los bloques que ya
          existan no se duplican.
        </p>
      </div>

      {/* Rango de fechas */}
      <div className="grid gap-4 sm:grid-cols-2">
        <CampoTexto
          etiqueta="Desde el día"
          type="date"
          required
          min={hoy}
          value={fechaDesde}
          onChange={(e) => alCambiar(setFechaDesde)(e.target.value)}
        />
        <CampoTexto
          etiqueta="Hasta el día"
          type="date"
          required
          min={fechaDesde}
          value={fechaHasta}
          onChange={(e) => alCambiar(setFechaHasta)(e.target.value)}
          ayuda="Inclusive. Máximo un año."
        />
      </div>

      {/* Días de la semana */}
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">
          Días de la semana
        </legend>

        <div className="mt-2 flex flex-wrap gap-2">
          {DIAS.map((dia) => {
            const activo = dias.includes(dia.valor);
            return (
              <button
                key={dia.valor}
                type="button"
                onClick={() => alternarDia(dia.valor)}
                aria-pressed={activo}
                aria-label={dia.nombre}
                className={[
                  "size-10 rounded-lg border text-sm font-semibold transition",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700",
                  activo
                    ? "border-emerald-700 bg-emerald-700 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
                ].join(" ")}
              >
                {dia.etiqueta}
              </button>
            );
          })}
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {ATAJOS.map((atajo) => (
            <Boton
              key={atajo.etiqueta}
              variante="texto"
              tamano="pequeno"
              onClick={() => {
                setDias(atajo.dias);
                setPrevia(null);
              }}
            >
              {atajo.etiqueta}
            </Boton>
          ))}
        </div>
      </fieldset>

      {/* Horas de inicio */}
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">
          Horas de inicio
        </legend>
        <p className="mt-1 text-xs text-slate-500">
          Se creará un bloque por cada hora, en cada día seleccionado.
        </p>

        <div className="mt-2 space-y-2">
          {horas.map((hora, indice) => (
            <div key={indice} className="flex items-center gap-2">
              <input
                type="time"
                required
                value={hora}
                onChange={(e) => {
                  const copia = [...horas];
                  copia[indice] = e.target.value;
                  alCambiar(setHoras)(copia);
                }}
                aria-label={`Hora de inicio ${indice + 1}`}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline focus:outline-2 focus:outline-emerald-600/30"
              />
              {horas.length > 1 ? (
                <Boton
                  variante="texto"
                  tamano="pequeno"
                  onClick={() => alCambiar(setHoras)(horas.filter((_, i) => i !== indice))}
                  aria-label={`Quitar la hora ${hora}`}
                >
                  Quitar
                </Boton>
              ) : null}
            </div>
          ))}
        </div>

        {horas.length < 24 ? (
          <Boton
            variante="secundario"
            tamano="pequeno"
            className="mt-2"
            onClick={() => alCambiar(setHoras)([...horas, ""])}
          >
            Añadir otra hora
          </Boton>
        ) : null}
      </fieldset>

      {/* Duración y capacidad */}
      <div className="grid gap-4 sm:grid-cols-2">
        <CampoSelect
          etiqueta="Duración de cada bloque"
          value={duracion}
          onChange={(e) => alCambiar(setDuracion)(e.target.value)}
        >
          <option value="30">30 minutos</option>
          <option value="45">45 minutos</option>
          <option value="60">1 hora</option>
          <option value="90">1 hora y media</option>
          <option value="120">2 horas</option>
          <option value="180">3 horas</option>
        </CampoSelect>

        <CampoTexto
          etiqueta="Capacidad por bloque"
          type="number"
          min={1}
          max={1000}
          required
          value={capacidad}
          onChange={(e) => alCambiar(setCapacidad)(e.target.value)}
          ayuda="Personas que admite cada bloque."
        />
      </div>

      {error ? (
        <Alerta tono="error" titulo="Revisa la serie">
          {error}
        </Alerta>
      ) : null}

      {aviso ? (
        <Alerta tono="exito" onCerrar={() => setAviso(null)}>
          {aviso}
        </Alerta>
      ) : null}

      {/* Vista previa antes de escribir nada */}
      {previa ? (
        <Alerta tono="info" titulo="Vista previa">
          <p>
            Se crearían <strong>{previa.creados} bloques</strong>
            {previa.primerBloque && previa.ultimoBloque ? (
              <>
                , del {formatearFechaMedia(previa.primerBloque)} al{" "}
                {formatearFechaMedia(previa.ultimoBloque)}
              </>
            ) : null}
            .
          </p>

          {previa.omitidosExistentes > 0 ? (
            <p className="mt-1">
              Se omitirán {previa.omitidosExistentes} que ya están publicados.
            </p>
          ) : null}
          {previa.omitidosPasado > 0 ? (
            <p className="mt-1">
              Se omitirán {previa.omitidosPasado} que caen en el pasado.
            </p>
          ) : null}

          {previa.muestra.length > 0 ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
              {previa.muestra.map((bloque) => (
                <li key={bloque.inicio}>
                  {formatearFechaMedia(bloque.inicio)} ·{" "}
                  {formatearHora(bloque.inicio)} a {formatearHora(bloque.fin)}
                </li>
              ))}
              {previa.creados > previa.muestra.length ? (
                <li className="list-none text-slate-500">
                  … y {previa.creados - previa.muestra.length} más
                </li>
              ) : null}
            </ul>
          ) : null}
        </Alerta>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {previa && previa.creados > 0 ? (
          <>
            <Boton onClick={() => void confirmar()} cargando={procesando}>
              Crear {previa.creados} bloques
            </Boton>
            <Boton
              variante="secundario"
              onClick={() => setPrevia(null)}
              disabled={procesando}
            >
              Ajustar
            </Boton>
          </>
        ) : (
          <Boton type="submit" cargando={procesando}>
            Ver vista previa
          </Boton>
        )}
      </div>
    </form>
  );
}

import { useId } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const claseControl =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 " +
  "placeholder:text-slate-400 focus:border-emerald-600 focus:outline focus:outline-2 " +
  "focus:outline-offset-0 focus:outline-emerald-600/30 disabled:bg-slate-100 disabled:text-slate-500";

const claseError = "border-red-400 focus:border-red-500 focus:outline-red-500/30";

interface Base {
  etiqueta: string;
  ayuda?: string;
  error?: string | null;
  /** Oculta visualmente la etiqueta, manteniéndola para lectores de pantalla. */
  etiquetaOculta?: boolean;
}

/**
 * Campos de formulario accesibles.
 *
 * Cada control queda asociado a su etiqueta, su texto de ayuda y su
 * mensaje de error mediante aria-describedby y aria-invalid, de modo que
 * un lector de pantalla anuncie el problema junto al campo.
 */
export function CampoTexto({
  etiqueta,
  ayuda,
  error,
  etiquetaOculta,
  ...resto
}: Base & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  const descripciones = [ayuda ? idAyuda : null, error ? idError : null]
    .filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className={etiquetaOculta ? "sr-only" : "block text-sm font-medium text-slate-800"}
      >
        {etiqueta}
        {resto.required ? <span className="ml-0.5 text-red-600" aria-hidden="true">*</span> : null}
      </label>

      <input
        id={id}
        className={`${claseControl} ${error ? claseError : ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={descripciones}
        {...resto}
      />

      {ayuda ? <p id={idAyuda} className="text-xs text-slate-500">{ayuda}</p> : null}
      {error ? (
        <p id={idError} className="text-xs font-medium text-red-700">{error}</p>
      ) : null}
    </div>
  );
}

export function CampoSelect({
  etiqueta,
  ayuda,
  error,
  etiquetaOculta,
  children,
  ...resto
}: Base & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  const descripciones = [ayuda ? idAyuda : null, error ? idError : null]
    .filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className={etiquetaOculta ? "sr-only" : "block text-sm font-medium text-slate-800"}
      >
        {etiqueta}
        {resto.required ? <span className="ml-0.5 text-red-600" aria-hidden="true">*</span> : null}
      </label>

      <select
        id={id}
        className={`${claseControl} ${error ? claseError : ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={descripciones}
        {...resto}
      >
        {children}
      </select>

      {ayuda ? <p id={idAyuda} className="text-xs text-slate-500">{ayuda}</p> : null}
      {error ? (
        <p id={idError} className="text-xs font-medium text-red-700">{error}</p>
      ) : null}
    </div>
  );
}

export function CampoTextarea({
  etiqueta,
  ayuda,
  error,
  etiquetaOculta,
  ...resto
}: Base & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  const descripciones = [ayuda ? idAyuda : null, error ? idError : null]
    .filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className={etiquetaOculta ? "sr-only" : "block text-sm font-medium text-slate-800"}
      >
        {etiqueta}
        {resto.required ? <span className="ml-0.5 text-red-600" aria-hidden="true">*</span> : null}
      </label>

      <textarea
        id={id}
        rows={resto.rows ?? 3}
        className={`${claseControl} ${error ? claseError : ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={descripciones}
        {...resto}
      />

      {ayuda ? <p id={idAyuda} className="text-xs text-slate-500">{ayuda}</p> : null}
      {error ? (
        <p id={idError} className="text-xs font-medium text-red-700">{error}</p>
      ) : null}
    </div>
  );
}

export function CampoCasilla({
  etiqueta,
  ayuda,
  error,
  ...resto
}: Omit<Base, "etiquetaOculta"> & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  const descripciones = [ayuda ? idAyuda : null, error ? idError : null]
    .filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 rounded border-slate-400 text-emerald-700 focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-emerald-600"
          aria-invalid={error ? true : undefined}
          aria-describedby={descripciones}
          {...resto}
        />
        <label htmlFor={id} className="text-sm leading-snug text-slate-800">
          {etiqueta}
        </label>
      </div>

      {ayuda ? <p id={idAyuda} className="ml-6.5 text-xs text-slate-500">{ayuda}</p> : null}
      {error ? (
        <p id={idError} className="ml-6.5 text-xs font-medium text-red-700">{error}</p>
      ) : null}
    </div>
  );
}

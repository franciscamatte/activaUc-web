import type { ButtonHTMLAttributes, ReactNode } from "react";

export type VarianteBoton = "primario" | "secundario" | "peligro" | "texto";
export type TamanoBoton = "normal" | "pequeno";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const variantes: Record<VarianteBoton, string> = {
  primario:
    "bg-emerald-700 text-white hover:bg-emerald-800 active:bg-emerald-900 " +
    "focus-visible:outline-emerald-700 disabled:hover:bg-emerald-700",
  secundario:
    "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 " +
    "active:bg-slate-100 focus-visible:outline-slate-600",
  peligro:
    "border border-red-300 bg-white text-red-700 hover:bg-red-50 " +
    "active:bg-red-100 focus-visible:outline-red-600",
  texto:
    "text-emerald-800 underline-offset-2 hover:underline focus-visible:outline-emerald-700",
};

const tamanos: Record<TamanoBoton, string> = {
  normal: "px-4 py-2.5 text-sm",
  pequeno: "px-3 py-1.5 text-sm",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: VarianteBoton;
  tamano?: TamanoBoton;
  cargando?: boolean;
  anchoCompleto?: boolean;
  children: ReactNode;
}

export default function Boton({
  variante = "primario",
  tamano = "normal",
  cargando = false,
  anchoCompleto = false,
  disabled,
  children,
  className = "",
  type = "button",
  ...resto
}: Props) {
  const clases = [
    base,
    variantes[variante],
    tamanos[tamano],
    anchoCompleto ? "w-full" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <button
      type={type}
      className={clases}
      disabled={disabled || cargando}
      aria-busy={cargando || undefined}
      {...resto}
    >
      {cargando ? (
        <>
          <span
            className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
          <span>Procesando…</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

import type { ReactNode } from "react";
import Boton from "./Boton";

export type TonoAlerta = "info" | "exito" | "aviso" | "error";

const estilos: Record<TonoAlerta, { caja: string; icono: string; titulo: string }> = {
  info: {
    caja: "border-sky-200 bg-sky-50 text-sky-900",
    icono: "ℹ",
    titulo: "text-sky-900",
  },
  exito: {
    caja: "border-emerald-200 bg-emerald-50 text-emerald-900",
    icono: "✓",
    titulo: "text-emerald-900",
  },
  aviso: {
    caja: "border-amber-200 bg-amber-50 text-amber-900",
    icono: "!",
    titulo: "text-amber-900",
  },
  error: {
    caja: "border-red-200 bg-red-50 text-red-900",
    icono: "✕",
    titulo: "text-red-900",
  },
};

interface Props {
  tono?: TonoAlerta;
  titulo?: string;
  children: ReactNode;
  /** Muestra un botón de reintento (estado "reintento"). */
  onReintentar?: () => void;
  etiquetaReintento?: string;
  onCerrar?: () => void;
  className?: string;
}

/**
 * Mensaje de estado accesible.
 *
 * Los errores usan role="alert" para que los lectores de pantalla los
 * anuncien de inmediato; el resto usa una región educada.
 */
export default function Alerta({
  tono = "info",
  titulo,
  children,
  onReintentar,
  etiquetaReintento = "Reintentar",
  onCerrar,
  className = "",
}: Props) {
  const estilo = estilos[tono];

  return (
    <div
      role={tono === "error" ? "alert" : "status"}
      aria-live={tono === "error" ? "assertive" : "polite"}
      className={`flex gap-3 rounded-xl border p-4 text-sm ${estilo.caja} ${className}`}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-current text-xs font-bold"
      >
        {estilo.icono}
      </span>

      <div className="min-w-0 flex-1 space-y-2">
        {titulo ? <p className={`font-semibold ${estilo.titulo}`}>{titulo}</p> : null}
        <div className="leading-relaxed">{children}</div>

        {onReintentar ? (
          <Boton variante="secundario" tamano="pequeno" onClick={onReintentar}>
            {etiquetaReintento}
          </Boton>
        ) : null}
      </div>

      {onCerrar ? (
        <button
          type="button"
          onClick={onCerrar}
          className="-mr-1 -mt-1 size-7 shrink-0 rounded-md text-lg leading-none hover:bg-black/5 focus-visible:outline focus-visible:outline-2"
          aria-label="Cerrar aviso"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

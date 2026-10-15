import type { ReactNode } from "react";
import Alerta from "./Alerta";
import Boton from "./Boton";
import type { AppError } from "../../lib/errors";

/** Indicador de carga con texto, nunca sólo un spinner silencioso. */
export function Cargando({ texto = "Cargando…" }: { texto?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-10 text-sm text-slate-600"
    >
      <span
        className="size-5 animate-spin rounded-full border-2 border-emerald-700 border-t-transparent"
        aria-hidden="true"
      />
      <span>{texto}</span>
    </div>
  );
}

/** Esqueleto para listas, mientras llega la primera carga. */
export function EsqueletoTarjetas({ cantidad = 4 }: { cantidad?: number }) {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2"
      role="status"
      aria-live="polite"
      aria-label="Cargando disponibilidad"
    >
      {Array.from({ length: cantidad }, (_, i) => (
        <div
          key={i}
          className="animate-pulse space-y-3 rounded-xl border border-slate-200 bg-white p-5"
          aria-hidden="true"
        >
          <div className="h-3 w-20 rounded bg-slate-200" />
          <div className="h-5 w-3/4 rounded bg-slate-200" />
          <div className="h-4 w-1/2 rounded bg-slate-100" />
          <div className="h-9 w-28 rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

/** Estado "sin datos", con una acción sugerida cuando corresponde. */
export function SinDatos({
  titulo,
  descripcion,
  accion,
}: {
  titulo: string;
  descripcion: string;
  accion?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <p className="text-base font-semibold text-slate-800">{titulo}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">
        {descripcion}
      </p>
      {accion ? <div className="mt-5 flex justify-center">{accion}</div> : null}
    </div>
  );
}

/**
 * Estado de error con reintento. El mensaje llega ya traducido al
 * español por src/lib/errors.ts.
 */
export function ErrorConReintento({
  error,
  onReintentar,
  titulo,
}: {
  error: AppError;
  onReintentar?: () => void;
  titulo?: string;
}) {
  const titulos: Record<string, string> = {
    sin_conexion: "Sin conexión",
    sesion_expirada: "Sesión expirada",
    permisos: "Acceso restringido",
    limite_solicitudes: "Demasiadas solicitudes",
    integracion: "Integración no disponible",
    configuracion: "Configuración incompleta",
  };

  return (
    <Alerta
      tono="error"
      titulo={titulo ?? titulos[error.tipo] ?? "No pudimos cargar la información"}
      onReintentar={error.reintentable && onReintentar ? onReintentar : undefined}
    >
      {error.message}
    </Alerta>
  );
}

/** Aviso permanente de que la aplicación corre en modo demostración. */
export function AvisoModoDemo() {
  return (
    <div className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-center text-xs font-medium text-amber-900">
      Modo demostración local: los datos son de ejemplo y las integraciones con
      Google Calendar y WhatsApp están desactivadas.
    </div>
  );
}

/** Franja que informa la pérdida de conexión. */
export function AvisoSinConexion() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-slate-700 bg-slate-800 px-4 py-2 text-center text-xs font-medium text-white"
    >
      Sin conexión a internet. La disponibilidad mostrada puede estar desactualizada.
    </div>
  );
}

/** Pantalla completa de error de configuración (falta de variables). */
export function PantallaErrorConfiguracion({ detalle }: { detalle: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-4 py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-800">
          ActivaUC
        </p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          La aplicación no está configurada
        </h1>
      </div>

      <Alerta tono="error" titulo="Falta configuración del entorno">
        <p>{detalle}</p>
        <p className="mt-3">
          Copia <code className="rounded bg-red-100 px-1 py-0.5">.env.example</code> a{" "}
          <code className="rounded bg-red-100 px-1 py-0.5">.env</code> y completa las
          variables públicas. Las instrucciones completas están en{" "}
          <code className="rounded bg-red-100 px-1 py-0.5">docs/CONFIGURACION_SUPABASE.md</code>.
        </p>
      </Alerta>

      <Boton variante="secundario" onClick={() => window.location.reload()}>
        Recargar la página
      </Boton>
    </main>
  );
}

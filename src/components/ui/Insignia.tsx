import type { ReactNode } from "react";
import type {
  EstadoMensaje,
  EstadoReserva,
  EstadoSincronizacion,
} from "../../domain/types";
import {
  etiquetaEstadoReserva,
  etiquetaMensaje,
  etiquetaSincronizacionCorta,
} from "../../lib/format";

export type TonoInsignia = "neutro" | "exito" | "aviso" | "error" | "info";

const tonos: Record<TonoInsignia, string> = {
  neutro: "border-slate-300 bg-slate-100 text-slate-700",
  exito: "border-emerald-300 bg-emerald-50 text-emerald-800",
  aviso: "border-amber-300 bg-amber-50 text-amber-900",
  error: "border-red-300 bg-red-50 text-red-800",
  info: "border-sky-300 bg-sky-50 text-sky-800",
};

export default function Insignia({
  tono = "neutro",
  children,
}: {
  tono?: TonoInsignia;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tonos[tono]}`}
    >
      {children}
    </span>
  );
}

/** Insignia del estado de una reserva. */
export function InsigniaReserva({
  estado,
  esPasada,
}: {
  estado: EstadoReserva;
  esPasada: boolean;
}) {
  const tono: TonoInsignia =
    estado === "cancelada" ? "error" : esPasada ? "neutro" : "exito";
  return <Insignia tono={tono}>{etiquetaEstadoReserva(estado, esPasada)}</Insignia>;
}

/**
 * Insignia del estado de sincronización con Google Calendar (REQ-21).
 *
 * Nunca muestra "sincronizado" si el backend no lo confirmó: el valor
 * proviene de reservations.calendar_sync_status, que sólo pasa a
 * "sincronizado" cuando complete_calendar_job lo registra.
 */
export function InsigniaCalendario({ estado }: { estado: EstadoSincronizacion }) {
  const tonos: Record<EstadoSincronizacion, TonoInsignia> = {
    sincronizado: "exito",
    pendiente: "aviso",
    error: "error",
    no_aplica: "neutro",
  };
  return (
    <Insignia tono={tonos[estado]}>
      Calendar: {etiquetaSincronizacionCorta(estado)}
    </Insignia>
  );
}

/** Insignia del estado de un mensaje de WhatsApp (REQ-27). */
export function InsigniaWhatsapp({
  estado,
  prefijo = "WhatsApp",
}: {
  estado: EstadoMensaje;
  prefijo?: string;
}) {
  const tonos: Record<EstadoMensaje, TonoInsignia> = {
    entregado: "exito",
    enviado: "info",
    pendiente: "aviso",
    fallido: "error",
    omitido: "neutro",
  };
  return (
    <Insignia tono={tonos[estado]}>
      {prefijo}: {etiquetaMensaje(estado)}
    </Insignia>
  );
}

/** Indicador de cupos restantes de un bloque. */
export function InsigniaCupos({
  disponibles,
  capacidad,
}: {
  disponibles: number;
  capacidad: number;
}) {
  if (disponibles <= 0) {
    return <Insignia tono="error">Sin cupos</Insignia>;
  }
  const tono: TonoInsignia = disponibles <= Math.max(1, Math.floor(capacidad * 0.2))
    ? "aviso"
    : "exito";
  return (
    <Insignia tono={tono}>
      {disponibles} de {capacidad} {disponibles === 1 ? "cupo" : "cupos"}
    </Insignia>
  );
}

/**
 * Formato de fechas, horas y etiquetas, siempre en español de Chile.
 */

import { config } from "./env";
import type {
  EstadoMensaje,
  EstadoReserva,
  EstadoSincronizacion,
} from "../domain/types";

const zona = config.timeZone;

// Formato de 24 horas en toda la interfaz: "18:00" no admite confusión.
const fechaHoraLarga = new Intl.DateTimeFormat("es-CL", {
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: zona,
});

const fechaCorta = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: zona,
});

const fechaMedia = new Intl.DateTimeFormat("es-CL", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: zona,
});

const soloHora = new Intl.DateTimeFormat("es-CL", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: zona,
});

export function formatearFechaHora(iso: string): string {
  return fechaHoraLarga.format(new Date(iso));
}

export function formatearFecha(iso: string): string {
  return fechaCorta.format(new Date(iso));
}

export function formatearFechaMedia(iso: string): string {
  return fechaMedia.format(new Date(iso));
}

export function formatearHora(iso: string): string {
  return soloHora.format(new Date(iso));
}

/** "vie 17 oct · 18:00 a 19:00" */
export function formatearRango(inicio: string, fin: string): string {
  return `${fechaMedia.format(new Date(inicio))} · ${soloHora.format(new Date(inicio))} a ${
    soloHora.format(new Date(fin))
  }`;
}

/** Fecha en formato yyyy-mm-dd para los campos <input type="date">. */
export function aValorFecha(fecha: Date): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: zona,
  }).format(fecha);
  return partes;
}

export function hoyComoValorFecha(): string {
  return aValorFecha(new Date());
}

/** "en 3 horas", "mañana", "hace 2 días" */
export function tiempoRelativo(iso: string, ahora: Date = new Date()): string {
  const diffMs = new Date(iso).getTime() - ahora.getTime();
  const rtf = new Intl.RelativeTimeFormat("es-CL", { numeric: "auto" });
  const minutos = Math.round(diffMs / 60_000);

  if (Math.abs(minutos) < 60) return rtf.format(minutos, "minute");
  const horas = Math.round(diffMs / 3_600_000);
  if (Math.abs(horas) < 24) return rtf.format(horas, "hour");
  const dias = Math.round(diffMs / 86_400_000);
  if (Math.abs(dias) < 30) return rtf.format(dias, "day");
  return rtf.format(Math.round(dias / 30), "month");
}

// ---------------------------------------------------------------------
// Etiquetas de estado, todas en español
// ---------------------------------------------------------------------

export function etiquetaEstadoReserva(estado: EstadoReserva, esPasada: boolean): string {
  if (estado === "cancelada") return "Cancelada";
  return esPasada ? "Finalizada" : "Vigente";
}

export function etiquetaSincronizacion(estado: EstadoSincronizacion): string {
  switch (estado) {
    case "sincronizado": return "Sincronizada con Google Calendar";
    case "pendiente": return "Sincronización pendiente";
    case "error": return "Error de sincronización";
    case "no_aplica": return "Sin Google Calendar conectado";
  }
}

export function etiquetaSincronizacionCorta(estado: EstadoSincronizacion): string {
  switch (estado) {
    case "sincronizado": return "Sincronizada";
    case "pendiente": return "Pendiente";
    case "error": return "Con error";
    case "no_aplica": return "No aplica";
  }
}

export function etiquetaMensaje(estado: EstadoMensaje): string {
  switch (estado) {
    case "pendiente": return "En cola de envío";
    case "enviado": return "Enviado";
    case "entregado": return "Entregado";
    case "fallido": return "Falló el envío";
    case "omitido": return "Omitido";
  }
}

/** Texto de cupos, con singular y plural correctos. */
export function etiquetaCupos(disponibles: number, capacidad: number): string {
  if (disponibles <= 0) return "Sin cupos disponibles";
  if (disponibles === 1) return `1 cupo disponible de ${capacidad}`;
  return `${disponibles} cupos disponibles de ${capacidad}`;
}

export function pluralizar(cantidad: number, singular: string, plural: string): string {
  return cantidad === 1 ? `${cantidad} ${singular}` : `${cantidad} ${plural}`;
}

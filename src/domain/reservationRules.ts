import type { Bloque, Reserva } from "./types";
import { differenceInHours } from "../lib/date";

export function canReserveBlock(
  reservas: Reserva[],
  bloque: Bloque,
  recintoId: string,
  usuarioId: string,
): { ok: boolean; reason?: string } {
  const vigentesDelBloque = reservas.filter(
    (r) =>
      r.estado === "vigente" && r.bloqueId === bloque.id && r.recintoId === recintoId,
  );

  if (vigentesDelBloque.length >= bloque.capacidadMaxima) {
    return { ok: false, reason: "El bloque ya alcanzó su capacidad máxima." };
  }

  const duplicada = vigentesDelBloque.find((r) => r.usuarioId === usuarioId);
  if (duplicada) {
    return {
      ok: false,
      reason: "Ya tienes una reserva activa en este mismo bloque.",
    };
  }

  return { ok: true };
}

export function canUserCancelReservation(
  reservaInicio: string,
  nowIso: string,
): { ok: boolean; reason?: string } {
  const hours = differenceInHours(nowIso, reservaInicio);
  if (hours < 2) {
    return {
      ok: false,
      reason:
        "La cancelación por usuario requiere al menos 2 horas de anticipación.",
    };
  }
  return { ok: true };
}

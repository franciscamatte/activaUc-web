/**
 * Reglas de negocio replicadas en el cliente.
 *
 * IMPORTANTE: esto NO es la validación del sistema. Existe sólo para
 * deshabilitar botones y mostrar avisos antes de llamar al backend. La
 * decisión real la toman public.create_reservation_strict() y
 * public.cancel_reservation(), que son las únicas vías de escritura y
 * validan identidad, rol, capacidad y tiempos de forma transaccional.
 *
 * Cualquier cambio aquí debe reflejarse en
 * supabase/migrations/20261016000200_functions.sql y en sus pruebas.
 */

import type { Disponibilidad, Reserva, Rol } from "./types";

/** Horas mínimas de anticipación para que el usuario cancele (REQ-15). */
export const HORAS_MINIMAS_CANCELACION = 2;

/** Horas de anticipación del recordatorio por WhatsApp (REQ-25). */
export const HORAS_RECORDATORIO = 2;

export interface Veredicto {
  permitido: boolean;
  motivo?: string;
}

const PERMITIDO: Veredicto = { permitido: true };

function horasHasta(iso: string, ahora: Date): number {
  return (new Date(iso).getTime() - ahora.getTime()) / 3_600_000;
}

/**
 * ¿Puede este usuario seleccionar el bloque para reservar?
 * Replica las comprobaciones de create_reservation_strict.
 */
export function puedeReservarBloque(
  bloque: Disponibilidad,
  reservasDelUsuario: readonly Reserva[],
  ahora: Date = new Date(),
): Veredicto {
  if (bloque.iniciado || new Date(bloque.inicio).getTime() <= ahora.getTime()) {
    return { permitido: false, motivo: "Este bloque ya comenzó." };
  }
  if (bloque.agotado || bloque.disponibles <= 0) {
    return { permitido: false, motivo: "Sin cupos disponibles." };
  }
  const yaReservado = reservasDelUsuario.some(
    (r) => r.bloqueId === bloque.bloqueId && r.estado === "vigente",
  );
  if (yaReservado) {
    return { permitido: false, motivo: "Ya tienes una reserva en este bloque." };
  }
  return PERMITIDO;
}

/**
 * ¿Puede cancelarse la reserva, y por quién?
 *
 *   · El dueño necesita al menos 2 horas de anticipación.
 *   · El administrador del recinto no está sujeto a esa ventana.
 *   · Nadie puede cancelar una reserva ya finalizada o ya cancelada.
 */
export function puedeCancelar(
  reserva: Pick<Reserva, "estado" | "inicio" | "fin">,
  comoRol: Rol,
  ahora: Date = new Date(),
): Veredicto {
  if (reserva.estado === "cancelada") {
    return { permitido: false, motivo: "Esta reserva ya está cancelada." };
  }
  if (new Date(reserva.fin).getTime() <= ahora.getTime()) {
    return { permitido: false, motivo: "Esta reserva ya finalizó." };
  }

  if (comoRol === "administrador") {
    return PERMITIDO;
  }

  if (new Date(reserva.inicio).getTime() <= ahora.getTime()) {
    return { permitido: false, motivo: "La reserva ya comenzó." };
  }

  const horas = horasHasta(reserva.inicio, ahora);
  if (horas < HORAS_MINIMAS_CANCELACION) {
    return {
      permitido: false,
      motivo:
        `Las cancelaciones requieren al menos ${HORAS_MINIMAS_CANCELACION} horas de ` +
        `anticipación. Contacta al administrador del recinto.`,
    };
  }

  return PERMITIDO;
}

/**
 * ¿Se programará un recordatorio por WhatsApp? (REQ-25)
 *
 * Regla exacta: sólo si la reserva se crea con 2 horas o más de
 * anticipación. Con menos, el usuario recibe únicamente la confirmación.
 */
export function tendraRecordatorio(
  inicioBloque: string,
  ahora: Date = new Date(),
): boolean {
  return horasHasta(inicioBloque, ahora) >= HORAS_RECORDATORIO;
}

/** Separa las reservas en vigentes e historial (REQ-14). */
export function separarReservas(reservas: readonly Reserva[], ahora: Date = new Date()): {
  vigentes: Reserva[];
  pasadas: Reserva[];
} {
  const vigentes: Reserva[] = [];
  const pasadas: Reserva[] = [];

  for (const reserva of reservas) {
    const finalizada = new Date(reserva.fin).getTime() <= ahora.getTime();
    if (reserva.estado === "vigente" && !finalizada) {
      vigentes.push(reserva);
    } else {
      pasadas.push(reserva);
    }
  }

  vigentes.sort((a, b) => a.inicio.localeCompare(b.inicio));
  pasadas.sort((a, b) => b.inicio.localeCompare(a.inicio));

  return { vigentes, pasadas };
}

/** Filtra por rango horario del día (REQ-10). */
export function dentroDelRangoHorario(
  bloque: Pick<Disponibilidad, "inicio" | "fin">,
  horaDesde: string,
  horaHasta: string,
  zonaHoraria: string,
): boolean {
  if (!horaDesde && !horaHasta) return true;

  const minutos = (iso: string): number => {
    const partes = new Intl.DateTimeFormat("es-CL", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: zonaHoraria,
    }).formatToParts(new Date(iso));
    const hora = Number(partes.find((p) => p.type === "hour")?.value ?? "0");
    const minuto = Number(partes.find((p) => p.type === "minute")?.value ?? "0");
    return hora * 60 + minuto;
  };

  const aMinutos = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + (m || 0);
  };

  if (horaDesde && minutos(bloque.inicio) < aMinutos(horaDesde)) return false;
  if (horaHasta && minutos(bloque.fin) > aMinutos(horaHasta)) return false;
  return true;
}

/** Validación de un bloque antes de enviarlo al backend (REQ-30). */
export function validarBloqueHorario(datos: {
  inicio: string;
  fin: string;
  capacidadMaxima: number;
}): string | null {
  if (!datos.inicio || !datos.fin) {
    return "Indica la hora de inicio y de término del bloque.";
  }

  const inicio = new Date(datos.inicio).getTime();
  const fin = new Date(datos.fin).getTime();

  if (Number.isNaN(inicio) || Number.isNaN(fin)) {
    return "Las fechas indicadas no son válidas.";
  }
  if (fin <= inicio) {
    return "La hora de término debe ser posterior a la de inicio.";
  }
  if (fin - inicio > 12 * 3_600_000) {
    return "Un bloque no puede durar más de 12 horas.";
  }
  if (!Number.isInteger(datos.capacidadMaxima) || datos.capacidadMaxima < 1) {
    return "La capacidad debe ser un número entero mayor o igual a 1.";
  }
  if (datos.capacidadMaxima > 1000) {
    return "La capacidad máxima admitida por bloque es 1000.";
  }
  return null;
}

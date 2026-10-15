import { describe, expect, it } from "vitest";
import { canReserveBlock, canUserCancelReservation } from "./reservationRules";
import type { Bloque, Reserva } from "./types";

const bloque: Bloque = {
  id: "b1",
  recintoId: "r1",
  inicio: new Date(Date.now() + 5 * 3600000).toISOString(),
  fin: new Date(Date.now() + 6 * 3600000).toISOString(),
  capacidadMaxima: 2,
  activo: true,
};

describe("reglas de reserva", () => {
  it("bloquea por capacidad", () => {
    const reservas: Reserva[] = [
      { id: "1", usuarioId: "u1", recintoId: "r1", bloqueId: "b1", inicio: bloque.inicio, fin: bloque.fin, estado: "vigente", creadaEn: "", calendarSync: "sincronizado", whatsappConfirmacion: "entregado", whatsappRecordatorio: "pendiente" },
      { id: "2", usuarioId: "u2", recintoId: "r1", bloqueId: "b1", inicio: bloque.inicio, fin: bloque.fin, estado: "vigente", creadaEn: "", calendarSync: "sincronizado", whatsappConfirmacion: "entregado", whatsappRecordatorio: "pendiente" },
    ];

    const result = canReserveBlock(reservas, bloque, "r1", "u3");
    expect(result.ok).toBe(false);
  });

  it("bloquea duplicados del mismo usuario", () => {
    const reservas: Reserva[] = [
      { id: "1", usuarioId: "u1", recintoId: "r1", bloqueId: "b1", inicio: bloque.inicio, fin: bloque.fin, estado: "vigente", creadaEn: "", calendarSync: "sincronizado", whatsappConfirmacion: "entregado", whatsappRecordatorio: "pendiente" },
    ];

    const result = canReserveBlock(reservas, bloque, "r1", "u1");
    expect(result.ok).toBe(false);
  });

  it("permite cancelación solo con 2 horas o más", () => {
    const now = new Date().toISOString();
    const plus1h = new Date(Date.now() + 3600000).toISOString();
    const plus3h = new Date(Date.now() + 3 * 3600000).toISOString();

    expect(canUserCancelReservation(plus1h, now).ok).toBe(false);
    expect(canUserCancelReservation(plus3h, now).ok).toBe(true);
  });
});

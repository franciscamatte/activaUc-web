import { describe, expect, it } from "vitest";
import {
  HORAS_MINIMAS_CANCELACION,
  dentroDelRangoHorario,
  puedeCancelar,
  puedeReservarBloque,
  separarReservas,
  tendraRecordatorio,
  validarBloqueHorario,
} from "./reservationRules";
import type { Disponibilidad, Reserva } from "./types";

const AHORA = new Date("2026-10-15T12:00:00Z");

function enHoras(horas: number): string {
  return new Date(AHORA.getTime() + horas * 3_600_000).toISOString();
}

function bloque(parcial: Partial<Disponibilidad> = {}): Disponibilidad {
  return {
    bloqueId: "bloque-1",
    recintoId: "recinto-1",
    recintoNombre: "Cancha de prueba",
    recintoTipo: "Fútbol",
    recintoDescripcion: "",
    recintoHorario: "",
    inicio: enHoras(5),
    fin: enHoras(6),
    capacidadMaxima: 10,
    reservados: 2,
    disponibles: 8,
    agotado: false,
    iniciado: false,
    ...parcial,
  };
}

function reserva(parcial: Partial<Reserva> = {}): Reserva {
  return {
    id: "reserva-1",
    usuarioId: "usuario-1",
    recintoId: "recinto-1",
    recintoNombre: "Cancha de prueba",
    recintoTipo: "Fútbol",
    bloqueId: "bloque-1",
    inicio: enHoras(5),
    fin: enHoras(6),
    estado: "vigente",
    esPasada: false,
    calendarSync: "no_aplica",
    tieneEventoCalendario: false,
    whatsappConfirmacion: "omitido",
    whatsappRecordatorio: "omitido",
    canceladaEn: null,
    canceladaPorRol: null,
    motivoCancelacion: null,
    creadaEn: enHoras(-24),
    ...parcial,
  };
}

// =====================================================================
// REQ-11, REQ-12, REQ-13 · selección de un bloque
// =====================================================================
describe("puedeReservarBloque", () => {
  it("permite reservar un bloque futuro con cupos", () => {
    expect(puedeReservarBloque(bloque(), [], AHORA)).toEqual({ permitido: true });
  });

  it("impide seleccionar un bloque agotado (REQ-11)", () => {
    const veredicto = puedeReservarBloque(
      bloque({ agotado: true, disponibles: 0, reservados: 10 }),
      [],
      AHORA,
    );
    expect(veredicto.permitido).toBe(false);
    expect(veredicto.motivo).toContain("Sin cupos");
  });

  it("impide seleccionar un bloque sin cupos aunque la bandera no esté puesta", () => {
    expect(puedeReservarBloque(bloque({ disponibles: 0 }), [], AHORA).permitido).toBe(false);
  });

  it("impide seleccionar un bloque que ya comenzó", () => {
    const veredicto = puedeReservarBloque(bloque({ inicio: enHoras(-1) }), [], AHORA);
    expect(veredicto.permitido).toBe(false);
    expect(veredicto.motivo).toContain("ya comenzó");
  });

  it("impide una segunda reserva del mismo usuario en el mismo bloque (REQ-13)", () => {
    const veredicto = puedeReservarBloque(bloque(), [reserva()], AHORA);
    expect(veredicto.permitido).toBe(false);
    expect(veredicto.motivo).toContain("Ya tienes una reserva");
  });

  it("no cuenta una reserva cancelada como duplicado", () => {
    const cancelada = reserva({ estado: "cancelada", canceladaEn: enHoras(-2) });
    expect(puedeReservarBloque(bloque(), [cancelada], AHORA).permitido).toBe(true);
  });

  it("no confunde reservas de otros bloques", () => {
    const otra = reserva({ bloqueId: "bloque-2" });
    expect(puedeReservarBloque(bloque(), [otra], AHORA).permitido).toBe(true);
  });
});

// =====================================================================
// REQ-15 · ventana de cancelación de 2 horas
// =====================================================================
describe("puedeCancelar", () => {
  it("permite al usuario cancelar con más de 2 horas de anticipación", () => {
    expect(puedeCancelar(reserva({ inicio: enHoras(5) }), "usuario", AHORA)).toEqual({
      permitido: true,
    });
  });

  it("permite cancelar exactamente en el límite de 2 horas", () => {
    const limite = reserva({
      inicio: enHoras(HORAS_MINIMAS_CANCELACION),
      fin: enHoras(HORAS_MINIMAS_CANCELACION + 1),
    });
    expect(puedeCancelar(limite, "usuario", AHORA).permitido).toBe(true);
  });

  it("rechaza al usuario justo por debajo del límite", () => {
    const casi = reserva({ inicio: enHoras(1.99), fin: enHoras(3) });
    const veredicto = puedeCancelar(casi, "usuario", AHORA);
    expect(veredicto.permitido).toBe(false);
    expect(veredicto.motivo).toContain("2 horas de anticipación");
  });

  it("rechaza al usuario si la reserva ya comenzó", () => {
    const iniciada = reserva({ inicio: enHoras(-0.5), fin: enHoras(0.5) });
    const veredicto = puedeCancelar(iniciada, "usuario", AHORA);
    expect(veredicto.permitido).toBe(false);
    expect(veredicto.motivo).toContain("ya comenzó");
  });

  it("rechaza una reserva ya finalizada, para cualquier rol", () => {
    const vencida = reserva({ inicio: enHoras(-3), fin: enHoras(-2) });
    expect(puedeCancelar(vencida, "usuario", AHORA).permitido).toBe(false);
    expect(puedeCancelar(vencida, "administrador", AHORA).permitido).toBe(false);
  });

  it("rechaza una reserva ya cancelada", () => {
    const cancelada = reserva({ estado: "cancelada", canceladaEn: enHoras(-1) });
    const veredicto = puedeCancelar(cancelada, "usuario", AHORA);
    expect(veredicto.permitido).toBe(false);
    expect(veredicto.motivo).toContain("ya está cancelada");
  });

  it("exime al administrador de la ventana de 2 horas (REQ-32)", () => {
    const inmediata = reserva({ inicio: enHoras(0.25), fin: enHoras(1.25) });
    expect(puedeCancelar(inmediata, "usuario", AHORA).permitido).toBe(false);
    expect(puedeCancelar(inmediata, "administrador", AHORA).permitido).toBe(true);
  });

  it("permite al administrador cancelar una reserva ya iniciada pero no terminada", () => {
    const enCurso = reserva({ inicio: enHoras(-0.5), fin: enHoras(0.5) });
    expect(puedeCancelar(enCurso, "administrador", AHORA).permitido).toBe(true);
  });
});

// =====================================================================
// REQ-25 · regla exacta del recordatorio
// =====================================================================
describe("tendraRecordatorio", () => {
  it("programa recordatorio con 2 horas o más de anticipación", () => {
    expect(tendraRecordatorio(enHoras(2), AHORA)).toBe(true);
    expect(tendraRecordatorio(enHoras(8), AHORA)).toBe(true);
  });

  it("omite el recordatorio con menos de 2 horas de anticipación", () => {
    expect(tendraRecordatorio(enHoras(1.99), AHORA)).toBe(false);
    expect(tendraRecordatorio(enHoras(0.5), AHORA)).toBe(false);
  });

  it("omite el recordatorio de un bloque que ya pasó", () => {
    expect(tendraRecordatorio(enHoras(-1), AHORA)).toBe(false);
  });
});

// =====================================================================
// REQ-14 · dos secciones separadas
// =====================================================================
describe("separarReservas", () => {
  it("separa vigentes de pasadas y canceladas", () => {
    const vigente = reserva({ id: "a", inicio: enHoras(5), fin: enHoras(6) });
    const pasada = reserva({ id: "b", inicio: enHoras(-10), fin: enHoras(-9) });
    const cancelada = reserva({
      id: "c",
      inicio: enHoras(20),
      fin: enHoras(21),
      estado: "cancelada",
      canceladaEn: enHoras(-1),
    });

    const { vigentes, pasadas } = separarReservas([pasada, cancelada, vigente], AHORA);

    expect(vigentes.map((r) => r.id)).toEqual(["a"]);
    expect(pasadas.map((r) => r.id).sort()).toEqual(["b", "c"]);
  });

  it("ordena las vigentes de la más próxima a la más lejana", () => {
    const lejana = reserva({ id: "lejana", inicio: enHoras(50), fin: enHoras(51) });
    const proxima = reserva({ id: "proxima", inicio: enHoras(3), fin: enHoras(4) });

    const { vigentes } = separarReservas([lejana, proxima], AHORA);
    expect(vigentes.map((r) => r.id)).toEqual(["proxima", "lejana"]);
  });

  it("ordena el historial de la más reciente a la más antigua", () => {
    const vieja = reserva({ id: "vieja", inicio: enHoras(-100), fin: enHoras(-99) });
    const reciente = reserva({ id: "reciente", inicio: enHoras(-5), fin: enHoras(-4) });

    const { pasadas } = separarReservas([vieja, reciente], AHORA);
    expect(pasadas.map((r) => r.id)).toEqual(["reciente", "vieja"]);
  });

  it("trata una reserva en curso como vigente", () => {
    const enCurso = reserva({ id: "curso", inicio: enHoras(-0.5), fin: enHoras(0.5) });
    const { vigentes, pasadas } = separarReservas([enCurso], AHORA);
    expect(vigentes).toHaveLength(1);
    expect(pasadas).toHaveLength(0);
  });
});

// =====================================================================
// REQ-10 · filtro por rango horario
// =====================================================================
describe("dentroDelRangoHorario", () => {
  const zona = "UTC";
  const deDiez = { inicio: "2026-10-16T10:00:00Z", fin: "2026-10-16T11:00:00Z" };

  it("sin límites acepta cualquier bloque", () => {
    expect(dentroDelRangoHorario(deDiez, "", "", zona)).toBe(true);
  });

  it("acepta un bloque dentro del rango pedido", () => {
    expect(dentroDelRangoHorario(deDiez, "09:00", "12:00", zona)).toBe(true);
  });

  it("descarta un bloque que empieza antes del rango", () => {
    expect(dentroDelRangoHorario(deDiez, "11:00", "14:00", zona)).toBe(false);
  });

  it("descarta un bloque que termina después del rango", () => {
    expect(dentroDelRangoHorario(deDiez, "08:00", "10:30", zona)).toBe(false);
  });

  it("acepta un bloque que coincide exactamente con el rango", () => {
    expect(dentroDelRangoHorario(deDiez, "10:00", "11:00", zona)).toBe(true);
  });

  it("aplica la zona horaria de presentación", () => {
    // 10:00 UTC son 06:00 en Santiago (UTC-4 en octubre).
    expect(dentroDelRangoHorario(deDiez, "09:00", "12:00", "America/Santiago")).toBe(false);
    expect(dentroDelRangoHorario(deDiez, "05:00", "08:00", "America/Santiago")).toBe(true);
  });
});

// =====================================================================
// REQ-30 · validación de bloques antes de enviarlos al backend
// =====================================================================
describe("validarBloqueHorario", () => {
  it("acepta un bloque correcto", () => {
    expect(validarBloqueHorario({
      inicio: "2026-10-20T10:00",
      fin: "2026-10-20T11:00",
      capacidadMaxima: 10,
    })).toBeNull();
  });

  it("exige ambas fechas", () => {
    expect(validarBloqueHorario({ inicio: "", fin: "2026-10-20T11:00", capacidadMaxima: 5 }))
      .toContain("hora de inicio");
  });

  it("rechaza un término anterior o igual al inicio", () => {
    expect(validarBloqueHorario({
      inicio: "2026-10-20T11:00",
      fin: "2026-10-20T10:00",
      capacidadMaxima: 5,
    })).toContain("posterior");

    expect(validarBloqueHorario({
      inicio: "2026-10-20T10:00",
      fin: "2026-10-20T10:00",
      capacidadMaxima: 5,
    })).toContain("posterior");
  });

  it("rechaza un bloque de más de 12 horas (igual que la restricción SQL)", () => {
    expect(validarBloqueHorario({
      inicio: "2026-10-20T08:00",
      fin: "2026-10-20T21:00",
      capacidadMaxima: 5,
    })).toContain("12 horas");
  });

  it("rechaza capacidades inválidas", () => {
    expect(validarBloqueHorario({
      inicio: "2026-10-20T10:00",
      fin: "2026-10-20T11:00",
      capacidadMaxima: 0,
    })).toContain("mayor o igual a 1");

    expect(validarBloqueHorario({
      inicio: "2026-10-20T10:00",
      fin: "2026-10-20T11:00",
      capacidadMaxima: 2.5,
    })).toContain("entero");

    expect(validarBloqueHorario({
      inicio: "2026-10-20T10:00",
      fin: "2026-10-20T11:00",
      capacidadMaxima: 1001,
    })).toContain("1000");
  });

  it("rechaza fechas no interpretables", () => {
    expect(validarBloqueHorario({
      inicio: "no-es-fecha",
      fin: "2026-10-20T11:00",
      capacidadMaxima: 5,
    })).toContain("no son válidas");
  });
});

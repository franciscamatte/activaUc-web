/**
 * Pasos del flujo de reserva.
 *
 * Requisito no funcional de usabilidad: el flujo desde la consulta hasta
 * la confirmación no debe superar 4 pasos. Vive en su propio módulo para
 * que el componente PasosReserva exporte únicamente el componente.
 */

export interface PasoReserva {
  numero: 1 | 2 | 3 | 4;
  titulo: string;
  detalle: string;
}

export const PASOS: readonly PasoReserva[] = [
  { numero: 1, titulo: "Filtrar", detalle: "Elige fecha, recinto y horario" },
  { numero: 2, titulo: "Elegir bloque", detalle: "Selecciona un bloque con cupos" },
  { numero: 3, titulo: "Confirmar", detalle: "Revisa y confirma la reserva" },
  { numero: 4, titulo: "Listo", detalle: "Tu reserva queda registrada" },
];

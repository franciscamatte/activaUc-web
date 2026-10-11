export interface Recinto {
  id: number;
  nombre: string;
  tipo: string;
  descripcion: string;
  horario: string;
}

export interface Bloque {
  id: number;
  recintoId: number;
  fecha: string;
  inicio: string;
  fin: string;
  capacidad: number;
  ocupados: number;
}

export interface Reserva {
  id: number;
  recinto: string;
  fecha: string;
  bloque: string;
  estado: "vigente" | "pasada";
}

export const recintos: Recinto[] = [
  {
    id: 1,
    nombre: "Piscina Olímpica",
    tipo: "Piscina",
    descripcion: "Piscina temperada de 25 metros con carriles de nado libre.",
    horario: "Lunes a sábado, 07:00 - 21:00",
  },
  {
    id: 2,
    nombre: "Sala de pesas",
    tipo: "Sala de pesas",
    descripcion: "Máquinas, pesas libres y zona funcional.",
    horario: "Lunes a sábado, 08:00 - 22:00",
  },
  {
    id: 3,
    nombre: "Cancha de tenis",
    tipo: "Cancha",
    descripcion: "Cancha de arcilla con iluminación nocturna.",
    horario: "Todos los días, 09:00 - 19:00",
  },
];

export const bloques: Bloque[] = [
  // Piscina Olímpica
  { id: 1, recintoId: 1, fecha: "Lunes 12 de octubre", inicio: "07:00", fin: "08:00", capacidad: 10, ocupados: 3 },
  { id: 2, recintoId: 1, fecha: "Lunes 12 de octubre", inicio: "18:00", fin: "19:00", capacidad: 10, ocupados: 10 },
  { id: 3, recintoId: 1, fecha: "Martes 13 de octubre", inicio: "07:00", fin: "08:00", capacidad: 10, ocupados: 0 },
  { id: 4, recintoId: 1, fecha: "Martes 13 de octubre", inicio: "18:00", fin: "19:00", capacidad: 10, ocupados: 6 },
  // Sala de pesas
  { id: 5, recintoId: 2, fecha: "Lunes 12 de octubre", inicio: "16:00", fin: "18:00", capacidad: 12, ocupados: 8 },
  { id: 6, recintoId: 2, fecha: "Martes 13 de octubre", inicio: "10:00", fin: "12:00", capacidad: 12, ocupados: 12 },
  { id: 7, recintoId: 2, fecha: "Miércoles 14 de octubre", inicio: "16:00", fin: "18:00", capacidad: 12, ocupados: 5 },
  // Cancha de tenis
  { id: 8, recintoId: 3, fecha: "Lunes 12 de octubre", inicio: "17:00", fin: "18:00", capacidad: 4, ocupados: 1 },
  { id: 9, recintoId: 3, fecha: "Martes 13 de octubre", inicio: "17:00", fin: "18:00", capacidad: 4, ocupados: 4 },
  { id: 10, recintoId: 3, fecha: "Martes 13 de octubre", inicio: "18:00", fin: "19:00", capacidad: 4, ocupados: 2 },
];

export const reservas: Reserva[] = [
  {
    id: 1,
    recinto: "Piscina Olímpica",
    fecha: "Lunes 12 de octubre",
    bloque: "18:00 - 19:00",
    estado: "vigente",
  },
  {
    id: 2,
    recinto: "Sala de pesas",
    fecha: "Miércoles 14 de octubre",
    bloque: "16:00 - 18:00",
    estado: "vigente",
  },
  {
    id: 3,
    recinto: "Piscina Olímpica",
    fecha: "Viernes 9 de octubre",
    bloque: "07:00 - 08:00",
    estado: "pasada",
  },
];
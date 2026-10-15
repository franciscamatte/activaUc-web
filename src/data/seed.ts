import type { AsignacionAdministrador, Bloque, Recinto, Reserva, Usuario } from "../domain/types";

const now = Date.now();

function isoFromOffset(hours: number): string {
  return new Date(now + hours * 3600000).toISOString();
}

export const usuariosSeed: Usuario[] = [
  {
    id: "u-1",
    nombre: "Camila Rojas",
    email: "camila@uc.cl",
    password: "password123",
    telefono: "+56911112222",
    whatsappConsentido: true,
    googleCalendarConectado: true,
    rol: "usuario",
  },
  {
    id: "a-1",
    nombre: "Diego Admin",
    email: "admin@uc.cl",
    password: "admin12345",
    telefono: "+56933334444",
    whatsappConsentido: false,
    googleCalendarConectado: false,
    rol: "administrador",
  },
];

export const recintosSeed: Recinto[] = [
  {
    id: "r-1",
    nombre: "Piscina Olímpica",
    tipo: "Piscina",
    descripcion: "Piscina temperada de 25 metros con carriles para nado libre.",
    horarioFuncionamiento: "Lunes a sábado · 07:00 a 21:00",
    activo: true,
  },
  {
    id: "r-2",
    nombre: "Sala de pesas",
    tipo: "Gimnasio",
    descripcion: "Zona de máquinas, pesas libres y entrenamiento funcional.",
    horarioFuncionamiento: "Lunes a sábado · 08:00 a 22:00",
    activo: true,
  },
  {
    id: "r-3",
    nombre: "Cancha de tenis",
    tipo: "Cancha",
    descripcion: "Cancha de arcilla con iluminación para horario vespertino.",
    horarioFuncionamiento: "Todos los días · 09:00 a 20:00",
    activo: true,
  },
];

export const bloquesSeed: Bloque[] = [
  { id: "b-1", recintoId: "r-1", inicio: isoFromOffset(24), fin: isoFromOffset(25), capacidadMaxima: 8, activo: true },
  { id: "b-2", recintoId: "r-1", inicio: isoFromOffset(27), fin: isoFromOffset(28), capacidadMaxima: 8, activo: true },
  { id: "b-3", recintoId: "r-2", inicio: isoFromOffset(26), fin: isoFromOffset(28), capacidadMaxima: 10, activo: true },
  { id: "b-4", recintoId: "r-2", inicio: isoFromOffset(48), fin: isoFromOffset(50), capacidadMaxima: 10, activo: true },
  { id: "b-5", recintoId: "r-3", inicio: isoFromOffset(30), fin: isoFromOffset(31), capacidadMaxima: 4, activo: true },
  { id: "b-6", recintoId: "r-3", inicio: isoFromOffset(-28), fin: isoFromOffset(-27), capacidadMaxima: 4, activo: true },
];

export const reservasSeed: Reserva[] = [
  {
    id: "res-1",
    usuarioId: "u-1",
    recintoId: "r-1",
    bloqueId: "b-2",
    inicio: bloquesSeed[1].inicio,
    fin: bloquesSeed[1].fin,
    estado: "vigente",
    creadaEn: isoFromOffset(-5),
    calendarSync: "sincronizado",
    whatsappConfirmacion: "entregado",
    whatsappRecordatorio: "pendiente",
  },
  {
    id: "res-2",
    usuarioId: "u-1",
    recintoId: "r-3",
    bloqueId: "b-6",
    inicio: bloquesSeed[5].inicio,
    fin: bloquesSeed[5].fin,
    estado: "pasada",
    creadaEn: isoFromOffset(-60),
    calendarSync: "sincronizado",
    whatsappConfirmacion: "entregado",
    whatsappRecordatorio: "entregado",
  },
];

export const asignacionesSeed: AsignacionAdministrador[] = [
  { id: "asig-1", administradorId: "a-1", recintoId: "r-1" },
  { id: "asig-2", administradorId: "a-1", recintoId: "r-2" },
];

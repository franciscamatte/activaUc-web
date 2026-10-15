/**
 * Datos de ejemplo para el modo demostración local.
 *
 * NO son datos de producción. Las credenciales de aquí sólo existen en
 * memoria del navegador y no se envían a ningún servidor; equivalen a
 * los datos de supabase/seed.sql, que es el que se usa con el backend
 * real en desarrollo.
 */

import type {
  Bloque,
  ConexionCalendario,
  EntradaAuditoria,
  Recinto,
  Reserva,
  Rol,
} from "../domain/types";

export interface AsignacionDemo {
  id: string;
  administradorId: string;
  recintoId: string;
}

export interface EstadoDemo {
  cuentas: Array<{
    id: string;
    correo: string;
    contrasena: string;
    nombre: string;
    rol: Rol;
    confirmado: boolean;
    telefono: string | null;
    whatsappConsentido: boolean;
    whatsappConsentidoEn: string | null;
  }>;
  recintos: Recinto[];
  bloques: Bloque[];
  reservas: Reserva[];
  asignaciones: AsignacionDemo[];
  auditoria: EntradaAuditoria[];
  conexionCalendario: Record<string, ConexionCalendario>;
}

/** Credenciales visibles en la pantalla de ingreso en modo demostración. */
export const CUENTAS_DEMO = [
  { correo: "camila@uc.cl", contrasena: "activauc2026", rol: "usuario" as Rol },
  { correo: "admin@uc.cl", contrasena: "activauc2026", rol: "administrador" as Rol },
];

/** Devuelve una fecha a N días y a la hora indicada, en horario local. */
function enDias(dias: number, hora: number, minuto = 0): Date {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + dias);
  fecha.setHours(hora, minuto, 0, 0);
  return fecha;
}

export function crearDatosDemo(): EstadoDemo {
  const usuarioId = "11111111-1111-4111-8111-111111111111";
  const adminId = "22222222-2222-4222-8222-222222222222";

  const recintos: Recinto[] = [
    {
      id: "aaaaaaa1-0000-4000-8000-000000000001",
      nombre: "Cancha de fútbol San Joaquín",
      tipo: "Fútbol",
      descripcion:
        "Cancha de pasto sintético con iluminación nocturna, camarines y estacionamiento cercano.",
      horarioFuncionamiento: "08:00 a 22:00, lunes a sábado",
      activo: true,
    },
    {
      id: "aaaaaaa1-0000-4000-8000-000000000002",
      nombre: "Gimnasio multicancha Casa Central",
      tipo: "Básquetbol",
      descripcion:
        "Multicancha techada apta para básquetbol, vóleibol y balonmano, con graderías.",
      horarioFuncionamiento: "07:00 a 21:00, lunes a viernes",
      activo: true,
    },
    {
      id: "aaaaaaa1-0000-4000-8000-000000000003",
      nombre: "Canchas de tenis Lo Contador",
      tipo: "Tenis",
      descripcion: "Dos canchas de arcilla con arriendo de implementos en recepción.",
      horarioFuncionamiento: "09:00 a 20:00, todos los días",
      activo: true,
    },
    {
      id: "aaaaaaa1-0000-4000-8000-000000000004",
      nombre: "Piscina temperada Deportes UC",
      tipo: "Natación",
      descripcion: "Piscina semiolímpica de seis andariveles. Gorro de natación obligatorio.",
      horarioFuncionamiento: "07:00 a 21:00, lunes a sábado",
      activo: true,
    },
  ];

  const bloques: Bloque[] = [];
  const horarios = [9, 11, 15, 17, 19];

  for (let dia = 0; dia <= 6; dia += 1) {
    for (const recinto of recintos) {
      for (const hora of horarios) {
        const inicio = enDias(dia, hora);
        if (inicio.getTime() <= Date.now()) continue;

        bloques.push({
          id: `bbbb${recinto.id.slice(-2)}${dia}${hora}-0000-4000-8000-${String(
            bloques.length,
          ).padStart(12, "0")}`,
          recintoId: recinto.id,
          inicio: inicio.toISOString(),
          fin: enDias(dia, hora + 1).toISOString(),
          capacidadMaxima: recinto.tipo === "Tenis" ? 4 : recinto.tipo === "Natación" ? 12 : 20,
          activo: true,
        });
      }
    }
  }

  // Una reserva ya finalizada, para que la sección "Reservas pasadas"
  // tenga contenido desde el primer momento.
  const bloquePasadoId = "bbbbpasado-0000-4000-8000-000000000001";
  bloques.push({
    id: bloquePasadoId,
    recintoId: recintos[0].id,
    inicio: enDias(-3, 19).toISOString(),
    fin: enDias(-3, 20).toISOString(),
    capacidadMaxima: 20,
    activo: true,
  });

  const reservas: Reserva[] = [
    {
      id: "cccccccc-0000-4000-8000-000000000001",
      usuarioId,
      recintoId: recintos[0].id,
      recintoNombre: recintos[0].nombre,
      recintoTipo: recintos[0].tipo,
      bloqueId: bloquePasadoId,
      inicio: enDias(-3, 19).toISOString(),
      fin: enDias(-3, 20).toISOString(),
      estado: "vigente",
      esPasada: true,
      calendarSync: "no_aplica",
      tieneEventoCalendario: false,
      whatsappConfirmacion: "omitido",
      whatsappRecordatorio: "omitido",
      canceladaEn: null,
      canceladaPorRol: null,
      motivoCancelacion: null,
      creadaEn: enDias(-5, 10).toISOString(),
    },
  ];

  // Ocupación parcial de algunos bloques, para que el catálogo muestre
  // distintos estados de cupo, incluido uno agotado.
  const bloqueTenis = bloques.find((b) => b.recintoId === recintos[2].id);
  if (bloqueTenis) {
    for (let i = 0; i < bloqueTenis.capacidadMaxima; i += 1) {
      reservas.push({
        id: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`,
        usuarioId: `99999999-0000-4000-8000-${String(i).padStart(12, "0")}`,
        recintoId: bloqueTenis.recintoId,
        recintoNombre: recintos[2].nombre,
        recintoTipo: recintos[2].tipo,
        bloqueId: bloqueTenis.id,
        inicio: bloqueTenis.inicio,
        fin: bloqueTenis.fin,
        estado: "vigente",
        esPasada: false,
        calendarSync: "no_aplica",
        tieneEventoCalendario: false,
        whatsappConfirmacion: "omitido",
        whatsappRecordatorio: "omitido",
        canceladaEn: null,
        canceladaPorRol: null,
        motivoCancelacion: null,
        creadaEn: new Date().toISOString(),
      });
    }
  }

  return {
    cuentas: [
      {
        id: usuarioId,
        correo: "camila@uc.cl",
        contrasena: "activauc2026",
        nombre: "Camila Rojas",
        rol: "usuario",
        confirmado: true,
        telefono: null,
        whatsappConsentido: false,
        whatsappConsentidoEn: null,
      },
      {
        id: adminId,
        correo: "admin@uc.cl",
        contrasena: "activauc2026",
        nombre: "Javiera Donoso",
        rol: "administrador",
        confirmado: true,
        telefono: null,
        whatsappConsentido: false,
        whatsappConsentidoEn: null,
      },
    ],
    recintos,
    bloques,
    reservas,
    asignaciones: recintos.map((recinto, indice) => ({
      id: `eeeeeeee-0000-4000-8000-${String(indice).padStart(12, "0")}`,
      administradorId: adminId,
      recintoId: recinto.id,
    })),
    auditoria: [],
    conexionCalendario: {},
  };
}

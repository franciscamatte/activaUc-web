import { beforeEach, describe, expect, it } from "vitest";
import { MockRepository } from "./mockRepository";

/**
 * Pruebas de integración del repositorio en memoria.
 *
 * Verifican el recorrido completo que hace la interfaz —registrarse,
 * iniciar sesión, consultar disponibilidad, reservar, cancelar— y que el
 * modo demostración respeta las mismas reglas de negocio que el backend.
 *
 * Importante: el modo demostración NO sustituye a las pruebas contra
 * PostgreSQL (supabase/tests y scripts/concurrency-test.mjs). Aquí no
 * hay transacciones ni RLS; lo que se comprueba es que la capa de
 * aplicación llama a las reglas correctas y expone los estados correctos.
 */

const CORREO = "camila@uc.cl";
const CLAVE = "activauc2026";
const CORREO_ADMIN = "admin@uc.cl";

let repo: MockRepository;

beforeEach(() => {
  // Cada prueba parte de datos frescos: el constructor no encuentra
  // sessionStorage en el entorno de Node y genera la semilla.
  repo = new MockRepository();
});

describe("sesión", () => {
  it("rechaza credenciales incorrectas con un mensaje en español", async () => {
    await expect(repo.iniciarSesion(CORREO, "clave-incorrecta")).rejects.toThrow(
      /correo o la contraseña/,
    );
  });

  it("rechaza un correo que no existe", async () => {
    await expect(repo.iniciarSesion("nadie@uc.cl", CLAVE)).rejects.toThrow(
      /correo o la contraseña/,
    );
  });

  it("inicia y cierra sesión", async () => {
    expect(await repo.obtenerSesion()).toBeNull();

    await repo.iniciarSesion(CORREO, CLAVE);
    const sesion = await repo.obtenerSesion();
    expect(sesion?.correo).toBe(CORREO);

    await repo.cerrarSesion();
    expect(await repo.obtenerSesion()).toBeNull();
  });

  it("notifica a los oyentes los cambios de sesión", async () => {
    const eventos: string[] = [];
    const cancelar = repo.escucharSesion((evento) => eventos.push(evento));

    await repo.iniciarSesion(CORREO, CLAVE);
    await repo.cerrarSesion();
    cancelar();
    await repo.iniciarSesion(CORREO, CLAVE);

    expect(eventos).toEqual(["iniciada", "cerrada"]);
  });

  it("exige contraseña de al menos 8 caracteres al registrarse (REQ-1)", async () => {
    await expect(
      repo.registrarse({ nombre: "Nueva Persona", correo: "nueva@uc.cl", contrasena: "corta" }),
    ).rejects.toThrow(/8 caracteres/);
  });

  it("impide registrar un correo ya usado (REQ-1)", async () => {
    await expect(
      repo.registrarse({ nombre: "Otra Camila", correo: CORREO, contrasena: "clave-larga-1" }),
    ).rejects.toThrow(/Ya existe una cuenta/);
  });

  it("registra una cuenta nueva y permite iniciar sesión con ella", async () => {
    await repo.registrarse({
      nombre: "Persona Nueva",
      correo: "persona.nueva@uc.cl",
      contrasena: "clave-larga-1",
    });
    await repo.iniciarSesion("persona.nueva@uc.cl", "clave-larga-1");

    const perfil = await repo.obtenerPerfil();
    expect(perfil?.nombre).toBe("Persona Nueva");
    expect(perfil?.rol).toBe("usuario");
  });

  it("un código de 6 dígitos confirma la cuenta y abre sesión (REQ-5)", async () => {
    // Existe porque el enlace del correo no sirve con direcciones
    // institucionales: el escáner de Microsoft 365 lo consume antes.
    await repo.registrarse({
      nombre: "Código Válido",
      correo: "codigo@uc.cl",
      contrasena: "clave-larga-1",
    });

    await repo.verificarCodigo({
      correo: "codigo@uc.cl",
      codigo: "000000",
      tipo: "registro",
    });

    const sesion = await repo.obtenerSesion();
    expect(sesion?.correo).toBe("codigo@uc.cl");
  });

  it("rechaza un código mal formado o incorrecto sin abrir sesión", async () => {
    await repo.registrarse({
      nombre: "Código Malo",
      correo: "malo@uc.cl",
      contrasena: "clave-larga-1",
    });
    await repo.cerrarSesion();

    await expect(
      repo.verificarCodigo({ correo: "malo@uc.cl", codigo: "123", tipo: "registro" }),
    ).rejects.toThrow(/6 dígitos/);

    await expect(
      repo.verificarCodigo({ correo: "malo@uc.cl", codigo: "999999", tipo: "registro" }),
    ).rejects.toThrow(/no es válido o ya caducó/);

    expect(await repo.obtenerSesion()).toBeNull();
  });

  it("no revela si el correo existe al verificar un código", async () => {
    // El mismo mensaje para una cuenta inexistente que para un código
    // equivocado: de lo contrario se podría enumerar correos.
    await expect(
      repo.verificarCodigo({
        correo: "nadie@uc.cl",
        codigo: "000000",
        tipo: "recuperacion",
      }),
    ).rejects.toThrow(/no es válido o ya caducó/);
  });
});

describe("perfil y consentimiento de WhatsApp", () => {
  beforeEach(async () => {
    await repo.iniciarSesion(CORREO, CLAVE);
  });

  it("actualiza el nombre (REQ-7)", async () => {
    await repo.actualizarNombre("Camila Rojas Pérez");
    expect((await repo.obtenerPerfil())?.nombre).toBe("Camila Rojas Pérez");
  });

  it("rechaza un nombre demasiado corto", async () => {
    await expect(repo.actualizarNombre("A")).rejects.toThrow(/entre 2 y 120/);
  });

  it("rechaza un teléfono fuera del formato E.164 (REQ-22)", async () => {
    const resultado = await repo.definirConsentimientoWhatsapp("912345678", true);

    expect(resultado.ok).toBe(false);
    expect(resultado.mensaje).toContain("E.164");
    expect((await repo.obtenerPerfil())?.whatsappConsentido).toBe(false);
  });

  it("registra el número con consentimiento (REQ-22)", async () => {
    const resultado = await repo.definirConsentimientoWhatsapp("+56 9 1234 5678", true);

    expect(resultado.ok).toBe(true);
    const perfil = await repo.obtenerPerfil();
    expect(perfil?.telefono).toBe("+56912345678");
    expect(perfil?.whatsappConsentido).toBe(true);
    expect(perfil?.whatsappConsentidoEn).not.toBeNull();
  });

  it("revocar elimina el número y detiene los envíos pendientes (REQ-23)", async () => {
    await repo.definirConsentimientoWhatsapp("+56912345678", true);

    const bloques = await repo.consultarDisponibilidad({
      fechaDesde: "", fechaHasta: "", tipoRecinto: "", recintoId: "",
      horaDesde: "", horaHasta: "", soloConCupos: true,
    });
    const lejano = bloques.find(
      (b) => new Date(b.inicio).getTime() - Date.now() > 3 * 3_600_000,
    )!;
    const creada = await repo.crearReserva(lejano.bloqueId);
    expect(creada.ok).toBe(true);

    let misReservas = await repo.listarMisReservas();
    let reserva = misReservas.find((r) => r.id === creada.reservaId)!;
    expect(reserva.whatsappConfirmacion).toBe("pendiente");
    expect(reserva.whatsappRecordatorio).toBe("pendiente");

    const revocacion = await repo.definirConsentimientoWhatsapp(null, false);
    expect(revocacion.ok).toBe(true);

    const perfil = await repo.obtenerPerfil();
    expect(perfil?.telefono).toBeNull();
    expect(perfil?.whatsappConsentido).toBe(false);

    misReservas = await repo.listarMisReservas();
    reserva = misReservas.find((r) => r.id === creada.reservaId)!;
    expect(reserva.whatsappConfirmacion).toBe("omitido");
    expect(reserva.whatsappRecordatorio).toBe("omitido");
  });

  it("no simula una conexión con Google Calendar", async () => {
    // Fingir que Google está conectado sería engañoso: debe fallar con
    // un mensaje que explique qué falta.
    await expect(repo.iniciarConexionCalendario("/datos-personales")).rejects.toThrow(
      /backend real/,
    );
    expect((await repo.obtenerConexionCalendario()).estado).toBe("revocado");
  });
});

describe("disponibilidad y filtros", () => {
  const sinFiltros = {
    fechaDesde: "", fechaHasta: "", tipoRecinto: "", recintoId: "",
    horaDesde: "", horaHasta: "", soloConCupos: false,
  };

  it("lista recintos activos (REQ-8)", async () => {
    const recintos = await repo.listarRecintos();
    expect(recintos.length).toBeGreaterThan(0);
    expect(recintos.every((r) => r.activo)).toBe(true);
  });

  it("sólo muestra bloques futuros cuando no hay filtro de fecha", async () => {
    const bloques = await repo.consultarDisponibilidad(sinFiltros);
    expect(bloques.length).toBeGreaterThan(0);
    expect(bloques.every((b) => new Date(b.inicio).getTime() >= Date.now())).toBe(true);
  });

  it("calcula los cupos restantes y marca los agotados (REQ-9, REQ-11)", async () => {
    const bloques = await repo.consultarDisponibilidad(sinFiltros);

    for (const bloque of bloques) {
      expect(bloque.disponibles).toBe(
        Math.max(bloque.capacidadMaxima - bloque.reservados, 0),
      );
      expect(bloque.agotado).toBe(bloque.reservados >= bloque.capacidadMaxima);
    }

    // La semilla incluye un bloque de tenis completamente ocupado.
    expect(bloques.some((b) => b.agotado)).toBe(true);
  });

  it("filtra por tipo de recinto (REQ-10)", async () => {
    const bloques = await repo.consultarDisponibilidad({ ...sinFiltros, tipoRecinto: "Tenis" });
    expect(bloques.length).toBeGreaterThan(0);
    expect(bloques.every((b) => b.recintoTipo === "Tenis")).toBe(true);
  });

  it("filtra por recinto concreto (REQ-10)", async () => {
    const recintos = await repo.listarRecintos();
    const objetivo = recintos[1];

    const bloques = await repo.consultarDisponibilidad({
      ...sinFiltros,
      recintoId: objetivo.id,
    });
    expect(bloques.every((b) => b.recintoId === objetivo.id)).toBe(true);
  });

  it("filtra sólo bloques con cupos (REQ-11)", async () => {
    const bloques = await repo.consultarDisponibilidad({ ...sinFiltros, soloConCupos: true });
    expect(bloques.every((b) => !b.agotado && !b.iniciado)).toBe(true);
  });

  it("filtra por rango de fechas (REQ-10)", async () => {
    const todos = await repo.consultarDisponibilidad(sinFiltros);
    const dia = todos[0].inicio.slice(0, 10);

    const delDia = await repo.consultarDisponibilidad({ ...sinFiltros, fechaDesde: dia });
    expect(delDia.length).toBeGreaterThan(0);
    expect(delDia.every((b) => b.inicio.slice(0, 10) === dia)).toBe(true);
  });

  it("no expone identificadores de usuarios en la disponibilidad", async () => {
    const bloques = await repo.consultarDisponibilidad(sinFiltros);
    for (const bloque of bloques) {
      expect(Object.keys(bloque)).not.toContain("usuarioId");
      expect(Object.keys(bloque)).not.toContain("telefono");
    }
  });
});

describe("reservas", () => {
  const sinFiltros = {
    fechaDesde: "", fechaHasta: "", tipoRecinto: "", recintoId: "",
    horaDesde: "", horaHasta: "", soloConCupos: true,
  };

  async function bloqueLibre(horasMinimas = 3) {
    const bloques = await repo.consultarDisponibilidad(sinFiltros);
    const encontrado = bloques.find(
      (b) => new Date(b.inicio).getTime() - Date.now() > horasMinimas * 3_600_000,
    );
    if (!encontrado) throw new Error("La semilla no tiene bloques libres suficientes");
    return encontrado;
  }

  beforeEach(async () => {
    await repo.iniciarSesion(CORREO, CLAVE);
  });

  it("exige sesión para reservar", async () => {
    const bloque = await bloqueLibre();
    await repo.cerrarSesion();
    await expect(repo.crearReserva(bloque.bloqueId)).rejects.toThrow(/iniciar sesión/);
  });

  it("crea una reserva y descuenta el cupo (REQ-12)", async () => {
    const bloque = await bloqueLibre();
    const antes = bloque.disponibles;

    const resultado = await repo.crearReserva(bloque.bloqueId);
    expect(resultado.ok).toBe(true);
    expect(resultado.cuposDisponibles).toBe(antes - 1);

    const despues = (await repo.consultarDisponibilidad(sinFiltros))
      .find((b) => b.bloqueId === bloque.bloqueId)!;
    expect(despues.disponibles).toBe(antes - 1);
    expect(despues.reservados).toBe(bloque.reservados + 1);
  });

  it("no crea una segunda reserva del mismo bloque (REQ-13)", async () => {
    const bloque = await bloqueLibre();

    const primera = await repo.crearReserva(bloque.bloqueId);
    const segunda = await repo.crearReserva(bloque.bloqueId);

    expect(primera.duplicada).toBe(false);
    expect(segunda.ok).toBe(true);
    expect(segunda.duplicada).toBe(true);
    expect(segunda.reservaId).toBe(primera.reservaId);

    const propias = (await repo.listarMisReservas())
      .filter((r) => r.bloqueId === bloque.bloqueId && r.estado === "vigente");
    expect(propias).toHaveLength(1);
  });

  it("rechaza un bloque agotado con un mensaje claro (REQ-11)", async () => {
    const todos = await repo.consultarDisponibilidad({ ...sinFiltros, soloConCupos: false });
    const agotado = todos.find((b) => b.agotado)!;

    const resultado = await repo.crearReserva(agotado.bloqueId);
    expect(resultado.ok).toBe(false);
    expect(resultado.error).toBe("sin_cupos");
    expect(resultado.mensaje).toContain("cupos");
  });

  it("rechaza un bloque inexistente", async () => {
    const resultado = await repo.crearReserva("00000000-0000-0000-0000-000000000000");
    expect(resultado.error).toBe("bloque_inexistente");
  });

  it("marca el recordatorio según la regla de 2 horas (REQ-25)", async () => {
    await repo.definirConsentimientoWhatsapp("+56912345678", true);

    const lejano = await bloqueLibre(4);
    const resultado = await repo.crearReserva(lejano.bloqueId);

    expect(resultado.whatsappConfirmacion).toBe("pendiente");
    expect(resultado.whatsappRecordatorio).toBe("programado");
  });

  it("omite WhatsApp sin consentimiento (REQ-22)", async () => {
    const bloque = await bloqueLibre();
    const resultado = await repo.crearReserva(bloque.bloqueId);

    expect(resultado.whatsappConfirmacion).toBe("omitido");
    expect(resultado.whatsappRecordatorio).toBe("omitido");
  });

  it("no reporta sincronización con Calendar si no hay conexión (REQ-21)", async () => {
    const bloque = await bloqueLibre();
    const resultado = await repo.crearReserva(bloque.bloqueId);

    // Nunca debe decir "sincronizado" sin que haya ocurrido nada.
    expect(resultado.calendarSync).toBe("no_aplica");
  });

  it("separa las reservas propias en vigentes e historial (REQ-14)", async () => {
    const bloque = await bloqueLibre();
    await repo.crearReserva(bloque.bloqueId);

    const reservas = await repo.listarMisReservas();
    expect(reservas.some((r) => !r.esPasada && r.estado === "vigente")).toBe(true);
    // La semilla incluye una reserva ya finalizada.
    expect(reservas.some((r) => r.esPasada)).toBe(true);
  });

  it("sólo devuelve las reservas del usuario de la sesión", async () => {
    const bloque = await bloqueLibre();
    await repo.crearReserva(bloque.bloqueId);

    const sesion = await repo.obtenerSesion();
    const reservas = await repo.listarMisReservas();
    expect(reservas.every((r) => r.usuarioId === sesion?.usuarioId)).toBe(true);
  });
});

describe("cancelaciones", () => {
  const sinFiltros = {
    fechaDesde: "", fechaHasta: "", tipoRecinto: "", recintoId: "",
    horaDesde: "", horaHasta: "", soloConCupos: true,
  };

  it("el usuario cancela con más de 2 horas y libera el cupo (REQ-15)", async () => {
    await repo.iniciarSesion(CORREO, CLAVE);

    const bloques = await repo.consultarDisponibilidad(sinFiltros);
    const bloque = bloques.find(
      (b) => new Date(b.inicio).getTime() - Date.now() > 4 * 3_600_000,
    )!;
    const antes = bloque.disponibles;

    const creada = await repo.crearReserva(bloque.bloqueId);
    const cancelada = await repo.cancelarReserva(creada.reservaId!);

    expect(cancelada.ok).toBe(true);
    expect(cancelada.canceladoPor).toBe("usuario");

    const despues = (await repo.consultarDisponibilidad(sinFiltros))
      .find((b) => b.bloqueId === bloque.bloqueId)!;
    expect(despues.disponibles).toBe(antes);
  });

  it("cancelar dos veces es idempotente", async () => {
    await repo.iniciarSesion(CORREO, CLAVE);
    const bloques = await repo.consultarDisponibilidad(sinFiltros);
    const bloque = bloques.find(
      (b) => new Date(b.inicio).getTime() - Date.now() > 4 * 3_600_000,
    )!;

    const creada = await repo.crearReserva(bloque.bloqueId);
    await repo.cancelarReserva(creada.reservaId!);
    const segunda = await repo.cancelarReserva(creada.reservaId!);

    expect(segunda.ok).toBe(true);
    expect(segunda.yaCancelada).toBe(true);
  });

  it("rechaza cancelar una reserva de otra persona", async () => {
    await repo.iniciarSesion(CORREO, CLAVE);
    const bloques = await repo.consultarDisponibilidad(sinFiltros);
    const bloque = bloques.find(
      (b) => new Date(b.inicio).getTime() - Date.now() > 4 * 3_600_000,
    )!;
    const creada = await repo.crearReserva(bloque.bloqueId);

    await repo.registrarse({
      nombre: "Intruso Intruso",
      correo: "intruso@uc.cl",
      contrasena: "clave-larga-1",
    });
    await repo.iniciarSesion("intruso@uc.cl", "clave-larga-1");

    const resultado = await repo.cancelarReserva(creada.reservaId!);
    expect(resultado.ok).toBe(false);
    expect(resultado.error).toBe("no_autorizado");
  });

  it("rechaza cancelar una reserva inexistente", async () => {
    await repo.iniciarSesion(CORREO, CLAVE);
    const resultado = await repo.cancelarReserva("00000000-0000-0000-0000-000000000000");
    expect(resultado.error).toBe("reserva_inexistente");
  });

  it("el administrador cancela sin la ventana de 2 horas y notifica (REQ-26, REQ-32)", async () => {
    // La usuaria reserva un bloque cercano y tiene WhatsApp habilitado.
    await repo.iniciarSesion(CORREO, CLAVE);
    await repo.definirConsentimientoWhatsapp("+56912345678", true);

    const bloques = await repo.consultarDisponibilidad(sinFiltros);
    const cercano = bloques.find((b) => {
      const horas = (new Date(b.inicio).getTime() - Date.now()) / 3_600_000;
      return horas > 0 && horas < 2 && !b.agotado;
    });

    // La semilla puede no tener un bloque a menos de 2 horas; en ese
    // caso se usa uno lejano, que igualmente prueba el camino admin.
    const bloque = cercano ?? bloques.find(
      (b) => new Date(b.inicio).getTime() - Date.now() > 4 * 3_600_000,
    )!;
    const creada = await repo.crearReserva(bloque.bloqueId);

    if (cercano) {
      // Dentro de la ventana, la usuaria no puede cancelar.
      const intento = await repo.cancelarReserva(creada.reservaId!);
      expect(intento.ok).toBe(false);
      expect(intento.error).toBe("ventana_cerrada");
    }

    await repo.iniciarSesion(CORREO_ADMIN, CLAVE);
    const resultado = await repo.cancelarReserva(creada.reservaId!, "Mantención de la cancha");

    expect(resultado.ok).toBe(true);
    expect(resultado.canceladoPor).toBe("administrador");
    expect(resultado.notificacionWhatsapp).toBe(true);
  });
});

describe("administración", () => {
  beforeEach(async () => {
    await repo.iniciarSesion(CORREO_ADMIN, CLAVE);
  });

  it("lista sólo los recintos asignados (REQ-29)", async () => {
    const asignados = await repo.listarRecintosAsignados();
    expect(asignados.length).toBeGreaterThan(0);
  });

  it("un usuario común no puede crear recintos", async () => {
    await repo.iniciarSesion(CORREO, CLAVE);
    await expect(
      repo.crearRecinto({
        nombre: "Recinto Pirata",
        tipo: "Fútbol",
        descripcion: "",
        horarioFuncionamiento: "",
        activo: true,
      }),
    ).rejects.toThrow(/administrador/);
  });

  it("un usuario común no puede ver el listado administrativo", async () => {
    await repo.iniciarSesion(CORREO, CLAVE);
    await expect(repo.listarReservasAdmin(null, "vigentes")).rejects.toThrow(/administradores/);
  });

  it("crea un recinto y lo autoasigna (REQ-28, REQ-29)", async () => {
    const antes = (await repo.listarRecintosAsignados()).length;

    const resultado = await repo.crearRecinto({
      nombre: "Multicancha Oriente",
      tipo: "Básquetbol",
      descripcion: "Multicancha al aire libre",
      horarioFuncionamiento: "09:00 a 20:00",
      activo: true,
    });

    expect(resultado.ok).toBe(true);
    expect((await repo.listarRecintosAsignados()).length).toBe(antes + 1);
  });

  it("rechaza un nombre de recinto duplicado", async () => {
    const existente = (await repo.listarRecintosAsignados())[0];
    const resultado = await repo.crearRecinto({
      nombre: existente.nombre,
      tipo: "Fútbol",
      descripcion: "",
      horarioFuncionamiento: "",
      activo: true,
    });

    expect(resultado.ok).toBe(false);
    expect(resultado.mensaje).toContain("Ya existe");
  });

  it("crea y desactiva bloques horarios (REQ-30)", async () => {
    // Recinto recién creado y no uno del seed: el seed publica bloques a
    // las 9, 11, 15, 17 y 19, y «ahora + 72 h» con los minutos a cero
    // cae encima de uno según la hora a la que se corran las pruebas.
    const creado = await repo.crearRecinto({
      nombre: "Recinto Bloques Sueltos",
      tipo: "Fútbol",
      descripcion: "",
      horarioFuncionamiento: "",
      activo: true,
    });
    expect(creado.ok).toBe(true);
    const recinto = (await repo.listarRecintosAsignados())
      .find((r) => r.nombre === "Recinto Bloques Sueltos")!;
    const antes = (await repo.listarBloques(recinto.id)).length;

    const inicio = new Date(Date.now() + 72 * 3_600_000);
    inicio.setMinutes(0, 0, 0);

    await repo.crearBloque({
      recintoId: recinto.id,
      inicio: inicio.toISOString(),
      fin: new Date(inicio.getTime() + 3_600_000).toISOString(),
      capacidadMaxima: 8,
      activo: true,
    });

    const bloques = await repo.listarBloques(recinto.id);
    expect(bloques.length).toBe(antes + 1);

    const nuevo = bloques.find((b) => b.inicio === inicio.toISOString())!;
    await repo.actualizarBloque(nuevo.id, { activo: false });

    const actualizado = (await repo.listarBloques(recinto.id)).find((b) => b.id === nuevo.id)!;
    expect(actualizado.activo).toBe(false);

    // Un bloque desactivado desaparece del catálogo.
    const catalogo = await repo.consultarDisponibilidad({
      fechaDesde: "", fechaHasta: "", tipoRecinto: "", recintoId: "",
      horaDesde: "", horaHasta: "", soloConCupos: false,
    });
    expect(catalogo.some((b) => b.bloqueId === nuevo.id)).toBe(false);
  });

  it("impide dos bloques activos con el mismo inicio en un recinto", async () => {
    // Recinto propio por el mismo motivo que la prueba anterior: con uno
    // del seed, el choque lo provocaría el seed y no el segundo
    // crearBloque, y la prueba pasaría por la razón equivocada.
    const creado = await repo.crearRecinto({
      nombre: "Recinto Choque de Inicio",
      tipo: "Fútbol",
      descripcion: "",
      horarioFuncionamiento: "",
      activo: true,
    });
    expect(creado.ok).toBe(true);
    const recinto = (await repo.listarRecintosAsignados())
      .find((r) => r.nombre === "Recinto Choque de Inicio")!;

    const inicio = new Date(Date.now() + 96 * 3_600_000);
    inicio.setMinutes(0, 0, 0);

    const datos = {
      recintoId: recinto.id,
      inicio: inicio.toISOString(),
      fin: new Date(inicio.getTime() + 3_600_000).toISOString(),
      capacidadMaxima: 8,
      activo: true,
    };

    await repo.crearBloque(datos);
    await expect(repo.crearBloque(datos)).rejects.toThrow(/misma hora|esa hora/);
  });

  it("desactivar un recinto lo quita del catálogo pero conserva el historial", async () => {
    const recinto = (await repo.listarRecintosAsignados())[0];

    await repo.actualizarRecinto(recinto.id, { activo: false });

    const catalogo = await repo.consultarDisponibilidad({
      fechaDesde: "", fechaHasta: "", tipoRecinto: "", recintoId: "",
      horaDesde: "", horaHasta: "", soloConCupos: false,
    });
    expect(catalogo.some((b) => b.recintoId === recinto.id)).toBe(false);

    // Sigue existiendo para la administración, y se puede reactivar.
    expect((await repo.listarRecintosAsignados()).some((r) => r.id === recinto.id)).toBe(true);
    await repo.actualizarRecinto(recinto.id, { activo: true });
    expect((await repo.listarRecintos()).some((r) => r.id === recinto.id)).toBe(true);
  });

  it("el listado administrativo no expone correos ni teléfonos", async () => {
    await repo.iniciarSesion(CORREO, CLAVE);
    await repo.definirConsentimientoWhatsapp("+56912345678", true);

    const bloques = await repo.consultarDisponibilidad({
      fechaDesde: "", fechaHasta: "", tipoRecinto: "", recintoId: "",
      horaDesde: "", horaHasta: "", soloConCupos: true,
    });
    const bloque = bloques.find(
      (b) => new Date(b.inicio).getTime() - Date.now() > 4 * 3_600_000,
    )!;
    await repo.crearReserva(bloque.bloqueId);

    await repo.iniciarSesion(CORREO_ADMIN, CLAVE);
    const reservas = await repo.listarReservasAdmin(null, "vigentes");

    expect(reservas.length).toBeGreaterThan(0);
    for (const reserva of reservas) {
      const claves = Object.keys(reserva);
      expect(claves).not.toContain("usuarioCorreo");
      expect(claves).not.toContain("telefono");
      expect(claves).toContain("usuarioNombre");
      expect(JSON.stringify(reserva)).not.toContain("+569");
      expect(JSON.stringify(reserva)).not.toContain("@uc.cl");
    }
  });

  it("no inventa incidencias de integración en modo demostración", async () => {
    // Devolver datos falsos aquí haría creer que las colas funcionan.
    expect(await repo.listarIncidenciasIntegracion()).toEqual([]);
  });

  it("registra auditoría de las acciones", async () => {
    await repo.crearRecinto({
      nombre: "Recinto Auditado",
      tipo: "Tenis",
      descripcion: "",
      horarioFuncionamiento: "",
      activo: true,
    });

    const auditoria = await repo.listarAuditoria(null);
    expect(auditoria.some((e) => e.accion === "recinto_creado")).toBe(true);
  });
});

describe("series de bloques (REQ-30)", () => {
  /** Fecha en formato yyyy-mm-dd, desplazada N días desde hoy. */
  function enDias(dias: number): string {
    const d = new Date();
    d.setDate(d.getDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  const base = {
    fechaDesde: enDias(1),
    fechaHasta: enDias(7),
    horas: ["08:00", "10:00"],
    duracionMinutos: 60,
    capacidadMaxima: 20,
    diasSemana: [] as number[],
    simular: false,
  };

  /**
   * Crea un recinto nuevo para cada prueba.
   *
   * Los recintos de la semilla ya traen bloques publicados (y uno de
   * ellos en el pasado), así que usarlos haría que las series se
   * omitieran por duplicado y falsearía los recuentos. Partir de un
   * recinto vacío deja las aserciones libres de ese ruido.
   */
  let contador = 0;
  async function recintoPropio(): Promise<string> {
    await repo.iniciarSesion(CORREO_ADMIN, CLAVE);
    contador += 1;

    const creado = await repo.crearRecinto({
      nombre: `Recinto Serie ${contador}`,
      tipo: "Fútbol",
      descripcion: "",
      horarioFuncionamiento: "",
      activo: true,
    });
    expect(creado.ok).toBe(true);

    const recintos = await repo.listarRecintosAsignados();
    const recinto = recintos.find((r) => r.nombre === `Recinto Serie ${contador}`)!;
    expect(await repo.listarBloques(recinto.id)).toHaveLength(0);
    return recinto.id;
  }

  it("exige ser administrador del recinto", async () => {
    const recintoId = await recintoPropio();
    await repo.iniciarSesion(CORREO, CLAVE);

    await expect(
      repo.crearSerieBloques({ ...base, recintoId }),
    ).rejects.toThrow(/administras ese recinto/);
  });

  it("la simulación cuenta sin escribir nada", async () => {
    const recintoId = await recintoPropio();
    const antes = (await repo.listarBloques(recintoId)).length;

    const previa = await repo.crearSerieBloques({ ...base, recintoId, simular: true });

    expect(previa.ok).toBe(true);
    expect(previa.simulado).toBe(true);
    expect(previa.creados).toBe(14);
    expect(previa.muestra).toHaveLength(5);
    expect((await repo.listarBloques(recintoId)).length).toBe(antes);
  });

  it("crea la serie completa con su duración y capacidad", async () => {
    const recintoId = await recintoPropio();
    const antes = (await repo.listarBloques(recintoId)).length;

    const resultado = await repo.crearSerieBloques({ ...base, recintoId });

    expect(resultado.creados).toBe(14);
    const bloques = await repo.listarBloques(recintoId);
    expect(bloques.length).toBe(antes + 14);

    const nuevos = bloques.filter(
      (b) => b.capacidadMaxima === 20 && new Date(b.inicio).getTime() > Date.now(),
    );
    expect(nuevos.length).toBeGreaterThanOrEqual(14);
    for (const bloque of nuevos) {
      const minutos =
        (new Date(bloque.fin).getTime() - new Date(bloque.inicio).getTime()) / 60000;
      expect(minutos).toBe(60);
    }
  });

  it("repetir la misma serie no duplica bloques", async () => {
    const recintoId = await recintoPropio();
    await repo.crearSerieBloques({ ...base, recintoId });
    const despuesDeLaPrimera = (await repo.listarBloques(recintoId)).length;

    const segunda = await repo.crearSerieBloques({ ...base, recintoId });

    expect(segunda.creados).toBe(0);
    expect(segunda.omitidosExistentes).toBe(14);
    expect((await repo.listarBloques(recintoId)).length).toBe(despuesDeLaPrimera);
  });

  it("extender el rango sólo crea lo que falta", async () => {
    const recintoId = await recintoPropio();
    await repo.crearSerieBloques({ ...base, recintoId });

    const extendida = await repo.crearSerieBloques({
      ...base,
      recintoId,
      fechaHasta: enDias(14),
    });

    expect(extendida.omitidosExistentes).toBe(14);
    expect(extendida.creados).toBeGreaterThan(0);
  });

  it("filtra por días de la semana", async () => {
    const recintoId = await recintoPropio();

    const resultado = await repo.crearSerieBloques({
      ...base,
      recintoId,
      horas: ["09:00"],
      diasSemana: [1],
    });

    expect(resultado.creados).toBe(1);
    expect(new Date(resultado.primerBloque!).getDay()).toBe(1);
  });

  it("omite los bloques que caen en el pasado", async () => {
    const recintoId = await recintoPropio();

    const resultado = await repo.crearSerieBloques({
      ...base,
      recintoId,
      fechaDesde: enDias(-3),
      fechaHasta: enDias(1),
      horas: ["08:00"],
    });

    expect(resultado.omitidosPasado).toBeGreaterThan(0);
    const bloques = await repo.listarBloques(recintoId);
    for (const bloque of bloques) {
      expect(new Date(bloque.inicio).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("rechaza parámetros inválidos con el mismo código que el backend", async () => {
    const recintoId = await recintoPropio();

    const casos: Array<[Partial<typeof base>, string]> = [
      [{ fechaDesde: enDias(7), fechaHasta: enDias(1) }, "rango_invertido"],
      [{ fechaHasta: enDias(400) }, "rango_demasiado_largo"],
      [{ horas: [] }, "sin_horas"],
      [{ horas: ["25:00"] }, "hora_invalida"],
      [{ horas: ["8:00"] }, "hora_invalida"],
      [{ duracionMinutos: 5 }, "duracion_invalida"],
      [{ duracionMinutos: 900 }, "duracion_invalida"],
      [{ capacidadMaxima: 0 }, "capacidad_invalida"],
      [{ capacidadMaxima: 2000 }, "capacidad_invalida"],
      [{ diasSemana: [9] }, "dia_invalido"],
    ];

    for (const [parcial, esperado] of casos) {
      const resultado = await repo.crearSerieBloques({ ...base, recintoId, ...parcial });
      expect(resultado.ok, `con ${JSON.stringify(parcial)}`).toBe(false);
      expect(resultado.error, `con ${JSON.stringify(parcial)}`).toBe(esperado);
    }

    const bloques = await repo.listarBloques(recintoId);
    expect(bloques.every((b) => b.capacidadMaxima !== 2000)).toBe(true);
  });

  it("respeta el tope de bloques por operación", async () => {
    const recintoId = await recintoPropio();

    const resultado = await repo.crearSerieBloques({
      ...base,
      recintoId,
      fechaHasta: enDias(300),
      horas: ["06:00", "08:00", "10:00", "12:00", "14:00"],
    });

    expect(resultado.ok).toBe(false);
    expect(resultado.error).toBe("demasiados_bloques");
    expect(resultado.mensaje).toContain("1000");
  });

  it("avisa cuando ninguna fecha coincide con los días elegidos", async () => {
    const recintoId = await recintoPropio();

    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const diaOpuesto = (manana.getDay() + 3) % 7;

    const resultado = await repo.crearSerieBloques({
      ...base,
      recintoId,
      fechaDesde: enDias(1),
      fechaHasta: enDias(1),
      diasSemana: [diaOpuesto],
    });

    expect(resultado.ok).toBe(false);
    expect(resultado.error).toBe("serie_vacia");
  });

  it("desactiva en serie y avisa de las reservas vigentes", async () => {
    const recintoId = await recintoPropio();
    await repo.crearSerieBloques({ ...base, recintoId });

    const bloques = await repo.listarBloques(recintoId);
    const futuro = bloques.find(
      (b) => b.activo && new Date(b.inicio).getTime() - Date.now() > 3 * 3600000,
    )!;

    await repo.iniciarSesion(CORREO, CLAVE);
    const reserva = await repo.crearReserva(futuro.id);
    expect(reserva.ok).toBe(true);

    await repo.iniciarSesion(CORREO_ADMIN, CLAVE);

    const previa = await repo.desactivarSerieBloques(
      recintoId, base.fechaDesde, base.fechaHasta, true,
    );
    expect(previa.afectados).toBeGreaterThan(0);
    expect(previa.conReservasVigentes).toBe(1);
    expect((await repo.listarBloques(recintoId)).some((b) => b.activo)).toBe(true);

    const real = await repo.desactivarSerieBloques(
      recintoId, base.fechaDesde, base.fechaHasta, false,
    );
    expect(real.afectados).toBe(previa.afectados);

    const reservas = await repo.listarReservasAdmin(recintoId, "todas");
    expect(reservas.find((r) => r.id === reserva.reservaId)?.estado).toBe("vigente");
  });
});

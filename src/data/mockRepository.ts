/**
 * Implementación en memoria del repositorio.
 *
 * SÓLO PARA DESARROLLO LOCAL sin backend. Se activa con
 * VITE_DATA_MODE=mock y una compilación de producción la rechaza
 * (ver src/lib/env.ts).
 *
 * Replica las reglas de negocio del backend para que la interfaz se
 * comporte igual, pero NO ofrece ninguna garantía real: no hay
 * transacciones, ni RLS, ni integraciones. Lo que aquí aparece como
 * "enviado" o "sincronizado" es simulado, y la interfaz lo señala con
 * la etiqueta de modo demostración.
 */

import { AppError } from "../lib/errors";
import {
  HORAS_MINIMAS_CANCELACION,
  dentroDelRangoHorario,
  tendraRecordatorio,
} from "../domain/reservationRules";
import { esE164, normalizarTelefono } from "../domain/phone";
import {
  MENSAJE_CODIGO_INVALIDO,
  codigoTieneFormato,
  normalizarCodigo,
} from "../domain/codigoVerificacion";
import { config } from "../lib/env";
import type {
  Bloque,
  ConexionCalendario,
  Disponibilidad,
  EntradaAuditoria,
  EstadoMensaje,
  EstadoSincronizacion,
  FiltrosCatalogo,
  IncidenciaIntegracion,
  Perfil,
  Recinto,
  Reserva,
  ReservaAdmin,
  ResultadoCancelacion,
  ResultadoReserva,
  Rol,
} from "../domain/types";
import type {
  TipoVerificacion,
  ActivaRepository,
  DatosBloque,
  DatosRecinto,
  DatosSerieBloques,
  OyenteSesion,
  ResultadoDesactivacionSerie,
  ResultadoSerie,
  SesionActual,
} from "./repository";
import { crearDatosDemo, type EstadoDemo } from "./seed";

const CLAVE_ALMACEN = "activauc.demo";

interface CuentaDemo {
  id: string;
  correo: string;
  contrasena: string;
  nombre: string;
  rol: Rol;
  confirmado: boolean;
  telefono: string | null;
  whatsappConsentido: boolean;
  whatsappConsentidoEn: string | null;
  correoConsentido: boolean;
  correoConsentidoEn: string | null;
}

export class MockRepository implements ActivaRepository {
  private estado: EstadoDemo;
  private sesion: SesionActual | null = null;
  private oyentes = new Set<OyenteSesion>();
  private observadores = new Set<() => void>();

  constructor() {
    this.estado = this.cargar();
  }

  // =================================================================
  // Persistencia local (sessionStorage) para sobrevivir recargas
  // =================================================================

  private cargar(): EstadoDemo {
    try {
      const guardado = window.sessionStorage.getItem(CLAVE_ALMACEN);
      if (guardado) return JSON.parse(guardado) as EstadoDemo;
    } catch {
      // Sin almacenamiento disponible: se parte de datos frescos.
    }
    return crearDatosDemo();
  }

  private guardar(): void {
    try {
      window.sessionStorage.setItem(CLAVE_ALMACEN, JSON.stringify(this.estado));
    } catch {
      // Modo privado o almacenamiento bloqueado: se opera sólo en memoria.
    }
    for (const observador of this.observadores) observador();
  }

  private cuenta(correo: string): CuentaDemo | undefined {
    return this.estado.cuentas.find((c) => c.correo === correo.trim().toLowerCase());
  }

  private cuentaActual(): CuentaDemo {
    if (!this.sesion) {
      throw new AppError("sesion_expirada", "Necesitas iniciar sesión para continuar.");
    }
    const cuenta = this.estado.cuentas.find((c) => c.id === this.sesion?.usuarioId);
    if (!cuenta) {
      throw new AppError("sesion_expirada", "Tu sesión ya no es válida. Inicia sesión de nuevo.");
    }
    return cuenta;
  }

  private notificar(
    evento: "iniciada" | "cerrada" | "renovada" | "expirada",
    sesion: SesionActual | null,
  ): void {
    for (const oyente of this.oyentes) oyente(evento, sesion);
  }

  private auditar(entrada: {
    reservaId?: string | null;
    recintoId?: string | null;
    accion: string;
    actorRol?: Rol | null;
    detalles?: Record<string, unknown>;
  }): void {
    this.estado.auditoria.unshift({
      id: crypto.randomUUID(),
      reservaId: entrada.reservaId ?? null,
      recintoId: entrada.recintoId ?? null,
      accion: entrada.accion,
      actorRol: entrada.actorRol ?? null,
      detalles: entrada.detalles ?? {},
      fecha: new Date().toISOString(),
    });
    this.estado.auditoria = this.estado.auditoria.slice(0, 200);
  }

  // =================================================================
  // Sesión
  // =================================================================

  async obtenerSesion(): Promise<SesionActual | null> {
    return this.sesion;
  }

  escucharSesion(oyente: OyenteSesion): () => void {
    this.oyentes.add(oyente);
    return () => this.oyentes.delete(oyente);
  }

  async registrarse(datos: {
    nombre: string;
    correo: string;
    contrasena: string;
  }): Promise<{ requiereConfirmacion: boolean }> {
    const correo = datos.correo.trim().toLowerCase();

    if (datos.contrasena.length < 8) {
      throw new AppError("contrasena_debil", "La contraseña debe tener al menos 8 caracteres.");
    }
    if (datos.nombre.trim().length < 2) {
      throw new AppError("conflicto", "Ingresa tu nombre completo.");
    }
    if (this.cuenta(correo)) {
      throw new AppError(
        "correo_en_uso",
        "Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.",
      );
    }

    this.estado.cuentas.push({
      id: crypto.randomUUID(),
      correo,
      contrasena: datos.contrasena,
      nombre: datos.nombre.trim(),
      rol: "usuario",
      // En modo demostración la cuenta queda confirmada al instante,
      // porque no hay servicio de correo.
      confirmado: true,
      telefono: null,
      whatsappConsentido: false,
      whatsappConsentidoEn: null,
      correoConsentido: false,
      correoConsentidoEn: null,
    });
    this.guardar();

    return { requiereConfirmacion: false };
  }

  async iniciarSesion(correo: string, contrasena: string): Promise<void> {
    const cuenta = this.cuenta(correo);
    if (!cuenta || cuenta.contrasena !== contrasena) {
      throw new AppError(
        "credenciales",
        "El correo o la contraseña no son correctos. Revísalos e inténtalo otra vez.",
      );
    }
    if (!cuenta.confirmado) {
      throw new AppError(
        "correo_no_confirmado",
        "Todavía no has confirmado tu correo.",
      );
    }

    this.sesion = {
      usuarioId: cuenta.id,
      correo: cuenta.correo,
      expiraEn: Math.floor(Date.now() / 1000) + 3600,
    };
    this.notificar("iniciada", this.sesion);
  }

  async cerrarSesion(): Promise<void> {
    this.sesion = null;
    this.notificar("cerrada", null);
  }

  async solicitarRecuperacion(correo: string): Promise<void> {
    // No se revela si el correo existe, igual que en producción.
    void correo;
  }

  async definirNuevaContrasena(contrasena: string): Promise<void> {
    if (contrasena.length < 8) {
      throw new AppError("contrasena_debil", "La contraseña debe tener al menos 8 caracteres.");
    }
    const cuenta = this.cuentaActual();
    cuenta.contrasena = contrasena;
    this.guardar();
  }

  async reenviarConfirmacion(correo: string): Promise<void> {
    void correo;
  }

  async definirConsentimientoCorreo(
    consentido: boolean,
  ): Promise<{ ok: boolean; mensaje: string }> {
    const cuenta = this.cuentaActual();
    cuenta.correoConsentido = consentido;
    cuenta.correoConsentidoEn = consentido ? new Date().toISOString() : null;
    this.guardar();
    return {
      ok: true,
      mensaje: consentido
        ? "Listo: te avisaremos por correo."
        : "Dejamos de enviarte correos de tus reservas.",
    };
  }

  /**
   * En modo simulado el código es siempre 000000: no hay correo que
   * leer, y pedir uno real impediría probar el flujo sin backend.
   */
  async verificarCodigo(datos: {
    correo: string;
    codigo: string;
    tipo: TipoVerificacion;
  }): Promise<void> {
    const codigo = normalizarCodigo(datos.codigo);
    if (!codigoTieneFormato(codigo)) {
      throw new AppError("conflicto", MENSAJE_CODIGO_INVALIDO);
    }
    if (codigo !== "000000") {
      throw new AppError("conflicto", "El código no es válido o ya caducó.");
    }

    const cuenta = this.cuenta(datos.correo);
    if (!cuenta) {
      throw new AppError("conflicto", "El código no es válido o ya caducó.");
    }

    if (datos.tipo === "registro") cuenta.confirmado = true;
    this.sesion = {
      usuarioId: cuenta.id,
      correo: cuenta.correo,
      expiraEn: Math.floor(Date.now() / 1000) + 3600,
    };
    this.guardar();
    this.notificar("iniciada", this.sesion);
  }

  // =================================================================
  // Perfil
  // =================================================================

  async obtenerPerfil(): Promise<Perfil | null> {
    if (!this.sesion) return null;
    const cuenta = this.cuentaActual();
    return {
      id: cuenta.id,
      nombre: cuenta.nombre,
      correo: cuenta.correo,
      telefono: cuenta.telefono,
      whatsappConsentido: cuenta.whatsappConsentido,
      whatsappConsentidoEn: cuenta.whatsappConsentidoEn,
      correoConsentido: cuenta.correoConsentido,
      correoConsentidoEn: cuenta.correoConsentidoEn,
      rol: cuenta.rol,
    };
  }

  async actualizarNombre(nombre: string): Promise<void> {
    const limpio = nombre.trim();
    if (limpio.length < 2 || limpio.length > 120) {
      throw new AppError("conflicto", "El nombre debe tener entre 2 y 120 caracteres.");
    }
    this.cuentaActual().nombre = limpio;
    this.guardar();
  }

  async definirConsentimientoWhatsapp(
    telefono: string | null,
    consentido: boolean,
  ): Promise<{ ok: boolean; mensaje: string }> {
    const cuenta = this.cuentaActual();

    if (consentido) {
      const limpio = normalizarTelefono(telefono ?? "");
      if (!esE164(limpio)) {
        return {
          ok: false,
          mensaje: "Ingresa el número en formato internacional E.164, por ejemplo +56912345678.",
        };
      }
      cuenta.telefono = limpio;
      cuenta.whatsappConsentido = true;
      cuenta.whatsappConsentidoEn = cuenta.whatsappConsentidoEn ?? new Date().toISOString();
      this.auditar({ accion: "consentimiento_otorgado", actorRol: cuenta.rol });
      this.guardar();
      return {
        ok: true,
        mensaje: "Registramos tu número (simulado en modo demostración).",
      };
    }

    cuenta.telefono = null;
    cuenta.whatsappConsentido = false;
    cuenta.whatsappConsentidoEn = null;

    // Igual que en el backend: revocar cancela los envíos pendientes.
    for (const reserva of this.estado.reservas) {
      if (reserva.usuarioId !== cuenta.id) continue;
      if (reserva.whatsappConfirmacion === "pendiente") reserva.whatsappConfirmacion = "omitido";
      if (reserva.whatsappRecordatorio === "pendiente") reserva.whatsappRecordatorio = "omitido";
    }

    this.auditar({ accion: "consentimiento_revocado", actorRol: cuenta.rol });
    this.guardar();
    return {
      ok: true,
      mensaje: "Eliminamos tu número y revocamos el consentimiento.",
    };
  }

  // =================================================================
  // Catálogo y disponibilidad
  // =================================================================

  async listarRecintos(): Promise<Recinto[]> {
    return this.estado.recintos
      .filter((r) => r.activo)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }

  async consultarDisponibilidad(filtros: FiltrosCatalogo): Promise<Disponibilidad[]> {
    const ahora = Date.now();
    const recintos = new Map(this.estado.recintos.map((r) => [r.id, r]));

    const ocupacion = new Map<string, number>();
    for (const reserva of this.estado.reservas) {
      if (reserva.estado !== "vigente") continue;
      ocupacion.set(reserva.bloqueId, (ocupacion.get(reserva.bloqueId) ?? 0) + 1);
    }

    let filas: Disponibilidad[] = this.estado.bloques
      .filter((bloque) => {
        const recinto = recintos.get(bloque.recintoId);
        return bloque.activo && recinto?.activo === true;
      })
      .map((bloque) => {
        const recinto = recintos.get(bloque.recintoId)!;
        const reservados = ocupacion.get(bloque.id) ?? 0;
        return {
          bloqueId: bloque.id,
          recintoId: recinto.id,
          recintoNombre: recinto.nombre,
          recintoTipo: recinto.tipo,
          recintoDescripcion: recinto.descripcion,
          recintoHorario: recinto.horarioFuncionamiento,
          inicio: bloque.inicio,
          fin: bloque.fin,
          capacidadMaxima: bloque.capacidadMaxima,
          reservados,
          disponibles: Math.max(bloque.capacidadMaxima - reservados, 0),
          agotado: reservados >= bloque.capacidadMaxima,
          iniciado: new Date(bloque.inicio).getTime() <= ahora,
        };
      });

    if (filtros.tipoRecinto) {
      filas = filas.filter((f) => f.recintoTipo === filtros.tipoRecinto);
    }
    if (filtros.recintoId) {
      filas = filas.filter((f) => f.recintoId === filtros.recintoId);
    }
    if (filtros.fechaDesde) {
      const desde = new Date(`${filtros.fechaDesde}T00:00:00`).getTime();
      const hasta = new Date(
        `${filtros.fechaHasta || filtros.fechaDesde}T23:59:59.999`,
      ).getTime();
      filas = filas.filter((f) => {
        const t = new Date(f.inicio).getTime();
        return t >= desde && t <= hasta;
      });
    } else {
      filas = filas.filter((f) => new Date(f.inicio).getTime() >= ahora);
    }
    if (filtros.horaDesde || filtros.horaHasta) {
      filas = filas.filter((f) =>
        dentroDelRangoHorario(f, filtros.horaDesde, filtros.horaHasta, config.timeZone),
      );
    }
    if (filtros.soloConCupos) {
      filas = filas.filter((f) => !f.agotado && !f.iniciado);
    }

    return filas.sort((a, b) => a.inicio.localeCompare(b.inicio));
  }

  /**
   * En modo demostración no hay WebSockets: se avisa a los observadores
   * cada vez que cambia el estado local.
   */
  observarDisponibilidad(alCambiar: () => void): () => void {
    this.observadores.add(alCambiar);
    return () => this.observadores.delete(alCambiar);
  }

  // =================================================================
  // Reservas
  // =================================================================

  async listarMisReservas(): Promise<Reserva[]> {
    if (!this.sesion) return [];
    const ahora = Date.now();
    const recintos = new Map(this.estado.recintos.map((r) => [r.id, r]));

    return this.estado.reservas
      .filter((r) => r.usuarioId === this.sesion?.usuarioId)
      .map((r) => ({
        ...r,
        recintoNombre: recintos.get(r.recintoId)?.nombre ?? "Recinto",
        recintoTipo: recintos.get(r.recintoId)?.tipo ?? "",
        esPasada: new Date(r.fin).getTime() <= ahora,
      }))
      .sort((a, b) => b.inicio.localeCompare(a.inicio));
  }

  async crearReserva(bloqueId: string): Promise<ResultadoReserva> {
    const cuenta = this.cuentaActual();
    const bloque = this.estado.bloques.find((b) => b.id === bloqueId);

    if (!bloque) {
      return { ok: false, error: "bloque_inexistente", mensaje: "El bloque horario ya no existe." };
    }
    if (!bloque.activo) {
      return {
        ok: false,
        error: "bloque_inactivo",
        mensaje: "Este bloque horario fue desactivado por el administrador.",
      };
    }

    const recinto = this.estado.recintos.find((r) => r.id === bloque.recintoId);
    if (!recinto?.activo) {
      return {
        ok: false,
        error: "recinto_inactivo",
        mensaje: "El recinto de este bloque está fuera de servicio.",
      };
    }
    if (new Date(bloque.inicio).getTime() <= Date.now()) {
      return {
        ok: false,
        error: "bloque_iniciado",
        mensaje: "Este bloque ya comenzó y no admite nuevas reservas.",
      };
    }

    const existente = this.estado.reservas.find(
      (r) => r.usuarioId === cuenta.id && r.bloqueId === bloqueId && r.estado === "vigente",
    );
    if (existente) {
      return {
        ok: true,
        duplicada: true,
        reservaId: existente.id,
        mensaje: "Ya tenías una reserva vigente en este bloque.",
        calendarSync: existente.calendarSync,
      };
    }

    const vigentes = this.estado.reservas.filter(
      (r) => r.bloqueId === bloqueId && r.estado === "vigente",
    ).length;

    if (vigentes >= bloque.capacidadMaxima) {
      return {
        ok: false,
        error: "sin_cupos",
        mensaje: "Este bloque acaba de quedar sin cupos disponibles.",
        cuposDisponibles: 0,
      };
    }

    const conCalendario = this.estado.conexionCalendario[cuenta.id]?.estado === "conectado";
    const conWhatsapp = cuenta.whatsappConsentido && cuenta.telefono !== null;
    const habraRecordatorio = conWhatsapp && tendraRecordatorio(bloque.inicio);

    const calendarSync: EstadoSincronizacion = conCalendario ? "pendiente" : "no_aplica";
    const confirmacion: EstadoMensaje = conWhatsapp ? "pendiente" : "omitido";
    const recordatorio: EstadoMensaje = habraRecordatorio ? "pendiente" : "omitido";

    const reserva: Reserva = {
      id: crypto.randomUUID(),
      usuarioId: cuenta.id,
      recintoId: bloque.recintoId,
      recintoNombre: recinto.nombre,
      recintoTipo: recinto.tipo,
      bloqueId: bloque.id,
      inicio: bloque.inicio,
      fin: bloque.fin,
      estado: "vigente",
      esPasada: false,
      calendarSync,
      tieneEventoCalendario: false,
      whatsappConfirmacion: confirmacion,
      whatsappRecordatorio: recordatorio,
      canceladaEn: null,
      canceladaPorRol: null,
      motivoCancelacion: null,
      creadaEn: new Date().toISOString(),
    };

    this.estado.reservas.push(reserva);
    this.auditar({
      reservaId: reserva.id,
      recintoId: reserva.recintoId,
      accion: "reserva_creada",
      actorRol: cuenta.rol,
      detalles: { modo: "demostracion" },
    });
    this.guardar();

    return {
      ok: true,
      duplicada: false,
      reservaId: reserva.id,
      mensaje: "Reserva confirmada.",
      calendarSync,
      whatsappConfirmacion: confirmacion,
      whatsappRecordatorio: habraRecordatorio ? "programado" : "omitido",
      cuposDisponibles: bloque.capacidadMaxima - vigentes - 1,
    };
  }

  async cancelarReserva(reservaId: string, motivo?: string): Promise<ResultadoCancelacion> {
    const cuenta = this.cuentaActual();
    const reserva = this.estado.reservas.find((r) => r.id === reservaId);

    if (!reserva) {
      return { ok: false, error: "reserva_inexistente", mensaje: "No encontramos esa reserva." };
    }

    const esDueno = reserva.usuarioId === cuenta.id;
    const esAdminAsignado = this.estado.asignaciones.some(
      (a) => a.administradorId === cuenta.id && a.recintoId === reserva.recintoId,
    );

    if (!esDueno && !esAdminAsignado) {
      return {
        ok: false,
        error: "no_autorizado",
        mensaje: "No tienes permiso para cancelar esta reserva.",
      };
    }
    if (reserva.estado === "cancelada") {
      return { ok: true, yaCancelada: true, mensaje: "Esta reserva ya estaba cancelada." };
    }
    if (new Date(reserva.fin).getTime() <= Date.now()) {
      return {
        ok: false,
        error: "reserva_vencida",
        mensaje: "Esta reserva ya finalizó y no puede cancelarse.",
      };
    }

    const comoAdmin = esAdminAsignado && !esDueno;

    if (!comoAdmin) {
      if (new Date(reserva.inicio).getTime() <= Date.now()) {
        return {
          ok: false,
          error: "reserva_iniciada",
          mensaje: "La reserva ya comenzó y no puede cancelarse.",
        };
      }
      const horas = (new Date(reserva.inicio).getTime() - Date.now()) / 3_600_000;
      if (horas < HORAS_MINIMAS_CANCELACION) {
        return {
          ok: false,
          error: "ventana_cerrada",
          mensaje:
            `Las cancelaciones requieren al menos ${HORAS_MINIMAS_CANCELACION} horas de ` +
            `anticipación. Contacta al administrador del recinto.`,
        };
      }
    }

    reserva.estado = "cancelada";
    reserva.canceladaEn = new Date().toISOString();
    reserva.canceladaPorRol = comoAdmin ? "administrador" : "usuario";
    reserva.motivoCancelacion = motivo?.trim() || null;
    reserva.calendarSync = reserva.tieneEventoCalendario ? "pendiente" : "no_aplica";
    reserva.whatsappRecordatorio = "omitido";

    const dueno = this.estado.cuentas.find((c) => c.id === reserva.usuarioId);
    const notificar = comoAdmin && dueno?.whatsappConsentido === true && dueno.telefono !== null;

    this.auditar({
      reservaId: reserva.id,
      recintoId: reserva.recintoId,
      accion: comoAdmin ? "reserva_cancelada_admin" : "reserva_cancelada_usuario",
      actorRol: comoAdmin ? "administrador" : "usuario",
      detalles: { motivo: reserva.motivoCancelacion, modo: "demostracion" },
    });
    this.guardar();

    return {
      ok: true,
      mensaje: "Reserva cancelada. El cupo quedó disponible para otras personas.",
      canceladoPor: comoAdmin ? "administrador" : "usuario",
      notificacionWhatsapp: notificar,
    };
  }

  // =================================================================
  // Google Calendar (simulado, nunca real)
  // =================================================================

  async obtenerConexionCalendario(): Promise<ConexionCalendario> {
    if (!this.sesion) {
      return { estado: "revocado", cuentaGoogle: null, conectadaEn: null, revocadaEn: null, ultimoError: null };
    }
    return (
      this.estado.conexionCalendario[this.sesion.usuarioId] ?? {
        estado: "revocado",
        cuentaGoogle: null,
        conectadaEn: null,
        revocadaEn: null,
        ultimoError: null,
      }
    );
  }

  async iniciarConexionCalendario(_rutaRetorno: string): Promise<string> {
    // Se rechaza en lugar de simular una conexión: fingir que Google
    // está conectado sería engañoso, que es justo lo que hay que evitar.
    throw new AppError(
      "integracion",
      "La conexión con Google Calendar requiere el backend real. Configura " +
      "VITE_DATA_MODE=supabase y despliega las Edge Functions para usarla.",
    );
  }

  async desconectarCalendario(): Promise<{ mensaje: string }> {
    throw new AppError(
      "integracion",
      "La desconexión de Google Calendar requiere el backend real.",
    );
  }

  // =================================================================
  // Administración
  // =================================================================

  async listarRecintosAsignados(): Promise<Recinto[]> {
    const cuenta = this.cuentaActual();
    const ids = new Set(
      this.estado.asignaciones
        .filter((a) => a.administradorId === cuenta.id)
        .map((a) => a.recintoId),
    );
    return this.estado.recintos
      .filter((r) => ids.has(r.id))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }

  async crearRecinto(datos: DatosRecinto): Promise<{ ok: boolean; mensaje: string }> {
    const cuenta = this.cuentaActual();
    if (cuenta.rol !== "administrador") {
      throw new AppError("permisos", "Sólo un administrador puede crear recintos.");
    }
    if (datos.nombre.trim().length < 2) {
      return { ok: false, mensaje: "El nombre del recinto debe tener al menos 2 caracteres." };
    }
    const duplicado = this.estado.recintos.some(
      (r) => r.nombre.trim().toLowerCase() === datos.nombre.trim().toLowerCase(),
    );
    if (duplicado) {
      return { ok: false, mensaje: "Ya existe un recinto con ese nombre." };
    }

    const recinto: Recinto = {
      id: crypto.randomUUID(),
      nombre: datos.nombre.trim(),
      tipo: datos.tipo.trim(),
      descripcion: datos.descripcion.trim(),
      horarioFuncionamiento: datos.horarioFuncionamiento.trim(),
      activo: true,
    };
    this.estado.recintos.push(recinto);
    this.estado.asignaciones.push({
      id: crypto.randomUUID(),
      administradorId: cuenta.id,
      recintoId: recinto.id,
    });
    this.auditar({
      recintoId: recinto.id,
      accion: "recinto_creado",
      actorRol: "administrador",
      detalles: { nombre: recinto.nombre },
    });
    this.guardar();

    return { ok: true, mensaje: "Recinto creado y asignado a tu cuenta." };
  }

  async actualizarRecinto(recintoId: string, datos: Partial<DatosRecinto>): Promise<void> {
    const cuenta = this.cuentaActual();
    const asignado = this.estado.asignaciones.some(
      (a) => a.administradorId === cuenta.id && a.recintoId === recintoId,
    );
    if (!asignado) throw new AppError("permisos", "No administras ese recinto.");

    const recinto = this.estado.recintos.find((r) => r.id === recintoId);
    if (!recinto) throw new AppError("no_encontrado", "No encontramos ese recinto.");

    if (datos.nombre !== undefined) recinto.nombre = datos.nombre.trim();
    if (datos.tipo !== undefined) recinto.tipo = datos.tipo.trim();
    if (datos.descripcion !== undefined) recinto.descripcion = datos.descripcion.trim();
    if (datos.horarioFuncionamiento !== undefined) {
      recinto.horarioFuncionamiento = datos.horarioFuncionamiento.trim();
    }
    if (datos.activo !== undefined) recinto.activo = datos.activo;

    this.auditar({
      recintoId,
      accion: datos.activo === false ? "recinto_desactivado" : "recinto_actualizado",
      actorRol: "administrador",
    });
    this.guardar();
  }

  async listarBloques(recintoId: string): Promise<Bloque[]> {
    this.cuentaActual();
    return this.estado.bloques
      .filter((b) => b.recintoId === recintoId)
      .sort((a, b) => a.inicio.localeCompare(b.inicio));
  }

  async crearBloque(datos: DatosBloque): Promise<void> {
    const cuenta = this.cuentaActual();
    const asignado = this.estado.asignaciones.some(
      (a) => a.administradorId === cuenta.id && a.recintoId === datos.recintoId,
    );
    if (!asignado) throw new AppError("permisos", "No administras ese recinto.");

    const choque = this.estado.bloques.some(
      (b) => b.recintoId === datos.recintoId && b.activo && b.inicio === datos.inicio,
    );
    if (choque) {
      throw new AppError(
        "conflicto",
        "Ya existe un bloque activo que comienza a esa hora en este recinto.",
      );
    }

    const bloque: Bloque = {
      id: crypto.randomUUID(),
      recintoId: datos.recintoId,
      inicio: datos.inicio,
      fin: datos.fin,
      capacidadMaxima: datos.capacidadMaxima,
      activo: datos.activo,
    };
    this.estado.bloques.push(bloque);
    this.auditar({
      recintoId: datos.recintoId,
      accion: "bloque_creado",
      actorRol: "administrador",
      detalles: { inicio: datos.inicio, capacidad: datos.capacidadMaxima },
    });
    this.guardar();
  }

  async actualizarBloque(bloqueId: string, datos: Partial<DatosBloque>): Promise<void> {
    const cuenta = this.cuentaActual();
    const bloque = this.estado.bloques.find((b) => b.id === bloqueId);
    if (!bloque) throw new AppError("no_encontrado", "No encontramos ese bloque.");

    const asignado = this.estado.asignaciones.some(
      (a) => a.administradorId === cuenta.id && a.recintoId === bloque.recintoId,
    );
    if (!asignado) throw new AppError("permisos", "No administras el recinto de ese bloque.");

    if (datos.inicio !== undefined) bloque.inicio = datos.inicio;
    if (datos.fin !== undefined) bloque.fin = datos.fin;
    if (datos.capacidadMaxima !== undefined) bloque.capacidadMaxima = datos.capacidadMaxima;
    if (datos.activo !== undefined) bloque.activo = datos.activo;

    this.auditar({
      recintoId: bloque.recintoId,
      accion: datos.activo === false ? "bloque_desactivado" : "bloque_actualizado",
      actorRol: "administrador",
    });
    this.guardar();
  }

  /**
   * REQ-30 · serie de bloques.
   *
   * Replica las reglas de public.admin_create_block_series: omite los
   * bloques ya existentes y los que caen en el pasado, y respeta el
   * mismo tope por operación. Las validaciones devuelven los mismos
   * códigos de error, para que la interfaz se comporte igual en los dos
   * modos.
   */
  async crearSerieBloques(datos: DatosSerieBloques): Promise<ResultadoSerie> {
    const cuenta = this.cuentaActual();
    const asignado = this.estado.asignaciones.some(
      (a) => a.administradorId === cuenta.id && a.recintoId === datos.recintoId,
    );
    if (!asignado) throw new AppError("permisos", "No administras ese recinto.");

    const fallo = (error: string, mensaje: string): ResultadoSerie => ({
      ok: false, simulado: datos.simular, creados: 0, omitidosExistentes: 0,
      omitidosPasado: 0, previstos: 0, primerBloque: null, ultimoBloque: null,
      muestra: [], error, mensaje,
    });

    const desde = new Date(`${datos.fechaDesde}T00:00:00`);
    const hasta = new Date(`${datos.fechaHasta}T00:00:00`);

    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      return fallo("fechas_incompletas", "Indica la fecha de inicio y la de término de la serie.");
    }
    if (hasta < desde) {
      return fallo("rango_invertido", "La fecha de término debe ser igual o posterior a la de inicio.");
    }
    if ((hasta.getTime() - desde.getTime()) / 86_400_000 > 366) {
      return fallo("rango_demasiado_largo", "El rango no puede superar un año. Crea la serie por temporadas.");
    }
    if (datos.horas.length === 0) {
      return fallo("sin_horas", "Indica al menos una hora de inicio, por ejemplo 08:00.");
    }
    if (datos.horas.length > 24) {
      return fallo("demasiadas_horas", "Como máximo 24 horas de inicio por serie.");
    }
    for (const hora of datos.horas) {
      if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(hora)) {
        return fallo("hora_invalida", `La hora «${hora}» no tiene el formato HH:MM (24 horas).`);
      }
    }
    if (datos.duracionMinutos < 15 || datos.duracionMinutos > 720) {
      return fallo("duracion_invalida", "La duración debe estar entre 15 minutos y 12 horas.");
    }
    if (datos.capacidadMaxima < 1 || datos.capacidadMaxima > 1000) {
      return fallo("capacidad_invalida", "La capacidad debe estar entre 1 y 1000 personas.");
    }
    if (datos.diasSemana.some((d) => d < 0 || d > 6)) {
      return fallo("dia_invalido", "Los días de la semana van de 0 (domingo) a 6 (sábado).");
    }

    const dias = datos.diasSemana.length > 0 ? datos.diasSemana : [0, 1, 2, 3, 4, 5, 6];

    const fechas: Date[] = [];
    for (let d = new Date(desde); d <= hasta; d.setDate(d.getDate() + 1)) {
      if (dias.includes(d.getDay())) fechas.push(new Date(d));
    }

    const previstos = fechas.length * datos.horas.length;
    if (previstos > 1000) {
      return fallo("demasiados_bloques",
        `La serie generaría ${previstos} bloques y el máximo por operación es 1000. ` +
        `Acorta el rango o reduce las horas.`);
    }
    if (previstos === 0) {
      return fallo("serie_vacia", "Ninguna fecha del rango coincide con los días de la semana elegidos.");
    }

    const ahora = Date.now();
    let creados = 0;
    let omitidosExistentes = 0;
    let omitidosPasado = 0;
    let primerBloque: string | null = null;
    let ultimoBloque: string | null = null;
    const muestra: Array<{ inicio: string; fin: string }> = [];

    for (const fecha of fechas) {
      for (const hora of datos.horas) {
        const [h, m] = hora.split(":").map(Number);
        const inicio = new Date(fecha);
        inicio.setHours(h, m, 0, 0);
        const fin = new Date(inicio.getTime() + datos.duracionMinutos * 60_000);
        const inicioIso = inicio.toISOString();

        if (inicio.getTime() <= ahora) {
          omitidosPasado += 1;
          continue;
        }

        const yaExiste = this.estado.bloques.some(
          (b) => b.recintoId === datos.recintoId && b.activo && b.inicio === inicioIso,
        );
        if (yaExiste) {
          omitidosExistentes += 1;
          continue;
        }

        if (!datos.simular) {
          this.estado.bloques.push({
            id: crypto.randomUUID(),
            recintoId: datos.recintoId,
            inicio: inicioIso,
            fin: fin.toISOString(),
            capacidadMaxima: datos.capacidadMaxima,
            activo: true,
          });
        }

        creados += 1;
        if (primerBloque === null) primerBloque = inicioIso;
        ultimoBloque = inicioIso;
        if (muestra.length < 5) {
          muestra.push({ inicio: inicioIso, fin: fin.toISOString() });
        }
      }
    }

    if (!datos.simular && creados > 0) {
      this.auditar({
        recintoId: datos.recintoId,
        accion: "bloque_creado",
        actorRol: "administrador",
        detalles: { serie: true, creados, modo: "demostracion" },
      });
      this.guardar();
    }

    return {
      ok: true,
      simulado: datos.simular,
      creados,
      omitidosExistentes,
      omitidosPasado,
      previstos,
      primerBloque,
      ultimoBloque,
      muestra,
      mensaje:
        creados === 0 && omitidosExistentes > 0
          ? "Todos los bloques de la serie ya existían: no se creó ninguno nuevo."
          : creados === 0
            ? "No había ningún bloque que crear en ese rango."
            : datos.simular
              ? `Se crearían ${creados} bloques.`
              : `Se crearon ${creados} bloques.`,
    };
  }

  async desactivarSerieBloques(
    recintoId: string,
    fechaDesde: string,
    fechaHasta: string,
    simular: boolean,
  ): Promise<ResultadoDesactivacionSerie> {
    const cuenta = this.cuentaActual();
    const asignado = this.estado.asignaciones.some(
      (a) => a.administradorId === cuenta.id && a.recintoId === recintoId,
    );
    if (!asignado) throw new AppError("permisos", "No administras ese recinto.");

    const desde = new Date(`${fechaDesde}T00:00:00`).getTime();
    const hasta = new Date(`${fechaHasta}T23:59:59.999`).getTime();

    if (Number.isNaN(desde) || Number.isNaN(hasta) || hasta < desde) {
      return {
        ok: false, simulado: simular, afectados: 0, conReservasVigentes: 0,
        error: "rango_invalido", mensaje: "Indica un rango de fechas válido.",
      };
    }

    const enRango = this.estado.bloques.filter((b) => {
      const t = new Date(b.inicio).getTime();
      return b.recintoId === recintoId && b.activo && t >= desde && t <= hasta;
    });

    const conReservas = new Set(
      this.estado.reservas
        .filter((r) => r.estado === "vigente" && enRango.some((b) => b.id === r.bloqueId))
        .map((r) => r.bloqueId),
    ).size;

    if (!simular && enRango.length > 0) {
      for (const bloque of enRango) bloque.activo = false;
      this.auditar({
        recintoId,
        accion: "bloque_desactivado",
        actorRol: "administrador",
        detalles: { serie: true, desactivados: enRango.length, modo: "demostracion" },
      });
      this.guardar();
    }

    return {
      ok: true,
      simulado: simular,
      afectados: enRango.length,
      conReservasVigentes: conReservas,
      mensaje:
        enRango.length === 0
          ? "No hay bloques activos en ese rango."
          : simular
            ? `Se desactivarían ${enRango.length} bloques.`
            : `Se desactivaron ${enRango.length} bloques.`,
    };
  }

  async listarReservasAdmin(
    recintoId: string | null,
    alcance: "vigentes" | "historial" | "todas",
  ): Promise<ReservaAdmin[]> {
    const cuenta = this.cuentaActual();
    if (cuenta.rol !== "administrador") {
      throw new AppError("permisos", "Acceso restringido a administradores.");
    }

    const permitidos = new Set(
      this.estado.asignaciones
        .filter((a) => a.administradorId === cuenta.id)
        .map((a) => a.recintoId),
    );
    if (recintoId && !permitidos.has(recintoId)) {
      throw new AppError("permisos", "No administras ese recinto.");
    }

    const ahora = Date.now();
    const recintos = new Map(this.estado.recintos.map((r) => [r.id, r]));
    const nombres = new Map(this.estado.cuentas.map((c) => [c.id, c.nombre]));

    return this.estado.reservas
      .filter((r) => permitidos.has(r.recintoId))
      .filter((r) => !recintoId || r.recintoId === recintoId)
      .filter((r) => {
        const pasada = new Date(r.fin).getTime() < ahora;
        if (alcance === "vigentes") return r.estado === "vigente" && !pasada;
        if (alcance === "historial") return r.estado === "cancelada" || pasada;
        return true;
      })
      .map((r) => ({
        id: r.id,
        recintoId: r.recintoId,
        recintoNombre: recintos.get(r.recintoId)?.nombre ?? "Recinto",
        bloqueId: r.bloqueId,
        inicio: r.inicio,
        fin: r.fin,
        estado: r.estado,
        esPasada: new Date(r.fin).getTime() < ahora,
        usuarioNombre: nombres.get(r.usuarioId) ?? "Usuario",
        calendarSync: r.calendarSync,
        tieneEventoCalendario: r.tieneEventoCalendario,
        whatsappEstado: r.whatsappConfirmacion,
        canceladaPorRol: r.canceladaPorRol,
        motivoCancelacion: r.motivoCancelacion,
        creadaEn: r.creadaEn,
      }))
      .sort((a, b) => b.inicio.localeCompare(a.inicio));
  }

  async listarIncidenciasIntegracion(): Promise<IncidenciaIntegracion[]> {
    // En modo demostración no hay colas reales, así que no hay
    // incidencias que reportar. Devolver datos inventados aquí haría
    // creer que las integraciones funcionan.
    this.cuentaActual();
    return [];
  }

  async listarAuditoria(recintoId: string | null): Promise<EntradaAuditoria[]> {
    this.cuentaActual();
    return this.estado.auditoria.filter((e) => !recintoId || e.recintoId === recintoId);
  }
}

export const mockRepository = new MockRepository();

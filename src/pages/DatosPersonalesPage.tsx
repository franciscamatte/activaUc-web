import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { enmascararTelefono, normalizarTelefono, validarTelefono } from "../domain/phone";
import { formatearFechaHora } from "../lib/format";
import { aAppError } from "../lib/errors";
import { esModoMock } from "../data";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import { CampoCasilla, CampoTexto } from "../components/ui/Campo";
import Insignia from "../components/ui/Insignia";
import Modal from "../components/ui/Modal";
import { Cargando } from "../components/ui/Estados";

/** Mensajes del parámetro ?calendar= que deja el callback de OAuth. */
const MOTIVOS_CALENDARIO: Record<string, string> = {
  permiso_denegado: "No autorizaste el acceso a tu calendario, así que no conectamos nada.",
  state_invalido:
    "La solicitud de conexión no pudo verificarse. Inténtalo de nuevo desde esta página.",
  state_expirado:
    "La solicitud de conexión caducó o ya se usó. Inicia la conexión otra vez.",
  sin_refresh_token:
    "Google no entregó el permiso prolongado necesario. Vuelve a intentarlo y acepta todos los permisos solicitados.",
  permisos_insuficientes:
    "Faltó autorizar el permiso de eventos de calendario, que es el mínimo que necesitamos.",
  no_configurado:
    "La integración con Google Calendar aún no está configurada en el servidor.",
  parametros_incompletos: "La respuesta de Google llegó incompleta. Inténtalo de nuevo.",
  google_error: "Google rechazó la solicitud. Inténtalo de nuevo en unos minutos.",
  error_interno: "Tuvimos un problema al guardar la conexión. Inténtalo de nuevo.",
};

/** REQ-7, REQ-17, REQ-22, REQ-23 · datos personales, WhatsApp y Calendar. */
export default function DatosPersonalesPage() {
  const {
    perfil,
    fase,
    calendario,
    cargandoCalendario,
    repositorio,
    actualizarNombre,
    definirConsentimientoWhatsapp,
    definirConsentimientoCorreo,
    recargarCalendario,
  } = useAuth();

  const [parametros, setParametros] = useSearchParams();

  // --- Nombre -------------------------------------------------------
  const [nombre, setNombre] = useState<string | null>(null);
  const [errorNombre, setErrorNombre] = useState<string | null>(null);
  const [guardandoNombre, setGuardandoNombre] = useState(false);
  const [nombreGuardado, setNombreGuardado] = useState(false);

  // --- WhatsApp -----------------------------------------------------
  const [telefono, setTelefono] = useState<string | null>(null);
  const [consentimiento, setConsentimiento] = useState<boolean | null>(null);
  const [errorTelefono, setErrorTelefono] = useState<string | null>(null);
  const [guardandoWhatsapp, setGuardandoWhatsapp] = useState(false);
  const [avisoWhatsapp, setAvisoWhatsapp] = useState<string | null>(null);
  const [confirmarRevocacion, setConfirmarRevocacion] = useState(false);

  // --- Correo (REQ-22, REQ-23 aplicados al otro canal) ------------
  const [guardandoCorreo, setGuardandoCorreo] = useState(false);
  const [avisoCorreo, setAvisoCorreo] = useState<string | null>(null);
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null);

  // --- Google Calendar ----------------------------------------------
  const [procesandoCalendario, setProcesandoCalendario] = useState(false);
  const [errorCalendario, setErrorCalendario] = useState<string | null>(null);
  const [avisoCalendario, setAvisoCalendario] = useState<string | null>(null);
  const [confirmarDesconexion, setConfirmarDesconexion] = useState(false);

  // Resultado del flujo OAuth, que vuelve como ?calendar=... Se lee una
  // sola vez al montar (inicializador perezoso) para poder derivar el
  // mensaje durante el render en lugar de fijarlo dentro de un efecto.
  const [resultadoOauth] = useState(() => ({
    estado: parametros.get("calendar"),
    motivo: parametros.get("motivo") ?? "",
  }));
  const [oauthDescartado, setOauthDescartado] = useState(false);

  const avisoOauth = !oauthDescartado && resultadoOauth.estado === "conectado"
    ? "Conectamos tu cuenta de Google Calendar. Tus próximas reservas se agregarán a tu calendario."
    : null;
  const errorOauth = !oauthDescartado && resultadoOauth.estado === "error"
    ? MOTIVOS_CALENDARIO[resultadoOauth.motivo] ??
      "No pudimos conectar tu cuenta de Google Calendar. Inténtalo de nuevo."
    : null;

  // Se muestra lo que ocurrió en esta pantalla, o si no, el resultado
  // con que volvió el flujo de OAuth.
  const avisoCalendarioVisible = avisoCalendario ?? avisoOauth;
  const errorCalendarioVisible = errorCalendario ?? errorOauth;

  // Los campos editables arrancan vacíos y se rellenan con los valores
  // del perfil mediante `valorMostrado`: así no hace falta copiar el
  // perfil al estado ni sincronizarlo con un efecto. `null` significa
  // "sin editar todavía", y cualquier cadena significa "el usuario ya
  // escribió algo", incluida la cadena vacía.
  const nombreMostrado = nombre ?? perfil?.nombre ?? "";
  const telefonoMostrado = telefono ?? perfil?.telefono ?? "";
  const consentimientoMostrado = consentimiento ?? perfil?.whatsappConsentido ?? false;

  // Tras una conexión exitosa se refresca el estado real desde el
  // servidor y se limpia la URL, que son efectos sobre sistemas
  // externos (la API y el historial del navegador), no estado derivado.
  useEffect(() => {
    if (!resultadoOauth.estado) return;

    if (resultadoOauth.estado === "conectado") {
      void recargarCalendario();
    }

    const limpios = new URLSearchParams(window.location.search);
    limpios.delete("calendar");
    limpios.delete("motivo");
    setParametros(limpios, { replace: true });
  }, [resultadoOauth.estado, setParametros, recargarCalendario]);

  if (fase === "cargando" || !perfil) {
    return <Cargando texto="Cargando tus datos…" />;
  }

  async function guardarNombre(evento: FormEvent) {
    evento.preventDefault();
    setErrorNombre(null);
    setNombreGuardado(false);

    if (nombreMostrado.trim().length < 2) {
      setErrorNombre("Ingresa tu nombre completo (al menos 2 caracteres).");
      return;
    }

    setGuardandoNombre(true);
    try {
      await actualizarNombre(nombreMostrado);
      setNombreGuardado(true);
    } catch (e) {
      setErrorNombre(aAppError(e, "guardar tu nombre").message);
    } finally {
      setGuardandoNombre(false);
    }
  }

  async function alternarCorreo(consentido: boolean) {
    setAvisoCorreo(null);
    setErrorCorreo(null);
    setGuardandoCorreo(true);
    try {
      const r = await definirConsentimientoCorreo(consentido);
      if (r.ok) setAvisoCorreo(r.mensaje);
      else setErrorCorreo(r.mensaje);
    } catch (e) {
      setErrorCorreo(aAppError(e, "guardar tu preferencia de correo").message);
    } finally {
      setGuardandoCorreo(false);
    }
  }

  async function guardarWhatsapp(evento: FormEvent) {
    evento.preventDefault();
    setErrorTelefono(null);
    setAvisoWhatsapp(null);

    // Desactivar la casilla equivale a revocar: se pide confirmación.
    if (!consentimientoMostrado && perfil?.whatsappConsentido) {
      setConfirmarRevocacion(true);
      return;
    }

    if (consentimientoMostrado) {
      const problema = validarTelefono(telefonoMostrado);
      if (problema) {
        setErrorTelefono(problema);
        return;
      }
    }

    setGuardandoWhatsapp(true);
    try {
      const resultado = await definirConsentimientoWhatsapp(
        consentimientoMostrado ? normalizarTelefono(telefonoMostrado) : null,
        consentimientoMostrado,
      );
      if (resultado.ok) setAvisoWhatsapp(resultado.mensaje);
      else setErrorTelefono(resultado.mensaje);
    } catch (e) {
      setErrorTelefono(aAppError(e, "guardar tus preferencias").message);
    } finally {
      setGuardandoWhatsapp(false);
    }
  }

  async function revocarConsentimiento() {
    setGuardandoWhatsapp(true);
    setErrorTelefono(null);
    try {
      const resultado = await definirConsentimientoWhatsapp(null, false);
      setConfirmarRevocacion(false);
      setTelefono(null);
      setConsentimiento(null);
      if (resultado.ok) setAvisoWhatsapp(resultado.mensaje);
    } catch (e) {
      setErrorTelefono(aAppError(e, "revocar el consentimiento").message);
    } finally {
      setGuardandoWhatsapp(false);
    }
  }

  async function conectarCalendario() {
    if (!repositorio) return;
    setErrorCalendario(null);
    setAvisoCalendario(null);
    setProcesandoCalendario(true);

    try {
      const url = await repositorio.iniciarConexionCalendario("/datos-personales");
      // Se abandona la SPA hacia la pantalla de consentimiento de Google.
      window.location.assign(url);
    } catch (e) {
      setErrorCalendario(aAppError(e, "conectar Google Calendar").message);
      setProcesandoCalendario(false);
    }
  }

  async function desconectarCalendario() {
    if (!repositorio) return;
    setErrorCalendario(null);
    setProcesandoCalendario(true);

    try {
      const { mensaje } = await repositorio.desconectarCalendario();
      setConfirmarDesconexion(false);
      setAvisoCalendario(mensaje);
      await recargarCalendario();
    } catch (e) {
      setErrorCalendario(aAppError(e, "desconectar Google Calendar").message);
    } finally {
      setProcesandoCalendario(false);
    }
  }

  const conectado = calendario?.estado === "conectado";

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Datos personales</h1>
        <p className="text-sm text-slate-600">
          Tu correo y tu teléfono sólo son visibles para ti. Nadie más en la plataforma
          puede consultarlos.
        </p>
      </header>

      {/* --- Cuenta --------------------------------------------------- */}
      <form
        onSubmit={guardarNombre}
        noValidate
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6"
      >
        <h2 className="text-base font-semibold text-slate-900">Mi cuenta</h2>

        <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm">
          <p className="text-slate-500">Correo de la cuenta</p>
          <p className="font-medium text-slate-900">{perfil.correo}</p>
          <p className="mt-1 text-xs text-slate-500">
            El correo no se puede cambiar desde aquí. Escribe a Deportes UC si necesitas
            modificarlo.
          </p>
        </div>

        <CampoTexto
          etiqueta="Nombre completo"
          autoComplete="name"
          required
          value={nombreMostrado}
          onChange={(e) => {
            setNombre(e.target.value);
            setNombreGuardado(false);
          }}
          error={errorNombre}
        />

        {nombreGuardado ? (
          <Alerta tono="exito" onCerrar={() => setNombreGuardado(false)}>
            Guardamos tu nombre.
          </Alerta>
        ) : null}

        <Boton
          type="submit"
          cargando={guardandoNombre}
          disabled={nombreMostrado.trim() === perfil.nombre}
        >
          Guardar nombre
        </Boton>
      </form>

      {/* --- WhatsApp (REQ-22, REQ-23) -------------------------------- */}
      <form
        onSubmit={guardarWhatsapp}
        noValidate
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            Notificaciones por WhatsApp
          </h2>
          {perfil.whatsappConsentido ? (
            <Insignia tono="exito">Activadas</Insignia>
          ) : (
            <Insignia tono="neutro">Desactivadas</Insignia>
          )}
        </div>

        <p className="text-sm text-slate-600">
          Si registras tu número, te enviaremos la confirmación de cada reserva y un
          recordatorio 2 horas antes del bloque. Puedes revocar este permiso cuando
          quieras.
        </p>

        {perfil.whatsappConsentido && perfil.telefono ? (
          <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm">
            <p className="text-emerald-800">Número registrado</p>
            <p className="font-medium text-emerald-950">
              {enmascararTelefono(perfil.telefono)}
            </p>
            {perfil.whatsappConsentidoEn ? (
              <p className="mt-1 text-xs text-emerald-800">
                Consentimiento otorgado el {formatearFechaHora(perfil.whatsappConsentidoEn)}.
              </p>
            ) : null}
          </div>
        ) : null}

        <CampoCasilla
          etiqueta="Acepto recibir confirmaciones y recordatorios de mis reservas por WhatsApp."
          checked={consentimientoMostrado}
          onChange={(e) => {
            setConsentimiento(e.target.checked);
            setAvisoWhatsapp(null);
            setErrorTelefono(null);
          }}
          ayuda="Es necesario registrar un número válido para activar los envíos."
        />

        {consentimientoMostrado ? (
          <CampoTexto
            etiqueta="Número de WhatsApp"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={telefonoMostrado}
            onChange={(e) => {
              setTelefono(e.target.value);
              setErrorTelefono(null);
            }}
            error={errorTelefono}
            ayuda="Formato internacional, por ejemplo +56912345678."
            placeholder="+56912345678"
          />
        ) : errorTelefono ? (
          <Alerta tono="error">{errorTelefono}</Alerta>
        ) : null}

        {avisoWhatsapp ? (
          <Alerta tono="exito" onCerrar={() => setAvisoWhatsapp(null)}>
            {avisoWhatsapp}
          </Alerta>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Boton type="submit" cargando={guardandoWhatsapp}>
            Guardar preferencias
          </Boton>

          {perfil.whatsappConsentido ? (
            <Boton
              variante="peligro"
              onClick={() => setConfirmarRevocacion(true)}
              disabled={guardandoWhatsapp}
            >
              Eliminar número y revocar
            </Boton>
          ) : null}
        </div>
      </form>

      {/* --- Correo (REQ-22, REQ-23) --------------------------------- */}
      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            Notificaciones por correo
          </h2>
          {perfil.correoConsentido ? (
            <Insignia tono="exito">Activadas</Insignia>
          ) : (
            <Insignia tono="neutro">Desactivadas</Insignia>
          )}
        </div>

        <p className="text-sm text-slate-600">
          La misma confirmación y el mismo recordatorio, a{" "}
          <strong className="font-medium text-slate-800">{perfil.correo}</strong>, el
          correo con que entras. Puedes tener las dos vías a la vez, una sola, o
          ninguna: son independientes.
        </p>

        {errorCorreo ? (
          <Alerta tono="error" titulo="No pudimos guardar tu preferencia">
            {errorCorreo}
          </Alerta>
        ) : null}

        {avisoCorreo ? (
          <Alerta tono="exito" onCerrar={() => setAvisoCorreo(null)}>
            {avisoCorreo}
          </Alerta>
        ) : null}

        <div>
          {perfil.correoConsentido ? (
            <Boton
              variante="secundario"
              onClick={() => alternarCorreo(false)}
              cargando={guardandoCorreo}
            >
              Desactivar los correos
            </Boton>
          ) : (
            <Boton onClick={() => alternarCorreo(true)} cargando={guardandoCorreo}>
              Avisarme por correo
            </Boton>
          )}
        </div>
      </div>

      {/* --- Google Calendar (REQ-17) -------------------------------- */}
      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">Google Calendar</h2>
          {cargandoCalendario ? (
            <Insignia tono="neutro">Consultando…</Insignia>
          ) : conectado ? (
            <Insignia tono="exito">Conectado</Insignia>
          ) : calendario?.estado === "error" ? (
            <Insignia tono="error">Con error</Insignia>
          ) : (
            <Insignia tono="neutro">No conectado</Insignia>
          )}
        </div>

        <p className="text-sm text-slate-600">
          La conexión es voluntaria. Si la activas, cada reserva que confirmes se agregará
          como evento a tu calendario y se eliminará si la cancelas. Desconectarla no
          afecta tus reservas.
        </p>

        {esModoMock ? (
          <Alerta tono="aviso" titulo="No disponible en modo demostración">
            La conexión con Google Calendar requiere el backend real. Configura{" "}
            <code className="rounded bg-amber-100 px-1">VITE_DATA_MODE=supabase</code> y
            despliega las Edge Functions para usarla.
          </Alerta>
        ) : null}

        {conectado && calendario?.cuentaGoogle ? (
          <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm">
            <p className="text-emerald-800">Cuenta conectada</p>
            <p className="font-medium text-emerald-950">{calendario.cuentaGoogle}</p>
            {calendario.conectadaEn ? (
              <p className="mt-1 text-xs text-emerald-800">
                Conectada el {formatearFechaHora(calendario.conectadaEn)}.
              </p>
            ) : null}
          </div>
        ) : null}

        {calendario?.estado === "error" ? (
          <Alerta tono="aviso" titulo="La conexión necesita renovarse">
            Perdimos el permiso para escribir en tu calendario (puede que lo hayas revocado
            desde tu cuenta de Google). Vuelve a conectarla para seguir sincronizando. Tus
            reservas siguen vigentes.
          </Alerta>
        ) : null}

        {avisoCalendarioVisible ? (
          <Alerta
            tono="exito"
            onCerrar={() => {
              setAvisoCalendario(null);
              setOauthDescartado(true);
            }}
          >
            {avisoCalendarioVisible}
          </Alerta>
        ) : null}

        {errorCalendarioVisible ? (
          <Alerta
            tono="error"
            titulo="No pudimos completar la operación"
            onCerrar={() => {
              setErrorCalendario(null);
              setOauthDescartado(true);
            }}
          >
            {errorCalendarioVisible}
          </Alerta>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {conectado ? (
            <Boton
              variante="peligro"
              onClick={() => setConfirmarDesconexion(true)}
              disabled={procesandoCalendario || esModoMock}
            >
              Desconectar Google Calendar
            </Boton>
          ) : (
            <Boton
              onClick={() => void conectarCalendario()}
              cargando={procesandoCalendario}
              disabled={esModoMock}
            >
              Conectar Google Calendar
            </Boton>
          )}
        </div>

        <p className="text-xs text-slate-500">
          Solicitamos únicamente el permiso de eventos de calendario, el mínimo necesario
          para crear y eliminar los eventos de tus reservas. Los permisos se guardan
          cifrados en el servidor y nunca se exponen en el navegador.
        </p>
      </div>

      {/* --- Diálogos de confirmación -------------------------------- */}
      <Modal
        abierto={confirmarRevocacion}
        titulo="Revocar notificaciones por WhatsApp"
        descripcion="Eliminaremos tu número y dejaremos de enviarte mensajes."
        onCerrar={() => setConfirmarRevocacion(false)}
        acciones={
          <>
            <Boton
              variante="secundario"
              onClick={() => setConfirmarRevocacion(false)}
              disabled={guardandoWhatsapp}
            >
              Mantener activadas
            </Boton>
            <Boton
              variante="peligro"
              onClick={() => void revocarConsentimiento()}
              cargando={guardandoWhatsapp}
            >
              Sí, revocar
            </Boton>
          </>
        }
      >
        <p>
          Dejarás de recibir confirmaciones y recordatorios. Los recordatorios que ya
          estaban programados se cancelarán. Tus reservas no se modifican.
        </p>
      </Modal>

      <Modal
        abierto={confirmarDesconexion}
        titulo="Desconectar Google Calendar"
        descripcion="Revocaremos el permiso en tu cuenta de Google."
        onCerrar={() => setConfirmarDesconexion(false)}
        acciones={
          <>
            <Boton
              variante="secundario"
              onClick={() => setConfirmarDesconexion(false)}
              disabled={procesandoCalendario}
            >
              Mantener conectada
            </Boton>
            <Boton
              variante="peligro"
              onClick={() => void desconectarCalendario()}
              cargando={procesandoCalendario}
            >
              Sí, desconectar
            </Boton>
          </>
        }
      >
        <p>
          Tus reservas seguirán vigentes y válidas. Dejaremos de crear y eliminar eventos
          en tu calendario, y los eventos ya creados permanecerán allí.
        </p>
      </Modal>
    </section>
  );
}

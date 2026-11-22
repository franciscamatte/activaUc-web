import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { normalizarTelefono, validarTelefono } from "../domain/phone";
import { formatearFechaHora } from "../lib/format";
import { aAppError } from "../lib/errors";
import { esModoMock } from "../data";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import { CampoTexto } from "../components/ui/Campo";
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
    "Faltó autorizar el permiso de eventos de calendario, que es el mínimo que " +
    "necesitamos. En la pantalla de Google hay que marcar la casilla del permiso " +
    "antes de continuar: si se deja sin marcar, Google aprueba el acceso sin ese " +
    "permiso y no podemos crear los eventos.",
  no_configurado:
    "La integración con Google Calendar aún no está configurada en el servidor.",
  parametros_incompletos: "La respuesta de Google llegó incompleta. Inténtalo de nuevo.",
  google_error: "Google rechazó la solicitud. Inténtalo de nuevo en unos minutos.",
  error_interno: "Tuvimos un problema al guardar la conexión. Inténtalo de nuevo.",
};

/** REQ-7, REQ-17, REQ-22, REQ-23 · datos personales, avisos y Calendar. */
export default function DatosPersonalesPage() {
  const {
    perfil,
    fase,
    calendario,
    cargandoCalendario,
    // La página ya tiene un `errorCalendario` para los fallos de
    // conectar o desconectar; este es el de no poder consultar el
    // estado, que es otra cosa.
    errorCalendario: errorEstadoCalendario,
    repositorio,
    actualizarNombre,
    actualizarTelefono,
    definirConsentimientoCorreo,
    recargarCalendario,
  } = useAuth();

  const [parametros, setParametros] = useSearchParams();

  // --- Nombre -------------------------------------------------------
  const [nombre, setNombre] = useState<string | null>(null);
  const [errorNombre, setErrorNombre] = useState<string | null>(null);
  const [guardandoNombre, setGuardandoNombre] = useState(false);
  const [nombreGuardado, setNombreGuardado] = useState(false);

  // --- Teléfono (REQ-7) ---------------------------------------------
  const [telefono, setTelefono] = useState<string | null>(null);
  const [errorTelefono, setErrorTelefono] = useState<string | null>(null);
  const [avisoTelefono, setAvisoTelefono] = useState<string | null>(null);

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

  // Tras una conexión exitosa se refresca el estado real desde el
  // servidor y se limpia la URL, que son efectos sobre sistemas
  // externos (la API y el historial del navegador), no estado derivado.
  //
  // El cerrojo es necesario: esto debe ocurrir **una vez** por vuelta
  // del flujo de OAuth, y las dependencias de un efecto no garantizan
  // eso. Si alguna cambiara de identidad entre renders, el efecto
  // volvería a consultar, la consulta fijaría estado, y de ahí un
  // bucle. Ya pasó una vez.
  const oauthProcesado = useRef(false);

  useEffect(() => {
    if (!resultadoOauth.estado || oauthProcesado.current) return;
    oauthProcesado.current = true;

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

  /**
   * REQ-7 · nombre y teléfono se guardan juntos.
   *
   * Son los dos campos editables de la cuenta y el requisito los nombra
   * en la misma frase, así que tenerlos en formularios separados
   * obligaba a guardar dos veces lo que es un solo cambio. Se envía sólo
   * lo que cambió: si tocaste el nombre, no se reescribe el teléfono.
   */
  async function guardarCuenta(evento: FormEvent) {
    evento.preventDefault();
    // El render ya devolvió «Cargando» si no hay perfil, pero las
    // declaraciones de función se elevan y TypeScript no lo sabe aquí.
    if (!perfil) return;
    setErrorNombre(null);
    setErrorTelefono(null);
    setNombreGuardado(false);
    setAvisoTelefono(null);

    const nombreCambio = nombreMostrado.trim() !== perfil.nombre;
    const telefonoLimpio = telefonoMostrado.trim();
    const telefonoCambio = telefonoLimpio !== (perfil.telefono ?? "");

    if (nombreCambio && nombreMostrado.trim().length < 2) {
      setErrorNombre("Ingresa tu nombre completo (al menos 2 caracteres).");
      return;
    }
    if (telefonoCambio && telefonoLimpio !== "") {
      const problema = validarTelefono(telefonoLimpio);
      if (problema) {
        setErrorTelefono(problema);
        return;
      }
    }

    setGuardandoNombre(true);
    try {
      if (nombreCambio) {
        await actualizarNombre(nombreMostrado);
        setNombreGuardado(true);
      }

      if (telefonoCambio) {
        const resultado = await actualizarTelefono(
          telefonoLimpio === "" ? null : normalizarTelefono(telefonoLimpio),
        );
        if (resultado.ok) {
          setAvisoTelefono(resultado.mensaje);
          setTelefono(null);
        } else {
          setErrorTelefono(resultado.mensaje);
        }
      }
    } catch (e) {
      setErrorNombre(aAppError(e, "guardar tus datos").message);
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

      {/* --- Mi cuenta · REQ-7 --------------------------------------- */}
      <form
        onSubmit={guardarCuenta}
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

        <CampoTexto
          etiqueta="Teléfono (opcional)"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={telefonoMostrado}
          onChange={(e) => {
            setTelefono(e.target.value);
            setErrorTelefono(null);
            setAvisoTelefono(null);
          }}
          error={errorTelefono}
          ayuda="Dato de contacto para la administración del recinto. Formato internacional, por ejemplo +56912345678. Déjalo en blanco para borrarlo."
          placeholder="+56912345678"
        />

        {/* Un solo aviso para los dos campos: guardar el nombre y el
            teléfono es un único gesto, y dos cajas verdes seguidas se
            leen como si hubieran pasado dos cosas distintas. */}
        {nombreGuardado || avisoTelefono ? (
          <Alerta
            tono="exito"
            onCerrar={() => {
              setNombreGuardado(false);
              setAvisoTelefono(null);
            }}
          >
            {[nombreGuardado ? "Guardamos tu nombre." : null, avisoTelefono]
              .filter(Boolean)
              .join(" ")}
          </Alerta>
        ) : null}

        <Boton
          type="submit"
          cargando={guardandoNombre}
          disabled={
            nombreMostrado.trim() === perfil.nombre &&
            telefonoMostrado.trim() === (perfil.telefono ?? "")
          }
        >
          Guardar cambios
        </Boton>
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
          Te enviaremos la confirmación de cada reserva, un recordatorio 2 horas
          antes, el aviso si la administración la cancela y el aviso si se libera
          un cupo que estabas esperando. Todo a{" "}
          <strong className="font-medium text-slate-800">{perfil.correo}</strong>, el
          correo con que entras: no hace falta escribir ninguna dirección.
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
          ) : errorEstadoCalendario ? (
            <Insignia tono="aviso">Sin respuesta</Insignia>
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

        {errorEstadoCalendario && !cargandoCalendario ? (
          <Alerta tono="aviso" titulo="No pudimos consultar tu conexión">
            {errorEstadoCalendario} Tus reservas no se ven afectadas: esto es sólo el estado
            de la integración.
            <div className="mt-3">
              <Boton
                variante="secundario"
                tamano="pequeno"
                onClick={() => void recargarCalendario()}
              >
                Volver a consultar
              </Boton>
            </div>
          </Alerta>
        ) : null}

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

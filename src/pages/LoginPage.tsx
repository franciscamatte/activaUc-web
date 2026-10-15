import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { esModoMock } from "../data";
import { CUENTAS_DEMO } from "../data/seed";
import { aAppError } from "../lib/errors";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import { CampoTexto } from "../components/ui/Campo";

/** REQ-2, REQ-3, REQ-5 · inicio de sesión con manejo explícito de errores. */
export default function LoginPage() {
  const { iniciarSesion, reenviarConfirmacion, sesionExpirada, descartarAvisoExpiracion } = useAuth();
  const navegar = useNavigate();
  const ubicacion = useLocation();

  const estado = (ubicacion.state ?? {}) as {
    destino?: string;
    sinPermiso?: boolean;
    cuentaCreada?: boolean;
    contrasenaActualizada?: boolean;
    correoConfirmado?: boolean;
  };

  const [correo, setCorreo] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tipoError, setTipoError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [reenviado, setReenviado] = useState(false);

  async function alEnviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setTipoError(null);
    setEnviando(true);
    descartarAvisoExpiracion();

    try {
      await iniciarSesion(correo, contrasena);
      navegar(estado.destino ?? "/catalogo", { replace: true });
    } catch (e) {
      const appError = aAppError(e, "iniciar sesión");
      setError(appError.message);
      setTipoError(appError.tipo);
    } finally {
      setEnviando(false);
    }
  }

  async function alReenviar() {
    try {
      await reenviarConfirmacion(correo);
      setReenviado(true);
    } catch (e) {
      setError(aAppError(e).message);
    }
  }

  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold text-slate-900">Iniciar sesión</h1>
      <p className="mt-2 text-sm text-slate-600">
        Ingresa con el correo y la contraseña con que creaste tu cuenta.
      </p>

      <div className="mt-6 space-y-4">
        {sesionExpirada ? (
          <Alerta tono="aviso" titulo="Tu sesión expiró" onCerrar={descartarAvisoExpiracion}>
            Por seguridad cerramos tu sesión tras un período de inactividad. Vuelve a
            ingresar para continuar donde estabas.
          </Alerta>
        ) : null}

        {estado.cuentaCreada ? (
          <Alerta tono="exito" titulo="Cuenta creada">
            Revisa tu correo y confirma tu cuenta. Después podrás iniciar sesión aquí.
          </Alerta>
        ) : null}

        {estado.correoConfirmado ? (
          <Alerta tono="exito" titulo="Correo confirmado">
            Tu cuenta quedó activada. Ya puedes iniciar sesión.
          </Alerta>
        ) : null}

        {estado.contrasenaActualizada ? (
          <Alerta tono="exito" titulo="Contraseña actualizada">
            Tu nueva contraseña quedó guardada. Inicia sesión con ella.
          </Alerta>
        ) : null}

        {estado.sinPermiso ? (
          <Alerta tono="aviso" titulo="Acceso restringido">
            Esa sección es sólo para administradores de recintos.
          </Alerta>
        ) : null}

        {esModoMock ? (
          <Alerta tono="info" titulo="Cuentas de ejemplo (modo demostración)">
            <ul className="space-y-1">
              {CUENTAS_DEMO.map((cuenta) => (
                <li key={cuenta.correo}>
                  <code className="rounded bg-sky-100 px-1.5 py-0.5">{cuenta.correo}</code>
                  {" · "}
                  <code className="rounded bg-sky-100 px-1.5 py-0.5">{cuenta.contrasena}</code>
                  {cuenta.rol === "administrador" ? " (administradora)" : " (usuaria)"}
                </li>
              ))}
            </ul>
          </Alerta>
        ) : null}

        <form onSubmit={alEnviar} noValidate className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
          <CampoTexto
            etiqueta="Correo"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            placeholder="nombre@uc.cl"
          />

          <CampoTexto
            etiqueta="Contraseña"
            type="password"
            name="current-password"
            autoComplete="current-password"
            required
            value={contrasena}
            onChange={(e) => setContrasena(e.target.value)}
          />

          {error ? (
            <Alerta tono="error" titulo="No pudimos iniciar tu sesión">
              <p>{error}</p>
              {tipoError === "correo_no_confirmado" && !reenviado ? (
                <Boton
                  variante="secundario"
                  tamano="pequeno"
                  className="mt-3"
                  onClick={() => void alReenviar()}
                >
                  Reenviar correo de confirmación
                </Boton>
              ) : null}
              {reenviado ? (
                <p className="mt-2 font-medium">
                  Reenviamos el correo de confirmación. Revisa tu bandeja de entrada.
                </p>
              ) : null}
            </Alerta>
          ) : null}

          <Boton type="submit" anchoCompleto cargando={enviando}>
            Ingresar
          </Boton>
        </form>

        <div className="flex flex-wrap justify-between gap-3 text-sm">
          <Link
            to="/registro"
            className="font-medium text-emerald-800 hover:underline focus-visible:outline focus-visible:outline-2"
          >
            Crear una cuenta
          </Link>
          <Link
            to="/recuperar-contrasena"
            className="font-medium text-emerald-800 hover:underline focus-visible:outline focus-visible:outline-2"
          >
            Olvidé mi contraseña
          </Link>
        </div>
      </div>
    </section>
  );
}

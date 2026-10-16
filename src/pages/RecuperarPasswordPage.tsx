import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { aAppError } from "../lib/errors";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import { CampoTexto } from "../components/ui/Campo";

/**
 * REQ-6 · solicitud de restablecimiento de contraseña.
 *
 * La respuesta es la misma exista o no la cuenta, para no revelar qué
 * correos están registrados.
 */
export default function RecuperarPasswordPage() {
  const { solicitarRecuperacion } = useAuth();

  const [correo, setCorreo] = useState("");
  const [errorCampo, setErrorCampo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function alEnviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setErrorCampo(null);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim())) {
      setErrorCampo("Ingresa un correo válido, por ejemplo nombre@uc.cl.");
      return;
    }

    setEnviando(true);
    try {
      await solicitarRecuperacion(correo);
      setEnviado(true);
    } catch (e) {
      setError(aAppError(e, "solicitar la recuperación").message);
    } finally {
      setEnviando(false);
    }
  }

  if (enviado) {
    return (
      <section className="mx-auto max-w-md space-y-5">
        <h1 className="text-2xl font-bold text-slate-900">Revisa tu correo</h1>
        <Alerta tono="exito" titulo="Código enviado">
          <p>
            Si existe una cuenta asociada a <strong>{correo.trim()}</strong>, enviamos un
            código de 6 dígitos para crear una nueva contraseña. Caduca en una hora.
          </p>
        </Alerta>
        <p className="text-sm text-slate-700">
          <Link
            to={`/verificar?tipo=recuperacion&correo=${encodeURIComponent(correo.trim())}`}
            className="font-medium text-emerald-800 hover:underline"
          >
            Ingresar el código
          </Link>
        </p>
        <p className="text-sm text-slate-600">
          <Link to="/login" className="font-medium text-emerald-800 hover:underline">
            Volver al inicio de sesión
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold text-slate-900">Recuperar contraseña</h1>
      <p className="mt-2 text-sm text-slate-600">
        Te enviaremos un código al correo con el que creaste tu cuenta para que puedas
        definir una contraseña nueva.
      </p>

      <form
        onSubmit={alEnviar}
        noValidate
        className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-6"
      >
        <CampoTexto
          etiqueta="Correo"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={correo}
          onChange={(e) => setCorreo(e.target.value)}
          error={errorCampo}
          placeholder="nombre@uc.cl"
        />

        {error ? (
          <Alerta tono="error" titulo="No pudimos enviar el código">
            {error}
          </Alerta>
        ) : null}

        <Boton type="submit" anchoCompleto cargando={enviando}>
          Enviar código
        </Boton>

        <p className="text-center text-sm text-slate-600">
          <Link to="/login" className="font-medium text-emerald-800 hover:underline">
            Volver al inicio de sesión
          </Link>
        </p>
      </form>
    </section>
  );
}

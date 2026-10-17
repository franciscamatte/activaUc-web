import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { aAppError } from "../lib/errors";
import type { TipoVerificacion } from "../data/repository";
import {
  MENSAJE_CODIGO_INVALIDO,
  codigoTieneFormato,
  normalizarCodigo,
} from "../domain/codigoVerificacion";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import { CampoTexto } from "../components/ui/Campo";

/**
 * REQ-5, REQ-6 · verificación con un código de 6 dígitos.
 *
 * Existe porque el enlace del correo no es fiable con direcciones
 * institucionales. En `@uc.cl` se comprobó que el enlace de
 * confirmación se consumió veinte segundos después de enviarse, sin que
 * nadie iniciara sesión: lo abrió el escáner de enlaces de Microsoft
 * 365, y al ser de un solo uso la persona se queda fuera.
 *
 * Un código no tiene ese problema: visitarlo no lo gasta, porque no hay
 * nada que visitar.
 */
export default function VerificarCodigoPage() {
  const { verificarCodigo, reenviarConfirmacion } = useAuth();
  const navegar = useNavigate();
  const [parametros] = useSearchParams();

  const tipo: TipoVerificacion =
    parametros.get("tipo") === "recuperacion" ? "recuperacion" : "registro";

  const [correo, setCorreo] = useState(parametros.get("correo") ?? "");
  const [codigo, setCodigo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function alEnviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setAviso(null);

    const limpio = normalizarCodigo(codigo);
    if (!codigoTieneFormato(limpio)) {
      setError(MENSAJE_CODIGO_INVALIDO);
      return;
    }

    setEnviando(true);
    try {
      await verificarCodigo({ correo, codigo: limpio, tipo });
      // Confirmar el alta deja la sesión abierta; recuperar la deja
      // abierta sólo para definir la contraseña nueva.
      navegar(tipo === "registro" ? "/catalogo" : "/restablecer-contrasena", {
        replace: true,
      });
    } catch (e) {
      setError(aAppError(e, "verificar el código").message);
    } finally {
      setEnviando(false);
    }
  }

  async function alReenviar() {
    setError(null);
    setAviso(null);
    try {
      await reenviarConfirmacion(correo);
      setAviso("Te enviamos un código nuevo. El anterior deja de servir.");
    } catch (e) {
      setError(aAppError(e, "reenviar el código").message);
    }
  }

  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold text-slate-900">
        {tipo === "registro" ? "Confirma tu correo" : "Ingresa el código"}
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        Escribe el código que te enviamos
        {correo ? (
          <>
            {" "}a <strong>{correo}</strong>
          </>
        ) : null}
        . Caduca en una hora.
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
          placeholder="nombre@uc.cl"
        />

        <CampoTexto
          etiqueta="Código del correo"
          type="text"
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={14}
          required
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          placeholder="12345678"
          ayuda="Está en el cuerpo del correo, no hay enlace que abrir."
        />

        {error ? (
          <Alerta tono="error" titulo="No pudimos verificar el código">
            {error}
          </Alerta>
        ) : null}

        {aviso ? <Alerta tono="exito">{aviso}</Alerta> : null}

        <Boton type="submit" anchoCompleto cargando={enviando}>
          Verificar
        </Boton>

        {tipo === "registro" ? (
          <p className="text-center text-sm text-slate-600">
            ¿No te llegó?{" "}
            <button
              type="button"
              onClick={alReenviar}
              className="font-medium text-emerald-800 hover:underline"
            >
              Enviar otro código
            </button>
          </p>
        ) : null}

        <p className="text-center text-sm text-slate-600">
          <Link to="/login" className="font-medium text-emerald-800 hover:underline">
            Volver al inicio de sesión
          </Link>
        </p>
      </form>
    </section>
  );
}

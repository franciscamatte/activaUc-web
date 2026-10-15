import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { aAppError } from "../lib/errors";
import {
  leerResultadoEnlace,
  limpiarFragmento,
  mensajeEnlaceRecuperacion,
} from "../lib/authHash";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import { CampoTexto } from "../components/ui/Campo";
import { Cargando } from "../components/ui/Estados";

const LARGO_MINIMO = 8;

/**
 * REQ-6 · definición de la nueva contraseña.
 *
 * Supabase procesa el enlace del correo y deja una sesión de
 * recuperación activa (detectSessionInUrl). Esta pantalla sólo funciona
 * con esa sesión: si no existe, el enlace caducó o ya se usó.
 */
export default function RestablecerPasswordPage() {
  const { fase, definirNuevaContrasena, cerrarSesion } = useAuth();
  const navegar = useNavigate();

  const [contrasena, setContrasena] = useState("");
  const [repetida, setRepetida] = useState("");
  const [erroresCampo, setErroresCampo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Si el enlace trae un error (caducado, ya usado), Supabase lo deja en
  // el fragmento de la URL. Se lee una sola vez con un inicializador
  // perezoso, así el mensaje se deriva durante el render.
  const [resultadoEnlace] = useState(leerResultadoEnlace);
  const errorEnlace = mensajeEnlaceRecuperacion(resultadoEnlace);

  // El fragmento contiene el token de recuperación: se quita de la URL.
  useEffect(() => {
    limpiarFragmento();
  }, []);

  async function alEnviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);

    const errores: Record<string, string> = {};
    if (contrasena.length < LARGO_MINIMO) {
      errores.contrasena = `La contraseña debe tener al menos ${LARGO_MINIMO} caracteres.`;
    }
    if (repetida !== contrasena) {
      errores.repetida = "Las contraseñas no coinciden.";
    }
    setErroresCampo(errores);
    if (Object.keys(errores).length > 0) return;

    setEnviando(true);
    try {
      await definirNuevaContrasena(contrasena);
      // Se cierra la sesión de recuperación para que el usuario entre
      // con su contraseña nueva.
      await cerrarSesion();
      navegar("/login", { replace: true, state: { contrasenaActualizada: true } });
    } catch (e) {
      setError(aAppError(e, "actualizar la contraseña").message);
    } finally {
      setEnviando(false);
    }
  }

  if (fase === "cargando") {
    return <Cargando texto="Validando el enlace de recuperación…" />;
  }

  if (errorEnlace || fase === "anonimo") {
    return (
      <section className="mx-auto max-w-md space-y-5">
        <h1 className="text-2xl font-bold text-slate-900">Enlace no válido</h1>
        <Alerta tono="error" titulo="No pudimos validar el enlace">
          {errorEnlace ??
            "Este enlace de recuperación caducó o ya fue utilizado. Solicita uno nuevo para " +
            "continuar."}
        </Alerta>
        <Link
          to="/recuperar-contrasena"
          className="inline-flex rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          Solicitar un enlace nuevo
        </Link>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold text-slate-900">Nueva contraseña</h1>
      <p className="mt-2 text-sm text-slate-600">
        Define la contraseña con la que ingresarás a ActivaUC de aquí en adelante.
      </p>

      <form
        onSubmit={alEnviar}
        noValidate
        className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-6"
      >
        <CampoTexto
          etiqueta="Nueva contraseña"
          type="password"
          autoComplete="new-password"
          required
          minLength={LARGO_MINIMO}
          value={contrasena}
          onChange={(e) => setContrasena(e.target.value)}
          error={erroresCampo.contrasena}
          ayuda={`Mínimo ${LARGO_MINIMO} caracteres.`}
        />

        <CampoTexto
          etiqueta="Repite la nueva contraseña"
          type="password"
          autoComplete="new-password"
          required
          value={repetida}
          onChange={(e) => setRepetida(e.target.value)}
          error={erroresCampo.repetida}
        />

        {error ? (
          <Alerta tono="error" titulo="No pudimos actualizar tu contraseña">
            {error}
          </Alerta>
        ) : null}

        <Boton type="submit" anchoCompleto cargando={enviando}>
          Guardar contraseña
        </Boton>
      </form>
    </section>
  );
}

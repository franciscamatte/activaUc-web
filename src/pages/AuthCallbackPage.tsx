import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../state/authContext";
import {
  leerResultadoEnlace,
  limpiarFragmento,
  mensajeEnlaceConfirmacion,
} from "../lib/authHash";
import Alerta from "../components/ui/Alerta";
import { Cargando } from "../components/ui/Estados";

/**
 * Destino del enlace de confirmación de correo (REQ-1).
 *
 * El cliente de Supabase procesa el token del fragmento de la URL
 * (detectSessionInUrl) y deja la sesión activa. Aquí sólo se interpreta
 * el resultado y se redirige.
 *
 * El fragmento se lee una vez con un inicializador perezoso, de modo que
 * el mensaje se deriva durante el render y no hace falta fijar estado
 * dentro de un efecto.
 */
export default function AuthCallbackPage() {
  const { fase } = useAuth();
  const navegar = useNavigate();

  const [resultado] = useState(leerResultadoEnlace);
  const errorEnlace = mensajeEnlaceConfirmacion(resultado);

  // El fragmento lleva tokens: se quita de la URL y del historial.
  useEffect(() => {
    limpiarFragmento();
  }, []);

  // Una vez resuelta la sesión, se continúa a la aplicación.
  useEffect(() => {
    if (errorEnlace || fase === "cargando") return;

    const destino = fase === "autenticado"
      ? { ruta: "/catalogo", estado: undefined }
      // Sin sesión y sin error: la confirmación funcionó, pero el enlace
      // se abrió en otro navegador. Se envía a iniciar sesión.
      : { ruta: "/login", estado: { correoConfirmado: true } };

    const id = window.setTimeout(
      () => navegar(destino.ruta, { replace: true, state: destino.estado }),
      1500,
    );
    return () => window.clearTimeout(id);
  }, [fase, errorEnlace, navegar]);

  if (errorEnlace) {
    return (
      <section className="mx-auto max-w-md space-y-5">
        <h1 className="text-2xl font-bold text-slate-900">
          No pudimos confirmar tu cuenta
        </h1>
        <Alerta tono="error" titulo="Enlace no válido">
          {errorEnlace}
        </Alerta>
        <Link
          to="/login"
          className="inline-flex rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          Ir al inicio de sesión
        </Link>
      </section>
    );
  }

  if (fase === "cargando") {
    return <Cargando texto="Confirmando tu cuenta…" />;
  }

  return (
    <section className="mx-auto max-w-md space-y-5">
      <h1 className="text-2xl font-bold text-slate-900">Cuenta confirmada</h1>
      <Alerta tono="exito" titulo="¡Listo!">
        Tu correo quedó verificado. Te estamos llevando
        {fase === "autenticado" ? " al catálogo de recintos" : " al inicio de sesión"}…
      </Alerta>
    </section>
  );
}

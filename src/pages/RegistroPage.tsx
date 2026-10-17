import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { aAppError } from "../lib/errors";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";
import { CampoTexto } from "../components/ui/Campo";

const LARGO_MINIMO = 8;

/** REQ-1 · registro con nombre, correo único y contraseña de largo mínimo. */
export default function RegistroPage() {
  const { registrarse } = useAuth();
  const navegar = useNavigate();

  const [nombre, setNombre] = useState("");
  const [correo, setCorreo] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [repetida, setRepetida] = useState("");
  const [erroresCampo, setErroresCampo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  function validar(): boolean {
    const errores: Record<string, string> = {};

    if (nombre.trim().length < 2) {
      errores.nombre = "Ingresa tu nombre completo (al menos 2 caracteres).";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim())) {
      errores.correo = "Ingresa un correo válido, por ejemplo nombre@uc.cl.";
    }
    if (contrasena.length < LARGO_MINIMO) {
      errores.contrasena = `La contraseña debe tener al menos ${LARGO_MINIMO} caracteres.`;
    }
    if (repetida !== contrasena) {
      errores.repetida = "Las contraseñas no coinciden.";
    }

    setErroresCampo(errores);
    return Object.keys(errores).length === 0;
  }

  async function alEnviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    if (!validar()) return;

    setEnviando(true);
    try {
      const { requiereConfirmacion } = await registrarse({ nombre, correo, contrasena });

      if (requiereConfirmacion) {
        // Directo al campo del código: una pantalla intermedia con un
        // botón «ingresar el código» era un clic sin información nueva.
        navegar(
          `/verificar?tipo=registro&correo=${encodeURIComponent(correo.trim())}`,
          { replace: true },
        );
      } else {
        navegar("/catalogo", { replace: true });
      }
    } catch (e) {
      setError(aAppError(e, "crear la cuenta").message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold text-slate-900">Crear cuenta</h1>
      <p className="mt-2 text-sm text-slate-600">
        Con una cuenta puedes reservar bloques horarios en los recintos de Deportes UC.
      </p>

      <form
        onSubmit={alEnviar}
        noValidate
        className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-6"
      >
        <CampoTexto
          etiqueta="Nombre completo"
          name="name"
          autoComplete="name"
          required
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          error={erroresCampo.nombre}
          placeholder="Camila Rojas"
        />

        <CampoTexto
          etiqueta="Correo"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={correo}
          onChange={(e) => setCorreo(e.target.value)}
          error={erroresCampo.correo}
          ayuda="Te enviaremos un enlace para confirmar tu cuenta."
          placeholder="nombre@uc.cl"
        />

        <CampoTexto
          etiqueta="Contraseña"
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          minLength={LARGO_MINIMO}
          value={contrasena}
          onChange={(e) => setContrasena(e.target.value)}
          error={erroresCampo.contrasena}
          ayuda={`Mínimo ${LARGO_MINIMO} caracteres.`}
        />

        <CampoTexto
          etiqueta="Repite la contraseña"
          type="password"
          autoComplete="new-password"
          required
          value={repetida}
          onChange={(e) => setRepetida(e.target.value)}
          error={erroresCampo.repetida}
        />

        {error ? (
          <Alerta tono="error" titulo="No pudimos crear tu cuenta">
            {error}
          </Alerta>
        ) : null}

        <Boton type="submit" anchoCompleto cargando={enviando}>
          Crear cuenta
        </Boton>

        <p className="text-center text-sm text-slate-600">
          ¿Ya tienes cuenta?{" "}
          <Link to="/login" className="font-medium text-emerald-800 hover:underline">
            Inicia sesión
          </Link>
        </p>
      </form>
    </section>
  );
}

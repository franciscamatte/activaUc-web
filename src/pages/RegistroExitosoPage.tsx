import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { aAppError } from "../lib/errors";
import Alerta from "../components/ui/Alerta";
import Boton from "../components/ui/Boton";

/**
 * REQ-1 · pantalla posterior al registro, cuando la cuenta queda
 * pendiente de confirmación por correo.
 */
export default function RegistroExitosoPage() {
  const { reenviarConfirmacion } = useAuth();
  const ubicacion = useLocation();
  const { correo } = (ubicacion.state ?? {}) as { correo?: string };

  const [reenviando, setReenviando] = useState(false);
  const [reenviado, setReenviado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function alReenviar() {
    if (!correo) return;
    setReenviando(true);
    setError(null);
    try {
      await reenviarConfirmacion(correo);
      setReenviado(true);
    } catch (e) {
      setError(aAppError(e, "reenviar la confirmación").message);
    } finally {
      setReenviando(false);
    }
  }

  return (
    <section className="mx-auto max-w-lg space-y-5">
      <h1 className="text-2xl font-bold text-slate-900">Confirma tu correo</h1>

      <Alerta tono="exito" titulo="Creamos tu cuenta">
        <p>
          Enviamos un enlace de confirmación
          {correo ? (
            <>
              {" a "}
              <strong className="font-semibold">{correo}</strong>
            </>
          ) : (
            " a tu correo"
          )}
          . Ábrelo para activar tu cuenta y poder iniciar sesión.
        </p>
      </Alerta>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-700">
        <h2 className="font-semibold text-slate-900">¿No llegó el correo?</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>Revisa la carpeta de correo no deseado o promociones.</li>
          <li>Puede tardar algunos minutos en llegar.</li>
          <li>Verifica que el correo esté bien escrito.</li>
        </ul>

        {error ? (
          <Alerta tono="error" className="mt-4">
            {error}
          </Alerta>
        ) : null}

        {reenviado ? (
          <Alerta tono="exito" className="mt-4">
            Reenviamos el correo de confirmación.
          </Alerta>
        ) : correo ? (
          <Boton
            variante="secundario"
            className="mt-4"
            onClick={() => void alReenviar()}
            cargando={reenviando}
          >
            Reenviar correo de confirmación
          </Boton>
        ) : null}
      </div>

      <p className="text-sm text-slate-600">
        Una vez confirmado,{" "}
        <Link to="/login" className="font-medium text-emerald-800 hover:underline">
          inicia sesión
        </Link>
        .
      </p>
    </section>
  );
}

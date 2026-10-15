import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAppState } from "../state/AppProvider";

export default function LoginPage() {
  const { login, error } = useAppState();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("camila@uc.cl");
  const [password, setPassword] = useState("password123");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await login(email, password);
      const next = (location.state as { from?: string } | undefined)?.from ?? "/catalogo";
      navigate(next);
    } catch {
      return;
    }
  }

  return (
    <section className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6">
      <h1 className="text-2xl font-bold">Iniciar sesión</h1>
      <p className="mt-2 text-sm text-slate-600">Accede con correo y contraseña.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="grid gap-1 text-sm">
          Correo
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Contraseña
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          className="w-full rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-700"
        >
          Ingresar
        </button>
      </form>
      <div className="mt-4 flex justify-between text-sm">
        <Link to="/registro" className="text-emerald-700 hover:underline">
          Crear cuenta
        </Link>
        <Link to="/recuperar-contrasena" className="text-emerald-700 hover:underline">
          Recuperar contraseña
        </Link>
      </div>
    </section>
  );
}

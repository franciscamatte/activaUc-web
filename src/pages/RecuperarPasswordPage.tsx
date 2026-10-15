import { useState } from "react";
import type { FormEvent } from "react";
import { useAppState } from "../state/AppProvider";

export default function RecuperarPasswordPage() {
  const { recoverPassword, error } = useAppState();
  const [email, setEmail] = useState("");
  const [ok, setOk] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await recoverPassword(email);
      setOk(true);
    } catch {
      setOk(false);
    }
  }

  return (
    <section className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6">
      <h1 className="text-2xl font-bold">Recuperar contraseña</h1>
      <p className="mt-2 text-sm text-slate-600">Simulación de envío de enlace al correo registrado.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <input
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2"
          placeholder="correo@uc.cl"
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {ok ? <p className="text-sm text-emerald-700">Se envió el enlace de recuperación (demo).</p> : null}
        <button type="submit" className="w-full rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-700">Enviar enlace</button>
      </form>
    </section>
  );
}

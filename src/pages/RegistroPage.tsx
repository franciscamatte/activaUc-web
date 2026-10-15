import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAppState } from "../state/AppProvider";

export default function RegistroPage() {
  const { register, error } = useAppState();
  const navigate = useNavigate();
  const [nombre, setNombre] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await register(nombre, email, password);
      navigate("/catalogo");
    } catch {
      return;
    }
  }

  return (
    <section className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6">
      <h1 className="text-2xl font-bold">Registro</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="grid gap-1 text-sm">
          Nombre completo
          <input required value={nombre} onChange={(e) => setNombre(e.target.value)} className="rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm">
          Correo institucional
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm">
          Contraseña (mínimo 8 caracteres)
          <input required minLength={8} type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-md border border-slate-300 px-3 py-2" />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button type="submit" className="w-full rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-700">Crear cuenta</button>
      </form>
    </section>
  );
}

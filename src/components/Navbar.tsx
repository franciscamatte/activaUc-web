import { NavLink } from "react-router-dom";

function linkClass({ isActive }: { isActive: boolean }) {
  return isActive
    ? "font-semibold text-emerald-700"
    : "text-slate-600 hover:text-slate-900";
}

export default function Navbar() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <span className="text-lg font-bold text-emerald-700">ActivaUC</span>
        <div className="flex gap-6">
          <NavLink to="/recintos" className={linkClass}>
            Recintos
          </NavLink>
          <NavLink to="/mis-reservas" className={linkClass}>
            Mis reservas
          </NavLink>
        </div>
      </nav>
    </header>
  );
}
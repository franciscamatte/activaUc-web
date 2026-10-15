import { NavLink } from "react-router-dom";
import { useAppState } from "../state/AppProvider";

function linkStyle(active: boolean): string {
  return active
    ? "rounded-md bg-emerald-100 px-3 py-1 text-emerald-800"
    : "rounded-md px-3 py-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900";
}

export default function Navbar() {
  const { currentUser, logout, isMockMode } = useAppState();

  const links = [
    { to: "/", label: "Inicio", always: true },
    { to: "/catalogo", label: "Catálogo", always: true },
    { to: "/mis-reservas", label: "Mis reservas", always: !!currentUser },
    { to: "/datos-personales", label: "Datos personales", always: !!currentUser },
    {
      to: "/admin",
      label: "Administración",
      always: currentUser?.rol === "administrador",
    },
  ];

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <NavLink to="/" className="text-xl font-bold text-emerald-700">
            ActivaUC
          </NavLink>
          {isMockMode ? (
            <p className="text-xs text-amber-700">Modo demo local (sin backend)</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          {links.filter((l) => l.always).map((link) => (
            <NavLink key={link.to} to={link.to} className={({ isActive }) => linkStyle(isActive)}>
              {link.label}
            </NavLink>
          ))}
        </div>

        <div className="flex items-center gap-2 text-sm">
          {currentUser ? (
            <>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">
                {currentUser.nombre} · {currentUser.rol}
              </span>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-md bg-slate-900 px-3 py-1 text-white hover:bg-slate-700"
              >
                Cerrar sesión
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login" className={({ isActive }) => linkStyle(isActive)}>
                Ingresar
              </NavLink>
              <NavLink to="/registro" className={({ isActive }) => linkStyle(isActive)}>
                Registrarme
              </NavLink>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../state/authContext";
import Boton from "./ui/Boton";

/**
 * Barra de navegación global (requisito de interfaz 8.1).
 *
 * Está presente en todas las pantallas, muestra los accesos directos
 * disponibles según el rol y deja visible el estado de sesión.
 */
export default function Navbar() {
  const { perfil, esAdministrador, cerrarSesion, fase } = useAuth();
  const navegar = useNavigate();
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [cerrando, setCerrando] = useState(false);

  const enlaces = [
    { a: "/", texto: "Inicio", visible: true },
    { a: "/catalogo", texto: "Catálogo", visible: true },
    { a: "/mis-reservas", texto: "Mis reservas", visible: perfil !== null },
    { a: "/datos-personales", texto: "Datos personales", visible: perfil !== null },
    { a: "/admin", texto: "Administración", visible: esAdministrador },
  ].filter((e) => e.visible);

  const claseEnlace = (activo: boolean) =>
    [
      "rounded-lg px-3 py-2 text-sm font-medium transition",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700",
      activo
        ? "bg-emerald-50 text-emerald-900"
        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
    ].join(" ");

  async function alCerrarSesion() {
    setCerrando(true);
    try {
      await cerrarSesion();
      setMenuAbierto(false);
      navegar("/", { replace: true });
    } finally {
      setCerrando(false);
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
      <nav
        aria-label="Navegación principal"
        className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3"
      >
        <NavLink
          to="/"
          className="flex items-center gap-2 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-lg bg-emerald-700 text-sm font-bold text-white"
          >
            UC
          </span>
          <span className="text-lg font-bold tracking-tight text-emerald-900">
            ActivaUC
          </span>
        </NavLink>

        {/* Navegación en pantallas medianas y grandes */}
        <ul className="ml-2 hidden flex-1 items-center gap-1 md:flex">
          {enlaces.map((enlace) => (
            <li key={enlace.a}>
              <NavLink
                to={enlace.a}
                end={enlace.a === "/"}
                className={({ isActive }) => claseEnlace(isActive)}
              >
                {enlace.texto}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="ml-auto hidden items-center gap-3 md:flex">
          {fase === "cargando" ? (
            <span className="text-sm text-slate-500">Cargando sesión…</span>
          ) : perfil ? (
            <>
              <span className="text-right text-sm leading-tight">
                <span className="block font-medium text-slate-900">{perfil.nombre}</span>
                <span className="block text-xs text-slate-500">
                  {perfil.rol === "administrador" ? "Administradora/or de recintos" : "Sesión activa"}
                </span>
              </span>
              <Boton
                variante="secundario"
                tamano="pequeno"
                onClick={() => void alCerrarSesion()}
                cargando={cerrando}
              >
                Cerrar sesión
              </Boton>
            </>
          ) : (
            <>
              <NavLink to="/login" className={({ isActive }) => claseEnlace(isActive)}>
                Ingresar
              </NavLink>
              <NavLink
                to="/registro"
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              >
                Crear cuenta
              </NavLink>
            </>
          )}
        </div>

        {/* Botón de menú en móvil */}
        <button
          type="button"
          onClick={() => setMenuAbierto((v) => !v)}
          aria-expanded={menuAbierto}
          aria-controls="menu-movil"
          className="ml-auto rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 md:hidden"
        >
          {menuAbierto ? "Cerrar menú" : "Menú"}
        </button>
      </nav>

      {menuAbierto ? (
        <div id="menu-movil" className="border-t border-slate-200 bg-white md:hidden">
          <ul className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
            {enlaces.map((enlace) => (
              <li key={enlace.a}>
                <NavLink
                  to={enlace.a}
                  end={enlace.a === "/"}
                  onClick={() => setMenuAbierto(false)}
                  className={({ isActive }) => `block ${claseEnlace(isActive)}`}
                >
                  {enlace.texto}
                </NavLink>
              </li>
            ))}

            <li className="mt-2 border-t border-slate-200 pt-3">
              {perfil ? (
                <div className="space-y-2">
                  <p className="px-3 text-sm">
                    <span className="block font-medium text-slate-900">{perfil.nombre}</span>
                    <span className="block text-xs text-slate-500">
                      {perfil.rol === "administrador"
                        ? "Administradora/or de recintos"
                        : "Sesión activa"}
                    </span>
                  </p>
                  <Boton
                    variante="secundario"
                    anchoCompleto
                    onClick={() => void alCerrarSesion()}
                    cargando={cerrando}
                  >
                    Cerrar sesión
                  </Boton>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <NavLink
                    to="/login"
                    onClick={() => setMenuAbierto(false)}
                    className="rounded-lg border border-slate-300 px-4 py-2.5 text-center text-sm font-semibold text-slate-800"
                  >
                    Ingresar
                  </NavLink>
                  <NavLink
                    to="/registro"
                    onClick={() => setMenuAbierto(false)}
                    className="rounded-lg bg-emerald-700 px-4 py-2.5 text-center text-sm font-semibold text-white"
                  >
                    Crear cuenta
                  </NavLink>
                </div>
              )}
            </li>
          </ul>
        </div>
      ) : null}
    </header>
  );
}

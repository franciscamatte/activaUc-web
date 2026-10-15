import type { ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../state/authContext";
import { Cargando } from "./ui/Estados";

/**
 * Guardia de rutas por sesión y rol.
 *
 * Es una conveniencia de interfaz, no un control de seguridad: quien
 * manipule el enrutador del navegador no obtiene ningún dato, porque
 * RLS y las funciones del backend son las que autorizan cada operación.
 */
export default function ProtectedRoute({
  children,
  rol,
}: {
  children: ReactElement;
  rol?: "administrador";
}) {
  const { fase, perfil } = useAuth();
  const ubicacion = useLocation();

  if (fase === "cargando") {
    return <Cargando texto="Verificando tu sesión…" />;
  }

  if (!perfil) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ destino: ubicacion.pathname + ubicacion.search }}
      />
    );
  }

  if (rol === "administrador" && perfil.rol !== "administrador") {
    return <Navigate to="/catalogo" replace state={{ sinPermiso: true }} />;
  }

  return children;
}

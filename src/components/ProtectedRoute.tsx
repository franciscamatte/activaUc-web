import type { ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { Rol } from "../domain/types";
import { useAppState } from "../state/AppProvider";

export default function ProtectedRoute({
  children,
  role,
}: {
  children: ReactElement;
  role?: Rol;
}) {
  const { currentUser } = useAppState();
  const location = useLocation();

  if (!currentUser) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (role && currentUser.rol !== role) {
    return <Navigate to="/catalogo" replace />;
  }

  return children;
}

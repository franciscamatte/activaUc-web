import { Navigate, Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar";
import ProtectedRoute from "./components/ProtectedRoute";
import AdminPage from "./pages/AdminPage";
import CatalogoPage from "./pages/CatalogoPage";
import DatosPersonalesPage from "./pages/DatosPersonalesPage";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import MisReservasPage from "./pages/MisReservasPage";
import NotFoundPage from "./pages/NotFoundPage";
import RecuperarPasswordPage from "./pages/RecuperarPasswordPage";
import RegistroPage from "./pages/RegistroPage";
import { useAppState } from "./state/AppProvider";

export default function App() {
  const { loading } = useAppState();

  if (loading) {
    return <p className="p-8 text-center">Cargando plataforma...</p>;
  }

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/registro" element={<RegistroPage />} />
          <Route path="/recuperar-contrasena" element={<RecuperarPasswordPage />} />
          <Route path="/catalogo" element={<CatalogoPage />} />
          <Route
            path="/mis-reservas"
            element={
              <ProtectedRoute>
                <MisReservasPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/datos-personales"
            element={
              <ProtectedRoute>
                <DatosPersonalesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute role="administrador">
                <AdminPage />
              </ProtectedRoute>
            }
          />
          <Route path="/recintos" element={<Navigate to="/catalogo" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </>
  );
}

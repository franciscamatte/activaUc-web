import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar";
import ProtectedRoute from "./components/ProtectedRoute";
import { useAuth } from "./state/authContext";
import { useOnline } from "./state/useOnline";
import { esModoMock } from "./data";
import {
  AvisoModoDemo,
  AvisoSinConexion,
  Cargando,
  PantallaErrorConfiguracion,
} from "./components/ui/Estados";
import Alerta from "./components/ui/Alerta";
import VerificarCodigoPage from "./pages/VerificarCodigoPage";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import CatalogoPage from "./pages/CatalogoPage";
import DatosPersonalesPage from "./pages/DatosPersonalesPage";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import MisReservasPage from "./pages/MisReservasPage";
import NotFoundPage from "./pages/NotFoundPage";
import RecuperarPasswordPage from "./pages/RecuperarPasswordPage";
import RegistroExitosoPage from "./pages/RegistroExitosoPage";
import RegistroPage from "./pages/RegistroPage";
import RestablecerPasswordPage from "./pages/RestablecerPasswordPage";

/**
 * El panel de administración se carga de forma diferida: sólo lo usa el
 * personal a cargo de los recintos, así que no tiene sentido que su
 * código viaje en el paquete inicial de todas las personas.
 */
const AdminPage = lazy(() => import("./pages/AdminPage"));

export default function App() {
  const { fase, errorConfiguracion, sesionExpirada, descartarAvisoExpiracion, perfil } = useAuth();
  const enLinea = useOnline();

  // Sin configuración válida la aplicación no puede operar: se dice con
  // claridad en lugar de fallar más adelante con un error opaco.
  if (fase === "error_configuracion") {
    return (
      <PantallaErrorConfiguracion
        detalle={errorConfiguracion ?? "Falta configuración del entorno."}
      />
    );
  }

  return (
    <>
      {/* Salto de navegación para teclado y lectores de pantalla. */}
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-emerald-700 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Saltar al contenido principal
      </a>

      {esModoMock ? <AvisoModoDemo /> : null}
      {!enLinea ? <AvisoSinConexion /> : null}

      <Navbar />

      <main id="contenido" className="mx-auto max-w-6xl px-4 py-8">
        {/* Aviso de sesión expirada, visible en cualquier pantalla. */}
        {sesionExpirada && !perfil ? (
          <Alerta
            tono="aviso"
            titulo="Tu sesión expiró"
            className="mb-6"
            onCerrar={descartarAvisoExpiracion}
          >
            Por seguridad cerramos tu sesión tras un período de inactividad. Vuelve a
            iniciar sesión para continuar.
          </Alerta>
        ) : null}

        {fase === "cargando" ? (
          <Cargando texto="Cargando ActivaUC…" />
        ) : (
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/catalogo" element={<CatalogoPage />} />

            {/* Autenticación */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/registro" element={<RegistroPage />} />
            <Route path="/registro-exitoso" element={<RegistroExitosoPage />} />
            <Route path="/recuperar-contrasena" element={<RecuperarPasswordPage />} />
            <Route path="/restablecer-contrasena" element={<RestablecerPasswordPage />} />
            <Route path="/verificar" element={<VerificarCodigoPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />

            {/* Área autenticada */}
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

            {/* Administración */}
            <Route
              path="/admin"
              element={
                <ProtectedRoute rol="administrador">
                  <Suspense fallback={<Cargando texto="Cargando el panel de administración…" />}>
                    <AdminPage />
                  </Suspense>
                </ProtectedRoute>
              }
            />

            {/* Rutas antiguas, conservadas para no romper enlaces guardados */}
            <Route path="/recintos" element={<Navigate to="/catalogo" replace />} />
            <Route path="/calendar/callback" element={<Navigate to="/datos-personales" replace />} />

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        )}
      </main>

      <footer className="mt-16 border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-600">
          <p className="font-semibold text-slate-900">ActivaUC · Deportes UC</p>
          <p className="mt-1">
            Plataforma de reserva de espacios deportivos. Tus datos personales se tratan
            conforme a las políticas de protección de datos de la institución.
          </p>
        </div>
      </footer>
    </>
  );
}

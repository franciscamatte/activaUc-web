import { Navigate, Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar";
import MisReservasPage from "./pages/MisReservasPage";
import RecintosPage from "./pages/RecintosPage";

export default function App() {
  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/recintos" replace />} />
          <Route path="/recintos" element={<RecintosPage />} />
          <Route path="/mis-reservas" element={<MisReservasPage />} />
        </Routes>
      </main>
    </>
  );
}
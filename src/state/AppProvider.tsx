import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { activeRepository, isMockMode } from "../data";
import { computeReservationStatus } from "../data/mockRepository";
import type { AppSnapshot } from "../data/repository";
import type { Bloque, FiltrosCatalogo, Recinto, Reserva, Usuario } from "../domain/types";

type AppContextType = {
  loading: boolean;
  error: string;
  snapshot: AppSnapshot | null;
  isMockMode: boolean;
  currentUser: Usuario | null;
  recargar: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (nombre: string, email: string, password: string) => Promise<void>;
  recoverPassword: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (payload: Partial<Usuario>) => Promise<void>;
  bloquesFiltrados: (filtros: FiltrosCatalogo) => Promise<void>;
  reservar: (bloqueId: string) => Promise<void>;
  cancelarUsuario: (reservaId: string) => Promise<void>;
  cancelarAdmin: (reservaId: string) => Promise<void>;
  saveRecinto: (payload: Omit<Recinto, "id"> & { id?: string }) => Promise<void>;
  saveBloque: (payload: Omit<Bloque, "id"> & { id?: string }) => Promise<void>;
  filteredBlocks: AppSnapshot["bloques"];
};

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filteredBlocks, setFilteredBlocks] = useState<AppSnapshot["bloques"]>([]);

  const recargar = useCallback(async () => {
    const fresh = await activeRepository.getSnapshot();
    fresh.reservas = fresh.reservas.map((r) => computeReservationStatus(r));
    setSnapshot(fresh);
    setFilteredBlocks(fresh.bloques);
  }, []);

  const withHandling = useCallback(
    async (action: () => Promise<void>) => {
      setError("");
      try {
        await action();
        await recargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ocurrió un error inesperado.");
        throw e;
      }
    },
    [recargar],
  );

  useEffect(() => {
    async function boot() {
      try {
        await recargar();
      } finally {
        setLoading(false);
      }
    }
    void boot();
  }, [recargar]);

  const currentUser = useMemo(() => {
    if (!snapshot?.sesion) {
      return null;
    }
    return snapshot.usuarios.find((u) => u.id === snapshot.sesion?.usuarioId) ?? null;
  }, [snapshot]);

  const value: AppContextType = {
    loading,
    error,
    snapshot,
    isMockMode,
    currentUser,
    recargar,
    login: (email, password) => withHandling(() => activeRepository.login(email, password)),
    register: (nombre, email, password) =>
      withHandling(() => activeRepository.register(nombre, email, password)),
    recoverPassword: (email) => withHandling(() => activeRepository.recoverPassword(email)),
    logout: () => withHandling(() => activeRepository.logout()),
    updateProfile: (payload) => withHandling(() => activeRepository.saveProfile(payload)),
    bloquesFiltrados: async (filtros: FiltrosCatalogo) => {
      try {
        const data = await activeRepository.getBloquesFiltrados(filtros);
        setFilteredBlocks(data);
        setError("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "No fue posible filtrar bloques.");
      }
    },
    reservar: (bloqueId: string) => withHandling(() => activeRepository.reservar(bloqueId)),
    cancelarUsuario: (reservaId: string) =>
      withHandling(() => activeRepository.cancelarReservaComoUsuario(reservaId)),
    cancelarAdmin: (reservaId: string) =>
      withHandling(() => activeRepository.cancelarReservaComoAdmin(reservaId)),
    saveRecinto: (payload) => withHandling(() => activeRepository.saveRecinto(payload)),
    saveBloque: (payload) => withHandling(() => activeRepository.saveBloque(payload)),
    filteredBlocks,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useAppState debe usarse dentro de AppProvider.");
  }
  return ctx;
}

export function splitReservations(reservas: Reserva[]): {
  vigentes: Reserva[];
  pasadas: Reserva[];
} {
  return {
    vigentes: reservas.filter((r) => r.estado === "vigente"),
    pasadas: reservas.filter((r) => r.estado !== "vigente"),
  };
}

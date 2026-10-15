/**
 * Selección del repositorio activo.
 *
 * Supabase es el modo por defecto. El modo demostración sólo se usa si
 * VITE_DATA_MODE=mock de forma explícita y la compilación no es de
 * producción (ver src/lib/env.ts, que rechaza la combinación).
 */

import { config, configuracionValida, esModoMock } from "../lib/env";
import { getSupabase } from "../lib/supabase";
import { mockRepository } from "./mockRepository";
import type { ActivaRepository } from "./repository";
import { SupabaseRepository } from "./supabaseRepository";

let cache: ActivaRepository | null = null;

/**
 * Devuelve el repositorio activo. Lanza si la configuración es inválida,
 * de modo que la aplicación muestre una pantalla de error de
 * configuración en lugar de fallar a mitad de una operación.
 */
export function getRepository(): ActivaRepository {
  if (cache) return cache;

  if (esModoMock) {
    cache = mockRepository;
    return cache;
  }

  if (!configuracionValida) {
    const detalle = config.problemas
      .map((p) => `${p.variable}: ${p.mensaje}`)
      .join(" · ");
    throw new Error(`Configuración inválida. ${detalle}`);
  }

  cache = new SupabaseRepository(getSupabase());
  return cache;
}

export { esModoMock };
export type { ActivaRepository };

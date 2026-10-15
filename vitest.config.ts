import { defineConfig } from "vitest/config";

/**
 * Configuración de pruebas.
 *
 * Se usa el entorno de Node en lugar de uno con DOM porque las pruebas
 * cubren reglas de negocio, criptografía e integraciones (con fetch
 * simulado), no el renderizado de componentes. Eso mantiene la suite
 * rápida y sin dependencias de navegador simulado.
 *
 * Las pruebas de la base de datos y de concurrencia necesitan un
 * PostgreSQL real y viven aparte:
 *   npm run test:db
 *   npm run test:concurrency
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // Las Edge Functions importan sus módulos con extensión .ts
    // explícita, como exige Deno.
    includeSource: [],
    reporters: process.env.CI ? ["default"] : ["default"],
    clearMocks: true,
    restoreMocks: true,
  },
  define: {
    // Valores de entorno estables durante las pruebas, para que no
    // dependan de un archivo .env local.
    "import.meta.env.VITE_DATA_MODE": JSON.stringify("mock"),
    "import.meta.env.VITE_TIME_ZONE": JSON.stringify("America/Santiago"),
  },
});

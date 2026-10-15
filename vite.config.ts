import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * Configuración de compilación de ActivaUC.
 *
 * El paquete se divide a mano en tres grupos estables para que un cambio
 * en el código de la aplicación no invalide la caché de las librerías:
 *
 *   · react    → React, React DOM y el enrutador
 *   · supabase → cliente de Supabase (incluye Realtime)
 *   · index    → el código propio de ActivaUC
 *
 * El panel de administración, además, se carga de forma diferida (ver
 * src/App.tsx), porque sólo lo usa el personal de los recintos.
 */
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  build: {
    // Los mapas de origen facilitan depurar en producción sin exponer
    // nada sensible: el código del frontend es público de todos modos.
    sourcemap: true,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            {
              name: "supabase",
              test: /node_modules[\\/]@supabase[\\/]/,
            },
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
});

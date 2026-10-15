/**
 * Configuración de la aplicación, leída de variables de entorno.
 *
 * Reglas (requisito 10 del encargo):
 *   · Sólo variables VITE_* llegan al navegador. Ningún secreto de
 *     backend (service role, Google, Twilio, ENCRYPTION_KEY, CRON_SECRET)
 *     se referencia aquí ni puede acabar en el bundle.
 *   · Producción usa Supabase por defecto.
 *   · El modo mock existe sólo para desarrollo local y debe activarse de
 *     forma explícita; en una compilación de producción se rechaza, para
 *     que nunca se confunda una demo con el sistema real.
 */

export type DataMode = "supabase" | "mock";

export interface ProblemaConfiguracion {
  variable: string;
  mensaje: string;
}

export interface AppConfig {
  dataMode: DataMode;
  supabaseUrl: string;
  supabaseAnonKey: string;
  functionsUrl: string;
  appUrl: string;
  timeZone: string;
  esProduccion: boolean;
  problemas: ProblemaConfiguracion[];
}

function leer(nombre: string): string {
  const valor = import.meta.env[nombre as keyof ImportMetaEnv];
  return typeof valor === "string" ? valor.trim() : "";
}

/** Deriva la URL de las Edge Functions desde la URL del proyecto. */
function derivarFunctionsUrl(supabaseUrl: string, explicita: string): string {
  if (explicita) return explicita.replace(/\/$/, "");
  if (!supabaseUrl) return "";
  return `${supabaseUrl.replace(/\/$/, "")}/functions/v1`;
}

function construir(): AppConfig {
  const esProduccion = import.meta.env.PROD === true;
  const modoSolicitado = leer("VITE_DATA_MODE").toLowerCase();
  const supabaseUrl = leer("VITE_SUPABASE_URL").replace(/\/$/, "");
  const supabaseAnonKey = leer("VITE_SUPABASE_ANON_KEY");
  const problemas: ProblemaConfiguracion[] = [];

  // El modo por defecto es Supabase. "mock" sólo si se pide expresamente.
  let dataMode: DataMode = modoSolicitado === "mock" ? "mock" : "supabase";

  if (modoSolicitado && modoSolicitado !== "mock" && modoSolicitado !== "supabase") {
    problemas.push({
      variable: "VITE_DATA_MODE",
      mensaje: `Valor no reconocido: "${modoSolicitado}". Usa "supabase" o "mock".`,
    });
  }

  if (dataMode === "mock" && esProduccion) {
    // Una compilación de producción en modo mock sería una demo
    // disfrazada de sistema real. Se rechaza de forma explícita.
    problemas.push({
      variable: "VITE_DATA_MODE",
      mensaje:
        "El modo mock no está permitido en una compilación de producción. " +
        "Define VITE_DATA_MODE=supabase junto con VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.",
    });
    dataMode = "supabase";
  }

  if (dataMode === "supabase") {
    if (!supabaseUrl) {
      problemas.push({
        variable: "VITE_SUPABASE_URL",
        mensaje: "Falta la URL del proyecto de Supabase (https://TU-PROYECTO.supabase.co).",
      });
    } else if (!/^https?:\/\//.test(supabaseUrl)) {
      problemas.push({
        variable: "VITE_SUPABASE_URL",
        mensaje: "Debe ser una URL absoluta que comience con https://.",
      });
    }

    if (!supabaseAnonKey) {
      problemas.push({
        variable: "VITE_SUPABASE_ANON_KEY",
        mensaje: "Falta la clave pública (anon) del proyecto de Supabase.",
      });
    }
  }

  // Defensa contra un error de configuración con consecuencias graves:
  // pegar la service role key donde va la anon key la publicaría en el
  // bundle. La detectamos por el claim "role" del JWT.
  if (supabaseAnonKey && pareceServiceRole(supabaseAnonKey)) {
    problemas.push({
      variable: "VITE_SUPABASE_ANON_KEY",
      mensaje:
        "La clave entregada parece una service_role key. Esa clave NUNCA debe ir en el " +
        "frontend: usa la clave anon (pública) del proyecto.",
    });
  }

  // `window` no existe al ejecutar pruebas en Node ni en un posible
  // render en servidor, así que se consulta con cuidado.
  const origenActual = typeof window === "undefined" ? "" : window.location.origin;

  return {
    dataMode,
    supabaseUrl,
    supabaseAnonKey,
    functionsUrl: derivarFunctionsUrl(supabaseUrl, leer("VITE_SUPABASE_FUNCTIONS_URL")),
    appUrl: leer("VITE_APP_URL").replace(/\/$/, "") || origenActual,
    timeZone: leer("VITE_TIME_ZONE") || "America/Santiago",
    esProduccion,
    problemas,
  };
}

/** Detecta una clave de servicio pegada por error en la variable pública. */
export function pareceServiceRole(clave: string): boolean {
  const partes = clave.split(".");
  if (partes.length !== 3) return false;
  try {
    const base = partes[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base + "=".repeat((4 - (base.length % 4)) % 4));
    const payload = JSON.parse(json) as { role?: string };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

export const config: AppConfig = construir();

export const esModoMock = config.dataMode === "mock";
export const configuracionValida = config.problemas.length === 0;

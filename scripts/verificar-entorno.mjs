#!/usr/bin/env node
/**
 * ActivaUC · comprobación del entorno antes de compilar
 * ---------------------------------------------------------------------
 * Vite **incrusta** las variables VITE_* en el momento de compilar. Si
 * faltan, el build termina bien y produce un sitio que, al abrirlo,
 * dice «La aplicación no está configurada». Eso es correcto —mejor un
 * aviso honesto que datos de ejemplo disfrazados— pero es un fallo que
 * se descubre tarde: en el navegador, cuando ya está publicado.
 *
 * Pasó el 17/10/2026 en Netlify: el despliegue salió «correcto» dos
 * veces con las variables sin llegar al build. Esta comprobación mueve
 * el fallo al único sitio donde se nota a tiempo, el registro del build.
 *
 * Se ejecuta como parte de `npm run build`, así que vale igual en local
 * y en cualquier alojamiento que corra ese comando.
 *
 * Deliberadamente NO imprime ningún valor: sólo nombres y longitudes.
 */

import { readFileSync, existsSync } from "node:fs";

// Vite carga los .env él mismo, y este script corre antes. Se replica lo
// mínimo: el orden de precedencia de Vite para un build de producción.
function cargarEnv() {
  const valores = {};
  for (const archivo of [".env", ".env.production", ".env.local", ".env.production.local"]) {
    if (!existsSync(archivo)) continue;
    for (const linea of readFileSync(archivo, "utf8").split("\n")) {
      const limpia = linea.trim();
      if (!limpia || limpia.startsWith("#")) continue;
      const i = limpia.indexOf("=");
      if (i === -1) continue;
      const clave = limpia.slice(0, i).trim();
      let valor = limpia.slice(i + 1).trim();
      if (
        (valor.startsWith('"') && valor.endsWith('"')) ||
        (valor.startsWith("'") && valor.endsWith("'"))
      ) {
        valor = valor.slice(1, -1);
      }
      valores[clave] = valor;
    }
  }
  // El entorno del proceso gana: es lo que inyecta Netlify, Vercel o CI.
  return { ...valores, ...process.env };
}

const env = cargarEnv();
const leer = (nombre) => (env[nombre] ?? "").trim();

const problemas = [];

const url = leer("VITE_SUPABASE_URL");
const clave = leer("VITE_SUPABASE_ANON_KEY");
const modo = leer("VITE_DATA_MODE");

if (!url) {
  problemas.push("VITE_SUPABASE_URL está vacía o no existe.");
} else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(url)) {
  problemas.push(
    `VITE_SUPABASE_URL no parece la de un proyecto de Supabase: «${url}». ` +
      "Debe ser https://<ref>.supabase.co, sin barra final ni ruta.",
  );
}

if (!clave) {
  problemas.push("VITE_SUPABASE_ANON_KEY está vacía o no existe.");
} else if (clave.startsWith("eyJ")) {
  // Es un JWT: se comprueba que sea la anon y no la service_role, que
  // daría acceso total saltándose RLS a cualquiera que abra la página.
  try {
    const cuerpo = clave.split(".")[1];
    const datos = JSON.parse(
      Buffer.from(cuerpo.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    if (datos.role === "service_role") {
      problemas.push(
        "VITE_SUPABASE_ANON_KEY contiene una clave service_role. Esa clave " +
          "da acceso total saltándose RLS y quedaría DENTRO del archivo " +
          "compilado, legible por cualquiera. Usa la clave anon.",
      );
    } else if (datos.role !== "anon") {
      problemas.push(`La clave tiene rol «${datos.role}»; se esperaba «anon».`);
    }
  } catch {
    problemas.push("VITE_SUPABASE_ANON_KEY parece un JWT pero no se pudo decodificar.");
  }
} else if (!clave.startsWith("sb_publishable_")) {
  problemas.push(
    "VITE_SUPABASE_ANON_KEY no tiene la forma de una clave de Supabase " +
      "(ni JWT ni sb_publishable_…). Revisa que esté completa.",
  );
}

if (modo && modo !== "supabase" && modo !== "mock") {
  problemas.push(`VITE_DATA_MODE=«${modo}» no es válido. Usa «supabase» o «mock».`);
}
if (modo === "mock") {
  problemas.push(
    "VITE_DATA_MODE=mock en una compilación de producción. El resultado " +
      "sería una demostración con datos de ejemplo presentada como " +
      "sistema real, así que se rechaza.",
  );
}

if (problemas.length > 0) {
  console.error("");
  console.error("  ActivaUC · no se puede compilar con este entorno");
  console.error("  " + "-".repeat(58));
  for (const p of problemas) console.error("  · " + p);
  console.error("");
  console.error("  Vite incrusta las variables VITE_* al compilar. Si faltan, el");
  console.error("  sitio se publica y muestra «La aplicación no está configurada»,");
  console.error("  que es un fallo que se descubre ya desplegado. Mejor aquí.");
  console.error("");
  console.error("  En local:    completa .env (ver docs/ARRANQUE_LOCAL.md § 4)");
  console.error("  En Netlify:  Site configuration → Environment variables, y");
  console.error("               después Deploys → Trigger deploy. Comprueba que");
  console.error("               el alcance incluya «Builds» y el contexto");
  console.error("               «Production», o el build no las ve.");
  console.error("");
  process.exit(1);
}

console.log(
  `  entorno correcto · ${url} · clave anon de ${clave.length} caracteres`,
);

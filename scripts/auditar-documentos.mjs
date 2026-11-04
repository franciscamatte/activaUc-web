#!/usr/bin/env node
/**
 * ActivaUC · contraste entre la documentación y el repositorio
 * ---------------------------------------------------------------------
 * Las cifras de los documentos se desactualizan sin que nada falle:
 * nadie recuerda que al añadir una migración hay que corregir «ocho
 * migraciones» en tres sitios. Esto lo encuentra.
 *
 * Compara lo que los documentos afirman con lo que existe de verdad, y
 * comprueba además que las migraciones, las suites de prueba y los
 * scripts citados existan.
 *
 *   node scripts/auditar-documentos.mjs
 *
 * Sale con código 1 si hay descuadres, para poder encadenarlo.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const leer = (ruta) => readFileSync(ruta, "utf8");
const listar = (dir, filtro) =>
  existsSync(dir) ? readdirSync(dir).filter(filtro) : [];

const esSql = (n) => n.endsWith(".sql");
const esMd = (n) => n.endsWith(".md");
const esSh = (n) => n.endsWith(".sh");

const migraciones = listar("supabase/migrations", esSql);
// Las suites de prueba empiezan por un número; 00_ es el arranque, no
// una suite.
const suites = listar("supabase/tests", (n) => esSql(n) && !n.startsWith("00_"));
const docs = listar("docs", esMd);
const scripts = listar("scripts", esSh);
const funciones = listar("supabase/functions", (n) => n !== "_shared" && !n.includes("."));

const esquema = leer(join("supabase/migrations", migraciones[0]));
const contar = (texto, patron) => (texto.match(patron) ?? []).length;

// Las tablas y enumeraciones pueden venir de cualquier migración.
const todasLasMigraciones = migraciones.map((m) => leer(join("supabase/migrations", m))).join("\n");

const real = {
  migraciones: migraciones.length,
  suites: suites.length,
  documentos: docs.length,
  scripts: scripts.length,
  funciones: funciones.length,
  tablas: contar(todasLasMigraciones, /create table if not exists public\./g),
  enumeraciones: contar(esquema, /create type public\./g),
};

const textos = [
  ["README", leer("README.md")],
  ["INFORME", leer("docs/INFORME_ENTREGA.md")],
  ["PRUEBAS", leer("docs/PRUEBAS.md")],
  ["REQUISITOS", leer("docs/REQUISITOS_IMPLEMENTADOS.md")],
  ["BASE_DE_DATOS", leer("docs/BASE_DE_DATOS.md")],
];

const problemas = [];

/** Busca `patron` en los documentos y compara el número que captura. */
function comprobar(nombre, esperado, patron) {
  for (const [doc, texto] of textos) {
    for (const m of texto.matchAll(patron)) {
      const hallado = Number(m[1]);
      if (hallado !== esperado) {
        problemas.push(
          `${nombre}: real ${esperado}, pero ${doc} dice ${hallado} («${m[0].trim()}»)`,
        );
      }
    }
  }
}

comprobar("migraciones", real.migraciones, /(\d+) migraciones/g);
comprobar("suites SQL", real.suites, /(\d+) archivos? (?:de prueba|SQL)/g);
comprobar("tablas", real.tablas, /(?:Las |son )?(\d+) tablas/g);
comprobar("documentos", real.documentos, /(\d+) documentos/g);
comprobar("enumeraciones", real.enumeraciones, /(\d+) enumeraciones/g);

// Toda migración debe estar citada en el informe, y al revés.
const informe = leer("docs/INFORME_ENTREGA.md");
const citadas = new Set([...informe.matchAll(/`(\d{14}_[a-z_]+\.sql)`/g)].map((m) => m[1]));
for (const m of migraciones) {
  if (!citadas.has(m)) problemas.push(`migración sin citar en el informe: ${m}`);
}
for (const c of citadas) {
  if (!migraciones.includes(c)) problemas.push(`el informe cita una migración inexistente: ${c}`);
}

// Toda suite debe estar citada en PRUEBAS.md.
const pruebas = leer("docs/PRUEBAS.md");
for (const s of suites) {
  if (!pruebas.includes(`\`${s}\``)) problemas.push(`suite sin citar en PRUEBAS.md: ${s}`);
}

// Todo script citado debe existir.
const todosLosTextos = textos.map(([, t]) => t).join("\n");
for (const m of todosLosTextos.matchAll(/scripts\/([a-z0-9-]+\.(?:sh|mjs))/g)) {
  if (!existsSync(join("scripts", m[1]))) {
    problemas.push(`se cita un script que no existe: scripts/${m[1]}`);
  }
}

console.log("Estado real del repositorio:");
for (const [k, v] of Object.entries(real).sort()) {
  console.log(`  ${k.padEnd(16)} ${v}`);
}
console.log("");

if (problemas.length === 0) {
  console.log("Sin descuadres entre la documentación y el repositorio.");
} else {
  console.log("DESCUADRES:");
  for (const p of problemas) console.log(`  · ${p}`);
  process.exitCode = 1;
}

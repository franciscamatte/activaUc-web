#!/usr/bin/env node
// =====================================================================
// ActivaUC · pruebas de base de datos
// ---------------------------------------------------------------------
// Aplica el arranque local + todas las migraciones sobre una base de
// datos desechable y ejecuta los archivos de supabase/tests/.
//
// Cada archivo corre en su propia transacción, que se revierte al
// terminar, de modo que las pruebas no se contaminan entre sí.
//
// Las aserciones usan el ASSERT de PL/pgSQL: si una condición falla, la
// sentencia lanza error y este script lo reporta con el archivo y el
// mensaje exactos.
//
//   npm run test:db
//   ACTIVAUC_TEST_DB_URL=postgresql://... npm run test:db
// =====================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  archivosSql,
  DIR_PRUEBAS,
  prepararBaseDesechable,
  urlServidor,
  verificarServidor,
} from "./db-harness.mjs";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const verde = (s) => (COLOR ? `\u001b[32m${s}\u001b[0m` : s);
const rojo = (s) => (COLOR ? `\u001b[31m${s}\u001b[0m` : s);
const gris = (s) => (COLOR ? `\u001b[90m${s}\u001b[0m` : s);

async function main() {
  console.log("ActivaUC · pruebas de base de datos\n");

  const salud = await verificarServidor(urlServidor());
  if (!salud.ok) {
    console.error(rojo("✖ Base de datos no disponible\n"));
    console.error(salud.mensaje);
    process.exit(2);
  }
  console.log(gris(`  servidor: ${salud.version.split(",")[0]}`));

  console.log("\nPreparando base de datos desechable…");
  const base = await prepararBaseDesechable();
  console.log(gris(`  base: ${base.nombre}`));

  const archivos = (await archivosSql(DIR_PRUEBAS)).filter(
    (n) => !n.startsWith("00_"),
  );

  let fallos = 0;
  const avisos = [];

  console.log(`\nEjecutando ${archivos.length} archivos de prueba:\n`);

  for (const archivo of archivos) {
    const sql = await readFile(join(DIR_PRUEBAS, archivo), "utf8");
    const inicio = Date.now();

    // Capturamos los RAISE NOTICE para mostrar cada aserción superada.
    const notices = [];
    const onNotice = (msg) => {
      if (msg?.message) notices.push(msg.message);
    };
    base.client.on("notice", onNotice);

    try {
      await base.client.query("begin");
      await base.client.query(sql);
      await base.client.query("rollback");

      const ms = Date.now() - inicio;
      console.log(`${verde("✔")} ${archivo} ${gris(`(${ms} ms)`)}`);
      for (const n of notices) {
        if (n.startsWith("OK ·")) console.log(gris(`    ${n}`));
      }
    } catch (error) {
      await base.client.query("rollback").catch(() => {});
      fallos += 1;
      console.log(`${rojo("✖")} ${archivo}`);
      console.log(rojo(`    ${error.message}`));
      if (error.where) console.log(gris(`    en: ${error.where.split("\n")[0]}`));
      for (const n of notices) {
        if (n.startsWith("OK ·")) console.log(gris(`    (superado antes) ${n}`));
      }
    } finally {
      base.client.off("notice", onNotice);
    }
  }

  await base.limpiar();

  console.log("");
  if (avisos.length > 0) {
    for (const a of avisos) console.log(gris(`  aviso: ${a}`));
  }

  if (fallos > 0) {
    console.log(rojo(`✖ ${fallos} de ${archivos.length} archivos con fallos`));
    process.exit(1);
  }

  console.log(verde(`✔ ${archivos.length} archivos de prueba superados`));
}

main().catch((error) => {
  console.error(rojo(`\n✖ Error no controlado: ${error.message}`));
  if (error.cause?.message) console.error(gris(`  causa: ${error.cause.message}`));
  process.exit(1);
});

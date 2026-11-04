// =====================================================================
// Utilidades compartidas por scripts/db-test.mjs y
// scripts/concurrency-test.mjs.
//
// Preparan una base de datos desechable con el entorno equivalente a
// Supabase (esquema auth, roles anon/authenticated/service_role) y todas
// las migraciones aplicadas en orden.
// =====================================================================

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const AQUI = dirname(fileURLToPath(import.meta.url));
export const RAIZ = resolve(AQUI, "..");
export const DIR_MIGRACIONES = join(RAIZ, "supabase", "migrations");
export const DIR_PRUEBAS = join(RAIZ, "supabase", "tests");

/**
 * Cadena de conexión al servidor de PostgreSQL de pruebas.
 *
 *   · ACTIVAUC_TEST_DB_URL  → la que se use en CI o en WSL
 *   · por defecto, el puerto del `supabase start` local
 */
export function urlServidor() {
  return (
    process.env.ACTIVAUC_TEST_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
  );
}

export function urlConBase(url, nombreBase) {
  const u = new URL(url);
  u.pathname = `/${nombreBase}`;
  return u.toString();
}

export async function conectar(url) {
  const client = new Client({ connectionString: url, application_name: "activauc-tests" });
  // Sin este oyente, una conexión que el servidor corta —cosa que hace
  // la propia limpieza al borrar la base desechable— emite un 'error'
  // sin manejar y tumba el proceso con una traza de pg, ocultando el
  // fallo original. Aquí se recuerda y se sigue.
  client.on("error", (error) => {
    client.activaucErrorDeConexion = error;
  });
  await client.connect();
  return client;
}

/**
 * Cuántas conexiones nuevas admite el servidor ahora mismo.
 *
 * La prueba de concurrencia abre una conexión por solicitud simultánea,
 * así que el techo del servidor es un límite real: con
 * `max_connections` en 100 —el valor por omisión— no caben 100
 * solicitudes más la conexión de control. Saberlo antes permite decirlo
 * en lugar de fallar con un error de pg a media prueba.
 */
export async function conexionesDisponibles(url) {
  const client = await conectar(url);
  try {
    const { rows } = await client.query(
      `select current_setting('max_connections')::int as tope,
              (select count(*) from pg_stat_activity) as en_uso`,
    );
    // Se descuenta esta misma conexión y se deja un margen de 2 para no
    // apurar el último hueco del servidor.
    return Math.max(0, rows[0].tope - rows[0].en_uso - 2);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Comprueba que el servidor responde y da un mensaje claro si no. */
export async function verificarServidor(url) {
  let client;
  try {
    client = await conectar(url);
    const { rows } = await client.query("select version() as v");
    return { ok: true, version: rows[0].v };
  } catch (error) {
    return {
      ok: false,
      mensaje:
        `No se pudo conectar a PostgreSQL en ${new URL(url).host}.\n` +
        `  Detalle: ${error.message}\n\n` +
        `  Levanta la base de datos antes de ejecutar las pruebas:\n` +
        `    npm run db:start            (Supabase local, requiere Docker)\n` +
        `  o apunta a otro servidor:\n` +
        `    ACTIVAUC_TEST_DB_URL=postgresql://usuario:clave@host:puerto/postgres`,
    };
  } finally {
    await client?.end().catch(() => {});
  }
}

export async function archivosSql(directorio) {
  const entradas = await readdir(directorio);
  return entradas.filter((n) => n.endsWith(".sql")).sort();
}

/**
 * Crea una base de datos desechable, aplica el arranque local y todas
 * las migraciones. Devuelve la URL de esa base y una función de limpieza.
 */
export async function prepararBaseDesechable({ silencioso = false } = {}) {
  const urlBase = urlServidor();
  const nombre = `activauc_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  const admin = await conectar(urlBase);
  try {
    await admin.query(`create database ${nombre}`);
  } finally {
    await admin.end();
  }

  const url = urlConBase(urlBase, nombre);
  const client = await conectar(url);

  const log = (...args) => { if (!silencioso) console.log(...args); };

  try {
    // 1) Entorno equivalente a Supabase.
    const bootstrap = await readFile(join(DIR_PRUEBAS, "00_bootstrap_local.sql"), "utf8");
    await client.query(bootstrap);
    log("  · entorno local tipo Supabase preparado");

    // 2) Migraciones, en orden lexicográfico (igual que Supabase CLI).
    for (const archivo of await archivosSql(DIR_MIGRACIONES)) {
      const sql = await readFile(join(DIR_MIGRACIONES, archivo), "utf8");
      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`Migración ${archivo} falló: ${error.message}`, { cause: error });
      }
      log(`  · migración aplicada: ${archivo}`);
    }
  } catch (error) {
    await client.end().catch(() => {});
    await eliminarBase(urlBase, nombre).catch(() => {});
    throw error;
  }

  return {
    url,
    nombre,
    client,
    async limpiar() {
      await client.end().catch(() => {});
      await eliminarBase(urlBase, nombre).catch(() => {});
    },
  };
}

export async function eliminarBase(urlServidorBase, nombre) {
  const admin = await conectar(urlServidorBase);
  try {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`,
      [nombre],
    );
    await admin.query(`drop database if exists ${nombre}`);
  } finally {
    await admin.end();
  }
}

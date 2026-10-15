#!/usr/bin/env node
// =====================================================================
// ActivaUC · pruebas de concurrencia (REQ-16, requisito no funcional de
// elasticidad: 100 usuarios concurrentes sin sobrecupos).
// ---------------------------------------------------------------------
// Las pruebas de supabase/tests/ corren en una sola sesión, así que no
// pueden demostrar concurrencia real. Este script abre N conexiones
// independientes contra PostgreSQL y las libera a la vez sobre el mismo
// bloque horario, que es exactamente el escenario de riesgo.
//
// Escenarios:
//   1. Último cupo con 2 usuarios simultáneos
//   2. 100 solicitudes concurrentes sobre un bloque de capacidad 20
//   3. El mismo usuario intentando duplicar su reserva 10 veces a la vez
//   4. Cancelación y nueva reserva concurrente sobre el cupo liberado
//   5. Bloque agotado bajo carga
//   6. Reintento de una misma solicitud (idempotencia)
//
//   npm run test:concurrency
// =====================================================================

import {
  conectar,
  prepararBaseDesechable,
  urlServidor,
  verificarServidor,
} from "./db-harness.mjs";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const verde = (s) => (COLOR ? `\u001b[32m${s}\u001b[0m` : s);
const rojo = (s) => (COLOR ? `\u001b[31m${s}\u001b[0m` : s);
const gris = (s) => (COLOR ? `\u001b[90m${s}\u001b[0m` : s);

let fallos = 0;

function comprobar(condicion, mensaje) {
  if (condicion) {
    console.log(`  ${verde("✔")} ${mensaje}`);
  } else {
    fallos += 1;
    console.log(`  ${rojo("✖")} ${mensaje}`);
  }
}

/** Crea usuarios de prueba y devuelve sus ids. */
async function crearUsuarios(client, cantidad, prefijo) {
  const ids = [];
  for (let i = 0; i < cantidad; i += 1) {
    const { rows } = await client.query(
      "select test_helpers.create_user($1, $2) as id",
      [`${prefijo}${i}@uc.cl`, `Usuario ${prefijo}${i}`],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

async function crearBloque(client, { nombre, capacidad, enHoras = 6 }) {
  const { rows: fac } = await client.query(
    `insert into public.facilities (name, facility_type, description, operation_hours)
     values ($1, 'Concurrencia', 'Recinto para pruebas de carga', '08:00 a 22:00')
     returning id`,
    [nombre],
  );
  const { rows: blk } = await client.query(
    `insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
     values ($1, now() + ($2 || ' hours')::interval, now() + (($2::int + 1) || ' hours')::interval, $3)
     returning id`,
    [fac[0].id, String(enHoras), capacidad],
  );
  return { facilityId: fac[0].id, blockId: blk[0].id };
}

/**
 * Ejecuta una operación con la identidad de un usuario.
 *
 * Los claims del JWT se fijan con set_config(..., is_local => true), que
 * es exactamente lo que hace PostgREST en Supabase: valen sólo dentro de
 * la transacción de la petición. Por eso cada operación va envuelta en
 * su propio BEGIN/COMMIT, igual que una llamada RPC real.
 */
async function comoUsuario(client, userId, operacion) {
  await client.query("begin");
  try {
    await client.query("select test_helpers.login_as($1)", [userId]);
    const resultado = await operacion();
    await client.query("commit");
    return resultado;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/**
 * Abre una conexión por solicitud y dispara create_reservation_strict en
 * paralelo. El rate limit del backend es de 20 intentos por minuto y
 * usuario, así que cada conexión usa un usuario distinto salvo en el
 * escenario de duplicados, donde eso es justamente lo que se prueba.
 */
async function reservarEnParalelo(url, pares) {
  const conexiones = await Promise.all(pares.map(() => conectar(url)));

  try {
    // Barrera: todas las conexiones abren su transacción y fijan su
    // identidad, y luego esperan la misma promesa. Al abrirla, las
    // solicitudes compiten por el bloqueo de fila del bloque a la vez.
    let abrirPuerta;
    const puerta = new Promise((resolve) => { abrirPuerta = resolve; });

    const trabajos = conexiones.map(async (client, i) => {
      const { userId, blockId } = pares[i];
      await client.query("begin");
      await client.query("select test_helpers.login_as($1)", [userId]);
      await puerta;
      try {
        const { rows } = await client.query(
          "select public.create_reservation_strict($1) as r",
          [blockId],
        );
        await client.query("commit");
        return rows[0].r;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        return { ok: false, error: "excepcion", mensaje: error.message };
      }
    });

    // Pequeña espera para que todas lleguen al await de la barrera.
    await new Promise((r) => setTimeout(r, 150));
    abrirPuerta();

    return await Promise.all(trabajos);
  } finally {
    await Promise.all(conexiones.map((c) => c.end().catch(() => {})));
  }
}

async function contarVigentes(client, blockId) {
  const { rows } = await client.query(
    "select count(*)::int as n from public.reservations where block_id = $1 and status = 'vigente'",
    [blockId],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------
// Escenario 1 · último cupo con dos usuarios simultáneos
// ---------------------------------------------------------------------
async function escenarioUltimoCupo(base) {
  console.log("\n1) Último cupo con 2 usuarios simultáneos (capacidad 1)");

  const { blockId } = await crearBloque(base.client, { nombre: "Conc 1", capacidad: 1 });
  const usuarios = await crearUsuarios(base.client, 2, "c1u");

  const resultados = await reservarEnParalelo(
    base.url,
    usuarios.map((userId) => ({ userId, blockId })),
  );

  const exitos = resultados.filter((r) => r.ok === true).length;
  const sinCupos = resultados.filter((r) => r.error === "sin_cupos").length;
  const vigentes = await contarVigentes(base.client, blockId);

  comprobar(exitos === 1, `exactamente 1 reserva creada (obtenido: ${exitos})`);
  comprobar(sinCupos === 1, `el otro recibe "sin_cupos" (obtenido: ${sinCupos})`);
  comprobar(vigentes === 1, `reservas vigentes = 1, capacidad = 1 (obtenido: ${vigentes})`);
}

// ---------------------------------------------------------------------
// Escenario 2 · 100 solicitudes concurrentes
// ---------------------------------------------------------------------
async function escenarioCien(base) {
  const CAPACIDAD = 20;
  const USUARIOS = 100;
  console.log(`\n2) ${USUARIOS} solicitudes concurrentes sobre capacidad ${CAPACIDAD}`);

  const { blockId } = await crearBloque(base.client, {
    nombre: "Conc 2",
    capacidad: CAPACIDAD,
    enHoras: 7,
  });
  const usuarios = await crearUsuarios(base.client, USUARIOS, "c2u");

  const inicio = Date.now();
  const resultados = await reservarEnParalelo(
    base.url,
    usuarios.map((userId) => ({ userId, blockId })),
  );
  const ms = Date.now() - inicio;

  const exitos = resultados.filter((r) => r.ok === true).length;
  const sinCupos = resultados.filter((r) => r.error === "sin_cupos").length;
  const excepciones = resultados.filter((r) => r.error === "excepcion");
  const vigentes = await contarVigentes(base.client, blockId);

  const { rows: dup } = await base.client.query(
    `select user_id, count(*) as n
     from public.reservations
     where block_id = $1 and status = 'vigente'
     group by user_id having count(*) > 1`,
    [blockId],
  );

  console.log(gris(`  ${USUARIOS} solicitudes en ${ms} ms`));
  comprobar(vigentes === CAPACIDAD, `reservas vigentes = ${CAPACIDAD} (obtenido: ${vigentes})`);
  comprobar(vigentes <= CAPACIDAD, "cero sobrecupos");
  comprobar(exitos === CAPACIDAD, `${CAPACIDAD} solicitudes exitosas (obtenido: ${exitos})`);
  comprobar(
    sinCupos === USUARIOS - CAPACIDAD,
    `${USUARIOS - CAPACIDAD} rechazos por "sin_cupos" (obtenido: ${sinCupos})`,
  );
  comprobar(dup.length === 0, `cero usuarios con reserva duplicada (obtenido: ${dup.length})`);
  comprobar(
    excepciones.length === 0,
    `cero errores inesperados (obtenido: ${excepciones.length}${
      excepciones.length ? ` · ej.: ${excepciones[0].mensaje}` : ""
    })`,
  );

  // Auditoría consistente con las reservas creadas.
  const { rows: audit } = await base.client.query(
    `select count(*)::int as n from public.reservation_audit_log a
     join public.reservations r on r.id = a.reservation_id
     where r.block_id = $1 and a.action = 'reserva_creada'`,
    [blockId],
  );
  comprobar(audit[0].n === CAPACIDAD, `${CAPACIDAD} registros de auditoría (obtenido: ${audit[0].n})`);
}

// ---------------------------------------------------------------------
// Escenario 3 · el mismo usuario intentando duplicar en paralelo
// ---------------------------------------------------------------------
async function escenarioDuplicado(base) {
  const INTENTOS = 10;
  console.log(`\n3) El mismo usuario lanzando ${INTENTOS} solicitudes simultáneas`);

  const { blockId } = await crearBloque(base.client, {
    nombre: "Conc 3",
    capacidad: 50,
    enHoras: 8,
  });
  const [userId] = await crearUsuarios(base.client, 1, "c3u");

  const resultados = await reservarEnParalelo(
    base.url,
    Array.from({ length: INTENTOS }, () => ({ userId, blockId })),
  );

  const creadas = resultados.filter((r) => r.ok === true && r.duplicada === false).length;
  const duplicadas = resultados.filter((r) => r.duplicada === true).length;
  const vigentes = await contarVigentes(base.client, blockId);

  comprobar(vigentes === 1, `una sola reserva vigente (obtenido: ${vigentes})`);
  comprobar(creadas === 1, `una sola creación efectiva (obtenido: ${creadas})`);
  comprobar(
    duplicadas === INTENTOS - 1,
    `${INTENTOS - 1} respuestas marcadas como duplicadas (obtenido: ${duplicadas})`,
  );

  // Y un solo trabajo de notificación/calendario por reserva.
  const { rows } = await base.client.query(
    `select count(*)::int as n from public.calendar_sync_jobs j
     join public.reservations r on r.id = j.reservation_id
     where r.block_id = $1`,
    [blockId],
  );
  comprobar(rows[0].n === 0, "sin trabajos de Calendar (el usuario no tiene conexión)");
}

// ---------------------------------------------------------------------
// Escenario 4 · cancelación y carrera por el cupo liberado
// ---------------------------------------------------------------------
async function escenarioCupoLiberado(base) {
  console.log("\n4) Carrera por el cupo liberado tras una cancelación");

  const { blockId } = await crearBloque(base.client, {
    nombre: "Conc 4",
    capacidad: 1,
    enHoras: 9,
  });
  const [titular, ...aspirantes] = await crearUsuarios(base.client, 11, "c4u");

  // El titular toma el único cupo.
  const [primera] = await reservarEnParalelo(base.url, [{ userId: titular, blockId }]);
  comprobar(primera.ok === true, "el titular toma el único cupo");

  // Lo cancela.
  const cancelacion = await comoUsuario(base.client, titular, async () => {
    const { rows } = await base.client.query(
      "select public.cancel_reservation($1) as r",
      [primera.reservation_id],
    );
    return rows[0].r;
  });
  comprobar(cancelacion.ok === true, "el titular cancela su reserva");

  // 10 aspirantes compiten por el cupo liberado.
  const resultados = await reservarEnParalelo(
    base.url,
    aspirantes.map((userId) => ({ userId, blockId })),
  );

  const exitos = resultados.filter((r) => r.ok === true).length;
  const vigentes = await contarVigentes(base.client, blockId);

  comprobar(exitos === 1, `exactamente 1 aspirante obtiene el cupo (obtenido: ${exitos})`);
  comprobar(vigentes === 1, `reservas vigentes = 1 (obtenido: ${vigentes})`);

  const { rows: total } = await base.client.query(
    "select count(*)::int as n from public.reservations where block_id = $1",
    [blockId],
  );
  comprobar(total[0].n === 2, `2 filas en total: 1 cancelada + 1 vigente (obtenido: ${total[0].n})`);
}

// ---------------------------------------------------------------------
// Escenario 5 · bloque ya agotado bajo carga
// ---------------------------------------------------------------------
async function escenarioAgotado(base) {
  console.log("\n5) 30 solicitudes sobre un bloque ya agotado");

  const { blockId } = await crearBloque(base.client, {
    nombre: "Conc 5",
    capacidad: 2,
    enHoras: 10,
  });
  const ocupantes = await crearUsuarios(base.client, 2, "c5ocu");
  const tardios = await crearUsuarios(base.client, 30, "c5tar");

  await reservarEnParalelo(base.url, ocupantes.map((userId) => ({ userId, blockId })));
  const vigentesAntes = await contarVigentes(base.client, blockId);
  comprobar(vigentesAntes === 2, "el bloque queda agotado");

  const resultados = await reservarEnParalelo(
    base.url,
    tardios.map((userId) => ({ userId, blockId })),
  );

  const exitos = resultados.filter((r) => r.ok === true).length;
  const sinCupos = resultados.filter((r) => r.error === "sin_cupos").length;
  const vigentes = await contarVigentes(base.client, blockId);

  comprobar(exitos === 0, `ninguna solicitud tardía tiene éxito (obtenido: ${exitos})`);
  comprobar(sinCupos === 30, `las 30 reciben "sin_cupos" (obtenido: ${sinCupos})`);
  comprobar(vigentes === 2, `reservas vigentes siguen en 2 (obtenido: ${vigentes})`);

  // Todas deben traer el mensaje en español, no una excepción cruda.
  const conMensaje = resultados.filter(
    (r) => typeof r.mensaje === "string" && r.mensaje.includes("cupos"),
  ).length;
  comprobar(conMensaje === 30, `las 30 devuelven un mensaje legible (obtenido: ${conMensaje})`);
}

// ---------------------------------------------------------------------
// Escenario 6 · reintento secuencial de la misma solicitud
// ---------------------------------------------------------------------
async function escenarioReintento(base) {
  console.log("\n6) Reintento de una misma solicitud (idempotencia)");

  const { blockId } = await crearBloque(base.client, {
    nombre: "Conc 6",
    capacidad: 5,
    enHoras: 11,
  });
  const [userId] = await crearUsuarios(base.client, 1, "c6u");

  // Con conexión de Calendar y consentimiento, para verificar que los
  // reintentos tampoco duplican trabajos de integración.
  await base.client.query(
    `insert into public.calendar_connections
       (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
     values ($1, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour')`,
    [userId],
  );
  await comoUsuario(base.client, userId, () =>
    base.client.query("select public.set_whatsapp_consent('+56912121212', true)"));

  const client = await conectar(base.url);
  try {
    // Cinco reintentos secuenciales de la MISMA solicitud, cada uno en su
    // propia transacción, como lo haría un cliente que reintenta.
    const respuestas = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await comoUsuario(client, userId, async () => {
        const { rows } = await client.query(
          "select public.create_reservation_strict($1, $2) as r",
          [blockId, "solicitud-fija-001"],
        );
        return rows[0].r;
      });
      respuestas.push(r);
    }

    const idsReserva = new Set(respuestas.map((r) => r.reservation_id));
    comprobar(respuestas.every((r) => r.ok === true), "los 5 reintentos responden ok");
    comprobar(idsReserva.size === 1, `siempre la misma reserva (ids distintos: ${idsReserva.size})`);
    comprobar(
      respuestas.slice(1).every((r) => r.duplicada === true),
      "los reintentos se marcan como duplicados",
    );

    const vigentes = await contarVigentes(base.client, blockId);
    comprobar(vigentes === 1, `una sola reserva vigente (obtenido: ${vigentes})`);

    const { rows: jobs } = await base.client.query(
      `select
         (select count(*)::int from public.calendar_sync_jobs where reservation_id = $1) as cal,
         (select count(*)::int from public.notification_jobs where reservation_id = $1) as notif`,
      [[...idsReserva][0]],
    );
    comprobar(jobs[0].cal === 1, `un solo trabajo de Calendar (obtenido: ${jobs[0].cal})`);
    comprobar(
      jobs[0].notif === 2,
      `dos notificaciones: confirmación + recordatorio (obtenido: ${jobs[0].notif})`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  console.log("ActivaUC · pruebas de concurrencia de reservas\n");

  const salud = await verificarServidor(urlServidor());
  if (!salud.ok) {
    console.error(rojo("✖ Base de datos no disponible\n"));
    console.error(salud.mensaje);
    process.exit(2);
  }
  console.log(gris(`  servidor: ${salud.version.split(",")[0]}`));

  console.log("\nPreparando base de datos desechable…");
  const base = await prepararBaseDesechable({ silencioso: true });
  console.log(gris(`  base: ${base.nombre}`));

  try {
    await escenarioUltimoCupo(base);
    await escenarioCien(base);
    await escenarioDuplicado(base);
    await escenarioCupoLiberado(base);
    await escenarioAgotado(base);
    await escenarioReintento(base);
  } finally {
    await base.limpiar();
  }

  console.log("");
  if (fallos > 0) {
    console.log(rojo(`✖ ${fallos} comprobaciones fallidas`));
    process.exit(1);
  }
  console.log(verde("✔ Todas las comprobaciones de concurrencia superadas: cero sobrecupos, cero duplicados"));
}

main().catch((error) => {
  console.error(rojo(`\n✖ Error no controlado: ${error.message}`));
  if (error.cause?.message) console.error(gris(`  causa: ${error.cause.message}`));
  process.exit(1);
});

/**
 * REQ-29 · el administrador general crea la cuenta de un administrador
 * de recintos y le asigna sus recintos.
 *
 * El documento de requerimientos encarga al administrador general
 * «crear las cuentas de los administradores de recintos y asignarles los
 * recintos a su cargo». Conceder el rol a una cuenta que ya existe se
 * hace con `admin_general_asignar_administrador` desde el navegador;
 * crear la cuenta no se puede, porque exige la clave de servicio. Eso es
 * lo que añade esta función.
 *
 * Qué hace, en orden:
 *
 *   1. Exige sesión y comprueba, **contra la base**, que quien llama es
 *      administrador general. No se confía en nada que venga del cuerpo
 *      de la solicitud.
 *   2. Intenta la asignación con el JWT de quien llama, de modo que la
 *      autorización siga viviendo en la función de PostgreSQL y no se
 *      duplique aquí.
 *   3. Sólo si esa función responde `sin_cuenta`, crea la cuenta con la
 *      clave de servicio y repite la asignación.
 *   4. Avisa a la persona por correo de que tiene que definir su
 *      contraseña.
 *
 * Ninguna contraseña viaja: la cuenta se crea **sin** contraseña y con
 * el correo ya confirmado, así que la persona la define ella misma por
 * «Olvidé mi contraseña», que es el mismo camino que ya existe. Si se
 * generara una contraseña aquí habría que entregarla por algún canal, y
 * ese canal sería el punto débil de todo el sistema de roles.
 *
 * Si el correo de aviso no se puede enviar, la respuesta lo dice: la
 * cuenta queda creada y el panel informa de que hay que avisar a mano.
 * Decir que se envió un correo que no salió sería peor que no enviarlo.
 */

import { BrevoEmailError, sendBrevoEmail } from "../_shared/brevoEmail.ts";
import { optionalEnv } from "../_shared/env.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { adminClient, requireUser, userClient } from "../_shared/supabase.ts";
import { createLogger, safeErrorMessage } from "../_shared/log.ts";

const log = createLogger("crear-administrador");

/** Mismo patrón que valida el formulario, para fallar antes de escribir. */
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tope por operación: un formulario no asigna cien recintos. */
const MAX_RECINTOS = 50;

interface Cuerpo {
  correo?: unknown;
  nombre?: unknown;
  recintoIds?: unknown;
}

interface Respuesta {
  ok: boolean;
  mensaje: string;
  cuentaCreada: boolean;
  correoEnviado: boolean;
  /** Por qué no salió el correo, cuando no salió. */
  motivoCorreo?: string;
}

function escapar(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cuerpoDelAviso(nombre: string, url: string, correo: string): string {
  const n = escapar(nombre);
  const c = escapar(correo);
  const u = escapar(url);
  return [
    "<!doctype html>",
    '<html lang="es"><body style="font-family:system-ui,sans-serif;color:#0f172a;line-height:1.55">',
    '<h1 style="font-size:20px;margin:0 0 12px">Tienes una cuenta de administración en ActivaUC</h1>',
    `<p>Hola ${n}:</p>`,
    "<p>Se creó una cuenta de <strong>administradora o administrador de recintos</strong> " +
    `a nombre de <strong>${c}</strong> en ActivaUC, la plataforma de reserva de espacios ` +
    "deportivos.</p>",
    "<p>La cuenta todavía no tiene contraseña. Para definirla, entra a " +
    `<a href="${u}/recuperar-contrasena">${u}/recuperar-contrasena</a>, escribe este mismo ` +
    "correo y sigue los pasos: te llegará un código y con él eliges tu contraseña.</p>",
    "<p>Después de eso verás el <strong>panel de administración</strong> con los recintos a " +
    "tu cargo.</p>",
    '<p style="color:#475569;font-size:13px">Si no esperabas este mensaje, puedes ignorarlo: ' +
    "sin definir una contraseña la cuenta no se puede usar.</p>",
    "</body></html>",
  ].join("\n");
}

Deno.serve(async (request) => {
  const pre = preflight(request);
  if (pre) return pre;

  if (request.method !== "POST") {
    return fail(request, "metodo_no_permitido", "Usa POST para crear la cuenta.", 405);
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const user = await requireUser(request);
  if (!user) {
    return fail(request, "no_autenticado", "Debes iniciar sesión.", 401);
  }

  const comoUsuario = userClient(authorization);

  // La comprobación del rol se hace contra la base, no contra el JWT:
  // un rol retirado hace un minuto tiene que surtir efecto ya.
  const { data: rol, error: errorRol } = await comoUsuario.rpc("current_user_role");
  if (errorRol) {
    log.error("No se pudo leer el rol", { error: safeErrorMessage(errorRol) });
    return fail(request, "error_interno", "No pudimos verificar tus permisos.", 500);
  }
  if (rol !== "administrador_general") {
    return fail(
      request,
      "no_autorizado",
      "Sólo el administrador general puede crear cuentas de administrador.",
      403,
    );
  }

  let cuerpo: Cuerpo;
  try {
    cuerpo = await request.json() as Cuerpo;
  } catch {
    return fail(request, "cuerpo_invalido", "El cuerpo de la solicitud no es JSON válido.");
  }

  const correo = typeof cuerpo.correo === "string" ? cuerpo.correo.trim().toLowerCase() : "";
  if (!CORREO.test(correo) || correo.length > 254) {
    return fail(request, "correo_invalido", "Ingresa un correo válido.");
  }

  const nombre = typeof cuerpo.nombre === "string" ? cuerpo.nombre.trim().slice(0, 120) : "";
  if (nombre.length < 2) {
    return fail(
      request,
      "nombre_invalido",
      "Indica el nombre de la persona (al menos 2 caracteres).",
    );
  }

  const recintoIds = Array.isArray(cuerpo.recintoIds)
    ? cuerpo.recintoIds.filter((r): r is string => typeof r === "string" && UUID.test(r))
    : [];
  if (Array.isArray(cuerpo.recintoIds) && recintoIds.length !== cuerpo.recintoIds.length) {
    return fail(request, "recinto_invalido", "Hay identificadores de recinto mal formados.");
  }
  if (recintoIds.length > MAX_RECINTOS) {
    return fail(
      request,
      "demasiados_recintos",
      `No se pueden asignar más de ${MAX_RECINTOS} recintos en una operación.`,
    );
  }

  const admin = adminClient();

  // Crear cuentas es una operación de personal, no de uso diario: 10 por
  // hora sobran y acotan el daño de una sesión robada.
  const { data: permitido, error: errorLimite } = await admin.rpc("consume_rate_limit", {
    _bucket: "crear_admin",
    _subject: user.id,
    _limit: 10,
    _window: "01:00:00",
  });
  if (errorLimite) {
    log.error("Falló el control de frecuencia", { error: safeErrorMessage(errorLimite) });
    return fail(request, "error_interno", "No pudimos procesar la solicitud.", 500);
  }
  if (permitido === false) {
    return fail(
      request,
      "limite_solicitudes",
      "Demasiadas cuentas creadas en poco tiempo. Inténtalo más tarde.",
      429,
    );
  }

  /** Asigna el rol con el JWT de quien llama: la regla vive en la base. */
  async function asignar(): Promise<{ ok: boolean; codigo: string; mensaje: string }> {
    const { data, error } = await comoUsuario.rpc("admin_general_asignar_administrador", {
      _correo: correo,
      _recintos: recintoIds.length > 0 ? recintoIds : null,
    });
    if (error) throw error;
    const r = data as { ok?: boolean; codigo?: string; mensaje?: string } | null;
    return {
      ok: r?.ok === true,
      codigo: r?.codigo ?? "",
      mensaje: r?.mensaje ?? "No pudimos completar la asignación.",
    };
  }

  let primera: { ok: boolean; codigo: string; mensaje: string };
  try {
    primera = await asignar();
  } catch (e) {
    log.error("Falló la asignación", { error: safeErrorMessage(e) });
    return fail(request, "error_interno", "No pudimos asignar el rol.", 500);
  }

  // La cuenta ya existía (o la asignación se rechazó por otra razón):
  // no hay nada que crear ni contraseña de la que avisar.
  if (primera.ok || primera.codigo !== "sin_cuenta") {
    const respuesta: Respuesta = {
      ok: primera.ok,
      mensaje: primera.mensaje,
      cuentaCreada: false,
      correoEnviado: false,
    };
    return json(request, respuesta, primera.ok ? 200 : 400);
  }

  // ---------------------------------------------------------------
  // No existe la cuenta: se crea, sin contraseña y ya confirmada.
  // ---------------------------------------------------------------
  const { error: errorCrear } = await admin.auth.admin.createUser({
    email: correo,
    email_confirm: true,
    user_metadata: { full_name: nombre },
  });

  if (errorCrear) {
    log.error("No se pudo crear la cuenta", { error: safeErrorMessage(errorCrear) });
    return fail(
      request,
      "creacion_fallida",
      "No pudimos crear la cuenta. Revisa que el correo no esté ya registrado.",
      400,
    );
  }

  let segunda: { ok: boolean; codigo: string; mensaje: string };
  try {
    segunda = await asignar();
  } catch (e) {
    log.error("Falló la asignación tras crear la cuenta", { error: safeErrorMessage(e) });
    // La cuenta quedó creada: decirlo es más útil que un error a secas,
    // porque el rol se puede conceder después desde el panel.
    return json(
      request,
      {
        ok: false,
        mensaje: "La cuenta se creó, pero no pudimos asignarle el rol. Vuelve a intentar " +
          "la asignación desde el panel.",
        cuentaCreada: true,
        correoEnviado: false,
      } satisfies Respuesta,
      500,
    );
  }

  // ---------------------------------------------------------------
  // Aviso por correo. Que no salga no invalida la cuenta creada.
  // ---------------------------------------------------------------
  let correoEnviado = false;
  let motivoCorreo: string | undefined;

  const apiKey = optionalEnv("BREVO_API_KEY");
  const remitente = optionalEnv("BREVO_EMAIL_FROM");
  const appUrl = optionalEnv("APP_URL", "http://localhost:5173").replace(/\/$/, "");

  if (!apiKey || !remitente) {
    motivoCorreo = "El canal de correo no está configurado en el servidor " +
      "(BREVO_API_KEY / BREVO_EMAIL_FROM).";
  } else {
    try {
      await sendBrevoEmail({
        apiKey,
        from: remitente,
        fromName: optionalEnv("BREVO_EMAIL_FROM_NAME") || null,
        to: correo,
        toName: nombre,
        subject: "Tu cuenta de administración en ActivaUC",
        html: cuerpoDelAviso(nombre, appUrl, correo),
      });
      correoEnviado = true;
    } catch (e) {
      motivoCorreo = e instanceof BrevoEmailError
        ? `El proveedor de correo rechazó el envío (${e.status}).`
        : "No pudimos enviar el correo de aviso.";
      log.error("No se pudo avisar por correo", { error: safeErrorMessage(e) });
    }
  }

  const respuesta: Respuesta = {
    ok: segunda.ok,
    mensaje: segunda.ok
      ? `Cuenta creada. ${segunda.mensaje}`
      : segunda.mensaje,
    cuentaCreada: true,
    correoEnviado,
    ...(motivoCorreo ? { motivoCorreo } : {}),
  };

  log.info("Cuenta de administración creada", {
    correoTerminacion: correo.slice(-12),
    recintos: recintoIds.length,
    correoEnviado,
  });

  return json(request, respuesta, segunda.ok ? 200 : 400);
});

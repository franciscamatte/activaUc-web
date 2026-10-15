import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_SCOPES,
  GoogleApiError,
  buildAuthUrl,
  createCalendarEvent,
  deleteCalendarEvent,
  emailFromIdToken,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
} from "../../supabase/functions/_shared/google.ts";

/**
 * Integración con Google Calendar, con fetch simulado.
 *
 * Lo que se comprueba aquí es el contrato que el worker necesita:
 * permisos mínimos, idempotencia al crear eventos, tolerancia a que el
 * evento ya no exista al eliminarlo, y qué errores merecen reintento.
 */

const CREDENCIALES = {
  clientId: "cliente-de-prueba.apps.googleusercontent.com",
  clientSecret: "secreto-de-prueba",
  redirectUri: "https://ejemplo.supabase.co/functions/v1/google-oauth-callback",
};

let fetchSimulado: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSimulado = vi.fn();
  vi.stubGlobal("fetch", fetchSimulado);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respuesta(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildAuthUrl", () => {
  it("pide únicamente los permisos mínimos necesarios (REQ-17)", () => {
    const url = new URL(buildAuthUrl({ ...CREDENCIALES, state: "firmado" }));
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");

    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    // No se solicita acceso de lectura al calendario completo ni al
    // perfil más allá del correo de la cuenta conectada.
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/userinfo.profile");
    expect(GOOGLE_SCOPES).toHaveLength(3);
  });

  it("incluye el state firmado y el redirect_uri exacto", () => {
    const url = new URL(buildAuthUrl({ ...CREDENCIALES, state: "nonce.usuario.firma" }));

    expect(url.searchParams.get("state")).toBe("nonce.usuario.firma");
    expect(url.searchParams.get("redirect_uri")).toBe(CREDENCIALES.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("solicita acceso offline para obtener refresh token", () => {
    const url = new URL(buildAuthUrl({ ...CREDENCIALES, state: "s" }));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("no expone el client secret en la URL", () => {
    const url = buildAuthUrl({ ...CREDENCIALES, state: "s" });
    expect(url).not.toContain(CREDENCIALES.clientSecret);
  });
});

describe("exchangeCode", () => {
  it("intercambia el código y normaliza la respuesta", async () => {
    fetchSimulado.mockResolvedValue(respuesta({
      access_token: "ya29.token-de-acceso",
      refresh_token: "1//refresh-token",
      expires_in: 3599,
      scope: "https://www.googleapis.com/auth/calendar.events openid email",
      id_token: construirIdToken("persona@uc.cl"),
    }));

    const tokens = await exchangeCode({ code: "codigo-de-google", ...CREDENCIALES });

    expect(tokens.accessToken).toBe("ya29.token-de-acceso");
    expect(tokens.refreshToken).toBe("1//refresh-token");
    expect(tokens.expiresInSeconds).toBe(3599);
    expect(tokens.scope).toContain("calendar.events");
  });

  it("envía el código y las credenciales en el cuerpo, no en la URL", async () => {
    fetchSimulado.mockResolvedValue(respuesta({ access_token: "a", expires_in: 3600 }));

    await exchangeCode({ code: "codigo-secreto", ...CREDENCIALES });

    const [url, opciones] = fetchSimulado.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(String(url)).not.toContain("codigo-secreto");
    expect(opciones.method).toBe("POST");

    const cuerpo = opciones.body as URLSearchParams;
    expect(cuerpo.get("code")).toBe("codigo-secreto");
    expect(cuerpo.get("grant_type")).toBe("authorization_code");
  });

  it("convierte un error de Google en GoogleApiError sin filtrar el código", async () => {
    fetchSimulado.mockResolvedValue(respuesta({
      error: "invalid_grant",
      error_description: "Bad Request",
    }, 400));

    const promesa = exchangeCode({ code: "codigo-secreto", ...CREDENCIALES });

    await expect(promesa).rejects.toThrow(GoogleApiError);
    await expect(promesa).rejects.toThrow(/invalid_grant|Bad Request/);
    await expect(promesa).rejects.not.toThrow(/codigo-secreto/);
  });

  it("un 400 no es reintentable; un 503 sí", async () => {
    fetchSimulado.mockResolvedValue(respuesta({ error: "invalid_grant" }, 400));
    await exchangeCode({ code: "c", ...CREDENCIALES }).catch((error) => {
      expect((error as GoogleApiError).retryable).toBe(false);
    });

    fetchSimulado.mockResolvedValue(respuesta({ error: "backend_error" }, 503));
    await exchangeCode({ code: "c", ...CREDENCIALES }).catch((error) => {
      expect((error as GoogleApiError).retryable).toBe(true);
    });
  });
});

describe("refreshAccessToken", () => {
  it("renueva el access token (REQ-17)", async () => {
    fetchSimulado.mockResolvedValue(respuesta({
      access_token: "ya29.token-renovado",
      expires_in: 3599,
      scope: "https://www.googleapis.com/auth/calendar.events",
    }));

    const tokens = await refreshAccessToken({
      refreshToken: "1//refresh",
      clientId: CREDENCIALES.clientId,
      clientSecret: CREDENCIALES.clientSecret,
    });

    expect(tokens.accessToken).toBe("ya29.token-renovado");
    // Google no siempre devuelve refresh token al renovar.
    expect(tokens.refreshToken).toBeNull();

    const cuerpo = fetchSimulado.mock.calls[0][1].body as URLSearchParams;
    expect(cuerpo.get("grant_type")).toBe("refresh_token");
  });

  it("un invalid_grant (usuario revocó el acceso) no es reintentable", async () => {
    fetchSimulado.mockResolvedValue(respuesta({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    }, 400));

    try {
      await refreshAccessToken({
        refreshToken: "1//revocado",
        clientId: CREDENCIALES.clientId,
        clientSecret: CREDENCIALES.clientSecret,
      });
      expect.unreachable("debía lanzar");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleApiError);
      expect((error as GoogleApiError).retryable).toBe(false);
    }
  });
});

describe("createCalendarEvent · REQ-18 y REQ-20", () => {
  const evento = {
    eventId: "activauc0191c2a45f6b7c8d9e0f1a2b3c4d5e6f",
    summary: "Reserva ActivaUC · Cancha San Joaquín",
    description: "Reserva confirmada en ActivaUC",
    location: "Cancha San Joaquín",
    startsAt: "2026-10-20T18:00:00.000Z",
    endsAt: "2026-10-20T19:00:00.000Z",
    timeZone: "America/Santiago",
  };

  it("crea el evento con el identificador determinístico", async () => {
    fetchSimulado.mockResolvedValue(respuesta({ id: evento.eventId }, 200));

    const resultado = await createCalendarEvent("ya29.token", evento);

    expect(resultado).toEqual({ eventId: evento.eventId, alreadyExisted: false });

    const cuerpo = JSON.parse(fetchSimulado.mock.calls[0][1].body as string);
    expect(cuerpo.id).toBe(evento.eventId);
    expect(cuerpo.start).toEqual({
      dateTime: evento.startsAt,
      timeZone: "America/Santiago",
    });
  });

  it("envía el token en el encabezado, nunca en la URL", async () => {
    fetchSimulado.mockResolvedValue(respuesta({ id: evento.eventId }));

    await createCalendarEvent("ya29.token-secreto", evento);

    const [url, opciones] = fetchSimulado.mock.calls[0];
    expect(String(url)).not.toContain("ya29.token-secreto");
    expect(opciones.headers.Authorization).toBe("Bearer ya29.token-secreto");
  });

  it("un 409 (evento ya existe) es éxito, no duplicación", async () => {
    // Éste es el mecanismo de idempotencia: reintentar la creación del
    // mismo evento no genera un segundo evento en el calendario.
    fetchSimulado.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "duplicate" } }), { status: 409 }),
    );

    const resultado = await createCalendarEvent("ya29.token", evento);

    expect(resultado.alreadyExisted).toBe(true);
    expect(resultado.eventId).toBe(evento.eventId);
  });

  it("clasifica los errores según sean transitorios o definitivos", async () => {
    for (const { status, reintentable } of [
      { status: 403, reintentable: false },
      { status: 404, reintentable: false },
      { status: 429, reintentable: true },
      { status: 500, reintentable: true },
      { status: 503, reintentable: true },
    ]) {
      fetchSimulado.mockResolvedValue(new Response("{}", { status }));

      try {
        await createCalendarEvent("ya29.token", evento);
        expect.unreachable(`HTTP ${status} debía lanzar`);
      } catch (error) {
        expect(error).toBeInstanceOf(GoogleApiError);
        expect((error as GoogleApiError).retryable).toBe(reintentable);
      }
    }
  });
});

describe("deleteCalendarEvent · REQ-19", () => {
  it("elimina el evento", async () => {
    fetchSimulado.mockResolvedValue(new Response(null, { status: 204 }));

    const resultado = await deleteCalendarEvent("ya29.token", "activauc123");

    expect(resultado.alreadyGone).toBe(false);
    expect(fetchSimulado.mock.calls[0][1].method).toBe("DELETE");
  });

  it("un 404 o un 410 significan que ya no existe: objetivo cumplido", async () => {
    for (const status of [404, 410]) {
      fetchSimulado.mockResolvedValue(new Response(null, { status }));
      const resultado = await deleteCalendarEvent("ya29.token", "activauc123");
      expect(resultado.alreadyGone).toBe(true);
    }
  });

  it("un 500 se propaga como reintentable", async () => {
    fetchSimulado.mockResolvedValue(new Response(null, { status: 500 }));

    try {
      await deleteCalendarEvent("ya29.token", "activauc123");
      expect.unreachable("debía lanzar");
    } catch (error) {
      expect((error as GoogleApiError).retryable).toBe(true);
    }
  });

  it("codifica el identificador del evento en la ruta", async () => {
    fetchSimulado.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteCalendarEvent("ya29.token", "evento con espacio");

    expect(String(fetchSimulado.mock.calls[0][0])).toContain("evento%20con%20espacio");
  });
});

describe("revokeToken", () => {
  it("considera exitosa la revocación", async () => {
    fetchSimulado.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await revokeToken("1//refresh")).toBe(true);
  });

  it("un 400 (token ya inválido) también cumple el objetivo", async () => {
    fetchSimulado.mockResolvedValue(new Response(null, { status: 400 }));
    expect(await revokeToken("1//ya-invalido")).toBe(true);
  });

  it("un fallo de red no lanza: la desconexión local debe continuar", async () => {
    fetchSimulado.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await revokeToken("1//refresh")).toBe(false);
  });
});

describe("emailFromIdToken", () => {
  it("extrae el correo de la cuenta conectada", () => {
    expect(emailFromIdToken(construirIdToken("persona@uc.cl"))).toBe("persona@uc.cl");
  });

  it("devuelve null ante un token ausente o malformado", () => {
    expect(emailFromIdToken(null)).toBeNull();
    expect(emailFromIdToken("no-es-jwt")).toBeNull();
    expect(emailFromIdToken("a.b")).toBeNull();
    expect(emailFromIdToken("a.!!!.c")).toBeNull();
  });
});

/** Construye un id_token de prueba (sin firmar; sólo se lee el payload). */
function construirIdToken(email: string): string {
  const base64url = (texto: string) =>
    btoa(texto).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({ email, email_verified: true })),
    "firma-no-verificada",
  ].join(".");
}

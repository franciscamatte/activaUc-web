import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrevoEmailError,
  sendBrevoEmail,
} from "../../supabase/functions/_shared/brevoEmail.ts";

/**
 * Canal de correo por Brevo, con `fetch` simulado.
 *
 * Reemplazó al de Twilio porque en el plan de prueba de éste el
 * contenido tiene que coincidir con una plantilla de muestra y cada
 * destinatario tiene que estar verificado (error 574002). Lo que se
 * verifica aquí es lo que protege a la plataforma: que la petición
 * llegue con la forma que Brevo exige, que el identificador devuelto se
 * pueda usar para registrar el envío, y que los errores se clasifiquen
 * bien para decidir si se reintenta.
 */

let fetchSimulado: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSimulado = vi.fn();
  vi.stubGlobal("fetch", fetchSimulado);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respuesta(cuerpo: unknown, status = 201): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const base = {
  apiKey: "xkeysib-clave-de-prueba",
  from: "activauc.deportes@example.cl",
  fromName: "ActivaUC",
  to: "persona@uc.cl",
  toName: "Camila Rojas",
  subject: "Reserva confirmada · Cancha de fútbol",
  html: "<p>Hola Camila</p>",
};

describe("sendBrevoEmail", () => {
  it("manda la petición con la forma que Brevo exige", async () => {
    fetchSimulado.mockResolvedValue(respuesta({ messageId: "<202610@brevo>" }));

    const r = await sendBrevoEmail(base);

    expect(r.messageId).toBe("<202610@brevo>");
    expect(fetchSimulado).toHaveBeenCalledTimes(1);

    const [url, opciones] = fetchSimulado.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(opciones.method).toBe("POST");

    // La clave va en su propia cabecera, no como Bearer.
    const cabeceras = opciones.headers as Record<string, string>;
    expect(cabeceras["api-key"]).toBe(base.apiKey);

    const cuerpo = JSON.parse(String(opciones.body));
    expect(cuerpo.sender).toEqual({ email: base.from, name: "ActivaUC" });
    expect(cuerpo.to).toEqual([{ email: base.to, name: "Camila Rojas" }]);
    expect(cuerpo.subject).toBe(base.subject);
    expect(cuerpo.htmlContent).toBe(base.html);
  });

  it("acepta messageIds en plural, que Brevo también devuelve", async () => {
    fetchSimulado.mockResolvedValue(respuesta({ messageIds: ["<a@brevo>", "<b@brevo>"] }));

    const r = await sendBrevoEmail(base);

    expect(r.messageId).toBe("<a@brevo>");
  });

  it("recorta los nombres al límite de 70 caracteres de Brevo", async () => {
    fetchSimulado.mockResolvedValue(respuesta({ messageId: "<x@brevo>" }));

    await sendBrevoEmail({ ...base, fromName: "A".repeat(100), toName: "B".repeat(100) });

    const cuerpo = JSON.parse(String((fetchSimulado.mock.calls[0] as [string, RequestInit])[1].body));
    expect(cuerpo.sender.name).toHaveLength(70);
    expect(cuerpo.to[0].name).toHaveLength(70);
  });

  it("omite el nombre del destinatario cuando no se conoce", async () => {
    fetchSimulado.mockResolvedValue(respuesta({ messageId: "<x@brevo>" }));

    await sendBrevoEmail({ ...base, toName: null });

    const cuerpo = JSON.parse(String((fetchSimulado.mock.calls[0] as [string, RequestInit])[1].body));
    expect(cuerpo.to).toEqual([{ email: base.to }]);
  });

  it("un 4xx no se reintenta y conserva el motivo de Brevo", async () => {
    fetchSimulado.mockResolvedValue(
      respuesta({ code: "invalid_parameter", message: "Invalid sender" }, 400),
    );

    await expect(sendBrevoEmail(base)).rejects.toMatchObject({
      name: "BrevoEmailError",
      status: 400,
      code: "invalid_parameter",
      retryable: false,
    });
  });

  it("un 429 y un 5xx sí se reintentan", async () => {
    for (const status of [429, 500, 503]) {
      fetchSimulado.mockResolvedValue(respuesta({ message: "ups" }, status));
      await expect(sendBrevoEmail(base)).rejects.toMatchObject({ retryable: true });
    }
  });

  it("sin identificador NO se reintenta, para no duplicar el correo", async () => {
    // Brevo aceptó la petición, así que el correo probablemente salió y
    // lo que falta es la trazabilidad. Reintentar mandaría un segundo
    // aviso a la misma persona, que es peor que perder un identificador.
    fetchSimulado.mockResolvedValue(respuesta({ ok: true }));

    await expect(sendBrevoEmail(base)).rejects.toMatchObject({
      retryable: false,
      code: "sin_message_id",
    });
  });

  it("la falta de configuración falla sin llamar a Brevo", async () => {
    // Un error de configuración no debe gastar reintentos ni red.
    await expect(sendBrevoEmail({ ...base, apiKey: "   " })).rejects.toThrow(
      /BREVO_API_KEY/,
    );
    await expect(sendBrevoEmail({ ...base, from: "" })).rejects.toThrow(
      /BREVO_EMAIL_FROM/,
    );
    expect(fetchSimulado).not.toHaveBeenCalled();

    await expect(sendBrevoEmail({ ...base, apiKey: "" })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("un cuerpo que no es JSON no rompe el manejo del error", async () => {
    fetchSimulado.mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );

    await expect(sendBrevoEmail(base)).rejects.toMatchObject({
      status: 502,
      code: null,
      retryable: true,
    });
  });

  it("BrevoEmailError es reconocible por su nombre", () => {
    const e = new BrevoEmailError(400, "x", "y");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BrevoEmailError");
  });
});

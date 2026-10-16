import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TwilioApiError,
  isValidTwilioSignature,
  sendWhatsApp,
  webhookUrlForSignature,
} from "../../supabase/functions/_shared/twilio.ts";
import { hmacSha1Base64 } from "../../supabase/functions/_shared/crypto.ts";
import {
  buildBody,
  buildContentVariables,
  contentSidEnvVar,
  contentVarsEnvVar,
  formatSpanishDateTime,
} from "../../supabase/functions/_shared/messages.ts";
import { isE164, toWhatsAppAddress } from "../../supabase/functions/_shared/phone.ts";

/**
 * Integración con Twilio WhatsApp, con fetch simulado.
 *
 * Se comprueba lo que protege al usuario y a la plataforma: validación
 * del destino, uso de plantillas aprobadas, clasificación de errores
 * para los reintentos, y verificación de la firma del webhook (que es lo
 * que impide que cualquiera falsifique estados de entrega).
 */

const CUENTA = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TOKEN = "token-de-autenticacion-de-prueba";
const EMISOR = "whatsapp:+14155238886";

let fetchSimulado: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSimulado = vi.fn();
  vi.stubGlobal("fetch", fetchSimulado);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respuestaTwilio(cuerpo: unknown, status = 201): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sendWhatsApp · REQ-24", () => {
  const base = {
    accountSid: CUENTA,
    authToken: TOKEN,
    from: EMISOR,
    to: "+56912345678",
    body: "Hola: tu reserva quedó confirmada.",
  };

  it("envía el mensaje y devuelve el identificador de Twilio", async () => {
    fetchSimulado.mockResolvedValue(respuestaTwilio({ sid: "SM123", status: "queued" }));

    const resultado = await sendWhatsApp(base);

    expect(resultado).toEqual({ sid: "SM123", status: "queued" });
    expect(fetchSimulado.mock.calls[0][0]).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${CUENTA}/Messages.json`,
    );
  });

  it("usa el prefijo whatsapp: en origen y destino", async () => {
    fetchSimulado.mockResolvedValue(respuestaTwilio({ sid: "SM1", status: "queued" }));

    await sendWhatsApp({ ...base, from: "+14155238886" });

    const cuerpo = fetchSimulado.mock.calls[0][1].body as URLSearchParams;
    expect(cuerpo.get("To")).toBe("whatsapp:+56912345678");
    expect(cuerpo.get("From")).toBe("whatsapp:+14155238886");
  });

  it("autentica con Basic y no pone credenciales en la URL", async () => {
    fetchSimulado.mockResolvedValue(respuestaTwilio({ sid: "SM1", status: "queued" }));

    await sendWhatsApp(base);

    const [url, opciones] = fetchSimulado.mock.calls[0];
    expect(String(url)).not.toContain(TOKEN);
    expect(opciones.headers.Authorization).toBe(`Basic ${btoa(`${CUENTA}:${TOKEN}`)}`);
  });

  it("usa la plantilla aprobada cuando hay ContentSid (producción)", async () => {
    fetchSimulado.mockResolvedValue(respuestaTwilio({ sid: "SM1", status: "queued" }));

    await sendWhatsApp({
      ...base,
      contentSid: "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      contentVariables: { "1": "Camila", "2": "Cancha San Joaquín", "3": "hoy a las 18:00" },
    });

    const cuerpo = fetchSimulado.mock.calls[0][1].body as URLSearchParams;
    expect(cuerpo.get("ContentSid")).toBe("HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(JSON.parse(cuerpo.get("ContentVariables") ?? "{}")).toEqual({
      "1": "Camila",
      "2": "Cancha San Joaquín",
      "3": "hoy a las 18:00",
    });
    // Con plantilla no se envía Body: WhatsApp lo rechazaría.
    expect(cuerpo.get("Body")).toBeNull();
  });

  it("usa texto libre cuando no hay plantilla (sandbox)", async () => {
    fetchSimulado.mockResolvedValue(respuestaTwilio({ sid: "SM1", status: "queued" }));

    await sendWhatsApp({ ...base, contentSid: null });

    const cuerpo = fetchSimulado.mock.calls[0][1].body as URLSearchParams;
    expect(cuerpo.get("Body")).toBe(base.body);
    expect(cuerpo.get("ContentSid")).toBeNull();
  });

  it("adjunta el callback de estados cuando está configurado (REQ-27)", async () => {
    fetchSimulado.mockResolvedValue(respuestaTwilio({ sid: "SM1", status: "queued" }));

    await sendWhatsApp({
      ...base,
      statusCallbackUrl: "https://ejemplo.supabase.co/functions/v1/twilio-status-webhook",
    });

    const cuerpo = fetchSimulado.mock.calls[0][1].body as URLSearchParams;
    expect(cuerpo.get("StatusCallback")).toContain("twilio-status-webhook");
  });

  it("rechaza un destino que no está en formato E.164", async () => {
    await expect(sendWhatsApp({ ...base, to: "912345678" })).rejects.toThrow(/E\.164/);
    expect(fetchSimulado).not.toHaveBeenCalled();
  });

  describe("clasificación de errores para los reintentos", () => {
    const casos = [
      { codigo: "21211", status: 400, reintentable: false, nota: "número inválido" },
      { codigo: "63003", status: 400, reintentable: false, nota: "destino sin WhatsApp" },
      { codigo: "63024", status: 400, reintentable: false, nota: "mensaje no permitido" },
      { codigo: "21610", status: 400, reintentable: false, nota: "destinatario dio de baja" },
      { codigo: "20429", status: 429, reintentable: true, nota: "demasiadas solicitudes" },
      { codigo: "20500", status: 500, reintentable: true, nota: "error interno de Twilio" },
      { codigo: "20503", status: 503, reintentable: true, nota: "servicio no disponible" },
    ];

    for (const caso of casos) {
      it(`${caso.codigo} (${caso.nota}) ${caso.reintentable ? "se reintenta" : "no se reintenta"}`, async () => {
        fetchSimulado.mockResolvedValue(respuestaTwilio(
          { code: Number(caso.codigo), message: caso.nota },
          caso.status,
        ));

        try {
          await sendWhatsApp(base);
          expect.unreachable("debía lanzar");
        } catch (error) {
          expect(error).toBeInstanceOf(TwilioApiError);
          expect((error as TwilioApiError).code).toBe(caso.codigo);
          expect((error as TwilioApiError).retryable).toBe(caso.reintentable);
        }
      });
    }
  });

  it("un cuerpo de error no interpretable no rompe el worker", async () => {
    fetchSimulado.mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    try {
      await sendWhatsApp(base);
      expect.unreachable("debía lanzar");
    } catch (error) {
      expect(error).toBeInstanceOf(TwilioApiError);
      expect((error as TwilioApiError).retryable).toBe(true);
    }
  });
});

describe("isValidTwilioSignature · autenticación del webhook", () => {
  const url = "https://ejemplo.supabase.co/functions/v1/twilio-status-webhook";
  const parametros = {
    MessageSid: "SM123",
    MessageStatus: "delivered",
    To: "whatsapp:+56912345678",
    From: EMISOR,
  };

  /** Firma calculada como lo hace Twilio: URL + pares ordenados por clave. */
  async function firmar(
    urlFirmada: string,
    params: Record<string, string>,
    token = TOKEN,
  ): Promise<string> {
    const datos = Object.keys(params).sort()
      .reduce((acumulado, clave) => acumulado + clave + params[clave], urlFirmada);
    return await hmacSha1Base64(token, datos);
  }

  it("acepta una firma legítima", async () => {
    const firma = await firmar(url, parametros);

    expect(await isValidTwilioSignature({
      authToken: TOKEN,
      url,
      formParams: parametros,
      signature: firma,
    })).toBe(true);
  });

  it("rechaza una solicitud sin firma", async () => {
    expect(await isValidTwilioSignature({
      authToken: TOKEN,
      url,
      formParams: parametros,
      signature: null,
    })).toBe(false);
  });

  it("rechaza una firma inventada", async () => {
    expect(await isValidTwilioSignature({
      authToken: TOKEN,
      url,
      formParams: parametros,
      signature: "ZmlybWFfaW52ZW50YWRh",
    })).toBe(false);
  });

  it("rechaza si se altera un parámetro tras firmar (anti-manipulación)", async () => {
    const firma = await firmar(url, parametros);

    expect(await isValidTwilioSignature({
      authToken: TOKEN,
      url,
      // Alguien intenta marcar como entregado otro mensaje.
      formParams: { ...parametros, MessageSid: "SM999" },
      signature: firma,
    })).toBe(false);
  });

  it("rechaza si se añade un parámetro no firmado", async () => {
    const firma = await firmar(url, parametros);

    expect(await isValidTwilioSignature({
      authToken: TOKEN,
      url,
      formParams: { ...parametros, Extra: "inyectado" },
      signature: firma,
    })).toBe(false);
  });

  it("rechaza una firma hecha con otro Auth Token", async () => {
    const firma = await firmar(url, parametros, "token-de-otra-cuenta");

    expect(await isValidTwilioSignature({
      authToken: TOKEN,
      url,
      formParams: parametros,
      signature: firma,
    })).toBe(false);
  });

  it("rechaza una firma válida para otra URL (evita reenvío cruzado)", async () => {
    const firma = await firmar("https://otro-dominio.example/webhook", parametros);

    expect(await isValidTwilioSignature({
      authToken: TOKEN,
      url,
      formParams: parametros,
      signature: firma,
    })).toBe(false);
  });

  it("el orden de las claves no afecta el resultado", async () => {
    const firma = await firmar(url, parametros);
    const reordenado = {
      To: parametros.To,
      MessageStatus: parametros.MessageStatus,
      From: parametros.From,
      MessageSid: parametros.MessageSid,
    };

    expect(await isValidTwilioSignature({
      authToken: TOKEN,
      url,
      formParams: reordenado,
      signature: firma,
    })).toBe(true);
  });
});

describe("webhookUrlForSignature", () => {
  it("usa la URL fijada por configuración cuando existe", () => {
    const solicitud = new Request("https://interno.local/functions/v1/twilio-status-webhook", {
      method: "POST",
    });

    expect(webhookUrlForSignature(solicitud, "https://publico.example/webhook"))
      .toBe("https://publico.example/webhook");
  });

  it("reconstruye la URL pública desde los encabezados del proxy", () => {
    const solicitud = new Request("http://interno.local/functions/v1/twilio-status-webhook", {
      method: "POST",
      headers: {
        "x-forwarded-host": "ejemplo.supabase.co",
        "x-forwarded-proto": "https",
      },
    });

    expect(webhookUrlForSignature(solicitud, "")).toBe(
      "https://ejemplo.supabase.co/functions/v1/twilio-status-webhook",
    );
  });

  it("sin la URL fijada no puede reconstruir la de una Edge Function", () => {
    // Caso real, y el motivo de que la función pase siempre el URL
    // registrado: en una Edge Function de Supabase, `request.url` llega
    // sin el prefijo `/functions/v1`, así que lo reconstruido no coincide
    // con lo que Twilio firmó y las llamadas legítimas daban 403.
    const solicitud = new Request("https://ejemplo.supabase.co/twilio-status-webhook", {
      method: "POST",
    });

    expect(webhookUrlForSignature(solicitud, "")).not.toBe(
      "https://ejemplo.supabase.co/functions/v1/twilio-status-webhook",
    );
    expect(webhookUrlForSignature(
      solicitud,
      "https://ejemplo.supabase.co/functions/v1/twilio-status-webhook",
    )).toBe("https://ejemplo.supabase.co/functions/v1/twilio-status-webhook");
  });
});

describe("plantillas de mensajes", () => {
  const contexto = {
    nombre: "Camila",
    recinto: "Cancha de fútbol San Joaquín",
    fechaHora: "viernes 17 de octubre, 18:00",
  };

  it("la confirmación está en español y nombra el recinto y la hora", () => {
    const texto = buildBody("confirmacion", contexto);
    expect(texto).toContain("Camila");
    expect(texto).toContain("Cancha de fútbol San Joaquín");
    expect(texto).toContain("viernes 17 de octubre, 18:00");
    expect(texto).toContain("confirmada");
  });

  it("el recordatorio menciona que es un recordatorio", () => {
    expect(buildBody("recordatorio", contexto)).toContain("recordamos");
  });

  it("la cancelación administrativa incluye el motivo cuando existe", () => {
    const conMotivo = buildBody("cancelacion_admin", {
      ...contexto,
      motivo: "mantención de la cancha",
    });
    expect(conMotivo).toContain("mantención de la cancha");

    const sinMotivo = buildBody("cancelacion_admin", contexto);
    expect(sinMotivo).toContain("cancelada");
    expect(sinMotivo).not.toContain("motivo:");
  });

  it("ningún mensaje contiene texto en inglés", () => {
    const tipos = ["confirmacion", "recordatorio", "cancelacion_admin"] as const;
    for (const tipo of tipos) {
      const texto = buildBody(tipo, contexto);
      expect(texto).not.toMatch(/\b(your|booking|reminder|cancelled|confirmed|hello)\b/i);
    }
  });

  it("las variables de plantilla van numeradas como las espera Twilio", () => {
    expect(buildContentVariables("confirmacion", contexto)).toEqual({
      "1": "Camila",
      "2": "Cancha de fútbol San Joaquín",
      "3": "viernes 17 de octubre, 18:00",
    });

    const cancelacion = buildContentVariables("cancelacion_admin", contexto);
    expect(cancelacion?.["4"]).toBe("mantención del recinto");
  });

  it("una plantilla sin variables no recibe ninguna", () => {
    // Las plantillas de muestra de Twilio (lo único disponible en una
    // cuenta Trial) traen el texto fijo. Mandarles variables da 63028.
    for (const palabra of ["ninguna", "NINGUNA", " none ", "sin"]) {
      expect(buildContentVariables("confirmacion", contexto, palabra)).toBeNull();
    }
  });

  it("el orden de las variables se puede configurar", () => {
    // Una plantilla aprobada por Meta puede quedar con otro orden.
    expect(buildContentVariables("confirmacion", contexto, "recinto,fechaHora,nombre"))
      .toEqual({
        "1": "Cancha de fútbol San Joaquín",
        "2": "viernes 17 de octubre, 18:00",
        "3": "Camila",
      });

    // Y con menos variables que los campos disponibles.
    expect(buildContentVariables("recordatorio", contexto, " nombre , fechaHora "))
      .toEqual({ "1": "Camila", "2": "viernes 17 de octubre, 18:00" });
  });

  it("un campo desconocido falla en lugar de enviar datos descolocados", () => {
    expect(() => buildContentVariables("confirmacion", contexto, "nombre,cancha"))
      .toThrow(/cancha/);
  });

  it("un orden vacío mantiene el de siempre", () => {
    expect(buildContentVariables("confirmacion", contexto, ""))
      .toEqual(buildContentVariables("confirmacion", contexto));
    expect(buildContentVariables("confirmacion", contexto, null))
      .toEqual(buildContentVariables("confirmacion", contexto));
  });

  it("cada tipo tiene su propia variable de ContentSid", () => {
    expect(contentSidEnvVar("confirmacion")).toBe("TWILIO_CONTENT_SID_CONFIRMACION");
    expect(contentSidEnvVar("recordatorio")).toBe("TWILIO_CONTENT_SID_RECORDATORIO");
    expect(contentSidEnvVar("cancelacion_admin")).toBe("TWILIO_CONTENT_SID_CANCELACION");
    expect(contentVarsEnvVar("confirmacion")).toBe("TWILIO_CONTENT_VARS_CONFIRMACION");
    expect(contentVarsEnvVar("recordatorio")).toBe("TWILIO_CONTENT_VARS_RECORDATORIO");
    expect(contentVarsEnvVar("cancelacion_admin")).toBe("TWILIO_CONTENT_VARS_CANCELACION");
  });

  it("la fecha se formatea en español de Chile y en la zona indicada", () => {
    // 2026-10-17 es sábado; 21:00 UTC son 18:00 en Santiago (UTC-3).
    const texto = formatSpanishDateTime("2026-10-17T21:00:00.000Z", "America/Santiago");
    expect(texto).toMatch(/sábado/);
    expect(texto).toMatch(/octubre/);
    expect(texto).toMatch(/18:00/);
    // Formato de 24 horas, sin "a. m." ni "p. m.".
    expect(texto).not.toMatch(/[ap]\.\s?m\./);
  });
});

describe("validación de destinos (compartida con la restricción SQL)", () => {
  it("acepta números E.164", () => {
    expect(isE164("+56912345678")).toBe(true);
    expect(toWhatsAppAddress("+56 9 1234 5678")).toBe("whatsapp:+56912345678");
  });

  it("rechaza números sin código de país", () => {
    expect(isE164("912345678")).toBe(false);
    expect(() => toWhatsAppAddress("912345678")).toThrow(/E\.164/);
  });

  it("rechaza cadenas vacías o con texto", () => {
    expect(isE164("")).toBe(false);
    expect(isE164("sin-numero")).toBe(false);
  });
});

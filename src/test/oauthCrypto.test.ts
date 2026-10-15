import { describe, expect, it } from "vitest";
import {
  calendarEventId,
  decryptSecret,
  encryptSecret,
  hmacSha1Base64,
  hmacSha256Hex,
  randomToken,
  sha256Hex,
  signState,
  timingSafeEqual,
  verifyState,
} from "../../supabase/functions/_shared/crypto.ts";

/**
 * Pruebas del cifrado de tokens OAuth y de la firma del parámetro
 * `state`, que son las dos piezas de las que depende la seguridad del
 * flujo de Google Calendar (REQ-17).
 */

/** Clave de 32 bytes en base64, sólo para pruebas. */
const CLAVE = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTRA_CLAVE = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("cifrado de tokens en reposo", () => {
  it("cifra y descifra sin pérdida", async () => {
    const token = "1//04abcdefgHIJKLmnop-refresh-token-de-google";
    const cifrado = await encryptSecret(token, CLAVE);

    expect(cifrado).not.toContain(token);
    expect(await decryptSecret(cifrado, CLAVE)).toBe(token);
  });

  it("usa un vector de inicialización distinto en cada cifrado", async () => {
    const token = "mismo-token";
    const a = await encryptSecret(token, CLAVE);
    const b = await encryptSecret(token, CLAVE);

    expect(a).not.toBe(b);
    expect(await decryptSecret(a, CLAVE)).toBe(token);
    expect(await decryptSecret(b, CLAVE)).toBe(token);
  });

  it("marca la versión del formato, para poder rotar el algoritmo", async () => {
    const cifrado = await encryptSecret("token", CLAVE);
    expect(cifrado.startsWith("v1.")).toBe(true);
    expect(cifrado.split(".")).toHaveLength(3);
  });

  it("falla al descifrar con otra clave (AES-GCM autentica)", async () => {
    const cifrado = await encryptSecret("token", CLAVE);
    await expect(decryptSecret(cifrado, OTRA_CLAVE)).rejects.toThrow();
  });

  it("detecta manipulación del texto cifrado", async () => {
    const cifrado = await encryptSecret("token-original", CLAVE);
    const partes = cifrado.split(".");

    // Se altera un byte del texto cifrado: la etiqueta GCM debe fallar.
    const bytes = atob(partes[2]).split("");
    bytes[0] = String.fromCharCode(bytes[0].charCodeAt(0) ^ 0xff);
    const alterado = `${partes[0]}.${partes[1]}.${btoa(bytes.join(""))}`;

    await expect(decryptSecret(alterado, CLAVE)).rejects.toThrow();
  });

  it("rechaza un formato desconocido", async () => {
    await expect(decryptSecret("texto-plano", CLAVE)).rejects.toThrow(/no reconocido/);
    await expect(decryptSecret("v2.a.b", CLAVE)).rejects.toThrow(/no reconocido/);
  });

  it("exige una clave de 32 bytes", async () => {
    const corta = btoa("demasiado-corta");
    await expect(encryptSecret("token", corta)).rejects.toThrow(/32 bytes/);
  });
});

describe("firma del state de OAuth (anti-CSRF)", () => {
  const SECRETO = CLAVE;

  it("firma y verifica un state propio", async () => {
    const nonce = randomToken(32);
    const userId = "11111111-1111-4111-8111-111111111111";

    const state = await signState(nonce, userId, SECRETO);
    const verificado = await verifyState(state, SECRETO);

    expect(verificado).toEqual({ nonce, userId });
  });

  it("rechaza un state con firma alterada", async () => {
    const state = await signState("nonce", "usuario", SECRETO);
    const [nonce, userId, firma] = state.split(".");
    const alterado = `${nonce}.${userId}.${firma.slice(0, -1)}0`;

    expect(await verifyState(alterado, SECRETO)).toBeNull();
  });

  it("rechaza un state donde se cambió el usuario", async () => {
    // Escenario de ataque: alguien intenta vincular su cuenta de Google
    // al usuario de otra persona reutilizando un state firmado.
    const state = await signState("nonce", "victima", SECRETO);
    const [nonce, , firma] = state.split(".");
    const suplantado = `${nonce}.atacante.${firma}`;

    expect(await verifyState(suplantado, SECRETO)).toBeNull();
  });

  it("rechaza un state firmado con otro secreto", async () => {
    const state = await signState("nonce", "usuario", SECRETO);
    expect(await verifyState(state, OTRA_CLAVE)).toBeNull();
  });

  it("rechaza states con formato inválido", async () => {
    expect(await verifyState("", SECRETO)).toBeNull();
    expect(await verifyState("solo-una-parte", SECRETO)).toBeNull();
    expect(await verifyState("dos.partes", SECRETO)).toBeNull();
    expect(await verifyState("a.b.c.d", SECRETO)).toBeNull();
  });

  it("el nonce aleatorio no se repite", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => randomToken(32)));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) expect(nonce).toHaveLength(64);
  });

  it("sólo se persiste el hash del nonce, no el nonce", async () => {
    const nonce = randomToken(32);
    const hash = await sha256Hex(nonce);

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(nonce);
    // El hash es determinístico, así que el callback puede encontrarlo.
    expect(await sha256Hex(nonce)).toBe(hash);
  });
});

describe("comparación en tiempo constante", () => {
  it("reconoce cadenas iguales", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("rechaza cadenas distintas del mismo largo", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("rechaza cadenas de largo distinto", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("maneja cadenas vacías", () => {
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("", "a")).toBe(false);
  });
});

describe("funciones HMAC", () => {
  it("HMAC-SHA256 es determinístico y de 64 hexadígitos", async () => {
    const a = await hmacSha256Hex("secreto", "mensaje");
    const b = await hmacSha256Hex("secreto", "mensaje");

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("HMAC-SHA256 cambia con el secreto y con el mensaje", async () => {
    const base = await hmacSha256Hex("secreto", "mensaje");
    expect(await hmacSha256Hex("otro", "mensaje")).not.toBe(base);
    expect(await hmacSha256Hex("secreto", "otro")).not.toBe(base);
  });

  it("HMAC-SHA1 coincide con el vector de prueba 2 de RFC 2202", async () => {
    // Clave "Jefe", mensaje "what do ya want for nothing?".
    // Resumen esperado (hexadecimal): effcdf6ae5eb2fa2d27416d5f184df9c259a7c79
    // Twilio firma en base64, que es el formato que devuelve la función.
    const esperadoHex = "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79";
    const bytes = esperadoHex.match(/../g)!.map((par) => parseInt(par, 16));
    const esperadoBase64 = btoa(String.fromCharCode(...bytes));

    const firma = await hmacSha1Base64("Jefe", "what do ya want for nothing?");
    expect(firma).toBe(esperadoBase64);
  });
});

describe("identificador de evento de Google Calendar", () => {
  it("se deriva del identificador de la reserva", () => {
    const reserva = "0191c2a4-5f6b-7c8d-9e0f-1a2b3c4d5e6f";
    const evento = calendarEventId(reserva);

    expect(evento).toBe("activauc0191c2a45f6b7c8d9e0f1a2b3c4d5e6f");
    // Mismo identificador siempre: así reintentar no duplica el evento.
    expect(calendarEventId(reserva)).toBe(evento);
  });

  it("usa sólo el alfabeto que acepta Google (a-v y 0-9)", () => {
    const evento = calendarEventId("ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(evento).toMatch(/^[a-v0-9]+$/);
    expect(evento.length).toBeGreaterThanOrEqual(5);
    expect(evento.length).toBeLessThanOrEqual(1024);
  });

  it("rechaza un identificador que no es UUID", () => {
    expect(() => calendarEventId("no-es-uuid")).toThrow(/UUID/);
    expect(() => calendarEventId("")).toThrow(/UUID/);
  });
});

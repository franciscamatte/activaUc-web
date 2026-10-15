/**
 * Criptografía de las Edge Functions.
 *
 *  · Cifrado de tokens OAuth en reposo con AES-256-GCM.
 *  · Firma HMAC-SHA256 del parámetro `state` del flujo OAuth (anti-CSRF).
 *  · Comparación en tiempo constante.
 *
 * ENCRYPTION_KEY debe ser una clave de 32 bytes codificada en base64.
 * Generarla con:  openssl rand -base64 32
 *
 * Ningún valor de este módulo se registra en logs.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CIPHER_VERSION = "v1";

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * El buffer se construye explícitamente como ArrayBuffer (y no como el
 * ArrayBufferLike que infiere TypeScript) porque la Web Crypto API exige
 * un BufferSource respaldado por ArrayBuffer, no por SharedArrayBuffer.
 */
function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function importAesKey(rawKeyBase64: string): Promise<CryptoKey> {
  const raw = base64Decode(rawKeyBase64);
  if (raw.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY debe ser una clave de 32 bytes en base64 (openssl rand -base64 32).",
    );
  }
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Cifra un texto. Formato: v1.<iv base64>.<ciphertext base64>. */
export async function encryptSecret(
  plaintext: string,
  keyBase64: string,
): Promise<string> {
  const key = await importAesKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)),
  );
  return `${CIPHER_VERSION}.${base64Encode(iv)}.${base64Encode(ciphertext)}`;
}

/** Descifra un texto producido por encryptSecret. */
export async function decryptSecret(
  payload: string,
  keyBase64: string,
): Promise<string> {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== CIPHER_VERSION) {
    throw new Error("Formato de token cifrado no reconocido.");
  }
  const key = await importAesKey(keyBase64);
  const iv = base64Decode(parts[1]);
  const ciphertext = base64Decode(parts[2]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return decoder.decode(plaintext);
}

/** HMAC-SHA256 en hexadecimal. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(signature));
}

/** HMAC-SHA1 en base64 (formato de firma de los webhooks de Twilio). */
export async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64Encode(new Uint8Array(signature));
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(message));
  return toHex(new Uint8Array(digest));
}

/** Comparación en tiempo constante para no filtrar información por timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

/** Valor aleatorio seguro en hexadecimal (para `state` y verificadores). */
export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * `state` del flujo OAuth: <nonce>.<userId>.<firma HMAC>.
 * El callback verifica la firma antes de tocar la base de datos, de modo
 * que un `state` fabricado se rechaza sin coste.
 */
export async function signState(
  nonce: string,
  userId: string,
  secret: string,
): Promise<string> {
  const payload = `${nonce}.${userId}`;
  const signature = await hmacSha256Hex(secret, payload);
  return `${payload}.${signature}`;
}

export async function verifyState(
  state: string,
  secret: string,
): Promise<{ nonce: string; userId: string } | null> {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [nonce, userId, signature] = parts;
  const expected = await hmacSha256Hex(secret, `${nonce}.${userId}`);
  if (!timingSafeEqual(signature, expected)) return null;
  return { nonce, userId };
}

/**
 * Identificador determinístico de evento de Google Calendar derivado de
 * la reserva. Google acepta ids en el alfabeto [a-v0-9], y el hexadecimal
 * de un UUID cumple esa restricción, así que reintentar la creación del
 * mismo evento devuelve 409 en lugar de duplicarlo.
 */
export function calendarEventId(reservationId: string): string {
  const hex = reservationId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error("El identificador de reserva no es un UUID válido.");
  }
  return `activauc${hex}`;
}

import { describe, expect, it } from "vitest";
import { withRetry } from "./retry";

describe("withRetry", () => {
  it("reintenta hasta resolver", async () => {
    let attempts = 0;

    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("fallo transitorio");
      }
      return "ok";
    }, 3);

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("falla al agotar reintentos", async () => {
    await expect(
      withRetry(async () => {
        throw new Error("sin salida");
      }, 1),
    ).rejects.toThrow("sin salida");
  });
});

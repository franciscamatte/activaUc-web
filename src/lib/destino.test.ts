import { describe, expect, it } from "vitest";
import { DESTINO_POR_OMISION, destinoSeguro } from "./destino";

/**
 * El destino decide a dónde vuelve alguien después de iniciar sesión, y
 * atraviesa tres pantallas antes de usarse. Las dos cosas que importan:
 * que un bloque concreto sobreviva el viaje, y que nada que no sea una
 * ruta interna llegue a `navigate()`.
 */
describe("destino de vuelta tras iniciar sesión", () => {
  it("conserva una ruta interna con su consulta", () => {
    expect(destinoSeguro("/catalogo?bloque=abc-123")).toBe("/catalogo?bloque=abc-123");
  });

  it("usa el catálogo cuando no hay destino", () => {
    expect(destinoSeguro(undefined)).toBe(DESTINO_POR_OMISION);
    expect(destinoSeguro(null)).toBe(DESTINO_POR_OMISION);
    expect(destinoSeguro("")).toBe(DESTINO_POR_OMISION);
  });

  it("descarta lo que no sea una ruta interna", () => {
    // `//ejemplo.com` y `/\ejemplo.com` los resuelve el navegador como
    // otro sitio, así que no son rutas internas aunque empiecen por «/».
    expect(destinoSeguro("https://ejemplo.com")).toBe(DESTINO_POR_OMISION);
    expect(destinoSeguro("//ejemplo.com")).toBe(DESTINO_POR_OMISION);
    expect(destinoSeguro("/\\ejemplo.com")).toBe(DESTINO_POR_OMISION);
    expect(destinoSeguro("catalogo")).toBe(DESTINO_POR_OMISION);
    expect(destinoSeguro(42)).toBe(DESTINO_POR_OMISION);
  });

  it("acepta un destino de omisión propio", () => {
    expect(destinoSeguro("no-vale", "/mis-reservas")).toBe("/mis-reservas");
  });
});

import { describe, expect, it } from "vitest";
import { esAdministrador, etiquetaRol, etiquetaRolDeCuenta } from "./types";
import type { Rol } from "./types";

const TODOS: Rol[] = ["usuario", "administrador", "administrador_general"];

/**
 * Los tres roles del sistema (REQ-29). Las dos funciones de aquí son el
 * único sitio donde la interfaz decide «esto es administración» y «así
 * se llama»; un rol nuevo que no pase por ellas aparecería en pantalla
 * como «Sesión activa» y sin acceso al panel.
 */
describe("roles", () => {
  it("administra quien tiene alguno de los dos roles de administración", () => {
    expect(esAdministrador("usuario")).toBe(false);
    expect(esAdministrador("administrador")).toBe(true);
    expect(esAdministrador("administrador_general")).toBe(true);
  });

  it("una cuenta se describe por su rol, no por su sesión", () => {
    // En la barra, un usuario común ve «Sesión activa»; en una lista de
    // cuentas eso no dice nada de la cuenta.
    expect(etiquetaRol("usuario")).toBe("Sesión activa");
    expect(etiquetaRolDeCuenta("usuario")).toContain("usuari");
    expect(etiquetaRolDeCuenta("administrador_general")).toContain("general");
    expect(new Set(TODOS.map(etiquetaRolDeCuenta)).size).toBe(TODOS.length);
  });

  it("cada rol tiene un nombre propio en pantalla", () => {
    const etiquetas = TODOS.map(etiquetaRol);
    expect(new Set(etiquetas).size).toBe(TODOS.length);
    expect(etiquetaRol("administrador_general")).toContain("general");
    expect(etiquetaRol("administrador")).toContain("recintos");
  });
});

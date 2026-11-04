import { describe, expect, it } from "vitest";
import { esAdministrador, etiquetaRol } from "./types";
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

  it("cada rol tiene un nombre propio en pantalla", () => {
    const etiquetas = TODOS.map(etiquetaRol);
    expect(new Set(etiquetas).size).toBe(TODOS.length);
    expect(etiquetaRol("administrador_general")).toContain("general");
    expect(etiquetaRol("administrador")).toContain("recintos");
  });
});

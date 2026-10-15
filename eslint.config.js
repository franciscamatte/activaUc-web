// =====================================================================
// ActivaUC · configuración de ESLint (flat config)
// ---------------------------------------------------------------------
// La configuración anterior sólo declaraba `files: ["**/*.js"]`, por lo
// que en la práctica no revisaba ningún archivo del proyecto (todo el
// código es .ts/.tsx). Aquí se cubren:
//   · src/**          → React + TypeScript
//   · supabase/functions/** → Deno (globals propios, sin DOM de Vite)
//   · scripts/**      → Node
// =====================================================================

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

/** Reglas de estilo acordadas por el equipo, comunes a todo el repo. */
const estiloComun = {
  "quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
  "semi": ["error", "always"],
  "no-var": "error",
  "prefer-const": "error",
  "eqeqeq": ["error", "always", { null: "ignore" }],
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-trailing-spaces": "error",
  "no-multiple-empty-lines": ["error", { max: 1, maxEOF: 0 }],
  "space-before-blocks": ["error", "always"],
  "object-shorthand": ["error", "always"],
  "no-throw-literal": "error",
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "supabase/.temp/**",
      "*.config.js",
    ],
  },

  // ------------------------------------------------------------------
  // Frontend React + TypeScript
  // ------------------------------------------------------------------
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...estiloComun,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // El tipo `any` deshabilita el chequeo que justifica usar TypeScript.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // Ningún secreto ni dato personal debe terminar en la consola del
      // navegador: sólo se permiten avisos y errores deliberados.
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Usa el cliente de Supabase; no persistas datos sensibles a mano." },
      ],
    },
  },

  // Las pruebas pueden usar utilidades de Node y console.
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ------------------------------------------------------------------
  // Edge Functions (Deno). No comparten tsconfig con el frontend.
  // ------------------------------------------------------------------
  {
    files: ["supabase/functions/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.worker,
        Deno: "readonly",
      },
    },
    rules: {
      ...estiloComun,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      // Las Edge Functions registran con el logger redactor de _shared/log.ts.
      "no-console": ["error", { allow: ["log", "warn", "error"] }],
    },
  },

  // ------------------------------------------------------------------
  // Scripts de operación (Node)
  // ------------------------------------------------------------------
  {
    files: ["scripts/**/*.{mjs,js}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...estiloComun,
      "no-console": "off",
    },
  },
);

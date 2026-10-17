#!/usr/bin/env bash
# =====================================================================
# ActivaUC · decidir si Netlify debe compilar
# ---------------------------------------------------------------------
# Netlify cobra por despliegue, no por tráfico: medido el 17/10/2026 en
# esta cuenta, 14 despliegues consumieron 210 de los 300 créditos
# mensuales —15 cada uno— mientras el ancho de banda y las peticiones
# juntos no llegaron a 0,3.
#
# Y la mayoría de esos despliegues no cambiaban nada visible: commits de
# documentación, de SQL, de scripts o de Edge Functions, que no tocan el
# archivo compilado. Este script los descarta.
#
# ATENCIÓN A LA SEMÁNTICA, que está invertida respecto a la intuición:
#   · salir con 0  →  Netlify CANCELA el build
#   · salir con 1  →  Netlify COMPILA
#
# Se declara en netlify.toml como `ignore`. Netlify lo ejecuta desde el
# directorio base del sitio.
# =====================================================================
set -uo pipefail

# Rutas que de verdad acaban dentro de lo que se publica. Si ninguna
# cambió, no hay nada nuevo que servir.
#
# netlify.toml está incluido porque define las cabeceras y la
# reescritura; public/ porque Vite copia su contenido a dist/, y ahí
# vive _redirects, sin el cual las rutas profundas dan 404.
RUTAS=(
  src
  public
  index.html
  package.json
  package-lock.json
  vite.config.ts
  tsconfig.json
  tsconfig.app.json
  tsconfig.node.json
  netlify.toml
)

# Primer despliegue, o sin referencia previa: compilar. Es la dirección
# segura, porque equivocarse hacia «no compilar» deja el sitio viejo
# publicado sin que nadie se entere.
if [[ -z "${CACHED_COMMIT_REF:-}" || -z "${COMMIT_REF:-}" ]]; then
  echo "Sin referencia previa: se compila."
  exit 1
fi

if git diff --quiet "$CACHED_COMMIT_REF" "$COMMIT_REF" -- "${RUTAS[@]}"; then
  echo "Nada que afecte al sitio cambió entre $CACHED_COMMIT_REF y $COMMIT_REF."
  echo "Se cancela el build para no gastar un despliegue."
  echo "Rutas vigiladas: ${RUTAS[*]}"
  exit 0
fi

echo "Cambios en el frontend: se compila."
git diff --name-only "$CACHED_COMMIT_REF" "$COMMIT_REF" -- "${RUTAS[@]}" | sed 's/^/  /'
exit 1

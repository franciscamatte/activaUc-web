#!/usr/bin/env bash
# =====================================================================
# ActivaUC · ajustes posteriores a publicar el frontend
# ---------------------------------------------------------------------
# Al publicar el frontend en un dominio público hay cuatro cosas que
# ajustar, y sin ellas la página carga pero el inicio de sesión y Google
# Calendar fallan. Este script hace las dos que se pueden automatizar e
# imprime las otras dos, que viven en paneles ajenos.
#
#   bash scripts/configurar-publicacion.sh https://activauc.netlify.app
#
# Es idempotente: se puede volver a correr al cambiar de dominio.
# =====================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROYECTO="$(dirname "$AQUI")"
cd "$PROYECTO"

URL="${1:-}"
if [[ -z "$URL" ]]; then
  cat >&2 <<'EOF'
Falta la URL pública.

  bash scripts/configurar-publicacion.sh https://tu-dominio.example

Es la que te dio Netlify, Vercel o quien aloje el frontend, sin barra
al final.
EOF
  exit 2
fi

# Normalización: sin barra final, y exigiendo https salvo en localhost.
URL="${URL%/}"
if [[ ! "$URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  if [[ "$URL" =~ ^http://localhost(:[0-9]+)?$ ]]; then
    echo "Aviso: localhost no necesita esto; la aplicación usa su propio origen." >&2
  else
    echo "La URL debe ser https://host, sin ruta ni barra final: $URL" >&2
    exit 2
  fi
fi

SECRETOS=".env.secrets"
if [[ ! -f "$SECRETOS" ]]; then
  echo "No existe $SECRETOS. Ver docs/CONFIGURACION_SUPABASE.md." >&2
  exit 1
fi

# ---------------------------------------------------------------------
# 1 · APP_URL y APP_ALLOWED_ORIGINS en los secretos del backend
# ---------------------------------------------------------------------
# APP_ALLOWED_ORIGINS es la lista blanca de CORS de las Edge Functions:
# si no está el dominio, el navegador recibe un rechazo en cada llamada.
fijar() {
  local clave="$1" valor="$2"
  if grep -qE "^${clave}=" "$SECRETOS"; then
    # Reemplazo con python para no pelearse con los caracteres del valor.
    python3 - "$SECRETOS" "$clave" "$valor" <<'PY'
import io, re, sys
ruta, clave, valor = sys.argv[1], sys.argv[2], sys.argv[3]
with io.open(ruta, encoding="utf-8") as f:
    t = f.read()
t = re.sub(r"(?m)^%s=.*$" % re.escape(clave), lambda m: "%s=%s" % (clave, valor), t, count=1)
with io.open(ruta, "w", encoding="utf-8", newline="\n") as f:
    f.write(t)
PY
  else
    printf '%s=%s\n' "$clave" "$valor" >> "$SECRETOS"
  fi
  echo "   $clave=$valor"
}

echo "1) Secretos del backend"
fijar APP_URL "$URL"
fijar APP_ALLOWED_ORIGINS "$URL"

echo ""
echo "2) Cargando los secretos y redesplegando las funciones"
bash scripts/set-secrets.sh >/dev/null || { echo "   ✖ Falló la carga de secretos."; exit 1; }
echo "   ✔ secretos cargados"
bash scripts/deploy-functions.sh >/dev/null || { echo "   ✖ Falló el despliegue."; exit 1; }
echo "   ✔ funciones redesplegadas"

# ---------------------------------------------------------------------
# 3 y 4 · Lo que vive en paneles ajenos
# ---------------------------------------------------------------------
REF="$(grep -E '^VITE_SUPABASE_URL=' .env 2>/dev/null \
  | sed -E 's#.*//([^.]+)\..*#\1#' | tr -d '[:space:]')"

cat <<EOF

3) Supabase · Authentication → URL Configuration
   (https://supabase.com/dashboard/project/${REF:-<ref>}/auth/url-configuration)

   Site URL:
     $URL

   Redirect URLs — añade estas tres:
     $URL/auth/callback
     $URL/restablecer-contrasena
     $URL/verificar

4) Google Cloud · APIs y servicios → Credenciales → tu cliente OAuth

   En «Orígenes autorizados de JavaScript» añade:
     $URL

   El URI de redireccionamiento NO cambia: sigue apuntando a la Edge
   Function de Supabase, no al frontend.

Y por último, compila con el .env de producción:

   npm run build

VITE_APP_URL debe estar VACÍO en .env para que el compilado use el
origen desde el que se sirve. Si le pones un valor, queda dentro del
archivo y publicar un build hecho en localhost rompe los redirectos.
EOF

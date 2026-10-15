#!/usr/bin/env bash
# =====================================================================
# ActivaUC · despliegue del frontend a S3 + CloudFront
# ---------------------------------------------------------------------
# Compila la SPA y la publica con las cabeceras de caché correctas:
#
#   · /assets/**  → immutable, 1 año (los nombres llevan hash)
#   · index.html  → no-cache (para que un despliegue se vea de inmediato)
#
# Después invalida CloudFront y, opcionalmente, espera la invalidación.
#
# Requisitos:
#   · AWS CLI configurado con permisos de s3:PutObject y
#     cloudfront:CreateInvalidation
#   · Variables en el entorno o en .env.deploy:
#       AWS_S3_BUCKET            nombre del bucket
#       AWS_CLOUDFRONT_ID        id de la distribución
#       VITE_SUPABASE_URL        URL del proyecto de Supabase
#       VITE_SUPABASE_ANON_KEY   clave pública (anon)
#       VITE_APP_URL             URL pública del sitio
#
# Uso:
#   bash scripts/deploy-frontend.sh
#   bash scripts/deploy-frontend.sh --dry-run
#   bash scripts/deploy-frontend.sh --esperar
# =====================================================================
set -euo pipefail

DRY_RUN=0
ESPERAR=0
ARCHIVO_ENTORNO=".env.deploy"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --esperar) ESPERAR=1; shift ;;
    --entorno) ARCHIVO_ENTORNO="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Opción no reconocida: $1" >&2; exit 2 ;;
  esac
done

if [[ -f "$ARCHIVO_ENTORNO" ]]; then
  echo "Cargando configuración de $ARCHIVO_ENTORNO"
  # shellcheck disable=SC1090
  set -a; source "$ARCHIVO_ENTORNO"; set +a
fi

# ---------------------------------------------------------------------
# Validación
# ---------------------------------------------------------------------
FALTANTES=()
for nombre in AWS_S3_BUCKET AWS_CLOUDFRONT_ID VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY VITE_APP_URL; do
  [[ -z "${!nombre:-}" ]] && FALTANTES+=("$nombre")
done

if [[ ${#FALTANTES[@]} -gt 0 ]]; then
  echo "Faltan variables requeridas:" >&2
  for nombre in "${FALTANTES[@]}"; do echo "  · $nombre" >&2; done
  echo "" >&2
  echo "Define las variables o crea $ARCHIVO_ENTORNO (ver docs/DESPLIEGUE_AWS.md)." >&2
  exit 1
fi

# Una compilación de producción en modo mock sería una demo disfrazada:
# la aplicación misma la rechaza, y aquí se detiene antes de compilar.
if [[ "${VITE_DATA_MODE:-supabase}" == "mock" ]]; then
  echo "VITE_DATA_MODE=mock no es válido para producción. Usa 'supabase'." >&2
  exit 1
fi
export VITE_DATA_MODE="${VITE_DATA_MODE:-supabase}"

# Defensa: la clave anon es pública, pero la service role NUNCA debe ir
# al bundle. Se detecta por el claim "role" del JWT.
if printf '%s' "$VITE_SUPABASE_ANON_KEY" | cut -d. -f2 \
   | tr '_-' '/+' | base64 -d 2>/dev/null | grep -q 'service_role'; then
  echo "ERROR: VITE_SUPABASE_ANON_KEY parece una service_role key." >&2
  echo "Esa clave otorga acceso total y jamás debe compilarse en el frontend." >&2
  exit 1
fi

for herramienta in aws npm; do
  command -v "$herramienta" >/dev/null || { echo "Falta $herramienta en el PATH." >&2; exit 1; }
done

# ---------------------------------------------------------------------
# Compilación
# ---------------------------------------------------------------------
echo ""
echo "── Verificaciones previas"
npm run lint
npm run typecheck
npm run test

echo ""
echo "── Compilando para producción"
rm -rf dist
npm run build

if [[ ! -f dist/index.html ]]; then
  echo "La compilación no generó dist/index.html." >&2
  exit 1
fi

# ---------------------------------------------------------------------
# Red de seguridad: ningún VALOR secreto puede acabar publicado.
# ---------------------------------------------------------------------
# Se buscan valores con forma de secreto, no nombres de variables: el
# código legítimamente menciona "service_role" (la comprobación que
# impide usar esa clave por error) y los comentarios citan los nombres
# de los secretos de backend. Buscar nombres daría falsos positivos en
# cada despliegue, que es la forma más rápida de que nadie mire la
# alerta.
#
# Sólo se revisan los archivos que realmente se suben: los mapas de
# origen (*.map) se generan para depuración local y quedan excluidos de
# la subida más abajo.
echo ""
echo "── Revisando el paquete generado"

ARCHIVOS_PUBLICADOS=$(find dist -type f ! -name '*.map')

# 1. Un JWT de Supabase cuyo claim "role" sea service_role. Eso sí sería
#    una filtración grave: esa clave omite por completo RLS.
JWT_PELIGROSO=$(
  grep -rhoE 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+' $ARCHIVOS_PUBLICADOS 2>/dev/null   | sort -u   | while read -r jwt; do
      payload=$(printf '%s' "$jwt" | cut -d. -f2 | tr '_-' '/+')
      padding=$(( (4 - ${#payload} % 4) % 4 ))
      [[ $padding -gt 0 ]] && payload="$payload$(printf '=%.0s' $(seq 1 $padding))"
      if printf '%s' "$payload" | base64 -d 2>/dev/null | grep -q 'service_role'; then
        echo "$jwt"
      fi
    done
)

if [[ -n "$JWT_PELIGROSO" ]]; then
  echo "  ✖ El paquete contiene un JWT con rol service_role." >&2
  echo "    Esa clave omite RLS y jamás debe publicarse." >&2
  exit 1
fi

# 2. Formatos de secreto inequívocos de los proveedores.
declare -A FORMATOS=(
  ["GOCSPX-"]="secreto de cliente de Google OAuth"
  ["sk_live_"]="clave secreta de producción"
  ["SG."]="clave de API de SendGrid"
)
ENCONTRADOS=0
for formato in "${!FORMATOS[@]}"; do
  if grep -rqF "$formato" $ARCHIVOS_PUBLICADOS 2>/dev/null; then
    echo "  ✖ El paquete contiene un ${FORMATOS[$formato]} («$formato…»)." >&2
    ENCONTRADOS=1
  fi
done

# 3. Los valores concretos que este despliegue tiene en el entorno, si
#    alguno se hubiera filtrado al paquete por error.
for nombre in GOOGLE_CLIENT_SECRET TWILIO_AUTH_TOKEN ENCRYPTION_KEY CRON_SECRET               SUPABASE_SERVICE_ROLE_KEY; do
  valor="${!nombre:-}"
  # Se ignoran los valores muy cortos para no buscar cadenas triviales.
  [[ ${#valor} -lt 16 ]] && continue
  if grep -rqF "$valor" $ARCHIVOS_PUBLICADOS 2>/dev/null; then
    echo "  ✖ El paquete contiene el valor de $nombre." >&2
    ENCONTRADOS=1
  fi
done

if [[ "$ENCONTRADOS" -eq 1 ]]; then
  echo "Despliegue abortado: hay valores secretos en dist/." >&2
  exit 1
fi
echo "  ✔ Sin valores secretos en los archivos que se publicarán"

EXTRA=()
[[ "$DRY_RUN" -eq 1 ]] && EXTRA+=(--dryrun)

# ---------------------------------------------------------------------
# Subida a S3, en dos pasadas por las cabeceras de caché
# ---------------------------------------------------------------------
echo ""
echo "── Subiendo activos con hash (caché de 1 año)"
aws s3 sync dist/ "s3://${AWS_S3_BUCKET}/" \
  "${EXTRA[@]}" \
  --delete \
  --exclude "index.html" \
  --exclude "*.map" \
  --cache-control "public, max-age=31536000, immutable"

echo ""
echo "── Subiendo index.html (sin caché)"
aws s3 cp dist/index.html "s3://${AWS_S3_BUCKET}/index.html" \
  "${EXTRA[@]}" \
  --cache-control "public, max-age=0, must-revalidate" \
  --content-type "text/html; charset=utf-8"

if [[ -f dist/favicon.svg ]]; then
  aws s3 cp dist/favicon.svg "s3://${AWS_S3_BUCKET}/favicon.svg" \
    "${EXTRA[@]}" \
    --cache-control "public, max-age=86400" \
    --content-type "image/svg+xml"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo ""
  echo "Modo simulación: no se subió nada ni se invalidó la caché."
  exit 0
fi

# ---------------------------------------------------------------------
# Invalidación de CloudFront
# ---------------------------------------------------------------------
echo ""
echo "── Invalidando CloudFront"
INVALIDACION=$(aws cloudfront create-invalidation \
  --distribution-id "$AWS_CLOUDFRONT_ID" \
  --paths "/index.html" "/" \
  --query 'Invalidation.Id' \
  --output text)

echo "  Invalidación creada: $INVALIDACION"

if [[ "$ESPERAR" -eq 1 ]]; then
  echo "  Esperando a que se complete…"
  aws cloudfront wait invalidation-completed \
    --distribution-id "$AWS_CLOUDFRONT_ID" \
    --id "$INVALIDACION"
  echo "  Invalidación completada."
fi

cat <<EOF

Despliegue terminado: $VITE_APP_URL

Sólo se invalidó /index.html porque los activos llevan hash en el nombre
y nunca se reutilizan entre versiones.

Comprobaciones:
  · curl -I "$VITE_APP_URL"                 → 200 y Cache-Control no-cache
  · curl -I "$VITE_APP_URL/mis-reservas"    → 200 (SPA fallback a index.html)
  · Abre el sitio y revisa que no haya errores en la consola.
EOF

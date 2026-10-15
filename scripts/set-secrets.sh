#!/usr/bin/env bash
# =====================================================================
# ActivaUC · carga de secretos en Supabase Edge Functions
# ---------------------------------------------------------------------
# Lee los secretos de un archivo local (por omisión .env.secrets, que
# está en .gitignore) y los sube con `supabase secrets set`.
#
# Este script NO contiene ninguna credencial: sólo los nombres de las
# variables que espera encontrar.
#
# Uso:
#   cp .env.secrets.example .env.secrets     # y completa los valores
#   bash scripts/set-secrets.sh              # proyecto ya vinculado
#   bash scripts/set-secrets.sh --archivo otro.env --proyecto abcdefgh
# =====================================================================
set -euo pipefail

ARCHIVO=".env.secrets"
PROYECTO=""
SOLO_VERIFICAR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archivo)  ARCHIVO="$2"; shift 2 ;;
    --proyecto) PROYECTO="$2"; shift 2 ;;
    --verificar) SOLO_VERIFICAR=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Opción no reconocida: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------
# Secretos que usan las Edge Functions.
# ---------------------------------------------------------------------
OBLIGATORIOS=(
  ENCRYPTION_KEY            # clave AES-256-GCM en base64 (32 bytes)
  CRON_SECRET               # autentica a pg_cron frente a los workers
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GOOGLE_REDIRECT_URI
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  TWILIO_WHATSAPP_FROM
  APP_URL                   # origen público del frontend
)

OPCIONALES=(
  APP_ALLOWED_ORIGINS           # lista de orígenes permitidos para CORS
  APP_TIME_ZONE                 # por omisión America/Santiago
  TWILIO_STATUS_CALLBACK_URL    # webhook público de estados
  TWILIO_WEBHOOK_URL            # URL exacta que firma Twilio
  TWILIO_CONTENT_SID_CONFIRMACION
  TWILIO_CONTENT_SID_RECORDATORIO
  TWILIO_CONTENT_SID_CANCELACION
)

# SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los inyecta
# Supabase automáticamente en cada Edge Function: NO deben cargarse aquí.
RESERVADOS=(SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL)

if [[ ! -f "$ARCHIVO" ]]; then
  cat >&2 <<EOF
No se encontró el archivo de secretos: $ARCHIVO

  1. cp .env.secrets.example $ARCHIVO
  2. completa los valores (ver docs/CONFIGURACION_SUPABASE.md)
  3. vuelve a ejecutar este script

El archivo está ignorado por Git y nunca debe versionarse.
EOF
  exit 1
fi

# ---------------------------------------------------------------------
# Validación antes de subir nada.
# ---------------------------------------------------------------------
# shellcheck disable=SC1090
set -a; source "$ARCHIVO"; set +a

FALTANTES=()
for nombre in "${OBLIGATORIOS[@]}"; do
  if [[ -z "${!nombre:-}" ]]; then
    FALTANTES+=("$nombre")
  fi
done

if [[ ${#FALTANTES[@]} -gt 0 ]]; then
  echo "Faltan secretos obligatorios en $ARCHIVO:" >&2
  for nombre in "${FALTANTES[@]}"; do echo "  · $nombre" >&2; done
  exit 1
fi

for nombre in "${RESERVADOS[@]}"; do
  if [[ -n "${!nombre:-}" ]]; then
    cat >&2 <<EOF
$nombre está definido en $ARCHIVO, pero Supabase lo inyecta
automáticamente en las Edge Functions y rechaza cargarlo como secreto.
Quítalo del archivo y vuelve a ejecutar.
EOF
    exit 1
  fi
done

# ENCRYPTION_KEY debe ser exactamente 32 bytes en base64: si es más
# corta, el cifrado de los tokens OAuth falla al ejecutarse.
BYTES=$(printf '%s' "$ENCRYPTION_KEY" | base64 -d 2>/dev/null | wc -c || echo 0)
if [[ "$BYTES" -ne 32 ]]; then
  cat >&2 <<EOF
ENCRYPTION_KEY debe ser una clave de 32 bytes codificada en base64
(se detectaron $BYTES bytes). Genera una con:

  openssl rand -base64 32
EOF
  exit 1
fi

if [[ ${#CRON_SECRET} -lt 24 ]]; then
  echo "CRON_SECRET es demasiado corto. Genera uno con: openssl rand -hex 32" >&2
  exit 1
fi

if [[ "$GOOGLE_REDIRECT_URI" != https://* && "$GOOGLE_REDIRECT_URI" != http://localhost* ]]; then
  echo "GOOGLE_REDIRECT_URI debe usar https:// (o http://localhost en desarrollo)." >&2
  exit 1
fi

echo "Validación correcta: ${#OBLIGATORIOS[@]} secretos obligatorios presentes."

if [[ "$SOLO_VERIFICAR" -eq 1 ]]; then
  echo "Modo verificación: no se cargó nada."
  exit 0
fi

# ---------------------------------------------------------------------
# Carga.
# ---------------------------------------------------------------------
ARGS=()
[[ -n "$PROYECTO" ]] && ARGS+=(--project-ref "$PROYECTO")

PARES=()
for nombre in "${OBLIGATORIOS[@]}" "${OPCIONALES[@]}"; do
  valor="${!nombre:-}"
  [[ -z "$valor" ]] && continue
  PARES+=("$nombre=$valor")
  echo "  · $nombre (cargado)"
done

echo "Subiendo ${#PARES[@]} secretos a Supabase…"
npx supabase secrets set "${ARGS[@]}" "${PARES[@]}"

cat <<EOF

Secretos cargados. Pasos siguientes:

  1. Despliega las funciones para que tomen los valores nuevos:
       bash scripts/deploy-functions.sh

  2. Programa las tareas de integración (una vez por entorno):
       psql "\$SUPABASE_DB_URL" \\
         -v functions_base_url="https://<ref>.supabase.co/functions/v1" \\
         -v cron_secret="\$CRON_SECRET" \\
         -f supabase/cron/schedule.sql

  3. Verifica con: npx supabase secrets list
EOF

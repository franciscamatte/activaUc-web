#!/usr/bin/env bash
# =====================================================================
# ActivaUC · despliegue de Edge Functions
# ---------------------------------------------------------------------
# Despliega las siete funciones del backend respetando la verificación
# de JWT que cada una necesita (definida en supabase/config.toml).
#
# Uso:
#   bash scripts/deploy-functions.sh                  # proyecto vinculado
#   bash scripts/deploy-functions.sh --proyecto abcd  # por referencia
#   bash scripts/deploy-functions.sh --solo process-calendar-jobs
# =====================================================================
set -euo pipefail

# Node sólo está disponible dentro de WSL en algunos equipos, así que la
# CLI se resuelve igual que en el resto de los scripts.
AQUI_DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/node-env.sh
source "$AQUI_DEPLOY/lib/node-env.sh"
cd "$(dirname "$AQUI_DEPLOY")"

PROYECTO=""
SOLO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --proyecto) PROYECTO="$2"; shift 2 ;;
    --solo)     SOLO="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Opción no reconocida: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------
# Funciones y su política de verificación de JWT.
#   true  → exige un usuario autenticado
#   false → endpoint público que se autentica por su cuenta (state
#           firmado de OAuth, firma de Twilio, encabezado x-cron-secret)
# ---------------------------------------------------------------------
declare -A FUNCIONES=(
  [google-oauth-start]=true
  [google-oauth-callback]=false
  [google-calendar-disconnect]=true
  [process-calendar-jobs]=false
  [process-notification-jobs]=false
  [twilio-status-webhook]=false
  [cron-dispatch]=false
)

ARGS=()
[[ -n "$PROYECTO" ]] && ARGS+=(--project-ref "$PROYECTO")

desplegar() {
  local nombre="$1"
  local verifica="${FUNCIONES[$nombre]:-}"

  if [[ -z "$verifica" ]]; then
    echo "Función desconocida: $nombre" >&2
    echo "Disponibles: ${!FUNCIONES[*]}" >&2
    exit 2
  fi

  if [[ ! -f "supabase/functions/$nombre/index.ts" ]]; then
    echo "No existe supabase/functions/$nombre/index.ts" >&2
    exit 1
  fi

  local extra=()
  [[ "$verifica" == "false" ]] && extra+=(--no-verify-jwt)

  echo ""
  echo "── Desplegando $nombre (verify_jwt=$verifica)"
  npx supabase functions deploy "$nombre" "${ARGS[@]}" "${extra[@]}"
}

if [[ -n "$SOLO" ]]; then
  desplegar "$SOLO"
else
  for nombre in google-oauth-start google-oauth-callback google-calendar-disconnect \
                process-calendar-jobs process-notification-jobs \
                twilio-status-webhook cron-dispatch; do
    desplegar "$nombre"
  done
fi

cat <<EOF

Despliegue terminado.

Verificaciones recomendadas (ver docs/OPERACION.md):

  · Workers accesibles sólo con credencial:
      curl -i -X POST "\$SUPABASE_URL/functions/v1/process-calendar-jobs"
      → debe responder 401

  · Despacho manual de las colas:
      curl -s -X POST "\$SUPABASE_URL/functions/v1/cron-dispatch" \\
        -H "x-cron-secret: \$CRON_SECRET" | jq

  · Registros de una función:
      # La CLI no tiene 'functions logs': se leen en el panel
      #   https://supabase.com/dashboard/project/<ref>/functions/process-notification-jobs/logs
EOF

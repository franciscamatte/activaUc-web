#!/usr/bin/env bash
# =====================================================================
# ActivaUC · CLI de Supabase desde WSL
# ---------------------------------------------------------------------
# En este equipo Node sólo existe dentro de WSL, así que la CLI de
# Supabase no se puede invocar directamente desde PowerShell. Este
# envoltorio resuelve Node y reenvía los argumentos tal cual.
#
# Desde Windows (PowerShell):
#   wsl -d Ubuntu-24.04 -- bash /mnt/c/.../scripts/supabase-cli.sh login
#   wsl -d Ubuntu-24.04 -- bash /mnt/c/.../scripts/supabase-cli.sh projects list
#
# Desde WSL:
#   bash scripts/supabase-cli.sh db push
#
# Mantiene la entrada estándar conectada, de modo que los comandos
# interactivos (login, confirmaciones de db push) funcionan igual que en
# una terminal normal.
# =====================================================================
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROYECTO="$(dirname "$AQUI")"

# shellcheck source=lib/node-env.sh
source "$AQUI/lib/node-env.sh"

cd "$PROYECTO"

if [ "$#" -eq 0 ]; then
  echo "Uso: bash scripts/supabase-cli.sh <comando de supabase>" >&2
  echo "Ejemplos: login · link --project-ref <ref> · db push · secrets list" >&2
  exit 2
fi

exec npx --yes supabase "$@"

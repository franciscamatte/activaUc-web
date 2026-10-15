#!/usr/bin/env bash
# =====================================================================
# ActivaUC · servidor de desarrollo desde WSL
# ---------------------------------------------------------------------
# En este equipo Node.js no está instalado en Windows, sólo dentro de
# WSL. Este script levanta el servidor de Vite desde WSL y lo deja
# accesible en http://localhost:5173 desde Windows.
#
# Lo usa .claude/launch.json. También sirve a mano:
#   wsl -d Ubuntu-24.04 -- bash /mnt/c/.../scripts/dev-wsl.sh
#
# Si tienes Node instalado en Windows, no necesitas nada de esto:
# cambia launch.json a runtimeExecutable "npm" con runtimeArgs
# ["run", "dev"].
# =====================================================================
set -euo pipefail

# ---------------------------------------------------------------------
# Ubicación del proyecto: se deriva de la del propio script, para no
# depender de rutas absolutas escritas a mano.
# ---------------------------------------------------------------------
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROYECTO="$(dirname "$AQUI")"
cd "$PROYECTO"

# ---------------------------------------------------------------------
# Node (ver scripts/lib/node-env.sh para el porqué de cada fallback)
# ---------------------------------------------------------------------
# shellcheck source=lib/node-env.sh
source "$AQUI/lib/node-env.sh"

# ---------------------------------------------------------------------
# Dependencias
# ---------------------------------------------------------------------
if [ ! -d node_modules ]; then
  echo "node_modules no existe; instalando dependencias…"
  npm install --no-audit --no-fund
fi

# ---------------------------------------------------------------------
# Opciones del servidor
# ---------------------------------------------------------------------
# · --host 0.0.0.0 para que el reenvío de puertos de WSL2 lo exponga en
#   localhost desde Windows.
# · --strictPort para que el puerto coincida con el declarado en
#   launch.json; si estuviera ocupado, es mejor fallar que escuchar en
#   otro y dejar la vista previa apuntando al lugar equivocado.
# · VITE_USE_POLLING porque inotify no entrega eventos para archivos en
#   /mnt/c, así que sin sondeo el recargado en caliente no reacciona
#   (ver vite.config.ts).
export VITE_USE_POLLING=true

echo "ActivaUC · servidor de desarrollo"
echo "  proyecto: $PROYECTO"
echo "  node:     $(node -v)   npm: $(npm -v)"
echo "  modo:     ${VITE_DATA_MODE:-el definido en .env}"
echo ""

exec npm run dev -- --host 0.0.0.0 --port "${PORT:-5173}" --strictPort

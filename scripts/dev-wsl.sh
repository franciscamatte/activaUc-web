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
# PATH
# ---------------------------------------------------------------------
# WSL añade el PATH de Windows, que contiene rutas con espacios
# («Program Files»). Se construye un PATH limpio y propio de Linux: el
# servidor de desarrollo no necesita herramientas de Windows, y así se
# evitan errores de división por espacios.
#
# $HOME puede venir heredado del entorno de Windows, así que el
# directorio del usuario se obtiene de /etc/passwd.
CASA="$(getent passwd "$(id -u)" | cut -d: -f6)"
BASE="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Orden de preferencia para encontrar Node:
#   1. nvm, que es como está instalado en este equipo. nvm se inicializa
#      en .bashrc, que un shell no interactivo no lee, así que hay que
#      apuntar directamente al directorio de la versión.
#   2. ~/.activauc-tools/node-current, instalación independiente.
#   3. El PATH del sistema (apt, fnm, volta…).
NVM_NODE=""
if [ -d "$CASA/.nvm/versions/node" ]; then
  # La versión más alta disponible, ordenada por número de versión.
  NVM_NODE="$(ls -1 "$CASA/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
fi

if [ -n "$NVM_NODE" ] && [ -x "$CASA/.nvm/versions/node/$NVM_NODE/bin/node" ]; then
  export PATH="$CASA/.nvm/versions/node/$NVM_NODE/bin:$BASE"
elif [ -x "$CASA/.activauc-tools/node-current/bin/node" ]; then
  export PATH="$CASA/.activauc-tools/node-current/bin:$BASE"
else
  export PATH="$BASE:${PATH:-}"
fi

if ! command -v npm >/dev/null 2>&1; then
  cat >&2 <<EOF
No se encontró npm dentro de WSL.

Se buscó en:
  $CASA/.nvm/versions/node/*/bin
  $CASA/.activauc-tools/node-current/bin
  y en el PATH del sistema.

Instala Node.js 20.19 o superior. Con nvm:

  nvm install --lts

O sin privilegios de administrador, en tu directorio personal:

  mkdir -p ~/.activauc-tools && cd ~/.activauc-tools
  VER=v24.22.0
  curl -fsSL "https://nodejs.org/dist/\$VER/node-\$VER-linux-x64.tar.xz" | tar -xJ
  ln -sfn ~/.activauc-tools/node-\$VER-linux-x64 ~/.activauc-tools/node-current
EOF
  exit 1
fi

# Vite 8 requiere Node 20.19 o superior.
MAYOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAYOR" -lt 20 ]; then
  echo "Node $(node -v) es demasiado antiguo: se requiere 20.19 o superior." >&2
  exit 1
fi

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

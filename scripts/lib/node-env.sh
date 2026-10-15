#!/usr/bin/env bash
# =====================================================================
# ActivaUC · resolución de Node.js dentro de WSL
# ---------------------------------------------------------------------
# Para incluir con `source`. Deja en el PATH un Node utilizable y aborta
# con un mensaje claro si no encuentra ninguno.
#
# Existe porque en este equipo Node sólo está instalado dentro de WSL
# (con nvm), y nvm se inicializa en .bashrc, que los shells no
# interactivos no leen. Además, WSL añade al PATH las rutas de Windows,
# que contienen espacios («Program Files») y rompen las asignaciones sin
# comillas, así que se construye un PATH limpio de Linux.
# =====================================================================

# $HOME puede venir heredado del entorno de Windows, así que el
# directorio del usuario se obtiene de /etc/passwd.
ACTIVAUC_CASA="$(getent passwd "$(id -u)" | cut -d: -f6)"
ACTIVAUC_PATH_BASE="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Orden de preferencia: nvm (como está en este equipo), instalación
# independiente en ~/.activauc-tools, y por último el PATH del sistema.
ACTIVAUC_NVM_VER=""
if [ -d "$ACTIVAUC_CASA/.nvm/versions/node" ]; then
  ACTIVAUC_NVM_VER="$(ls -1 "$ACTIVAUC_CASA/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
fi

if [ -n "$ACTIVAUC_NVM_VER" ] &&
   [ -x "$ACTIVAUC_CASA/.nvm/versions/node/$ACTIVAUC_NVM_VER/bin/node" ]; then
  export PATH="$ACTIVAUC_CASA/.nvm/versions/node/$ACTIVAUC_NVM_VER/bin:$ACTIVAUC_PATH_BASE"
elif [ -x "$ACTIVAUC_CASA/.activauc-tools/node-current/bin/node" ]; then
  export PATH="$ACTIVAUC_CASA/.activauc-tools/node-current/bin:$ACTIVAUC_PATH_BASE"
else
  export PATH="$ACTIVAUC_PATH_BASE:${PATH:-}"
fi

if ! command -v npm >/dev/null 2>&1; then
  cat >&2 <<EOF
No se encontró npm dentro de WSL.

Se buscó en:
  $ACTIVAUC_CASA/.nvm/versions/node/*/bin
  $ACTIVAUC_CASA/.activauc-tools/node-current/bin
  y en el PATH del sistema.

Instala Node.js 20.19 o superior. Con nvm:

  nvm install --lts
EOF
  return 1 2>/dev/null || exit 1
fi

# Vite 8 y la CLI de Supabase requieren Node 20.19 o superior.
ACTIVAUC_NODE_MAYOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$ACTIVAUC_NODE_MAYOR" -lt 20 ]; then
  echo "Node $(node -v) es demasiado antiguo: se requiere 20.19 o superior." >&2
  return 1 2>/dev/null || exit 1
fi

#!/usr/bin/env bash
# =====================================================================
# ActivaUC · acceso a la base de datos
# ---------------------------------------------------------------------
# Para incluir con `source`. Deja en el entorno:
#   · SUPABASE_DB_URL  → cadena de conexión, SIN la contraseña dentro
#   · PGPASSWORD       → la contraseña
#
# Separarlas es deliberado: así la contraseña no aparece en la lista de
# procesos (donde cualquier usuario del equipo podría leerla con `ps`),
# no queda en el historial del shell, y no hace falta codificar los
# caracteres especiales que tendría dentro de un URI.
#
# Orden de búsqueda: las variables ya definidas en el entorno y, si no,
# el archivo .env.db de la raíz del proyecto (ignorado por Git).
# =====================================================================

ACTIVAUC_RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Lee una clave de .env.db sin ejecutar el archivo, quitando las comillas
# envolventes si las tuviera.
_activauc_leer_env_db() {
  local clave="$1"
  [ -f "$ACTIVAUC_RAIZ/.env.db" ] || return 0
  grep -E "^[[:space:]]*${clave}[[:space:]]*=" "$ACTIVAUC_RAIZ/.env.db" 2>/dev/null |
    tr -d '' |
    tail -1 |
    sed -E "s/^[[:space:]]*${clave}[[:space:]]*=[[:space:]]*//" |
    sed -E 's/^"(.*)"$/\1/' |
    sed -E "s/^'(.*)'$/\1/"
}

if [ -z "${PGPASSWORD:-}" ]; then
  _activauc_clave="$(_activauc_leer_env_db SUPABASE_DB_PASSWORD)"
  if [ -n "$_activauc_clave" ] && [ "$_activauc_clave" != "TU_CLAVE" ]; then
    export PGPASSWORD="$_activauc_clave"
  fi
  unset _activauc_clave
fi

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  _activauc_url="$(_activauc_leer_env_db SUPABASE_DB_URL)"
  if [ -n "$_activauc_url" ]; then
    export SUPABASE_DB_URL="$_activauc_url"
  fi
  unset _activauc_url
fi

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  cat >&2 <<'EOF'
Falta la cadena de conexión a la base de datos.

Prepárala así:

  1. cp .env.db.example .env.db
  2. pon tu contraseña en SUPABASE_DB_PASSWORD
  3. bash scripts/db-connect-test.sh

Ese último paso prueba la conexión directa y los Session pooler, y
escribe en .env.db la variante que funciona. Hace falta porque la
conexión directa de Supabase resuelve sólo por IPv6: en una red IPv4
únicamente sirve el pooler.

.env.db está en .gitignore y nunca debe versionarse.
EOF
  return 1 2>/dev/null || exit 1
fi

# Aviso temprano si quedó un marcador sin reemplazar, que si no daría un
# error de autenticación bastante más opaco.
case "$SUPABASE_DB_URL" in
  *"[YOUR-PASSWORD]"*|*"TU_CLAVE"*|*"TU-REF"*)
    echo "La cadena de .env.db todavía tiene marcadores sin reemplazar." >&2
    echo "Ejecuta: bash scripts/db-connect-test.sh" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

if [ -z "${PGPASSWORD:-}" ]; then
  echo "Falta SUPABASE_DB_PASSWORD en .env.db." >&2
  return 1 2>/dev/null || exit 1
fi

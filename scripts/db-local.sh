#!/usr/bin/env bash
# =====================================================================
# ActivaUC · PostgreSQL propio para las pruebas, sin sudo y sin Docker
# ---------------------------------------------------------------------
# Las suites SQL y la prueba de concurrencia necesitan un PostgreSQL
# donde se pueda crear y borrar bases desechables. Las dos vías que
# documenta PRUEBAS.md fallan en algunos equipos:
#
#   · `supabase start` exige Docker, y la integración de Docker Desktop
#     con WSL puede estar apagada.
#   · El cluster del sistema suele pedir una contraseña que no es la que
#     la documentación supone, y cambiarla exige sudo.
#
# Esto evita las dos: crea un cluster **en la carpeta del usuario**, en
# otro puerto, con autenticación `trust` y `max_connections=200` —el
# valor que la prueba de concurrencia necesita para las 100 solicitudes
# simultáneas del requisito de elasticidad—. No toca el cluster del
# sistema ni necesita privilegios.
#
#   bash scripts/db-local.sh start     # crea si falta, y arranca
#   bash scripts/db-local.sh stop
#   bash scripts/db-local.sh status
#   bash scripts/db-local.sh url       # imprime ACTIVAUC_TEST_DB_URL
#   bash scripts/db-local.sh destroy   # borra el cluster entero
#
# Uso típico:
#
#   bash scripts/db-local.sh start
#   export ACTIVAUC_TEST_DB_URL="$(bash scripts/db-local.sh url)"
#   npm run test:db && npm run test:concurrency
#
# `trust` significa que cualquiera que ya tenga acceso a esta cuenta de
# usuario puede conectarse sin contraseña. Es aceptable porque sólo
# escucha en 127.0.0.1 y porque dentro no hay nada: cada prueba crea su
# base desechable y la borra. **No sirve para datos de verdad.**
# =====================================================================
set -euo pipefail

PUERTO="${ACTIVAUC_PG_PUERTO:-54329}"
BASE="${ACTIVAUC_PG_DIR:-$HOME/activauc-pg}"
DATOS="$BASE/data"

# Las herramientas del servidor no están en el PATH por omisión: viven
# en el directorio de la versión. Se toma la más alta que haya.
encontrar_bin() {
  local candidato
  for candidato in /usr/lib/postgresql/*/bin; do
    [ -x "$candidato/initdb" ] && echo "$candidato"
  done | sort -V | tail -1
}

BIN="$(encontrar_bin || true)"
if [ -z "${BIN:-}" ]; then
  cat >&2 <<'EOF'
No encontré las herramientas de servidor de PostgreSQL.

  sudo apt install postgresql

Hace falta `initdb` y `pg_ctl`, que vienen en ese paquete y no en
postgresql-client.
EOF
  exit 1
fi

url() { echo "postgresql://postgres@127.0.0.1:$PUERTO/postgres"; }

arrancar() {
  mkdir -p "$BASE"
  if [ ! -s "$DATOS/PG_VERSION" ]; then
    echo "Creando el cluster en $DATOS…"
    "$BIN/initdb" -D "$DATOS" -U postgres --auth=trust \
      --encoding=UTF8 --locale=C > "$BASE/initdb.log" 2>&1
  fi

  if "$BIN/pg_isready" -h 127.0.0.1 -p "$PUERTO" -q 2>/dev/null; then
    echo "Ya estaba escuchando en el puerto $PUERTO."
  else
    # -k /tmp: el socket va a /tmp porque /var/run/postgresql es del
    # usuario postgres y aquí no se escribe como root.
    "$BIN/pg_ctl" -D "$DATOS" -l "$BASE/server.log" \
      -o "-p $PUERTO -c max_connections=200 -k /tmp -c listen_addresses=127.0.0.1" \
      start > /dev/null 2>&1 || true

    local intento
    for intento in $(seq 1 20); do
      if "$BIN/pg_isready" -h 127.0.0.1 -p "$PUERTO" -q 2>/dev/null; then break; fi
      sleep 1
    done
  fi

  if ! "$BIN/pg_isready" -h 127.0.0.1 -p "$PUERTO"; then
    echo "" >&2
    echo "No llegó a aceptar conexiones. Últimas líneas del registro:" >&2
    tail -10 "$BASE/server.log" >&2
    exit 1
  fi

  echo ""
  echo "Para usarlo:"
  echo "  export ACTIVAUC_TEST_DB_URL=\"$(url)\""
}

case "${1:-start}" in
  start)   arrancar ;;
  stop)    "$BIN/pg_ctl" -D "$DATOS" stop -m fast ;;
  status)  "$BIN/pg_ctl" -D "$DATOS" status || true
           "$BIN/pg_isready" -h 127.0.0.1 -p "$PUERTO" || true ;;
  url)     url ;;
  destroy) "$BIN/pg_ctl" -D "$DATOS" stop -m immediate > /dev/null 2>&1 || true
           rm -rf "$BASE"
           echo "Cluster borrado: $BASE" ;;
  -h|--help) sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "Uso: $0 {start|stop|status|url|destroy}" >&2; exit 2 ;;
esac

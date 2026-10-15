#!/usr/bin/env bash
# =====================================================================
# ActivaUC · encontrar la cadena de conexión que funciona
# ---------------------------------------------------------------------
# Supabase ofrece varios puntos de entrada a la base de datos, y cuál
# sirve depende de la red y de la región del proyecto:
#
#   · Conexión directa (db.<ref>.supabase.co)
#       Sólo publica registro AAAA: en una red sin IPv6 falla siempre.
#   · Session pooler (aws-N-<region>.pooler.supabase.com:5432)
#       IPv4 y mantiene la sesión. Es el que sirve para psql y para los
#       scripts transaccionales de este proyecto.
#   · Transaction pooler (mismo host, puerto 6543)
#       IPv4 pero sin estado entre sentencias: no sirve aquí.
#
# El usuario del pooler es «postgres.<ref>», no «postgres»: con el
# segundo responde «no tenant identifier provided».
#
# Este script prueba las combinaciones con la contraseña de .env.db y
# escribe en ese mismo archivo la que conecta. La contraseña nunca se
# imprime: sólo se informa qué host respondió.
#
# Uso:
#   1. cp .env.db.example .env.db
#   2. pon tu contraseña en SUPABASE_DB_PASSWORD
#   3. bash scripts/db-connect-test.sh
# =====================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(dirname "$AQUI")"
ARCHIVO="$RAIZ/.env.db"

command -v psql >/dev/null || {
  echo "Falta psql. En WSL: sudo apt install postgresql-client" >&2
  exit 1
}

if [ ! -f "$ARCHIVO" ]; then
  echo "No existe .env.db. Créalo con: cp .env.db.example .env.db" >&2
  exit 1
fi

# tr -d '\r' en todas las lecturas: estos archivos se editan en Windows y
# un CR final rompe en silencio tanto las comparaciones como los anclajes
# $ de sed. Queda explícito porque costó un rato descubrirlo.
leer_clave() {
  local clave="$1" archivo="$2"
  [ -f "$archivo" ] || return 0
  grep -E "^[[:space:]]*${clave}[[:space:]]*=" "$archivo" 2>/dev/null |
    tr -d '\r' |
    tail -1 |
    sed -E "s/^[[:space:]]*${clave}[[:space:]]*=[[:space:]]*//" |
    sed -E 's/^"(.*)"$/\1/' |
    sed -E "s/^'(.*)'$/\1/"
}

CLAVE="$(leer_clave SUPABASE_DB_PASSWORD "$ARCHIVO")"
REF="$(leer_clave SUPABASE_PROJECT_REF "$ARCHIVO")"

# La referencia del proyecto se deduce de .env si no está declarada.
if [ -z "$REF" ] && [ -f "$RAIZ/.env" ]; then
  REF="$(leer_clave VITE_SUPABASE_URL "$RAIZ/.env" |
    sed -E 's#^https?://##' |
    sed -E 's#/+$##' |
    sed -E 's#\.supabase\.co$##')"
fi

if [ -z "$CLAVE" ] || [ "$CLAVE" = "TU_CLAVE" ]; then
  echo "Pon tu contraseña en SUPABASE_DB_PASSWORD dentro de .env.db." >&2
  exit 1
fi
if [ -z "$REF" ] || [ "$REF" = "TU-REF" ]; then
  echo "No pude deducir la referencia del proyecto. Declara SUPABASE_PROJECT_REF en .env.db." >&2
  exit 1
fi

echo "Proyecto: $REF"
echo ""

# La contraseña viaja por PGPASSWORD, no dentro del URI: así no aparece
# en la lista de procesos ni hay que codificar caracteres especiales.
export PGPASSWORD="$CLAVE"
export PGCONNECT_TIMEOUT=10

# Si no sabes la región: bash scripts/supabase-cli.sh projects list
REGIONES="${ACTIVAUC_REGIONES:-us-east-1 sa-east-1 us-west-1 eu-central-1 eu-west-1 ap-southeast-1 ap-northeast-1}"

GANADOR=""
GANADOR_DESC=""

probar() {
  local descripcion="$1" host="$2" puerto="$3" usuario="$4"
  printf "  %-40s " "$descripcion"

  local salida estado
  salida="$(psql -h "$host" -p "$puerto" -U "$usuario" -d postgres -w -tAc 'select 1' 2>&1)"
  estado=$?

  if [ "$estado" -eq 0 ] && printf '%s' "$salida" | tr -d '[:space:]' | grep -qx '1'; then
    echo "OK"
    if [ -z "$GANADOR" ]; then
      GANADOR="postgresql://$usuario@$host:$puerto/postgres"
      GANADOR_DESC="$descripcion"
    fi
    return 0
  fi

  local motivo
  motivo="$(printf '%s' "$salida" |
    grep -oiE 'tenant/user [^ ]* not found|no tenant identifier provided|Network is unreachable|password authentication failed|could not translate host name|timeout expired|Connection refused' |
    head -1)"
  printf '%s\n' "${motivo:-no conecta}" | cut -c1-58
  return 1
}

echo "Conexión directa:"
probar "db.$REF.supabase.co:5432" "db.$REF.supabase.co" 5432 "postgres"

echo ""
echo "Session pooler (el que necesitan los scripts):"
for region in $REGIONES; do
  for n in 0 1; do
    probar "aws-$n-$region:5432" \
      "aws-$n-$region.pooler.supabase.com" 5432 "postgres.$REF" && break 2
  done
done

echo ""

if [ -z "$GANADOR" ]; then
  cat >&2 <<'EOF'
Ninguna variante conectó.

Cómo leer los motivos de arriba:

  · «password authentication failed»
      La contraseña de .env.db no es la correcta. Restablécela en
      Project Settings -> Database -> Reset database password

  · «tenant/user ... not found» en todas
      La región del proyecto no está entre las probadas. Averigua cuál es:
        bash scripts/supabase-cli.sh projects list
      y vuelve a ejecutar indicándola:
        ACTIVAUC_REGIONES=la-region bash scripts/db-connect-test.sh

  · «could not translate host name» sólo en la conexión directa
      Es lo esperado en una red sin IPv6. Lo que importa es el pooler.

  · «Network is unreachable» o «Connection refused» en todas
      Revisa la salida a internet por el puerto 5432.
EOF
  exit 1
fi

echo "Conecta por: $GANADOR_DESC"

python3 - "$ARCHIVO" "$GANADOR" <<'PYEOF'
import io, re, sys

ruta, url = sys.argv[1], sys.argv[2]
texto = io.open(ruta, encoding="utf-8").read()
linea = f"SUPABASE_DB_URL={url}"

patron = r"^[ \t]*#?[ \t]*SUPABASE_DB_URL[ \t]*=.*$"
if re.search(patron, texto, re.M):
    texto = re.sub(patron, linea, texto, count=1, flags=re.M)
else:
    if not texto.endswith("\n"):
        texto += "\n"
    texto += "\n# Escrita por scripts/db-connect-test.sh.\n" + linea + "\n"

io.open(ruta, "w", encoding="utf-8", newline="\n").write(texto)
print("SUPABASE_DB_URL escrita en .env.db (la contraseña queda aparte).")
PYEOF

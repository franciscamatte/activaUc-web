#!/usr/bin/env bash
# =====================================================================
# ActivaUC · encontrar la cadena de conexión que funciona
# ---------------------------------------------------------------------
# Supabase ofrece tres puntos de entrada a la base de datos y cuál sirve
# depende de la red y del proyecto:
#
#   · Conexión directa  → sólo resuelve por IPv6. Falla en redes IPv4.
#   · Session pooler    → IPv4, mantiene la sesión. Es el que sirve para
#                         psql y para scripts transaccionales.
#   · Transaction pooler→ IPv4, pero no admite sentencias con estado.
#
# Este script prueba las variantes con la contraseña de .env.db y deja
# escrita en ese mismo archivo la que conecta, como SUPABASE_DB_URL.
#
# La contraseña nunca se imprime: sólo se informa qué host respondió.
#
# Uso:
#   1. Copia .env.db.example a .env.db
#   2. Pon tu contraseña en SUPABASE_DB_PASSWORD
#   3. bash scripts/db-connect-test.sh
# =====================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(dirname "$AQUI")"
ARCHIVO="$RAIZ/.env.db"

command -v psql >/dev/null || { echo "Falta psql. En WSL: sudo apt install postgresql-client" >&2; exit 1; }

if [ ! -f "$ARCHIVO" ]; then
  echo "No existe .env.db. Crea el archivo con: cp .env.db.example .env.db" >&2
  exit 1
fi

leer_clave() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ARCHIVO" 2>/dev/null \
    | tail -1 \
    | sed -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//" \
    | sed -E 's/^"(.*)"$/\1/' \
    | sed -E "s/^'(.*)'\$/\1/"
}

CLAVE="$(leer_clave SUPABASE_DB_PASSWORD)"
REF="$(leer_clave SUPABASE_PROJECT_REF)"

# La referencia del proyecto se deduce de .env si no está declarada.
if [ -z "$REF" ] && [ -f "$RAIZ/.env" ]; then
  REF="$(grep -E '^VITE_SUPABASE_URL=' "$RAIZ/.env" \
    | sed -E 's#^VITE_SUPABASE_URL=https?://##' \
    | sed -E 's#\.supabase\.co/?$##')"
fi

if [ -z "$CLAVE" ] || [ "$CLAVE" = "TU_CLAVE" ]; then
  echo "Pon tu contraseña en SUPABASE_DB_PASSWORD dentro de .env.db." >&2
  exit 1
fi
if [ -z "$REF" ]; then
  echo "No pude deducir la referencia del proyecto. Declara SUPABASE_PROJECT_REF en .env.db." >&2
  exit 1
fi

echo "Proyecto: $REF"
echo "Probando los puntos de entrada a la base de datos…"
echo ""

# psql no debe pedir contraseña por consola si falla la autenticación.
export PGCONNECT_TIMEOUT=10

# La contraseña viaja por PGPASSWORD, no dentro del URI, para que no
# aparezca en la lista de procesos ni haga falta codificarla.
export PGPASSWORD="$CLAVE"

REGIONES="sa-east-1 us-east-1 us-west-1 eu-central-1 ap-southeast-1"
GANADOR=""
GANADOR_DESC=""

probar() {
  local descripcion="$1" host="$2" puerto="$3" usuario="$4"
  printf "  %-46s " "$descripcion"

  local salida
  salida="$(psql -h "$host" -p "$puerto" -U "$usuario" -d postgres \
    -w -tAc "select 1" 2>&1)"

  if [ "$(echo "$salida" | tail -1)" = "1" ]; then
    echo "OK"
    if [ -z "$GANADOR" ]; then
      GANADOR="postgresql://$usuario@$host:$puerto/postgres"
      GANADOR_DESC="$descripcion"
    fi
    return 0
  fi

  # Se informa la causa en una línea, sin volcar la contraseña.
  local motivo
  motivo="$(echo "$salida" | grep -oiE 'Network is unreachable|Tenant or user not found|password authentication failed|could not translate host name|timeout expired|Connection refused' | head -1)"
  echo "${motivo:-no conecta}"
  return 1
}

# 1. Conexión directa (IPv6).
probar "conexión directa (IPv6)" "db.$REF.supabase.co" 5432 "postgres"

# 2. Session pooler, que es el que admite transacciones con estado.
for region in $REGIONES; do
  for n in 0 1; do
    probar "session pooler aws-$n-$region" \
      "aws-$n-$region.pooler.supabase.com" 5432 "postgres.$REF" && break 2
  done
done

echo ""

if [ -z "$GANADOR" ]; then
  cat >&2 <<EOF
Ninguna variante conectó.

Causas habituales:
  · «password authentication failed» → la contraseña de .env.db no es la
    correcta. Puedes restablecerla en el panel:
    Project Settings → Database → Reset database password
  · «Network is unreachable» en todas → revisa tu salida a internet.
  · «Tenant or user not found» en todas las del pooler → la región no
    está entre las probadas. Declárala con SUPABASE_PROJECT_REF y añade
    la región a la variable REGIONES de este script.
EOF
  exit 1
fi

echo "Conecta por: $GANADOR_DESC"

# Se escribe la cadena SIN la contraseña, y se deja que los scripts la
# tomen de PGPASSWORD. Así .env.db guarda el secreto una sola vez.
python3 - "$ARCHIVO" "$GANADOR" <<'PYEOF'
import io, re, sys
ruta, url = sys.argv[1], sys.argv[2]
texto = io.open(ruta, encoding="utf-8").read()

linea = f"SUPABASE_DB_URL={url}"
if re.search(r"^[ \t]*SUPABASE_DB_URL[ \t]*=.*$", texto, re.M):
    texto = re.sub(r"^[ \t]*SUPABASE_DB_URL[ \t]*=.*$", linea, texto, count=1, flags=re.M)
else:
    if not texto.endswith("\n"):
        texto += "\n"
    texto += "\n# Escrita por scripts/db-connect-test.sh: la variante que conecta.\n"
    texto += "# La contraseña va aparte, en SUPABASE_DB_PASSWORD.\n"
    texto += linea + "\n"

io.open(ruta, "w", encoding="utf-8").write(texto)
print("SUPABASE_DB_URL escrita en .env.db (sin la contraseña dentro).")
PYEOF

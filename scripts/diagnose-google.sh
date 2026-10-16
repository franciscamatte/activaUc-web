#!/usr/bin/env bash
# =====================================================================
# ActivaUC · diagnóstico de las credenciales de Google OAuth
# ---------------------------------------------------------------------
# Cuando la conexión con Google Calendar falla, el navegador sólo recibe
# un motivo genérico («Google rechazó la solicitud»), porque el callback
# no debe filtrar detalles al cliente. Este script hace la pregunta
# directamente a Google y traduce la respuesta.
#
# Cómo funciona: envía al endpoint de token un código de autorización
# deliberadamente inválido. Lo que importa es QUÉ error devuelve Google:
#
#   · invalid_grant         -> las credenciales son correctas (el código
#                              es el que no vale, que es lo esperado)
#   · invalid_client        -> el client_id o el client_secret están mal
#   · redirect_uri_mismatch -> el URI no coincide con el registrado
#
# No revela ningún secreto: sólo informa de su forma y del error.
#
# Uso:
#   bash scripts/diagnose-google.sh
# =====================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(dirname "$AQUI")"
ARCHIVO="$RAIZ/.env.secrets"

if [ ! -f "$ARCHIVO" ]; then
  echo "No existe .env.secrets. Créalo con: cp .env.secrets.example .env.secrets" >&2
  exit 1
fi

# tr -d para que un CR de un editor de Windows no falsee las longitudes.
leer() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ARCHIVO" 2>/dev/null |
    tr -d '\r' | tail -1 | sed -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//"
}

ID="$(leer GOOGLE_CLIENT_ID)"
SECRETO="$(leer GOOGLE_CLIENT_SECRET)"
REDIR="$(leer GOOGLE_REDIRECT_URI)"

if [ -z "$ID" ] || [ -z "$SECRETO" ]; then
  echo "Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en .env.secrets." >&2
  exit 1
fi

# ---------------------------------------------------------------------
# Comprobaciones de forma, que atrapan los errores más comunes antes de
# siquiera hablar con Google.
# ---------------------------------------------------------------------
echo "Forma de los valores (no se muestran):"
problemas=0

printf "  client_id:      %3s caracteres" "${#ID}"
if [[ "$ID" == *.apps.googleusercontent.com ]]; then
  echo "  · termina en .apps.googleusercontent.com"
else
  echo "  · NO termina en .apps.googleusercontent.com"
  problemas=1
fi

printf "  client_secret:  %3s caracteres" "${#SECRETO}"
if [[ "$SECRETO" == GOCSPX-* ]]; then
  echo "  · empieza por GOCSPX-"
else
  echo "  · NO empieza por GOCSPX-"
  problemas=1
fi

# El error más frecuente, con diferencia: pegar el ID en ambos campos.
if [ "$ID" = "$SECRETO" ]; then
  echo ""
  echo "  >>> client_id y client_secret son el MISMO valor." >&2
  echo "      Se pegó el ID de cliente en los dos campos." >&2
  echo "      El secreto está en Credenciales -> tu cliente OAuth ->" >&2
  echo "      «Secretos de cliente», y empieza por GOCSPX-." >&2
  problemas=1
fi

if [[ "$ID" =~ [[:space:]] ]] || [[ "$SECRETO" =~ [[:space:]] ]]; then
  echo "  >>> Alguno contiene espacios o saltos de línea." >&2
  problemas=1
fi

echo ""
echo "  redirect_uri: $REDIR"
if [[ "$REDIR" != */functions/v1/google-oauth-callback ]]; then
  echo "  >>> No apunta a la Edge Function del callback." >&2
  problemas=1
fi

# ---------------------------------------------------------------------
# La prueba que lo decide: preguntarle a Google.
# ---------------------------------------------------------------------
echo ""
echo "Respuesta de Google al intercambio de código:"

RESPUESTA="$(curl -s --max-time 20 -X POST https://oauth2.googleapis.com/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "code=codigo-deliberadamente-invalido" \
  --data-urlencode "client_id=$ID" \
  --data-urlencode "client_secret=$SECRETO" \
  --data-urlencode "redirect_uri=$REDIR" \
  --data-urlencode "grant_type=authorization_code")"

printf '%s' "$RESPUESTA" | python3 -c "
import json, sys

try:
    datos = json.load(sys.stdin)
except Exception:
    print('  No se pudo interpretar la respuesta de Google.')
    raise SystemExit(1)

error = datos.get('error', '')
detalle = datos.get('error_description', '')

print(f'  error:   {error}')
if detalle:
    print(f'  detalle: {detalle}')
print()

if error == 'invalid_grant':
    print('  Las credenciales son CORRECTAS.')
    print('  Google rechaza el código porque es falso, que es lo esperado.')
    print('  Si la conexión sigue fallando, revisa en el panel de Supabase')
    print('  los registros de la función google-oauth-callback.')
    raise SystemExit(0)

if error == 'invalid_client':
    print('  El client_id o el client_secret NO son correctos.')
    print('  Cópialos de nuevo desde Google Cloud -> APIs y servicios ->')
    print('  Credenciales -> tu cliente OAuth.')
    raise SystemExit(1)

if error == 'redirect_uri_mismatch':
    print('  El redirect_uri no coincide con el registrado en el cliente.')
    print('  Debe ser idéntico carácter por carácter, sin barra final.')
    raise SystemExit(1)

print('  Error no previsto: revisa el detalle de arriba.')
raise SystemExit(1)
"
ESTADO=$?

if [ "$problemas" -eq 1 ] && [ "$ESTADO" -eq 0 ]; then
  echo ""
  echo "Aviso: hay observaciones de forma, aunque Google aceptó las credenciales."
fi

exit "$ESTADO"

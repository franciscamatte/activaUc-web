#!/usr/bin/env bash
# =====================================================================
# ActivaUC · diagnóstico de la cuenta de Twilio
# ---------------------------------------------------------------------
# Comprueba, sin enviar nada, qué parte de la configuración de Twilio
# está bien y qué falta. Útil sobre todo al cambiar de cuenta: hay
# valores que parecen universales y no lo son.
#
#   bash scripts/diagnose-twilio.sh
#
# Lee .env.secrets. Las credenciales nunca aparecen en la línea de
# órdenes ni en la salida: curl las recibe por un archivo de
# configuración temporal con permisos 600.
# =====================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROYECTO="$(dirname "$AQUI")"
cd "$PROYECTO"

ARCHIVO="${1:-.env.secrets}"
if [[ ! -f "$ARCHIVO" ]]; then
  echo "No existe $ARCHIVO. Copia .env.secrets.example y complétalo." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "./$ARCHIVO"
set +a

SID="$(printf '%s' "${TWILIO_ACCOUNT_SID:-}" | tr -d '[:space:]')"
TOKEN="$(printf '%s' "${TWILIO_AUTH_TOKEN:-}" | tr -d '[:space:]')"
DESDE="$(printf '%s' "${TWILIO_WHATSAPP_FROM:-}" | tr -d '[:space:]')"

if [[ -z "$SID" || -z "$TOKEN" ]]; then
  echo "Faltan TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN en $ARCHIVO." >&2
  exit 1
fi

CURLRC="$(mktemp)"
chmod 600 "$CURLRC"
printf 'user = "%s:%s"\n' "$SID" "$TOKEN" > "$CURLRC"
trap 'rm -f "$CURLRC"' EXIT

pedir() { curl -sS -K "$CURLRC" "$1"; }

echo "ActivaUC · diagnóstico de Twilio"
echo ""

# ---------------------------------------------------------------------
# 1 · Credenciales y tipo de cuenta
# ---------------------------------------------------------------------
echo "1) Credenciales"
if [[ "$SID" == "$TOKEN" ]]; then
  echo "   ✖ El SID y el token son el mismo valor: uno de los dos está mal copiado."
  exit 1
fi
if [[ ! "$SID" =~ ^AC[0-9a-f]{32}$ ]]; then
  echo "   ✖ El Account SID debería empezar por AC y tener 34 caracteres."
fi

TIPO="$(pedir "https://api.twilio.com/2010-04-01/Accounts/${SID}.json" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
if d.get("status") in (401, 404) or d.get("code"):
    print("ERROR|%s|%s" % (d.get("code"), d.get("message")))
else:
    print("OK|%s|%s" % (d.get("type"), d.get("friendly_name")))')"

case "$TIPO" in
  OK*)
    IFS='|' read -r _ PLAN NOMBRE <<< "$TIPO"
    echo "   ✔ Válidas · cuenta «$NOMBRE» · plan $PLAN"
    ;;
  *)
    IFS='|' read -r _ CODIGO MENSAJE <<< "$TIPO"
    echo "   ✖ Rechazadas · ${CODIGO:-sin código} · $MENSAJE"
    echo "     Revisa que el Auth Token esté completo y vigente (se invalida al rotarlo)."
    exit 1
    ;;
esac

# ---------------------------------------------------------------------
# 2 · El número del Sandbox, que NO es el mismo en todas las cuentas
# ---------------------------------------------------------------------
echo ""
echo "2) Número emisor de WhatsApp"
SANDBOX="$(pedir "https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json?PageSize=50" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
for m in d.get("messages", []):
    if m.get("direction") == "inbound" and (m.get("body") or "").lower().startswith("join"):
        print((m.get("to") or "").replace("whatsapp:", "")); break')"

if [[ -z "$SANDBOX" ]]; then
  echo "   · No hay ningún «join» en el historial de esta cuenta."
  echo "     Desde tu WhatsApp, envía el código que muestra la consola en"
  echo "     Messaging → Try it out → Send a WhatsApp message."
  echo "     Sin eso, WhatsApp no deja que el Sandbox te escriba."
elif [[ -z "$DESDE" ]]; then
  echo "   ✖ Falta TWILIO_WHATSAPP_FROM. El de esta cuenta es: $SANDBOX"
elif [[ "$DESDE" != "$SANDBOX" ]]; then
  echo "   ✖ TWILIO_WHATSAPP_FROM no es el Sandbox de esta cuenta."
  echo "     Configurado: $DESDE"
  echo "     El correcto:  $SANDBOX"
  echo "     Enviar desde otro número falla con 21654, sin mencionar el From."
else
  echo "   ✔ Coincide con el Sandbox de la cuenta ($SANDBOX)"
fi

# ---------------------------------------------------------------------
# 3 · Plantillas: en Trial sólo las de muestra, y no por API
# ---------------------------------------------------------------------
echo ""
echo "3) Plantillas de WhatsApp"
CONTENIDO="$(pedir "https://content.twilio.com/v1/Content?PageSize=5" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
if d.get("code") == 20003:
    print("TRIAL")
elif "contents" in d:
    print("OK|%d" % len(d["contents"]))
else:
    print("OTRO|%s|%s" % (d.get("code"), d.get("message")))')"

case "$CONTENIDO" in
  TRIAL)
    echo "   · Cuenta Trial: el Content API no está disponible (20003)."
    echo "     Sólo se puede enviar con los ContentSid de muestra que lista"
    echo "     la consola, y hay que copiarlos a mano."
    for v in TWILIO_CONTENT_SID_CONFIRMACION TWILIO_CONTENT_SID_RECORDATORIO \
             TWILIO_CONTENT_SID_CANCELACION; do
      if [[ -z "${!v:-}" ]]; then
        echo "   ✖ $v vacío: sin él, el envío falla con 21654."
      fi
    done
    ;;
  OK*)
    echo "   ✔ Content API disponible · ${CONTENIDO#OK|} plantillas en la cuenta"
    ;;
  *)
    echo "   · Respuesta inesperada: ${CONTENIDO}"
    ;;
esac

# ---------------------------------------------------------------------
# 4 · Correo
# ---------------------------------------------------------------------
echo ""
echo "4) Canal de correo"
echo "   · Remitente: ${TWILIO_EMAIL_FROM:-${SID}@twilio.email (el del plan de prueba)}"
if [[ -n "${TWILIO_EMAIL_ASUNTO_FIJO:-}" ]]; then
  echo "   · Contenido fijado a una plantilla de muestra (necesario en Trial)."
  echo "     Al salir de Trial, vacía TWILIO_EMAIL_ASUNTO_FIJO y"
  echo "     TWILIO_EMAIL_HTML_FIJO para enviar los textos de ActivaUC."
else
  echo "   · Contenido propio de ActivaUC. En Trial esto falla con"
  echo "     «Invalid template»: hay que fijar TWILIO_EMAIL_ASUNTO_FIJO"
  echo "     y TWILIO_EMAIL_HTML_FIJO."
fi

echo ""
echo "Si cambiaste algo, cárgalo y vuelve a desplegar:"
echo "  bash scripts/set-secrets.sh"
echo "  bash scripts/deploy-functions.sh"

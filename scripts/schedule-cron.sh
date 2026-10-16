#!/usr/bin/env bash
# =====================================================================
# ActivaUC · programación de las tareas de integración
# ---------------------------------------------------------------------
# Aplica supabase/cron/schedule.sql leyendo la configuración de los
# archivos locales, en lugar de pasarla por la línea de comandos: el
# CRON_SECRET no debe quedar en el historial del shell ni visible en la
# lista de procesos.
#
# Deja programadas dos tareas:
#   · cada minuto  -> dispara los workers de Calendar y WhatsApp,
#                     incluidos los recordatorios vencidos
#   · cada hora    -> limpia states de OAuth vencidos y contadores
#
# Requisitos: .env.db (conexión) y .env.secrets (CRON_SECRET).
#
# Uso:
#   bash scripts/schedule-cron.sh
#   bash scripts/schedule-cron.sh --estado    # sólo consultar
# =====================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(dirname "$AQUI")"

SOLO_ESTADO=0
[[ "${1:-}" == "--estado" ]] && SOLO_ESTADO=1

# shellcheck source=lib/db-url.sh
source "$AQUI/lib/db-url.sh" || exit 1

command -v psql >/dev/null || { echo "Falta psql en el PATH." >&2; exit 1; }

mostrar_estado() {
  echo "Tareas programadas:"
  psql "$SUPABASE_DB_URL" -X -tA <<'SQL'
select '  ' || jobname || ' · ' || schedule ||
       case when active then ' · activa' else ' · PAUSADA' end
from cron.job where jobname like 'activauc%'
order by jobname;
SQL

  echo ""
  echo "Últimas ejecuciones:"
  # cron.job_run_details no guarda el nombre de la tarea, sólo su jobid:
  # hay que unirla con cron.job para poder mostrarlo.
  psql "$SUPABASE_DB_URL" -X -tA <<'SQL'
select '  ' || to_char(d.start_time, 'HH24:MI:SS') || ' · ' || j.jobname ||
       ' · ' || d.status || coalesce(' · ' || nullif(d.return_message, ''), '')
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname like 'activauc%'
order by d.start_time desc limit 5;
SQL
}

if [[ "$SOLO_ESTADO" -eq 1 ]]; then
  mostrar_estado
  exit 0
fi

# ---------------------------------------------------------------------
# Valores que necesita schedule.sql
# ---------------------------------------------------------------------
leer_secreto() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$RAIZ/.env.secrets" 2>/dev/null |
    tr -d '\r' | tail -1 |
    sed -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//" |
    sed -E 's/^"(.*)"$/\1/'
}

CRON_SECRET="$(leer_secreto CRON_SECRET)"
if [ -z "$CRON_SECRET" ]; then
  echo "Falta CRON_SECRET en .env.secrets." >&2
  exit 1
fi

# La URL de las funciones se deduce de la referencia del proyecto.
REF="$(grep -E '^VITE_SUPABASE_URL=' "$RAIZ/.env" 2>/dev/null |
  tr -d '\r' | tail -1 |
  sed -E 's#^VITE_SUPABASE_URL=https?://##' |
  sed -E 's#/+$##' |
  sed -E 's#\.supabase\.co$##')"

if [ -z "$REF" ]; then
  echo "No pude deducir la referencia del proyecto desde .env." >&2
  exit 1
fi

FUNCTIONS_URL="https://$REF.supabase.co/functions/v1"

echo "Proyecto:  $REF"
echo "Funciones: $FUNCTIONS_URL"
echo ""

# ---------------------------------------------------------------------
# Extensiones
# ---------------------------------------------------------------------
# pg_cron y pg_net no se instalan desde las migraciones porque requieren
# privilegios que no todos los planes conceden. Se intenta aquí y, si no
# se puede, se indica cómo habilitarlas desde el panel.
echo "Comprobando extensiones…"
FALTAN="$(psql "$SUPABASE_DB_URL" -X -tA <<'SQL'
select string_agg(e, ' ')
from (
  select 'pg_cron' as e where not exists (select 1 from pg_extension where extname = 'pg_cron')
  union all
  select 'pg_net' where not exists (select 1 from pg_extension where extname = 'pg_net')
) f;
SQL
)"

if [ -n "$(printf '%s' "$FALTAN" | tr -d '[:space:]')" ]; then
  echo "  Faltan: $FALTAN · intentando instalarlas…"
  for ext in $FALTAN; do
    if [ "$ext" = "pg_net" ]; then
      psql "$SUPABASE_DB_URL" -X -q -c "create extension if not exists pg_net with schema extensions;" 2>/dev/null
    else
      psql "$SUPABASE_DB_URL" -X -q -c "create extension if not exists $ext;" 2>/dev/null
    fi
  done

  PENDIENTES="$(psql "$SUPABASE_DB_URL" -X -tA <<'SQL'
select string_agg(e, ' ')
from (
  select 'pg_cron' as e where not exists (select 1 from pg_extension where extname = 'pg_cron')
  union all
  select 'pg_net' where not exists (select 1 from pg_extension where extname = 'pg_net')
) f;
SQL
)"

  if [ -n "$(printf '%s' "$PENDIENTES" | tr -d '[:space:]')" ]; then
    cat >&2 <<EOF

No se pudieron instalar por SQL: $PENDIENTES

Habilítalas desde el panel (son dos clics) y vuelve a ejecutar:

  https://supabase.com/dashboard/project/$REF/database/extensions

Busca cada una y actívala con el interruptor. pg_cron ejecuta las tareas
y pg_net les permite invocar las Edge Functions por HTTP.
EOF
    exit 1
  fi
fi
echo "  pg_cron y pg_net instaladas."
echo ""

# ---------------------------------------------------------------------
# Programación
# ---------------------------------------------------------------------
echo "Aplicando supabase/cron/schedule.sql…"
psql "$SUPABASE_DB_URL" -X -q \
  -v ON_ERROR_STOP=on \
  -v functions_base_url="$FUNCTIONS_URL" \
  -v cron_secret="$CRON_SECRET" \
  -f "$RAIZ/supabase/cron/schedule.sql" || {
    echo "Falló la programación. Revisa el error de arriba." >&2
    exit 1
  }

echo ""
mostrar_estado

cat <<EOF

Listo. A partir de ahora los eventos de Calendar y los mensajes de
WhatsApp se procesan solos, cada minuto.

Para comprobarlo dentro de un par de minutos:
  bash scripts/schedule-cron.sh --estado
EOF

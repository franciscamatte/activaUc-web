#!/usr/bin/env bash
# =====================================================================
# ActivaUC · promoción de una cuenta a administradora de recintos
# ---------------------------------------------------------------------
# El rol de administrador NO se puede asignar desde la aplicación: la
# política RLS y el disparador prevent_profile_privilege_escalation lo
# impiden a propósito. Esta es la vía prevista, con acceso directo a la
# base de datos.
#
# Pasos:
#   1. La persona crea su cuenta normalmente en ActivaUC y confirma el
#      correo.
#   2. Se ejecuta este script indicando su correo y los recintos.
#
# Uso:
#   export SUPABASE_DB_URL="postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres"
#   bash scripts/seed-usuarios.sh --correo admin@uc.cl --todos-los-recintos
#   bash scripts/seed-usuarios.sh --correo admin@uc.cl --recinto "Cancha de fútbol San Joaquín"
#   bash scripts/seed-usuarios.sh --correo admin@uc.cl --listar
# =====================================================================
set -euo pipefail

CORREO=""
RECINTO=""
TODOS=0
LISTAR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --correo)               CORREO="$2"; shift 2 ;;
    --recinto)              RECINTO="$2"; shift 2 ;;
    --todos-los-recintos)   TODOS=1; shift ;;
    --listar)               LISTAR=1; shift ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Opción no reconocida: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  cat >&2 <<'EOF'
Falta SUPABASE_DB_URL.

  · Local:      postgresql://postgres:postgres@127.0.0.1:54322/postgres
  · Producción: Supabase → Project Settings → Database → Connection string

Esa cadena incluye la contraseña de la base: no la guardes en el repositorio.
EOF
  exit 1
fi

command -v psql >/dev/null || { echo "Falta psql en el PATH." >&2; exit 1; }

# ---------------------------------------------------------------------
# Listado
# ---------------------------------------------------------------------
if [[ "$LISTAR" -eq 1 ]]; then
  echo "Administradores y recintos asignados:"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=on <<'SQL'
select
  u.email                              as correo,
  p.full_name                          as nombre,
  p.role                               as rol,
  coalesce(string_agg(f.name, ', ' order by f.name), '(sin recintos)') as recintos
from public.profiles p
join auth.users u on u.id = p.id
left join public.facility_admin_assignments a on a.admin_id = p.id
left join public.facilities f on f.id = a.facility_id
where p.role = 'administrador'
group by u.email, p.full_name, p.role
order by u.email;
SQL
  exit 0
fi

if [[ -z "$CORREO" ]]; then
  echo "Falta --correo. Usa --help para ver el uso." >&2
  exit 2
fi

if [[ "$TODOS" -eq 0 && -z "$RECINTO" ]]; then
  echo "Indica --todos-los-recintos o --recinto \"<nombre>\"." >&2
  exit 2
fi

# ---------------------------------------------------------------------
# Promoción y asignación, en una sola transacción.
# ---------------------------------------------------------------------
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=on \
  -v correo="$CORREO" -v recinto="${RECINTO:-}" -v todos="$TODOS" <<'SQL'
begin;

do $$
declare
  _correo  text := :'correo';
  _recinto text := nullif(:'recinto', '');
  _todos   boolean := (:'todos' = '1');
  _uid     uuid;
  _n       int;
begin
  select id into _uid from auth.users where lower(email) = lower(_correo);

  if _uid is null then
    raise exception
      'No existe un usuario con el correo %. Primero debe registrarse en ActivaUC y confirmar su correo.',
      _correo;
  end if;

  if not exists (select 1 from public.profiles where id = _uid) then
    raise exception 'El usuario % existe en auth.users pero no tiene perfil.', _correo;
  end if;

  -- El disparador de escalada de privilegios sólo bloquea cuando hay un
  -- JWT; aquí operamos como administrador de base de datos, sin JWT.
  update public.profiles set role = 'administrador' where id = _uid;
  raise notice 'Rol de administrador asignado a %.', _correo;

  if _todos then
    insert into public.facility_admin_assignments (admin_id, facility_id)
    select _uid, f.id from public.facilities f
    on conflict (admin_id, facility_id) do nothing;
  else
    if not exists (select 1 from public.facilities where name = _recinto) then
      raise exception 'No existe un recinto llamado «%».', _recinto;
    end if;

    insert into public.facility_admin_assignments (admin_id, facility_id)
    select _uid, f.id from public.facilities f where f.name = _recinto
    on conflict (admin_id, facility_id) do nothing;
  end if;

  select count(*) into _n
  from public.facility_admin_assignments where admin_id = _uid;

  raise notice 'Recintos asignados a %: %.', _correo, _n;
end;
$$;

commit;
SQL

echo ""
echo "Listo. Verifica con: bash scripts/seed-usuarios.sh --listar"

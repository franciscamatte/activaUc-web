-- =====================================================================
-- ActivaUC · 09 · Rol de administrador general
-- ---------------------------------------------------------------------
-- El documento de requerimientos define tres clases de usuario, y hasta
-- ahora sólo existían dos. El administrador general es quien crea las
-- cuentas de los administradores de recintos y les asigna los recintos
-- a su cargo, con visibilidad sobre todos los recintos y reservas de la
-- organización.
--
-- Decisión deliberada: esta migración permite otorgar y quitar el rol
-- `administrador`, pero **nunca** `administrador_general`. Ese se asigna
-- sólo con acceso directo a la base (scripts/seed-usuarios.sh), que es
-- el arranque del sistema. Si la aplicación pudiera concederlo, una
-- cuenta comprometida de administrador general podría crear más, y no
-- habría forma de acotar el daño desde fuera.
--
-- Sobre el uso del valor nuevo del enum: se compara `role::text` y no
-- el literal, porque PostgreSQL prohíbe usar un valor de enumeración
-- recién añadido dentro de la misma transacción que lo añade, y las
-- migraciones de Supabase corren en una sola transacción.
-- =====================================================================

alter type public.user_role add value if not exists 'administrador_general';

-- ---------------------------------------------------------------------
-- 0 · La bitácora admite las dos acciones nuevas
-- ---------------------------------------------------------------------
-- `action` tiene una lista cerrada a propósito: así una acción mal
-- escrita falla al insertarse en lugar de quedar registrada con un
-- nombre que nadie buscará después.
-- Se descubre el nombre en lugar de suponerlo: si no coincidiera, el
-- DROP no haría nada, quedarían dos restricciones y la antigua seguiría
-- rechazando las acciones nuevas. Un fallo silencioso.
do $$
declare
  _nombre text;
begin
  for _nombre in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.reservation_audit_log'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%reserva_creada%'
  loop
    execute format('alter table public.reservation_audit_log drop constraint %I', _nombre);
  end loop;
end;
$$;

alter table public.reservation_audit_log
  add constraint reservation_audit_log_action_check check (action in (
    'reserva_creada',
    'reserva_cancelada_usuario',
    'reserva_cancelada_admin',
    'calendar_evento_creado',
    'calendar_evento_eliminado',
    'calendar_error',
    'calendar_conectado',
    'calendar_desconectado',
    'whatsapp_enviado',
    'whatsapp_fallido',
    'whatsapp_omitido',
    'consentimiento_otorgado',
    'consentimiento_revocado',
    'recinto_creado',
    'recinto_actualizado',
    'recinto_desactivado',
    'bloque_creado',
    'bloque_actualizado',
    'bloque_desactivado',
    'administrador_asignado',
    'administrador_retirado'
  ));

-- ---------------------------------------------------------------------
-- 1 · El administrador general administra cualquier recinto
-- ---------------------------------------------------------------------
-- `is_facility_admin` es el único punto por el que pasan todas las
-- políticas RLS de administración y todas las funciones del panel. Al
-- ampliarlo aquí, el administrador general hereda la visibilidad
-- completa sin duplicar una sola política.
create or replace function public.is_facility_admin(_uid uuid, _facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = _uid
      and (
        -- Administrador general: cualquier recinto de la organización.
        p.role::text = 'administrador_general'
        or (
          -- Administrador de recintos: sólo los asignados (REQ-29).
          p.role::text = 'administrador'
          and exists (
            select 1 from public.facility_admin_assignments faa
            where faa.admin_id = _uid and faa.facility_id = _facility_id
          )
        )
      )
  );
$$;

comment on function public.is_facility_admin(uuid, uuid) is
  'Un administrador de recintos sólo opera sobre los que tiene asignados (REQ-29); un administrador general, sobre todos. Base de todas las políticas RLS de administración.';

-- ---------------------------------------------------------------------
-- 1.b · «Es administrador» incluye al general
-- ---------------------------------------------------------------------
-- El segundo punto de paso, junto con is_facility_admin: las funciones
-- del panel que no reciben un recinto concreto —el informe de
-- integraciones, el listado de reservas— preguntan por aquí. Sin esto,
-- el administrador general entraría al panel y cada sección le
-- respondería «acceso restringido a administradores».
create or replace function public.is_admin(_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = _uid
      and p.role::text in ('administrador', 'administrador_general')
  );
$$;

comment on function public.is_admin(uuid) is
  'Verdadero para un administrador de recintos o un administrador general. El alcance por recinto lo decide is_facility_admin.';

-- ---------------------------------------------------------------------
-- 2 · La barrera anti-escalada admite la vía sancionada
-- ---------------------------------------------------------------------
-- El cliente no tiene privilegio de UPDATE sobre `role`, así que no
-- puede llegar a este disparador por una escritura directa: es una
-- segunda barrera. Se abre únicamente para que un administrador general
-- pueda otorgar y quitar el rol `administrador`, y se mantiene cerrada
-- para `administrador_general`, que no se concede desde la aplicación.
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _rol_del_actor text;
begin
  if auth.uid() is null or new.role is not distinct from old.role then
    return new;
  end if;

  select p.role::text into _rol_del_actor
  from public.profiles p where p.id = auth.uid();

  if _rol_del_actor is distinct from 'administrador_general' then
    raise exception 'No puedes modificar tu rol.' using errcode = '42501';
  end if;

  if new.role::text = 'administrador_general' then
    raise exception 'El rol de administrador general no se concede desde la aplicación.'
      using errcode = '42501';
  end if;

  if new.id = auth.uid() then
    raise exception 'No puedes modificar tu propio rol.' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_profile_privilege_escalation()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3 · Otorgar el rol de administrador de recintos y asignar recintos
-- ---------------------------------------------------------------------
-- Recibe el correo y no el id porque es lo que el administrador general
-- conoce. La cuenta tiene que existir: crearla es trabajo de la Edge
-- Function `admin-crear-administrador`, que usa la API de
-- administración de Auth y después llama aquí.
create or replace function public.admin_general_asignar_administrador(
  _correo text,
  _recintos uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _actor uuid := auth.uid();
  _uid uuid;
  _correo_limpio text := lower(btrim(coalesce(_correo, '')));
  _asignados int := 0;
  _desconocidos uuid[];
begin
  if _actor is null then
    return jsonb_build_object('ok', false, 'mensaje', 'Debes iniciar sesión.');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = _actor and p.role::text = 'administrador_general'
  ) then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Sólo el administrador general puede asignar administradores.'
    );
  end if;

  if _correo_limpio = '' then
    return jsonb_build_object('ok', false, 'mensaje', 'Indica el correo de la cuenta.');
  end if;

  select u.id into _uid from auth.users u where lower(u.email) = _correo_limpio;

  if _uid is null then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'No existe una cuenta con ese correo. Créala primero.'
    );
  end if;

  if _uid = _actor then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'No puedes cambiar tu propio rol.'
    );
  end if;

  if exists (
    select 1 from public.profiles p
    where p.id = _uid and p.role::text = 'administrador_general'
  ) then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Esa cuenta es administradora general; su rol no se cambia desde aquí.'
    );
  end if;

  -- Los recintos inexistentes se informan en lugar de ignorarse en
  -- silencio: un id mal copiado dejaría al administrador sin acceso y
  -- sin explicación.
  if _recintos is not null and array_length(_recintos, 1) > 0 then
    select array_agg(r) into _desconocidos
    from unnest(_recintos) r
    where not exists (select 1 from public.facilities f where f.id = r);

    if _desconocidos is not null then
      return jsonb_build_object(
        'ok', false,
        'mensaje', format('Hay %s recinto(s) que no existen.', array_length(_desconocidos, 1))
      );
    end if;
  end if;

  update public.profiles set role = 'administrador'::public.user_role where id = _uid;

  if _recintos is not null and array_length(_recintos, 1) > 0 then
    insert into public.facility_admin_assignments (admin_id, facility_id)
    select _uid, r from unnest(_recintos) r
    on conflict (admin_id, facility_id) do nothing;
    _asignados := array_length(_recintos, 1);
  end if;

  insert into public.reservation_audit_log (reservation_id, facility_id, action, actor_id, details)
  values (null, null, 'administrador_asignado', _actor,
          jsonb_build_object('correo_terminacion', right(_correo_limpio, 12),
                             'recintos', _asignados));

  return jsonb_build_object(
    'ok', true,
    'mensaje', format('Cuenta habilitada como administradora de %s recinto(s).', _asignados)
  );
end;
$$;

revoke all on function public.admin_general_asignar_administrador(text, uuid[])
  from public, anon;
grant execute on function public.admin_general_asignar_administrador(text, uuid[])
  to authenticated;

comment on function public.admin_general_asignar_administrador(text, uuid[]) is
  'REQ-29 · el administrador general otorga el rol de administrador de recintos y asigna recintos. No puede conceder el rol de administrador general.';

-- ---------------------------------------------------------------------
-- 4 · Quitar el rol
-- ---------------------------------------------------------------------
-- Las reservas de los usuarios de sus recintos no se tocan: quitar un
-- administrador es un cambio de personal, no una baja de servicio.
create or replace function public.admin_general_quitar_administrador(_correo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _actor uuid := auth.uid();
  _uid uuid;
  _correo_limpio text := lower(btrim(coalesce(_correo, '')));
  _quitados int;
begin
  if _actor is null then
    return jsonb_build_object('ok', false, 'mensaje', 'Debes iniciar sesión.');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = _actor and p.role::text = 'administrador_general'
  ) then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Sólo el administrador general puede quitar administradores.'
    );
  end if;

  select u.id into _uid from auth.users u where lower(u.email) = _correo_limpio;
  if _uid is null then
    return jsonb_build_object('ok', false, 'mensaje', 'No existe una cuenta con ese correo.');
  end if;
  if _uid = _actor then
    return jsonb_build_object('ok', false, 'mensaje', 'No puedes cambiar tu propio rol.');
  end if;

  delete from public.facility_admin_assignments where admin_id = _uid;
  get diagnostics _quitados = row_count;

  update public.profiles set role = 'usuario'::public.user_role
  where id = _uid and role::text = 'administrador';

  insert into public.reservation_audit_log (reservation_id, facility_id, action, actor_id, details)
  values (null, null, 'administrador_retirado', _actor,
          jsonb_build_object('correo_terminacion', right(_correo_limpio, 12),
                             'recintos', _quitados));

  return jsonb_build_object(
    'ok', true,
    'mensaje', format('Rol retirado y %s asignación(es) eliminada(s).', _quitados)
  );
end;
$$;

revoke all on function public.admin_general_quitar_administrador(text) from public, anon;
grant execute on function public.admin_general_quitar_administrador(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5 · Listado para el panel
-- ---------------------------------------------------------------------
-- Devuelve el correo porque el administrador general lo necesita para
-- gestionar, y es el único rol al que se le expone. El teléfono NO se
-- incluye: no hace falta para esta tarea.
create or replace function public.admin_general_listar_administradores()
returns table (
  correo text,
  nombre text,
  rol text,
  recintos text[]
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role::text = 'administrador_general'
  ) then
    raise exception 'Sólo el administrador general puede ver esta lista.'
      using errcode = '42501';
  end if;

  return query
  select u.email::text,
         p.full_name,
         p.role::text,
         coalesce(
           array_agg(f.name order by f.name) filter (where f.name is not null),
           '{}'::text[]
         )
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.facility_admin_assignments faa on faa.admin_id = p.id
  left join public.facilities f on f.id = faa.facility_id
  where p.role::text in ('administrador', 'administrador_general')
  group by u.email, p.full_name, p.role, p.created_at
  order by p.role::text desc, p.created_at;
end;
$$;

revoke all on function public.admin_general_listar_administradores() from public, anon;
grant execute on function public.admin_general_listar_administradores() to authenticated;

-- ---------------------------------------------------------------------
-- 6 · Catálogo de recintos para asignar
-- ---------------------------------------------------------------------
-- El administrador general necesita ver todos los recintos, incluidos
-- los inactivos, para poder asignarlos. La vista pública sólo muestra
-- los activos.
create or replace function public.admin_general_listar_recintos()
returns table (id uuid, nombre text, activo boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role::text = 'administrador_general'
  ) then
    raise exception 'Sólo el administrador general puede ver esta lista.'
      using errcode = '42501';
  end if;

  return query
  select f.id, f.name, f.active from public.facilities f order by f.name;
end;
$$;

revoke all on function public.admin_general_listar_recintos() from public, anon;
grant execute on function public.admin_general_listar_recintos() to authenticated;

-- ---------------------------------------------------------------------
-- 7 · Las funciones del panel que filtraban por asignación con un JOIN
-- ---------------------------------------------------------------------
-- Estas dos acotaban su resultado uniéndose a
-- facility_admin_assignments, lo que deja fuera al administrador
-- general: no tiene asignaciones, tiene alcance. Pasan a filtrar por
-- is_facility_admin, que ya conoce ambos casos, de modo que el alcance
-- vive en un solo sitio.
--
-- Se redeclaran enteras porque el cambio está dentro de su consulta.
-- ---------------------------------------------------------------------

create or replace function public.admin_list_reservations(
  _facility_id uuid default null,
  _scope text default 'vigentes',
  _limit integer default 200
)
returns table (
  reservation_id uuid,
  facility_id uuid,
  facility_name text,
  block_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.reservation_status,
  is_past boolean,
  user_display_name text,
  calendar_sync_status public.calendar_sync_status,
  has_calendar_event boolean,
  whatsapp_status text,
  cancelled_by_role public.user_role,
  cancel_reason text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null or not public.is_admin(_uid) then
    raise exception 'Acceso restringido a administradores.' using errcode = '42501';
  end if;

  if _facility_id is not null and not public.is_facility_admin(_uid, _facility_id) then
    raise exception 'No administras ese recinto.' using errcode = '42501';
  end if;

  return query
  select
    r.id,
    r.facility_id,
    f.name,
    r.block_id,
    r.starts_at,
    r.ends_at,
    r.status,
    (r.ends_at < now()),
    p.full_name,
    r.calendar_sync_status,
    (r.calendar_event_id is not null),
    coalesce(
      (select wm.status::text from public.whatsapp_messages wm
       where wm.reservation_id = r.id
       order by wm.created_at desc limit 1),
      'omitido'
    ),
    r.cancelled_by_role,
    r.cancel_reason,
    r.created_at
  from public.reservations r
  join public.facilities f on f.id = r.facility_id
  join public.profiles p on p.id = r.user_id
  where public.is_facility_admin(_uid, r.facility_id)
    and (_facility_id is null or r.facility_id = _facility_id)
    and (
      case _scope
        when 'vigentes'  then r.status = 'vigente' and r.ends_at >= now()
        when 'historial' then r.status = 'cancelada' or r.ends_at < now()
        else true
      end
    )
  order by r.starts_at desc
  limit least(greatest(coalesce(_limit, 200), 1), 500);
end;
$$;

create or replace function public.admin_integration_report(_limit integer default 100)
returns table (
  kind text,
  reference_id uuid,
  facility_id uuid,
  facility_name text,
  reservation_starts_at timestamptz,
  status text,
  attempts integer,
  last_error text,
  occurred_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null or not public.is_admin(_uid) then
    raise exception 'Acceso restringido a administradores.' using errcode = '42501';
  end if;

  -- El UNION ALL se envuelve en una subconsulta: ORDER BY sobre el
  -- resultado de un UNION sólo admite nombres de columna de salida.
  return query
  select *
  from (
    select
      'google_calendar'::text          as kind,
      j.id                             as reference_id,
      r.facility_id                    as facility_id,
      f.name                           as facility_name,
      r.starts_at                      as reservation_starts_at,
      j.status::text                   as status,
      j.attempts                       as attempts,
      j.last_error                     as last_error,
      j.updated_at                     as occurred_at
    from public.calendar_sync_jobs j
    join public.reservations r on r.id = j.reservation_id
    join public.facilities f on f.id = r.facility_id
    where public.is_facility_admin(_uid, r.facility_id)
    union all
    select
      'whatsapp'::text,
      m.id,
      r.facility_id,
      f.name,
      r.starts_at,
      m.status::text,
      0,
      coalesce(m.error_message, m.skipped_reason),
      m.updated_at
    from public.whatsapp_messages m
    join public.reservations r on r.id = m.reservation_id
    join public.facilities f on f.id = r.facility_id
    where public.is_facility_admin(_uid, r.facility_id)
  ) informe
  order by informe.occurred_at desc
  limit least(greatest(coalesce(_limit, 100), 1), 500);
end;
$$;

revoke all on function public.admin_list_reservations(uuid, text, integer) from public, anon;
grant execute on function public.admin_list_reservations(uuid, text, integer) to authenticated;
revoke all on function public.admin_integration_report(integer) from public, anon;
grant execute on function public.admin_integration_report(integer) to authenticated;

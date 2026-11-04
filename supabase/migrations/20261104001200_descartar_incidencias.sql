-- =====================================================================
-- ActivaUC · descartar incidencias de integración ya resueltas
-- ---------------------------------------------------------------------
-- El panel avisa cuando alguna sincronización con Google Calendar o
-- algún mensaje quedó en error. Eso es lo que pide REQ-33 y tiene que
-- seguir pasando.
--
-- Lo que faltaba es qué hacer **después**. Un fallo de la puesta en
-- marcha —una plantilla que el proveedor aún no había aprobado, un
-- destinatario que no estaba verificado— queda en la tabla para siempre
-- y el aviso no se apaga nunca, aunque no haya nada que arreglar. Con el
-- tiempo el panel avisa de un problema que no existe, que es la forma
-- más segura de que nadie vuelva a mirar el aviso.
--
-- Borrar esas filas sería lo rápido, pero son el registro de
-- trazabilidad que pide REQ-27: hay que poder responder «qué pasó con el
-- mensaje de esta reserva» meses después. Así que no se borran: se
-- marcan como descartadas, con quién lo hizo y cuándo. El informe deja
-- de contarlas, la fila sigue ahí y la auditoría guarda la decisión.
--
-- Esta migración añade además un detalle de redacción: conceder el rol
-- sin recintos ya era posible en el backend, pero el mensaje decía
-- «administradora de 0 recinto(s)».
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · Marca de descarte
-- ---------------------------------------------------------------------
-- Dos columnas y no una: sin saber quién lo descartó, la auditoría de
-- una incidencia que alguien decidió ignorar queda a medias.
alter table public.whatsapp_messages
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid references auth.users(id) on delete set null;

alter table public.calendar_sync_jobs
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid references auth.users(id) on delete set null;

-- El informe filtra por esta marca, así que conviene que el filtro no
-- recorra la tabla entera.
create index if not exists whatsapp_messages_sin_descartar_idx
  on public.whatsapp_messages (updated_at desc)
  where dismissed_at is null;

create index if not exists calendar_sync_jobs_sin_descartar_idx
  on public.calendar_sync_jobs (updated_at desc)
  where dismissed_at is null;

-- Las columnas nuevas no se conceden a nadie: se leen y se escriben
-- sólo desde funciones `security definer`. `REVOKE ALL` del esquema
-- original ya las deja sin privilegios, pero se deja explícito.
revoke all (dismissed_at, dismissed_by) on public.whatsapp_messages from authenticated, anon;
revoke all (dismissed_at, dismissed_by) on public.calendar_sync_jobs from authenticated, anon;

-- ---------------------------------------------------------------------
-- 2 · La acción, en la lista de acciones auditables
-- ---------------------------------------------------------------------
-- El nombre de la restricción se busca en lugar de escribirse: si no
-- coincidiera, se quedaría la vieja y el `insert` de auditoría fallaría
-- al descartar.
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
    'administrador_retirado',
    'incidencia_descartada'
  ));

-- ---------------------------------------------------------------------
-- 3 · Descartar una incidencia
-- ---------------------------------------------------------------------
-- Sólo incidencias **en error**: no se puede descartar una
-- sincronización pendiente, porque todavía va a ocurrir, ni una
-- completada, que no avisa de nada. Y sólo de los recintos que quien
-- llama administre, por `is_facility_admin`, que es el mismo punto por
-- el que pasa el resto del panel.
create or replace function public.admin_descartar_incidencia(
  _tipo text,
  _id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _facility uuid;
  _estado text;
begin
  if _uid is null then
    return jsonb_build_object('ok', false, 'codigo', 'sin_sesion',
                              'mensaje', 'Debes iniciar sesión.');
  end if;

  if not public.is_admin(_uid) then
    return jsonb_build_object('ok', false, 'codigo', 'no_autorizado',
                              'mensaje', 'Acceso restringido a administradores.');
  end if;

  if _tipo not in ('whatsapp', 'google_calendar') then
    return jsonb_build_object('ok', false, 'codigo', 'tipo_desconocido',
                              'mensaje', 'Tipo de incidencia desconocido.');
  end if;

  if _tipo = 'whatsapp' then
    select r.facility_id, m.status::text
      into _facility, _estado
      from public.whatsapp_messages m
      join public.reservations r on r.id = m.reservation_id
     where m.id = _id;
  else
    select r.facility_id, j.status::text
      into _facility, _estado
      from public.calendar_sync_jobs j
      join public.reservations r on r.id = j.reservation_id
     where j.id = _id;
  end if;

  if _facility is null then
    return jsonb_build_object('ok', false, 'codigo', 'no_encontrada',
                              'mensaje', 'No encontramos esa incidencia.');
  end if;

  if not public.is_facility_admin(_uid, _facility) then
    return jsonb_build_object('ok', false, 'codigo', 'no_autorizado',
                              'mensaje', 'No administras el recinto de esa incidencia.');
  end if;

  -- 'fallido' es el estado de error de los mensajes; 'error' el de las
  -- colas. Cualquier otro no es una incidencia.
  if _estado not in ('fallido', 'error') then
    return jsonb_build_object(
      'ok', false,
      'codigo', 'no_es_incidencia',
      'mensaje', 'Sólo se descartan las integraciones en error.'
    );
  end if;

  if _tipo = 'whatsapp' then
    update public.whatsapp_messages
       set dismissed_at = now(), dismissed_by = _uid
     where id = _id and dismissed_at is null;
  else
    update public.calendar_sync_jobs
       set dismissed_at = now(), dismissed_by = _uid
     where id = _id and dismissed_at is null;
  end if;

  if not found then
    return jsonb_build_object('ok', false, 'codigo', 'ya_descartada',
                              'mensaje', 'Esa incidencia ya estaba descartada.');
  end if;

  insert into public.reservation_audit_log (facility_id, action, actor_id, details)
  values (_facility, 'incidencia_descartada', _uid,
          jsonb_build_object('tipo', _tipo, 'incidencia', _id, 'estado', _estado));

  return jsonb_build_object('ok', true, 'codigo', 'descartada',
                            'mensaje', 'Incidencia descartada. La reserva no cambia.');
end;
$$;

revoke all on function public.admin_descartar_incidencia(text, uuid) from public, anon;
grant execute on function public.admin_descartar_incidencia(text, uuid) to authenticated;

comment on function public.admin_descartar_incidencia(text, uuid) is
  'REQ-33 · retira del informe una integración en error ya resuelta, sin borrar la fila (REQ-27 exige conservar la trazabilidad). Deja constancia de quién la descartó.';

-- ---------------------------------------------------------------------
-- 4 · El informe deja de contar lo descartado
-- ---------------------------------------------------------------------
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
      and j.dismissed_at is null
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
      and m.dismissed_at is null
  ) informe
  order by informe.occurred_at desc
  limit least(greatest(coalesce(_limit, 100), 1), 500);
end;
$$;

revoke all on function public.admin_integration_report(integer) from public, anon;
grant execute on function public.admin_integration_report(integer) to authenticated;

comment on function public.admin_integration_report(integer) is
  'REQ-33 · estado de las integraciones de los recintos que administra quien llama. No incluye las incidencias descartadas.';

-- ---------------------------------------------------------------------
-- 5 · Conceder el rol sin recintos, dicho con propiedad
-- ---------------------------------------------------------------------
-- El backend ya lo permitía: `admin_create_facility` sólo exige el rol y
-- asigna el recinto a quien lo crea, así que un administrador recién
-- nombrado puede crear el primero. Lo único que sobraba era el mensaje,
-- que hablaba de «0 recinto(s)».
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
    return jsonb_build_object(
      'ok', false, 'codigo', 'sin_sesion', 'mensaje', 'Debes iniciar sesión.'
    );
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = _actor and p.role::text = 'administrador_general'
  ) then
    return jsonb_build_object(
      'ok', false,
      'codigo', 'no_autorizado',
      'mensaje', 'Sólo el administrador general puede asignar administradores.'
    );
  end if;

  if _correo_limpio = '' then
    return jsonb_build_object(
      'ok', false, 'codigo', 'sin_correo', 'mensaje', 'Indica el correo de la cuenta.'
    );
  end if;

  select u.id into _uid from auth.users u where lower(u.email) = _correo_limpio;

  if _uid is null then
    return jsonb_build_object(
      'ok', false,
      'codigo', 'sin_cuenta',
      'mensaje', 'No existe una cuenta con ese correo. Créala primero.'
    );
  end if;

  if _uid = _actor then
    return jsonb_build_object(
      'ok', false, 'codigo', 'propio_rol', 'mensaje', 'No puedes cambiar tu propio rol.'
    );
  end if;

  if exists (
    select 1 from public.profiles p
    where p.id = _uid and p.role::text = 'administrador_general'
  ) then
    return jsonb_build_object(
      'ok', false,
      'codigo', 'es_general',
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
        'codigo', 'recintos_desconocidos',
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
    'codigo', 'asignado',
    'mensaje', case
      when _asignados = 0 then
        'Cuenta habilitada como administradora. Todavía sin recintos: el primero que cree quedará a su cargo.'
      else
        format('Cuenta habilitada como administradora de %s recinto(s).', _asignados)
    end
  );
end;
$$;

revoke all on function public.admin_general_asignar_administrador(text, uuid[])
  from public, anon;
grant execute on function public.admin_general_asignar_administrador(text, uuid[])
  to authenticated;

comment on function public.admin_general_asignar_administrador(text, uuid[]) is
  'REQ-29 · el administrador general otorga el rol de administrador de recintos y asigna recintos. Admite ninguno: el primero que cree esa persona queda a su cargo. No puede conceder el rol de administrador general.';

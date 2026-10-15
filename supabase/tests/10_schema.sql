-- =====================================================================
-- Pruebas · integridad del esquema
-- Cada archivo lo ejecuta scripts/db-test.mjs dentro de una transacción
-- que se revierte al final, de modo que las pruebas son independientes.
-- =====================================================================

do $$
declare
  _faltantes text[];
  _esperadas text[] := array[
    'profiles', 'facilities', 'time_blocks', 'facility_admin_assignments',
    'reservations', 'reservation_audit_log', 'calendar_connections',
    'calendar_sync_jobs', 'whatsapp_messages', 'notification_jobs',
    'webhook_events', 'oauth_states', 'rate_limit_counters'
  ];
begin
  select array_agg(t) into _faltantes
  from unnest(_esperadas) t
  where not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = t
  );

  assert _faltantes is null,
    format('Faltan tablas requeridas: %s', _faltantes);

  raise notice 'OK · las 13 tablas de dominio existen';
end;
$$;

do $$
declare
  _sin_rls text[];
begin
  select array_agg(c.relname::text) into _sin_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  assert _sin_rls is null,
    format('Tablas de public sin RLS activa: %s', _sin_rls);

  raise notice 'OK · RLS activa en todas las tablas de public';
end;
$$;

do $$
begin
  -- Índice único parcial que impide dos reservas vigentes del mismo
  -- usuario en el mismo bloque (REQ-13).
  assert exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'reservations_one_active_per_user_block_idx'
  ), 'Falta el índice único parcial de reservas duplicadas';

  -- Disparadores de updated_at.
  assert (
    select count(*) from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and t.tgname like '%set_updated_at'
      and not t.tgisinternal
  ) >= 8, 'Faltan disparadores de updated_at';

  raise notice 'OK · índices y disparadores presentes';
end;
$$;

do $$
declare
  _r record;
begin
  -- Las funciones SECURITY DEFINER deben fijar search_path para no ser
  -- vulnerables a secuestro de esquema.
  for _r in
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
        where cfg like 'search_path=%'
      )
  loop
    assert false, format(
      'La función SECURITY DEFINER %s no fija search_path', _r.proname
    );
  end loop;

  raise notice 'OK · todas las funciones SECURITY DEFINER fijan search_path';
end;
$$;

do $$
begin
  -- Restricción E.164 del teléfono.
  assert exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%+[1-9]%'
  ), 'Falta la restricción de formato E.164 en profiles.phone';

  -- Consentimiento sin teléfono no debe ser posible.
  assert exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_consent_requires_phone'
  ), 'Falta la restricción consentimiento-requiere-teléfono';

  raise notice 'OK · restricciones de datos personales presentes';
end;
$$;

do $$
declare
  _inesperadas text[];
begin
  -- PostgreSQL concede EXECUTE a PUBLIC en cada función nueva, y anon
  -- hereda ese privilegio. Esta comprobación impide que una función
  -- futura quede expuesta a usuarios no autenticados por descuido.
  select array_agg(p.proname::text order by p.proname) into _inesperadas
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('anon', p.oid, 'execute')
    and p.proname not in (
      -- Única excepción prevista: ninguna. La disponibilidad pública se
      -- expone por la vista block_availability, no por funciones.
      ''
    );

  assert _inesperadas is null,
    format('Funciones de public ejecutables por anon: %s', _inesperadas);

  raise notice 'OK · ninguna función de public es ejecutable por anon';
end;
$$;

do $$
declare
  _expuestas text[];
begin
  -- Las columnas de tokens OAuth no deben ser legibles por ningún rol
  -- del cliente, ni siquiera por su propio dueño.
  select array_agg(c.column_name::text) into _expuestas
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'calendar_connections'
    and c.column_name in ('access_token_encrypted', 'refresh_token_encrypted')
    and (
      has_column_privilege('authenticated', 'public.calendar_connections', c.column_name, 'select')
      or has_column_privilege('anon', 'public.calendar_connections', c.column_name, 'select')
    );

  assert _expuestas is null,
    format('Columnas de tokens legibles desde el cliente: %s', _expuestas);

  -- Y nadie del cliente puede escribir en reservations.
  assert not has_table_privilege('authenticated', 'public.reservations', 'insert'),
    'authenticated tiene privilegio de INSERT sobre reservations';
  assert not has_table_privilege('authenticated', 'public.reservations', 'update'),
    'authenticated tiene privilegio de UPDATE sobre reservations';
  assert not has_table_privilege('authenticated', 'public.reservations', 'delete'),
    'authenticated tiene privilegio de DELETE sobre reservations';
  assert not has_table_privilege('anon', 'public.reservations', 'select'),
    'anon tiene privilegio de SELECT sobre reservations';

  raise notice 'OK · tokens y escrituras de reservas fuera del alcance del cliente';
end;
$$;

do $$
declare
  _uid uuid;
begin
  -- El perfil se crea automáticamente al insertar en auth.users.
  _uid := test_helpers.create_user('schema@uc.cl', 'Prueba Esquema');
  assert exists (select 1 from public.profiles where id = _uid),
    'El disparador on_auth_user_created no creó el perfil';

  -- Teléfono fuera de E.164 debe ser rechazado.
  begin
    update public.profiles set phone = '912345678' where id = _uid;
    assert false, 'La base aceptó un teléfono sin formato E.164';
  exception
    when check_violation then null;
  end;

  raise notice 'OK · alta automática de perfil y validación de teléfono';
end;
$$;

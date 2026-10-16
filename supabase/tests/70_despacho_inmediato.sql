-- =====================================================================
-- Pruebas · despacho inmediato de las integraciones
-- ---------------------------------------------------------------------
-- No se puede comprobar aquí que la petición HTTP salga (pg_net no está
-- instalado en el entorno de pruebas, y hacer red desde una prueba sería
-- frágil). Lo que sí se verifica, que es lo que importa:
--
--   · que los disparadores existan y sean por sentencia,
--   · que reservar y cancelar sigan funcionando con ellos puestos,
--   · y sobre todo, que un fallo del despacho NO impida crear la reserva.
--
-- Ese último punto es el riesgo real de añadir un disparador en el
-- camino de escritura.
-- =====================================================================

do $$
declare
  _faltan text[];
begin
  select array_agg(t) into _faltan
  from unnest(array[
    'calendar_jobs_despacho_inmediato',
    'notification_jobs_despacho_inmediato',
    'calendar_jobs_despacho_reintento',
    'notification_jobs_despacho_reintento'
  ]) t
  where not exists (
    select 1 from pg_trigger where tgname = t and not tgisinternal
  );

  assert _faltan is null, format('Faltan disparadores: %s', _faltan);

  -- Por sentencia, no por fila: crear una reserva inserta varios
  -- trabajos y no tiene sentido despachar una vez por cada uno.
  assert not exists (
    select 1 from pg_trigger
    where tgname like '%despacho%' and not tgisinternal and tgtype & 1 = 1
  ), 'Algún disparador de despacho es FOR EACH ROW';

  raise notice 'OK · los cuatro disparadores existen y son por sentencia';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _r jsonb; _reserva uuid;
begin
  -- El camino completo debe seguir funcionando con los disparadores
  -- puestos y sin pg_net instalado: dispatch_integration_workers()
  -- comprueba la extensión y no hace nada si falta.
  _u := test_helpers.create_user('d1@uc.cl', 'Dani Despacho');

  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour');

  perform test_helpers.login_as(_u);
  perform public.set_whatsapp_consent('+56911112222', true);

  insert into public.facilities (name, facility_type)
  values ('Recinto Despacho', 'Fútbol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 5)
  returning id into _bloque;

  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'ok')::boolean, format('La reserva falló con los disparadores puestos: %s', _r);
  _reserva := (_r ->> 'reservation_id')::uuid;

  -- Los trabajos se encolaron igual.
  assert (select count(*) from public.calendar_sync_jobs where reservation_id = _reserva) = 1,
    'No se encoló el trabajo de Calendar';
  assert (select count(*) from public.notification_jobs where reservation_id = _reserva) = 2,
    'No se encolaron la confirmación y el recordatorio';

  -- Y la cancelación también.
  _r := public.cancel_reservation(_reserva);
  assert (_r ->> 'ok')::boolean, format('La cancelación falló: %s', _r);

  raise notice 'OK · reservar y cancelar funcionan con los disparadores activos';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _r jsonb;
begin
  -- El riesgo de poner un disparador en el camino de escritura es que un
  -- fallo suyo impida crear la reserva. Se fuerza ese fallo sustituyendo
  -- la función de despacho por una que siempre lanza.
  _u := test_helpers.create_user('d2@uc.cl', 'Eva Despacho');
  perform test_helpers.login_as(_u);

  insert into public.facilities (name, facility_type)
  values ('Recinto Despacho Roto', 'Tenis') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 5)
  returning id into _bloque;

  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour');

  -- Sustitución temporal: dentro de esta transacción, despachar falla.
  create or replace function private.dispatch_integration_workers()
  returns void language plpgsql security definer set search_path = '' as $roto$
  begin
    raise exception 'fallo simulado del despacho';
  end;
  $roto$;

  _r := public.create_reservation_strict(_bloque);

  assert (_r ->> 'ok')::boolean,
    format('Un fallo del despacho impidió crear la reserva: %s', _r);
  assert (select count(*) from public.reservations
          where user_id = _u and status = 'vigente') = 1,
    'La reserva no se creó pese a que el fallo era sólo del despacho';
  assert (select count(*) from public.calendar_sync_jobs
          where reservation_id = (_r ->> 'reservation_id')::uuid) = 1,
    'El trabajo no quedó encolado para que lo recoja el cron';

  raise notice 'OK · un fallo del despacho no impide reservar (lo recoge el cron)';
end;
$$;

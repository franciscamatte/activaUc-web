-- =====================================================================
-- Pruebas · creación de reservas (REQ-12, REQ-13, REQ-16)
-- =====================================================================

do $$
declare
  _u1 uuid; _u2 uuid; _u3 uuid;
  _fac uuid; _bloque uuid;
  _r jsonb;
begin
  _u1 := test_helpers.create_user('r1@uc.cl', 'Ana Reserva');
  _u2 := test_helpers.create_user('r2@uc.cl', 'Beto Reserva');
  _u3 := test_helpers.create_user('r3@uc.cl', 'Caro Reserva');

  insert into public.facilities (name, facility_type, description, operation_hours)
  values ('Cancha Prueba 20', 'Fútbol', 'Cancha de pruebas', '08:00 a 22:00')
  returning id into _fac;

  -- Capacidad 2, dentro de 5 horas.
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '5 hours', now() + interval '6 hours', 2)
  returning id into _bloque;

  -- ---------------------------------------------------------------
  -- Sin sesión no se puede reservar.
  -- ---------------------------------------------------------------
  perform test_helpers.logout();
  begin
    perform public.create_reservation_strict(_bloque);
    assert false, 'Se permitió reservar sin usuario autenticado';
  exception
    when invalid_authorization_specification then null;
  end;

  -- ---------------------------------------------------------------
  -- REQ-12 · reserva válida
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_u1);
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'ok')::boolean, format('La primera reserva falló: %s', _r);
  assert (_r ->> 'duplicada')::boolean = false, 'La primera reserva se marcó como duplicada';
  assert (_r ->> 'cupos_disponibles')::int = 1,
    format('Cupos restantes esperados 1, obtenidos %s', _r ->> 'cupos_disponibles');
  -- Sin Google Calendar conectado, el estado no es "pendiente" ni "error".
  assert (_r ->> 'calendar_sync_status') = 'no_aplica',
    format('calendar_sync_status esperado no_aplica, obtenido %s', _r ->> 'calendar_sync_status');
  -- Sin consentimiento no se encola ningún mensaje.
  assert (_r ->> 'whatsapp_confirmacion') = 'omitido', 'Se encoló WhatsApp sin consentimiento';
  assert not exists (select 1 from public.notification_jobs where reservation_id = (_r ->> 'reservation_id')::uuid),
    'Se creó un trabajo de notificación sin consentimiento';

  -- Auditoría registrada.
  assert exists (
    select 1 from public.reservation_audit_log
    where reservation_id = (_r ->> 'reservation_id')::uuid and action = 'reserva_creada'
  ), 'No se registró la auditoría de creación';

  -- ---------------------------------------------------------------
  -- REQ-13 · el mismo usuario no genera una segunda reserva
  -- ---------------------------------------------------------------
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'duplicada')::boolean, 'No se detectó el intento duplicado';
  assert (select count(*) from public.reservations
          where user_id = _u1 and block_id = _bloque and status = 'vigente') = 1,
    'Se creó una segunda reserva para el mismo usuario y bloque';

  -- ---------------------------------------------------------------
  -- Segundo usuario toma el último cupo.
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_u2);
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'ok')::boolean, format('La segunda reserva falló: %s', _r);
  assert (_r ->> 'cupos_disponibles')::int = 0, 'El bloque debería quedar sin cupos';

  -- ---------------------------------------------------------------
  -- Tercer usuario: bloque agotado, fallo limpio y sin escrituras.
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_u3);
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'ok')::boolean = false, 'Se permitió sobrecupo';
  assert (_r ->> 'error') = 'sin_cupos', format('Código de error inesperado: %s', _r ->> 'error');
  assert (select count(*) from public.reservations where block_id = _bloque and status = 'vigente') = 2,
    'El número de reservas vigentes excede la capacidad';

  -- La vista pública refleja el bloque como agotado (REQ-11).
  assert (select is_full from public.block_availability where block_id = _bloque),
    'block_availability no marca el bloque como agotado';
  assert (select available_count from public.block_availability where block_id = _bloque) = 0,
    'block_availability no reporta 0 cupos';

  raise notice 'OK · capacidad, duplicados y agotamiento';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _pasado uuid; _inactivo uuid; _recinto_off uuid; _bloque_off uuid;
  _r jsonb;
begin
  _u := test_helpers.create_user('r4@uc.cl', 'Dani Reserva');
  perform test_helpers.login_as(_u);

  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 20b', 'Tenis') returning id into _fac;

  -- Bloque en el pasado.
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() - interval '3 hours', now() - interval '2 hours', 5)
  returning id into _pasado;

  _r := public.create_reservation_strict(_pasado);
  assert (_r ->> 'error') = 'bloque_iniciado',
    format('Debía rechazar un bloque pasado, obtuvo: %s', _r);

  -- Bloque desactivado.
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity, active)
  values (_fac, now() + interval '4 hours', now() + interval '5 hours', 5, false)
  returning id into _inactivo;

  _r := public.create_reservation_strict(_inactivo);
  assert (_r ->> 'error') = 'bloque_inactivo',
    format('Debía rechazar un bloque inactivo, obtuvo: %s', _r);

  -- Recinto desactivado.
  insert into public.facilities (name, facility_type, active)
  values ('Cancha Prueba 20c', 'Básquetbol', false) returning id into _recinto_off;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_recinto_off, now() + interval '4 hours', now() + interval '5 hours', 5)
  returning id into _bloque_off;

  _r := public.create_reservation_strict(_bloque_off);
  assert (_r ->> 'error') = 'recinto_inactivo',
    format('Debía rechazar un recinto inactivo, obtuvo: %s', _r);

  -- Bloque inexistente.
  _r := public.create_reservation_strict('00000000-0000-0000-0000-000000000000');
  assert (_r ->> 'error') = 'bloque_inexistente',
    format('Debía rechazar un bloque inexistente, obtuvo: %s', _r);

  -- Ninguna reserva debió crearse en todo este bloque de pruebas.
  assert (select count(*) from public.reservations where user_id = _u) = 0,
    'Se creó una reserva en un caso que debía fallar';

  raise notice 'OK · bloques pasados, inactivos, recintos inactivos e inexistentes';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _b_lejano uuid; _b_cercano uuid;
  _r jsonb; _reserva uuid;
begin
  -- Usuario con consentimiento de WhatsApp vigente.
  _u := test_helpers.create_user('r5@uc.cl', 'Eva Reserva');
  perform test_helpers.login_as(_u);
  _r := public.set_whatsapp_consent('+56912345678', true);
  assert (_r ->> 'ok')::boolean, format('No se registró el consentimiento: %s', _r);

  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 20d', 'Pádel') returning id into _fac;

  -- ---------------------------------------------------------------
  -- REQ-25 · con >= 2 horas de anticipación se programa recordatorio
  -- ---------------------------------------------------------------
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 4)
  returning id into _b_lejano;

  _r := public.create_reservation_strict(_b_lejano);
  _reserva := (_r ->> 'reservation_id')::uuid;
  assert (_r ->> 'whatsapp_confirmacion') = 'pendiente', 'No se encoló la confirmación';
  assert (_r ->> 'whatsapp_recordatorio') = 'programado', 'No se programó el recordatorio';

  assert (select scheduled_for from public.notification_jobs
          where reservation_id = _reserva and kind = 'recordatorio')
         between now() + interval '5 hours 59 minutes' and now() + interval '6 hours 1 minute',
    'El recordatorio no quedó programado 2 horas antes del inicio';

  -- ---------------------------------------------------------------
  -- REQ-25 · con menos de 2 horas sólo se envía la confirmación
  -- ---------------------------------------------------------------
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '90 minutes', now() + interval '150 minutes', 4)
  returning id into _b_cercano;

  _r := public.create_reservation_strict(_b_cercano);
  _reserva := (_r ->> 'reservation_id')::uuid;
  assert (_r ->> 'whatsapp_confirmacion') = 'pendiente', 'No se encoló la confirmación cercana';
  assert (_r ->> 'whatsapp_recordatorio') = 'omitido',
    format('Con menos de 2 horas no debe haber recordatorio, obtuvo: %s', _r ->> 'whatsapp_recordatorio');
  assert not exists (
    select 1 from public.notification_jobs
    where reservation_id = _reserva and kind = 'recordatorio'
  ), 'Se encoló un recordatorio para una reserva creada con menos de 2 horas';

  raise notice 'OK · regla exacta del recordatorio de 2 horas';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _r jsonb;
begin
  -- Idempotencia de la cola de Calendar: el usuario con conexión activa
  -- genera exactamente un trabajo por reserva.
  _u := test_helpers.create_user('r6@uc.cl', 'Fran Reserva');

  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.ficticio.ficticio', 'v1.ficticio.ficticio', now() + interval '1 hour');

  perform test_helpers.login_as(_u);

  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 20e', 'Vóleibol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '7 hours', now() + interval '8 hours', 3)
  returning id into _bloque;

  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'calendar_sync_status') = 'pendiente',
    format('Con Calendar conectado el estado debe ser pendiente, obtuvo: %s', _r ->> 'calendar_sync_status');
  assert (select count(*) from public.calendar_sync_jobs
          where reservation_id = (_r ->> 'reservation_id')::uuid and kind = 'crear_evento') = 1,
    'Debe existir exactamente un trabajo de creación de evento';

  -- Reintento de la misma solicitud: no duplica trabajos.
  _r := public.create_reservation_strict(_bloque);
  assert (select count(*) from public.calendar_sync_jobs
          where user_id = _u and kind = 'crear_evento') = 1,
    'El reintento duplicó el trabajo de Calendar';

  raise notice 'OK · idempotencia de la cola de Google Calendar';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _r jsonb; _i int;
begin
  -- Límite de solicitudes: 20 intentos por minuto.
  _u := test_helpers.create_user('r7@uc.cl', 'Gabi Reserva');
  perform test_helpers.login_as(_u);

  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 20f', 'Atletismo') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '9 hours', now() + interval '10 hours', 50)
  returning id into _bloque;

  for _i in 1..21 loop
    _r := public.create_reservation_strict(_bloque);
  end loop;

  assert (_r ->> 'error') = 'limite_solicitudes',
    format('El intento 21 debía ser limitado, obtuvo: %s', _r);

  raise notice 'OK · límite de solicitudes por usuario';
end;
$$;

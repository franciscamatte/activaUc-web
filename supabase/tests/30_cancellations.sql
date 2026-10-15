-- =====================================================================
-- Pruebas · cancelaciones (REQ-15, REQ-26, REQ-32 y reglas de negocio)
-- =====================================================================

do $$
declare
  _dueno uuid; _otro uuid; _fac uuid;
  _b_lejano uuid; _b_cercano uuid; _b_iniciado uuid; _b_vencido uuid;
  _res_lejana uuid; _res_cercana uuid; _res_iniciada uuid; _res_vencida uuid;
  _r jsonb;
begin
  _dueno := test_helpers.create_user('c1@uc.cl', 'Hugo Cancela');
  _otro  := test_helpers.create_user('c2@uc.cl', 'Ines Ajena');

  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 30', 'Fútbol') returning id into _fac;

  -- Bloque a 5 horas: cancelable por el usuario.
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '5 hours', now() + interval '6 hours', 5)
  returning id into _b_lejano;

  -- Bloque a 1 hora: dentro de la ventana de 2 horas.
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '1 hour', now() + interval '2 hours', 5)
  returning id into _b_cercano;

  perform test_helpers.login_as(_dueno);
  _res_lejana  := (public.create_reservation_strict(_b_lejano)  ->> 'reservation_id')::uuid;
  _res_cercana := (public.create_reservation_strict(_b_cercano) ->> 'reservation_id')::uuid;

  -- Reservas ya iniciada y ya vencida: se insertan directamente porque
  -- create_reservation_strict (correctamente) no permite crearlas.
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() - interval '30 minutes', now() + interval '30 minutes', 5)
  returning id into _b_iniciado;
  insert into public.reservations (user_id, facility_id, block_id, starts_at, ends_at)
  values (_dueno, _fac, _b_iniciado, now() - interval '30 minutes', now() + interval '30 minutes')
  returning id into _res_iniciada;

  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() - interval '3 hours', now() - interval '2 hours', 5)
  returning id into _b_vencido;
  insert into public.reservations (user_id, facility_id, block_id, starts_at, ends_at)
  values (_dueno, _fac, _b_vencido, now() - interval '3 hours', now() - interval '2 hours')
  returning id into _res_vencida;

  -- ---------------------------------------------------------------
  -- Un tercero no puede cancelar una reserva ajena.
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_otro);
  _r := public.cancel_reservation(_res_lejana);
  assert (_r ->> 'error') = 'no_autorizado',
    format('Un tercero pudo intentar cancelar: %s', _r);
  assert (select status from public.reservations where id = _res_lejana) = 'vigente',
    'La reserva ajena cambió de estado';

  -- ---------------------------------------------------------------
  -- REQ-15 · el dueño cancela con más de 2 horas de anticipación.
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_dueno);
  _r := public.cancel_reservation(_res_lejana, 'Cambio de planes');
  assert (_r ->> 'ok')::boolean, format('La cancelación válida falló: %s', _r);
  assert (_r ->> 'cancelado_por') = 'usuario', 'Rol de cancelación incorrecto';
  assert (select status from public.reservations where id = _res_lejana) = 'cancelada',
    'La reserva no quedó cancelada';
  assert (select cancelled_at is not null and cancelled_by = _dueno
          from public.reservations where id = _res_lejana),
    'No se registró quién canceló ni cuándo';
  assert exists (
    select 1 from public.reservation_audit_log
    where reservation_id = _res_lejana and action = 'reserva_cancelada_usuario'
  ), 'Falta la auditoría de cancelación de usuario';

  -- El cupo se libera de inmediato.
  assert (select available_count from public.block_availability where block_id = _b_lejano) = 5,
    'El cupo no se liberó al cancelar';

  -- Cancelar dos veces es idempotente, no un error.
  _r := public.cancel_reservation(_res_lejana);
  assert (_r ->> 'ok')::boolean and (_r ->> 'ya_cancelada')::boolean,
    format('La segunda cancelación debía ser idempotente: %s', _r);

  -- ---------------------------------------------------------------
  -- Ventana de 2 horas: el dueño no puede cancelar.
  -- ---------------------------------------------------------------
  _r := public.cancel_reservation(_res_cercana);
  assert (_r ->> 'error') = 'ventana_cerrada',
    format('Debía rechazar por la ventana de 2 horas: %s', _r);
  assert (select status from public.reservations where id = _res_cercana) = 'vigente',
    'La reserva se canceló dentro de la ventana prohibida';

  -- ---------------------------------------------------------------
  -- Reserva ya iniciada y reserva vencida.
  -- ---------------------------------------------------------------
  _r := public.cancel_reservation(_res_iniciada);
  assert (_r ->> 'error') = 'reserva_iniciada',
    format('Debía rechazar una reserva iniciada: %s', _r);

  _r := public.cancel_reservation(_res_vencida);
  assert (_r ->> 'error') = 'reserva_vencida',
    format('Debía rechazar una reserva vencida: %s', _r);

  -- Reserva inexistente.
  _r := public.cancel_reservation('00000000-0000-0000-0000-000000000000');
  assert (_r ->> 'error') = 'reserva_inexistente',
    format('Debía rechazar una reserva inexistente: %s', _r);

  raise notice 'OK · reglas de cancelación del usuario';
end;
$$;

do $$
declare
  _usuario uuid; _admin uuid; _admin_ajeno uuid;
  _fac uuid; _fac_ajeno uuid; _bloque uuid; _res uuid;
  _r jsonb;
begin
  _usuario     := test_helpers.create_user('c3@uc.cl', 'Javi Usuario');
  _admin       := test_helpers.create_user('c4@uc.cl', 'Karla Admin', 'administrador');
  _admin_ajeno := test_helpers.create_user('c5@uc.cl', 'Luis Admin', 'administrador');

  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 30b', 'Tenis') returning id into _fac;
  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 30c', 'Tenis') returning id into _fac_ajeno;

  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin_ajeno, _fac_ajeno);

  -- Bloque a 30 minutos: dentro de la ventana prohibida para el usuario.
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '30 minutes', now() + interval '90 minutes', 3)
  returning id into _bloque;

  -- Usuario con consentimiento de WhatsApp, para comprobar REQ-26.
  perform test_helpers.login_as(_usuario);
  perform public.set_whatsapp_consent('+56987654321', true);
  _res := (public.create_reservation_strict(_bloque) ->> 'reservation_id')::uuid;

  -- ---------------------------------------------------------------
  -- Un administrador de OTRO recinto no puede cancelar (REQ-29).
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_admin_ajeno);
  _r := public.cancel_reservation(_res, 'Intento indebido');
  assert (_r ->> 'error') = 'no_autorizado',
    format('Un administrador no asignado pudo intentar cancelar: %s', _r);

  -- ---------------------------------------------------------------
  -- REQ-32 · el administrador asignado cancela sin ventana de 2 horas.
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_admin);
  _r := public.cancel_reservation(_res, 'Mantención de la cancha');
  assert (_r ->> 'ok')::boolean, format('El administrador no pudo cancelar: %s', _r);
  assert (_r ->> 'cancelado_por') = 'administrador', 'Rol de cancelación incorrecto';
  assert (select cancelled_by_role from public.reservations where id = _res) = 'administrador',
    'No se registró el rol del administrador';
  assert (select cancel_reason from public.reservations where id = _res) = 'Mantención de la cancha',
    'No se guardó el motivo';
  assert exists (
    select 1 from public.reservation_audit_log
    where reservation_id = _res and action = 'reserva_cancelada_admin'
  ), 'Falta la auditoría de cancelación administrativa';

  -- El cupo vuelve a estar disponible de inmediato.
  assert (select available_count from public.block_availability where block_id = _bloque) = 3,
    'El cupo no se liberó tras la cancelación administrativa';

  -- ---------------------------------------------------------------
  -- REQ-26 · se encola el aviso por WhatsApp al usuario afectado.
  -- ---------------------------------------------------------------
  assert (_r ->> 'notificacion_whatsapp')::boolean,
    'No se marcó el envío de notificación al usuario';
  assert exists (
    select 1 from public.notification_jobs
    where reservation_id = _res and kind = 'cancelacion_admin' and status = 'pendiente'
  ), 'No se encoló el aviso de cancelación administrativa';
  assert (select payload ->> 'motivo' from public.notification_jobs
          where reservation_id = _res and kind = 'cancelacion_admin') = 'Mantención de la cancha',
    'El motivo no llegó al trabajo de notificación';

  -- No se envían recordatorios de reservas canceladas.
  assert not exists (
    select 1 from public.notification_jobs
    where reservation_id = _res and kind in ('confirmacion', 'recordatorio')
      and status in ('pendiente', 'procesando', 'error')
  ), 'Quedaron notificaciones activas de una reserva cancelada';

  raise notice 'OK · cancelación administrativa y aviso por WhatsApp';
end;
$$;

do $$
declare
  _u1 uuid; _u2 uuid; _fac uuid; _bloque uuid; _res1 uuid; _r jsonb;
begin
  -- Cancelación y nueva reserva sobre el cupo liberado.
  _u1 := test_helpers.create_user('c6@uc.cl', 'Marta Ciclo');
  _u2 := test_helpers.create_user('c7@uc.cl', 'Nico Ciclo');

  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 30d', 'Pádel') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '6 hours', now() + interval '7 hours', 1)
  returning id into _bloque;

  perform test_helpers.login_as(_u1);
  _res1 := (public.create_reservation_strict(_bloque) ->> 'reservation_id')::uuid;

  -- Con el único cupo tomado, el segundo usuario no entra.
  perform test_helpers.login_as(_u2);
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'error') = 'sin_cupos', 'Debía estar agotado';

  -- El primero cancela.
  perform test_helpers.login_as(_u1);
  _r := public.cancel_reservation(_res1);
  assert (_r ->> 'ok')::boolean, 'La cancelación falló';

  -- Ahora el segundo sí puede reservar.
  perform test_helpers.login_as(_u2);
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'ok')::boolean, format('No se pudo reservar el cupo liberado: %s', _r);
  assert (select count(*) from public.reservations where block_id = _bloque and status = 'vigente') = 1,
    'Hay más reservas vigentes que capacidad tras el ciclo cancelar/reservar';

  -- El primer usuario puede volver a reservar el mismo bloque: su
  -- reserva anterior está cancelada, así que no es un duplicado.
  perform test_helpers.login_as(_u1);
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'error') = 'sin_cupos',
    format('El bloque está lleno otra vez, debía rechazar: %s', _r);

  raise notice 'OK · el cupo liberado queda disponible de inmediato';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _res uuid; _r jsonb;
begin
  -- Cancelar con Calendar conectado encola la eliminación del evento.
  _u := test_helpers.create_user('c8@uc.cl', 'Olga Calendar');
  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.x.y', 'v1.x.y', now() + interval '1 hour');

  perform test_helpers.login_as(_u);
  insert into public.facilities (name, facility_type)
  values ('Cancha Prueba 30e', 'Vóleibol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '6 hours', now() + interval '7 hours', 2)
  returning id into _bloque;

  _res := (public.create_reservation_strict(_bloque) ->> 'reservation_id')::uuid;

  -- Caso A · el evento todavía no se creó: se cancela el trabajo y no se
  -- encola ninguna eliminación (no hay nada que borrar en Google).
  _r := public.cancel_reservation(_res);
  assert (select status from public.calendar_sync_jobs
          where reservation_id = _res and kind = 'crear_evento') = 'cancelado',
    'El trabajo de creación pendiente debía cancelarse';
  assert not exists (
    select 1 from public.calendar_sync_jobs where reservation_id = _res and kind = 'eliminar_evento'
  ), 'No debía encolarse una eliminación si el evento nunca se creó';
  assert (_r ->> 'calendar_sync_status') = 'no_aplica',
    format('Estado de calendario inesperado: %s', _r ->> 'calendar_sync_status');

  -- Caso B · el evento ya existe: se encola la eliminación (REQ-19).
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 2)
  returning id into _bloque;
  _res := (public.create_reservation_strict(_bloque) ->> 'reservation_id')::uuid;

  update public.reservations
  set calendar_event_id = 'activauc' || replace(_res::text, '-', ''),
      calendar_sync_status = 'sincronizado'
  where id = _res;
  update public.calendar_sync_jobs set status = 'completado'
  where reservation_id = _res and kind = 'crear_evento';

  _r := public.cancel_reservation(_res);
  assert exists (
    select 1 from public.calendar_sync_jobs
    where reservation_id = _res and kind = 'eliminar_evento' and status = 'pendiente'
  ), 'No se encoló la eliminación del evento de Calendar';
  assert (_r ->> 'calendar_sync_status') = 'pendiente',
    'La reserva debía quedar con sincronización pendiente';

  -- La reserva sigue cancelada independientemente de Google.
  assert (select status from public.reservations where id = _res) = 'cancelada',
    'El estado de la reserva depende de la integración (no debe ocurrir)';

  raise notice 'OK · encolado de eliminación de eventos de Calendar';
end;
$$;

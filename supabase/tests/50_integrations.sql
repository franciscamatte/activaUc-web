-- =====================================================================
-- Pruebas · colas de integración, reintentos, idempotencia y webhooks
-- (REQ-20, REQ-21, REQ-23, REQ-25, REQ-27, REQ-33)
-- =====================================================================

do $$
declare
  _u uuid; _fac uuid; _blk uuid; _res uuid;
  _job record; _n int;
begin
  -- Reclamo de trabajos de Calendar con reintentos y backoff.
  _u := test_helpers.create_user('i1@uc.cl', 'Tomas Cola');
  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour');

  perform test_helpers.login_as(_u);
  insert into public.facilities (name, facility_type) values ('Recinto Cola 50', 'Fútbol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '6 hours', now() + interval '7 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;
  perform test_helpers.logout();

  -- Reclamo: el trabajo queda "procesando" con un intento consumido.
  select * into _job from public.claim_calendar_jobs(10) limit 1;
  assert _job.id is not null, 'claim_calendar_jobs no devolvió el trabajo pendiente';
  assert _job.attempts = 1, format('attempts esperado 1, obtenido %s', _job.attempts);
  assert (select status from public.calendar_sync_jobs where id = _job.id) = 'procesando',
    'El trabajo reclamado no quedó en procesando';

  -- Un segundo reclamo inmediato no lo entrega otra vez (sin duplicar trabajo).
  select count(*) into _n from public.claim_calendar_jobs(10);
  assert _n = 0, 'Un trabajo en proceso se volvió a entregar';

  -- Fallo reintentable: backoff exponencial, sigue habiendo intentos.
  perform public.fail_calendar_job(_job.id, 'HTTP 503 de Google', true);
  assert (select next_attempt_at from public.calendar_sync_jobs where id = _job.id) > now(),
    'El backoff no retrasó el próximo intento';
  assert (select attempts from public.calendar_sync_jobs where id = _job.id) = 1,
    'Un fallo reintentable no debe agotar los intentos';
  assert (select calendar_sync_status from public.reservations where id = _res) = 'pendiente',
    'Un fallo reintentable no debe marcar la reserva como error';

  -- Mientras el backoff está vigente, no se vuelve a reclamar.
  select count(*) into _n from public.claim_calendar_jobs(10);
  assert _n = 0, 'Se reclamó un trabajo antes de su next_attempt_at';

  -- Fallo definitivo: estado error en el trabajo y en la reserva (REQ-21).
  perform public.fail_calendar_job(_job.id, 'invalid_grant: el usuario revocó el acceso', false);
  assert (select status from public.calendar_sync_jobs where id = _job.id) = 'error',
    'El trabajo no quedó en error tras un fallo definitivo';
  assert (select calendar_sync_status from public.reservations where id = _res) = 'error',
    'La reserva no refleja el error de sincronización';
  assert exists (
    select 1 from public.reservation_audit_log where reservation_id = _res and action = 'calendar_error'
  ), 'Falta la auditoría del error de Calendar';

  -- La reserva sigue siendo válida: un fallo de Google no la invalida.
  assert (select status from public.reservations where id = _res) = 'vigente',
    'Un fallo de Google invalidó la reserva (viola la regla de negocio)';

  -- Agotados los intentos, ya no se reclama.
  update public.calendar_sync_jobs set next_attempt_at = now() - interval '1 minute' where id = _job.id;
  select count(*) into _n from public.claim_calendar_jobs(10);
  assert _n = 0, 'Se reclamó un trabajo con los intentos agotados';

  raise notice 'OK · reintentos, backoff y tope de intentos en Calendar';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _blk uuid; _res uuid; _job record;
begin
  -- Éxito de Calendar: estado sincronizado y event_id persistido.
  _u := test_helpers.create_user('i2@uc.cl', 'Ursula Sync');
  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour');

  perform test_helpers.login_as(_u);
  insert into public.facilities (name, facility_type) values ('Recinto Cola 50b', 'Tenis') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '6 hours', now() + interval '7 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;
  perform test_helpers.logout();

  select * into _job from public.claim_calendar_jobs(10) limit 1;
  perform public.complete_calendar_job(_job.id, 'activauc' || replace(_res::text, '-', ''));

  assert (select calendar_sync_status from public.reservations where id = _res) = 'sincronizado',
    'La reserva no quedó como sincronizada';
  assert (select calendar_event_id from public.reservations where id = _res)
         = 'activauc' || replace(_res::text, '-', ''),
    'No se guardó el identificador del evento';
  assert (select status from public.calendar_sync_jobs where id = _job.id) = 'completado',
    'El trabajo no quedó completado';
  assert exists (
    select 1 from public.reservation_audit_log
    where reservation_id = _res and action = 'calendar_evento_creado'
  ), 'Falta la auditoría de creación del evento';

  raise notice 'OK · sincronización exitosa con Google Calendar';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _blk uuid; _res uuid; _job record; _n int;
begin
  -- Cola de notificaciones: consentimiento, reintentos y trazabilidad.
  _u := test_helpers.create_user('i3@uc.cl', 'Vale Mensaje');
  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);

  insert into public.facilities (name, facility_type) values ('Recinto Cola 50c', 'Pádel') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '6 hours', now() + interval '7 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;
  perform test_helpers.logout();

  -- Sólo la confirmación está vencida; el recordatorio es para más tarde.
  select count(*) into _n from public.claim_notification_jobs(10);
  assert _n = 1, format('Debía reclamarse sólo la confirmación, se reclamaron %s', _n);

  -- El recordatorio sigue pendiente y programado a futuro (REQ-25).
  assert (select status from public.notification_jobs where reservation_id = _res and kind = 'recordatorio') = 'pendiente',
    'El recordatorio no debía reclamarse todavía';

  -- Envío exitoso: trazabilidad en notification_messages (REQ-27).
  select * into _job from public.notification_jobs
  where reservation_id = _res and kind = 'confirmacion';
  perform public.complete_notification_job(_job.id, 'SM_PRUEBA_0001', 'i3@uc.cl');

  assert (select status from public.notification_messages where provider_message_sid = 'SM_PRUEBA_0001') = 'enviado',
    'No se registró el mensaje como enviado';
  assert (select kind from public.notification_messages where provider_message_sid = 'SM_PRUEBA_0001') = 'confirmacion',
    'El tipo de mensaje registrado es incorrecto';
  assert exists (
    select 1 from public.reservation_audit_log
    where reservation_id = _res and action = 'notificacion_enviada'
  ), 'Falta la auditoría del envío';

  -- El proveedor de correo no informa la entrega: su API es asíncrona y
  -- no tiene webhook de estados. Así que 'enviado' es el estado final de
  -- un envío correcto, y eso se comprueba en lugar de dar por hecho un
  -- 'entregado' que nadie puede fijar.
  assert (select delivered_at is null from public.notification_messages
          where provider_message_sid = 'SM_PRUEBA_0001'),
    'Nada debería fijar la fecha de entrega: el proveedor no la informa';

  raise notice 'OK · cola de notificaciones y trazabilidad del envío';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _blk uuid; _res uuid; _job record; _n int;
begin
  -- Fallo de Twilio: reintentos y registro de fallo definitivo.
  _u := test_helpers.create_user('i4@uc.cl', 'Wenu Fallo');
  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);

  insert into public.facilities (name, facility_type) values ('Recinto Cola 50d', 'Vóleibol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '6 hours', now() + interval '7 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;
  perform test_helpers.logout();

  select * into _job from public.claim_notification_jobs(10) limit 1;

  -- Fallo transitorio: se reprograma con backoff.
  perform public.fail_notification_job(_job.job_id, 'HTTP 429 de Twilio', '20429', true);
  assert (select next_attempt_at from public.notification_jobs where id = _job.job_id) > now(),
    'El backoff no retrasó el reintento del mensaje';
  assert not exists (select 1 from public.notification_messages where notification_job_id = _job.job_id),
    'Un fallo transitorio no debe registrar un mensaje fallido definitivo';

  -- Fallo permanente (dirección rechazada): queda fallido y trazado.
  perform public.fail_notification_job(_job.job_id, 'El proveedor rechazó la dirección', 'invalid_parameter', false);
  assert (select status from public.notification_messages where notification_job_id = _job.job_id) = 'fallido',
    'No se registró el mensaje como fallido';
  assert (select error_code from public.notification_messages where notification_job_id = _job.job_id) = 'invalid_parameter',
    'No se guardó el código de error del proveedor';
  assert exists (
    select 1 from public.reservation_audit_log
    where reservation_id = _res and action = 'notificacion_fallida'
  ), 'Falta la auditoría del fallo de envío';

  -- La reserva sigue vigente: el aviso es informativo.
  assert (select status from public.reservations where id = _res) = 'vigente',
    'Un fallo de notificación invalidó la reserva';

  -- Agotados los intentos, no se vuelve a reclamar.
  update public.notification_jobs set next_attempt_at = now() - interval '1 minute' where id = _job.job_id;
  select count(*) into _n from public.claim_notification_jobs(10);
  assert _n = 0, 'Se reclamó un mensaje con los intentos agotados';

  raise notice 'OK · reintentos y fallos definitivos del envío';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _blk uuid; _res uuid; _n int; _r jsonb;
begin
  -- REQ-23 · revocar el consentimiento detiene los envíos.
  _u := test_helpers.create_user('i5@uc.cl', 'Ximena Revoca');
  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);

  insert into public.facilities (name, facility_type) values ('Recinto Cola 50e', 'Fútbol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '10 hours', now() + interval '11 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;

  assert (select count(*) from public.notification_jobs
          where reservation_id = _res and status = 'pendiente') = 2,
    'Debían quedar encolados la confirmación y el recordatorio';

  -- Revocación.
  _r := public.set_email_consent(false);
  assert (_r ->> 'ok')::boolean, format('La revocación no se aplicó: %s', _r);
  assert (select not email_consent and email_consent_at is null
            from public.profiles where id = _u),
    'El consentimiento no se eliminó';

  -- Todos los trabajos pendientes quedan cancelados.
  assert (select count(*) from public.notification_jobs
          where reservation_id = _res and status in ('pendiente', 'error')) = 0,
    'Quedaron notificaciones activas tras revocar el consentimiento';
  assert exists (
    select 1 from public.reservation_audit_log
    where actor_id = _u and action = 'consentimiento_revocado'
  ), 'Falta la auditoría de revocación';

  perform test_helpers.logout();

  -- Y ya no se reclama nada para ese usuario.
  select count(*) into _n from public.claim_notification_jobs(10);
  assert _n = 0, 'Se reclamó una notificación de un usuario sin consentimiento';

  -- Volver a consentir reactiva el canal, sin resucitar lo cancelado:
  -- un aviso que ya no se envió no se reintenta semanas después.
  perform test_helpers.login_as(_u);
  _r := public.set_email_consent(true);
  assert (_r ->> 'ok')::boolean, format('No se pudo volver a consentir: %s', _r);
  assert (select email_consent from public.profiles where id = _u),
    'El consentimiento no volvió a activarse';
  assert (select count(*) from public.notification_jobs
          where reservation_id = _res and status in ('pendiente', 'error')) = 0,
    'Volver a consentir resucitó notificaciones ya canceladas';

  raise notice 'OK · revocación y reactivación del consentimiento de correo';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _blk uuid; _res uuid; _job record; _n int;
begin
  -- Interrupción a mitad de proceso: el trabajo se libera y se reintenta.
  _u := test_helpers.create_user('i6@uc.cl', 'Yago Interrumpe');
  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour');

  perform test_helpers.login_as(_u);
  insert into public.facilities (name, facility_type) values ('Recinto Cola 50f', 'Tenis') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '6 hours', now() + interval '7 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;
  perform test_helpers.logout();

  select * into _job from public.claim_calendar_jobs(10) limit 1;
  assert (select status from public.calendar_sync_jobs where id = _job.id) = 'procesando',
    'El trabajo debía quedar en procesando';

  -- El worker muere sin completar ni fallar el trabajo: queda "colgado".
  -- Pasados 10 minutos, el siguiente reclamo lo rescata.
  update public.calendar_sync_jobs
  set locked_at = now() - interval '15 minutes'
  where id = _job.id;

  select count(*) into _n from public.claim_calendar_jobs(10);
  assert _n = 1, 'El trabajo huérfano no se recuperó tras el tiempo de gracia';
  assert (select attempts from public.calendar_sync_jobs where id = _job.id) = 2,
    'El reintento no incrementó el contador de intentos';

  raise notice 'OK · recuperación de trabajos interrumpidos';
end;
$$;

do $$
declare
  _admin uuid; _u uuid; _fac uuid; _blk uuid; _res uuid; _n int;
begin
  -- REQ-33 · informe de integraciones para el administrador asignado.
  _admin := test_helpers.create_user('i7@uc.cl', 'Zoe AdminReporte', 'administrador');
  _u     := test_helpers.create_user('i8@uc.cl', 'Ale Usuario');

  insert into public.facilities (name, facility_type) values ('Recinto Reporte 50', 'Fútbol') returning id into _fac;
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);

  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour');

  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '6 hours', now() + interval '7 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;

  perform test_helpers.login_as(_admin);
  select count(*) into _n from public.admin_integration_report(100);
  assert _n >= 1, 'El informe de integraciones no devolvió el trabajo de Calendar';
  assert exists (
    select 1 from public.admin_integration_report(100) where kind = 'google_calendar'
  ), 'Falta la fila de Google Calendar en el informe';

  raise notice 'OK · informe de integraciones del administrador';
end;
$$;

-- ---------------------------------------------------------------------
-- REQ-33 · descartar una incidencia ya resuelta
-- ---------------------------------------------------------------------
-- El aviso del panel sólo sirve si se puede apagar cuando ya no hay nada
-- que arreglar. Lo que importa: que se descarten sólo las que están en
-- error, sólo de los recintos propios, que la fila no se borre —es la
-- trazabilidad de REQ-27— y que quede constancia de quién lo hizo.
do $$
declare
  _admin uuid; _otro uuid; _u uuid;
  _fac uuid; _blk uuid; _res uuid;
  _trabajo uuid; _mensaje uuid;
  _job public.notification_jobs;
  _r jsonb; _n int;
begin
  _admin := test_helpers.create_user('i20@uc.cl', 'Ana Descarta', 'administrador');
  _otro  := test_helpers.create_user('i21@uc.cl', 'Otro Admin', 'administrador');
  _u     := test_helpers.create_user('i22@uc.cl', 'Usuaria Descarte');

  insert into public.facilities (name, facility_type)
  values ('Recinto Descarte 50', 'Tenis') returning id into _fac;
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);

  -- Sin conexión de calendario no se encola trabajo de Calendar, y la
  -- prueba necesita una incidencia de cada tipo.
  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour');

  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;

  select id into _trabajo from public.calendar_sync_jobs where reservation_id = _res limit 1;
  assert _trabajo is not null, 'La reserva no encoló trabajo de Calendar';

  -- La fila de notification_messages la escribe el despacho, no la reserva:
  -- se recorre ese camino para tener una incidencia de verdad.
  perform test_helpers.logout();
  perform public.claim_notification_jobs(10);
  select * into _job from public.notification_jobs
   where reservation_id = _res and kind = 'confirmacion' and channel = 'email';
  assert _job.id is not null, 'No se encoló la confirmación por correo';
  perform public.complete_notification_job(_job.id, 'SM_DESCARTE_0001', '+56955554444');

  select id into _mensaje from public.notification_messages
   where provider_message_sid = 'SM_DESCARTE_0001';
  assert _mensaje is not null, 'El despacho no registró el mensaje';

  -- Todavía no están en error: no hay nada que descartar.
  perform test_helpers.login_as(_admin);
  _r := public.admin_descartar_incidencia('google_calendar', _trabajo);
  assert _r ->> 'codigo' = 'no_es_incidencia',
    format('Una integración que no falló no debería descartarse: %s', _r);

  -- Se las deja en error, como habría quedado un fallo real.
  update public.calendar_sync_jobs set status = 'error', last_error = 'falló de prueba'
   where id = _trabajo;
  update public.notification_messages set status = 'fallido', error_message = 'falló de prueba'
   where id = _mensaje;

  select count(*) into _n from public.admin_integration_report(100)
   where status in ('error', 'fallido');
  assert _n = 2, format('El informe debería traer las 2 incidencias, trajo %s', _n);

  -- Un administrador de otro recinto no puede descartarlas.
  perform test_helpers.login_as(_otro);
  _r := public.admin_descartar_incidencia('google_calendar', _trabajo);
  assert _r ->> 'codigo' = 'no_autorizado',
    format('Un administrador ajeno no debería poder descartar: %s', _r);

  -- Un usuario común, tampoco.
  perform test_helpers.login_as(_u);
  _r := public.admin_descartar_incidencia('notificacion', _mensaje);
  assert _r ->> 'codigo' = 'no_autorizado',
    format('Un usuario común no debería poder descartar: %s', _r);

  -- El administrador del recinto sí.
  perform test_helpers.login_as(_admin);
  _r := public.admin_descartar_incidencia('google_calendar', _trabajo);
  assert (_r ->> 'ok')::boolean, format('No se pudo descartar: %s', _r);
  _r := public.admin_descartar_incidencia('notificacion', _mensaje);
  assert (_r ->> 'ok')::boolean, format('No se pudo descartar el mensaje: %s', _r);

  -- Desaparecen del informe...
  select count(*) into _n from public.admin_integration_report(100)
   where status in ('error', 'fallido');
  assert _n = 0, format('El informe seguía contando %s incidencias descartadas', _n);

  -- ...pero las filas siguen ahí, que es lo que pide la trazabilidad.
  assert exists (
    select 1 from public.calendar_sync_jobs where id = _trabajo and dismissed_at is not null
  ), 'La fila del trabajo de Calendar no debería borrarse al descartarla';
  assert exists (
    select 1 from public.notification_messages where id = _mensaje and dismissed_by = _admin
  ), 'El mensaje no guardó quién lo descartó';

  -- Y no se descarta dos veces.
  _r := public.admin_descartar_incidencia('notificacion', _mensaje);
  assert _r ->> 'codigo' = 'ya_descartada',
    format('Descartar dos veces debería informarse: %s', _r);

  -- Un tipo inventado no toca nada.
  _r := public.admin_descartar_incidencia('telepatia', _mensaje);
  assert _r ->> 'codigo' = 'tipo_desconocido',
    format('Un tipo desconocido debería rechazarse: %s', _r);

  assert exists (
    select 1 from public.reservation_audit_log
     where action = 'incidencia_descartada' and actor_id = _admin
  ), 'No quedó constancia en la auditoría';

  raise notice 'OK · descartar incidencias retira del informe sin borrar la fila';
end;
$$;

-- ---------------------------------------------------------------------
-- REQ-18, REQ-20 · conectar el calendario después de haber reservado
-- ---------------------------------------------------------------------
-- Quien conecta su calendario más tarde esperaría ver ahí las reservas
-- que ya tenía. Lo que importa de esta comprobación: que se encolen las
-- futuras, que **no** se encolen las pasadas ni las canceladas, y que
-- reconectar no duplique nada.
do $$
declare
  _u uuid; _fac uuid; _futura uuid; _pasada uuid; _cancelada uuid;
  _blk uuid; _n int;
begin
  _u := test_helpers.create_user('i30@uc.cl', 'Rosa Reconecta');

  insert into public.facilities (name, facility_type)
  values ('Recinto Reconexión', 'Fútbol') returning id into _fac;

  -- Una reserva futura, creada SIN calendario conectado.
  perform test_helpers.login_as(_u);
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '30 hours', now() + interval '31 hours', 4)
  returning id into _blk;
  _futura := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;

  assert (select calendar_sync_status::text from public.reservations where id = _futura)
         = 'no_aplica',
    'Sin calendario conectado, la reserva no debería tener sincronización';
  assert not exists (select 1 from public.calendar_sync_jobs where reservation_id = _futura),
    'Sin calendario conectado no debería encolarse nada';

  -- Y dos que no deben tocarse: una pasada y una cancelada.
  perform test_helpers.logout();
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() - interval '30 hours', now() - interval '29 hours', 4)
  returning id into _blk;
  insert into public.reservations (user_id, facility_id, block_id, starts_at, ends_at, status)
  values (_u, _fac, _blk, now() - interval '30 hours', now() - interval '29 hours', 'vigente')
  returning id into _pasada;

  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '40 hours', now() + interval '41 hours', 4)
  returning id into _blk;
  -- `reservations_cancel_consistency` exige la fecha de cancelación.
  insert into public.reservations
    (user_id, facility_id, block_id, starts_at, ends_at, status, cancelled_at, cancelled_by_role)
  values (_u, _fac, _blk, now() + interval '40 hours', now() + interval '41 hours',
          'cancelada', now(), 'usuario')
  returning id into _cancelada;

  -- Ahora conecta el calendario.
  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u, 'conectado', 'v1.a.b', 'v1.a.b', now() + interval '1 hour');

  assert exists (
    select 1 from public.calendar_sync_jobs
     where reservation_id = _futura and kind = 'crear_evento'
  ), 'Al conectar no se encoló la reserva futura que ya existía';

  assert (select calendar_sync_status::text from public.reservations where id = _futura)
         = 'pendiente',
    'La reserva futura debería quedar como pendiente de sincronizar';

  assert not exists (select 1 from public.calendar_sync_jobs where reservation_id = _pasada),
    'No debería encolarse una reserva que ya pasó';
  assert not exists (select 1 from public.calendar_sync_jobs where reservation_id = _cancelada),
    'No debería encolarse una reserva cancelada';

  select count(*) into _n from public.calendar_sync_jobs where reservation_id = _futura;
  assert _n = 1, format('Esperaba un solo trabajo, hay %s', _n);

  -- Reconectar (revocar y volver) no duplica: la clave es la misma.
  update public.calendar_connections set status = 'revocado' where user_id = _u;
  update public.calendar_connections set status = 'conectado' where user_id = _u;

  select count(*) into _n from public.calendar_sync_jobs where reservation_id = _futura;
  assert _n = 1, format('Reconectar duplicó el trabajo: hay %s', _n);

  -- Y si el trabajo había agotado sus intentos —el caso de quien
  -- reconecta porque el token de Google había caducado—, reconectar lo
  -- revive en lugar de dejarlo muerto.
  update public.calendar_sync_jobs
  set status = 'error', attempts = 5, last_error = 'token caducado',
      dismissed_at = now()
  where reservation_id = _futura;

  update public.calendar_connections set status = 'revocado' where user_id = _u;
  update public.calendar_connections set status = 'conectado' where user_id = _u;

  assert (select status::text from public.calendar_sync_jobs where reservation_id = _futura)
         = 'pendiente',
    'Reconectar debería revivir el trabajo que había fallado';
  assert (select attempts from public.calendar_sync_jobs where reservation_id = _futura) = 0,
    'Al revivirlo, los intentos deberían volver a cero';
  assert (select dismissed_at is null from public.calendar_sync_jobs where reservation_id = _futura),
    'Un trabajo revivido no debería seguir descartado del informe';

  -- Y el caso de verdad frecuente: desconectar **cancela** los trabajos
  -- pendientes, así que reconectar tiene que revivir también eso. Es el
  -- camino que sigue cualquiera que vea su calendario desactualizado.
  update public.calendar_sync_jobs
  set status = 'cancelado', last_error = 'Conexión de Google Calendar revocada.'
  where reservation_id = _futura;
  update public.reservations set calendar_sync_status = 'no_aplica' where id = _futura;

  update public.calendar_connections set status = 'revocado' where user_id = _u;
  update public.calendar_connections set status = 'conectado' where user_id = _u;

  assert (select status::text from public.calendar_sync_jobs where reservation_id = _futura)
         = 'pendiente',
    'Reconectar debería revivir el trabajo que canceló la desconexión';
  assert (select calendar_sync_status::text from public.reservations where id = _futura)
         = 'pendiente',
    'La reserva debería volver a quedar pendiente de sincronizar';

  -- Un trabajo ya completado no se revive: su evento existe.
  update public.calendar_sync_jobs set status = 'completado' where reservation_id = _futura;
  update public.calendar_connections set status = 'revocado' where user_id = _u;
  update public.calendar_connections set status = 'conectado' where user_id = _u;
  assert (select status::text from public.calendar_sync_jobs where reservation_id = _futura)
         = 'completado',
    'Un trabajo completado no debería reabrirse al reconectar';

  -- Y queda constancia de la conexión con cuántas reservas arrastró.
  assert exists (
    select 1 from public.reservation_audit_log
     where actor_id = _u and action = 'calendar_conectado'
       and (details ->> 'reservas_encoladas')::int = 1
  ), 'Falta la constancia de la conexión con las reservas encoladas';

  raise notice 'OK · conectar el calendario arrastra las reservas futuras';
end;
$$;

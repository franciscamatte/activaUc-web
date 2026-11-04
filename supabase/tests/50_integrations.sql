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
  -- Cola de WhatsApp: consentimiento, reintentos y trazabilidad.
  _u := test_helpers.create_user('i3@uc.cl', 'Vale Mensaje');
  perform test_helpers.login_as(_u);
  perform public.set_whatsapp_consent('+56933333333', true);

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

  -- Envío exitoso: trazabilidad en whatsapp_messages (REQ-27).
  select * into _job from public.notification_jobs
  where reservation_id = _res and kind = 'confirmacion';
  perform public.complete_notification_job(_job.id, 'SM_PRUEBA_0001', '+56933333333');

  assert (select status from public.whatsapp_messages where provider_message_sid = 'SM_PRUEBA_0001') = 'enviado',
    'No se registró el mensaje como enviado';
  assert (select kind from public.whatsapp_messages where provider_message_sid = 'SM_PRUEBA_0001') = 'confirmacion',
    'El tipo de mensaje registrado es incorrecto';
  assert exists (
    select 1 from public.reservation_audit_log
    where reservation_id = _res and action = 'whatsapp_enviado'
  ), 'Falta la auditoría del envío';

  -- ---------------------------------------------------------------
  -- REQ-27 · webhook de Twilio: idempotencia y transición de estados
  -- ---------------------------------------------------------------
  assert public.register_webhook_event('twilio', 'SM_PRUEBA_0001', 'delivered', true, '{}'::jsonb),
    'El primer evento del webhook debía registrarse';
  assert public.apply_whatsapp_status('SM_PRUEBA_0001', 'delivered', null),
    'No se aplicó el estado entregado';
  assert (select status from public.whatsapp_messages where provider_message_sid = 'SM_PRUEBA_0001') = 'entregado',
    'El mensaje no quedó como entregado';
  assert (select delivered_at is not null from public.whatsapp_messages
          where provider_message_sid = 'SM_PRUEBA_0001'),
    'No se registró la fecha de entrega';

  -- Reentrega del mismo evento: se descarta (anti-replay).
  assert public.register_webhook_event('twilio', 'SM_PRUEBA_0001', 'delivered', true, '{}'::jsonb) = false,
    'Un evento repetido volvió a registrarse';

  -- Un estado anterior no debe retroceder el mensaje ya entregado.
  perform public.apply_whatsapp_status('SM_PRUEBA_0001', 'sent', null);
  assert (select status from public.whatsapp_messages where provider_message_sid = 'SM_PRUEBA_0001') = 'entregado',
    'El estado retrocedió de entregado a enviado';

  -- Un estado desconocido se ignora sin romper nada.
  assert public.apply_whatsapp_status('SM_PRUEBA_0001', 'estado_raro', null) = false,
    'Un estado desconocido no debía aplicarse';

  raise notice 'OK · cola de WhatsApp, trazabilidad e idempotencia del webhook';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _blk uuid; _res uuid; _job record; _n int;
begin
  -- Fallo de Twilio: reintentos y registro de fallo definitivo.
  _u := test_helpers.create_user('i4@uc.cl', 'Wenu Fallo');
  perform test_helpers.login_as(_u);
  perform public.set_whatsapp_consent('+56944444444', true);

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
  assert not exists (select 1 from public.whatsapp_messages where notification_job_id = _job.job_id),
    'Un fallo transitorio no debe registrar un mensaje fallido definitivo';

  -- Fallo permanente (número sin WhatsApp): queda fallido y trazado.
  perform public.fail_notification_job(_job.job_id, 'El número no tiene WhatsApp', '63003', false);
  assert (select status from public.whatsapp_messages where notification_job_id = _job.job_id) = 'fallido',
    'No se registró el mensaje como fallido';
  assert (select error_code from public.whatsapp_messages where notification_job_id = _job.job_id) = '63003',
    'No se guardó el código de error de Twilio';
  assert exists (
    select 1 from public.reservation_audit_log
    where reservation_id = _res and action = 'whatsapp_fallido'
  ), 'Falta la auditoría del fallo de envío';

  -- La reserva sigue vigente: WhatsApp es informativo.
  assert (select status from public.reservations where id = _res) = 'vigente',
    'Un fallo de WhatsApp invalidó la reserva';

  -- Agotados los intentos, no se vuelve a reclamar.
  update public.notification_jobs set next_attempt_at = now() - interval '1 minute' where id = _job.job_id;
  select count(*) into _n from public.claim_notification_jobs(10);
  assert _n = 0, 'Se reclamó un mensaje con los intentos agotados';

  raise notice 'OK · reintentos y fallos definitivos de WhatsApp';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _blk uuid; _res uuid; _n int; _r jsonb;
begin
  -- REQ-23 · revocar el consentimiento detiene los envíos.
  _u := test_helpers.create_user('i5@uc.cl', 'Ximena Revoca');
  perform test_helpers.login_as(_u);
  perform public.set_whatsapp_consent('+56955555555', true);

  insert into public.facilities (name, facility_type) values ('Recinto Cola 50e', 'Fútbol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '10 hours', now() + interval '11 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;

  assert (select count(*) from public.notification_jobs
          where reservation_id = _res and status = 'pendiente') = 2,
    'Debían quedar encolados la confirmación y el recordatorio';

  -- Revocación.
  _r := public.set_whatsapp_consent(null, false);
  assert (_r ->> 'ok')::boolean and (_r ->> 'consentimiento')::boolean = false,
    format('La revocación no se aplicó: %s', _r);
  assert (select phone is null and whatsapp_consent = false from public.profiles where id = _u),
    'El teléfono o el consentimiento no se eliminaron';

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

  -- Un teléfono inválido se rechaza con mensaje claro.
  perform test_helpers.login_as(_u);
  _r := public.set_whatsapp_consent('912345678', true);
  assert (_r ->> 'error') = 'telefono_invalido',
    format('Debía rechazar un teléfono no E.164: %s', _r);
  assert (select whatsapp_consent = false from public.profiles where id = _u),
    'Un teléfono inválido activó el consentimiento';

  raise notice 'OK · revocación de consentimiento y validación E.164';
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
  perform public.set_whatsapp_consent('+56966666666', true);
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
  perform public.set_whatsapp_consent('+56955554444', true);
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 4) returning id into _blk;
  _res := (public.create_reservation_strict(_blk) ->> 'reservation_id')::uuid;

  select id into _trabajo from public.calendar_sync_jobs where reservation_id = _res limit 1;
  assert _trabajo is not null, 'La reserva no encoló trabajo de Calendar';

  -- La fila de whatsapp_messages la escribe el despacho, no la reserva:
  -- se recorre ese camino para tener una incidencia de verdad.
  perform test_helpers.logout();
  perform public.claim_notification_jobs(10);
  select * into _job from public.notification_jobs
   where reservation_id = _res and kind = 'confirmacion' and channel = 'whatsapp';
  assert _job.id is not null, 'No se encoló la confirmación por WhatsApp';
  perform public.complete_notification_job(_job.id, 'SM_DESCARTE_0001', '+56955554444');

  select id into _mensaje from public.whatsapp_messages
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
  update public.whatsapp_messages set status = 'fallido', error_message = 'falló de prueba'
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
  _r := public.admin_descartar_incidencia('whatsapp', _mensaje);
  assert _r ->> 'codigo' = 'no_autorizado',
    format('Un usuario común no debería poder descartar: %s', _r);

  -- El administrador del recinto sí.
  perform test_helpers.login_as(_admin);
  _r := public.admin_descartar_incidencia('google_calendar', _trabajo);
  assert (_r ->> 'ok')::boolean, format('No se pudo descartar: %s', _r);
  _r := public.admin_descartar_incidencia('whatsapp', _mensaje);
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
    select 1 from public.whatsapp_messages where id = _mensaje and dismissed_by = _admin
  ), 'El mensaje no guardó quién lo descartó';

  -- Y no se descarta dos veces.
  _r := public.admin_descartar_incidencia('whatsapp', _mensaje);
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

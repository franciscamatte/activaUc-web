-- =====================================================================
-- Pruebas · notificaciones por correo (REQ-22 a REQ-26, dos canales)
-- ---------------------------------------------------------------------
-- Lo que importa verificar de un canal nuevo no es que envíe, sino que
-- no se cruce con el que ya existía: que cada consentimiento sea
-- independiente, que un mismo aviso por dos vías sean dos trabajos y no
-- uno que desplaza al otro, y que revocar uno no apague el otro.
-- =====================================================================

do $$
declare
  _u uuid; _r jsonb;
begin
  _u := test_helpers.create_user('correo1@uc.cl', 'Ana Correo');
  perform test_helpers.login_as(_u);

  -- Arranca sin consentimiento, como en producción.
  assert not (select email_consent from public.profiles where id = _u),
    'El consentimiento de correo no debería estar activo al crear la cuenta';

  _r := public.set_email_consent(true);
  assert (_r ->> 'ok')::boolean, format('set_email_consent falló: %s', _r);

  assert (select email_consent and email_consent_at is not null
          from public.profiles where id = _u),
    'El consentimiento quedó sin marca de tiempo';

  -- No hace falta teléfono: el correo no depende de él.
  assert (select phone is null from public.profiles where id = _u),
    'La prueba asume que no hay teléfono registrado';

  _r := public.set_email_consent(false);
  assert (select not email_consent and email_consent_at is null
          from public.profiles where id = _u),
    'Al revocar debe limpiarse la marca de tiempo';

  raise notice 'OK · consentimiento de correo independiente del teléfono';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _r jsonb;
begin
  -- El canal único: la reserva encola confirmación y recordatorio.
  _u := test_helpers.create_user('correo2@uc.cl', 'Beto Correo');
  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);

  insert into public.facilities (name, facility_type)
  values ('Recinto Correo', 'Tenis') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 5)
  returning id into _bloque;

  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'ok')::boolean, format('La reserva falló: %s', _r);

  assert (select count(*) from public.notification_jobs
          where reservation_id = (_r ->> 'reservation_id')::uuid
            and channel = 'email') = 2,
    'Esperaba confirmación y recordatorio por correo';
  assert (select count(*) from public.notification_jobs
          where reservation_id = (_r ->> 'reservation_id')::uuid
            and channel <> 'email') = 0,
    'No debería encolarse nada por otro canal: el correo es el único';

  -- Y la respuesta lo dice, para que la interfaz pueda informarlo.
  assert (_r -> 'canales') = '["email"]'::jsonb,
    format('Canales informados: %s', _r -> 'canales');

  raise notice 'OK · con el correo consentido, encola por correo';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _r jsonb; _reserva uuid;
begin
  -- Un trabajo por aviso, con claves distintas entre sí.
  _u := test_helpers.create_user('correo3@uc.cl', 'Cata Correo');
  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);

  insert into public.facilities (name, facility_type)
  values ('Recinto Claves', 'Fútbol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 5)
  returning id into _bloque;

  _r := public.create_reservation_strict(_bloque);
  _reserva := (_r ->> 'reservation_id')::uuid;

  assert (select count(*) from public.notification_jobs
          where reservation_id = _reserva and kind = 'confirmacion') = 1,
    'La confirmación debería encolarse una sola vez';
  assert (select count(distinct idempotency_key) from public.notification_jobs
          where reservation_id = _reserva) = 2,
    'Las dos claves de idempotencia deben ser distintas entre sí';

  -- La clave conserva el prefijo 'em:' con que se encoló siempre, de
  -- modo que lo encolado antes sigue siendo idempotente y un mismo
  -- aviso no se duplica.
  assert exists (
    select 1 from public.notification_jobs
    where reservation_id = _reserva
      and idempotency_key = 'em:confirm:' || _reserva::text
  ), 'La clave de la confirmación cambió de forma';

  raise notice 'OK · un trabajo por aviso, con claves estables';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _r jsonb; _reserva uuid;
begin
  -- Revocar un canal no debe apagar el otro.
  _u := test_helpers.create_user('correo4@uc.cl', 'Dani Correo');
  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);
  perform public.set_email_consent(true);

  insert into public.facilities (name, facility_type)
  values ('Recinto Revocar', 'Tenis') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 5)
  returning id into _bloque;

  _r := public.create_reservation_strict(_bloque);
  _reserva := (_r ->> 'reservation_id')::uuid;

  perform public.set_email_consent(false);

  assert (select count(*) from public.notification_jobs
          where reservation_id = _reserva and channel = 'email'
            and status = 'cancelado') = 2,
    'Al revocar el correo, lo encolado por correo debe descartarse';
  -- Y la reserva no se toca: el aviso es informativo.
  assert (select status from public.reservations where id = _reserva) = 'vigente',
    'Revocar el consentimiento no debe afectar a la reserva';

  raise notice 'OK · revocar descarta lo encolado y no toca la reserva';
end;
$$;

do $$
declare
  _u uuid; _fac uuid; _bloque uuid; _r jsonb; _reserva uuid;
  _trabajo record; _detalles jsonb;
begin
  -- El reclamo resuelve el destino de cada canal, y el registro guarda
  -- el correo en su propia columna.
  _u := test_helpers.create_user('correo5@uc.cl', 'Eva Correo');
  perform test_helpers.login_as(_u);
  perform public.set_email_consent(true);

  insert into public.facilities (name, facility_type)
  values ('Recinto Reclamo', 'Fútbol') returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 5)
  returning id into _bloque;

  _r := public.create_reservation_strict(_bloque);
  _reserva := (_r ->> 'reservation_id')::uuid;

  select * into _trabajo from public.claim_notification_jobs(10)
  where reservation_id = _reserva limit 1;

  assert _trabajo.channel = 'email',
    format('Esperaba un trabajo de correo, vino %s', _trabajo.channel);
  assert _trabajo.to_email = 'correo5@uc.cl',
    format('El destino del correo no se resolvió: %s', _trabajo.to_email);

  perform public.complete_notification_job(
    _trabajo.job_id, 'comms_operation_prueba_01', 'correo5@uc.cl');

  assert (select channel = 'email' and to_email = 'correo5@uc.cl' and to_phone is null
            and status = 'enviado'
          from public.notification_messages
          where notification_job_id = _trabajo.job_id),
    'El envío no quedó registrado en el canal correcto';

  -- De la dirección sólo debe quedar el dominio en la bitácora, que es
  -- legible por los administradores de recinto.
  select details into _detalles from public.reservation_audit_log
  where reservation_id = _reserva and action = 'notificacion_enviada'
  order by created_at desc limit 1;

  assert _detalles ->> 'canal' = 'email',
    format('La bitácora no registró el canal: %s', _detalles);
  assert _detalles ->> 'destino' = '@uc.cl',
    format('La bitácora no debe guardar la dirección completa: %s', _detalles);

  raise notice 'OK · el reclamo resuelve el destino y la bitácora lo enmascara';
end;
$$;

do $$
declare
  _u uuid;
begin
  -- El canal sólo admite 'email': es el único que existe.
  _u := test_helpers.create_user('correo6@uc.cl', 'Fran Correo');

  begin
    insert into public.notification_jobs
      (user_id, kind, channel, idempotency_key)
    values (_u, 'confirmacion', 'telegrama', 'tg:x:1');
    assert false, 'Debería rechazarse un canal desconocido';
  exception when check_violation then
    null;
  end;

  -- Y tampoco se admite ya el canal retirado, aunque las filas
  -- históricas con ese valor se conserven (la restricción es NOT VALID).
  begin
    insert into public.notification_jobs
      (user_id, kind, channel, idempotency_key)
    values (_u, 'confirmacion', 'whatsapp', 'wa:x:1');
    assert false, 'El canal retirado no debería aceptarse en filas nuevas';
  exception when check_violation then
    null;
  end;

  -- Un registro no puede llevar un teléfono como destino.
  begin
    insert into public.notification_messages
      (user_id, kind, channel, to_phone)
    values (_u, 'confirmacion', 'email', '+56911112222');
    assert false, 'Un registro de correo no debería aceptar teléfono';
  exception when check_violation then
    null;
  end;

  raise notice 'OK · el canal y su destino están restringidos';
end;
$$;

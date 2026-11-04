-- =====================================================================
-- Pruebas · aviso cuando se libera un cupo
-- ---------------------------------------------------------------------
-- Solicitud de cambio. Lo delicado de esta funcionalidad no es avisar,
-- sino avisar una sola vez, a quien corresponde, y sólo cuando de
-- verdad quedó cupo. Un aviso de más es ruido; uno de menos es un cupo
-- perdido, que es justo lo que el cambio viene a evitar.
-- =====================================================================

do $$
declare
  _a uuid; _b uuid; _fac uuid; _bloque uuid; _r jsonb;
begin
  -- Sólo se puede pedir aviso de un bloque lleno: con cupo, lo útil es
  -- decir que se puede reservar.
  _a := test_helpers.create_user('w1@uc.cl', 'Walter Uno');
  _b := test_helpers.create_user('w2@uc.cl', 'Wanda Dos');

  insert into public.facilities (name, facility_type) values ('Recinto Aviso', 'Tenis')
  returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 1)
  returning id into _bloque;

  perform test_helpers.login_as(_b);
  _r := public.solicitar_aviso_de_cupo(_bloque);
  assert not (_r ->> 'ok')::boolean, 'Con cupo libre no debería aceptarse el aviso';
  assert _r ->> 'mensaje' like '%tiene cupos%', format('Mensaje inesperado: %s', _r);

  -- Se llena el bloque.
  perform test_helpers.login_as(_a);
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'ok')::boolean, 'La reserva de preparación falló';

  -- Ahora sí.
  perform test_helpers.login_as(_b);
  _r := public.solicitar_aviso_de_cupo(_bloque);
  assert (_r ->> 'ok')::boolean, format('El aviso debería aceptarse: %s', _r);
  assert (select count(*) from public.block_watchers
          where block_id = _bloque and user_id = _b and notified_at is null) = 1,
    'No quedó registrada la solicitud';

  -- Quien ya tiene reserva en el bloque no necesita aviso.
  perform test_helpers.login_as(_a);
  _r := public.solicitar_aviso_de_cupo(_bloque);
  assert not (_r ->> 'ok')::boolean, 'Quien ya reservó no debería pedir aviso';

  raise notice 'OK · el aviso sólo se pide para bloques llenos y sin reserva propia';
end;
$$;

do $$
declare
  _a uuid; _b uuid; _fac uuid; _bloque uuid; _r jsonb; _reserva uuid;
begin
  -- El caso central: al cancelar, quien esperaba recibe el aviso.
  _a := test_helpers.create_user('w3@uc.cl', 'Wendy Tres');
  _b := test_helpers.create_user('w4@uc.cl', 'Wilson Cuatro');

  insert into public.facilities (name, facility_type) values ('Recinto Libera', 'Fútbol')
  returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 1)
  returning id into _bloque;

  perform test_helpers.login_as(_a);
  _r := public.create_reservation_strict(_bloque);
  _reserva := (_r ->> 'reservation_id')::uuid;

  -- El que espera consiente correo, para que haya un canal por donde
  -- avisar.
  perform test_helpers.login_as(_b);
  perform public.set_email_consent(true);
  perform public.solicitar_aviso_de_cupo(_bloque);

  -- Cancela el que tenía la reserva.
  perform test_helpers.login_as(_a);
  _r := public.cancel_reservation(_reserva);
  assert (_r ->> 'ok')::boolean, format('La cancelación falló: %s', _r);

  -- Queda encolado el aviso, apuntando al bloque y sin reserva.
  assert (select count(*) from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado') = 1,
    'No se encoló el aviso de cupo liberado';
  assert (select block_id from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado') = _bloque,
    'El aviso no apunta al bloque';
  assert (select reservation_id is null from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado'),
    'Un aviso de cupo no debería tener reserva asociada';

  -- Y la solicitud queda consumida.
  assert (select notified_at is not null from public.block_watchers
          where block_id = _bloque and user_id = _b),
    'La solicitud debería quedar marcada como avisada';

  raise notice 'OK · una cancelación avisa a quien esperaba';
end;
$$;

do $$
declare
  _a uuid; _b uuid; _c uuid; _fac uuid; _bloque uuid; _r jsonb;
  _res_a uuid; _res_c uuid;
begin
  -- No avisar dos veces: ni por una segunda cancelación, ni por una
  -- actualización posterior de la misma reserva.
  _a := test_helpers.create_user('w5@uc.cl', 'Wilma Cinco');
  _b := test_helpers.create_user('w6@uc.cl', 'Wenceslao Seis');
  _c := test_helpers.create_user('w7@uc.cl', 'Wania Siete');

  insert into public.facilities (name, facility_type) values ('Recinto Dos Cancel', 'Tenis')
  returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 2)
  returning id into _bloque;

  perform test_helpers.login_as(_a);
  _r := public.create_reservation_strict(_bloque);
  _res_a := (_r ->> 'reservation_id')::uuid;
  perform test_helpers.login_as(_c);
  _r := public.create_reservation_strict(_bloque);
  _res_c := (_r ->> 'reservation_id')::uuid;

  perform test_helpers.login_as(_b);
  perform public.set_email_consent(true);
  perform public.solicitar_aviso_de_cupo(_bloque);

  perform test_helpers.login_as(_a);
  perform public.cancel_reservation(_res_a);
  perform test_helpers.login_as(_c);
  perform public.cancel_reservation(_res_c);

  assert (select count(*) from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado') = 1,
    'Dos cancelaciones no deberían producir dos avisos';

  -- Una actualización posterior de una reserva ya cancelada tampoco.
  update public.reservations set calendar_sync_status = 'error'
  where id = _res_a;

  assert (select count(*) from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado') = 1,
    'Una actualización posterior no debería volver a avisar';

  raise notice 'OK · se avisa una sola vez por solicitud';
end;
$$;

do $$
declare
  _a uuid; _b uuid; _fac uuid; _bloque uuid; _r jsonb; _reserva uuid;
begin
  -- Sin ningún canal consentido la solicitud se consume igual: dejarla
  -- pendiente la haría reaparecer en cada cancelación futura.
  _a := test_helpers.create_user('w8@uc.cl', 'Wally Ocho');
  _b := test_helpers.create_user('w9@uc.cl', 'Wilda Nueve');

  insert into public.facilities (name, facility_type) values ('Recinto Sin Canal', 'Fútbol')
  returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 1)
  returning id into _bloque;

  perform test_helpers.login_as(_a);
  _r := public.create_reservation_strict(_bloque);
  _reserva := (_r ->> 'reservation_id')::uuid;

  perform test_helpers.login_as(_b);
  perform public.solicitar_aviso_de_cupo(_bloque);

  perform test_helpers.login_as(_a);
  perform public.cancel_reservation(_reserva);

  assert (select count(*) from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado') = 0,
    'Sin canal consentido no debería encolarse nada';
  assert (select notified_at is not null from public.block_watchers
          where block_id = _bloque and user_id = _b),
    'La solicitud debería consumirse igualmente para no reaparecer';

  raise notice 'OK · sin canal consentido la solicitud se consume sin enviar';
end;
$$;

do $$
declare
  _a uuid; _b uuid; _fac uuid; _bloque uuid; _r jsonb;
begin
  -- Cada quien ve y gestiona sólo sus propias solicitudes.
  _a := test_helpers.create_user('w10@uc.cl', 'Wadi Diez');
  _b := test_helpers.create_user('w11@uc.cl', 'Wira Once');

  insert into public.facilities (name, facility_type) values ('Recinto Propio', 'Tenis')
  returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 1)
  returning id into _bloque;

  perform test_helpers.login_as(_a);
  perform public.create_reservation_strict(_bloque);

  perform test_helpers.login_as(_b);
  perform public.solicitar_aviso_de_cupo(_bloque);

  -- Cancelar el aviso lo borra.
  _r := public.cancelar_aviso_de_cupo(_bloque);
  assert (_r ->> 'ok')::boolean, 'Cancelar el aviso debería funcionar';
  assert (select count(*) from public.block_watchers
          where block_id = _bloque and user_id = _b) = 0,
    'La solicitud no se borró';

  -- Sin sesión no se puede pedir nada.
  perform test_helpers.logout();
  _r := public.solicitar_aviso_de_cupo(_bloque);
  assert not (_r ->> 'ok')::boolean, 'Sin sesión no debería aceptarse';

  raise notice 'OK · cada persona gestiona sólo sus propias solicitudes';
end;
$$;

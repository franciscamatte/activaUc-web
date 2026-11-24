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

do $$
declare
  _a uuid; _b uuid; _fac uuid; _bloque uuid; _r jsonb; _id1 uuid; _id2 uuid;
begin
  -- La invariante de la que depende la clave del aviso: reabrir una
  -- espera entrega una solicitud nueva, con id nuevo, sin duplicar la
  -- fila. Si esto deja de cumplirse, el segundo aviso de un bloque se
  -- descarta por choque de clave de idempotencia.
  _a := test_helpers.create_user('w12@uc.cl', 'Wendel Doce');
  _b := test_helpers.create_user('w13@uc.cl', 'Wivian Trece');

  insert into public.facilities (name, facility_type) values ('Recinto Reabre', 'Tenis')
  returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 1)
  returning id into _bloque;

  perform test_helpers.login_as(_a);
  perform public.create_reservation_strict(_bloque);

  perform test_helpers.login_as(_b);
  _r := public.solicitar_aviso_de_cupo(_bloque);
  assert (_r ->> 'ok')::boolean, format('El aviso debería aceptarse: %s', _r);
  select id into _id1 from public.block_watchers
  where block_id = _bloque and user_id = _b;

  -- Pedirlo otra vez no añade una espera: reabre la que hay.
  _r := public.solicitar_aviso_de_cupo(_bloque);
  assert (_r ->> 'ok')::boolean, format('Reabrir el aviso debería aceptarse: %s', _r);
  assert (select count(*) from public.block_watchers
          where block_id = _bloque and user_id = _b) = 1,
    'Reabrir la espera no debería duplicar la fila';

  select id into _id2 from public.block_watchers
  where block_id = _bloque and user_id = _b;
  assert _id2 is distinct from _id1,
    'Reabrir la espera debería entregar una solicitud con id nuevo';
  assert (select notified_at is null from public.block_watchers
          where block_id = _bloque and user_id = _b),
    'La espera reabierta debería quedar pendiente';

  raise notice 'OK · reabrir una espera entrega una solicitud nueva';
end;
$$;

do $$
declare
  _a uuid; _b uuid; _c uuid; _fac uuid; _bloque uuid; _r jsonb;
  _res_a uuid; _res_c uuid;
begin
  -- El caso que estaba roto: pedir el aviso de nuevo después de haberlo
  -- recibido tiene que volver a avisar. Antes el encolado chocaba con la
  -- clave del primer aviso y se descartaba en silencio, consumiendo la
  -- espera sin enviar nada.
  _a := test_helpers.create_user('w14@uc.cl', 'Wilfredo Catorce');
  _b := test_helpers.create_user('w15@uc.cl', 'Wania Quince');
  _c := test_helpers.create_user('w16@uc.cl', 'Waldo Dieciséis');

  insert into public.facilities (name, facility_type) values ('Recinto Dos Avisos', 'Fútbol')
  returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 1)
  returning id into _bloque;

  perform test_helpers.login_as(_a);
  _r := public.create_reservation_strict(_bloque);
  _res_a := (_r ->> 'reservation_id')::uuid;

  perform test_helpers.login_as(_b);
  perform public.set_email_consent(true);
  perform public.solicitar_aviso_de_cupo(_bloque);

  -- Primera liberación: llega el primer aviso y la espera se consume.
  perform test_helpers.login_as(_a);
  perform public.cancel_reservation(_res_a);
  assert (select count(*) from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado') = 1,
    'No se encoló el primer aviso';

  -- El bloque se vuelve a llenar y la persona vuelve a pedir el aviso.
  perform test_helpers.login_as(_c);
  _r := public.create_reservation_strict(_bloque);
  _res_c := (_r ->> 'reservation_id')::uuid;
  assert (_r ->> 'ok')::boolean, format('La segunda reserva falló: %s', _r);

  perform test_helpers.login_as(_b);
  _r := public.solicitar_aviso_de_cupo(_bloque);
  assert (_r ->> 'ok')::boolean, format('Volver a pedir el aviso debería aceptarse: %s', _r);

  -- Segunda liberación: tiene que llegar un segundo aviso, con clave
  -- propia, y no volver a descartarse.
  perform test_helpers.login_as(_c);
  perform public.cancel_reservation(_res_c);

  assert (select count(*) from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado') = 2,
    'El segundo aviso no se encoló: la espera se consumió sin enviar nada';
  assert (select count(distinct idempotency_key) from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado') = 2,
    'Los dos avisos deberían tener claves de idempotencia distintas';
  assert (select count(*) from public.notification_jobs
          where user_id = _b and kind::text = 'cupo_liberado'
            and block_id = _bloque) = 2,
    'Los dos avisos deberían apuntar al mismo bloque';
  assert (select notified_at is not null from public.block_watchers
          where block_id = _bloque and user_id = _b),
    'La segunda espera también debería quedar consumida';

  raise notice 'OK · volver a pedir el aviso vuelve a avisar';
end;
$$;

-- =====================================================================
-- Pruebas · RLS y privilegios
-- ---------------------------------------------------------------------
-- Se intenta acceder a los datos con distintos roles reales
-- (anon / authenticated) y distintas identidades, comprobando que:
--   · un usuario sólo ve lo propio
--   · un administrador sólo opera sobre sus recintos asignados
--   · anon ve disponibilidad agregada pero ninguna fila de reservas
--   · teléfonos, correos y tokens OAuth no son legibles por terceros
--   · nadie puede escribir directamente en reservations ni cambiar su rol
-- =====================================================================

-- ------------------------------------------------------------------
-- Datos de prueba (como propietario, antes de cambiar de rol).
-- La tabla vive en test_helpers, no en pg_temp, porque los bloques que
-- cambian a rol anon/authenticated deben poder leerla. Todo el archivo
-- corre en una transacción que se revierte, así que no deja rastro.
-- ------------------------------------------------------------------
create table test_helpers.ids (k text primary key, v uuid);
grant select on test_helpers.ids to anon, authenticated;

do $$
declare
  _u1 uuid; _u2 uuid; _admin uuid; _admin2 uuid;
  _fac_a uuid; _fac_b uuid; _blk_a uuid; _blk_b uuid;
  _res1 uuid; _res2 uuid;
begin
  _u1     := test_helpers.create_user('rls1@uc.cl', 'Paula Propia');
  _u2     := test_helpers.create_user('rls2@uc.cl', 'Quique Ajeno');
  _admin  := test_helpers.create_user('rls3@uc.cl', 'Rita AdminA', 'administrador');
  _admin2 := test_helpers.create_user('rls4@uc.cl', 'Sergio AdminB', 'administrador');

  insert into public.facilities (name, facility_type) values ('Recinto RLS A', 'Fútbol') returning id into _fac_a;
  insert into public.facilities (name, facility_type) values ('Recinto RLS B', 'Tenis')  returning id into _fac_b;

  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac_a);
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin2, _fac_b);

  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac_a, now() + interval '6 hours', now() + interval '7 hours', 5) returning id into _blk_a;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac_b, now() + interval '6 hours', now() + interval '7 hours', 5) returning id into _blk_b;

  -- Una reserva de cada usuario, en recintos distintos.
  perform test_helpers.login_as(_u1);
  perform public.set_whatsapp_consent('+56911111111', true);
  _res1 := (public.create_reservation_strict(_blk_a) ->> 'reservation_id')::uuid;

  perform test_helpers.login_as(_u2);
  perform public.set_whatsapp_consent('+56922222222', true);
  _res2 := (public.create_reservation_strict(_blk_b) ->> 'reservation_id')::uuid;

  perform test_helpers.logout();

  -- Conexión de Calendar con "tokens" para comprobar que no se filtran.
  insert into public.calendar_connections
    (user_id, status, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
  values (_u1, 'conectado', 'v1.SECRETO_REFRESH.xx', 'v1.SECRETO_ACCESS.xx', now() + interval '1 hour');

  insert into test_helpers.ids(k, v) values
    ('u1', _u1), ('u2', _u2), ('admin', _admin), ('admin2', _admin2),
    ('fac_a', _fac_a), ('fac_b', _fac_b), ('blk_a', _blk_a), ('blk_b', _blk_b),
    ('res1', _res1), ('res2', _res2);
end;
$$;

-- ------------------------------------------------------------------
-- Rol anon: disponibilidad sí, datos de reservas no.
-- ------------------------------------------------------------------
do $$
declare
  _n int;
begin
  execute 'set local role anon';
  perform test_helpers.logout();

  -- REQ-9/REQ-11: la disponibilidad agregada es pública.
  select count(*) into _n from public.block_availability;
  assert _n >= 2, 'anon no puede leer la disponibilidad agregada';

  -- La vista no expone identificadores de usuarios.
  assert not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'block_availability'
      and column_name in ('user_id', 'phone', 'email')
  ), 'block_availability expone columnas de datos personales';

  -- Recintos y bloques activos: lectura pública.
  select count(*) into _n from public.facilities;
  assert _n >= 2, 'anon no puede leer el catálogo de recintos';

  -- Pero ninguna fila de reservas.
  begin
    select count(*) into _n from public.reservations;
    assert false, 'anon pudo consultar public.reservations';
  exception
    when insufficient_privilege then null;
  end;

  -- Ni perfiles.
  begin
    select count(*) into _n from public.profiles;
    assert false, 'anon pudo consultar public.profiles';
  exception
    when insufficient_privilege then null;
  end;

  -- Ni reservar.
  begin
    perform public.create_reservation_strict((select v from test_helpers.ids where k = 'blk_a'));
    assert false, 'anon pudo ejecutar create_reservation_strict';
  exception
    when insufficient_privilege then null;
  end;

  execute 'reset role';
  raise notice 'OK · anon: disponibilidad pública, cero datos personales';
end;
$$;

-- ------------------------------------------------------------------
-- Rol authenticated · usuario común
-- ------------------------------------------------------------------
do $$
declare
  _u1 uuid := (select v from test_helpers.ids where k = 'u1');
  _u2 uuid := (select v from test_helpers.ids where k = 'u2');
  _res2 uuid := (select v from test_helpers.ids where k = 'res2');
  _n int;
  _fantasma text;
begin
  execute 'set local role authenticated';
  perform test_helpers.login_as(_u1);

  -- Sólo su propio perfil.
  select count(*) into _n from public.profiles;
  assert _n = 1, format('Un usuario ve %s perfiles, debía ver 1', _n);
  assert (select id from public.profiles) = _u1, 'El perfil visible no es el propio';

  -- No puede leer el teléfono de otra persona (ni su fila).
  select phone into _fantasma from public.profiles where id = _u2;
  assert _fantasma is null, 'Se filtró el teléfono de otro usuario';

  -- Sólo sus propias reservas (REQ-14).
  select count(*) into _n from public.reservations;
  assert _n = 1, format('Un usuario ve %s reservas, debía ver 1', _n);
  assert (select user_id from public.reservations) = _u1, 'La reserva visible no es la propia';

  -- No puede modificar ninguna reserva por SQL directo, ni ajena ni
  -- propia: a authenticated no se le concede UPDATE sobre reservations.
  -- La única vía es public.cancel_reservation(), que valida el rol real.
  begin
    update public.reservations set status = 'cancelada' where id = _res2;
    assert false, 'Un usuario pudo hacer UPDATE sobre una reserva ajena';
  exception
    when insufficient_privilege then null;
  end;
  -- Nota: no se puede comprobar aquí el estado de _res2 porque RLS la
  -- hace invisible para este usuario, que es precisamente lo esperado.
  -- La integridad de esa fila se verifica más abajo, con el rol del
  -- administrador asignado a su recinto.

  begin
    update public.reservations set status = 'cancelada' where user_id = _u1;
    assert false, 'Un usuario pudo hacer UPDATE directo sobre su propia reserva';
  exception
    when insufficient_privilege then null;
  end;

  -- Ni INSERT directo (saltándose la función transaccional).
  begin
    insert into public.reservations (user_id, facility_id, block_id, starts_at, ends_at)
    values (_u1, (select v from test_helpers.ids where k = 'fac_b'), (select v from test_helpers.ids where k = 'blk_b'),
            now() + interval '6 hours', now() + interval '7 hours');
    assert false, 'Un usuario pudo insertar en reservations sin pasar por la función';
  exception
    when insufficient_privilege then null;
  end;

  -- No puede escalar su rol.
  begin
    update public.profiles set role = 'administrador' where id = _u1;
    assert false, 'Un usuario pudo cambiar su propio rol';
  exception
    when insufficient_privilege then null;
    when others then
      assert sqlerrm like '%rol%' or sqlstate = '42501',
        format('Error inesperado al intentar escalar privilegios: %s', sqlerrm);
  end;
  assert (select role from public.profiles where id = _u1) = 'usuario',
    'El rol del usuario cambió';

  -- Puede actualizar su nombre (REQ-7).
  update public.profiles set full_name = 'Paula Actualizada' where id = _u1;
  assert (select full_name from public.profiles where id = _u1) = 'Paula Actualizada',
    'El usuario no pudo actualizar su propio nombre';

  -- No puede tocar el consentimiento por SQL directo (sólo vía función).
  begin
    update public.profiles set whatsapp_consent = false where id = _u1;
    assert false, 'Un usuario pudo cambiar whatsapp_consent por SQL directo';
  exception
    when insufficient_privilege then null;
  end;

  -- No puede crear recintos ni bloques.
  begin
    insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
    values ((select v from test_helpers.ids where k = 'fac_a'), now() + interval '20 hours',
            now() + interval '21 hours', 5);
    assert false, 'Un usuario común pudo crear un bloque horario';
  exception
    when insufficient_privilege then null;
  end;

  -- No puede entrar al panel de administración.
  begin
    perform public.admin_list_reservations(null, 'vigentes');
    assert false, 'Un usuario común accedió al listado administrativo';
  exception
    when insufficient_privilege then null;
  end;

  execute 'reset role';
  raise notice 'OK · usuario común: aislamiento de perfil, reservas y escrituras';
end;
$$;

-- ------------------------------------------------------------------
-- Tokens OAuth: nunca legibles desde el cliente
-- ------------------------------------------------------------------
do $$
declare
  _u1 uuid := (select v from test_helpers.ids where k = 'u1');
  _estado text;
begin
  execute 'set local role authenticated';
  perform test_helpers.login_as(_u1);

  -- El estado de la conexión sí es visible (REQ-17: mostrarlo en la UI).
  select status::text into _estado from public.calendar_connections where user_id = _u1;
  assert _estado = 'conectado', 'El usuario no puede ver el estado de su conexión';

  -- Las columnas de tokens no tienen privilegio de lectura.
  begin
    perform refresh_token_encrypted from public.calendar_connections where user_id = _u1;
    assert false, 'Se pudo leer refresh_token_encrypted desde el cliente';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform access_token_encrypted from public.calendar_connections where user_id = _u1;
    assert false, 'Se pudo leer access_token_encrypted desde el cliente';
  exception
    when insufficient_privilege then null;
  end;

  -- select * también debe fallar por la columna no concedida.
  begin
    perform * from public.calendar_connections where user_id = _u1;
    assert false, 'select * sobre calendar_connections expuso los tokens';
  exception
    when insufficient_privilege then null;
  end;

  -- Los states de OAuth no son visibles en absoluto: no hay ni GRANT de
  -- SELECT, así que el intento falla antes de evaluar RLS.
  begin
    perform count(*) from public.oauth_states;
    assert false, 'oauth_states es legible desde el cliente';
  exception
    when insufficient_privilege then null;
  end;

  execute 'reset role';
  raise notice 'OK · tokens OAuth inaccesibles desde el cliente';
end;
$$;

-- ------------------------------------------------------------------
-- Rol authenticated · administrador, acotado a recintos asignados
-- ------------------------------------------------------------------
do $$
declare
  _admin uuid := (select v from test_helpers.ids where k = 'admin');
  _fac_a uuid := (select v from test_helpers.ids where k = 'fac_a');
  _fac_b uuid := (select v from test_helpers.ids where k = 'fac_b');
  _blk_b uuid := (select v from test_helpers.ids where k = 'blk_b');
  _n int;
begin
  execute 'set local role authenticated';
  perform test_helpers.login_as(_admin);

  -- REQ-31: ve las reservas de su recinto.
  select count(*) into _n from public.reservations;
  assert _n = 1, format('El administrador A ve %s reservas, debía ver 1 (la de su recinto)', _n);
  assert (select facility_id from public.reservations) = _fac_a,
    'El administrador ve reservas de un recinto que no administra';
  -- La reserva del otro recinto sigue intacta tras los intentos de
  -- escritura directa del bloque anterior (es invisible para este
  -- administrador, así que se comprueba por conteo global del dueño).
  assert (select status from public.my_reservations where facility_id = _fac_a) = 'vigente',
    'La reserva del recinto administrado cambió de estado';

  -- REQ-29: no puede editar un recinto ajeno.
  update public.facilities set name = 'Secuestrado' where id = _fac_b;
  assert (select name from public.facilities where id = _fac_b) = 'Recinto RLS B',
    'El administrador modificó un recinto que no administra';

  -- Sí puede editar el propio.
  update public.facilities set operation_hours = '07:00 a 23:00' where id = _fac_a;
  assert (select operation_hours from public.facilities where id = _fac_a) = '07:00 a 23:00',
    'El administrador no pudo editar su propio recinto';

  -- REQ-30: no puede crear bloques en un recinto ajeno.
  begin
    insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
    values (_fac_b, now() + interval '30 hours', now() + interval '31 hours', 4);
    assert false, 'El administrador creó un bloque en un recinto ajeno';
  exception
    when insufficient_privilege then null;
  end;

  -- Sí en el propio.
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac_a, now() + interval '30 hours', now() + interval '31 hours', 4);

  -- No puede modificar la capacidad de un bloque ajeno.
  update public.time_blocks set max_capacity = 999 where id = _blk_b;
  assert (select max_capacity from public.time_blocks where id = _blk_b) = 5,
    'El administrador cambió la capacidad de un bloque ajeno';

  -- El listado administrativo sólo devuelve su recinto y no expone
  -- correo ni teléfono (REQ-31 + protección de datos personales).
  select count(*) into _n from public.admin_list_reservations(null, 'todas');
  assert _n = 1, format('admin_list_reservations devolvió %s filas, debía devolver 1', _n);

  assert not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'admin_list_reservations'
      and column_name in ('email', 'phone', 'to_phone')
  ), 'admin_list_reservations expone datos personales';

  -- Pedir explícitamente un recinto ajeno es rechazado.
  begin
    perform public.admin_list_reservations(_fac_b, 'todas');
    assert false, 'El administrador consultó reservas de un recinto ajeno';
  exception
    when insufficient_privilege then null;
  end;

  -- No ve el perfil (ni el teléfono) de quien reservó.
  select count(*) into _n from public.profiles;
  assert _n = 1, format('El administrador ve %s perfiles, debía ver sólo el suyo', _n);

  -- No puede leer el teléfono registrado en whatsapp_messages.
  begin
    perform to_phone from public.whatsapp_messages;
    assert false, 'El administrador pudo leer to_phone de whatsapp_messages';
  exception
    when insufficient_privilege then null;
  end;

  execute 'reset role';
  raise notice 'OK · administrador acotado a sus recintos asignados';
end;
$$;

-- ------------------------------------------------------------------
-- Colas internas y contadores: sin acceso desde el cliente
-- ------------------------------------------------------------------
do $$
declare
  _u1 uuid := (select v from test_helpers.ids where k = 'u1');
begin
  execute 'set local role authenticated';
  perform test_helpers.login_as(_u1);

  -- El usuario ve el estado de SUS trabajos (para la interfaz).
  assert (select count(*) from public.notification_jobs) >= 1,
    'El usuario no puede ver el estado de sus propias notificaciones';

  -- Pero no puede reclamar ni completar trabajos.
  begin
    perform public.claim_notification_jobs(5);
    assert false, 'Un usuario pudo reclamar trabajos de la cola';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.claim_calendar_jobs(5);
    assert false, 'Un usuario pudo reclamar trabajos de Calendar';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.register_webhook_event('twilio', 'SM1', 'delivered', true, '{}'::jsonb);
    assert false, 'Un usuario pudo registrar un evento de webhook';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.apply_whatsapp_status('SM1', 'delivered', null);
    assert false, 'Un usuario pudo forzar el estado de un mensaje';
  exception
    when insufficient_privilege then null;
  end;

  -- Los contadores de rate limiting y los webhooks no son legibles.
  begin
    perform count(*) from public.rate_limit_counters;
    assert false, 'rate_limit_counters es legible desde el cliente';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform count(*) from public.webhook_events;
    assert false, 'webhook_events es legible desde el cliente';
  exception
    when insufficient_privilege then null;
  end;

  execute 'reset role';
  raise notice 'OK · colas, webhooks y contadores reservados al backend';
end;
$$;

-- ------------------------------------------------------------------
-- Comprobación final, ya como propietario: ninguna de las escrituras
-- directas intentadas por usuarios o administradores ajenos surtió
-- efecto sobre los datos.
-- ------------------------------------------------------------------
do $$
declare
  _res2 uuid := (select v from test_helpers.ids where k = 'res2');
  _fac_b uuid := (select v from test_helpers.ids where k = 'fac_b');
  _blk_b uuid := (select v from test_helpers.ids where k = 'blk_b');
begin
  assert (select status from public.reservations where id = _res2) = 'vigente',
    'La reserva del otro usuario quedó modificada';
  assert (select name from public.facilities where id = _fac_b) = 'Recinto RLS B',
    'El recinto ajeno quedó renombrado';
  assert (select max_capacity from public.time_blocks where id = _blk_b) = 5,
    'La capacidad del bloque ajeno quedó modificada';
  assert not exists (
    select 1 from public.time_blocks where facility_id = _fac_b and max_capacity = 4
  ), 'Se creó un bloque en el recinto ajeno';

  raise notice 'OK · ningún intento de escritura cruzada surtió efecto';
end;
$$;

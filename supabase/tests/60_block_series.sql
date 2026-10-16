-- =====================================================================
-- Pruebas · creación y desactivación de bloques en serie
-- =====================================================================

do $$
declare
  _admin uuid; _ajeno uuid; _usuario uuid;
  _fac uuid; _fac_ajeno uuid;
  _r jsonb;
  _desde date := (now() at time zone 'America/Santiago')::date + 1;
begin
  _admin   := test_helpers.create_user('s1@uc.cl', 'Admin Serie', 'administrador');
  _ajeno   := test_helpers.create_user('s2@uc.cl', 'Admin Ajeno', 'administrador');
  _usuario := test_helpers.create_user('s3@uc.cl', 'Usuario Serie');

  insert into public.facilities (name, facility_type)
  values ('Recinto Serie', 'Fútbol') returning id into _fac;
  insert into public.facilities (name, facility_type)
  values ('Recinto Serie Ajeno', 'Tenis') returning id into _fac_ajeno;

  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_ajeno, _fac_ajeno);

  -- ---------------------------------------------------------------
  -- Autorización
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_usuario);
  begin
    perform public.admin_create_block_series(
      _fac, _desde, _desde + 6, array['08:00'], 60, 10);
    assert false, 'Un usuario común pudo crear una serie';
  exception when insufficient_privilege then null;
  end;

  perform test_helpers.login_as(_ajeno);
  begin
    perform public.admin_create_block_series(
      _fac, _desde, _desde + 6, array['08:00'], 60, 10);
    assert false, 'Un administrador no asignado pudo crear una serie';
  exception when insufficient_privilege then null;
  end;

  raise notice 'OK · sólo el administrador asignado crea series';
end;
$$;

do $$
declare
  _admin uuid; _fac uuid; _r jsonb;
  _desde date := (now() at time zone 'America/Santiago')::date + 1;
begin
  _admin := test_helpers.create_user('s4@uc.cl', 'Admin Validaciones', 'administrador');
  insert into public.facilities (name, facility_type)
  values ('Recinto Validaciones', 'Tenis') returning id into _fac;
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);
  perform test_helpers.login_as(_admin);

  -- Rango invertido
  _r := public.admin_create_block_series(_fac, _desde + 5, _desde, array['08:00'], 60, 10);
  assert (_r ->> 'error') = 'rango_invertido', format('esperado rango_invertido: %s', _r);

  -- Rango demasiado largo
  _r := public.admin_create_block_series(_fac, _desde, _desde + 400, array['08:00'], 60, 10);
  assert (_r ->> 'error') = 'rango_demasiado_largo', format('esperado rango_demasiado_largo: %s', _r);

  -- Sin horas
  _r := public.admin_create_block_series(_fac, _desde, _desde + 6, array[]::text[], 60, 10);
  assert (_r ->> 'error') = 'sin_horas', format('esperado sin_horas: %s', _r);

  -- Hora mal formada
  _r := public.admin_create_block_series(_fac, _desde, _desde + 6, array['25:00'], 60, 10);
  assert (_r ->> 'error') = 'hora_invalida', format('esperado hora_invalida: %s', _r);
  _r := public.admin_create_block_series(_fac, _desde, _desde + 6, array['8:00'], 60, 10);
  assert (_r ->> 'error') = 'hora_invalida', format('esperado hora_invalida para 8:00: %s', _r);

  -- Duración y capacidad fuera de rango
  _r := public.admin_create_block_series(_fac, _desde, _desde + 6, array['08:00'], 5, 10);
  assert (_r ->> 'error') = 'duracion_invalida', format('esperado duracion_invalida: %s', _r);
  _r := public.admin_create_block_series(_fac, _desde, _desde + 6, array['08:00'], 800, 10);
  assert (_r ->> 'error') = 'duracion_invalida', format('esperado duracion_invalida (larga): %s', _r);
  _r := public.admin_create_block_series(_fac, _desde, _desde + 6, array['08:00'], 60, 0);
  assert (_r ->> 'error') = 'capacidad_invalida', format('esperado capacidad_invalida: %s', _r);

  -- Día de la semana fuera de rango
  _r := public.admin_create_block_series(
    _fac, _desde, _desde + 6, array['08:00'], 60, 10, array[7]);
  assert (_r ->> 'error') = 'dia_invalido', format('esperado dia_invalido: %s', _r);

  -- Tope de seguridad: 366 días x 24 horas supera el máximo
  _r := public.admin_create_block_series(
    _fac, _desde, _desde + 365,
    array['00:00','01:00','02:00','03:00','04:00','05:00','06:00','07:00',
          '08:00','09:00','10:00','11:00'], 60, 10);
  assert (_r ->> 'error') = 'demasiados_bloques', format('esperado demasiados_bloques: %s', _r);

  -- Ningún bloque creado por culpa de las validaciones
  assert (select count(*) from public.time_blocks where facility_id = _fac) = 0,
    'Una serie inválida escribió bloques';

  raise notice 'OK · validaciones rechazan antes de escribir nada';
end;
$$;

do $$
declare
  _admin uuid; _fac uuid; _r jsonb;
  _desde date := (now() at time zone 'America/Santiago')::date + 1;
  _n int;
begin
  _admin := test_helpers.create_user('s5@uc.cl', 'Admin Generacion', 'administrador');
  insert into public.facilities (name, facility_type)
  values ('Recinto Generacion', 'Fútbol') returning id into _fac;
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);
  perform test_helpers.login_as(_admin);

  -- ---------------------------------------------------------------
  -- Simulación: no debe escribir nada
  -- ---------------------------------------------------------------
  _r := public.admin_create_block_series(
    _fac, _desde, _desde + 6, array['08:00','10:00'], 60, 20,
    null, 'America/Santiago', true);

  assert (_r ->> 'ok')::boolean, format('la simulación falló: %s', _r);
  assert (_r ->> 'simulado')::boolean, 'no se marcó como simulada';
  assert (_r ->> 'creados')::int = 14, format('esperados 14 en 7 días x 2 horas: %s', _r ->> 'creados');
  assert jsonb_array_length(_r -> 'muestra') = 5, 'la vista previa debe traer una muestra';
  assert (select count(*) from public.time_blocks where facility_id = _fac) = 0,
    'La simulación escribió bloques';

  raise notice 'OK · la simulación cuenta sin escribir (vista previa)';

  -- ---------------------------------------------------------------
  -- Creación real
  -- ---------------------------------------------------------------
  _r := public.admin_create_block_series(
    _fac, _desde, _desde + 6, array['08:00','10:00'], 60, 20);

  assert (_r ->> 'creados')::int = 14, format('esperados 14 creados: %s', _r);
  select count(*) into _n from public.time_blocks where facility_id = _fac;
  assert _n = 14, format('en la tabla hay %s bloques', _n);

  -- La duración se respeta
  assert (select count(*) from public.time_blocks
          where facility_id = _fac and ends_at - starts_at = interval '60 minutes') = 14,
    'La duración de los bloques no es la indicada';

  -- La capacidad se respeta
  assert (select count(*) from public.time_blocks
          where facility_id = _fac and max_capacity = 20) = 14,
    'La capacidad de los bloques no es la indicada';

  raise notice 'OK · serie diaria creada con su duración y capacidad';

  -- ---------------------------------------------------------------
  -- Idempotencia: repetir la misma serie no duplica
  -- ---------------------------------------------------------------
  _r := public.admin_create_block_series(
    _fac, _desde, _desde + 6, array['08:00','10:00'], 60, 20);

  assert (_r ->> 'creados')::int = 0, format('no debía crear nada: %s', _r);
  assert (_r ->> 'omitidos_existentes')::int = 14,
    format('debía omitir los 14 existentes: %s', _r);
  assert (select count(*) from public.time_blocks where facility_id = _fac) = 14,
    'Repetir la serie duplicó bloques';

  raise notice 'OK · repetir la serie no duplica (REQ-30)';

  -- ---------------------------------------------------------------
  -- Extender la serie: sólo crea lo que falta
  -- ---------------------------------------------------------------
  _r := public.admin_create_block_series(
    _fac, _desde, _desde + 13, array['08:00','10:00'], 60, 20);

  assert (_r ->> 'creados')::int = 14, format('debía crear los 14 nuevos: %s', _r);
  assert (_r ->> 'omitidos_existentes')::int = 14, 'debía omitir los 14 ya publicados';
  assert (select count(*) from public.time_blocks where facility_id = _fac) = 28,
    'La extensión de la serie no cuadra';

  raise notice 'OK · extender la serie respeta lo ya publicado';
end;
$$;

do $$
declare
  _admin uuid; _fac uuid; _r jsonb;
  _desde date := (now() at time zone 'America/Santiago')::date + 1;
  _lunes date;
begin
  _admin := test_helpers.create_user('s6@uc.cl', 'Admin Semanal', 'administrador');
  insert into public.facilities (name, facility_type)
  values ('Recinto Semanal', 'Básquetbol') returning id into _fac;
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);
  perform test_helpers.login_as(_admin);

  -- ---------------------------------------------------------------
  -- Días de la semana: lunes a viernes durante 4 semanas
  -- ---------------------------------------------------------------
  _r := public.admin_create_block_series(
    _fac, _desde, _desde + 27, array['19:00'], 90, 15, array[1,2,3,4,5]);

  assert (_r ->> 'ok')::boolean, format('la serie semanal falló: %s', _r);

  -- Todos los bloques deben caer en día hábil, en hora local.
  assert not exists (
    select 1 from public.time_blocks
    where facility_id = _fac
      and extract(dow from (starts_at at time zone 'America/Santiago')) in (0, 6)
  ), 'La serie de lunes a viernes incluyó fin de semana';

  -- Y todos a las 19:00 locales, aunque cambie el horario de verano.
  assert not exists (
    select 1 from public.time_blocks
    where facility_id = _fac
      and to_char(starts_at at time zone 'America/Santiago', 'HH24:MI') <> '19:00'
  ), 'Algún bloque no quedó a las 19:00 en hora local';

  -- Duración de 90 minutos
  assert (select count(*) from public.time_blocks
          where facility_id = _fac and ends_at - starts_at = interval '90 minutes')
         = (select count(*) from public.time_blocks where facility_id = _fac),
    'La duración de 90 minutos no se respetó';

  raise notice 'OK · serie por días de la semana, en hora local (REQ-30)';

  -- Un rango sin días coincidentes se informa con claridad.
  _lunes := _desde + ((8 - extract(dow from _desde)::int) % 7);
  _r := public.admin_create_block_series(
    _fac, _lunes, _lunes, array['08:00'], 60, 10, array[0]);
  assert (_r ->> 'error') = 'serie_vacia', format('esperado serie_vacia: %s', _r);

  raise notice 'OK · rango sin días coincidentes se informa';
end;
$$;

do $$
declare
  _admin uuid; _fac uuid; _r jsonb;
  _ayer date := (now() at time zone 'America/Santiago')::date - 2;
  _manana date := (now() at time zone 'America/Santiago')::date + 1;
begin
  _admin := test_helpers.create_user('s7@uc.cl', 'Admin Pasado', 'administrador');
  insert into public.facilities (name, facility_type)
  values ('Recinto Pasado', 'Tenis') returning id into _fac;
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);
  perform test_helpers.login_as(_admin);

  -- Un rango que empieza en el pasado omite esos días, no falla.
  _r := public.admin_create_block_series(
    _fac, _ayer, _manana, array['08:00'], 60, 10);

  assert (_r ->> 'ok')::boolean, format('debía crear los futuros: %s', _r);
  assert (_r ->> 'omitidos_pasado')::int >= 2,
    format('debía omitir los días pasados: %s', _r);
  assert not exists (
    select 1 from public.time_blocks where facility_id = _fac and starts_at <= now()
  ), 'Se publicaron bloques en el pasado';

  raise notice 'OK · los bloques en el pasado se omiten sin fallar';
end;
$$;

do $$
declare
  _admin uuid; _usuario uuid; _fac uuid; _r jsonb; _bloque uuid;
  _desde date := (now() at time zone 'America/Santiago')::date + 1;
begin
  _admin   := test_helpers.create_user('s8@uc.cl', 'Admin Desactiva', 'administrador');
  _usuario := test_helpers.create_user('s9@uc.cl', 'Usuario Desactiva');

  insert into public.facilities (name, facility_type)
  values ('Recinto Desactiva', 'Vóleibol') returning id into _fac;
  insert into public.facility_admin_assignments (admin_id, facility_id) values (_admin, _fac);

  perform test_helpers.login_as(_admin);
  _r := public.admin_create_block_series(_fac, _desde, _desde + 6, array['08:00'], 60, 10);
  assert (_r ->> 'creados')::int = 7, format('esperados 7: %s', _r);

  -- Una reserva sobre uno de los bloques.
  select id into _bloque from public.time_blocks
  where facility_id = _fac order by starts_at limit 1;

  perform test_helpers.login_as(_usuario);
  _r := public.create_reservation_strict(_bloque);
  assert (_r ->> 'ok')::boolean, format('la reserva de apoyo falló: %s', _r);

  -- ---------------------------------------------------------------
  -- Simulación de la desactivación
  -- ---------------------------------------------------------------
  perform test_helpers.login_as(_admin);
  _r := public.admin_deactivate_block_series(
    _fac, _desde, _desde + 6, 'America/Santiago', true);

  assert (_r ->> 'afectados')::int = 7, format('esperados 7 afectados: %s', _r);
  assert (_r ->> 'con_reservas_vigentes')::int = 1,
    format('debía avisar de 1 bloque con reservas: %s', _r);
  assert (select count(*) from public.time_blocks where facility_id = _fac and active) = 7,
    'La simulación desactivó bloques';

  -- ---------------------------------------------------------------
  -- Desactivación real
  -- ---------------------------------------------------------------
  _r := public.admin_deactivate_block_series(_fac, _desde, _desde + 6);
  assert (_r ->> 'afectados')::int = 7, format('esperados 7 desactivados: %s', _r);
  assert (select count(*) from public.time_blocks where facility_id = _fac and active) = 0,
    'Quedaron bloques activos';

  -- Los bloques desaparecen del catálogo público…
  assert not exists (select 1 from public.block_availability where facility_id = _fac),
    'Un bloque desactivado sigue en el catálogo';

  -- …pero la reserva ya confirmada NO se cancela: esa decisión es
  -- explícita y se toma desde la pestaña de reservas.
  assert (select status from public.reservations where block_id = _bloque) = 'vigente',
    'Desactivar los bloques canceló una reserva confirmada';

  raise notice 'OK · desactivación en serie conserva las reservas confirmadas';
end;
$$;

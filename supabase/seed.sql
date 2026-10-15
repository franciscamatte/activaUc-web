-- =====================================================================
-- ActivaUC · datos de ejemplo para DESARROLLO
-- ---------------------------------------------------------------------
-- `supabase db reset` lo aplica automáticamente en el entorno local.
--
-- NO ejecutar en producción: crea recintos y bloques de muestra.
-- Los usuarios se crean aparte, desde la aplicación o con el script
-- scripts/seed-usuarios.sh, porque dependen de Supabase Auth.
--
-- Este archivo es idempotente: puede ejecutarse varias veces.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Recintos de muestra
-- ---------------------------------------------------------------------
insert into public.facilities (id, name, facility_type, description, operation_hours)
values
  (
    '0a000001-0000-4000-8000-000000000001',
    'Cancha de fútbol San Joaquín',
    'Fútbol',
    'Cancha de pasto sintético con iluminación nocturna, camarines y estacionamiento cercano.',
    '08:00 a 22:00, lunes a sábado'
  ),
  (
    '0a000001-0000-4000-8000-000000000002',
    'Gimnasio multicancha Casa Central',
    'Básquetbol',
    'Multicancha techada apta para básquetbol, vóleibol y balonmano, con graderías.',
    '07:00 a 21:00, lunes a viernes'
  ),
  (
    '0a000001-0000-4000-8000-000000000003',
    'Canchas de tenis Lo Contador',
    'Tenis',
    'Dos canchas de arcilla con arriendo de implementos en recepción.',
    '09:00 a 20:00, todos los días'
  ),
  (
    '0a000001-0000-4000-8000-000000000004',
    'Piscina temperada Deportes UC',
    'Natación',
    'Piscina semiolímpica de seis andariveles. Gorro de natación obligatorio.',
    '07:00 a 21:00, lunes a sábado'
  )
on conflict (id) do update
  set name = excluded.name,
      facility_type = excluded.facility_type,
      description = excluded.description,
      operation_hours = excluded.operation_hours,
      active = true;

-- ---------------------------------------------------------------------
-- Bloques horarios de los próximos 14 días
-- ---------------------------------------------------------------------
do $$
declare
  _recinto record;
  _dia int;
  _hora int;
  _inicio timestamptz;
  _capacidad int;
begin
  for _recinto in
    select id, facility_type from public.facilities
    where id like '0a000001-0000-4000-8000-%'
  loop
    _capacidad := case _recinto.facility_type
      when 'Tenis'    then 4
      when 'Natación' then 12
      else 20
    end;

    for _dia in 0..13 loop
      foreach _hora in array array[9, 11, 15, 17, 19] loop
        -- Hora local de Chile continental.
        _inicio := (current_date + _dia) + (_hora || ' hours')::interval;

        -- Sólo bloques futuros: el pasado no es reservable.
        continue when _inicio <= now() + interval '15 minutes';

        insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
        values (_recinto.id, _inicio, _inicio + interval '1 hour', _capacidad)
        on conflict do nothing;
      end loop;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Asignación de administradores
-- ---------------------------------------------------------------------
-- Las asignaciones dependen de usuarios reales de auth.users, que este
-- archivo no crea. Tras registrar la cuenta administradora en la
-- aplicación, ejecuta (sustituyendo el correo):
--
--   update public.profiles
--   set role = 'administrador'
--   where id = (select id from auth.users where email = 'admin@uc.cl');
--
--   insert into public.facility_admin_assignments (admin_id, facility_id)
--   select p.id, f.id
--   from public.profiles p
--   cross join public.facilities f
--   where p.id = (select id from auth.users where email = 'admin@uc.cl')
--   on conflict do nothing;
--
-- scripts/seed-usuarios.sh automatiza estos dos pasos.

-- ---------------------------------------------------------------------
-- Resumen de lo cargado
-- ---------------------------------------------------------------------
do $$
declare
  _recintos int;
  _bloques int;
begin
  select count(*) into _recintos from public.facilities where active;
  select count(*) into _bloques from public.time_blocks where active and starts_at > now();

  raise notice 'ActivaUC · datos de ejemplo cargados: % recintos activos, % bloques futuros.',
    _recintos, _bloques;
end;
$$;

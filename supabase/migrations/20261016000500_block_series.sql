-- =====================================================================
-- ActivaUC · 05 · Creación de bloques en serie
-- ---------------------------------------------------------------------
-- Crear los bloques uno a uno es inviable para quien administra un
-- recinto: una temporada son cientos. Esta función genera una serie
-- (diaria o por días de la semana) en una sola transacción.
--
-- Decisiones:
--   · Vive en la base, no en el cliente, porque es una escritura masiva
--     que debe autorizarse en el servidor y ser atómica. Un bucle en el
--     navegador dejaría series a medias si se corta a la mitad.
--   · Admite simulación (_simular), para que el panel muestre una vista
--     previa antes de escribir nada.
--   · Omite, sin fallar, los bloques que ya existen y los que caen en el
--     pasado. Así la misma serie se puede volver a aplicar para
--     extenderla sin duplicar lo ya publicado.
-- =====================================================================

create or replace function public.admin_create_block_series(
  _facility_id uuid,
  _fecha_desde date,
  _fecha_hasta date,
  _horas text[],
  _duracion_minutos integer,
  _capacidad integer,
  -- Días de la semana: 0 = domingo … 6 = sábado. NULL o vacío = todos.
  _dias_semana integer[] default null,
  _zona text default 'America/Santiago',
  _simular boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid        uuid := auth.uid();
  _fecha      date;
  _hora       text;
  _inicio     timestamptz;
  _fin        timestamptz;
  _creados    integer := 0;
  _omitidos_existentes integer := 0;
  _omitidos_pasado     integer := 0;
  _previstos  integer := 0;
  _primero    timestamptz;
  _ultimo     timestamptz;
  _dias       integer[];
  _muestra    jsonb := '[]'::jsonb;
  -- Tope de seguridad: evita que un rango mal escrito genere decenas de
  -- miles de filas por accidente.
  _tope       constant integer := 1000;
begin
  -- ---------------------------------------------------------------
  -- Autorización: sólo un administrador asignado a ese recinto.
  -- ---------------------------------------------------------------
  if _uid is null then
    raise exception 'Debes iniciar sesión.' using errcode = '28000';
  end if;

  if not public.is_facility_admin(_uid, _facility_id) then
    raise exception 'No administras ese recinto.' using errcode = '42501';
  end if;

  -- ---------------------------------------------------------------
  -- Validación de los parámetros, con mensajes accionables.
  -- ---------------------------------------------------------------
  if _fecha_desde is null or _fecha_hasta is null then
    return jsonb_build_object('ok', false, 'error', 'fechas_incompletas',
      'mensaje', 'Indica la fecha de inicio y la de término de la serie.');
  end if;

  if _fecha_hasta < _fecha_desde then
    return jsonb_build_object('ok', false, 'error', 'rango_invertido',
      'mensaje', 'La fecha de término debe ser igual o posterior a la de inicio.');
  end if;

  if _fecha_hasta - _fecha_desde > 366 then
    return jsonb_build_object('ok', false, 'error', 'rango_demasiado_largo',
      'mensaje', 'El rango no puede superar un año. Crea la serie por temporadas.');
  end if;

  if _horas is null or array_length(_horas, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'sin_horas',
      'mensaje', 'Indica al menos una hora de inicio, por ejemplo 08:00.');
  end if;

  if array_length(_horas, 1) > 24 then
    return jsonb_build_object('ok', false, 'error', 'demasiadas_horas',
      'mensaje', 'Como máximo 24 horas de inicio por serie.');
  end if;

  foreach _hora in array _horas loop
    if _hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return jsonb_build_object('ok', false, 'error', 'hora_invalida',
        'mensaje', format('La hora «%s» no tiene el formato HH:MM (24 horas).', _hora));
    end if;
  end loop;

  if _duracion_minutos is null or _duracion_minutos < 15 or _duracion_minutos > 720 then
    return jsonb_build_object('ok', false, 'error', 'duracion_invalida',
      'mensaje', 'La duración debe estar entre 15 minutos y 12 horas.');
  end if;

  if _capacidad is null or _capacidad < 1 or _capacidad > 1000 then
    return jsonb_build_object('ok', false, 'error', 'capacidad_invalida',
      'mensaje', 'La capacidad debe estar entre 1 y 1000 personas.');
  end if;

  -- Comprobación de la zona horaria antes de usarla en el bucle.
  begin
    perform now() at time zone _zona;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'zona_invalida',
      'mensaje', format('La zona horaria «%s» no es válida.', _zona));
  end;

  _dias := case
    when _dias_semana is null or array_length(_dias_semana, 1) is null
      then array[0, 1, 2, 3, 4, 5, 6]
    else _dias_semana
  end;

  if exists (select 1 from unnest(_dias) d where d < 0 or d > 6) then
    return jsonb_build_object('ok', false, 'error', 'dia_invalido',
      'mensaje', 'Los días de la semana van de 0 (domingo) a 6 (sábado).');
  end if;

  -- ---------------------------------------------------------------
  -- Recuento previo, para rechazar antes de escribir nada.
  -- ---------------------------------------------------------------
  _previstos := (
    select count(*)
    from generate_series(_fecha_desde, _fecha_hasta, interval '1 day') g(dia)
    where extract(dow from g.dia)::integer = any(_dias)
  ) * array_length(_horas, 1);

  if _previstos > _tope then
    return jsonb_build_object('ok', false, 'error', 'demasiados_bloques',
      'mensaje', format(
        'La serie generaría %s bloques y el máximo por operación es %s. Acorta el rango o reduce las horas.',
        _previstos, _tope));
  end if;

  if _previstos = 0 then
    return jsonb_build_object('ok', false, 'error', 'serie_vacia',
      'mensaje', 'Ninguna fecha del rango coincide con los días de la semana elegidos.');
  end if;

  -- ---------------------------------------------------------------
  -- Generación
  -- ---------------------------------------------------------------
  for _fecha in
    select g.dia::date
    from generate_series(_fecha_desde, _fecha_hasta, interval '1 day') g(dia)
    where extract(dow from g.dia)::integer = any(_dias)
    order by g.dia
  loop
    foreach _hora in array _horas loop
      -- La hora se interpreta en la zona del recinto, no en UTC: un
      -- bloque de las 08:00 debe ser las 08:00 locales todo el año,
      -- incluido el cambio de horario de verano.
      _inicio := (_fecha::text || ' ' || _hora || ':00')::timestamp at time zone _zona;
      _fin    := _inicio + make_interval(mins => _duracion_minutos);

      -- No tiene sentido publicar bloques ya pasados.
      if _inicio <= now() then
        _omitidos_pasado := _omitidos_pasado + 1;
        continue;
      end if;

      -- El índice único parcial ya lo impediría, pero comprobarlo aquí
      -- permite informar cuántos se omitieron y por qué.
      if exists (
        select 1 from public.time_blocks tb
        where tb.facility_id = _facility_id
          and tb.starts_at = _inicio
          and tb.active
      ) then
        _omitidos_existentes := _omitidos_existentes + 1;
        continue;
      end if;

      if not _simular then
        insert into public.time_blocks
          (facility_id, starts_at, ends_at, max_capacity, active)
        values (_facility_id, _inicio, _fin, _capacidad, true);
      end if;

      _creados := _creados + 1;
      if _primero is null then _primero := _inicio; end if;
      _ultimo := _inicio;

      -- Muestra de los primeros bloques, para la vista previa.
      if jsonb_array_length(_muestra) < 5 then
        _muestra := _muestra || jsonb_build_object('inicio', _inicio, 'fin', _fin);
      end if;
    end loop;
  end loop;

  -- ---------------------------------------------------------------
  -- Auditoría: sólo cuando se escribió de verdad.
  -- ---------------------------------------------------------------
  if not _simular and _creados > 0 then
    insert into public.reservation_audit_log
      (facility_id, action, actor_id, actor_role, details)
    values (_facility_id, 'bloque_creado', _uid, 'administrador',
      jsonb_build_object(
        'serie', true,
        'creados', _creados,
        'desde', _fecha_desde,
        'hasta', _fecha_hasta,
        'horas', _horas,
        'dias_semana', _dias,
        'capacidad', _capacidad,
        'duracion_minutos', _duracion_minutos));
  end if;

  return jsonb_build_object(
    'ok', true,
    'simulado', _simular,
    'creados', _creados,
    'omitidos_existentes', _omitidos_existentes,
    'omitidos_pasado', _omitidos_pasado,
    'previstos', _previstos,
    'primer_bloque', _primero,
    'ultimo_bloque', _ultimo,
    'muestra', _muestra,
    'mensaje', case
      when _creados = 0 and _omitidos_existentes > 0
        then 'Todos los bloques de la serie ya existían: no se creó ninguno nuevo.'
      when _creados = 0
        then 'No había ningún bloque que crear en ese rango.'
      when _simular
        then format('Se crearían %s bloques.', _creados)
      else format('Se crearon %s bloques.', _creados)
    end
  );
end;
$$;

comment on function public.admin_create_block_series(uuid, date, date, text[], integer, integer, integer[], text, boolean) is
  'Crea una serie de bloques horarios (diaria o por días de la semana) en una sola transacción. Admite simulación para vista previa. Omite los ya existentes y los que caen en el pasado.';

-- ---------------------------------------------------------------------
-- Desactivación en serie, la operación inversa.
-- ---------------------------------------------------------------------
-- Hace falta por la misma razón: un recinto que cierra por mantención
-- durante dos semanas no se puede desactivar bloque por bloque.
-- Las reservas ya confirmadas NO se cancelan: eso es una decisión que
-- debe tomarse explícitamente desde la pestaña de reservas.
create or replace function public.admin_deactivate_block_series(
  _facility_id uuid,
  _fecha_desde date,
  _fecha_hasta date,
  _zona text default 'America/Santiago',
  _simular boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid        uuid := auth.uid();
  _desde      timestamptz;
  _hasta      timestamptz;
  _afectados  integer := 0;
  _con_reservas integer := 0;
begin
  if _uid is null then
    raise exception 'Debes iniciar sesión.' using errcode = '28000';
  end if;

  if not public.is_facility_admin(_uid, _facility_id) then
    raise exception 'No administras ese recinto.' using errcode = '42501';
  end if;

  if _fecha_desde is null or _fecha_hasta is null or _fecha_hasta < _fecha_desde then
    return jsonb_build_object('ok', false, 'error', 'rango_invalido',
      'mensaje', 'Indica un rango de fechas válido.');
  end if;

  _desde := (_fecha_desde::text || ' 00:00:00')::timestamp at time zone _zona;
  _hasta := ((_fecha_hasta + 1)::text || ' 00:00:00')::timestamp at time zone _zona;

  select count(*) into _afectados
  from public.time_blocks tb
  where tb.facility_id = _facility_id
    and tb.active
    and tb.starts_at >= _desde
    and tb.starts_at < _hasta;

  -- Se informa cuántos tienen reservas vigentes, para que quien
  -- administra sepa que debe atenderlas aparte.
  select count(distinct tb.id) into _con_reservas
  from public.time_blocks tb
  join public.reservations r on r.block_id = tb.id and r.status = 'vigente'
  where tb.facility_id = _facility_id
    and tb.active
    and tb.starts_at >= _desde
    and tb.starts_at < _hasta;

  if not _simular and _afectados > 0 then
    update public.time_blocks
    set active = false
    where facility_id = _facility_id
      and active
      and starts_at >= _desde
      and starts_at < _hasta;

    insert into public.reservation_audit_log
      (facility_id, action, actor_id, actor_role, details)
    values (_facility_id, 'bloque_desactivado', _uid, 'administrador',
      jsonb_build_object('serie', true, 'desactivados', _afectados,
                         'desde', _fecha_desde, 'hasta', _fecha_hasta,
                         'con_reservas_vigentes', _con_reservas));
  end if;

  return jsonb_build_object(
    'ok', true,
    'simulado', _simular,
    'afectados', _afectados,
    'con_reservas_vigentes', _con_reservas,
    'mensaje', case
      when _afectados = 0 then 'No hay bloques activos en ese rango.'
      when _simular then format('Se desactivarían %s bloques.', _afectados)
      else format('Se desactivaron %s bloques.', _afectados)
    end
  );
end;
$$;

comment on function public.admin_deactivate_block_series(uuid, date, date, text, boolean) is
  'Desactiva en bloque los bloques horarios de un rango de fechas. No cancela las reservas ya confirmadas: informa cuántas hay para que se atiendan aparte.';

-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------
revoke all on function public.admin_create_block_series(uuid, date, date, text[], integer, integer, integer[], text, boolean)
  from public, anon;
revoke all on function public.admin_deactivate_block_series(uuid, date, date, text, boolean)
  from public, anon;

grant execute on function public.admin_create_block_series(uuid, date, date, text[], integer, integer, integer[], text, boolean)
  to authenticated;
grant execute on function public.admin_deactivate_block_series(uuid, date, date, text, boolean)
  to authenticated;

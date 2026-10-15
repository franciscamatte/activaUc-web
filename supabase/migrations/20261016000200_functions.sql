-- =====================================================================
-- ActivaUC · 02 · Funciones, vistas y transacciones
-- ---------------------------------------------------------------------
-- Contiene la lógica de negocio que NO puede delegarse al frontend:
--   · create_reservation_strict  (REQ-12, REQ-13, REQ-16)
--   · cancel_reservation         (REQ-15, REQ-32, reglas de negocio)
--   · colas de integración con reintentos e idempotencia (REQ-20, REQ-25)
--   · vistas de disponibilidad sin exponer datos personales
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers de autorización
-- ---------------------------------------------------------------------
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.is_admin(_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = _uid and p.role = 'administrador'
  );
$$;

-- Verdadero sólo si _uid es administrador asignado a ese recinto (REQ-29).
create or replace function public.is_facility_admin(_uid uuid, _facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.facility_admin_assignments faa
    join public.profiles p on p.id = faa.admin_id
    where faa.admin_id = _uid
      and faa.facility_id = _facility_id
      and p.role = 'administrador'
  );
$$;

comment on function public.is_facility_admin(uuid, uuid) is
  'Un administrador sólo opera sobre los recintos que tiene asignados. Base de todas las políticas RLS de administración.';

-- ---------------------------------------------------------------------
-- Rate limiting por ventana fija (abuso de endpoints)
-- ---------------------------------------------------------------------
create or replace function public.consume_rate_limit(
  _bucket text,
  _subject text,
  _limit integer,
  _window interval default interval '1 minute'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _window_start timestamptz;
  _current integer;
begin
  _window_start := to_timestamp(
    floor(extract(epoch from now()) / greatest(extract(epoch from _window), 1))
    * greatest(extract(epoch from _window), 1)
  );

  insert into public.rate_limit_counters (bucket, subject, window_start, counter)
  values (_bucket, _subject, _window_start, 1)
  on conflict (bucket, subject, window_start)
    do update set counter = public.rate_limit_counters.counter + 1
  returning counter into _current;

  -- Limpieza oportunista de ventanas antiguas.
  if random() < 0.01 then
    delete from public.rate_limit_counters where window_start < now() - interval '1 day';
  end if;

  return _current <= _limit;
end;
$$;

-- ---------------------------------------------------------------------
-- Vista pública de disponibilidad · REQ-9, REQ-11
-- Expone únicamente agregados: nunca user_id ni datos personales.
-- security_invoker = false para que anon pueda contar reservas sin
-- tener permiso de lectura sobre public.reservations.
-- ---------------------------------------------------------------------
create or replace view public.block_availability
with (security_invoker = false) as
select
  tb.id                     as block_id,
  tb.facility_id            as facility_id,
  f.name                    as facility_name,
  f.facility_type           as facility_type,
  f.description             as facility_description,
  f.operation_hours         as facility_operation_hours,
  tb.starts_at              as starts_at,
  tb.ends_at                as ends_at,
  tb.max_capacity           as max_capacity,
  coalesce(r.active_count, 0)::integer                               as reserved_count,
  greatest(tb.max_capacity - coalesce(r.active_count, 0), 0)::integer as available_count,
  (coalesce(r.active_count, 0) >= tb.max_capacity)                   as is_full,
  (tb.starts_at <= now())                                            as is_past,
  tb.active                 as block_active,
  f.active                  as facility_active
from public.time_blocks tb
join public.facilities f on f.id = tb.facility_id
left join (
  select block_id, count(*) as active_count
  from public.reservations
  where status = 'vigente'
  group by block_id
) r on r.block_id = tb.id
where tb.active and f.active;

comment on view public.block_availability is
  'Disponibilidad agregada por bloque. Lectura pública: no contiene identificadores ni datos personales de usuarios.';

-- ---------------------------------------------------------------------
-- Vista de reservas del usuario autenticado · REQ-14, REQ-21
-- security_invoker = true: respeta las políticas RLS de reservations.
-- ---------------------------------------------------------------------
create or replace view public.my_reservations
with (security_invoker = true) as
select
  r.id,
  r.user_id,
  r.facility_id,
  f.name            as facility_name,
  f.facility_type   as facility_type,
  r.block_id,
  r.starts_at,
  r.ends_at,
  r.status,
  (r.status = 'vigente' and r.ends_at < now()) as is_past,
  r.calendar_sync_status,
  (r.calendar_event_id is not null)            as has_calendar_event,
  r.cancelled_at,
  r.cancelled_by_role,
  r.cancel_reason,
  r.created_at,
  coalesce(
    (select wm.status::text
     from public.whatsapp_messages wm
     where wm.reservation_id = r.id and wm.kind = 'confirmacion'
     order by wm.created_at desc limit 1),
    case
      when exists (
        select 1 from public.notification_jobs nj
        where nj.reservation_id = r.id and nj.kind = 'confirmacion'
          and nj.status in ('pendiente', 'procesando', 'error')
      ) then 'pendiente'
      else 'omitido'
    end
  ) as whatsapp_confirmation_status,
  coalesce(
    (select wm.status::text
     from public.whatsapp_messages wm
     where wm.reservation_id = r.id and wm.kind = 'recordatorio'
     order by wm.created_at desc limit 1),
    case
      when exists (
        select 1 from public.notification_jobs nj
        where nj.reservation_id = r.id and nj.kind = 'recordatorio'
          and nj.status in ('pendiente', 'procesando', 'error')
      ) then 'pendiente'
      else 'omitido'
    end
  ) as whatsapp_reminder_status
from public.reservations r
join public.facilities f on f.id = r.facility_id;

comment on view public.my_reservations is
  'Reservas visibles para el solicitante según RLS, con estados de integración derivados de las colas y la trazabilidad.';

-- =====================================================================
-- REQ-12 / REQ-13 / REQ-16 · Creación transaccional de reserva
-- ---------------------------------------------------------------------
-- Garantía de concurrencia: se toma un bloqueo de fila sobre el bloque
-- (SELECT ... FOR UPDATE). Toda solicitud concurrente sobre el mismo
-- bloque se serializa, de modo que el conteo de reservas vigentes y la
-- comparación contra max_capacity son consistentes. El índice único
-- parcial reservations_one_active_per_user_block_idx es la segunda
-- barrera contra duplicados.
--
-- Devuelve un resultado estructurado (jsonb). Los fallos de negocio no
-- lanzan excepción: retornan ok = false, de modo que la transacción
-- termina limpia y sin escrituras parciales.
-- =====================================================================
create or replace function public.create_reservation_strict(
  _block_id uuid,
  _client_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid              uuid := auth.uid();
  _block            public.time_blocks;
  _facility_active  boolean;
  _active_count     integer;
  _existing         public.reservations;
  _reservation      public.reservations;
  _has_calendar     boolean := false;
  _consent          boolean := false;
  _calendar_state   public.calendar_sync_status := 'no_aplica';
  _confirm_state    text := 'omitido';
  _reminder_state   text := 'omitido';
  _reminder_at      timestamptz;
begin
  -- 1) Usuario autenticado (REQ: sólo usuarios registrados reservan).
  if _uid is null then
    raise exception 'Debes iniciar sesión para reservar.' using errcode = '28000';
  end if;

  if not exists (select 1 from public.profiles p where p.id = _uid) then
    raise exception 'Tu perfil aún no está disponible. Vuelve a iniciar sesión.' using errcode = '28000';
  end if;

  -- Protección contra abuso: máximo 20 intentos por minuto y usuario.
  if not public.consume_rate_limit('reserva', _uid::text, 20, interval '1 minute') then
    return jsonb_build_object(
      'ok', false,
      'error', 'limite_solicitudes',
      'mensaje', 'Demasiados intentos seguidos. Espera un momento e inténtalo de nuevo.'
    );
  end if;

  -- 2) Bloqueo de fila del bloque: serializa las solicitudes concurrentes.
  select * into _block
  from public.time_blocks tb
  where tb.id = _block_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'bloque_inexistente',
      'mensaje', 'El bloque horario ya no existe.'
    );
  end if;

  if not _block.active then
    return jsonb_build_object(
      'ok', false,
      'error', 'bloque_inactivo',
      'mensaje', 'Este bloque horario fue desactivado por el administrador.'
    );
  end if;

  select f.active into _facility_active
  from public.facilities f where f.id = _block.facility_id;

  if not coalesce(_facility_active, false) then
    return jsonb_build_object(
      'ok', false,
      'error', 'recinto_inactivo',
      'mensaje', 'El recinto de este bloque está fuera de servicio.'
    );
  end if;

  if _block.starts_at <= now() then
    return jsonb_build_object(
      'ok', false,
      'error', 'bloque_iniciado',
      'mensaje', 'Este bloque ya comenzó y no admite nuevas reservas.'
    );
  end if;

  -- 3) Idempotencia / REQ-13: si ya existe una reserva vigente del mismo
  --    usuario en este bloque, no se crea otra y se devuelve la existente.
  select * into _existing
  from public.reservations r
  where r.user_id = _uid and r.block_id = _block.id and r.status = 'vigente';

  if found then
    return jsonb_build_object(
      'ok', true,
      'duplicada', true,
      'reservation_id', _existing.id,
      'estado', _existing.status,
      'calendar_sync_status', _existing.calendar_sync_status,
      'mensaje', 'Ya tenías una reserva vigente en este bloque.'
    );
  end if;

  -- 4) Capacidad (REQ-12, regla de negocio: sin sobrecupos).
  select count(*)::integer into _active_count
  from public.reservations r
  where r.block_id = _block.id and r.status = 'vigente';

  if _active_count >= _block.max_capacity then
    return jsonb_build_object(
      'ok', false,
      'error', 'sin_cupos',
      'mensaje', 'Este bloque acaba de quedar sin cupos disponibles.',
      'cupos_disponibles', 0
    );
  end if;

  -- 5) Estado de integraciones del usuario.
  select (cc.status = 'conectado') into _has_calendar
  from public.calendar_connections cc
  where cc.user_id = _uid;
  _has_calendar := coalesce(_has_calendar, false);

  select (p.whatsapp_consent and p.phone is not null) into _consent
  from public.profiles p where p.id = _uid;
  _consent := coalesce(_consent, false);

  if _has_calendar then
    _calendar_state := 'pendiente';
  end if;

  -- 6) Creación atómica.
  insert into public.reservations (
    user_id, facility_id, block_id, starts_at, ends_at,
    status, calendar_sync_status
  ) values (
    _uid, _block.facility_id, _block.id, _block.starts_at, _block.ends_at,
    'vigente', _calendar_state
  )
  returning * into _reservation;

  -- 7) Auditoría.
  insert into public.reservation_audit_log
    (reservation_id, facility_id, action, actor_id, actor_role, details)
  values (
    _reservation.id, _block.facility_id, 'reserva_creada', _uid, 'usuario',
    jsonb_build_object(
      'block_id', _block.id,
      'starts_at', _block.starts_at,
      'cupos_restantes', _block.max_capacity - _active_count - 1,
      'client_request_id', _client_request_id
    )
  );

  -- 8) Trabajos de integración, idempotentes por clave determinística.
  if _has_calendar then
    insert into public.calendar_sync_jobs
      (reservation_id, user_id, kind, idempotency_key, payload)
    values (
      _reservation.id, _uid, 'crear_evento',
      'cal:create:' || _reservation.id::text,
      jsonb_build_object('reservation_id', _reservation.id)
    )
    on conflict (idempotency_key) do nothing;
  end if;

  if _consent then
    -- REQ-24: confirmación inmediata.
    insert into public.notification_jobs
      (reservation_id, user_id, kind, idempotency_key, scheduled_for, payload)
    values (
      _reservation.id, _uid, 'confirmacion',
      'wa:confirm:' || _reservation.id::text,
      now(),
      jsonb_build_object('reservation_id', _reservation.id)
    )
    on conflict (idempotency_key) do nothing;
    _confirm_state := 'pendiente';

    -- REQ-25: recordatorio sólo si la reserva se crea con >= 2 horas de
    -- anticipación. Con menos de 2 horas se omite por completo.
    _reminder_at := _block.starts_at - interval '2 hours';
    if _reminder_at > now() then
      insert into public.notification_jobs
        (reservation_id, user_id, kind, idempotency_key, scheduled_for, next_attempt_at, payload)
      values (
        _reservation.id, _uid, 'recordatorio',
        'wa:remind:' || _reservation.id::text,
        _reminder_at, _reminder_at,
        jsonb_build_object('reservation_id', _reservation.id)
      )
      on conflict (idempotency_key) do nothing;
      _reminder_state := 'programado';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicada', false,
    'reservation_id', _reservation.id,
    'estado', _reservation.status,
    'starts_at', _reservation.starts_at,
    'ends_at', _reservation.ends_at,
    'facility_id', _reservation.facility_id,
    'calendar_sync_status', _calendar_state,
    'whatsapp_confirmacion', _confirm_state,
    'whatsapp_recordatorio', _reminder_state,
    'recordatorio_programado_para', _reminder_at,
    'cupos_disponibles', _block.max_capacity - _active_count - 1
  );
exception
  -- Barrera defensiva: si el índice único parcial dispara (no debería
  -- ocurrir con el bloqueo de fila), se informa como duplicado y no
  -- queda ninguna escritura a medias.
  when unique_violation then
    return jsonb_build_object(
      'ok', false,
      'error', 'reserva_duplicada',
      'mensaje', 'Ya tienes una reserva vigente en este bloque.'
    );
end;
$$;

comment on function public.create_reservation_strict(uuid, text) is
  'Crea una reserva de forma atómica con bloqueo de fila sobre el bloque. Devuelve jsonb estructurado; sin sobrecupos ni duplicados bajo concurrencia.';

-- =====================================================================
-- REQ-15 / REQ-32 · Cancelación transaccional
-- ---------------------------------------------------------------------
-- Una sola función cubre ambos caminos y decide por el rol real del
-- solicitante, nunca por un parámetro del cliente:
--   · dueño de la reserva  → exige >= 2 horas de anticipación
--   · administrador asignado al recinto → sin ventana de 2 horas
-- =====================================================================
create or replace function public.cancel_reservation(
  _reservation_id uuid,
  _reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid          uuid := auth.uid();
  _res          public.reservations;
  _is_owner     boolean;
  _is_admin     boolean;
  _actor_role   public.user_role;
  _action       text;
  _consent      boolean := false;
  _pending_create integer := 0;
  _calendar_next public.calendar_sync_status;
  _notify       boolean := false;
begin
  if _uid is null then
    raise exception 'Debes iniciar sesión para cancelar una reserva.' using errcode = '28000';
  end if;

  if not public.consume_rate_limit('cancelacion', _uid::text, 30, interval '1 minute') then
    return jsonb_build_object(
      'ok', false,
      'error', 'limite_solicitudes',
      'mensaje', 'Demasiados intentos seguidos. Espera un momento e inténtalo de nuevo.'
    );
  end if;

  select * into _res
  from public.reservations r
  where r.id = _reservation_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'reserva_inexistente',
      'mensaje', 'No encontramos esa reserva.'
    );
  end if;

  _is_owner := (_res.user_id = _uid);
  _is_admin := public.is_facility_admin(_uid, _res.facility_id);

  -- Sólo el dueño o el administrador del recinto pueden cancelar.
  if not (_is_owner or _is_admin) then
    return jsonb_build_object(
      'ok', false,
      'error', 'no_autorizado',
      'mensaje', 'No tienes permiso para cancelar esta reserva.'
    );
  end if;

  if _res.status = 'cancelada' then
    return jsonb_build_object(
      'ok', true,
      'ya_cancelada', true,
      'reservation_id', _res.id,
      'mensaje', 'Esta reserva ya estaba cancelada.'
    );
  end if;

  if _res.ends_at <= now() then
    return jsonb_build_object(
      'ok', false,
      'error', 'reserva_vencida',
      'mensaje', 'Esta reserva ya finalizó y no puede cancelarse.'
    );
  end if;

  -- Si quien cancela es el dueño (y no además administrador del recinto),
  -- se aplica la ventana de 2 horas y no puede cancelar algo ya iniciado.
  if _is_owner and not _is_admin then
    if _res.starts_at <= now() then
      return jsonb_build_object(
        'ok', false,
        'error', 'reserva_iniciada',
        'mensaje', 'La reserva ya comenzó y no puede cancelarse.'
      );
    end if;
    if _res.starts_at - now() < interval '2 hours' then
      return jsonb_build_object(
        'ok', false,
        'error', 'ventana_cerrada',
        'mensaje', 'Las cancelaciones requieren al menos 2 horas de anticipación. Contacta al administrador del recinto.'
      );
    end if;
    _actor_role := 'usuario';
    _action := 'reserva_cancelada_usuario';
  else
    _actor_role := 'administrador';
    _action := 'reserva_cancelada_admin';
    _notify := true;
  end if;

  -- Cancelar el trabajo de creación de evento si todavía no se ejecutó;
  -- en ese caso no hay nada que eliminar en Google Calendar.
  update public.calendar_sync_jobs
  set status = 'cancelado', last_error = null
  where reservation_id = _res.id
    and kind = 'crear_evento'
    and status in ('pendiente', 'error');
  _pending_create := coalesce((select count(*) from public.calendar_sync_jobs j
                               where j.reservation_id = _res.id
                                 and j.kind = 'crear_evento'
                                 and j.status = 'procesando'), 0);

  -- REQ-19: encolar eliminación si el evento existe o puede existir.
  if _res.calendar_event_id is not null or _pending_create > 0 then
    insert into public.calendar_sync_jobs
      (reservation_id, user_id, kind, idempotency_key, payload)
    values (
      _res.id, _res.user_id, 'eliminar_evento',
      'cal:delete:' || _res.id::text,
      jsonb_build_object('reservation_id', _res.id)
    )
    on conflict (idempotency_key) do nothing;
    _calendar_next := 'pendiente';
  else
    _calendar_next := case
      when _res.calendar_sync_status = 'error' then 'error'
      else 'no_aplica'
    end;
  end if;

  -- Liberación inmediata del cupo: el cambio de estado basta porque la
  -- disponibilidad se calcula sobre status = 'vigente'.
  update public.reservations
  set status = 'cancelada',
      cancelled_at = now(),
      cancelled_by = _uid,
      cancelled_by_role = _actor_role,
      cancel_reason = nullif(btrim(coalesce(_reason, '')), ''),
      calendar_sync_status = _calendar_next
  where id = _res.id;

  insert into public.reservation_audit_log
    (reservation_id, facility_id, action, actor_id, actor_role, details)
  values (
    _res.id, _res.facility_id, _action, _uid, _actor_role,
    jsonb_build_object(
      'block_id', _res.block_id,
      'starts_at', _res.starts_at,
      'motivo', nullif(btrim(coalesce(_reason, '')), ''),
      'horas_de_anticipacion', round(extract(epoch from (_res.starts_at - now())) / 3600.0, 2)
    )
  );

  -- No enviar recordatorios de reservas canceladas.
  update public.notification_jobs
  set status = 'cancelado'
  where reservation_id = _res.id
    and kind in ('recordatorio', 'confirmacion')
    and status in ('pendiente', 'error');

  -- REQ-26: avisar al usuario cuando cancela el administrador.
  if _notify and not _is_owner then
    select (p.whatsapp_consent and p.phone is not null) into _consent
    from public.profiles p where p.id = _res.user_id;

    if coalesce(_consent, false) then
      insert into public.notification_jobs
        (reservation_id, user_id, kind, idempotency_key, scheduled_for, payload)
      values (
        _res.id, _res.user_id, 'cancelacion_admin',
        'wa:admincancel:' || _res.id::text,
        now(),
        jsonb_build_object('reservation_id', _res.id, 'motivo', nullif(btrim(coalesce(_reason, '')), ''))
      )
      on conflict (idempotency_key) do nothing;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reservation_id', _res.id,
    'estado', 'cancelada',
    'cancelado_por', _actor_role,
    'calendar_sync_status', _calendar_next,
    'notificacion_whatsapp', (_notify and not _is_owner and coalesce(_consent, false)),
    'mensaje', 'Reserva cancelada. El cupo quedó disponible para otras personas.'
  );
end;
$$;

comment on function public.cancel_reservation(uuid, text) is
  'Cancela una reserva validando en backend la identidad y el rol real del solicitante. Libera el cupo, audita y encola integraciones.';

-- =====================================================================
-- REQ-22 / REQ-23 · Consentimiento WhatsApp
-- =====================================================================
create or replace function public.set_whatsapp_consent(
  _phone text,
  _consent boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid   uuid := auth.uid();
  _clean text;
begin
  if _uid is null then
    raise exception 'Debes iniciar sesión.' using errcode = '28000';
  end if;

  if _consent then
    _clean := regexp_replace(coalesce(_phone, ''), '[^0-9+]', '', 'g');
    if _clean !~ '^\+[1-9][0-9]{7,14}$' then
      return jsonb_build_object(
        'ok', false,
        'error', 'telefono_invalido',
        'mensaje', 'Ingresa el número en formato internacional E.164, por ejemplo +56912345678.'
      );
    end if;

    update public.profiles
    set phone = _clean,
        whatsapp_consent = true,
        whatsapp_consent_at = coalesce(whatsapp_consent_at, now())
    where id = _uid;

    insert into public.reservation_audit_log (action, actor_id, actor_role, details)
    values ('consentimiento_otorgado', _uid, public.current_user_role(),
            jsonb_build_object('telefono_terminacion', right(_clean, 4)));

    return jsonb_build_object('ok', true, 'consentimiento', true, 'telefono', _clean);
  end if;

  -- REQ-23: revocar consentimiento elimina el teléfono y detiene envíos.
  update public.profiles
  set phone = null,
      whatsapp_consent = false,
      whatsapp_consent_at = null
  where id = _uid;

  update public.notification_jobs
  set status = 'cancelado',
      last_error = 'Consentimiento de WhatsApp revocado por el usuario.'
  where user_id = _uid
    and status in ('pendiente', 'error');

  insert into public.reservation_audit_log (action, actor_id, actor_role, details)
  values ('consentimiento_revocado', _uid, public.current_user_role(), '{}'::jsonb);

  return jsonb_build_object('ok', true, 'consentimiento', false, 'telefono', null);
end;
$$;

-- =====================================================================
-- Administración · REQ-28, REQ-29, REQ-30, REQ-31, REQ-32, REQ-33
-- =====================================================================

-- Crea un recinto y lo asigna al administrador que lo creó, de forma atómica.
create or replace function public.admin_create_facility(
  _name text,
  _facility_type text,
  _description text default '',
  _operation_hours text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _facility public.facilities;
begin
  if _uid is null or not public.is_admin(_uid) then
    raise exception 'Sólo un administrador puede crear recintos.' using errcode = '42501';
  end if;

  if length(btrim(coalesce(_name, ''))) < 2 then
    return jsonb_build_object('ok', false, 'error', 'nombre_invalido',
                              'mensaje', 'El nombre del recinto debe tener al menos 2 caracteres.');
  end if;

  if exists (select 1 from public.facilities f where lower(btrim(f.name)) = lower(btrim(_name))) then
    return jsonb_build_object('ok', false, 'error', 'nombre_duplicado',
                              'mensaje', 'Ya existe un recinto con ese nombre.');
  end if;

  insert into public.facilities (name, facility_type, description, operation_hours)
  values (btrim(_name), btrim(_facility_type), coalesce(_description, ''), coalesce(_operation_hours, ''))
  returning * into _facility;

  insert into public.facility_admin_assignments (admin_id, facility_id)
  values (_uid, _facility.id)
  on conflict (admin_id, facility_id) do nothing;

  insert into public.reservation_audit_log (facility_id, action, actor_id, actor_role, details)
  values (_facility.id, 'recinto_creado', _uid, 'administrador',
          jsonb_build_object('nombre', _facility.name, 'tipo', _facility.facility_type));

  return jsonb_build_object('ok', true, 'facility_id', _facility.id, 'mensaje', 'Recinto creado y asignado a tu cuenta.');
end;
$$;

-- Listado de reservas por recinto para administradores asignados.
-- Devuelve el nombre del usuario, nunca su correo ni su teléfono.
create or replace function public.admin_list_reservations(
  _facility_id uuid default null,
  _scope text default 'vigentes',
  _limit integer default 200
)
returns table (
  reservation_id uuid,
  facility_id uuid,
  facility_name text,
  block_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.reservation_status,
  is_past boolean,
  user_display_name text,
  calendar_sync_status public.calendar_sync_status,
  has_calendar_event boolean,
  whatsapp_status text,
  cancelled_by_role public.user_role,
  cancel_reason text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null or not public.is_admin(_uid) then
    raise exception 'Acceso restringido a administradores.' using errcode = '42501';
  end if;

  if _facility_id is not null and not public.is_facility_admin(_uid, _facility_id) then
    raise exception 'No administras ese recinto.' using errcode = '42501';
  end if;

  return query
  select
    r.id,
    r.facility_id,
    f.name,
    r.block_id,
    r.starts_at,
    r.ends_at,
    r.status,
    (r.ends_at < now()),
    p.full_name,
    r.calendar_sync_status,
    (r.calendar_event_id is not null),
    coalesce(
      (select wm.status::text from public.whatsapp_messages wm
       where wm.reservation_id = r.id
       order by wm.created_at desc limit 1),
      'omitido'
    ),
    r.cancelled_by_role,
    r.cancel_reason,
    r.created_at
  from public.reservations r
  join public.facilities f on f.id = r.facility_id
  join public.profiles p on p.id = r.user_id
  join public.facility_admin_assignments faa
    on faa.facility_id = r.facility_id and faa.admin_id = _uid
  where (_facility_id is null or r.facility_id = _facility_id)
    and (
      case _scope
        when 'vigentes'  then r.status = 'vigente' and r.ends_at >= now()
        when 'historial' then r.status = 'cancelada' or r.ends_at < now()
        else true
      end
    )
  order by r.starts_at desc
  limit least(greatest(coalesce(_limit, 200), 1), 500);
end;
$$;

comment on function public.admin_list_reservations(uuid, text, integer) is
  'Monitoreo de reservas por recinto asignado (REQ-31). Expone el nombre del usuario pero nunca su correo ni su teléfono.';

-- Auditoría e incidencias de integración visibles para el administrador.
create or replace function public.admin_integration_report(_limit integer default 100)
returns table (
  kind text,
  reference_id uuid,
  facility_id uuid,
  facility_name text,
  reservation_starts_at timestamptz,
  status text,
  attempts integer,
  last_error text,
  occurred_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null or not public.is_admin(_uid) then
    raise exception 'Acceso restringido a administradores.' using errcode = '42501';
  end if;

  -- El UNION ALL se envuelve en una subconsulta: ORDER BY sobre el
  -- resultado de un UNION sólo admite nombres de columna de salida.
  return query
  select *
  from (
    select
      'google_calendar'::text          as kind,
      j.id                             as reference_id,
      r.facility_id                    as facility_id,
      f.name                           as facility_name,
      r.starts_at                      as reservation_starts_at,
      j.status::text                   as status,
      j.attempts                       as attempts,
      j.last_error                     as last_error,
      j.updated_at                     as occurred_at
    from public.calendar_sync_jobs j
    join public.reservations r on r.id = j.reservation_id
    join public.facilities f on f.id = r.facility_id
    join public.facility_admin_assignments faa
      on faa.facility_id = r.facility_id and faa.admin_id = _uid
    union all
    select
      'whatsapp'::text,
      m.id,
      r.facility_id,
      f.name,
      r.starts_at,
      m.status::text,
      0,
      coalesce(m.error_message, m.skipped_reason),
      m.updated_at
    from public.whatsapp_messages m
    join public.reservations r on r.id = m.reservation_id
    join public.facilities f on f.id = r.facility_id
    join public.facility_admin_assignments faa
      on faa.facility_id = r.facility_id and faa.admin_id = _uid
  ) informe
  order by informe.occurred_at desc
  limit least(greatest(coalesce(_limit, 100), 1), 500);
end;
$$;

-- =====================================================================
-- Colas de integración · reservadas a service_role (Edge Functions)
-- =====================================================================

-- Reclama trabajos de Calendar listos para ejecutar.
-- FOR UPDATE SKIP LOCKED permite varios workers en paralelo sin colisión.
create or replace function public.claim_calendar_jobs(_limit integer default 10)
returns setof public.calendar_sync_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Libera trabajos cuyo worker murió a mitad de camino (interrupción).
  update public.calendar_sync_jobs
  set status = 'pendiente', locked_at = null
  where status = 'procesando' and locked_at < now() - interval '10 minutes';

  return query
  with ready as (
    select j.id
    from public.calendar_sync_jobs j
    where j.status in ('pendiente', 'error')
      and j.attempts < j.max_attempts
      and j.next_attempt_at <= now()
    order by j.next_attempt_at asc
    limit least(greatest(coalesce(_limit, 10), 1), 100)
    for update skip locked
  )
  update public.calendar_sync_jobs j
  set status = 'procesando',
      attempts = j.attempts + 1,
      locked_at = now()
  from ready
  where j.id = ready.id
  returning j.*;
end;
$$;

create or replace function public.complete_calendar_job(
  _job_id uuid,
  _event_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _job public.calendar_sync_jobs;
begin
  update public.calendar_sync_jobs
  set status = 'completado', completed_at = now(), locked_at = null, last_error = null
  where id = _job_id
  returning * into _job;

  if not found then
    return;
  end if;

  if _job.kind = 'crear_evento' then
    update public.reservations
    set calendar_sync_status = 'sincronizado',
        calendar_event_id = coalesce(_event_id, calendar_event_id)
    where id = _job.reservation_id;

    insert into public.reservation_audit_log
      (reservation_id, action, actor_id, details)
    select _job.reservation_id, 'calendar_evento_creado', null,
           jsonb_build_object('intentos', _job.attempts)
    ;
  else
    update public.reservations
    set calendar_sync_status = 'sincronizado',
        calendar_event_id = null
    where id = _job.reservation_id;

    insert into public.reservation_audit_log
      (reservation_id, action, actor_id, details)
    select _job.reservation_id, 'calendar_evento_eliminado', null,
           jsonb_build_object('intentos', _job.attempts)
    ;
  end if;
end;
$$;

-- Reintentos con backoff exponencial y tope de intentos.
create or replace function public.fail_calendar_job(
  _job_id uuid,
  _error text,
  _retryable boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _job public.calendar_sync_jobs;
  _exhausted boolean;
begin
  select * into _job from public.calendar_sync_jobs where id = _job_id;
  if not found then
    return;
  end if;

  _exhausted := (not _retryable) or (_job.attempts >= _job.max_attempts);

  update public.calendar_sync_jobs
  set status = 'error',
      locked_at = null,
      last_error = left(coalesce(_error, 'error desconocido'), 500),
      -- backoff: 30s, 60s, 120s, 240s, ...
      next_attempt_at = case
        when _exhausted then next_attempt_at
        else now() + (interval '30 seconds' * power(2, least(_job.attempts, 6)))
      end,
      attempts = case when _exhausted then _job.max_attempts else _job.attempts end
  where id = _job_id;

  if _exhausted then
    update public.reservations
    set calendar_sync_status = 'error'
    where id = _job.reservation_id;

    insert into public.reservation_audit_log
      (reservation_id, action, actor_id, details)
    values (_job.reservation_id, 'calendar_error', null,
            jsonb_build_object('intentos', _job.attempts,
                               'detalle', left(coalesce(_error, ''), 300)));
  end if;
end;
$$;

-- Reclama notificaciones cuyo scheduled_for ya venció.
-- Excluye reservas canceladas y usuarios sin consentimiento vigente.
create or replace function public.claim_notification_jobs(_limit integer default 10)
returns table (
  job_id uuid,
  reservation_id uuid,
  user_id uuid,
  kind public.notification_kind,
  attempts integer,
  max_attempts integer,
  payload jsonb,
  to_phone text,
  full_name text,
  facility_name text,
  starts_at timestamptz,
  ends_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notification_jobs
  set status = 'pendiente', locked_at = null
  where status = 'procesando' and locked_at < now() - interval '10 minutes';

  -- No enviar notificaciones de reservas canceladas.
  update public.notification_jobs nj
  set status = 'cancelado',
      last_error = 'Reserva cancelada: notificación descartada.'
  where nj.status in ('pendiente', 'error')
    and exists (
      select 1 from public.reservations r
      where r.id = nj.reservation_id
        and r.status = 'cancelada'
        and nj.kind in ('confirmacion', 'recordatorio')
    );

  return query
  with ready as (
    select j.id
    from public.notification_jobs j
    join public.profiles p on p.id = j.user_id
    where j.status in ('pendiente', 'error')
      and j.attempts < j.max_attempts
      and j.scheduled_for <= now()
      and j.next_attempt_at <= now()
      and p.whatsapp_consent              -- consentimiento vigente
      and p.phone is not null             -- número válido registrado
    order by j.scheduled_for asc
    limit least(greatest(coalesce(_limit, 10), 1), 100)
    for update skip locked
  ),
  claimed as (
    update public.notification_jobs j
    set status = 'procesando',
        attempts = j.attempts + 1,
        locked_at = now()
    from ready
    where j.id = ready.id
    returning j.*
  )
  select
    c.id, c.reservation_id, c.user_id, c.kind, c.attempts, c.max_attempts, c.payload,
    p.phone, p.full_name, f.name, r.starts_at, r.ends_at
  from claimed c
  join public.profiles p on p.id = c.user_id
  left join public.reservations r on r.id = c.reservation_id
  left join public.facilities f on f.id = r.facility_id;
end;
$$;

create or replace function public.complete_notification_job(
  _job_id uuid,
  _provider_sid text,
  _to_phone text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _job public.notification_jobs;
begin
  update public.notification_jobs
  set status = 'completado', completed_at = now(), locked_at = null, last_error = null
  where id = _job_id
  returning * into _job;

  if not found then
    return;
  end if;

  insert into public.whatsapp_messages
    (notification_job_id, reservation_id, user_id, kind, to_phone, status,
     provider_message_sid, sent_at, template_vars)
  values
    (_job.id, _job.reservation_id, _job.user_id, _job.kind, _to_phone, 'enviado',
     _provider_sid, now(), _job.payload)
  on conflict (provider_message_sid) do update
    set status = 'enviado', sent_at = now();

  insert into public.reservation_audit_log
    (reservation_id, action, actor_id, details)
  values (_job.reservation_id, 'whatsapp_enviado', null,
          jsonb_build_object('tipo', _job.kind, 'telefono_terminacion', right(_to_phone, 4)));
end;
$$;

create or replace function public.fail_notification_job(
  _job_id uuid,
  _error text,
  _error_code text default null,
  _retryable boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _job public.notification_jobs;
  _exhausted boolean;
begin
  select * into _job from public.notification_jobs where id = _job_id;
  if not found then
    return;
  end if;

  _exhausted := (not _retryable) or (_job.attempts >= _job.max_attempts);

  -- Un trabajo agotado se distingue por attempts = max_attempts, que es
  -- lo que mira claim_notification_jobs para no volver a entregarlo.
  update public.notification_jobs
  set status = 'error',
      locked_at = null,
      last_error = left(coalesce(_error, 'error desconocido'), 500),
      next_attempt_at = case
        when _exhausted then next_attempt_at
        else now() + (interval '60 seconds' * power(2, least(_job.attempts, 5)))
      end,
      attempts = case when _exhausted then _job.max_attempts else _job.attempts end
  where id = _job_id;

  if _exhausted then
    -- to_phone puede quedar nulo si el usuario revocó su consentimiento
    -- entre el intento de envío y el registro del fallo.
    insert into public.whatsapp_messages
      (notification_job_id, reservation_id, user_id, kind, to_phone, status,
       error_code, error_message, template_vars)
    select _job.id, _job.reservation_id, _job.user_id, _job.kind,
           p.phone, 'fallido',
           _error_code, left(coalesce(_error, ''), 300), _job.payload
    from public.profiles p where p.id = _job.user_id;

    insert into public.reservation_audit_log
      (reservation_id, action, actor_id, details)
    values (_job.reservation_id, 'whatsapp_fallido', null,
            jsonb_build_object('tipo', _job.kind, 'intentos', _job.attempts,
                               'codigo', _error_code));
  end if;
end;
$$;

-- Marca un trabajo como omitido sin consumir reintentos (sin consentimiento).
create or replace function public.skip_notification_job(_job_id uuid, _reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _job public.notification_jobs;
begin
  update public.notification_jobs
  set status = 'cancelado', locked_at = null, last_error = left(coalesce(_reason, ''), 300)
  where id = _job_id
  returning * into _job;

  if not found then
    return;
  end if;

  insert into public.reservation_audit_log
    (reservation_id, action, actor_id, details)
  values (_job.reservation_id, 'whatsapp_omitido', null,
          jsonb_build_object('tipo', _job.kind, 'motivo', left(coalesce(_reason, ''), 200)));
end;
$$;

-- Registro idempotente de webhooks entrantes.
-- Devuelve true sólo la primera vez que llega ese evento (anti-replay).
create or replace function public.register_webhook_event(
  _provider text,
  _external_id text,
  _event_type text,
  _signature_valid boolean,
  _payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _inserted uuid;
begin
  insert into public.webhook_events
    (provider, external_id, event_type, signature_valid, payload, processed_at)
  values (_provider, _external_id, _event_type, _signature_valid, coalesce(_payload, '{}'::jsonb), now())
  on conflict (provider, external_id, event_type) do nothing
  returning id into _inserted;

  return _inserted is not null;
end;
$$;

-- Actualiza el estado de un mensaje desde el webhook de Twilio (REQ-27).
create or replace function public.apply_whatsapp_status(
  _provider_sid text,
  _status text,
  _error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _mapped public.message_status;
  _updated integer;
begin
  _mapped := case lower(coalesce(_status, ''))
    when 'queued'      then 'pendiente'
    when 'accepted'    then 'pendiente'
    when 'scheduled'   then 'pendiente'
    when 'sending'     then 'pendiente'
    when 'sent'        then 'enviado'
    when 'delivered'   then 'entregado'
    when 'read'        then 'entregado'
    when 'undelivered' then 'fallido'
    when 'failed'      then 'fallido'
    else null
  end;

  if _mapped is null then
    return false;
  end if;

  update public.whatsapp_messages
  set status = _mapped,
      error_code = coalesce(_error_code, error_code),
      delivered_at = case when _mapped = 'entregado' then now() else delivered_at end
  where provider_message_sid = _provider_sid
    -- no retroceder de "entregado" a un estado anterior
    and (status <> 'entregado' or _mapped = 'entregado');

  get diagnostics _updated = row_count;
  return _updated > 0;
end;
$$;

-- =====================================================================
-- Permisos de ejecución
-- ---------------------------------------------------------------------
-- Por defecto Postgres concede EXECUTE a PUBLIC en funciones nuevas, así
-- que se revoca explícitamente y se concede sólo a quien corresponde.
-- =====================================================================
revoke all on function public.claim_calendar_jobs(integer)                      from public, anon, authenticated;
revoke all on function public.complete_calendar_job(uuid, text)                 from public, anon, authenticated;
revoke all on function public.fail_calendar_job(uuid, text, boolean)            from public, anon, authenticated;
revoke all on function public.claim_notification_jobs(integer)                  from public, anon, authenticated;
revoke all on function public.complete_notification_job(uuid, text, text)       from public, anon, authenticated;
revoke all on function public.fail_notification_job(uuid, text, text, boolean)  from public, anon, authenticated;
revoke all on function public.skip_notification_job(uuid, text)                 from public, anon, authenticated;
revoke all on function public.register_webhook_event(text, text, text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.apply_whatsapp_status(text, text, text)           from public, anon, authenticated;
revoke all on function public.consume_rate_limit(text, text, integer, interval) from public, anon, authenticated;

grant execute on function public.claim_calendar_jobs(integer)                      to service_role;
grant execute on function public.complete_calendar_job(uuid, text)                 to service_role;
grant execute on function public.fail_calendar_job(uuid, text, boolean)            to service_role;
grant execute on function public.claim_notification_jobs(integer)                  to service_role;
grant execute on function public.complete_notification_job(uuid, text, text)       to service_role;
grant execute on function public.fail_notification_job(uuid, text, text, boolean)  to service_role;
grant execute on function public.skip_notification_job(uuid, text)                 to service_role;
grant execute on function public.register_webhook_event(text, text, text, boolean, jsonb) to service_role;
grant execute on function public.apply_whatsapp_status(text, text, text)           to service_role;
grant execute on function public.consume_rate_limit(text, text, integer, interval) to service_role;

-- Funciones de usuario final.
-- IMPORTANTE: PostgreSQL concede EXECUTE a PUBLIC en cada función nueva,
-- y anon hereda ese privilegio. Revocar sólo "from anon" no sirve de
-- nada: hay que revocar primero "from public" y después conceder de
-- forma explícita a authenticated.
revoke all on function public.create_reservation_strict(uuid, text) from public, anon;
revoke all on function public.cancel_reservation(uuid, text)        from public, anon;
revoke all on function public.set_whatsapp_consent(text, boolean)   from public, anon;
revoke all on function public.admin_create_facility(text, text, text, text) from public, anon;
revoke all on function public.admin_list_reservations(uuid, text, integer)  from public, anon;
revoke all on function public.admin_integration_report(integer)     from public, anon;
revoke all on function public.is_facility_admin(uuid, uuid)         from public, anon;
revoke all on function public.current_user_role()                   from public, anon;
revoke all on function public.is_admin(uuid)                        from public, anon;

grant execute on function public.create_reservation_strict(uuid, text)  to authenticated;
grant execute on function public.cancel_reservation(uuid, text)         to authenticated;
grant execute on function public.set_whatsapp_consent(text, boolean)    to authenticated;
grant execute on function public.admin_create_facility(text, text, text, text) to authenticated;
grant execute on function public.admin_list_reservations(uuid, text, integer)  to authenticated;
grant execute on function public.admin_integration_report(integer)      to authenticated;
grant execute on function public.is_facility_admin(uuid, uuid)          to authenticated;
grant execute on function public.current_user_role()                    to authenticated;

-- is_admin / is_facility_admin se usan dentro de políticas RLS, que se
-- evalúan con los privilegios del propietario de la política, así que no
-- necesitan estar expuestas a anon.
grant execute on function public.is_admin(uuid) to authenticated;

-- Funciones de disparador: sólo las invoca el motor, nunca un cliente.
-- (prevent_profile_privilege_escalation se revoca en la migración 03,
--  donde se crea.)
revoke all on function public.set_updated_at()  from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Vistas
grant select on public.block_availability to anon, authenticated;
grant select on public.my_reservations to authenticated;

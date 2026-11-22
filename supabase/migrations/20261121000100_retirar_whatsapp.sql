-- =====================================================================
-- ActivaUC · retirar el canal de WhatsApp
-- ---------------------------------------------------------------------
-- El canal de WhatsApp sale del producto: las notificaciones pasan a ser
-- sólo por correo.
--
-- Lo que esta migración NO hace, a propósito:
--
--   · **No borra el historial.** `whatsapp_messages` era el registro de
--     trazabilidad que pide REQ-27, y tiene filas de envíos reales. Se
--     conserva entero: pasa a llamarse `notification_messages`, que es
--     lo que siempre fue —registraba los dos canales desde la migración
--     del canal de correo— y ahora el nombre lo dice.
--
--   · **No prohíbe el canal con una restricción validada.** Una
--     `CHECK (channel = 'email')` normal se comprueba contra las filas
--     existentes y fallaría por las históricas. Se añade `NOT VALID`,
--     que es exactamente la herramienta para esto: rige para lo nuevo y
--     deja en paz lo viejo.
--
--   · **No borra las acciones whatsapp_* de la bitácora.** Siguen
--     permitidas porque hay filas con esos valores; las nuevas usan
--     nombres neutros (notificacion_enviada, _fallida, _omitida).
--
-- Lo que sí desaparece: el consentimiento de WhatsApp en `profiles`
-- —esa columna afirmaba una capacidad que ya no existe—, la función que
-- lo fijaba, y la que aplicaba los estados del webhook de Twilio. El
-- teléfono se queda: lo pide REQ-7, que es independiente del canal.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · La tabla de trazabilidad, con su nombre de verdad
-- ---------------------------------------------------------------------
alter table public.whatsapp_messages rename to notification_messages;

alter index if exists public.whatsapp_messages_reservation_idx
  rename to notification_messages_reservation_idx;
alter index if exists public.whatsapp_messages_user_idx
  rename to notification_messages_user_idx;
alter index if exists public.whatsapp_messages_status_idx
  rename to notification_messages_status_idx;
alter index if exists public.whatsapp_messages_channel_idx
  rename to notification_messages_channel_idx;
alter index if exists public.whatsapp_messages_sin_descartar_idx
  rename to notification_messages_sin_descartar_idx;

alter table public.notification_messages
  rename constraint whatsapp_messages_channel_check to notification_messages_channel_check;
alter table public.notification_messages
  rename constraint whatsapp_messages_destino_del_canal to notification_messages_destino_del_canal;
alter table public.notification_messages
  rename constraint whatsapp_messages_to_phone_check to notification_messages_to_phone_check;

alter policy whatsapp_messages_select_own on public.notification_messages
  rename to notification_messages_select_own;

alter trigger whatsapp_messages_set_updated_at on public.notification_messages
  rename to notification_messages_set_updated_at;

comment on table public.notification_messages is
  'REQ-27 · trazabilidad de cada notificación enviada. Conserva las filas del canal de WhatsApp, retirado del producto: el registro de un envío no se borra porque el canal deje de usarse.';

-- ---------------------------------------------------------------------
-- 2 · De aquí en adelante, sólo correo
-- ---------------------------------------------------------------------
alter table public.notification_messages
  drop constraint if exists notification_messages_solo_correo;
alter table public.notification_messages
  add constraint notification_messages_solo_correo
  check (channel = 'email') not valid;

alter table public.notification_jobs
  drop constraint if exists notification_jobs_solo_correo;
alter table public.notification_jobs
  add constraint notification_jobs_solo_correo
  check (channel = 'email') not valid;

-- ---------------------------------------------------------------------
-- 3 · El consentimiento de un canal que ya no existe
-- ---------------------------------------------------------------------
-- Al soltar la columna se van con ella sus privilegios y la restricción
-- que ataba el consentimiento al teléfono.
alter table public.profiles drop column if exists whatsapp_consent;
alter table public.profiles drop column if exists whatsapp_consent_at;

-- ---------------------------------------------------------------------
-- 4 · Acciones de la bitácora
-- ---------------------------------------------------------------------
do $$
declare
  _nombre text;
begin
  for _nombre in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.reservation_audit_log'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%reserva_creada%'
  loop
    execute format('alter table public.reservation_audit_log drop constraint %I', _nombre);
  end loop;
end;
$$;

alter table public.reservation_audit_log
  add constraint reservation_audit_log_action_check check (action in (
    'reserva_creada',
    'reserva_cancelada_usuario',
    'reserva_cancelada_admin',
    'calendar_evento_creado',
    'calendar_evento_eliminado',
    'calendar_error',
    'calendar_conectado',
    'calendar_desconectado',
    'notificacion_enviada',
    'notificacion_fallida',
    'notificacion_omitida',
    'whatsapp_enviado',
    'whatsapp_fallido',
    'whatsapp_omitido',
    'consentimiento_otorgado',
    'consentimiento_revocado',
    'recinto_creado',
    'recinto_actualizado',
    'recinto_desactivado',
    'bloque_creado',
    'bloque_actualizado',
    'bloque_desactivado',
    'administrador_asignado',
    'administrador_retirado',
    'incidencia_descartada'
  ));

-- ---------------------------------------------------------------------
-- 5 · Funciones que se van
-- ---------------------------------------------------------------------
drop function if exists public.apply_whatsapp_status(text, text, text);
drop function if exists public.set_whatsapp_consent(text, boolean);

-- ---------------------------------------------------------------------
-- 6 · Funciones cuya firma cambia
-- ---------------------------------------------------------------------
-- No se pueden reemplazar en sitio: `claim_notification_jobs` deja de
-- devolver el teléfono, `complete_notification_job` renombra su tercer
-- parámetro y `admin_list_reservations` renombra una columna de salida.
-- Al recrearlas se pierden los privilegios, que se vuelven a dar al
-- final.
drop function if exists public.claim_notification_jobs(integer);
drop function if exists public.complete_notification_job(uuid, text, text);
drop function if exists public.admin_list_reservations(uuid, text, integer);

-- ---------------------------------------------------------------------
-- 7 · Las funciones, sin el canal
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.avisar_cupo_liberado()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _bloque record;
  _espera record;
  _canales text[];
begin
  for _bloque in
    select distinct b.id, b.starts_at, b.max_capacity
    from nuevas n
    join public.time_blocks b on b.id = n.block_id
    where n.status = 'cancelada'
      and b.starts_at > now()
      and b.active
  loop
    -- Sólo si de verdad quedó cupo: dos cancelaciones simultáneas no
    -- deben avisar dos veces por el mismo hueco inexistente.
    if (
      select _bloque.max_capacity - count(*)
      from public.reservations r
      where r.block_id = _bloque.id and r.status = 'vigente'
    ) <= 0 then
      continue;
    end if;

    for _espera in
      select w.id, w.user_id
      from public.block_watchers w
      where w.block_id = _bloque.id
        and w.notified_at is null
        -- Quien ya reservó ese bloque no necesita el aviso.
        and not exists (
          select 1 from public.reservations r
          where r.block_id = _bloque.id
            and r.user_id = w.user_id
            and r.status = 'vigente'
        )
      order by w.created_at
    loop
      select
        case when p.email_consent then array['email'] else '{}' end
      into _canales
      from public.profiles p where p.id = _espera.user_id;

      -- La solicitud se marca avisada aunque no haya canal consentido:
      -- de lo contrario quedaría pendiente para siempre, acumulando
      -- intentos cada vez que alguien cancela.
      update public.block_watchers set notified_at = now() where id = _espera.id;

      if coalesce(array_length(_canales, 1), 0) = 0 then
        continue;
      end if;

      insert into public.notification_jobs
        (reservation_id, block_id, user_id, kind, channel, idempotency_key,
         scheduled_for, next_attempt_at, payload)
      select
        null,
        _bloque.id,
        _espera.user_id,
        'cupo_liberado'::public.notification_kind,
        canal,
        -- La clave lleva el id de la solicitud, que es único por
        -- petición: si la persona vuelve a pedir aviso del mismo bloque
        -- más adelante, no choca con el anterior.
        'em:cupo:' || _espera.id::text,
        now(), now(),
        jsonb_build_object('block_id', _bloque.id)
      from unnest(_canales) canal
      on conflict (idempotency_key) do nothing;
    end loop;
  end loop;

  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.encolar_notificacion(_reservation_id uuid, _user_id uuid, _kind notification_kind, _sufijo text, _cuando timestamp with time zone, _payload jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _canales text[] := '{}';
  _canal text;
begin
  select
    case when p.email_consent then array['email'] else '{}' end
  into _canales
  from public.profiles p
  where p.id = _user_id;

  foreach _canal in array coalesce(_canales, '{}')
  loop
    insert into public.notification_jobs
      (reservation_id, user_id, kind, channel, idempotency_key,
       scheduled_for, next_attempt_at, payload)
    values (
      _reservation_id, _user_id, _kind, _canal,
      -- 'em' es el prefijo que ya usan las filas encoladas antes,
      -- y cambiarlo haría que un mismo aviso se pudiera encolar dos
      -- veces.
      'em:' || _sufijo || ':' || _reservation_id::text,
      _cuando, _cuando, _payload
    )
    on conflict (idempotency_key) do nothing;
  end loop;

  return coalesce(_canales, '{}');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_descartar_incidencia(_tipo text, _id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _uid uuid := auth.uid();
  _facility uuid;
  _estado text;
begin
  if _uid is null then
    return jsonb_build_object('ok', false, 'codigo', 'sin_sesion',
                              'mensaje', 'Debes iniciar sesión.');
  end if;

  if not public.is_admin(_uid) then
    return jsonb_build_object('ok', false, 'codigo', 'no_autorizado',
                              'mensaje', 'Acceso restringido a administradores.');
  end if;

  if _tipo not in ('notificacion', 'google_calendar') then
    return jsonb_build_object('ok', false, 'codigo', 'tipo_desconocido',
                              'mensaje', 'Tipo de incidencia desconocido.');
  end if;

  if _tipo = 'notificacion' then
    select r.facility_id, m.status::text
      into _facility, _estado
      from public.notification_messages m
      join public.reservations r on r.id = m.reservation_id
     where m.id = _id;
  else
    select r.facility_id, j.status::text
      into _facility, _estado
      from public.calendar_sync_jobs j
      join public.reservations r on r.id = j.reservation_id
     where j.id = _id;
  end if;

  if _facility is null then
    return jsonb_build_object('ok', false, 'codigo', 'no_encontrada',
                              'mensaje', 'No encontramos esa incidencia.');
  end if;

  if not public.is_facility_admin(_uid, _facility) then
    return jsonb_build_object('ok', false, 'codigo', 'no_autorizado',
                              'mensaje', 'No administras el recinto de esa incidencia.');
  end if;

  -- 'fallido' es el estado de error de los mensajes; 'error' el de las
  -- colas. Cualquier otro no es una incidencia.
  if _estado not in ('fallido', 'error') then
    return jsonb_build_object(
      'ok', false,
      'codigo', 'no_es_incidencia',
      'mensaje', 'Sólo se descartan las integraciones en error.'
    );
  end if;

  if _tipo = 'notificacion' then
    update public.notification_messages
       set dismissed_at = now(), dismissed_by = _uid
     where id = _id and dismissed_at is null;
  else
    update public.calendar_sync_jobs
       set dismissed_at = now(), dismissed_by = _uid
     where id = _id and dismissed_at is null;
  end if;

  if not found then
    return jsonb_build_object('ok', false, 'codigo', 'ya_descartada',
                              'mensaje', 'Esa incidencia ya estaba descartada.');
  end if;

  insert into public.reservation_audit_log (facility_id, action, actor_id, details)
  values (_facility, 'incidencia_descartada', _uid,
          jsonb_build_object('tipo', _tipo, 'incidencia', _id, 'estado', _estado));

  return jsonb_build_object('ok', true, 'codigo', 'descartada',
                            'mensaje', 'Incidencia descartada. La reserva no cambia.');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_integration_report(_limit integer DEFAULT 100)
 RETURNS TABLE(kind text, reference_id uuid, facility_id uuid, facility_name text, reservation_starts_at timestamp with time zone, status text, attempts integer, last_error text, occurred_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    where public.is_facility_admin(_uid, r.facility_id)
      and j.dismissed_at is null
    union all
    select
      'notificacion'::text,
      m.id,
      r.facility_id,
      f.name,
      r.starts_at,
      m.status::text,
      0,
      coalesce(m.error_message, m.skipped_reason),
      m.updated_at
    from public.notification_messages m
    join public.reservations r on r.id = m.reservation_id
    join public.facilities f on f.id = r.facility_id
    where public.is_facility_admin(_uid, r.facility_id)
      and m.dismissed_at is null
  ) informe
  order by informe.occurred_at desc
  limit least(greatest(coalesce(_limit, 100), 1), 500);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_list_reservations(_facility_id uuid DEFAULT NULL::uuid, _scope text DEFAULT 'vigentes'::text, _limit integer DEFAULT 200)
 RETURNS TABLE(reservation_id uuid, facility_id uuid, facility_name text, block_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, status reservation_status, is_past boolean, user_display_name text, calendar_sync_status calendar_sync_status, has_calendar_event boolean, notification_status text, cancelled_by_role user_role, cancel_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      (select wm.status::text from public.notification_messages wm
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
  where public.is_facility_admin(_uid, r.facility_id)
    and (_facility_id is null or r.facility_id = _facility_id)
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
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_reservation(_reservation_id uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _uid          uuid := auth.uid();
  _res          public.reservations;
  _is_owner     boolean;
  _is_admin     boolean;
  _actor_role   public.user_role;
  _action       text;
  _consent      boolean := false;
  _canales      text[] := '{}';
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
    select p.email_consent into _consent
    from public.profiles p where p.id = _res.user_id;

    _canales := private.encolar_notificacion(
      _res.id, _res.user_id, 'cancelacion_admin', 'admincancel', now(),
      jsonb_build_object('reservation_id', _res.id,
                         'motivo', nullif(btrim(coalesce(_reason, '')), ''))
    );
    _consent := array_length(_canales, 1) > 0;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reservation_id', _res.id,
    'estado', 'cancelada',
    'cancelado_por', _actor_role,
    'calendar_sync_status', _calendar_next,
    'notificacion_encolada', (_notify and not _is_owner and coalesce(_consent, false)),
    'mensaje', 'Reserva cancelada. El cupo quedó disponible para otras personas.'
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_notification_jobs(_limit integer DEFAULT 10)
 RETURNS TABLE(job_id uuid, reservation_id uuid, block_id uuid, user_id uuid, kind notification_kind, channel text, attempts integer, max_attempts integer, payload jsonb, to_email text, full_name text, facility_name text, starts_at timestamp with time zone, ends_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.notification_jobs
  set status = 'pendiente', locked_at = null
  where status = 'procesando' and locked_at < now() - interval '10 minutes';

  -- No enviar notificaciones de reservas canceladas. No afecta a los
  -- avisos de cupo, que no tienen reserva asociada.
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

  -- Un aviso de cupo cuyo bloque ya empezó no sirve de nada.
  update public.notification_jobs nj
  set status = 'cancelado',
      last_error = 'El bloque ya comenzó: aviso descartado.'
  where nj.status in ('pendiente', 'error')
    and nj.block_id is not null
    and exists (
      select 1 from public.time_blocks b
      where b.id = nj.block_id and b.starts_at <= now()
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
      and j.channel = 'email'
      and p.email_consent
      and exists (
        select 1 from auth.users u
        where u.id = j.user_id and u.email is not null
      )
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
    c.id, c.reservation_id, c.block_id, c.user_id, c.kind, c.channel,
    c.attempts, c.max_attempts, c.payload,
    u.email::text,
    p.full_name,
    -- Recinto y horario salen de la reserva cuando existe, y del bloque
    -- cuando el aviso no tiene reserva.
    coalesce(fr.name, fb.name),
    coalesce(r.starts_at, b.starts_at),
    coalesce(r.ends_at, b.ends_at)
  from claimed c
  join public.profiles p on p.id = c.user_id
  left join auth.users u on u.id = c.user_id
  left join public.reservations r on r.id = c.reservation_id
  left join public.facilities fr on fr.id = r.facility_id
  left join public.time_blocks b on b.id = c.block_id
  left join public.facilities fb on fb.id = b.facility_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.complete_notification_job(_job_id uuid, _provider_sid text, _destino text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  insert into public.notification_messages
    (notification_job_id, reservation_id, user_id, kind, channel,
     to_phone, to_email, status, provider_message_sid, sent_at, template_vars)
  values
    (_job.id, _job.reservation_id, _job.user_id, _job.kind, _job.channel,
     null::text,
     _destino,
     'enviado', _provider_sid, now(), _job.payload)
  on conflict (provider_message_sid) do update
    set status = 'enviado', sent_at = now();

  insert into public.reservation_audit_log
    (reservation_id, action, actor_id, details)
  values (_job.reservation_id, 'notificacion_enviada', null,
          jsonb_build_object(
            'tipo', _job.kind,
            'canal', _job.channel,
            -- Del correo se guarda sólo el dominio: basta para
            -- diagnosticar entregas y no deja la dirección en la
            -- bitácora, que es legible por los administradores.
            'destino', case
              when _job.channel = 'email'
                then '@' || split_part(coalesce(_destino, ''), '@', 2)
              else right(coalesce(_destino, ''), 4)
            end
          ));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_reservation_strict(_block_id uuid, _client_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _uid              uuid := auth.uid();
  _block            public.time_blocks;
  _facility_active  boolean;
  _active_count     integer;
  _existing         public.reservations;
  _reservation      public.reservations;
  _has_calendar     boolean := false;
  _consent          boolean := false;
  _canales          text[] := '{}';
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

  select p.email_consent into _consent
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

  -- REQ-24: confirmación inmediata, por cada canal consentido.
  _canales := private.encolar_notificacion(
    _reservation.id, _uid, 'confirmacion', 'confirm', now(),
    jsonb_build_object('reservation_id', _reservation.id)
  );

  if array_length(_canales, 1) > 0 then
    _confirm_state := 'pendiente';

    -- REQ-25: recordatorio sólo si la reserva se crea con >= 2 horas de
    -- anticipación. Con menos de 2 horas se omite por completo.
    _reminder_at := _block.starts_at - interval '2 hours';
    if _reminder_at > now() then
      perform private.encolar_notificacion(
        _reservation.id, _uid, 'recordatorio', 'remind', _reminder_at,
        jsonb_build_object('reservation_id', _reservation.id)
      );
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
    'notificacion_confirmacion', _confirm_state,
    'canales', to_jsonb(_canales),
    'notificacion_recordatorio', _reminder_state,
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
$function$
;

CREATE OR REPLACE FUNCTION public.fail_notification_job(_job_id uuid, _error text, _error_code text DEFAULT NULL::text, _retryable boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    insert into public.notification_messages
      (notification_job_id, reservation_id, user_id, kind, channel,
       to_phone, to_email, status, error_code, error_message, template_vars)
    select _job.id, _job.reservation_id, _job.user_id, _job.kind, _job.channel,
           null::text,
           u.email::text,
           'fallido',
           _error_code, left(coalesce(_error, ''), 300), _job.payload
    from public.profiles p
    left join auth.users u on u.id = p.id
    where p.id = _job.user_id;

    insert into public.reservation_audit_log
      (reservation_id, action, actor_id, details)
    values (_job.reservation_id, 'notificacion_fallida', null,
            jsonb_build_object('tipo', _job.kind, 'canal', _job.channel,
                               'intentos', _job.attempts,
                               'codigo', _error_code));
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.skip_notification_job(_job_id uuid, _reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  values (_job.reservation_id, 'notificacion_omitida', null,
          jsonb_build_object('tipo', _job.kind, 'motivo', left(coalesce(_reason, ''), 200)));
end;
$function$
;

-- ---------------------------------------------------------------------
-- 8 · Privilegios de las funciones recreadas
-- ---------------------------------------------------------------------
revoke all on function public.claim_notification_jobs(integer) from public, anon, authenticated;
revoke all on function public.complete_notification_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_notification_jobs(integer) to service_role;
grant execute on function public.complete_notification_job(uuid, text, text) to service_role;

revoke all on function public.admin_list_reservations(uuid, text, integer) from public, anon;
grant execute on function public.admin_list_reservations(uuid, text, integer)
  to authenticated, service_role;

comment on function public.claim_notification_jobs(integer) is
  'Reclama trabajos de notificación por correo con FOR UPDATE SKIP LOCKED. Exige el consentimiento de correo vigente en el momento del reclamo.';
comment on function public.complete_notification_job(uuid, text, text) is
  'REQ-27 · registra el envío en notification_messages y en la bitácora.';
comment on function public.admin_list_reservations(uuid, text, integer) is
  'Monitoreo de reservas por recinto administrado (REQ-31). Expone el nombre de quien reservó, nunca su correo ni su teléfono.';

-- ---------------------------------------------------------------------
-- 9 · La vista de «Mis reservas»
-- ---------------------------------------------------------------------
-- Dos de sus columnas llevaban el nombre del canal. Una vista no puede
-- renombrar columnas con CREATE OR REPLACE, así que se recrea; por eso
-- se repiten aquí la opción `security_invoker` —sin ella la vista
-- dejaría de aplicar RLS y cada persona vería las reservas de todas— y
-- el privilegio de lectura.
drop view if exists public.my_reservations;

create view public.my_reservations
with (security_invoker = true) as
  select
    r.id,
    r.user_id,
    r.facility_id,
    f.name as facility_name,
    f.facility_type,
    r.block_id,
    r.starts_at,
    r.ends_at,
    r.status,
    r.status = 'vigente'::public.reservation_status and r.ends_at < now() as is_past,
    r.calendar_sync_status,
    r.calendar_event_id is not null as has_calendar_event,
    r.cancelled_at,
    r.cancelled_by_role,
    r.cancel_reason,
    r.created_at,
    coalesce(
      (select nm.status::text
         from public.notification_messages nm
        where nm.reservation_id = r.id
          and nm.kind = 'confirmacion'::public.notification_kind
        order by nm.created_at desc
        limit 1),
      case when exists (
        select 1 from public.notification_jobs nj
         where nj.reservation_id = r.id
           and nj.kind = 'confirmacion'::public.notification_kind
           and nj.status = any (array['pendiente'::public.job_status,
                                      'procesando'::public.job_status,
                                      'error'::public.job_status])
      ) then 'pendiente' else 'omitido' end
    ) as notification_confirmation_status,
    coalesce(
      (select nm.status::text
         from public.notification_messages nm
        where nm.reservation_id = r.id
          and nm.kind = 'recordatorio'::public.notification_kind
        order by nm.created_at desc
        limit 1),
      case when exists (
        select 1 from public.notification_jobs nj
         where nj.reservation_id = r.id
           and nj.kind = 'recordatorio'::public.notification_kind
           and nj.status = any (array['pendiente'::public.job_status,
                                      'procesando'::public.job_status,
                                      'error'::public.job_status])
      ) then 'pendiente' else 'omitido' end
    ) as notification_reminder_status
  from public.reservations r
  join public.facilities f on f.id = r.facility_id;

grant select on public.my_reservations to authenticated;

comment on view public.my_reservations is
  'REQ-14 · reservas de quien consulta, con el estado de sus integraciones. security_invoker: la vista aplica las políticas RLS de quien la consulta, no las del dueño.';

-- ---------------------------------------------------------------------
-- 10 · El teléfono sigue siendo editable (REQ-7)
-- ---------------------------------------------------------------------
-- Hasta ahora el teléfono se escribía dentro de `set_whatsapp_consent`,
-- que acaba de desaparecer con el canal. El dato en sí lo pide REQ-7
-- —ver y actualizar nombre y teléfono—, así que pasa a actualizarse como
-- el nombre: privilegio por columna sobre la propia fila, con la misma
-- política RLS. `profiles_phone_check` sigue exigiendo formato E.164, y
-- un valor nulo es válido (borrar el teléfono).
grant update (phone) on public.profiles to authenticated;

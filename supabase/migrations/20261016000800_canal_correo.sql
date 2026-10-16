-- =====================================================================
-- ActivaUC · 08 · Notificaciones por correo, a elección de la persona
-- ---------------------------------------------------------------------
-- Hasta aquí las notificaciones salían sólo por WhatsApp, y eso obliga
-- a tener WhatsApp y a hacer el `join` del Sandbox mientras la cuenta de
-- Twilio no salga de Trial. El correo es la alternativa natural: toda
-- persona registrada ya tiene uno verificado en auth.users.
--
-- Cada vía se consiente por separado, así que son cuatro combinaciones
-- posibles: sólo WhatsApp, sólo correo, ambas o ninguna. Lo que no
-- cambia es que sin consentimiento no sale nada.
--
-- `notification_jobs.channel` ya existía con un check que sólo admitía
-- 'whatsapp'; aquí se abre a 'email'. El resto del andamiaje —cola con
-- reclamo, retroceso, tope de intentos, idempotencia— se reutiliza tal
-- cual: el canal es una columna más, no una cola aparte.
--
-- Sobre el nombre `whatsapp_messages`: pasa a registrar los dos canales,
-- con lo que el nombre queda histórico. Renombrarla obligaría a tocar
-- políticas de RLS, privilegios por columna, tres funciones y dos
-- archivos de prueba sin ganar nada funcional, así que se queda; lo dice
-- su comentario.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · Consentimiento de correo, en espejo del de WhatsApp
-- ---------------------------------------------------------------------
-- La dirección NO se copia aquí: vive en auth.users, verificada, y el
-- worker la lee con el rol de servicio. Duplicarla sería un dato
-- personal más que mantener sincronizado y que proteger.
alter table public.profiles
  add column if not exists email_consent    boolean not null default false,
  add column if not exists email_consent_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_email_consent_timestamp;
alter table public.profiles
  add constraint profiles_email_consent_timestamp
    check (email_consent = false or email_consent_at is not null);

comment on column public.profiles.email_consent is
  'REQ-22/REQ-23 aplicados al correo: consentimiento explícito para recibir notificaciones de reservas por correo. La dirección está en auth.users.';

-- ---------------------------------------------------------------------
-- 2 · El canal admite correo
-- ---------------------------------------------------------------------
alter table public.notification_jobs
  drop constraint if exists notification_jobs_channel_check;
alter table public.notification_jobs
  add constraint notification_jobs_channel_check
    check (channel in ('whatsapp', 'email'));

alter table public.whatsapp_messages
  add column if not exists channel  text not null default 'whatsapp',
  add column if not exists to_email text;

alter table public.whatsapp_messages
  drop constraint if exists whatsapp_messages_channel_check;
alter table public.whatsapp_messages
  add constraint whatsapp_messages_channel_check
    check (channel in ('whatsapp', 'email'));

-- Un envío efectivo siempre tiene destino, y el destino que corresponde
-- a su canal. Queda permitido que ambos sean nulos: es el caso de un
-- fallo registrado después de que la persona revocara su consentimiento.
alter table public.whatsapp_messages
  drop constraint if exists whatsapp_messages_destino_del_canal;
alter table public.whatsapp_messages
  add constraint whatsapp_messages_destino_del_canal
    check (
      (channel = 'whatsapp' and to_email is null)
      or (channel = 'email' and to_phone is null)
    );

comment on table public.whatsapp_messages is
  'Trazabilidad de notificaciones enviadas, por los dos canales (la columna channel distingue). El nombre es histórico: nació cuando sólo existía WhatsApp. No almacena credenciales ni el cuerpo renderizado, sólo variables de plantilla.';

create index if not exists whatsapp_messages_channel_idx
  on public.whatsapp_messages(channel, created_at desc);

-- ---------------------------------------------------------------------
-- 3 · Otorgar o revocar el consentimiento de correo
-- ---------------------------------------------------------------------
-- No recibe la dirección a propósito: es la del correo con que la
-- persona entró, ya verificado. Aceptar una cualquiera convertiría esto
-- en un medio para enviar correo a terceros.
create or replace function public.set_email_consent(_consent boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _correo text;
begin
  if _uid is null then
    return jsonb_build_object('ok', false, 'mensaje', 'Debes iniciar sesión.');
  end if;

  select u.email into _correo from auth.users u where u.id = _uid;

  if _consent and coalesce(btrim(_correo), '') = '' then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Tu cuenta no tiene un correo verificado.'
    );
  end if;

  update public.profiles
  set email_consent = _consent,
      email_consent_at = case when _consent then now() else null end
  where id = _uid;

  -- Al revocar, las notificaciones por correo que estén en cola dejan de
  -- tener sentido: se descartan en lugar de esperar a que el worker las
  -- rechace una por una.
  if not _consent then
    update public.notification_jobs
    set status = 'cancelado',
        last_error = 'Consentimiento de correo revocado.'
    where user_id = _uid
      and channel = 'email'
      and status in ('pendiente', 'error');
  end if;

  insert into public.reservation_audit_log (reservation_id, action, actor_id, details)
  values (null,
          case when _consent then 'consentimiento_otorgado' else 'consentimiento_revocado' end,
          _uid,
          jsonb_build_object('canal', 'email'));

  return jsonb_build_object(
    'ok', true,
    'mensaje', case
      when _consent then 'Listo: te avisaremos por correo.'
      else 'Dejamos de enviarte correos de tus reservas.'
    end
  );
end;
$$;

revoke all on function public.set_email_consent(boolean) from public, anon;
grant execute on function public.set_email_consent(boolean) to authenticated;

comment on function public.set_email_consent(boolean) is
  'REQ-23 para el canal de correo: otorga o revoca el consentimiento del usuario autenticado y descarta lo que quede en cola al revocar.';

-- ---------------------------------------------------------------------
-- 4 · Encolar por cada canal consentido
-- ---------------------------------------------------------------------
-- Función auxiliar para no repetir en create_reservation_strict y en
-- cancel_reservation la decisión de qué canales están activos. La clave
-- de idempotencia incorpora el canal, de modo que un mismo aviso por
-- las dos vías son dos trabajos distintos y ninguno desplaza al otro.
create or replace function private.encolar_notificacion(
  _reservation_id uuid,
  _user_id uuid,
  _kind public.notification_kind,
  _sufijo text,
  _cuando timestamptz,
  _payload jsonb
)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  _canales text[] := '{}';
  _canal text;
begin
  select
    case when p.whatsapp_consent and p.phone is not null
         then array['whatsapp'] else '{}' end
    || case when p.email_consent then array['email'] else '{}' end
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
      -- 'wa' y no 'whatsapp': es el prefijo que ya usan las filas
      -- encoladas antes de esta migración, y cambiarlo haría que un
      -- mismo aviso se pudiera encolar dos veces.
      (case _canal when 'whatsapp' then 'wa' else 'em' end)
        || ':' || _sufijo || ':' || _reservation_id::text,
      _cuando, _cuando, _payload
    )
    on conflict (idempotency_key) do nothing;
  end loop;

  return coalesce(_canales, '{}');
end;
$$;

revoke all on function private.encolar_notificacion(uuid, uuid, public.notification_kind, text, timestamptz, jsonb)
  from public, anon, authenticated;

comment on function private.encolar_notificacion(uuid, uuid, public.notification_kind, text, timestamptz, jsonb) is
  'Encola un aviso en cada canal que la persona haya consentido, con una clave de idempotencia por canal. Devuelve los canales encolados.';

-- ---------------------------------------------------------------------
-- 5 · El reclamo distingue el canal y resuelve el destino
-- ---------------------------------------------------------------------
-- Cambia el tipo de retorno, así que hay que soltarla antes.
drop function if exists public.claim_notification_jobs(integer);

create or replace function public.claim_notification_jobs(_limit integer default 10)
returns table (
  job_id uuid,
  reservation_id uuid,
  user_id uuid,
  kind public.notification_kind,
  channel text,
  attempts integer,
  max_attempts integer,
  payload jsonb,
  to_phone text,
  to_email text,
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
      -- El consentimiento se comprueba por canal: revocar uno no
      -- detiene el otro.
      --
      -- La dirección se comprueba con exists y no con un join a
      -- auth.users: FOR UPDATE no admite el lado nulable de un outer
      -- join, y con join interno un perfil sin fila en auth.users
      -- desaparecería de la cola en silencio.
      and case j.channel
            when 'whatsapp' then p.whatsapp_consent and p.phone is not null
            when 'email'    then p.email_consent and exists (
              select 1 from auth.users u
              where u.id = j.user_id and u.email is not null
            )
            else false
          end
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
    c.id, c.reservation_id, c.user_id, c.kind, c.channel,
    c.attempts, c.max_attempts, c.payload,
    case when c.channel = 'whatsapp' then p.phone end,
    case when c.channel = 'email' then u.email::text end,
    p.full_name, f.name, r.starts_at, r.ends_at
  from claimed c
  join public.profiles p on p.id = c.user_id
  left join auth.users u on u.id = c.user_id
  left join public.reservations r on r.id = c.reservation_id
  left join public.facilities f on f.id = r.facility_id;
end;
$$;

revoke all on function public.claim_notification_jobs(integer) from public, anon, authenticated;

comment on function public.claim_notification_jobs(integer) is
  'Reclama notificaciones vencidas de cualquier canal, comprobando el consentimiento que corresponde a cada uno, con FOR UPDATE SKIP LOCKED.';

-- ---------------------------------------------------------------------
-- 6 · Registrar el envío en el canal correcto
-- ---------------------------------------------------------------------
-- La firma no cambia: `_destino` es el teléfono o la dirección según el
-- canal del trabajo, y la función decide en qué columna va. Así no hay
-- que rehacer privilegios ni los llamantes que ya existen.
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
  _destino text := _to_phone;
begin
  update public.notification_jobs
  set status = 'completado', completed_at = now(), locked_at = null, last_error = null
  where id = _job_id
  returning * into _job;

  if not found then
    return;
  end if;

  insert into public.whatsapp_messages
    (notification_job_id, reservation_id, user_id, kind, channel,
     to_phone, to_email, status, provider_message_sid, sent_at, template_vars)
  values
    (_job.id, _job.reservation_id, _job.user_id, _job.kind, _job.channel,
     case when _job.channel = 'whatsapp' then _destino end,
     case when _job.channel = 'email' then _destino end,
     'enviado', _provider_sid, now(), _job.payload)
  on conflict (provider_message_sid) do update
    set status = 'enviado', sent_at = now();

  insert into public.reservation_audit_log
    (reservation_id, action, actor_id, details)
  values (_job.reservation_id, 'whatsapp_enviado', null,
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
$$;

revoke all on function public.complete_notification_job(uuid, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 7 - Las funciones que encolan y la que registra fallos
-- ---------------------------------------------------------------------
-- Se vuelven a declarar enteras porque su cuerpo cambia por dentro. El
-- unico cambio en las dos primeras es que el encolado pasa por
-- private.encolar_notificacion en lugar de insertar un trabajo de
-- WhatsApp; en fail_notification_job, que el destino registrado depende
-- del canal.
-- ---------------------------------------------------------------------

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
    -- Las claves 'whatsapp_*' conservan su nombre porque el
    -- frontend ya las lee; 'canales' dice por dónde saldrá.
    'whatsapp_confirmacion', _confirm_state,
    'canales', to_jsonb(_canales),
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
    select (p.whatsapp_consent and p.phone is not null) into _consent
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
    'notificacion_whatsapp', (_notify and not _is_owner and coalesce(_consent, false)),
    'mensaje', 'Reserva cancelada. El cupo quedó disponible para otras personas.'
  );
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
      (notification_job_id, reservation_id, user_id, kind, channel,
       to_phone, to_email, status, error_code, error_message, template_vars)
    select _job.id, _job.reservation_id, _job.user_id, _job.kind, _job.channel,
           case when _job.channel = 'whatsapp' then p.phone end,
           case when _job.channel = 'email' then u.email::text end,
           'fallido',
           _error_code, left(coalesce(_error, ''), 300), _job.payload
    from public.profiles p
    left join auth.users u on u.id = p.id
    where p.id = _job.user_id;

    insert into public.reservation_audit_log
      (reservation_id, action, actor_id, details)
    values (_job.reservation_id, 'whatsapp_fallido', null,
            jsonb_build_object('tipo', _job.kind, 'canal', _job.channel,
                               'intentos', _job.attempts,
                               'codigo', _error_code));
  end if;
end;
$$;

revoke all on function public.fail_notification_job(uuid, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.create_reservation_strict(uuid, text) from public, anon;
grant execute on function public.create_reservation_strict(uuid, text) to authenticated;
revoke all on function public.cancel_reservation(uuid, text) from public, anon;
grant execute on function public.cancel_reservation(uuid, text) to authenticated;

-- =====================================================================
-- ActivaUC · 10 · Aviso cuando se libera un cupo
-- ---------------------------------------------------------------------
-- Solicitud de cambio: cuando un bloque no tiene cupos, la persona puede
-- pedir que le avisen si se libera uno. Si alguien cancela y el bloque
-- vuelve a tener lugar, se le envía un mensaje y reserva por el flujo
-- normal. El aviso **no reserva nada**: el cupo lo toma quien reserve
-- primero, y eso es deliberado, porque reservar en nombre de alguien
-- que no está mirando llenaría los recintos de ausencias.
--
-- El aviso sale por cada canal que la persona haya consentido, de modo
-- que la elección entre WhatsApp y correo es la que ya tomó en «Datos
-- personales» y no una decisión fija del sistema.
-- =====================================================================

alter type public.notification_kind add value if not exists 'cupo_liberado';

-- ---------------------------------------------------------------------
-- 1 · Quién espera qué bloque
-- ---------------------------------------------------------------------
-- Una solicitud se consume al avisarse: `notified_at` deja de ser nulo y
-- no se vuelve a considerar. Si la persona quiere que le avisen otra
-- vez, lo pide de nuevo. Es más simple que una suscripción permanente y
-- evita avisar indefinidamente a quien ya perdió el interés.
create table if not exists public.block_watchers (
  id          uuid primary key default gen_random_uuid(),
  block_id    uuid not null references public.time_blocks(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  notified_at timestamptz,
  unique (block_id, user_id)
);

comment on table public.block_watchers is
  'Solicitudes de aviso por liberación de cupo. Una solicitud se consume al avisarse; el aviso no reserva ni asegura el cupo.';

-- Índice para la consulta que hace el disparador: los pendientes de un
-- bloque concreto.
create index if not exists block_watchers_pendientes_idx
  on public.block_watchers(block_id)
  where notified_at is null;

create index if not exists block_watchers_user_idx
  on public.block_watchers(user_id, created_at desc);

-- ---------------------------------------------------------------------
-- 2 · La cola necesita saber de qué bloque habla
-- ---------------------------------------------------------------------
-- Un aviso de cupo no tiene reserva asociada, y el worker descarta los
-- trabajos de los que no puede resolver recinto y horario. Con
-- `block_id` se resuelven desde el bloque.
alter table public.notification_jobs
  add column if not exists block_id uuid references public.time_blocks(id) on delete cascade;

-- ---------------------------------------------------------------------
-- 3 · Pedir y cancelar el aviso
-- ---------------------------------------------------------------------
create or replace function public.solicitar_aviso_de_cupo(_block_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _bloque record;
  _cupos int;
begin
  if _uid is null then
    return jsonb_build_object('ok', false, 'mensaje', 'Debes iniciar sesión.');
  end if;

  if not public.consume_rate_limit('aviso_cupo', _uid::text, 20, interval '1 minute') then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Hiciste demasiadas solicitudes seguidas. Espera un momento.'
    );
  end if;

  select b.id, b.starts_at, b.max_capacity, b.active, f.active as recinto_activo
  into _bloque
  from public.time_blocks b
  join public.facilities f on f.id = b.facility_id
  where b.id = _block_id;

  if not found or not _bloque.active or not _bloque.recinto_activo then
    return jsonb_build_object('ok', false, 'mensaje', 'Ese bloque no está disponible.');
  end if;

  if _bloque.starts_at <= now() then
    return jsonb_build_object('ok', false, 'mensaje', 'Ese bloque ya comenzó.');
  end if;

  if exists (
    select 1 from public.reservations r
    where r.block_id = _block_id and r.user_id = _uid and r.status = 'vigente'
  ) then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Ya tienes una reserva en ese bloque.'
    );
  end if;

  select _bloque.max_capacity - count(*) into _cupos
  from public.reservations r
  where r.block_id = _block_id and r.status = 'vigente';

  -- El aviso existe para los bloques llenos. Si hay cupo, lo útil es
  -- decirlo en lugar de registrar una espera que no llegará a nada.
  if _cupos > 0 then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Ese bloque tiene cupos: puedes reservarlo ahora.'
    );
  end if;

  -- Volver a pedirlo reabre una solicitud ya avisada, que es lo que la
  -- persona espera al pulsar el botón otra vez.
  insert into public.block_watchers (block_id, user_id)
  values (_block_id, _uid)
  on conflict (block_id, user_id) do update
    set notified_at = null, created_at = now();

  return jsonb_build_object(
    'ok', true,
    'mensaje', 'Listo: te avisaremos si se libera un cupo. El cupo es de quien reserve primero.'
  );
end;
$$;

revoke all on function public.solicitar_aviso_de_cupo(uuid) from public, anon;
grant execute on function public.solicitar_aviso_de_cupo(uuid) to authenticated;

create or replace function public.cancelar_aviso_de_cupo(_block_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    return jsonb_build_object('ok', false, 'mensaje', 'Debes iniciar sesión.');
  end if;

  delete from public.block_watchers
  where block_id = _block_id and user_id = _uid;

  return jsonb_build_object('ok', true, 'mensaje', 'Ya no te avisaremos de ese bloque.');
end;
$$;

revoke all on function public.cancelar_aviso_de_cupo(uuid) from public, anon;
grant execute on function public.cancelar_aviso_de_cupo(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4 · Privilegios y RLS
-- ---------------------------------------------------------------------
-- Sólo lectura de lo propio: la interfaz necesita saber de qué bloques
-- ya pidió aviso esta persona. Escribir es exclusivo de las dos
-- funciones de arriba, que validan antes.
revoke all on public.block_watchers from anon, authenticated;
grant select (id, block_id, user_id, created_at, notified_at)
  on public.block_watchers to authenticated;

alter table public.block_watchers enable row level security;

drop policy if exists "watchers_select_own" on public.block_watchers;
create policy "watchers_select_own" on public.block_watchers
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 5 · Avisar cuando una cancelación libera un cupo
-- ---------------------------------------------------------------------
-- Disparador por sentencia sobre `reservations`: una cancelación puede
-- afectar a varias filas, y basta recorrer los bloques distintos una
-- vez. Va por disparador y no dentro de `cancel_reservation` para que
-- cubra cualquier vía que cancele, incluida una corrección manual.
create or replace function private.avisar_cupo_liberado()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
        case when p.whatsapp_consent and p.phone is not null
             then array['whatsapp'] else '{}' end
        || case when p.email_consent then array['email'] else '{}' end
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
        (case canal when 'whatsapp' then 'wa' else 'em' end)
          || ':cupo:' || _espera.id::text,
        now(), now(),
        jsonb_build_object('block_id', _bloque.id)
      from unnest(_canales) canal
      on conflict (idempotency_key) do nothing;
    end loop;
  end loop;

  return null;
end;
$$;

revoke all on function private.avisar_cupo_liberado() from public, anon, authenticated;

comment on function private.avisar_cupo_liberado() is
  'Encola el aviso de cupo liberado para quienes lo pidieron, una vez por solicitud y sólo si la cancelación dejó cupo real.';

drop trigger if exists reservations_avisar_cupo on public.reservations;
create trigger reservations_avisar_cupo
  after update on public.reservations
  referencing new table as nuevas
  for each statement
  execute function private.avisar_cupo_liberado();

-- ---------------------------------------------------------------------
-- 6 · El reclamo resuelve el horario desde la reserva o desde el bloque
-- ---------------------------------------------------------------------
-- Cambia el tipo de retorno (añade block_id), así que hay que soltarla.
drop function if exists public.claim_notification_jobs(integer);

create or replace function public.claim_notification_jobs(_limit integer default 10)
returns table (
  job_id uuid,
  reservation_id uuid,
  block_id uuid,
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
    c.id, c.reservation_id, c.block_id, c.user_id, c.kind, c.channel,
    c.attempts, c.max_attempts, c.payload,
    case when c.channel = 'whatsapp' then p.phone end,
    case when c.channel = 'email' then u.email::text end,
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
$$;

revoke all on function public.claim_notification_jobs(integer) from public, anon, authenticated;

comment on function public.claim_notification_jobs(integer) is
  'Reclama notificaciones vencidas de cualquier canal y tipo, resolviendo recinto y horario desde la reserva o desde el bloque, con FOR UPDATE SKIP LOCKED.';

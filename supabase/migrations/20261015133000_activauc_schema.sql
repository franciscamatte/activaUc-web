-- ActivaUC schema base + seguridad + concurrencia
create extension if not exists pgcrypto;

create type public.user_role as enum ('usuario', 'administrador');
create type public.reservation_status as enum ('vigente', 'cancelada', 'pasada');
create type public.sync_status as enum ('sincronizado', 'pendiente', 'error');
create type public.message_status as enum ('enviado', 'entregado', 'fallido', 'omitido');

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  whatsapp_consent boolean not null default false,
  google_calendar_connected boolean not null default false,
  role public.user_role not null default 'usuario',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  facility_type text not null,
  description text not null,
  operation_hours text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.time_blocks (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  max_capacity int not null check (max_capacity > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.facility_admin_assignments (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete cascade,
  facility_id uuid not null references public.facilities(id) on delete cascade,
  unique (admin_id, facility_id)
);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  facility_id uuid not null references public.facilities(id) on delete cascade,
  block_id uuid not null references public.time_blocks(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.reservation_status not null default 'vigente',
  calendar_sync_status public.sync_status not null default 'pendiente',
  whatsapp_confirmation_status public.message_status not null default 'omitido',
  whatsapp_reminder_status public.message_status not null default 'omitido',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create unique index if not exists reservations_unique_active_user_block
  on public.reservations(user_id, facility_id, block_id)
  where status = 'vigente';

create index if not exists reservations_block_status_idx on public.reservations(block_id, status);
create index if not exists reservations_user_status_idx on public.reservations(user_id, status);
create index if not exists time_blocks_facility_idx on public.time_blocks(facility_id);

create table if not exists public.integration_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  provider text not null check (provider in ('google_calendar', 'whatsapp')),
  event_type text not null,
  status text not null,
  retries int not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reservation_audit_log (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  action text not null,
  actor_id uuid not null references public.profiles(id),
  details text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.facilities enable row level security;
alter table public.time_blocks enable row level security;
alter table public.facility_admin_assignments enable row level security;
alter table public.reservations enable row level security;
alter table public.integration_events enable row level security;
alter table public.reservation_audit_log enable row level security;

create or replace function public.is_admin(_uid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.profiles p where p.id = _uid and p.role = 'administrador'
  );
$$;

create policy "profiles own data" on public.profiles
for select using (auth.uid() = id or public.is_admin(auth.uid()));

create policy "profiles self insert" on public.profiles
for insert with check (auth.uid() = id);

create policy "profiles self update" on public.profiles
for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "public facilities visible" on public.facilities
for select using (true);

create policy "admins update assigned facilities" on public.facilities
for update using (
  exists (
    select 1 from public.facility_admin_assignments faa
    where faa.facility_id = facilities.id
      and faa.admin_id = auth.uid()
  )
) with check (
  exists (
    select 1 from public.facility_admin_assignments faa
    where faa.facility_id = facilities.id
      and faa.admin_id = auth.uid()
  )
);

create policy "admins insert facilities" on public.facilities
for insert with check (public.is_admin(auth.uid()));

create policy "admins delete assigned facilities" on public.facilities
for delete using (
  exists (
    select 1 from public.facility_admin_assignments faa
    where faa.facility_id = facilities.id
      and faa.admin_id = auth.uid()
  )
);

create policy "time blocks readable" on public.time_blocks
for select using (true);

create policy "admins manage assigned blocks" on public.time_blocks
for all using (
  exists (
    select 1 from public.facility_admin_assignments faa
    where faa.facility_id = time_blocks.facility_id and faa.admin_id = auth.uid()
  )
) with check (
  exists (
    select 1 from public.facility_admin_assignments faa
    where faa.facility_id = time_blocks.facility_id and faa.admin_id = auth.uid()
  )
);

create policy "users see own reservations" on public.reservations
for select using (
  auth.uid() = user_id
  or exists (
    select 1 from public.facility_admin_assignments faa
    where faa.admin_id = auth.uid() and faa.facility_id = reservations.facility_id
  )
);

create policy "users insert own reservations" on public.reservations
for insert with check (auth.uid() = user_id);

create policy "users cancel own reservations" on public.reservations
for update using (
  auth.uid() = user_id
  or exists (
    select 1 from public.facility_admin_assignments faa
    where faa.admin_id = auth.uid() and faa.facility_id = reservations.facility_id
  )
);

create policy "admins manage assignments" on public.facility_admin_assignments
for all using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

create policy "integration events limited visibility" on public.integration_events
for select using (
  exists (
    select 1 from public.reservations r
    where r.id = integration_events.reservation_id
      and (
        r.user_id = auth.uid()
        or exists (
          select 1 from public.facility_admin_assignments faa
          where faa.admin_id = auth.uid() and faa.facility_id = r.facility_id
        )
      )
  )
);

create policy "reservation audit visibility" on public.reservation_audit_log
for select using (
  exists (
    select 1 from public.reservations r
    where r.id = reservation_audit_log.reservation_id
      and (
        r.user_id = auth.uid()
        or exists (
          select 1 from public.facility_admin_assignments faa
          where faa.admin_id = auth.uid() and faa.facility_id = r.facility_id
        )
      )
  )
);

create or replace function public.create_reservation_strict(_block_id uuid)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  _block public.time_blocks;
  _active_count int;
  _res public.reservations;
  _profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado';
  end if;

  select * into _block
  from public.time_blocks
  where id = _block_id and active = true
  for update;

  if not found then
    raise exception 'Bloque no disponible';
  end if;

  if _block.starts_at <= now() then
    raise exception 'No se puede reservar un bloque en el pasado';
  end if;

  select count(*) into _active_count
  from public.reservations r
  where r.block_id = _block.id and r.status = 'vigente'
  for update;

  if _active_count >= _block.max_capacity then
    raise exception 'No hay cupos disponibles';
  end if;

  if exists (
    select 1 from public.reservations r
    where r.user_id = auth.uid()
      and r.facility_id = _block.facility_id
      and r.block_id = _block.id
      and r.status = 'vigente'
  ) then
    raise exception 'Reserva duplicada para este bloque';
  end if;

  select * into _profile from public.profiles where id = auth.uid();

  insert into public.reservations (
    user_id,
    facility_id,
    block_id,
    starts_at,
    ends_at,
    status,
    calendar_sync_status,
    whatsapp_confirmation_status,
    whatsapp_reminder_status
  ) values (
    auth.uid(),
    _block.facility_id,
    _block.id,
    _block.starts_at,
    _block.ends_at,
    'vigente',
    case when _profile.google_calendar_connected then 'pendiente' else 'error' end,
    case when _profile.whatsapp_consent and coalesce(_profile.phone, '') <> '' then 'enviado' else 'omitido' end,
    case
      when _profile.whatsapp_consent
        and coalesce(_profile.phone, '') <> ''
        and _block.starts_at >= now() + interval '2 hours' then 'pendiente'
      else 'omitido'
    end
  ) returning * into _res;

  insert into public.reservation_audit_log(reservation_id, action, actor_id, details)
  values (_res.id, 'creada', auth.uid(), 'Reserva creada con función transaccional');

  return _res;
end;
$$;

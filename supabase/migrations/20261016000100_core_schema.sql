-- =====================================================================
-- ActivaUC · 01 · Esquema central
-- ---------------------------------------------------------------------
-- Extensiones, enumeraciones, tablas de dominio, índices, restricciones
-- y disparadores de mantenimiento (updated_at, creación de perfil).
--
-- Fuente oficial de la verdad: Supabase / PostgreSQL.
-- Los estados de integración (Google Calendar, WhatsApp) son
-- informativos y nunca condicionan la validez de una reserva.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Esquema privado: sólo accesible con service_role / funciones definer.
-- ---------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------------
-- Enumeraciones
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('usuario', 'administrador');
  end if;

  if not exists (select 1 from pg_type where typname = 'reservation_status') then
    -- "pasada" no se almacena: se deriva de ends_at < now() para evitar
    -- estados obsoletos. Una reserva sólo es vigente o cancelada.
    create type public.reservation_status as enum ('vigente', 'cancelada');
  end if;

  if not exists (select 1 from pg_type where typname = 'calendar_sync_status') then
    create type public.calendar_sync_status as enum (
      'no_aplica',    -- el usuario no tiene Google Calendar conectado
      'pendiente',    -- hay un trabajo encolado
      'sincronizado', -- evento creado/eliminado con éxito
      'error'         -- se agotaron los reintentos
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type public.job_status as enum (
      'pendiente', 'procesando', 'completado', 'error', 'cancelado'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'message_status') then
    create type public.message_status as enum (
      'pendiente', 'enviado', 'entregado', 'fallido', 'omitido'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'notification_kind') then
    create type public.notification_kind as enum (
      'confirmacion', 'recordatorio', 'cancelacion_admin'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'calendar_job_kind') then
    create type public.calendar_job_kind as enum ('crear_evento', 'eliminar_evento');
  end if;

  if not exists (select 1 from pg_type where typname = 'calendar_connection_status') then
    create type public.calendar_connection_status as enum (
      'conectado', 'revocado', 'error'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Disparador genérico de updated_at
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- profiles · REQ-1, REQ-4, REQ-7, REQ-22
-- El teléfono se valida en formato E.164 y sólo puede existir junto con
-- consentimiento explícito de WhatsApp.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  full_name           text not null check (length(btrim(full_name)) between 2 and 120),
  phone               text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_consent    boolean not null default false,
  whatsapp_consent_at timestamptz,
  role                public.user_role not null default 'usuario',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint profiles_consent_requires_phone
    check (whatsapp_consent = false or phone is not null),
  constraint profiles_consent_timestamp
    check (whatsapp_consent = false or whatsapp_consent_at is not null)
);

comment on table public.profiles is
  'Perfil de aplicación de cada usuario autenticado. El correo vive en auth.users y nunca se expone a terceros.';
comment on column public.profiles.phone is
  'Teléfono en formato E.164 (+56912345678). Sólo se almacena con consentimiento WhatsApp vigente.';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create index if not exists profiles_role_idx on public.profiles(role);

-- Alta automática de perfil al confirmarse el registro en auth.users.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _name text;
begin
  _name := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  if length(_name) < 2 then
    _name := split_part(coalesce(new.email, 'usuario'), '@', 1);
  end if;
  if length(_name) < 2 then
    _name := 'Usuario';
  end if;

  insert into public.profiles (id, full_name)
  values (new.id, left(_name, 120))
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- facilities · REQ-8, REQ-28
-- No se borran físicamente: se desactivan (active = false).
-- ---------------------------------------------------------------------
create table if not exists public.facilities (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(btrim(name)) between 2 and 120),
  facility_type   text not null check (length(btrim(facility_type)) between 2 and 60),
  description     text not null default '' check (length(description) <= 1000),
  operation_hours text not null default '' check (length(operation_hours) <= 200),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.facilities is 'Recintos deportivos. La baja es lógica (active = false) para preservar el historial de reservas.';

drop trigger if exists facilities_set_updated_at on public.facilities;
create trigger facilities_set_updated_at
  before update on public.facilities
  for each row execute function public.set_updated_at();

create index if not exists facilities_active_type_idx on public.facilities(active, facility_type);
create unique index if not exists facilities_name_unique_idx on public.facilities(lower(btrim(name)));

-- ---------------------------------------------------------------------
-- facility_admin_assignments · REQ-29
-- ---------------------------------------------------------------------
create table if not exists public.facility_admin_assignments (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid not null references public.profiles(id) on delete cascade,
  facility_id uuid not null references public.facilities(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (admin_id, facility_id)
);

create index if not exists faa_facility_idx on public.facility_admin_assignments(facility_id);
create index if not exists faa_admin_idx on public.facility_admin_assignments(admin_id);

-- ---------------------------------------------------------------------
-- time_blocks · REQ-9, REQ-30
-- ---------------------------------------------------------------------
create table if not exists public.time_blocks (
  id           uuid primary key default gen_random_uuid(),
  facility_id  uuid not null references public.facilities(id) on delete cascade,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  max_capacity integer not null check (max_capacity between 1 and 1000),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint time_blocks_range check (ends_at > starts_at),
  constraint time_blocks_max_duration check (ends_at - starts_at <= interval '12 hours')
);

comment on table public.time_blocks is 'Bloques horarios reservables. La baja es lógica (active = false).';

drop trigger if exists time_blocks_set_updated_at on public.time_blocks;
create trigger time_blocks_set_updated_at
  before update on public.time_blocks
  for each row execute function public.set_updated_at();

create index if not exists time_blocks_facility_start_idx
  on public.time_blocks(facility_id, starts_at);
create index if not exists time_blocks_start_active_idx
  on public.time_blocks(starts_at) where active;
-- Un recinto no puede tener dos bloques activos con el mismo inicio.
create unique index if not exists time_blocks_no_duplicate_start_idx
  on public.time_blocks(facility_id, starts_at) where active;

-- ---------------------------------------------------------------------
-- reservations · REQ-12, REQ-13, REQ-14, REQ-15, REQ-16, REQ-21
-- ---------------------------------------------------------------------
create table if not exists public.reservations (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  facility_id          uuid not null references public.facilities(id) on delete restrict,
  block_id             uuid not null references public.time_blocks(id) on delete restrict,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  status               public.reservation_status not null default 'vigente',
  calendar_sync_status public.calendar_sync_status not null default 'no_aplica',
  calendar_event_id    text,
  cancelled_at         timestamptz,
  cancelled_by         uuid references public.profiles(id) on delete set null,
  cancelled_by_role    public.user_role,
  cancel_reason        text check (cancel_reason is null or length(cancel_reason) <= 500),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint reservations_range check (ends_at > starts_at),
  constraint reservations_cancel_consistency check (
    (status = 'vigente'   and cancelled_at is null and cancelled_by_role is null)
    or
    (status = 'cancelada' and cancelled_at is not null)
  )
);

comment on table public.reservations is
  'Reservas. "pasada" no es un estado almacenado: se deriva de ends_at < now() (ver vista public.reservations_view).';

drop trigger if exists reservations_set_updated_at on public.reservations;
create trigger reservations_set_updated_at
  before update on public.reservations
  for each row execute function public.set_updated_at();

-- REQ-13 / regla de negocio: una sola reserva vigente por usuario y bloque.
create unique index if not exists reservations_one_active_per_user_block_idx
  on public.reservations(user_id, block_id) where status = 'vigente';

create index if not exists reservations_block_active_idx
  on public.reservations(block_id) where status = 'vigente';
create index if not exists reservations_user_start_idx
  on public.reservations(user_id, starts_at desc);
create index if not exists reservations_facility_start_idx
  on public.reservations(facility_id, starts_at desc);

-- ---------------------------------------------------------------------
-- reservation_audit_log · auditoría de acciones relevantes
-- ---------------------------------------------------------------------
create table if not exists public.reservation_audit_log (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid references public.reservations(id) on delete set null,
  facility_id    uuid references public.facilities(id) on delete set null,
  action         text not null check (action in (
                   'reserva_creada',
                   'reserva_cancelada_usuario',
                   'reserva_cancelada_admin',
                   'calendar_evento_creado',
                   'calendar_evento_eliminado',
                   'calendar_error',
                   'calendar_conectado',
                   'calendar_desconectado',
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
                   'bloque_desactivado'
                 )),
  actor_id       uuid references public.profiles(id) on delete set null,
  actor_role     public.user_role,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.reservation_audit_log is
  'Bitácora de auditoría. details nunca debe contener tokens, secretos ni el teléfono completo.';

create index if not exists audit_reservation_idx on public.reservation_audit_log(reservation_id, created_at desc);
create index if not exists audit_facility_idx on public.reservation_audit_log(facility_id, created_at desc);
create index if not exists audit_created_idx on public.reservation_audit_log(created_at desc);

-- ---------------------------------------------------------------------
-- calendar_connections · REQ-17
-- Los tokens se guardan cifrados (AES-GCM) por las Edge Functions y
-- jamás se exponen al cliente web (ver políticas RLS en la migración 03).
-- ---------------------------------------------------------------------
create table if not exists public.calendar_connections (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null unique references public.profiles(id) on delete cascade,
  provider                 text not null default 'google' check (provider = 'google'),
  google_account_email     text,
  access_token_encrypted   text,
  refresh_token_encrypted  text,
  access_token_expires_at  timestamptz,
  scope                    text,
  status                   public.calendar_connection_status not null default 'conectado',
  last_error               text,
  connected_at             timestamptz not null default now(),
  revoked_at               timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint calendar_connections_active_requires_refresh
    check (status <> 'conectado' or refresh_token_encrypted is not null)
);

comment on column public.calendar_connections.access_token_encrypted is
  'Token cifrado con AES-256-GCM usando ENCRYPTION_KEY (secreto de Edge Functions). Nunca se envía al navegador.';

drop trigger if exists calendar_connections_set_updated_at on public.calendar_connections;
create trigger calendar_connections_set_updated_at
  before update on public.calendar_connections
  for each row execute function public.set_updated_at();

create index if not exists calendar_connections_status_idx on public.calendar_connections(status);

-- ---------------------------------------------------------------------
-- oauth_states · protección CSRF del callback de Google
-- Sólo se guarda el hash del state; el valor plano vive en el navegador.
-- ---------------------------------------------------------------------
create table if not exists public.oauth_states (
  id            uuid primary key default gen_random_uuid(),
  state_hash    text not null unique,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  redirect_path text not null default '/datos-personales'
                  check (redirect_path ~ '^/[A-Za-z0-9/_-]*$'),
  code_verifier text,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists oauth_states_expires_idx on public.oauth_states(expires_at);

-- ---------------------------------------------------------------------
-- calendar_sync_jobs · REQ-18, REQ-19, REQ-20, REQ-21
-- Cola con reintentos y backoff exponencial, idempotente por clave.
-- ---------------------------------------------------------------------
create table if not exists public.calendar_sync_jobs (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid not null references public.reservations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  kind            public.calendar_job_kind not null,
  status          public.job_status not null default 'pendiente',
  idempotency_key text not null unique,
  attempts        integer not null default 0 check (attempts >= 0),
  max_attempts    integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,
  last_error      text,
  payload         jsonb not null default '{}'::jsonb,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.calendar_sync_jobs.idempotency_key is
  'Clave determinística (reserva + tipo) que impide crear eventos duplicados en Google Calendar.';

drop trigger if exists calendar_sync_jobs_set_updated_at on public.calendar_sync_jobs;
create trigger calendar_sync_jobs_set_updated_at
  before update on public.calendar_sync_jobs
  for each row execute function public.set_updated_at();

create index if not exists calendar_jobs_ready_idx
  on public.calendar_sync_jobs(next_attempt_at)
  where status in ('pendiente', 'error');
create index if not exists calendar_jobs_reservation_idx
  on public.calendar_sync_jobs(reservation_id, created_at desc);

-- ---------------------------------------------------------------------
-- notification_jobs · REQ-24, REQ-25, REQ-26
-- scheduled_for permite programar el recordatorio de 2 horas antes.
-- ---------------------------------------------------------------------
create table if not exists public.notification_jobs (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid references public.reservations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  kind            public.notification_kind not null,
  channel         text not null default 'whatsapp' check (channel = 'whatsapp'),
  status          public.job_status not null default 'pendiente',
  idempotency_key text not null unique,
  scheduled_for   timestamptz not null default now(),
  attempts        integer not null default 0 check (attempts >= 0),
  max_attempts    integer not null default 4 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,
  last_error      text,
  payload         jsonb not null default '{}'::jsonb,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists notification_jobs_set_updated_at on public.notification_jobs;
create trigger notification_jobs_set_updated_at
  before update on public.notification_jobs
  for each row execute function public.set_updated_at();

create index if not exists notification_jobs_ready_idx
  on public.notification_jobs(scheduled_for, next_attempt_at)
  where status in ('pendiente', 'error');
create index if not exists notification_jobs_reservation_idx
  on public.notification_jobs(reservation_id, kind);

-- ---------------------------------------------------------------------
-- whatsapp_messages · REQ-27 (trazabilidad de envíos)
-- ---------------------------------------------------------------------
create table if not exists public.whatsapp_messages (
  id                  uuid primary key default gen_random_uuid(),
  notification_job_id uuid references public.notification_jobs(id) on delete set null,
  reservation_id      uuid references public.reservations(id) on delete set null,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  kind                public.notification_kind not null,
  -- Nulo sólo cuando el usuario revocó su consentimiento entre el intento
  -- de envío y el registro del fallo; en un envío efectivo siempre existe.
  to_phone            text check (to_phone is null or to_phone ~ '^\+[1-9][0-9]{7,14}$'),
  status              public.message_status not null default 'pendiente',
  provider_message_sid text unique,
  template_vars       jsonb not null default '{}'::jsonb,
  error_code          text,
  error_message       text,
  skipped_reason      text,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.whatsapp_messages is
  'Trazabilidad de mensajes WhatsApp. No almacena credenciales ni el cuerpo renderizado completo, sólo variables de plantilla.';

drop trigger if exists whatsapp_messages_set_updated_at on public.whatsapp_messages;
create trigger whatsapp_messages_set_updated_at
  before update on public.whatsapp_messages
  for each row execute function public.set_updated_at();

create index if not exists whatsapp_messages_reservation_idx
  on public.whatsapp_messages(reservation_id, created_at desc);
create index if not exists whatsapp_messages_user_idx
  on public.whatsapp_messages(user_id, created_at desc);
create index if not exists whatsapp_messages_status_idx
  on public.whatsapp_messages(status);

-- ---------------------------------------------------------------------
-- webhook_events · idempotencia y protección anti-replay
-- ---------------------------------------------------------------------
create table if not exists public.webhook_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null check (provider in ('twilio', 'google')),
  external_id     text not null,
  event_type      text,
  signature_valid boolean not null default false,
  payload         jsonb not null default '{}'::jsonb,
  processed_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (provider, external_id, event_type)
);

comment on table public.webhook_events is
  'Registro de webhooks recibidos. La clave única (provider, external_id, event_type) garantiza procesamiento idempotente.';

create index if not exists webhook_events_created_idx on public.webhook_events(created_at desc);

-- ---------------------------------------------------------------------
-- rate_limit_counters · límite de uso por usuario/acción
-- ---------------------------------------------------------------------
create table if not exists public.rate_limit_counters (
  bucket       text not null,
  subject      text not null,
  window_start timestamptz not null,
  counter      integer not null default 0,
  primary key (bucket, subject, window_start)
);

create index if not exists rate_limit_window_idx on public.rate_limit_counters(window_start);

-- ---------------------------------------------------------------------
-- private.app_config · configuración operativa del backend
-- Sólo accesible por service_role y funciones security definer.
-- ---------------------------------------------------------------------
create table if not exists private.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

comment on table private.app_config is
  'Configuración del backend (URL de funciones, CRON_SECRET). Se carga manualmente; nunca se versiona en Git.';

-- ---------------------------------------------------------------------
-- RLS activa en todas las tablas de public (políticas en migración 03).
-- ---------------------------------------------------------------------
alter table public.profiles                  enable row level security;
alter table public.facilities                enable row level security;
alter table public.facility_admin_assignments enable row level security;
alter table public.time_blocks               enable row level security;
alter table public.reservations              enable row level security;
alter table public.reservation_audit_log     enable row level security;
alter table public.calendar_connections      enable row level security;
alter table public.oauth_states              enable row level security;
alter table public.calendar_sync_jobs        enable row level security;
alter table public.notification_jobs         enable row level security;
alter table public.whatsapp_messages         enable row level security;
alter table public.webhook_events            enable row level security;
alter table public.rate_limit_counters       enable row level security;

-- =====================================================================
-- ActivaUC · arranque de un PostgreSQL "parecido a Supabase"
-- ---------------------------------------------------------------------
-- Las migraciones dependen de piezas que Supabase provee por defecto
-- (esquema auth, auth.uid(), roles anon/authenticated/service_role,
-- esquema extensions). Este archivo las crea para poder aplicar y
-- probar las migraciones contra un PostgreSQL vacío, tanto en la
-- máquina de desarrollo como en integración continua.
--
-- NO se despliega en Supabase: allí estas piezas ya existen.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Roles equivalentes a los de Supabase.
-- service_role tiene BYPASSRLS, igual que en Supabase, porque es el rol
-- que usan las Edge Functions de confianza.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema extensions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Esquema auth mínimo: lo que realmente usan las migraciones.
-- ---------------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- auth.uid() en Supabase lee el claim "sub" del JWT de la petición.
-- En las pruebas se simula con `set local request.jwt.claims`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  );
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.email', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  );
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- ---------------------------------------------------------------------
-- Ayudantes de prueba: crear usuarios y simular una sesión autenticada.
-- ---------------------------------------------------------------------
create schema if not exists test_helpers;

-- _role se declara como text, no como public.user_role, porque este
-- archivo se aplica ANTES de las migraciones (que son las que crean el
-- tipo). El cuerpo de una función PL/pgSQL se resuelve al invocarla, de
-- modo que la conversión funciona sin problemas.
create or replace function test_helpers.create_user(
  _email text,
  _full_name text,
  _role text default 'usuario'
)
returns uuid
language plpgsql
as $$
declare
  _id uuid := gen_random_uuid();
  _claims_previos text := coalesce(current_setting('request.jwt.claims', true), '');
begin
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values (_id, _email, now(), jsonb_build_object('full_name', _full_name));

  -- El disparador on_auth_user_created ya creó el perfil con rol
  -- 'usuario'. Asignar otro rol es una operación de administración de
  -- base de datos, así que se limpian los claims para que el disparador
  -- public.prevent_profile_privilege_escalation no la bloquee (en
  -- producción esa operación también se hace sin JWT, con service_role).
  perform set_config('request.jwt.claims', '', true);
  execute 'update public.profiles set role = $1::public.user_role where id = $2'
    using _role, _id;
  perform set_config('request.jwt.claims', _claims_previos, true);

  return _id;
end;
$$;

-- Simula la sesión de un usuario autenticado dentro de la transacción.
create or replace function test_helpers.login_as(_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', _user_id::text, 'role', 'authenticated')::text,
    true
  );
end;
$$;

create or replace function test_helpers.logout()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Las pruebas de RLS cambian a los roles reales anon/authenticated con
-- `set local role`, así que necesitan poder seguir llamando a estos
-- ayudantes y leer la tabla de identificadores compartidos.
grant usage on schema test_helpers to anon, authenticated, service_role;
grant execute on function test_helpers.login_as(uuid), test_helpers.logout()
  to anon, authenticated, service_role;

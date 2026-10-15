-- =====================================================================
-- ActivaUC · 03 · Privilegios y políticas RLS
-- ---------------------------------------------------------------------
-- Principio de mínimo privilegio:
--   · Supabase concede por defecto ALL a anon/authenticated sobre public.
--     Aquí se revoca todo y se vuelve a conceder columna por columna.
--   · Las escrituras sensibles (reservas, cancelaciones, consentimiento,
--     tokens OAuth) sólo ocurren a través de funciones SECURITY DEFINER.
--   · Teléfonos, correos y tokens nunca son legibles por otro usuario.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Punto de partida: sin privilegios en el esquema público.
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant usage on schema public to anon, authenticated;

-- =====================================================================
-- profiles · REQ-4, REQ-7
-- Un usuario sólo lee y modifica su propio perfil, y nunca su rol.
-- =====================================================================
grant select on public.profiles to authenticated;
-- El rol, el teléfono y el consentimiento NO son actualizables desde el
-- cliente: el rol lo asigna un administrador de base de datos y el
-- teléfono/consentimiento pasan por public.set_whatsapp_consent().
grant update (full_name) on public.profiles to authenticated;

drop policy if exists "profiles_select_self" on public.profiles;
create policy "profiles_select_self" on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Barrera adicional: aunque alguien obtuviera el privilegio de columna,
-- el rol no puede cambiarse desde una sesión de usuario.
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null and new.role is distinct from old.role then
    raise exception 'No puedes modificar tu rol.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_profile_privilege_escalation()
  from public, anon, authenticated;

drop trigger if exists profiles_no_role_change on public.profiles;
create trigger profiles_no_role_change
  before update on public.profiles
  for each row execute function public.prevent_profile_privilege_escalation();

-- =====================================================================
-- facilities · REQ-8, REQ-28
-- Lectura pública de recintos activos; gestión sólo del administrador
-- asignado (REQ-29). La baja es lógica: no se concede DELETE.
-- =====================================================================
grant select on public.facilities to anon, authenticated;
grant update (name, facility_type, description, operation_hours, active)
  on public.facilities to authenticated;

drop policy if exists "facilities_select_active" on public.facilities;
create policy "facilities_select_active" on public.facilities
  for select to anon, authenticated
  using (active = true);

drop policy if exists "facilities_select_assigned_admin" on public.facilities;
create policy "facilities_select_assigned_admin" on public.facilities
  for select to authenticated
  using (public.is_facility_admin(auth.uid(), id));

drop policy if exists "facilities_update_assigned_admin" on public.facilities;
create policy "facilities_update_assigned_admin" on public.facilities
  for update to authenticated
  using (public.is_facility_admin(auth.uid(), id))
  with check (public.is_facility_admin(auth.uid(), id));

-- =====================================================================
-- facility_admin_assignments · REQ-29
-- Cada administrador ve únicamente sus propias asignaciones y no puede
-- auto-asignarse recintos ajenos (la asignación la hace el service_role
-- o public.admin_create_facility para el recinto que acaba de crear).
-- =====================================================================
grant select on public.facility_admin_assignments to authenticated;

drop policy if exists "assignments_select_self" on public.facility_admin_assignments;
create policy "assignments_select_self" on public.facility_admin_assignments
  for select to authenticated
  using (admin_id = auth.uid());

-- =====================================================================
-- time_blocks · REQ-9, REQ-30
-- =====================================================================
grant select on public.time_blocks to anon, authenticated;
grant insert (facility_id, starts_at, ends_at, max_capacity, active)
  on public.time_blocks to authenticated;
grant update (starts_at, ends_at, max_capacity, active)
  on public.time_blocks to authenticated;

drop policy if exists "time_blocks_select_public" on public.time_blocks;
create policy "time_blocks_select_public" on public.time_blocks
  for select to anon, authenticated
  using (
    active = true
    and exists (select 1 from public.facilities f where f.id = facility_id and f.active)
  );

drop policy if exists "time_blocks_select_assigned_admin" on public.time_blocks;
create policy "time_blocks_select_assigned_admin" on public.time_blocks
  for select to authenticated
  using (public.is_facility_admin(auth.uid(), facility_id));

drop policy if exists "time_blocks_insert_assigned_admin" on public.time_blocks;
create policy "time_blocks_insert_assigned_admin" on public.time_blocks
  for insert to authenticated
  with check (public.is_facility_admin(auth.uid(), facility_id));

drop policy if exists "time_blocks_update_assigned_admin" on public.time_blocks;
create policy "time_blocks_update_assigned_admin" on public.time_blocks
  for update to authenticated
  using (public.is_facility_admin(auth.uid(), facility_id))
  with check (public.is_facility_admin(auth.uid(), facility_id));

-- =====================================================================
-- reservations
-- Lectura: el dueño y el administrador del recinto. La disponibilidad
-- pública se obtiene de public.block_availability (sólo agregados), de
-- modo que anon nunca lee filas de reservas.
-- Escritura: ninguna directa. create_reservation_strict() y
-- cancel_reservation() son las únicas vías (SECURITY DEFINER).
-- =====================================================================
grant select on public.reservations to authenticated;

drop policy if exists "reservations_select_own" on public.reservations;
create policy "reservations_select_own" on public.reservations
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "reservations_select_assigned_admin" on public.reservations;
create policy "reservations_select_assigned_admin" on public.reservations
  for select to authenticated
  using (public.is_facility_admin(auth.uid(), facility_id));

-- =====================================================================
-- reservation_audit_log
-- =====================================================================
grant select on public.reservation_audit_log to authenticated;

drop policy if exists "audit_select_own" on public.reservation_audit_log;
create policy "audit_select_own" on public.reservation_audit_log
  for select to authenticated
  using (
    exists (
      select 1 from public.reservations r
      where r.id = reservation_id and r.user_id = auth.uid()
    )
  );

drop policy if exists "audit_select_assigned_admin" on public.reservation_audit_log;
create policy "audit_select_assigned_admin" on public.reservation_audit_log
  for select to authenticated
  using (
    facility_id is not null
    and public.is_facility_admin(auth.uid(), facility_id)
  );

-- =====================================================================
-- calendar_connections · REQ-17, REQ-21
-- El usuario sólo puede ver el ESTADO de su conexión. Las columnas de
-- tokens no se conceden a ningún rol del cliente: viven exclusivamente
-- para service_role (Edge Functions).
-- =====================================================================
grant select (id, user_id, provider, google_account_email, scope, status,
              last_error, connected_at, revoked_at, created_at, updated_at)
  on public.calendar_connections to authenticated;

drop policy if exists "calendar_connections_select_self" on public.calendar_connections;
create policy "calendar_connections_select_self" on public.calendar_connections
  for select to authenticated
  using (user_id = auth.uid());

-- =====================================================================
-- oauth_states · sin acceso desde el cliente (anti-CSRF)
-- =====================================================================
drop policy if exists "oauth_states_no_client_access" on public.oauth_states;
create policy "oauth_states_no_client_access" on public.oauth_states
  for select to authenticated
  using (false);

-- =====================================================================
-- Colas e integraciones · el usuario ve el estado de lo suyo
-- =====================================================================
grant select (id, reservation_id, user_id, kind, status, attempts, max_attempts,
              next_attempt_at, last_error, completed_at, created_at, updated_at)
  on public.calendar_sync_jobs to authenticated;

drop policy if exists "calendar_jobs_select_own" on public.calendar_sync_jobs;
create policy "calendar_jobs_select_own" on public.calendar_sync_jobs
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "calendar_jobs_select_assigned_admin" on public.calendar_sync_jobs;
create policy "calendar_jobs_select_assigned_admin" on public.calendar_sync_jobs
  for select to authenticated
  using (
    exists (
      select 1 from public.reservations r
      where r.id = reservation_id
        and public.is_facility_admin(auth.uid(), r.facility_id)
    )
  );

grant select (id, reservation_id, user_id, kind, channel, status, scheduled_for,
              attempts, max_attempts, next_attempt_at, last_error, completed_at,
              created_at, updated_at)
  on public.notification_jobs to authenticated;

drop policy if exists "notification_jobs_select_own" on public.notification_jobs;
create policy "notification_jobs_select_own" on public.notification_jobs
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "notification_jobs_select_assigned_admin" on public.notification_jobs;
create policy "notification_jobs_select_assigned_admin" on public.notification_jobs
  for select to authenticated
  using (
    exists (
      select 1 from public.reservations r
      where r.id = reservation_id
        and public.is_facility_admin(auth.uid(), r.facility_id)
    )
  );

-- whatsapp_messages: el dueño ve su propio historial (incluido su propio
-- teléfono). El administrador ve el estado SIN la columna to_phone, por
-- eso to_phone no está en el grant y el panel usa
-- public.admin_integration_report().
grant select (id, notification_job_id, reservation_id, user_id, kind, status,
              error_code, error_message, skipped_reason, sent_at, delivered_at,
              created_at, updated_at)
  on public.whatsapp_messages to authenticated;

drop policy if exists "whatsapp_messages_select_own" on public.whatsapp_messages;
create policy "whatsapp_messages_select_own" on public.whatsapp_messages
  for select to authenticated
  using (user_id = auth.uid());

-- =====================================================================
-- webhook_events y rate_limit_counters · sólo service_role
-- Sin GRANT y con una política falsa explícita para dejar constancia.
-- =====================================================================
drop policy if exists "webhook_events_no_client_access" on public.webhook_events;
create policy "webhook_events_no_client_access" on public.webhook_events
  for select to authenticated using (false);

drop policy if exists "rate_limits_no_client_access" on public.rate_limit_counters;
create policy "rate_limits_no_client_access" on public.rate_limit_counters
  for select to authenticated using (false);

-- =====================================================================
-- Vistas · se vuelven a conceder porque el REVOKE ALL del inicio de esta
-- migración también alcanza a las vistas creadas en la migración 02.
-- =====================================================================
grant select on public.block_availability to anon, authenticated;
grant select on public.my_reservations    to authenticated;

-- Nota deliberada: NO se usa FORCE ROW LEVEL SECURITY. Las escrituras
-- legítimas pasan por funciones SECURITY DEFINER propiedad de postgres;
-- forzar RLS al propietario dependería del atributo BYPASSRLS del rol y
-- haría frágil el control de concurrencia. La protección efectiva es que
-- anon/authenticated no tienen privilegio de INSERT/UPDATE/DELETE sobre
-- reservations, calendar_connections, oauth_states, webhook_events ni
-- rate_limit_counters (ver GRANTs de esta migración).

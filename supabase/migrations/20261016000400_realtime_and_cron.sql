-- =====================================================================
-- ActivaUC · 04 · Realtime y programación de tareas
-- ---------------------------------------------------------------------
-- REQ-9  · disponibilidad en vivo vía Supabase Realtime (WebSockets)
-- REQ-25 · recordatorios automáticos 2 horas antes del bloque
-- =====================================================================

-- ---------------------------------------------------------------------
-- Publicación de Realtime
-- ---------------------------------------------------------------------
-- La publicación supabase_realtime existe en todo proyecto Supabase.
-- Se agregan sólo las tablas cuyos cambios afectan la disponibilidad
-- mostrada en el catálogo y el panel de administración.
--
-- Importante: Realtime respeta RLS. Un visitante anónimo NO recibe
-- eventos de public.reservations (no tiene SELECT), por lo que el
-- frontend aplica un refresco periódico como respaldo para anon.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

do $$
declare
  _t text;
begin
  foreach _t in array array['reservations', 'time_blocks', 'facilities']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = _t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', _t);
    end if;
  end loop;
end;
$$;

-- REPLICA IDENTITY FULL permite que los eventos DELETE/UPDATE lleguen
-- con la fila anterior completa, necesario para recalcular cupos.
alter table public.reservations replica identity full;
alter table public.time_blocks  replica identity full;
alter table public.facilities   replica identity full;

-- ---------------------------------------------------------------------
-- Configuración operativa leída por la tarea programada.
-- Los valores se cargan manualmente (ver docs/OPERACION.md); este
-- archivo no contiene secretos.
-- ---------------------------------------------------------------------
create or replace function private.get_config(_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.value from private.app_config c where c.key = _key;
$$;

revoke all on function private.get_config(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Disparador de los workers de integración.
-- Usa pg_net para invocar la Edge Function cron-dispatch, autenticada
-- con el encabezado x-cron-secret. Si la configuración todavía no está
-- cargada, la función no hace nada y lo deja registrado.
-- ---------------------------------------------------------------------
create or replace function private.dispatch_integration_workers()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _base_url text := private.get_config('functions_base_url');
  _secret   text := private.get_config('cron_secret');
begin
  if _base_url is null or _secret is null then
    raise notice 'ActivaUC: private.app_config incompleto (functions_base_url / cron_secret). Cron sin efecto.';
    return;
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'ActivaUC: extensión pg_net no instalada. Cron sin efecto.';
    return;
  end if;

  perform net.http_post(
    url     := rtrim(_base_url, '/') || '/cron-dispatch',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', _secret
               ),
    body    := jsonb_build_object('source', 'pg_cron', 'at', now()),
    timeout_milliseconds := 25000
  );
end;
$$;

revoke all on function private.dispatch_integration_workers() from public, anon, authenticated;

comment on function private.dispatch_integration_workers() is
  'Invocada por pg_cron cada minuto. Dispara los workers de Google Calendar y WhatsApp (incluidos los recordatorios vencidos).';

-- ---------------------------------------------------------------------
-- Vista de salud de las colas, para monitoreo y alertas.
-- ---------------------------------------------------------------------
create or replace view private.integration_health as
select
  'calendar_sync_jobs' as queue,
  status::text         as status,
  count(*)             as total,
  min(next_attempt_at) as proximo_intento,
  max(updated_at)      as ultima_actualizacion
from public.calendar_sync_jobs
group by status
union all
select
  'notification_jobs',
  status::text,
  count(*),
  min(greatest(scheduled_for, next_attempt_at)),
  max(updated_at)
from public.notification_jobs
group by status
union all
select
  'whatsapp_messages',
  status::text,
  count(*),
  null::timestamptz,
  max(updated_at)
from public.whatsapp_messages
group by status;

-- ---------------------------------------------------------------------
-- Limpieza de datos efímeros (states OAuth vencidos, contadores viejos).
-- ---------------------------------------------------------------------
create or replace function private.cleanup_ephemeral_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.oauth_states where expires_at < now() - interval '1 hour';
  delete from public.rate_limit_counters where window_start < now() - interval '1 day';
  delete from public.webhook_events where created_at < now() - interval '90 days';
end;
$$;

revoke all on function private.cleanup_ephemeral_data() from public, anon, authenticated;

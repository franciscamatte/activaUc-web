-- =====================================================================
-- ActivaUC · programación de tareas (pg_cron + pg_net)
-- ---------------------------------------------------------------------
-- Este script NO es una migración: se ejecuta UNA VEZ por entorno, una
-- vez que ya existen la URL de las Edge Functions y el CRON_SECRET.
-- Se mantiene fuera de supabase/migrations a propósito, porque esos
-- valores son distintos en cada proyecto y no deben versionarse.
--
-- Ejecución (ver docs/OPERACION.md):
--
--   psql "$SUPABASE_DB_URL" \
--     -v functions_base_url="https://<ref>.supabase.co/functions/v1" \
--     -v cron_secret="<CRON_SECRET>" \
--     -f supabase/cron/schedule.sql
--
-- Para rotar el secreto basta volver a ejecutarlo con el nuevo valor.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) Extensiones. En Supabase se instalan en el esquema "extensions".
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------
-- 2) Configuración operativa. Los valores quedan sólo en la base de
--    datos, en un esquema sin acceso para anon/authenticated.
-- ---------------------------------------------------------------------
insert into private.app_config (key, value, updated_at)
values
  ('functions_base_url', :'functions_base_url', now()),
  ('cron_secret',        :'cron_secret',        now())
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();

-- ---------------------------------------------------------------------
-- 3) Tareas programadas.
--    · Cada minuto: workers de Google Calendar y WhatsApp. Los
--      recordatorios se envían cuando notification_jobs.scheduled_for
--      (= inicio - 2 h) ya venció, así que este único cron cubre REQ-25.
--    · Cada hora: limpieza de states OAuth vencidos y contadores.
-- ---------------------------------------------------------------------
select cron.unschedule(jobid)
from cron.job
where jobname in ('activauc_integraciones', 'activauc_limpieza');

select cron.schedule(
  'activauc_integraciones',
  '* * * * *',
  $$select private.dispatch_integration_workers();$$
);

select cron.schedule(
  'activauc_limpieza',
  '17 * * * *',
  $$select private.cleanup_ephemeral_data();$$
);

-- ---------------------------------------------------------------------
-- 4) Verificación
-- ---------------------------------------------------------------------
select jobid, jobname, schedule, active from cron.job where jobname like 'activauc%';

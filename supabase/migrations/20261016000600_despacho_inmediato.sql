-- =====================================================================
-- ActivaUC · 06 · Despacho inmediato de las integraciones
-- ---------------------------------------------------------------------
-- Hasta aquí, los eventos de Calendar y los mensajes de WhatsApp sólo se
-- procesaban cuando pg_cron despertaba, cada minuto. Esa espera es
-- innecesaria: la base de datos sabe en el instante exacto en que se
-- encola un trabajo.
--
-- Este disparador invoca el worker en cuanto hay algo que hacer, de modo
-- que el evento aparece en el calendario en segundos en lugar de hasta
-- un minuto después.
--
-- El cron NO se elimina: sigue siendo necesario para
--   · los reintentos con backoff de los trabajos que fallaron,
--   · los recordatorios cuyo scheduled_for vence más tarde,
--   · rescatar trabajos cuyo worker murió a mitad,
--   · y como red de seguridad si un disparo puntual se pierde.
--
-- Funciona porque net.http_post() de pg_net no bloquea: encola la
-- petición en su propia cola y un proceso en segundo plano la envía
-- después del commit. Si la transacción se revierte, la petición
-- encolada se revierte con ella, así que nunca se dispara por una
-- reserva que no llegó a existir.
-- =====================================================================

create or replace function private.despachar_si_hay_trabajo_inmediato()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _hay_trabajo_ya boolean := true;
begin
  -- Un recordatorio programado para dentro de seis horas no justifica
  -- despertar al worker ahora: de eso se encarga el cron cuando venza.
  if tg_table_name = 'notification_jobs' then
    select exists (
      select 1 from nuevas n
      where n.status = 'pendiente'
        and n.scheduled_for <= now()
    ) into _hay_trabajo_ya;
  else
    select exists (
      select 1 from nuevas n
      where n.status = 'pendiente'
        and n.next_attempt_at <= now()
    ) into _hay_trabajo_ya;
  end if;

  if _hay_trabajo_ya then
    -- La función ya comprueba que exista configuración y pg_net, y no
    -- hace nada si falta alguna. Nunca lanza, para que un problema de
    -- la integración no pueda tumbar la creación de una reserva.
    begin
      perform private.dispatch_integration_workers();
    exception when others then
      raise notice 'ActivaUC: no se pudo despachar el worker (%). El cron lo recogerá.', sqlerrm;
    end;
  end if;

  return null;
end;
$$;

revoke all on function private.despachar_si_hay_trabajo_inmediato()
  from public, anon, authenticated;

comment on function private.despachar_si_hay_trabajo_inmediato() is
  'Invoca el worker de integraciones en cuanto se encola un trabajo listo para ejecutar, para no esperar al siguiente ciclo de pg_cron.';

-- ---------------------------------------------------------------------
-- Disparadores por sentencia, no por fila: crear una reserva inserta un
-- trabajo de calendario y hasta dos notificaciones, y basta con un
-- despacho por sentencia. La tabla de transición `nuevas` permite
-- inspeccionar lo insertado sin recorrer fila por fila.
-- ---------------------------------------------------------------------
drop trigger if exists calendar_jobs_despacho_inmediato on public.calendar_sync_jobs;
create trigger calendar_jobs_despacho_inmediato
  after insert on public.calendar_sync_jobs
  referencing new table as nuevas
  for each statement
  execute function private.despachar_si_hay_trabajo_inmediato();

drop trigger if exists notification_jobs_despacho_inmediato on public.notification_jobs;
create trigger notification_jobs_despacho_inmediato
  after insert on public.notification_jobs
  referencing new table as nuevas
  for each statement
  execute function private.despachar_si_hay_trabajo_inmediato();

-- ---------------------------------------------------------------------
-- Un trabajo que se reencola a mano (tras corregir la causa de un
-- fallo) también merece ejecutarse de inmediato.
--
-- Sin «of status»: PostgreSQL no admite tablas de transición junto con
-- una lista de columnas. El filtro vive en la función, que sólo despacha
-- si alguna fila quedó en 'pendiente' y lista para ejecutar.
--
-- Eso además evita un bucle: el propio worker actualiza estas filas al
-- reclamarlas ('procesando'), completarlas ('completado') y fallarlas
-- ('error'), y ninguno de esos estados cumple la condición, así que no
-- se vuelve a despachar a sí mismo.
-- ---------------------------------------------------------------------
drop trigger if exists calendar_jobs_despacho_reintento on public.calendar_sync_jobs;
create trigger calendar_jobs_despacho_reintento
  after update on public.calendar_sync_jobs
  referencing new table as nuevas
  for each statement
  execute function private.despachar_si_hay_trabajo_inmediato();

drop trigger if exists notification_jobs_despacho_reintento on public.notification_jobs;
create trigger notification_jobs_despacho_reintento
  after update on public.notification_jobs
  referencing new table as nuevas
  for each statement
  execute function private.despachar_si_hay_trabajo_inmediato();

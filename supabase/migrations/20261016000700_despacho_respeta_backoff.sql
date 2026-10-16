-- =====================================================================
-- ActivaUC · 07 · El despacho inmediato respeta el retroceso
-- ---------------------------------------------------------------------
-- La condición para notification_jobs mira sólo `scheduled_for`, pero
-- `claim_notification_jobs` exige además `next_attempt_at <= now()`.
--
-- La diferencia importa al fallar un envío: el trabajo vuelve a
-- 'pendiente' con su `scheduled_for` ya vencido y su `next_attempt_at`
-- en el futuro, así que el disparador despachaba el worker, que no podía
-- reclamar nada y volvía vacío. No se perdía ni se adelantaba ningún
-- mensaje —el retroceso vive en la consulta de reclamo, no aquí— pero
-- cada fallo provocaba una invocación inútil de la Edge Function.
--
-- La condición pasa a ser la misma que la del reclamo: ambas fechas
-- vencidas. Así el disparador sólo despierta al worker cuando hay algo
-- que de verdad puede tomar.
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
  -- La condición replica la de claim_*: despachar sólo si el worker
  -- podrá reclamar algo. Un recordatorio para dentro de seis horas, o un
  -- reintento que todavía está en su retroceso, los recoge el cron.
  if tg_table_name = 'notification_jobs' then
    select exists (
      select 1 from nuevas n
      where n.status = 'pendiente'
        and n.scheduled_for <= now()
        and n.next_attempt_at <= now()
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

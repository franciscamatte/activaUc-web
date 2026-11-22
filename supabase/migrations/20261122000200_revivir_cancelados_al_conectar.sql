-- =====================================================================
-- ActivaUC · al reconectar, revivir también lo que la desconexión canceló
-- ---------------------------------------------------------------------
-- La migración anterior encola las reservas futuras al conectar el
-- calendario, y revive los trabajos que habían quedado **en error**. Le
-- faltaba el caso más frecuente de todos.
--
-- Al desconectar, `google-calendar-disconnect` cancela los trabajos
-- pendientes: deja de tener sentido crear un evento en un calendario al
-- que ya no se tiene acceso. Esos trabajos quedan en `cancelado`, no en
-- `error`. Así que el camino natural —desconectar y volver a conectar,
-- que es justo lo que hace quien ve que su calendario no se actualiza—
-- no revivía nada: la clave de idempotencia encontraba el trabajo
-- cancelado y el `do update` lo dejaba intacto.
--
-- Esta migración sólo amplía esa condición a `cancelado`. No se revive
-- un `completado`: ése ya creó su evento, y repetirlo sería trabajo
-- inútil contra la API de Google.
-- =====================================================================

create or replace function private.encolar_calendario_pendiente()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _encolados int;
begin
  -- Sólo al pasar a conectado: una renovación de token que mantiene el
  -- estado no tiene por qué revisar nada.
  if new.status <> 'conectado' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'conectado' then
    return new;
  end if;

  with pendientes as (
    select r.id, r.user_id
    from public.reservations r
    where r.user_id = new.user_id
      and r.status = 'vigente'
      and r.starts_at > now()
      and r.calendar_event_id is null
  ),
  encolados as (
    insert into public.calendar_sync_jobs
      (reservation_id, user_id, kind, idempotency_key, payload)
    select p.id, p.user_id, 'crear_evento',
           'cal:create:' || p.id::text,
           jsonb_build_object('reservation_id', p.id)
    from pendientes p
    -- Se revive tanto lo que falló (token caducado) como lo que la
    -- propia desconexión canceló. Un `completado` no se toca: ya creó
    -- su evento.
    on conflict (idempotency_key) do update
      set status = 'pendiente',
          attempts = 0,
          next_attempt_at = now(),
          locked_at = null,
          last_error = null,
          dismissed_at = null,
          dismissed_by = null
      where public.calendar_sync_jobs.status in ('error', 'cancelado')
    returning 1
  )
  select count(*) into _encolados from encolados;

  -- El estado visible acompaña a la cola: si no, la persona vería
  -- «no aplica» mientras el trabajo está en camino.
  update public.reservations r
  set calendar_sync_status = 'pendiente'
  where r.user_id = new.user_id
    and r.status = 'vigente'
    and r.starts_at > now()
    and r.calendar_event_id is null
    and r.calendar_sync_status <> 'pendiente';

  if _encolados > 0 then
    insert into public.reservation_audit_log
      (reservation_id, action, actor_id, details)
    values (null, 'calendar_conectado', new.user_id,
            jsonb_build_object('reservas_encoladas', _encolados));
  end if;

  return new;
end;
$$;

comment on function private.encolar_calendario_pendiente() is
  'REQ-18, REQ-20 · al conectar el calendario, encola las reservas futuras que aún no tienen evento y revive los trabajos que habían quedado en error o cancelados. Idempotente por la clave cal:create:<reserva>.';

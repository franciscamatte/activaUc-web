-- =====================================================================
-- ActivaUC · al conectar el calendario, sincronizar lo que ya existía
-- ---------------------------------------------------------------------
-- Hasta ahora el evento de Google se creaba al **reservar**, de modo que
-- quien conectaba su calendario después de haber reservado se quedaba
-- con el calendario vacío y sin forma de arreglarlo desde la aplicación:
-- había que ejecutar a mano la consulta de OPERACION.md.
--
-- Esto lo hace solo. Un disparador sobre `calendar_connections` encola
-- un `crear_evento` por cada reserva **futura y vigente** de esa persona
-- que todavía no tenga evento, en el momento en que la conexión pasa a
-- `conectado`.
--
-- Tres decisiones que importan:
--
--   · **Sólo futuras.** Llenar el calendario de alguien con reservas que
--     ya pasaron no le sirve de nada y multiplica las llamadas a Google.
--
--   · **Idempotente, y además reparadora.** La clave
--     `cal:create:<reserva>` es la misma que usa la reserva al crearse,
--     así que reconectar no duplica trabajos ni eventos —el id de evento
--     es determinístico—. Y si el trabajo ya existía **en error**, se
--     reinicia: ése es el caso de quien reconecta porque el token había
--     caducado, y con un `do nothing` se habría quedado sin arreglo
--     posible desde la aplicación.
--
--   · **Disparador y no código de la Edge Function.** El callback de
--     OAuth no es el único camino que marca una conexión como
--     `conectado`; ponerlo aquí cubre también una reparación hecha desde
--     la base, y deja la regla en un solo sitio.
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
    -- `do update` y no `do nothing`: el caso que más importa es
    -- justamente el del trabajo que ya existe y **falló** —por un token
    -- caducado, que es lo que pasa cuando la pantalla de consentimiento
    -- de Google sigue en pruebas—. Con `do nothing`, reconectar no
    -- arreglaba nada y la reserva se quedaba en «pendiente» para
    -- siempre, sin reintento posible desde la aplicación.
    on conflict (idempotency_key) do update
      set status = 'pendiente',
          attempts = 0,
          next_attempt_at = now(),
          locked_at = null,
          last_error = null,
          dismissed_at = null,
          dismissed_by = null
      where public.calendar_sync_jobs.status = 'error'
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
  'REQ-18, REQ-20 · al conectar el calendario, encola las reservas futuras que aún no tienen evento. Idempotente por la clave cal:create:<reserva>.';

drop trigger if exists calendar_connections_encolar_pendiente on public.calendar_connections;

create trigger calendar_connections_encolar_pendiente
  after insert or update of status on public.calendar_connections
  for each row
  execute function private.encolar_calendario_pendiente();

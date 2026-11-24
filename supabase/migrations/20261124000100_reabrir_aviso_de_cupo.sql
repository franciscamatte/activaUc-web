-- =====================================================================
-- ActivaUC · volver a pedir el aviso de cupo tiene que volver a avisar
-- ---------------------------------------------------------------------
-- `private.avisar_cupo_liberado()` encola el aviso con la clave de
-- idempotencia `em:cupo:<id de la solicitud>`, y el comentario que
-- acompaña a esa clave afirma que el id «es único por petición: si la
-- persona vuelve a pedir aviso del mismo bloque más adelante, no choca
-- con el anterior».
--
-- No lo era. `block_watchers` tiene `unique (block_id, user_id)` y
-- `solicitar_aviso_de_cupo` reabría la solicitud con un `do update`
-- sobre la misma fila, así que el id no cambiaba: era único por par
-- bloque-persona, no por petición. Al segundo aviso del mismo bloque la
-- clave coincidía con la del primero, que sigue en `notification_jobs`
-- —donde `idempotency_key` es única—, y el `on conflict do nothing`
-- descartaba el encolado.
--
-- Lo descartaba además en silencio y con pérdida de la solicitud: el
-- disparador marca `notified_at` antes de insertar, de modo que la
-- espera se consumía igual. Visto desde la interfaz todo parecía
-- correcto —el botón se vuelve a ofrecer en cuanto el aviso se consume,
-- responde «te avisaremos», la insignia queda puesta— y el correo no
-- llegaba nunca. Sólo fallaba la segunda vez de la misma persona en el
-- mismo bloque: otro bloque, u otra persona, tienen fila e id propios.
--
-- El arreglo hace verdadera la invariante de la que depende la clave en
-- lugar de complicar la clave: reabrir una espera entrega una solicitud
-- nueva, con id nuevo. El disparador no se toca, y tampoco cambia nada
-- de lo que ya funcionaba: una sola cancelación sigue avisando una sola
-- vez, dos cancelaciones seguidas no avisan dos veces, y quien ya tiene
-- reserva en el bloque sigue sin recibir aviso.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · Reabrir una espera es crear una solicitud nueva
-- ---------------------------------------------------------------------
create or replace function public.solicitar_aviso_de_cupo(_block_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _bloque record;
  _cupos int;
begin
  if _uid is null then
    return jsonb_build_object('ok', false, 'mensaje', 'Debes iniciar sesión.');
  end if;

  if not public.consume_rate_limit('aviso_cupo', _uid::text, 20, interval '1 minute') then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Hiciste demasiadas solicitudes seguidas. Espera un momento.'
    );
  end if;

  select b.id, b.starts_at, b.max_capacity, b.active, f.active as recinto_activo
  into _bloque
  from public.time_blocks b
  join public.facilities f on f.id = b.facility_id
  where b.id = _block_id;

  if not found or not _bloque.active or not _bloque.recinto_activo then
    return jsonb_build_object('ok', false, 'mensaje', 'Ese bloque no está disponible.');
  end if;

  if _bloque.starts_at <= now() then
    return jsonb_build_object('ok', false, 'mensaje', 'Ese bloque ya comenzó.');
  end if;

  if exists (
    select 1 from public.reservations r
    where r.block_id = _block_id and r.user_id = _uid and r.status = 'vigente'
  ) then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Ya tienes una reserva en ese bloque.'
    );
  end if;

  select _bloque.max_capacity - count(*) into _cupos
  from public.reservations r
  where r.block_id = _block_id and r.status = 'vigente';

  -- El aviso existe para los bloques llenos. Si hay cupo, lo útil es
  -- decirlo en lugar de registrar una espera que no llegará a nada.
  if _cupos > 0 then
    return jsonb_build_object(
      'ok', false,
      'mensaje', 'Ese bloque tiene cupos: puedes reservarlo ahora.'
    );
  end if;

  -- Volver a pedirlo reabre una solicitud ya avisada, que es lo que la
  -- persona espera al pulsar el botón otra vez. Y la reabre con `id`
  -- nuevo, porque el aviso se encola con la clave `em:cupo:<id>`:
  -- conservar el id haría que el segundo aviso de este bloque choque
  -- con el primero y se descarte. Una petición, una solicitud, un id.
  insert into public.block_watchers (block_id, user_id)
  values (_block_id, _uid)
  on conflict (block_id, user_id) do update
    set id = gen_random_uuid(),
        notified_at = null,
        created_at = now();

  return jsonb_build_object(
    'ok', true,
    'mensaje', 'Listo: te avisaremos si se libera un cupo. El cupo es de quien reserve primero.'
  );
end;
$$;

comment on function public.solicitar_aviso_de_cupo(uuid) is
  'Registra la espera de un cupo en un bloque lleno. Reabrirla entrega una solicitud nueva con id nuevo: `private.avisar_cupo_liberado()` deriva de ese id la clave de idempotencia del aviso, y repetirlo descartaría el envío.';

-- ---------------------------------------------------------------------
-- 2 · Las esperas que el error dejó condenadas
-- ---------------------------------------------------------------------
-- Una espera reabierta antes de esta migración conserva el id con el
-- que ya se encoló un aviso, así que seguiría descartándose aunque la
-- función ya esté corregida: está pendiente y nunca llegará. Se les da
-- id nuevo, que es exactamente lo que la función habría hecho al
-- reabrirlas. No se tocan las ya avisadas: ésas están consumidas, y al
-- pedirlas de nuevo pasan por la función corregida.
update public.block_watchers w
set id = gen_random_uuid()
where w.notified_at is null
  and exists (
    select 1 from public.notification_jobs j
    where j.idempotency_key = 'em:cupo:' || w.id::text
  );

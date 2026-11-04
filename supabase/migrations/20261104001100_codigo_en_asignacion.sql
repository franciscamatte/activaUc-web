-- =====================================================================
-- ActivaUC · código legible por máquina al asignar administradores
-- ---------------------------------------------------------------------
-- El documento de requerimientos encarga al administrador general
-- «crear las cuentas de los administradores de recintos y asignarles los
-- recintos a su cargo». Crear la cuenta exige privilegios que no pueden
-- estar en el navegador, así que lo hace una Edge Function
-- (`crear-administrador`) con la clave de servicio.
--
-- Esa función necesita distinguir un caso de los demás: que el correo
-- todavía no tenga cuenta. Hasta ahora la única señal era el texto del
-- mensaje, y decidir por el texto se rompe en cuanto alguien corrige una
-- tilde. Esta migración añade un campo `codigo` a cada respuesta y no
-- cambia ninguna regla: los mensajes, los permisos y el comportamiento
-- quedan idénticos.
-- =====================================================================

create or replace function public.admin_general_asignar_administrador(
  _correo text,
  _recintos uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _actor uuid := auth.uid();
  _uid uuid;
  _correo_limpio text := lower(btrim(coalesce(_correo, '')));
  _asignados int := 0;
  _desconocidos uuid[];
begin
  if _actor is null then
    return jsonb_build_object(
      'ok', false, 'codigo', 'sin_sesion', 'mensaje', 'Debes iniciar sesión.'
    );
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = _actor and p.role::text = 'administrador_general'
  ) then
    return jsonb_build_object(
      'ok', false,
      'codigo', 'no_autorizado',
      'mensaje', 'Sólo el administrador general puede asignar administradores.'
    );
  end if;

  if _correo_limpio = '' then
    return jsonb_build_object(
      'ok', false, 'codigo', 'sin_correo', 'mensaje', 'Indica el correo de la cuenta.'
    );
  end if;

  select u.id into _uid from auth.users u where lower(u.email) = _correo_limpio;

  if _uid is null then
    return jsonb_build_object(
      'ok', false,
      'codigo', 'sin_cuenta',
      'mensaje', 'No existe una cuenta con ese correo. Créala primero.'
    );
  end if;

  if _uid = _actor then
    return jsonb_build_object(
      'ok', false, 'codigo', 'propio_rol', 'mensaje', 'No puedes cambiar tu propio rol.'
    );
  end if;

  if exists (
    select 1 from public.profiles p
    where p.id = _uid and p.role::text = 'administrador_general'
  ) then
    return jsonb_build_object(
      'ok', false,
      'codigo', 'es_general',
      'mensaje', 'Esa cuenta es administradora general; su rol no se cambia desde aquí.'
    );
  end if;

  -- Los recintos inexistentes se informan en lugar de ignorarse en
  -- silencio: un id mal copiado dejaría al administrador sin acceso y
  -- sin explicación.
  if _recintos is not null and array_length(_recintos, 1) > 0 then
    select array_agg(r) into _desconocidos
    from unnest(_recintos) r
    where not exists (select 1 from public.facilities f where f.id = r);

    if _desconocidos is not null then
      return jsonb_build_object(
        'ok', false,
        'codigo', 'recintos_desconocidos',
        'mensaje', format('Hay %s recinto(s) que no existen.', array_length(_desconocidos, 1))
      );
    end if;
  end if;

  update public.profiles set role = 'administrador'::public.user_role where id = _uid;

  if _recintos is not null and array_length(_recintos, 1) > 0 then
    insert into public.facility_admin_assignments (admin_id, facility_id)
    select _uid, r from unnest(_recintos) r
    on conflict (admin_id, facility_id) do nothing;
    _asignados := array_length(_recintos, 1);
  end if;

  insert into public.reservation_audit_log (reservation_id, facility_id, action, actor_id, details)
  values (null, null, 'administrador_asignado', _actor,
          jsonb_build_object('correo_terminacion', right(_correo_limpio, 12),
                             'recintos', _asignados));

  return jsonb_build_object(
    'ok', true,
    'codigo', 'asignado',
    'mensaje', format('Cuenta habilitada como administradora de %s recinto(s).', _asignados)
  );
end;
$$;

revoke all on function public.admin_general_asignar_administrador(text, uuid[])
  from public, anon;
grant execute on function public.admin_general_asignar_administrador(text, uuid[])
  to authenticated;

comment on function public.admin_general_asignar_administrador(text, uuid[]) is
  'REQ-29 · el administrador general otorga el rol de administrador de recintos y asigna recintos. No puede conceder el rol de administrador general. Devuelve un campo codigo para que la Edge Function crear-administrador distinga el caso «sin_cuenta».';

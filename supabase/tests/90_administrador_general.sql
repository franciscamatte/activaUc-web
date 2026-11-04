-- =====================================================================
-- Pruebas · rol de administrador general (REQ-29)
-- ---------------------------------------------------------------------
-- Lo que importa de un rol con privilegios más altos no es que pueda
-- hacer su trabajo, sino que no pueda hacer más de lo previsto. De ahí
-- que la mitad de estas aserciones comprueben negaciones.
-- =====================================================================

do $$
declare
  _general uuid; _admin uuid; _usuario uuid;
  _fac1 uuid; _fac2 uuid;
  _r jsonb;
begin
  _general := test_helpers.create_user('g1@uc.cl', 'Gabriela General', 'administrador_general');
  _admin   := test_helpers.create_user('a1@uc.cl', 'Alonso Admin');
  _usuario := test_helpers.create_user('u1@uc.cl', 'Ulises Usuario');

  insert into public.facilities (name, facility_type) values ('Recinto Uno', 'Fútbol')
  returning id into _fac1;
  insert into public.facilities (name, facility_type) values ('Recinto Dos', 'Tenis')
  returning id into _fac2;

  -- Un usuario común no puede asignar administradores.
  perform test_helpers.login_as(_usuario);
  _r := public.admin_general_asignar_administrador('a1@uc.cl', array[_fac1]);
  assert not (_r ->> 'ok')::boolean,
    'Un usuario común no debería poder asignar administradores';

  -- Tampoco un administrador de recintos.
  perform test_helpers.login_as(_admin);
  _r := public.admin_general_asignar_administrador('u1@uc.cl', array[_fac1]);
  assert not (_r ->> 'ok')::boolean,
    'Un administrador de recintos no debería poder asignar administradores';

  -- El administrador general sí.
  perform test_helpers.login_as(_general);
  _r := public.admin_general_asignar_administrador('u1@uc.cl', array[_fac1, _fac2]);
  assert (_r ->> 'ok')::boolean, format('La asignación falló: %s', _r);

  assert (select role::text from public.profiles where id = _usuario) = 'administrador',
    'El rol no quedó asignado';
  assert (select count(*) from public.facility_admin_assignments where admin_id = _usuario) = 2,
    'No quedaron los dos recintos asignados';

  raise notice 'OK · sólo el administrador general asigna administradores';
end;
$$;

do $$
declare
  _general uuid; _otro_general uuid; _usuario uuid; _fac uuid; _r jsonb;
begin
  _general      := test_helpers.create_user('g2@uc.cl', 'Gonzalo General', 'administrador_general');
  _otro_general := test_helpers.create_user('g3@uc.cl', 'Gloria General', 'administrador_general');
  _usuario      := test_helpers.create_user('u2@uc.cl', 'Úrsula Usuario');

  insert into public.facilities (name, facility_type) values ('Recinto Tres', 'Tenis')
  returning id into _fac;

  perform test_helpers.login_as(_general);

  -- No puede cambiar su propio rol.
  _r := public.admin_general_asignar_administrador('g2@uc.cl', array[_fac]);
  assert not (_r ->> 'ok')::boolean, 'No debería poder cambiar su propio rol';

  -- Ni tocar a otro administrador general.
  _r := public.admin_general_asignar_administrador('g3@uc.cl', array[_fac]);
  assert not (_r ->> 'ok')::boolean,
    'No debería poder degradar a otro administrador general';
  assert (select role::text from public.profiles where id = _otro_general) = 'administrador_general',
    'El otro administrador general cambió de rol';

  -- Un recinto inexistente se informa en lugar de ignorarse.
  _r := public.admin_general_asignar_administrador(
    'u2@uc.cl', array[gen_random_uuid()]);
  assert not (_r ->> 'ok')::boolean, 'Un recinto inexistente debería rechazarse';
  assert (select role::text from public.profiles where id = _usuario) = 'usuario',
    'El rol cambió pese a que la asignación falló';

  -- Un correo sin cuenta se informa con claridad.
  _r := public.admin_general_asignar_administrador('nadie@uc.cl', array[_fac]);
  assert not (_r ->> 'ok')::boolean, 'Un correo sin cuenta debería rechazarse';
  assert _r ->> 'mensaje' like '%No existe una cuenta%',
    format('El mensaje no explica la causa: %s', _r);

  raise notice 'OK · el administrador general no puede sobrepasar su alcance';
end;
$$;

do $$
declare
  _general uuid; _usuario uuid; _fac uuid; _r jsonb;
begin
  -- El rol de administrador general NO se concede desde la aplicación:
  -- es el límite que impide que una cuenta comprometida cree más.
  _general := test_helpers.create_user('g4@uc.cl', 'Genaro General', 'administrador_general');
  _usuario := test_helpers.create_user('u3@uc.cl', 'Uriel Usuario');
  insert into public.facilities (name, facility_type) values ('Recinto Cuatro', 'Fútbol')
  returning id into _fac;

  perform test_helpers.login_as(_general);

  -- Ni por la función (que sólo otorga 'administrador')...
  _r := public.admin_general_asignar_administrador('u3@uc.cl', array[_fac]);
  assert (_r ->> 'ok')::boolean, 'La asignación normal debería funcionar';
  assert (select role::text from public.profiles where id = _usuario) = 'administrador',
    'Debería haber quedado como administrador de recintos, no general';

  -- ...ni por una escritura directa, que el disparador rechaza.
  begin
    update public.profiles set role = 'administrador_general'::public.user_role
    where id = _usuario;
    assert false, 'El disparador debería impedir conceder el rol general';
  exception when insufficient_privilege then
    null;
  end;

  raise notice 'OK · el rol de administrador general no se concede desde la aplicación';
end;
$$;

do $$
declare
  _general uuid; _dueno uuid; _fac uuid; _bloque uuid; _reserva uuid; _r jsonb;
begin
  -- Visibilidad: el administrador general ve y gestiona recintos que no
  -- tiene asignados, que es lo que lo distingue del de recintos.
  _general := test_helpers.create_user('g5@uc.cl', 'Gaspar General', 'administrador_general');
  _dueno   := test_helpers.create_user('d9@uc.cl', 'Delia Dueña');

  insert into public.facilities (name, facility_type) values ('Recinto Ajeno', 'Natación')
  returning id into _fac;
  insert into public.time_blocks (facility_id, starts_at, ends_at, max_capacity)
  values (_fac, now() + interval '8 hours', now() + interval '9 hours', 5)
  returning id into _bloque;

  perform test_helpers.login_as(_dueno);
  _r := public.create_reservation_strict(_bloque);
  _reserva := (_r ->> 'reservation_id')::uuid;

  perform test_helpers.login_as(_general);

  assert public.is_facility_admin(_general, _fac),
    'El administrador general debería administrar cualquier recinto';
  assert (select count(*) from public.admin_list_reservations(_fac)) = 1,
    'El administrador general no ve las reservas del recinto';

  -- Y puede cancelar sin estar sujeto a la ventana de 2 horas.
  _r := public.cancel_reservation(_reserva, 'Mantención');
  assert (_r ->> 'ok')::boolean, format('La cancelación falló: %s', _r);
  assert (select status::text from public.reservations where id = _reserva) = 'cancelada',
    'La reserva no quedó cancelada';

  raise notice 'OK · el administrador general alcanza todos los recintos';
end;
$$;

do $$
declare
  _general uuid; _usuario uuid; _fac uuid; _r jsonb; _fila record;
begin
  _general := test_helpers.create_user('g6@uc.cl', 'Gema General', 'administrador_general');
  _usuario := test_helpers.create_user('u4@uc.cl', 'Unai Usuario');
  insert into public.facilities (name, facility_type) values ('Recinto Listado', 'Tenis')
  returning id into _fac;

  perform test_helpers.login_as(_general);
  perform public.admin_general_asignar_administrador('u4@uc.cl', array[_fac]);

  -- El listado incluye al administrador con su recinto, y al general.
  select * into _fila from public.admin_general_listar_administradores()
  where correo = 'u4@uc.cl';
  assert _fila.rol = 'administrador', format('Rol inesperado: %s', _fila.rol);
  assert _fila.recintos = array['Recinto Listado'],
    format('Recintos inesperados: %s', _fila.recintos);

  assert exists (
    select 1 from public.admin_general_listar_administradores()
    where correo = 'g6@uc.cl' and rol = 'administrador_general'
  ), 'El administrador general no aparece en su propio listado';

  -- Quitar el rol borra las asignaciones.
  _r := public.admin_general_quitar_administrador('u4@uc.cl');
  assert (_r ->> 'ok')::boolean, format('No se pudo quitar el rol: %s', _r);
  assert (select role::text from public.profiles where id = _usuario) = 'usuario',
    'El rol no volvió a usuario';
  assert (select count(*) from public.facility_admin_assignments where admin_id = _usuario) = 0,
    'Quedaron asignaciones huérfanas';

  -- Y un usuario común no puede ni ver la lista.
  perform test_helpers.login_as(_usuario);
  begin
    perform public.admin_general_listar_administradores();
    assert false, 'Un usuario común no debería ver el listado de administradores';
  exception when insufficient_privilege then
    null;
  end;

  raise notice 'OK · el listado y la retirada del rol funcionan y están acotados';
end;
$$;

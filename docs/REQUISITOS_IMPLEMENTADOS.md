# Matriz de requisitos implementados

Trazabilidad de los requerimientos del documento
`2.1 Documento de requerimientos de software (1).pdf` al código.

**Criterio usado**: un requisito se considera implementado sólo si existe
persistencia real y validación en el backend. Un cambio de estado visual sin
respaldo no cuenta.

> Nota sobre la numeración: el documento de origen rotula dos requisitos
> consecutivos como «REQ-32» en la sección 6.6 (monitoreo y cancelación
> administrativa). Aquí se numeran **REQ-31** (monitoreo) y **REQ-32**
> (cancelación administrativa) para poder referenciarlos sin ambigüedad.

---

## 6.1 Autenticación y gestión de roles

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-1 | Registro con nombre, correo único y contraseña de largo mínimo | Implementado | `src/pages/RegistroPage.tsx`, `SupabaseRepository.registrarse`, disparador `handle_new_user` en `20261016000100_core_schema.sql`. La cuenta se activa con un **código de 6 dígitos** (`/verificar` → `verifyOtp`), no con un enlace: ver REQ-6 | Unicidad del correo: Supabase Auth. Largo mínimo validado en cliente y en `signUp`. `mockRepository.test.ts` › «sesión» (incluye los tres casos del código) |
| REQ-2 | Autenticación con correo y contraseña | Implementado | `src/pages/LoginPage.tsx`, `signInWithPassword`, sesión persistente con renovación automática (`src/lib/supabase.ts`) | `mockRepository.test.ts` › «inicia y cierra sesión» |
| REQ-3 | Autenticación diferenciada de administradores | Implementado | Mismo flujo de ingreso; la diferencia la hace `profiles.role`, que **no es modificable desde el cliente** (privilegio de columna + disparador `prevent_profile_privilege_escalation`) | `40_rls.sql` › «no puede escalar su rol» |
| REQ-4 | Diferenciación entre administrador y usuario | Implementado | `ProtectedRoute` en la interfaz; `is_admin()` e `is_facility_admin()` en RLS y en cada función de administración | `40_rls.sql` › «administrador acotado a sus recintos asignados» |
| REQ-5 | Manejo de errores de autenticación con la razón | Implementado | `src/lib/errors.ts` traduce cada error de Supabase a un mensaje en español específico (credenciales, correo sin confirmar, correo en uso, contraseña débil) | `errors.test.ts` (21 casos, incluye «ningún mensaje contiene texto en inglés») |
| REQ-6 | Recuperación de contraseña por correo | Implementado | `RecuperarPasswordPage` → `resetPasswordForEmail`; `VerificarCodigoPage` → `verifyOtp('recovery')`; `RestablecerPasswordPage` → `updateUser`. Respuesta idéntica exista o no la cuenta, para no revelar correos registrados. **Código de 6 dígitos y no enlace**: contra el proyecto real se comprobó que un enlace enviado a una dirección `@uc.cl` quedó consumido veinte segundos después, sin que nadie iniciara sesión —lo abrió el escáner de enlaces de Microsoft 365— y al ser de un solo uso el escáner la dejó confirmada sin que nadie demostrara controlar ese buzón; en la recuperación de contraseña el mismo efecto sí deja a la persona fuera, porque gasta el token sin definir contraseña nueva. Un código no se gasta por visitarlo. Las plantillas sin enlace están en `supabase/templates/` | `mockRepository.test.ts` › «un código de 6 dígitos confirma la cuenta», «rechaza un código mal formado», «no revela si el correo existe»; evidencia del diagnóstico en `docs/CONFIGURACION_CORREO.md` § 1 |
| REQ-7 | Ver y actualizar datos personales | Implementado | `src/pages/DatosPersonalesPage.tsx`. El nombre y el teléfono se actualizan con privilegio de columna (`update (full_name)` y `update (phone)`) sobre la propia fila, con la misma política RLS; el formato E.164 lo exige `profiles_phone_check` | `40_rls.sql` › «puede actualizar su propio nombre», `mockRepository.test.ts` › «actualiza el nombre» |

---

## 6.2 Consulta de disponibilidad

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-8 | Listado de recintos con descripción, capacidad y horario | Implementado | Vista `public.block_availability`; `CatalogoPage` | `mockRepository.test.ts` › «lista recintos activos» |
| REQ-9 | Cupos actualizados en tiempo real | Implementado | Supabase Realtime sobre `reservations`, `time_blocks` y `facilities` (`20261016000400_realtime_and_cron.sql`, `useDisponibilidad.ts`), con respaldo por intervalo de 45 s y refresco al recuperar foco o conexión | `20_reservations.sql` comprueba los conteos de la vista; el indicador «Actualización en vivo activa» refleja el estado real |
| REQ-10 | Filtros por fecha, tipo de recinto y bloque horario, específicos o por rango | Implementado | `CatalogoPage` (6 filtros: fecha desde/hasta, tipo, recinto, hora desde/hasta, sólo con cupos). Fecha, tipo y recinto se filtran en PostgreSQL; el rango horario en el cliente, por la zona de presentación | `reservationRules.test.ts` › `dentroDelRangoHorario` (6 casos, incluye zona horaria), `mockRepository.test.ts` › «disponibilidad y filtros» |
| REQ-11 | Bloques sin disponibilidad | Implementado | La vista `block_availability` expone `is_full`, el catálogo lo marca y el botón de reservar queda deshabilitado. Desde la solicitud de cambio 2, un bloque lleno ofrece además pedir aviso si se libera un cupo | `20_reservations.sql` › «agotamiento con fallo limpio»; `95_aviso_cupo_liberado.sql` |

---

## 6.3 Gestión de reservas

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-12 | Crear reserva validando la capacidad máxima | Implementado | `create_reservation_strict()` en `20261016000200_functions.sql` | `20_reservations.sql`; `test:concurrency` escenario 2: **100 solicitudes simultáneas sobre capacidad 20 → exactamente 20 reservas** (en la verificación automática, con `max_connections=200`) |
| REQ-13 | Impedir reservas duplicadas del mismo usuario y bloque | Implementado | Doble barrera: comprobación dentro de la función transaccional e índice único parcial `reservations_one_active_per_user_block_idx` | `test:concurrency` escenario 3: **10 solicitudes simultáneas del mismo usuario → 1 reserva** |
| REQ-14 | Mis reservas vigentes e historial, en secciones separadas | Implementado | `MisReservasPage` con dos pestañas accesibles (`role="tab"`). «Pasada» no se almacena: se deriva de `ends_at < now()`, de modo que no hay estados obsoletos | `reservationRules.test.ts` › `separarReservas` (4 casos) |
| REQ-15 | Cancelar reserva propia con 2 horas de anticipación, liberando el cupo | Implementado | `cancel_reservation()`; la UI deshabilita el botón y explica el motivo | `30_cancellations.sql` › «reglas de cancelación del usuario»; `test:concurrency` escenario 4 |
| REQ-16 | Control de concurrencia transaccional: sin sobrecupos ni duplicados | Implementado | `SELECT ... FOR UPDATE` sobre la fila del bloque serializa las solicitudes concurrentes del mismo bloque | `npm run test:concurrency`: 6 escenarios, **todos en verde** (ver abajo) |

### Evidencia de concurrencia

Ejecutado contra PostgreSQL 16 real, con una conexión y una transacción por
solicitud (igual que PostgREST en Supabase):

```
1) Último cupo con 2 usuarios simultáneos (capacidad 1)
   ✔ exactamente 1 reserva creada
   ✔ el otro recibe "sin_cupos"
2) 100 solicitudes concurrentes sobre capacidad 20
   ✔ reservas vigentes = 20 · cero sobrecupos
   ✔ 80 rechazos por "sin_cupos" · cero duplicados · cero errores inesperados
   ✔ 20 registros de auditoría
3) El mismo usuario lanzando 10 solicitudes simultáneas
   ✔ una sola reserva vigente · 9 respuestas marcadas como duplicadas
4) Carrera por el cupo liberado tras una cancelación
   ✔ exactamente 1 aspirante obtiene el cupo (de 10)
5) 30 solicitudes sobre un bloque ya agotado
   ✔ ninguna tiene éxito · las 30 reciben un mensaje legible
6) Reintento de una misma solicitud (idempotencia)
   ✔ siempre la misma reserva · un solo trabajo de Calendar · 2 notificaciones
```

---

## 6.4 Integración con Google Calendar

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-17 | Conectar y desconectar voluntariamente con OAuth 2.0 y permisos mínimos | Implementado | `google-oauth-start`, `google-oauth-callback`, `google-calendar-disconnect`. Único alcance de escritura: `calendar.events`. `state` firmado con HMAC-SHA256, de un solo uso y con vencimiento a 10 min. Tokens cifrados con AES-256-GCM | `googleCalendar.test.ts` › «pide únicamente los permisos mínimos»; `oauthCrypto.test.ts` (24 casos: cifrado, manipulación, CSRF, suplantación de usuario) |
| REQ-18 | Crear el evento al confirmarse la reserva, si hay conexión | Implementado | `create_reservation_strict` encola `crear_evento`; el worker `process-calendar-jobs` lo ejecuta. Y al **conectar** el calendario, un disparador encola las reservas futuras que ya existían: quien conecta después de haber reservado ve esas reservas en su calendario, que es lo que cualquiera espera | `50_integrations.sql` › «sincronización exitosa con Google Calendar» y «conectar el calendario arrastra las reservas futuras» |
| REQ-19 | Eliminar el evento al cancelarse la reserva | Implementado | `cancel_reservation` encola `eliminar_evento` sólo si el evento existe o puede existir; si el trabajo de creación aún no corrió, lo cancela en lugar de encolar un borrado inútil | `30_cancellations.sql` › «encolado de eliminación de eventos de Calendar» (casos A y B) |
| REQ-20 | Sincronización automática con reintentos y colas | Implementado | Tablas `calendar_sync_jobs` y `notification_jobs`; `claim_*` con `FOR UPDATE SKIP LOCKED`; retroceso exponencial (30 s, 60 s, 120 s…), tope de 5 intentos; rescate de trabajos huérfanos a los 10 min. Idempotencia por id de evento derivado del id de la reserva: un reintento recibe 409 de Google y se trata como éxito. El despacho no espera al cron: cuatro disparadores por sentencia invocan el worker al encolar, y el evento aparece en ~2 s (medido); el cron queda como red de seguridad para reintentos, recordatorios futuros y huérfanos | `50_integrations.sql` › «reintentos, backoff y tope de intentos», «recuperación de trabajos interrumpidos»; `70_despacho_inmediato.sql` › «un fallo del despacho no impide reservar»; `googleCalendar.test.ts` › «un 409 es éxito, no duplicación» |
| REQ-21 | Reconocer el estado de sincronización: sincronizado, pendiente o con error | Implementado | `reservations.calendar_sync_status` (`no_aplica`, `pendiente`, `sincronizado`, `error`). La interfaz **nunca** muestra «sincronizado» sin que `complete_calendar_job` lo haya registrado | `50_integrations.sql`; `mockRepository.test.ts` › «no reporta sincronización con Calendar si no hay conexión» |

---

## 6.5 Notificaciones y recordatorios

> **El canal cambió.** El documento de requerimientos dice «vía
> WhatsApp». El equipo retiró ese canal y las notificaciones salen por
> **correo**, con el acuerdo de la ayudante del curso. Lo que cada
> requisito pide —consentimiento explícito, revocación que detiene los
> envíos, confirmación, recordatorio a 2 h, aviso de cancelación y
> trazabilidad de cada mensaje— se cumple igual; lo que cambia es la vía.
> El historial de los envíos que sí salieron por WhatsApp se conserva en
> `notification_messages`.

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-22 | Registrar el consentimiento explícito de las notificaciones | Implementado | `set_email_consent()`, con `email_consent` y `email_consent_at` en `profiles` y la restricción `email_consent = false OR email_consent_at IS NOT NULL`. **No pide la dirección**: es la de la cuenta con que la persona entró, ya verificada en `auth.users`; aceptar una cualquiera convertiría esto en un medio para enviar correo a terceros. El teléfono sigue existiendo como dato de contacto (REQ-7), pero ya no activa ningún envío | `10_schema.sql` › «restricciones de datos personales»; `80_canal_correo.sql` (6 escenarios) |
| REQ-23 | Revocar el consentimiento, deteniendo los envíos | Implementado | La misma función apaga el consentimiento y **cancela los trabajos pendientes**, en lugar de dejar que el worker los rechace uno por uno. El worker tampoco reclama trabajos de quien no tenga consentimiento vigente **en el momento del reclamo** | `50_integrations.sql` › «revocación y reactivación del consentimiento de correo»; `80_canal_correo.sql` |
| REQ-24 | Confirmación al crear la reserva | Implementado | Trabajo `confirmacion` encolado para ejecución inmediata (`private.encolar_notificacion`) y despachado por un disparador, sin esperar al cron; `process-notification-jobs` lo envía por la API HTTP de Brevo. Medido sobre los envíos reales del proyecto: entre 1,1 y 2,9 s desde el evento hasta que el proveedor acepta | `50_integrations.sql` › «cola de notificaciones y trazabilidad del envío»; `80_canal_correo.sql`; `brevoEmail.test.ts` (10 casos) |
| REQ-25 | Recordatorio 2 h antes; si la reserva se crea con menos de 2 h, sólo confirmación | Implementado | `scheduled_for = starts_at - 2 horas`; si ese instante ya pasó, **no se encola nada** | `20_reservations.sql` › «regla exacta del recordatorio de 2 horas» (ambos lados del límite); `reservationRules.test.ts` › `tendraRecordatorio` |
| REQ-26 | Notificar al usuario cuando el administrador cancela | Implementado | `cancel_reservation` encola `cancelacion_admin` con el motivo, y la respuesta dice si quedó encolado para que el panel lo informe sin adivinar | `30_cancellations.sql` › «cancelación administrativa y aviso por correo» |
| REQ-27 | Registrar el estado de cada mensaje para trazabilidad | Implementado | Tabla `notification_messages` (`pendiente`, `enviado`, `entregado`, `fallido`, `omitido`) con el `messageId` del proveedor, el tipo de aviso y el error cuando lo hubo; la bitácora guarda sólo el **dominio** del destino, no la dirección. Una incidencia resuelta se descarta sin borrar la fila (`admin_descartar_incidencia`). **De la entrega no hay estado**: la API de Brevo acepta el envío y no informa la entrega, así que `enviado` es el estado final; fingir un «entregado» que nadie puede fijar sería peor que no tenerlo | `50_integrations.sql`; `80_canal_correo.sql` › «el reclamo resuelve el destino y la bitácora lo enmascara» |

---

## 6.6 Panel de administración

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-28 | Crear, actualizar y eliminar los recintos a cargo | Implementado | `admin_create_facility()` (crea y autoasigna de forma atómica); edición por RLS. La baja es **lógica** (`active = false`) para preservar el historial de reservas | `40_rls.sql` › «no puede editar un recinto ajeno»; `mockRepository.test.ts` › «administración» |
| REQ-29 | Asignación de administradores a recintos | Implementado | `facility_admin_assignments` acota a cada administrador a sus recintos, y `is_facility_admin` es el único punto por el que pasan todas las políticas RLS y las funciones del panel. El rol `administrador_general` lo gestiona desde la pestaña «Administradores»: concede el rol de administrador de recintos y le asigna recintos (`admin_general_asignar_administrador`), o se lo retira. Puede concederlo **sin recintos**: `admin_create_facility` asigna el recinto a quien lo crea, así que esa persona crea el primero y queda a su cargo. Exigir uno antes obligaría a inventar un recinto para poder nombrar a nadie, y el «uno o más» del requisito describe el resultado, no el orden de los pasos. Si ese correo todavía no tiene cuenta, el backend responde `sin_cuenta` y el panel ofrece **crearla**: lo hace la Edge Function `crear-administrador`, que comprueba el rol contra la base y crea la cuenta **sin contraseña** —la persona la define por «Olvidé mi contraseña»— de modo que ninguna credencial viaja. Su propio rol **no** se concede desde la aplicación —sólo con `seed-usuarios.sh --administrador-general`— para que una cuenta comprometida no pueda crear más | `90_administrador_general.sql` (5 escenarios, la mitad comprobando lo que **no** puede hacer); `mockRepository.test.ts` › «administrador general (REQ-29)» (6 casos) |
| REQ-30 | Definir y modificar bloques horarios y la capacidad máxima | Implementado | `BloquesSeccion` para el bloque suelto y `SerieBloquesForm` para publicar una temporada entera: `admin_create_block_series` acepta un rango de fechas, varias horas de inicio y días de la semana, interpreta las horas en hora local de Santiago, exige una vista previa antes de escribir y es idempotente (repetirla no duplica); `admin_deactivate_block_series` retira la serie sin cancelar las reservas confirmadas y las informa. Privilegios de columna + RLS sobre `time_blocks`; índice único que impide dos bloques activos con el mismo inicio en un recinto | `60_block_series.sql` (10 escenarios, incluidos hora local, idempotencia y omisión del pasado); `40_rls.sql`; `reservationRules.test.ts` › `validarBloqueHorario` (6 casos) |
| REQ-31 | Consultar reservas vigentes e históricas por recinto | Implementado | `admin_list_reservations(facility_id, scope)`. Devuelve el **nombre** de quien reservó, nunca su correo ni su teléfono | `40_rls.sql` › «admin_list_reservations expone datos personales» (debe fallar) |
| REQ-32 | Cancelar reservas de sus recintos, liberando el cupo y notificando | Implementado | `cancel_reservation()` por la vía de administrador: sin ventana de 2 horas, con motivo obligatoriamente registrado en auditoría | `30_cancellations.sql` › «cancelación administrativa y aviso por correo» |
| REQ-33 | Mostrar el estado de las sincronizaciones externas de cada reserva | Implementado | `admin_integration_report()` + pestaña «Integraciones»: resumen, incidencias y último error de cada cola. Una incidencia en error ya resuelta se **descarta** (`admin_descartar_incidencia`): deja de contar en el informe, pero la fila se conserva con quién la descartó, porque REQ-27 exige poder responder después qué pasó con el mensaje de una reserva | `50_integrations.sql` › «informe de integraciones del administrador» y «descartar incidencias retira del informe sin borrar la fila» (10 aserciones, la mitad sobre quién **no** puede descartar) |

---

## 7. Reglas de negocio

| Regla | Dónde se garantiza |
|---|---|
| No exceder la capacidad máxima del bloque | `create_reservation_strict` con bloqueo de fila. Verificado con 100 solicitudes concurrentes en la verificación automática, y con las que admita el servidor en local |
| Una sola reserva activa por usuario, bloque, fecha y recinto | Comprobación en la función + índice único parcial |
| Sólo administradores asignados gestionan recintos, bloques y capacidades | RLS con `is_facility_admin()` en todas las políticas de escritura |
| Cancelaciones con 2 horas de anticipación mínima | `cancel_reservation`, camino de dueño |
| Sólo el administrador general crea cuentas de administrador y les asigna recintos | `prevent_profile_privilege_escalation` bloquea cualquier otro camino, incluida una escritura directa; `admin_general_asignar_administrador` vuelve a comprobar el rol; crear la cuenta lo hace la Edge Function `crear-administrador`, que verifica el rol contra la base antes de usar la clave de servicio |
| Sólo el dueño o el administrador del recinto cancelan; el administrador sin ventana | `cancel_reservation` decide por el rol real del solicitante |
| Las notificaciones requieren consentimiento y un destino válido | Restricción de tabla, `claim_notification_jobs` filtra por consentimiento vigente, y el worker revalida la dirección antes de enviar |
| La conexión con Calendar es voluntaria y desconectarla no afecta la reserva | `google-calendar-disconnect` sólo toca `calendar_sync_status`; nunca `status` |
| Supabase es la fuente oficial; los estados de integración son informativos | Ningún camino de código cambia `reservations.status` por un fallo externo. Verificado explícitamente en `50_integrations.sql` |
| Sólo usuarios registrados pueden reservar | `auth.uid() IS NULL` lanza; `create_reservation_strict` no está concedida a `anon` |
| Los datos personales nunca se exponen en el cliente | Privilegios por columna, vistas con agregados, informes sin correo ni teléfono. Verificado en `10_schema.sql` y `40_rls.sql` |
| Con menos de 2 horas, sólo confirmación y no recordatorio | `create_reservation_strict`, verificado en ambos lados del límite |

---

## 9. Requerimientos no funcionales

| Requisito | Cómo se aborda | Evidencia |
|---|---|---|
| Elasticidad: 100 usuarios concurrentes sin degradar ni generar sobrecupos | Bloqueo por fila (no por tabla), índices sobre `block_id` y `next_attempt_at`, colas con `SKIP LOCKED` | `test:concurrency`: **100 solicitudes resueltas en 848 ms, 0 sobrecupos**. Cada solicitud simultánea abre su propia conexión, así que la prueba usa las que el servidor admita y **avisa** si fueron menos de 100; con `scripts/db-local.sh` y en la verificación automática caben las 100 |
| Seguridad: contraseñas cifradas, HTTPS/TLS, llaves y tokens sólo en backend, mínimo privilegio | Supabase Auth gestiona las contraseñas; CloudFront fuerza HTTPS; tokens cifrados con AES-256-GCM y columnas sin privilegio de lectura; `REVOKE ALL` y concesiones explícitas por columna | `docs/SEGURIDAD.md`; `10_schema.sql` › «ninguna función de public es ejecutable por anon» |
| Interoperabilidad: APIs oficiales REST/OAuth 2.0, ≥95 % de éxito | Clientes propios contra las APIs oficiales, con clasificación de errores transitorios y reintentos con retroceso | `googleCalendar.test.ts` (23 casos) y `brevoEmail.test.ts` (10 casos) |
| Disponibilidad ≥99 % | Supabase gestionado + CloudFront; las integraciones degradan sin afectar la reserva | `docs/OPERACION.md` (monitoreo y recuperación) |
| Confiabilidad: consistencia ante solicitudes simultáneas; si una integración falla, la reserva se registra y se reintenta | Transacción + colas con reintentos. Un fallo definitivo marca `error` pero **no** toca la reserva | `50_integrations.sql` › «un fallo de Google invalidó la reserva (no debe ocurrir)» |
| Usabilidad: flujo de 4 pasos como máximo | Indicador `PasosReserva` visible: Filtrar → Elegir bloque → Confirmar → Listo | `src/domain/pasosReserva.ts`, `src/components/PasosReserva.tsx` |

---

## 10. Otros requerimientos

| Requisito | Estado |
|---|---|
| Manual técnico de despliegue | `docs/DESPLIEGUE_AWS.md`, `docs/CONFIGURACION_SUPABASE.md` |
| Guía de uso para usuarios y administradores | `docs/GUIA_USUARIO.md`, `docs/GUIA_ADMINISTRADOR.md` |
| Interfaz únicamente en español | Todo el texto visible está en español. Verificado por `errors.test.ts` (ausencia de palabras en inglés en los mensajes traducidos) |
| Linter configurado en el repositorio | ESLint con configuración plana sobre `src/`, `supabase/functions/` y `scripts/`. **La configuración anterior sólo declaraba `files: ["**/*.js"]`, por lo que no revisaba ningún archivo del proyecto**; se corrigió |
| Pruebas automatizadas de las funcionalidades críticas, ejecutadas antes de integrar | 242 pruebas con Vitest + 10 archivos SQL + 6 escenarios de concurrencia. `npm run verify` encadena lint, typecheck, test y build |

---

## Configuración externa pendiente

Lo único que falta para operar en producción. No hay código pendiente.

| Qué | Dónde se carga | Documento |
|---|---|---|
| Proyecto de Supabase (URL y clave `anon`) | `.env` del frontend | `CONFIGURACION_SUPABASE.md` |
| Cadena de conexión a la base de datos | `SUPABASE_DB_URL` del operador | `CONFIGURACION_SUPABASE.md` |
| `ENCRYPTION_KEY` y `CRON_SECRET` | Secretos de Edge Functions | `CONFIGURACION_SUPABASE.md` |
| Cliente OAuth de Google (id, secreto, redirect URI) | Secretos de Edge Functions | `CONFIGURACION_GOOGLE_CALENDAR.md` |
| Cuenta de Brevo y remitente verificado | Secretos de Edge Functions | `CONFIGURACION_CORREO.md` § 6.1 |
| Bucket S3, distribución CloudFront y dominio | Variables del pipeline | `DESPLIEGUE_AWS.md` |
| URLs de redirección de Supabase Auth | Panel de Supabase | `CONFIGURACION_SUPABASE.md` |
| Programación de `pg_cron` | `supabase/cron/schedule.sql`, una vez por entorno | `OPERACION.md` |
| Recintos, bloques y administradores reales | Panel de administración y `scripts/seed-usuarios.sh` | `GUIA_ADMINISTRADOR.md` |

---

## Limitaciones conocidas

Declaradas de forma explícita, sin presentarlas como resueltas:

1. **Las pruebas automatizadas no llaman a las APIs reales de Google ni de
   Brevo**, porque eso exige cuentas con credenciales productivas. Lo que sí
   está verificado en ellas es el contrato completo con `fetch` simulado:
   alcances, idempotencia, clasificación de errores y reintentos. Los dos
   canales **sí** se ejercieron a mano contra las cuentas reales; los pasos
   están en `CONFIGURACION_GOOGLE_CALENDAR.md` y `CONFIGURACION_CORREO.md`.

2. **La programación con `pg_cron` requiere un paso manual por entorno**
   (`supabase/cron/schedule.sql`), porque la URL de las funciones y el
   `CRON_SECRET` son distintos en cada proyecto y no deben versionarse.

3. **Del correo no se sabe si se entregó.** La API de Brevo acepta el envío y
   no informa la entrega, así que el estado final de un envío correcto es
   `enviado`. La cadena para consumir eventos existe (`webhook_events`, con
   antirréplica); lo que falta es la función que los aplique.

4. **Realtime no alcanza a los visitantes anónimos.** Por diseño, `anon` no
   tiene privilegio de lectura sobre `public.reservations`, así que no recibe
   eventos de reservas. El catálogo público se mantiene al día con un refresco
   periódico de 45 segundos; quien ha iniciado sesión sí recibe la actualización
   instantánea.

5. **No hay pruebas de renderizado de componentes.** La suite cubre reglas de
   negocio, criptografía, integraciones y acceso a datos. Añadir pruebas de
   interfaz requeriría `@testing-library/react` y un DOM simulado; se omitió
   deliberadamente para no inflar las dependencias con pruebas de menor valor
   que las de concurrencia y RLS.

---

## Solicitudes de cambio aceptadas

Dos solicitudes posteriores al documento de requerimientos. No llevan
número de REQ porque el cliente no se lo dio; se listan aquí con la
misma exigencia de evidencia que el resto.

### SC-1 · Consulta pública de disponibilidad

**Qué pide.** Que cualquier persona vea recintos, bloques y cupos sin
iniciar sesión. El registro se pide recién al pulsar «reservar», y
después de entrar se vuelve al bloque que había elegido.

**Estado: implementado.**

La consulta pública ya existía: `block_availability` sólo expone
agregados —sin un solo dato personal— y `anon` tiene permiso de lectura
sobre ella, de modo que el catálogo y los filtros funcionan sin cuenta.
Lo que faltaba era la vuelta al bloque: el botón llevaba a `/login` con
destino al catálogo genérico y la persona tenía que buscar su bloque otra
vez.

Ahora el identificador del bloque viaja en el destino
(`/catalogo?bloque=<id>`) y al volver se abre directamente su
confirmación. Si en ese intervalo el bloque se ocupó o pasó su horario,
se dice explícitamente en lugar de abrir un diálogo que fallaría al
confirmar.

La selección se **deriva** de la URL en lugar de escribirse desde un
efecto: así no hay un render intermedio con el diálogo cerrado.

La solicitud dice «el inicio de sesión **o registro**», así que el destino
acompaña a la persona por toda la cadena y no sólo por el inicio de
sesión: `/login` → «crear una cuenta» → `/registro` → el código de
confirmación → el bloque. Antes el enlace a registro perdía el destino y
quien no tenía cuenta acababa igualmente en el catálogo genérico, que es
precisamente el paso que la solicitud quería evitar.

Un único sitio decide si un destino es aceptable (`src/lib/destino.ts`):
sólo rutas internas. Una ruta que empiece por `//` la resuelve el
navegador como otro sitio, de modo que se descarta aunque hoy el valor lo
escriba sólo la propia aplicación.

*Evidencia:* `block_availability` y los privilegios de `anon` en
`40_rls.sql` › «disponibilidad pública sin datos personales»;
`destino.test.ts` (4 casos, incluidos los que no son rutas internas).

### SC-2 · Aviso cuando se libera un cupo

**Qué pide.** Que en un bloque sin cupos se pueda pedir aviso si se
libera uno. Al cancelar alguien, se avisa a quien lo pidió, que reserva
por el flujo normal. El aviso no asegura el cupo.

**Estado: implementado.**

- `block_watchers` registra quién espera qué bloque. Una solicitud se
  **consume** al avisarse, de modo que no se avisa indefinidamente a
  quien ya perdió el interés.
- Sólo se acepta sobre bloques llenos, futuros y en los que la persona no
  tenga ya reserva. Con cupo libre se responde que puede reservar.
- Un disparador por sentencia sobre `reservations` detecta las
  cancelaciones y encola el aviso, pero **sólo si la cancelación dejó
  cupo real**: dos cancelaciones simultáneas no avisan dos veces por el
  mismo hueco.
- El aviso sale si la persona tiene consentidas las notificaciones en
  «Datos personales», que es la misma decisión que gobierna la
  confirmación y el recordatorio.
- El texto dice explícitamente que el cupo **todavía no es suyo**:
  prometer lo contrario sería engañoso, y el cupo lo toma quien reserve
  primero.
- Sin consentimiento la solicitud se consume igualmente: dejarla
  pendiente la haría reaparecer en cada cancelación futura.

*Evidencia:* `95_aviso_cupo_liberado.sql` (5 escenarios, incluidos el de
no avisar dos veces y el de consumir la solicitud sin canal);
`mockRepository.test.ts` › «aviso de cupo liberado» (5 casos).

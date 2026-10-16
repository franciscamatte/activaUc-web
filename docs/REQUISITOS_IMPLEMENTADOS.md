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
| REQ-1 | Registro con nombre, correo único y contraseña de largo mínimo | Implementado | `src/pages/RegistroPage.tsx`, `SupabaseRepository.registrarse`, disparador `handle_new_user` en `20261016000100_core_schema.sql` | Unicidad del correo: Supabase Auth. Largo mínimo validado en cliente y en `signUp`. `mockRepository.test.ts` › «sesión» |
| REQ-2 | Autenticación con correo y contraseña | Implementado | `src/pages/LoginPage.tsx`, `signInWithPassword`, sesión persistente con renovación automática (`src/lib/supabase.ts`) | `mockRepository.test.ts` › «inicia y cierra sesión» |
| REQ-3 | Autenticación diferenciada de administradores | Implementado | Mismo flujo de ingreso; la diferencia la hace `profiles.role`, que **no es modificable desde el cliente** (privilegio de columna + disparador `prevent_profile_privilege_escalation`) | `40_rls.sql` › «no puede escalar su rol» |
| REQ-4 | Diferenciación entre administrador y usuario | Implementado | `ProtectedRoute` en la interfaz; `is_admin()` e `is_facility_admin()` en RLS y en cada función de administración | `40_rls.sql` › «administrador acotado a sus recintos asignados» |
| REQ-5 | Manejo de errores de autenticación con la razón | Implementado | `src/lib/errors.ts` traduce cada error de Supabase a un mensaje en español específico (credenciales, correo sin confirmar, correo en uso, contraseña débil) | `errors.test.ts` (21 casos, incluye «ningún mensaje contiene texto en inglés») |
| REQ-6 | Recuperación de contraseña por enlace al correo | Implementado | `RecuperarPasswordPage` → `resetPasswordForEmail`; `RestablecerPasswordPage` → `updateUser`. Respuesta idéntica exista o no la cuenta, para no revelar correos registrados | Enlace probado en el buzón local (`supabase start`, puerto 54324) |
| REQ-7 | Ver y actualizar datos personales | Implementado | `src/pages/DatosPersonalesPage.tsx`. El nombre se actualiza con privilegio de columna `update (full_name)`; el teléfono pasa por `set_whatsapp_consent()` | `40_rls.sql` › «puede actualizar su propio nombre», `mockRepository.test.ts` › «actualiza el nombre» |

---

## 6.2 Consulta de disponibilidad

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-8 | Listado de recintos con descripción, capacidad y horario | Implementado | Vista `public.block_availability`; `CatalogoPage` | `mockRepository.test.ts` › «lista recintos activos» |
| REQ-9 | Cupos actualizados en tiempo real | Implementado | Supabase Realtime sobre `reservations`, `time_blocks` y `facilities` (`20261016000400_realtime_and_cron.sql`, `useDisponibilidad.ts`), con respaldo por intervalo de 45 s y refresco al recuperar foco o conexión | `20_reservations.sql` comprueba los conteos de la vista; el indicador «Actualización en vivo activa» refleja el estado real |
| REQ-10 | Filtros por fecha, tipo de recinto y bloque horario, específicos o por rango | Implementado | `CatalogoPage` (6 filtros: fecha desde/hasta, tipo, recinto, hora desde/hasta, sólo con cupos). Fecha, tipo y recinto se filtran en PostgreSQL; el rango horario en el cliente, por la zona de presentación | `reservationRules.test.ts` › `dentroDelRangoHorario` (6 casos, incluye zona horaria), `mockRepository.test.ts` › «disponibilidad y filtros» |
| REQ-11 | Indicar explícitamente los bloques sin cupos e impedir su selección | Implementado | `block_availability.is_full`; `InsigniaCupos` muestra «Sin cupos»; el botón queda deshabilitado con el motivo asociado por `aria-describedby`. El backend **vuelve a rechazar** con `error: "sin_cupos"` | `20_reservations.sql` › «capacidad, duplicados y agotamiento`; `reservationRules.test.ts` › `puedeReservarBloque` |

---

## 6.3 Gestión de reservas

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-12 | Crear reserva validando la capacidad máxima | Implementado | `create_reservation_strict()` en `20261016000200_functions.sql` | `20_reservations.sql`; `test:concurrency` escenario 2: **100 solicitudes sobre capacidad 20 → exactamente 20 reservas** |
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
| REQ-18 | Crear el evento al confirmarse la reserva, si hay conexión | Implementado | `create_reservation_strict` encola `crear_evento`; el worker `process-calendar-jobs` lo ejecuta | `50_integrations.sql` › «sincronización exitosa con Google Calendar» |
| REQ-19 | Eliminar el evento al cancelarse la reserva | Implementado | `cancel_reservation` encola `eliminar_evento` sólo si el evento existe o puede existir; si el trabajo de creación aún no corrió, lo cancela en lugar de encolar un borrado inútil | `30_cancellations.sql` › «encolado de eliminación de eventos de Calendar» (casos A y B) |
| REQ-20 | Sincronización automática con reintentos y colas | Implementado | Tablas `calendar_sync_jobs` y `notification_jobs`; `claim_*` con `FOR UPDATE SKIP LOCKED`; retroceso exponencial (30 s, 60 s, 120 s…), tope de 5 intentos; rescate de trabajos huérfanos a los 10 min. Idempotencia por id de evento derivado del id de la reserva: un reintento recibe 409 de Google y se trata como éxito. El despacho no espera al cron: cuatro disparadores por sentencia invocan el worker al encolar, y el evento aparece en ~2 s (medido); el cron queda como red de seguridad para reintentos, recordatorios futuros y huérfanos | `50_integrations.sql` › «reintentos, backoff y tope de intentos», «recuperación de trabajos interrumpidos»; `70_despacho_inmediato.sql` › «un fallo del despacho no impide reservar»; `googleCalendar.test.ts` › «un 409 es éxito, no duplicación» |
| REQ-21 | Reconocer el estado de sincronización: sincronizado, pendiente o con error | Implementado | `reservations.calendar_sync_status` (`no_aplica`, `pendiente`, `sincronizado`, `error`). La interfaz **nunca** muestra «sincronizado» sin que `complete_calendar_job` lo haya registrado | `50_integrations.sql`; `mockRepository.test.ts` › «no reporta sincronización con Calendar si no hay conexión» |

---

## 6.5 Notificaciones y recordatorios por WhatsApp

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-22 | Registrar teléfono con consentimiento explícito | Implementado | `set_whatsapp_consent()`. Restricciones en la tabla: formato E.164 y `whatsapp_consent = false OR phone IS NOT NULL`. Desde la migración 08 hay un segundo canal, el correo, con `set_email_consent()` y su propio consentimiento: la persona elige WhatsApp, correo, ambos o ninguno. La dirección no se duplica en `profiles`, se lee de `auth.users` | `10_schema.sql` › «restricciones de datos personales»; `80_canal_correo.sql` (6 escenarios); `phone.test.ts` (20 casos) |
| REQ-23 | Revocar el consentimiento o eliminar el teléfono, deteniendo los envíos | Implementado | La misma función borra el teléfono, apaga el consentimiento y **cancela los trabajos pendientes**. El worker tampoco reclama trabajos de usuarios sin consentimiento vigente | `50_integrations.sql` › «revocación de consentimiento y validación E.164» |
| REQ-24 | Confirmación al crear la reserva | Implementado | Trabajo `confirmacion` encolado para ejecución inmediata, uno por cada canal consentido (`private.encolar_notificacion`); `process-notification-jobs` lo envía por la API de Mensajes o la de Correo de Twilio según el canal. Ejercido contra la cuenta real el 16/10/2026: WhatsApp en 2 s, correo en 3 s | `50_integrations.sql` › «cola de WhatsApp, trazabilidad e idempotencia»; `80_canal_correo.sql` |
| REQ-25 | Recordatorio 2 h antes; si la reserva se crea con menos de 2 h, sólo confirmación | Implementado | `scheduled_for = starts_at - 2 horas`; si ese instante ya pasó, **no se encola nada** | `20_reservations.sql` › «regla exacta del recordatorio de 2 horas» (ambos lados del límite); `reservationRules.test.ts` › `tendraRecordatorio` |
| REQ-26 | Notificar al usuario cuando el administrador cancela | Implementado | `cancel_reservation` encola `cancelacion_admin` con el motivo, sólo si hay consentimiento vigente | `30_cancellations.sql` › «cancelación administrativa y aviso por WhatsApp» |
| REQ-27 | Registrar el estado de cada mensaje para trazabilidad | Implementado | Tabla `whatsapp_messages` (`pendiente`, `enviado`, `entregado`, `fallido`, `omitido`) + webhook `twilio-status-webhook` con validación de firma, idempotencia por `(provider, external_id, event_type)` y sin retroceso de «entregado» | `50_integrations.sql`; `twilioWhatsapp.test.ts` › «autenticación del webhook» (8 casos, incluye manipulación y reenvío cruzado) |

---

## 6.6 Panel de administración

| Req | Descripción | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| REQ-28 | Crear, actualizar y eliminar los recintos a cargo | Implementado | `admin_create_facility()` (crea y autoasigna de forma atómica); edición por RLS. La baja es **lógica** (`active = false`) para preservar el historial de reservas | `40_rls.sql` › «no puede editar un recinto ajeno»; `mockRepository.test.ts` › «administración» |
| REQ-29 | Asociar cada administrador a uno o más recintos y restringir su gestión | Implementado | `facility_admin_assignments` + `is_facility_admin()` en todas las políticas y funciones de administración | `40_rls.sql` › «el administrador modificó un recinto que no administra» (debe fallar); `30_cancellations.sql` › «un administrador no asignado pudo intentar cancelar» (debe fallar) |
| REQ-30 | Definir y modificar bloques horarios y la capacidad máxima | Implementado | `BloquesSeccion` para el bloque suelto y `SerieBloquesForm` para publicar una temporada entera: `admin_create_block_series` acepta un rango de fechas, varias horas de inicio y días de la semana, interpreta las horas en hora local de Santiago, exige una vista previa antes de escribir y es idempotente (repetirla no duplica); `admin_deactivate_block_series` retira la serie sin cancelar las reservas confirmadas y las informa. Privilegios de columna + RLS sobre `time_blocks`; índice único que impide dos bloques activos con el mismo inicio en un recinto | `60_block_series.sql` (10 escenarios, incluidos hora local, idempotencia y omisión del pasado); `40_rls.sql`; `reservationRules.test.ts` › `validarBloqueHorario` (6 casos) |
| REQ-31 | Consultar reservas vigentes e históricas por recinto | Implementado | `admin_list_reservations(facility_id, scope)`. Devuelve el **nombre** de quien reservó, nunca su correo ni su teléfono | `40_rls.sql` › «admin_list_reservations expone datos personales» (debe fallar) |
| REQ-32 | Cancelar reservas de sus recintos, liberando el cupo y notificando | Implementado | `cancel_reservation()` por la vía de administrador: sin ventana de 2 horas, con motivo obligatoriamente registrado en auditoría | `30_cancellations.sql` › «cancelación administrativa y aviso por WhatsApp» |
| REQ-33 | Mostrar el estado de las sincronizaciones externas de cada reserva | Implementado | `admin_integration_report()` + pestaña «Integraciones»: resumen, incidencias y último error de cada cola | `50_integrations.sql` › «informe de integraciones del administrador» |

---

## 7. Reglas de negocio

| Regla | Dónde se garantiza |
|---|---|
| No exceder la capacidad máxima del bloque | `create_reservation_strict` con bloqueo de fila. Verificado con 100 solicitudes concurrentes |
| Una sola reserva activa por usuario, bloque, fecha y recinto | Comprobación en la función + índice único parcial |
| Sólo administradores asignados gestionan recintos, bloques y capacidades | RLS con `is_facility_admin()` en todas las políticas de escritura |
| Cancelaciones con 2 horas de anticipación mínima | `cancel_reservation`, camino de dueño |
| Sólo el dueño o el administrador del recinto cancelan; el administrador sin ventana | `cancel_reservation` decide por el rol real del solicitante |
| WhatsApp requiere consentimiento y número válido | Restricción de tabla, `claim_notification_jobs` filtra por consentimiento, y el worker revalida E.164 |
| La conexión con Calendar es voluntaria y desconectarla no afecta la reserva | `google-calendar-disconnect` sólo toca `calendar_sync_status`; nunca `status` |
| Supabase es la fuente oficial; los estados de integración son informativos | Ningún camino de código cambia `reservations.status` por un fallo externo. Verificado explícitamente en `50_integrations.sql` |
| Sólo usuarios registrados pueden reservar | `auth.uid() IS NULL` lanza; `create_reservation_strict` no está concedida a `anon` |
| Los datos personales nunca se exponen en el cliente | Privilegios por columna, vistas con agregados, informes sin correo ni teléfono. Verificado en `10_schema.sql` y `40_rls.sql` |
| Con menos de 2 horas, sólo confirmación y no recordatorio | `create_reservation_strict`, verificado en ambos lados del límite |

---

## 9. Requerimientos no funcionales

| Requisito | Cómo se aborda | Evidencia |
|---|---|---|
| Elasticidad: 100 usuarios concurrentes sin degradar ni generar sobrecupos | Bloqueo por fila (no por tabla), índices sobre `block_id` y `next_attempt_at`, colas con `SKIP LOCKED` | `test:concurrency`: 100 solicitudes resueltas en ~800 ms, 0 sobrecupos |
| Seguridad: contraseñas cifradas, HTTPS/TLS, llaves y tokens sólo en backend, mínimo privilegio | Supabase Auth gestiona las contraseñas; CloudFront fuerza HTTPS; tokens cifrados con AES-256-GCM y columnas sin privilegio de lectura; `REVOKE ALL` y concesiones explícitas por columna | `docs/SEGURIDAD.md`; `10_schema.sql` › «ninguna función de public es ejecutable por anon» |
| Interoperabilidad: APIs oficiales REST/OAuth 2.0, ≥95 % de éxito | Clientes propios contra las APIs oficiales, con clasificación de errores transitorios y reintentos con retroceso | `googleCalendar.test.ts`, `twilioWhatsapp.test.ts` (58 casos combinados) |
| Disponibilidad ≥99 % | Supabase gestionado + CloudFront; las integraciones degradan sin afectar la reserva | `docs/OPERACION.md` (monitoreo y recuperación) |
| Confiabilidad: consistencia ante solicitudes simultáneas; si una integración falla, la reserva se registra y se reintenta | Transacción + colas con reintentos. Un fallo definitivo marca `error` pero **no** toca la reserva | `50_integrations.sql` › «un fallo de Google invalidó la reserva (no debe ocurrir)» |
| Usabilidad: flujo de 4 pasos como máximo | Indicador `PasosReserva` visible: Filtrar → Elegir bloque → Confirmar → Listo | `src/domain/pasosReserva.ts`, `src/components/PasosReserva.tsx` |

---

## 10. Otros requerimientos

| Requisito | Estado |
|---|---|
| Manual técnico de despliegue | `docs/DESPLIEGUE_AWS.md`, `docs/CONFIGURACION_SUPABASE.md` |
| Guía de uso para usuarios y administradores | `docs/GUIA_USUARIO.md`, `docs/GUIA_ADMINISTRADOR.md` |
| Interfaz únicamente en español | Todo el texto visible está en español. Verificado por `errors.test.ts` (ausencia de palabras en inglés en los mensajes traducidos) y por una prueba equivalente sobre las plantillas de WhatsApp |
| Linter configurado en el repositorio | ESLint con configuración plana sobre `src/`, `supabase/functions/` y `scripts/`. **La configuración anterior sólo declaraba `files: ["**/*.js"]`, por lo que no revisaba ningún archivo del proyecto**; se corrigió |
| Pruebas automatizadas de las funcionalidades críticas, ejecutadas antes de integrar | 233 pruebas con Vitest + 8 archivos SQL + 6 escenarios de concurrencia. `npm run verify` encadena lint, typecheck, test y build |

---

## Configuración externa pendiente

Lo único que falta para operar en producción. No hay código pendiente.

| Qué | Dónde se carga | Documento |
|---|---|---|
| Proyecto de Supabase (URL y clave `anon`) | `.env` del frontend | `CONFIGURACION_SUPABASE.md` |
| Cadena de conexión a la base de datos | `SUPABASE_DB_URL` del operador | `CONFIGURACION_SUPABASE.md` |
| `ENCRYPTION_KEY` y `CRON_SECRET` | Secretos de Edge Functions | `CONFIGURACION_SUPABASE.md` |
| Cliente OAuth de Google (id, secreto, redirect URI) | Secretos de Edge Functions | `CONFIGURACION_GOOGLE_CALENDAR.md` |
| Cuenta de Twilio, emisor de WhatsApp y plantillas aprobadas | Secretos de Edge Functions | `CONFIGURACION_TWILIO_WHATSAPP.md` |
| Bucket S3, distribución CloudFront y dominio | Variables del pipeline | `DESPLIEGUE_AWS.md` |
| URLs de redirección de Supabase Auth | Panel de Supabase | `CONFIGURACION_SUPABASE.md` |
| Programación de `pg_cron` | `supabase/cron/schedule.sql`, una vez por entorno | `OPERACION.md` |
| Recintos, bloques y administradores reales | Panel de administración y `scripts/seed-usuarios.sh` | `GUIA_ADMINISTRADOR.md` |

---

## Limitaciones conocidas

Declaradas de forma explícita, sin presentarlas como resueltas:

1. **Las integraciones no se han ejercido contra las APIs reales de Google y
   Twilio**, porque eso exige cuentas con credenciales productivas. Lo que sí
   está verificado es el contrato completo con `fetch` simulado: alcances,
   idempotencia, clasificación de errores, reintentos y validación de firma.
   Los pasos de verificación con las cuentas reales están en
   `CONFIGURACION_GOOGLE_CALENDAR.md` y `CONFIGURACION_TWILIO_WHATSAPP.md`.

2. **La programación con `pg_cron` requiere un paso manual por entorno**
   (`supabase/cron/schedule.sql`), porque la URL de las funciones y el
   `CRON_SECRET` son distintos en cada proyecto y no deben versionarse.

3. **En producción, WhatsApp exige plantillas aprobadas por Meta.** El código
   admite ambos caminos (plantilla aprobada por `ContentSid`, o texto libre para
   el Sandbox), pero la aprobación de las plantillas es un trámite externo.

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

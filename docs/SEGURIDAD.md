# Seguridad

Modelo de seguridad de ActivaUC y resultado de la revisión aplicada.

---

## 1. Principios

1. **El cliente no es de confianza.** El navegador no tiene privilegio de
   `INSERT`, `UPDATE` ni `DELETE` sobre `public.reservations`. Las validaciones
   del frontend existen para dar retroalimentación inmediata, no para autorizar.
2. **Mínimo privilegio, columna por columna.** La migración de RLS empieza con
   `REVOKE ALL ... FROM anon, authenticated` y vuelve a conceder sólo lo
   necesario, por columna.
3. **Los secretos no cruzan al navegador.** El cliente conoce la URL del
   proyecto y la clave `anon`, nada más.
4. **Un fallo de integración no compromete los datos.** Supabase es la fuente
   oficial; Google Calendar y WhatsApp son informativos.
5. **Lo que se registra no identifica a nadie.** Teléfonos enmascarados, correos
   reducidos al dominio, tokens nunca.

---

## 2. Autenticación y sesiones

| Aspecto | Implementación |
|---|---|
| Contraseñas | Las gestiona Supabase Auth (bcrypt). ActivaUC nunca las ve ni las almacena |
| Largo mínimo | 8 caracteres, validado en cliente, en `signUp` y en la configuración de Auth |
| Confirmación de correo | Obligatoria: la cuenta no puede iniciar sesión sin confirmar |
| Recuperación | Enlace de un solo uso con vencimiento. **La respuesta es idéntica exista o no la cuenta**, para no revelar qué correos están registrados |
| Persistencia | Sesión en almacenamiento local con renovación automática del token |
| Rotación del refresh token | Activada: un token robado deja de servir cuando el legítimo rota |
| Caducidad por inactividad | 72 h. La aplicación distingue un cierre voluntario de una sesión caducada y lo informa |
| Transporte | HTTPS obligatorio (CloudFront redirige HTTP) y WSS para Realtime |

### Escalada de privilegios: dos barreras

El rol de administrador es el privilegio más valioso del sistema, así que está
protegido dos veces:

1. **Privilegio de columna.** A `authenticated` sólo se le concede
   `UPDATE (full_name)` sobre `public.profiles`. Un `UPDATE ... SET role` falla
   con «permiso denegado» antes de evaluar RLS.
2. **Disparador.** `prevent_profile_privilege_escalation` rechaza cualquier
   cambio de `role` cuando hay un JWT presente, incluso si alguien concediera el
   privilegio por error.

Un operador con acceso directo a la base sí puede asignar el rol (no hay JWT en
ese contexto), que es la vía prevista: `scripts/seed-usuarios.sh`.

Verificado en `supabase/tests/40_rls.sql` › «no puede escalar su rol».

---

## 3. Autorización (RLS)

### Quién ve qué

| Tabla | `anon` | Usuario | Administrador asignado |
|---|---|---|---|
| `profiles` | nada | sólo el propio | sólo el propio |
| `facilities` | sólo activos | sólo activos | los suyos, incluidos inactivos |
| `time_blocks` | activos de recintos activos | idem | los de sus recintos |
| `reservations` | **nada** | sólo las propias | las de sus recintos |
| `block_availability` (vista) | **sí, sólo agregados** | sí | sí |
| `calendar_connections` | nada | su estado, **sin los tokens** | nada |
| `oauth_states` | nada | nada | nada |
| `calendar_sync_jobs` | nada | el estado de los propios | los de sus recintos |
| `notification_jobs` | nada | el estado de los propios | los de sus recintos |
| `whatsapp_messages` | nada | los propios | estado sí, **`to_phone` no** |
| `webhook_events` | nada | nada | nada |
| `rate_limit_counters` | nada | nada | nada |

### Cómo ve el público la disponibilidad sin ver reservas

`anon` no tiene privilegio de lectura sobre `public.reservations`. La
disponibilidad se expone con la vista `public.block_availability`, creada con
`security_invoker = false`: cuenta las reservas con los privilegios del
propietario y devuelve **sólo agregados** (`reserved_count`, `available_count`,
`is_full`). No contiene `user_id` ni ningún dato personal.

Hay una prueba que falla si alguien agrega una columna de ese tipo a la vista.

### Escrituras: una sola puerta

`anon` y `authenticated` no tienen `INSERT`, `UPDATE` ni `DELETE` sobre
`reservations`. Las únicas vías son dos funciones `SECURITY DEFINER`:

- `create_reservation_strict(block_id)`
- `cancel_reservation(reservation_id, reason)`

`cancel_reservation` decide por el **rol real del solicitante**, consultado
contra `facility_admin_assignments`, nunca por un parámetro del cliente. No
existe forma de pedir «cancélala como administrador».

### El detalle que es fácil pasar por alto

PostgreSQL concede `EXECUTE` a `PUBLIC` en **toda función nueva**, y `anon`
hereda ese privilegio. Revocar sólo «from anon» no sirve de nada.

Esto se detectó durante el desarrollo precisamente porque hay una prueba que lo
busca, y se corrigió revocando primero `FROM public, anon` y concediendo después
de forma explícita a `authenticated`.

```sql
-- Debe devolver cero filas. Está en supabase/tests/10_schema.sql
select p.proname from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
```

### Funciones SECURITY DEFINER

Todas fijan `search_path = ''` y cualifican cada referencia. Sin eso, quien
pudiera crear objetos en un esquema del `search_path` podría secuestrar una
llamada interna y ejecutar código con los privilegios del propietario.

Hay una prueba que recorre `pg_proc` y falla si alguna función `SECURITY
DEFINER` de `public` o `private` no lo fija.

---

## 4. Datos personales

La regla de negocio es explícita: el correo y el teléfono **nunca deben
exponerse en el cliente web**.

| Dato | Dónde vive | Quién lo ve |
|---|---|---|
| Correo | `auth.users` | Sólo su dueño, desde su propia sesión |
| Teléfono | `profiles.phone`, con restricción E.164 | Sólo su dueño. Nadie más, ni el personal administrativo |
| Nombre | `profiles.full_name` | Su dueño y el administrador del recinto donde reservó |

### El panel de administración

`admin_list_reservations()` devuelve el **nombre** de quien reservó, porque el
personal necesita saber a quién corresponde cada cupo. No devuelve el correo ni
el teléfono: no hacen falta para gestionar un recinto.

En `whatsapp_messages`, la columna `to_phone` no está en el `GRANT` para
`authenticated`, así que ni el administrador puede leerla con un `select *`.

Verificado en `40_rls.sql`:

```sql
begin
  perform to_phone from public.whatsapp_messages;
  assert false, 'El administrador pudo leer to_phone';
exception when insufficient_privilege then null;
end;
```

### Consentimiento

- Registrar un teléfono exige consentimiento explícito. La base lo impone:
  `check (whatsapp_consent = false or phone is not null)`.
- Revocar borra el teléfono, apaga el consentimiento y **cancela los trabajos de
  notificación pendientes**.
- El worker tampoco reclama trabajos de usuarios sin consentimiento vigente: no
  depende de que la cancelación haya ocurrido.
- Todo cambio de consentimiento queda auditado, con los últimos 4 dígitos del
  número y nunca el número completo.

---

## 5. Secretos

### Qué conoce cada capa

| Capa | Conoce |
|---|---|
| Navegador | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_URL`, `VITE_TIME_ZONE` |
| Edge Functions | `ENCRYPTION_KEY`, `CRON_SECRET`, credenciales de Google y Twilio, `SUPABASE_SERVICE_ROLE_KEY` (inyectada) |
| Base de datos | `private.app_config`: URL de las funciones y `CRON_SECRET`, en un esquema sin acceso para `anon` ni `authenticated` |

No existe ninguna variable `VITE_GOOGLE_*` ni `VITE_TWILIO_*`, y no debe
existir: `VITE_*` se incrusta en el paquete JavaScript.

### Defensa contra el error más costoso

Pegar la `service_role` key donde va la `anon` publicaría una credencial que
omite por completo RLS. Hay tres barreras:

1. `src/lib/env.ts` decodifica el JWT y, si el claim `role` es `service_role`,
   la aplicación muestra una pantalla de error de configuración y no arranca.
2. `scripts/deploy-frontend.sh` hace la misma comprobación antes de compilar.
3. El mismo script, tras compilar, extrae **todos** los JWT del paquete, decodifica
   cada payload y aborta si alguno tiene `role: service_role`.

El escáner busca **valores** con forma de secreto, no nombres de variables: el
código menciona legítimamente la cadena `"service_role"` (es la comprobación
anterior) y los comentarios citan los nombres de los secretos. Un escáner que
busque nombres da falsos positivos en cada despliegue, que es la forma más
rápida de que nadie vuelva a mirar la alerta.

Verificado en los dos sentidos: con el paquete real no encuentra nada, y con una
clave de prueba inyectada aborta con código 1.

### Tokens OAuth en reposo

- Cifrados con **AES-256-GCM** antes de guardarse, con un vector de
  inicialización aleatorio por operación.
- El formato lleva versión (`v1.<iv>.<ciphertext>`) para permitir rotar el
  algoritmo.
- GCM es autenticado: alterar un byte del texto cifrado hace fallar el
  descifrado. Verificado con una prueba que altera deliberadamente un byte.
- Las columnas no están en ningún `GRANT` para roles del cliente.
- `ENCRYPTION_KEY` debe medir exactamente 32 bytes; `scripts/set-secrets.sh` lo
  comprueba antes de cargar, porque una clave corta haría fallar el cifrado
  recién en tiempo de ejecución.

---

## 6. Flujo OAuth

| Amenaza | Mitigación |
|---|---|
| **CSRF**: inducir a alguien a completar un flujo ajeno | El `state` es `<nonce>.<userId>.<HMAC-SHA256>`, firmado con `ENCRYPTION_KEY`. El callback verifica la firma **antes** de consultar la base: un `state` fabricado se descarta sin coste |
| **Vinculación de cuenta ajena**: cambiar el `userId` del `state` | El `userId` está dentro del contenido firmado. Alterarlo invalida la firma. Hay una prueba específica de este ataque |
| **Replay**: reutilizar un `state` capturado | Se marca como consumido con un `UPDATE ... WHERE consumed_at IS NULL` atómico: sólo una petición puede ganarlo |
| **State robado de la base** | Sólo se persiste el SHA-256 del nonce. El valor que la firma necesita nunca está almacenado |
| **Ventana de ataque** | El `state` vence a los 10 minutos |
| **Exceso de permisos** | Único alcance de escritura: `calendar.events`. Una prueba falla si alguien agrega un permiso más amplio |
| **Fuga por la URL** | El callback redirige con un resultado legible (`?calendar=conectado`), nunca con tokens |
| **Abuso del endpoint** | Límite de 5 inicios de OAuth por minuto y usuario |

---

## 7. Webhooks

`twilio-status-webhook` es público porque lo llama Twilio, pero nunca sin
autenticar:

1. **Firma.** Valida `X-Twilio-Signature` (HMAC-SHA1 del URL más los pares
   ordenados) con comparación en tiempo constante. Sin firma válida responde
   `403` y no toca la base.
2. **Idempotencia y anti-replay.** `register_webhook_event` tiene una
   restricción única sobre `(provider, external_id, event_type)`. Una reentrega
   del mismo evento se descarta y responde `200`, para que Twilio no reintente
   indefinidamente.
3. **Sin retroceso de estado.** Un `sent` que llega después de un `delivered` no
   degrada el mensaje.
4. **Entradas acotadas.** Los estados desconocidos se ignoran; el payload que se
   guarda lleva el teléfono enmascarado.

Casos verificados en `src/test/twilioWhatsapp.test.ts`: firma ausente,
inventada, de otro Auth Token, **de otra URL** (lo que impediría reenviar una
solicitud legítima a otro endpoint), con un parámetro alterado y con un
parámetro añadido.

Los workers de integración no son endpoints públicos: exigen `x-cron-secret` o
la service role key, comparados en tiempo constante. Si `CRON_SECRET` no está
configurado, rechazan todo: es preferible que el worker no funcione a que quede
abierto.

---

## 8. Validación de entradas

| Entrada | Validación |
|---|---|
| Teléfono | `^\+[1-9][0-9]{7,14}$` en **tres** capas: restricción `CHECK`, función SQL y worker. El worker revalida antes de enviar, sin confiar en un único control |
| Capacidad de bloque | `CHECK (max_capacity between 1 and 1000)` |
| Rango del bloque | `CHECK (ends_at > starts_at)` y duración máxima de 12 h |
| Nombres | Largo entre 2 y 120 caracteres |
| Motivo de cancelación | Máximo 500 caracteres |
| `redirect_path` de OAuth | `CHECK (redirect_path ~ '^/[A-Za-z0-9/_-]*$')`: impide redirección abierta |
| Identificadores | Tipo `uuid`: un valor no-UUID se rechaza antes de llegar a la consulta |
| Consistencia de cancelación | `CHECK`: `status = 'cancelada'` exige `cancelled_at`, y `vigente` exige que sea nulo |

### Inyección SQL

No hay ninguna consulta construida por concatenación de cadenas:

- El frontend usa el cliente de Supabase, que parametriza todo.
- Las funciones SQL reciben parámetros tipados.
- Los únicos `EXECUTE` dinámicos están en `20261016000400_realtime_and_cron.sql`
  (`format('alter publication ... add table public.%I', _t)`), sobre una lista
  de nombres fija del propio archivo, con `%I` que cita el identificador.

### XSS

React escapa el contenido por omisión. No se usa `dangerouslySetInnerHTML` en
ninguna parte del proyecto, ni `innerHTML`, ni `eval` (ESLint prohíbe `no-eval`
y `no-implied-eval`). La CSP recomendada en `DESPLIEGUE_AWS.md` acota
`script-src` a `'self'`.

---

## 9. Límite de uso

`public.consume_rate_limit(bucket, subject, limit, window)` con ventana fija:

| Acción | Límite |
|---|---|
| Crear reserva | 20 por minuto y usuario |
| Cancelar reserva | 30 por minuto y usuario |
| Iniciar OAuth | 5 por minuto y usuario |

El límite se aplica **dentro de la función transaccional**, por `auth.uid()`, no
por dirección IP: cambiar de red no lo elude. Supabase aplica además sus propios
límites sobre Auth.

Los contadores se limpian de forma oportunista y por la tarea horaria.

---

## 10. CORS

Las Edge Functions no responden con `Access-Control-Allow-Origin: *`. La lista
blanca viene de `APP_ALLOWED_ORIGINS` (o, en su defecto, `APP_URL`), y el
encabezado se emite sólo si el `Origin` de la solicitud coincide. Se incluye
`Vary: Origin` para que una caché intermedia no sirva la respuesta de un origen
a otro.

---

## 11. Resultado de la revisión

Revisión del requisito 15 del encargo, con los hallazgos reales.

| Punto | Resultado |
|---|---|
| Secretos hardcodeados en el código | **Ninguno.** Búsqueda de patrones de JWT, `GOCSPX-`, `sk_live`, SID de Twilio y claves de SendGrid en `src/`, `supabase/` y `scripts/` |
| Tokens en el frontend | **Ninguno.** `Deno.env` no aparece en `src/`; no hay variables `VITE_*` de Google ni Twilio |
| Service role key expuesta | **No.** Triple barrera (arranque, pre-compilación, post-compilación). Escáner verificado en ambos sentidos |
| Auth Token de Twilio expuesto | **No.** Sólo se usa en `process-notification-jobs` y en la validación de firma del webhook |
| Llamadas directas a Google o Twilio desde el navegador | **Ninguna.** Verificado buscando `googleapis.com`, `api.twilio.com` y `accounts.google.com` en `src/` |
| Registros con datos sensibles | **Redacción obligatoria** en `_shared/log.ts`: claves con nombre sensible se reemplazan, teléfonos se reducen a 4 dígitos, correos al dominio |
| XSS | Sin `dangerouslySetInnerHTML`, `innerHTML` ni `eval`. CSP documentada |
| Validación de entradas | En tres capas para el teléfono; restricciones `CHECK` para el resto |
| CORS | Lista blanca por origen, con `Vary: Origin` |
| CSRF en OAuth | `state` firmado, de un solo uso, con vencimiento. Prueba específica de suplantación de usuario |
| Webhooks sin autenticar | **Ninguno.** El de Twilio valida firma; los workers exigen `CRON_SECRET` |
| Replay | Restricción única en `webhook_events`; consumo atómico de `oauth_states` |
| Idempotencia | Claves determinísticas en ambas colas; id de evento derivado del id de reserva |
| Permisos RLS | 13 tablas con RLS; privilegios por columna; verificado con los roles reales en `40_rls.sql` |
| Acceso administrativo | Acotado a `facility_admin_assignments` en toda política y función |
| Filtración de teléfonos y correos | `to_phone` fuera del `GRANT`; informes sin datos personales; pruebas que fallan si eso cambia |
| Inyección SQL | Todo parametrizado; único `EXECUTE` dinámico sobre una lista fija con `%I` |
| Abuso de endpoints | Límite por usuario en las tres acciones sensibles |

### Hallazgos corregidos durante la revisión

Se dejan registrados porque eran reales:

1. **Funciones ejecutables por `anon`.** PostgreSQL concede `EXECUTE` a
   `PUBLIC` en cada función nueva. El `REVOKE ... FROM anon` inicial no tenía
   efecto porque `anon` hereda de `PUBLIC`. Se corrigió revocando
   `FROM public, anon` y concediendo luego a `authenticated`. Hay una prueba que
   lo impide a futuro.

2. **ESLint no revisaba nada.** La configuración declaraba
   `files: ["**/*.js"]`, y todo el código es `.ts`/`.tsx`. Al corregirla
   aparecieron errores reales (incluido un `setState` en un efecto que provocaba
   renders en cascada), que se arreglaron.

3. **Error de tipos en `fail_notification_job`.** Un `CASE` con dos ramas de
   literal sin tipo producía `text` donde se esperaba el enum `job_status`, de
   modo que **registrar un fallo de WhatsApp habría fallado en tiempo de
   ejecución**. Lo detectó `supabase/tests/50_integrations.sql`.

4. **`ORDER BY` inválido tras `UNION ALL`** en `admin_integration_report`: el
   informe de integraciones del panel habría fallado siempre. Detectado por las
   pruebas SQL.

5. **Escáner de secretos con falsos positivos.** La primera versión buscaba
   nombres de variables, así que el propio código de defensa y los comentarios
   lo activaban: habría abortado cada despliegue. Se reescribió para buscar
   valores con forma de secreto, y se verificó que detecta una clave inyectada.

6. **Scripts con fin de línea CRLF.** Al escribirse desde Windows quedaron con
   CRLF y fallaban en Linux con `$'\r': command not found`, es decir, el
   despliegue no habría funcionado en integración continua. Se convirtieron a LF
   y se agregó `.gitattributes` para fijarlo.

7. **`.env` podía llegar al repositorio.** El `.gitignore` original no lo
   ignoraba. Se reescribió para cubrir `.env`, `.env.*`, claves y certificados,
   con excepción explícita para los archivos de ejemplo.

---

## 12. Comprobaciones periódicas

```bash
# 1. Ninguna función de public ejecutable por anon (debe dar 0 filas)
psql "$SUPABASE_DB_URL" -c \
  "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute');"

# 2. RLS activa en todas las tablas de public (0 filas)
psql "$SUPABASE_DB_URL" -c \
  "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;"

# 3. Columnas de tokens no legibles por el cliente (0 filas)
psql "$SUPABASE_DB_URL" -c \
  "select column_name from information_schema.columns
   where table_name='calendar_connections'
     and column_name like '%token%'
     and has_column_privilege('authenticated','public.calendar_connections',column_name,'select');"

# 4. Webhooks con firma inválida (debería ser 0)
psql "$SUPABASE_DB_URL" -c \
  "select count(*) from public.webhook_events where not signature_valid;"

# 5. Sobrecupos (debe ser 0 siempre)
psql "$SUPABASE_DB_URL" -c \
  "select count(*) from (
     select tb.id from public.time_blocks tb
     join public.reservations r on r.block_id=tb.id and r.status='vigente'
     group by tb.id, tb.max_capacity having count(r.id) > tb.max_capacity) s;"

# 6. La suite completa, que incluye las pruebas de seguridad
npm run test && npm run test:db && npm run test:concurrency

# 7. Dependencias con vulnerabilidades conocidas
npm audit --omit=dev
```

Los puntos 1 a 3 y 5 están automatizados en las pruebas, así que
`npm run test:db` los cubre en cada integración.

---

## 13. Rotación de credenciales

| Credencial | Cómo | Impacto |
|---|---|---|
| `CRON_SECRET` | `set-secrets.sh` y luego `supabase/cron/schedule.sql` con el nuevo valor | Entre ambos pasos las tareas fallan con 401; los trabajos quedan en cola |
| `TWILIO_AUTH_TOKEN` | Rotar en Twilio, recargar el secreto, redesplegar | Los webhooks en vuelo con el token viejo se rechazarán |
| `GOOGLE_CLIENT_SECRET` | Rotar en Google Cloud, recargar, redesplegar | Los refresh tokens guardados siguen siendo válidos |
| `ENCRYPTION_KEY` | **Invalida todos los tokens guardados.** Ver `CONFIGURACION_GOOGLE_CALENDAR.md` § 9 | Las personas deben reconectar su calendario. Las reservas no se afectan |
| `SUPABASE_ANON_KEY` | Rotar en Supabase, recompilar y desplegar el frontend | Las sesiones activas se invalidan |
| Contraseña de la base | Rotar en Supabase, actualizar `SUPABASE_DB_URL` de los operadores | Sólo afecta el acceso directo |

Ante sospecha de filtración de la **service role key**, rótala de inmediato
desde el panel de Supabase: esa clave omite RLS por completo.

---

## 14. Respuesta a incidentes

1. **Contener.** Si la filtración es de una credencial, rótala primero. Si es un
   problema de autorización, pausa la tarea afectada
   (`update cron.job set active = false ...`) sin tocar las reservas.
2. **Evaluar el alcance.** `reservation_audit_log` y `webhook_events` conservan
   el historial de acciones. Los registros de las Edge Functions se guardan
   según el plan de Supabase.
3. **Preservar evidencia.** `npx supabase db dump` antes de corregir.
4. **Corregir.** Con una prueba que reproduzca el problema **antes** del
   arreglo: así no reaparece.
5. **Notificar.** Si hubo exposición de datos personales (correos o teléfonos),
   corresponde informar según las políticas de protección de datos de la
   institución.

### Si hubiera un sobrecupo

Sería un defecto en el control de concurrencia, no una incidencia operativa.
Preserva los datos, ejecuta `npm run test:concurrency` para intentar reproducirlo
y revisa que `create_reservation_strict` conserve el `SELECT ... FOR UPDATE`
sobre la fila del bloque **antes** de contar las reservas. Ese bloqueo es lo
único que impide el sobrecupo.

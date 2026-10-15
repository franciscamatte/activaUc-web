# Configuración de Supabase

Supabase es la fuente oficial de los datos de ActivaUC: base de datos
PostgreSQL, autenticación, Realtime y Edge Functions.

Esta guía va del proyecto vacío al backend operativo.

---

## 1. Requisitos previos

```bash
node --version    # 20.19 o superior
docker --version  # necesario sólo para el entorno local
npx supabase --version
```

La CLI de Supabase viene como dependencia de desarrollo del proyecto, así que
`npx supabase` funciona tras `npm install`.

---

## 2. Entorno local

Sirve para desarrollar y para probar las migraciones antes de tocar producción.

```bash
npx supabase start
```

Al terminar imprime algo así:

```
API URL: http://127.0.0.1:54321
DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
Studio URL: http://127.0.0.1:54323
Inbucket URL: http://127.0.0.1:54324
anon key: eyJhbGciOi...
service_role key: eyJhbGciOi...
```

Copia los valores públicos a `.env`:

```bash
VITE_DATA_MODE=supabase
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_APP_URL=http://localhost:5173
VITE_TIME_ZONE=America/Santiago
```

> La `service_role key` **no va nunca** en `.env` ni en ningún archivo `VITE_*`.
> Esa clave omite por completo RLS. Si la pegas donde va la `anon`, la
> aplicación lo detecta y se niega a arrancar, pero de todas formas quedaría
> publicada en el paquete JavaScript.

Aplica el esquema y los datos de ejemplo:

```bash
npx supabase db reset
```

Esto ejecuta, en orden, las migraciones de `supabase/migrations/` y después
`supabase/seed.sql`.

| Migración | Contenido |
|---|---|
| `20261016000100_core_schema.sql` | Extensiones, enumeraciones, 13 tablas, índices, restricciones y disparadores |
| `20261016000200_functions.sql` | Vistas de disponibilidad y las funciones transaccionales y de colas |
| `20261016000300_rls_policies.sql` | `REVOKE ALL` y concesiones explícitas por columna, más las políticas RLS |
| `20261016000400_realtime_and_cron.sql` | Publicación de Realtime, configuración operativa y disparador de tareas |

Verifica que quedó bien:

```bash
npm run test:db            # esquema, reservas, cancelaciones, RLS e integraciones
npm run test:concurrency   # sin sobrecupos ni duplicados
```

Ambos comandos crean su propia base desechable y la eliminan al terminar, así
que no ensucian los datos de desarrollo.

Para apuntarlos a otro servidor:

```bash
ACTIVAUC_TEST_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:db
```

El buzón local (<http://127.0.0.1:54324>) recibe los correos de confirmación y
recuperación, así que esos flujos se pueden probar completos sin servicio de
correo real.

---

## 3. Proyecto en la nube

### 3.1 Crear el proyecto

1. Entra a <https://supabase.com/dashboard> y crea un proyecto nuevo.
2. Elige la región más cercana a las personas usuarias (para Chile,
   `sa-east-1` / São Paulo da la menor latencia).
3. Guarda la contraseña de la base de datos en el gestor de contraseñas del
   equipo: se usa en `SUPABASE_DB_URL` y **no se puede recuperar** después.
4. Anota la referencia del proyecto (`<ref>`), visible en la URL del panel.

### 3.2 Vincular la CLI

```bash
npx supabase login
npx supabase link --project-ref <ref>
```

### 3.3 Aplicar las migraciones

```bash
# Revisa primero qué se va a aplicar
npx supabase db push --dry-run

# Aplica
npx supabase db push
```

> `db push` **no** ejecuta `seed.sql`: los datos de ejemplo son sólo para
> desarrollo. Los recintos y bloques reales se crean desde el panel de
> administración (ver `GUIA_ADMINISTRADOR.md`).

### 3.4 Habilitar extensiones

En **Database → Extensions** activa:

| Extensión | Para qué |
|---|---|
| `pgcrypto` | `gen_random_uuid()` (la migración la instala sola) |
| `pg_cron` | Ejecutar los workers de integración cada minuto |
| `pg_net` | Que `pg_cron` pueda invocar las Edge Functions por HTTP |

`pg_cron` y `pg_net` no se activan desde las migraciones a propósito: requieren
privilegios que no todos los planes conceden, y hacerlo desde una migración
rompería `db push` en un proyecto que no los tenga.

---

## 4. Autenticación

### 4.1 URLs de redirección

**Authentication → URL Configuration**:

| Campo | Valor |
|---|---|
| Site URL | `https://activauc.ejemplo.cl` (tu dominio real) |
| Redirect URLs | `https://activauc.ejemplo.cl/auth/callback`<br>`https://activauc.ejemplo.cl/restablecer-contrasena`<br>`https://activauc.ejemplo.cl/datos-personales`<br>`http://localhost:5173/**` (sólo en el proyecto de desarrollo) |

Si estas URLs no coinciden con `VITE_APP_URL`, los enlaces de confirmación y de
recuperación llevarán a una página en blanco.

### 4.2 Proveedor de correo y contraseña

**Authentication → Providers → Email**:

| Opción | Valor | Por qué |
|---|---|---|
| Enable Email provider | activado | Es el único método de ingreso (REQ-2) |
| Confirm email | **activado** | REQ-1: la cuenta se activa por correo |
| Secure email change | activado | Un cambio de correo exige confirmar ambos |
| Minimum password length | **8** | REQ-1 |
| Password requirements | al menos letras y dígitos | Reduce contraseñas triviales |

### 4.3 Sesiones

**Authentication → Sessions**:

| Opción | Valor | Efecto |
|---|---|---|
| Access token expiry | 3600 s | El cliente lo renueva solo |
| Refresh token rotation | activado | Un token robado deja de servir al rotarse |
| Reuse interval | 10 s | Tolera reintentos de red |
| Inactivity timeout | 72 h | Tras ese tiempo la app muestra «Tu sesión expiró» |

### 4.4 Servidor de correo (SMTP)

El SMTP de cortesía de Supabase tiene un límite bajo y no sirve para producción.
En **Project Settings → Auth → SMTP Settings** configura el servidor
institucional o un servicio de envío.

Personaliza las plantillas en **Authentication → Email Templates**; deben estar
en español. Como mínimo, «Confirm signup» y «Reset password».

### 4.5 Crear la primera cuenta administradora

El rol de administrador **no se puede asignar desde la aplicación**: la política
de columna y el disparador `prevent_profile_privilege_escalation` lo impiden a
propósito. El procedimiento es:

1. La persona crea su cuenta en ActivaUC y confirma su correo.
2. Un operador con acceso a la base ejecuta:

```bash
export SUPABASE_DB_URL="postgresql://postgres:<clave>@db.<ref>.supabase.co:5432/postgres"

bash scripts/seed-usuarios.sh --correo admin@uc.cl --todos-los-recintos
bash scripts/seed-usuarios.sh --listar     # verificación
```

---

## 5. Realtime

La migración `20261016000400` agrega `reservations`, `time_blocks` y
`facilities` a la publicación `supabase_realtime` y les pone
`REPLICA IDENTITY FULL`, que es lo que permite recalcular los cupos a partir de
un evento de actualización o borrado.

Verifica en **Database → Replication** que las tres tablas estén activas.

Realtime respeta RLS: un visitante anónimo no recibe eventos de
`public.reservations` porque no tiene privilegio de lectura. Eso es deliberado,
y el frontend lo compensa con un refresco periódico de 45 segundos.

---

## 6. Secretos de las Edge Functions

```bash
cp .env.secrets.example .env.secrets
```

Completa `.env.secrets` y genera las dos claves propias:

```bash
# Clave de cifrado de los tokens OAuth (32 bytes en base64)
openssl rand -base64 32

# Secreto compartido con pg_cron
openssl rand -hex 32
```

Carga los secretos:

```bash
bash scripts/set-secrets.sh --verificar   # valida sin subir nada
bash scripts/set-secrets.sh               # carga
npx supabase secrets list                 # confirma
```

El script valida antes de subir: que no falte ningún secreto obligatorio, que
`ENCRYPTION_KEY` tenga exactamente 32 bytes, que `CRON_SECRET` sea
suficientemente largo, que `GOOGLE_REDIRECT_URI` use HTTPS, y que no intentes
cargar variables reservadas.

> `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta
> Supabase en cada función automáticamente. Cargarlas como secretos falla.

---

## 7. Desplegar las Edge Functions

```bash
bash scripts/deploy-functions.sh
```

El script respeta la verificación de JWT que cada función necesita:

| Función | `verify_jwt` | Cómo se autentica |
|---|---|---|
| `google-oauth-start` | sí | JWT del usuario |
| `google-oauth-callback` | no | `state` firmado con HMAC, de un solo uso |
| `google-calendar-disconnect` | sí | JWT del usuario |
| `process-calendar-jobs` | no | `x-cron-secret` o la service role key |
| `process-notification-jobs` | no | `x-cron-secret` o la service role key |
| `twilio-status-webhook` | no | Firma `X-Twilio-Signature` |
| `cron-dispatch` | no | `x-cron-secret` |

Comprueba que los workers **no** sean públicos:

```bash
curl -i -X POST "https://<ref>.supabase.co/functions/v1/process-calendar-jobs"
# Debe responder 401 no_autorizado
```

---

## 8. Programar las tareas

Último paso del backend. Se hace una vez por entorno, porque la URL y el
secreto son distintos en cada proyecto.

```bash
export SUPABASE_DB_URL="postgresql://postgres:<clave>@db.<ref>.supabase.co:5432/postgres"
source .env.secrets

psql "$SUPABASE_DB_URL" \
  -v functions_base_url="https://<ref>.supabase.co/functions/v1" \
  -v cron_secret="$CRON_SECRET" \
  -f supabase/cron/schedule.sql
```

Deja dos tareas programadas:

| Tarea | Frecuencia | Qué hace |
|---|---|---|
| `activauc_integraciones` | cada minuto | Dispara los workers de Calendar y WhatsApp, incluidos los recordatorios vencidos |
| `activauc_limpieza` | cada hora (min. 17) | Borra `oauth_states` vencidos, contadores viejos y webhooks de más de 90 días |

Verifica:

```sql
select jobname, schedule, active from cron.job where jobname like 'activauc%';
select * from cron.job_run_details order by start_time desc limit 10;
```

---

## 9. Lista de verificación

```bash
# 1. Migraciones aplicadas: deben existir 13 tablas
psql "$SUPABASE_DB_URL" -c "select count(*) from pg_tables where schemaname='public';"

# 2. RLS activa en todas ellas: debe devolver 0 filas
psql "$SUPABASE_DB_URL" -c \
  "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;"

# 3. Ninguna función de public ejecutable por anon: debe devolver 0 filas
psql "$SUPABASE_DB_URL" -c \
  "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute');"

# 4. Secretos cargados
npx supabase secrets list

# 5. Workers protegidos
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://<ref>.supabase.co/functions/v1/cron-dispatch"   # 401

# 6. Despacho manual funcionando
curl -s -X POST "https://<ref>.supabase.co/functions/v1/cron-dispatch" \
  -H "x-cron-secret: $CRON_SECRET" | jq

# 7. Tareas programadas
psql "$SUPABASE_DB_URL" -c "select jobname, active from cron.job;"
```

---

## 10. Rollback

### Deshacer una migración

Supabase no revierte migraciones automáticamente. El procedimiento seguro es
escribir una migración nueva que deshaga el cambio:

```bash
npx supabase migration new revertir_lo_que_sea
# escribe el SQL inverso
npx supabase db push
```

Antes de aplicar cualquier migración en producción, prueba en local:

```bash
npx supabase db reset && npm run test:db
```

### Volver a una versión anterior de una función

```bash
git checkout <commit-anterior> -- supabase/functions/<nombre>/
bash scripts/deploy-functions.sh --solo <nombre>
```

### Detener las integraciones sin tocar las reservas

Si una integración está causando problemas, desactiva la tarea programada. Las
reservas siguen funcionando con normalidad; los trabajos se acumulan en la cola
y se procesan cuando la reactives.

```sql
update cron.job set active = false where jobname = 'activauc_integraciones';
-- para reactivar:
update cron.job set active = true  where jobname = 'activauc_integraciones';
```

### Respaldos

Supabase hace respaldos automáticos diarios (según el plan). Para uno manual
antes de un cambio grande:

```bash
npx supabase db dump --file respaldo-$(date +%Y%m%d).sql
```

---

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| «La aplicación no está configurada» | Falta `VITE_SUPABASE_URL` o `VITE_SUPABASE_ANON_KEY` | Completa `.env` y recompila (las variables `VITE_*` se incrustan al compilar) |
| La aplicación se niega a arrancar diciendo que la clave parece `service_role` | Se pegó la clave equivocada | Usa la clave `anon` de Project Settings → API |
| El enlace del correo lleva a una página en blanco | Las Redirect URLs no incluyen la ruta | Agrégalas en Authentication → URL Configuration |
| Los cupos no se actualizan en vivo | Realtime desactivado en las tablas | Revisa Database → Replication |
| Los recordatorios no llegan | `pg_cron` o `pg_net` sin instalar, o `private.app_config` vacío | Instala las extensiones y vuelve a ejecutar `supabase/cron/schedule.sql` |
| «La integración aún no está configurada» | Faltan secretos en las Edge Functions | `bash scripts/set-secrets.sh` y vuelve a desplegar |
| `supabase db push` falla por `pg_cron` | La extensión no está disponible en el plan | Las migraciones no la requieren; sólo `supabase/cron/schedule.sql` |

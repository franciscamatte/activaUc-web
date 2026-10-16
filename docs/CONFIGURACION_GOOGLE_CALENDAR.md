# Configuración de Google Calendar (OAuth 2.0)

Integración que permite a cada persona sincronizar sus reservas con su propio
Google Calendar. Es **voluntaria**: desconectarla no afecta la validez de
ninguna reserva (REQ-17 a REQ-21).

---

## Cómo funciona

```
Navegador                Edge Functions                 Google
    │                          │                           │
    │ 1. "Conectar"            │                           │
    ├─────────────────────────►│ google-oauth-start        │
    │                          │ · firma el state (HMAC)   │
    │                          │ · guarda su hash, 10 min  │
    │ 2. URL de autorización   │                           │
    │◄─────────────────────────┤                           │
    │ 3. redirección                                       │
    ├─────────────────────────────────────────────────────►│
    │                          │        4. ?code&state     │
    │                          │◄──────────────────────────┤
    │                          │ google-oauth-callback     │
    │                          │ · verifica la firma       │
    │                          │ · consume el state (1 vez)│
    │                          │ 5. code → tokens          │
    │                          ├──────────────────────────►│
    │                          │ · cifra AES-256-GCM       │
    │ 6. vuelve a la app       │ · guarda en la BD         │
    │◄─────────────────────────┤                           │
```

El `client_secret` y los tokens nunca pasan por el navegador.

**Al confirmar una reserva** se encola un trabajo en `calendar_sync_jobs`; el
worker `process-calendar-jobs` crea el evento con un id derivado del id de la
reserva, de modo que un reintento recibe `409` de Google y no duplica nada.
**Al cancelarla** se encola la eliminación.

---

## 1. Proyecto de Google Cloud

1. Entra a <https://console.cloud.google.com>.
2. **Crear proyecto** → nombre `ActivaUC` (o el que use la institución).
3. Anota el id del proyecto.

> Si Deportes UC usa Google Workspace, conviene crear el proyecto dentro de la
> organización: la pantalla de consentimiento puede quedar como «interna» y
> evitar el proceso de verificación de Google.

---

## 2. Habilitar la Google Calendar API

1. **APIs y servicios → Biblioteca**.
2. Busca **Google Calendar API** y pulsa **Habilitar**.

No hace falta habilitar ninguna otra API: el correo de la cuenta conectada se
obtiene del `id_token` que entrega el propio flujo OAuth.

---

## 3. Pantalla de consentimiento

**APIs y servicios → Pantalla de consentimiento de OAuth**.

| Campo | Valor |
|---|---|
| Tipo de usuario | **Interno** si todas las cuentas son del dominio institucional; **Externo** si hay cuentas `@gmail.com` |
| Nombre de la aplicación | `ActivaUC` |
| Correo de asistencia | Una casilla institucional atendida |
| Logotipo | Opcional (requiere verificación si es Externo) |
| Dominios autorizados | El dominio público de ActivaUC |
| Enlace a la política de privacidad | Obligatorio si es Externo |
| Enlace a los términos | Obligatorio si es Externo |
| Correo del desarrollador | Contacto técnico |

### Permisos (scopes)

Agrega **exactamente estos tres**, y ninguno más:

| Scope | Para qué |
|---|---|
| `https://www.googleapis.com/auth/calendar.events` | Crear y eliminar los eventos de las reservas. Es el único permiso de escritura |
| `openid` | Identificar la cuenta |
| `email` | Mostrar en la interfaz qué cuenta quedó conectada |

> `calendar.events` permite gestionar eventos, pero **no** leer el calendario
> completo ni tocar eventos ajenos a los que la aplicación crea. Pedir
> `calendar` (acceso total) sería innecesario y haría más probable que Google
> exija verificación.

La lista está fijada en `supabase/functions/_shared/google.ts` (`GOOGLE_SCOPES`)
y hay una prueba que falla si alguien agrega un permiso más amplio
(`src/test/googleCalendar.test.ts` › «pide únicamente los permisos mínimos»).

### Si el tipo es «Externo»

- Mientras esté **en pruebas**, sólo funcionarán las cuentas que agregues a
  «Usuarios de prueba» (hasta 100). Sirve para validar la integración.
- Para abrirla a cualquier cuenta hay que **publicar** la aplicación. Con los
  scopes anteriores, `calendar.events` es un permiso sensible y Google puede
  pedir verificación (puede tardar semanas). Planifícalo con antelación.

---

## 4. Credenciales de cliente OAuth

**APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**.

| Campo | Valor |
|---|---|
| Tipo de aplicación | **Aplicación web** |
| Nombre | `ActivaUC · web` |

### URI de redireccionamiento autorizados

Debe apuntar a la Edge Function, **no** al frontend:

```
https://<ref>.supabase.co/functions/v1/google-oauth-callback
```

Para desarrollo local agrega también:

```
http://127.0.0.1:54321/functions/v1/google-oauth-callback
```

> La coincidencia es **exacta**, carácter por carácter: protocolo, host, puerto
> y ruta, sin barra final. Cualquier diferencia produce `redirect_uri_mismatch`.

### Orígenes de JavaScript autorizados

ActivaUC **no** inicia el flujo desde el navegador con la librería de Google:
la URL de autorización la construye el backend. Por eso este campo puede
quedar vacío. Si prefieres completarlo, pon el origen público del frontend
(`https://activauc.ejemplo.cl`).

Al guardar, copia el **ID de cliente** y el **secreto de cliente**.

---

## 5. Cargar las credenciales

En `.env.secrets`:

```bash
GOOGLE_CLIENT_ID=123456789012-abcdefghijk.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=https://<ref>.supabase.co/functions/v1/google-oauth-callback

# Clave de cifrado de los tokens en reposo: 32 bytes en base64
ENCRYPTION_KEY=<openssl rand -base64 32>

# Origen al que se devuelve el navegador al terminar
APP_URL=https://activauc.ejemplo.cl
```

```bash
bash scripts/set-secrets.sh
bash scripts/deploy-functions.sh
```

El `GOOGLE_CLIENT_SECRET` sólo existe como secreto de Edge Function. No hay
ninguna variable `VITE_GOOGLE_*`, y no debe haberla.

---

## 6. Verificación con la cuenta real

Estos pasos requieren las credenciales cargadas y no pueden automatizarse.

### 6.1 Conectar

1. Inicia sesión en ActivaUC y ve a **Datos personales**.
2. Pulsa **Conectar Google Calendar**.
3. Google debe mostrar el consentimiento pidiendo **sólo** acceso a eventos de
   calendario.
4. Acepta. Debes volver a ActivaUC con el aviso «Conectamos tu cuenta…» y la
   insignia **Conectado** con el correo de la cuenta.

Comprueba en la base de datos que los tokens quedaron cifrados:

```sql
select
  user_id,
  status,
  google_account_email,
  left(access_token_encrypted, 3)  as prefijo_access,
  left(refresh_token_encrypted, 3) as prefijo_refresh,
  access_token_expires_at
from public.calendar_connections;
```

Ambos prefijos deben ser `v1.` (el marcador de formato del cifrado). Si vieras
algo que empieza con `ya29.` o `1//`, los tokens estarían en texto claro: eso
sería un incidente de seguridad.

### 6.2 Crear un evento

1. Reserva un bloque cualquiera.
2. En **Mis reservas**, la insignia debe decir **Calendar: Pendiente**.
3. Espera unos segundos: el trabajo se despacha en cuanto se encola, no en el
   siguiente ciclo de `pg_cron`. Si pasa más de un minuto, algo falla y puedes
   dispararlo a mano para ver el error:

```bash
curl -s -X POST "https://<ref>.supabase.co/functions/v1/cron-dispatch" \
  -H "x-cron-secret: $CRON_SECRET" | jq
```

4. Recarga: la insignia debe pasar a **Calendar: Sincronizada**.
5. Abre tu Google Calendar: debe estar el evento «Reserva ActivaUC · <recinto>»
   en el horario correcto.

```sql
select status, attempts, last_error, completed_at
from public.calendar_sync_jobs
order by created_at desc limit 5;
```

### 6.3 Comprobar la idempotencia

Reencola el mismo trabajo y vuelve a ejecutar el worker:

```sql
update public.calendar_sync_jobs
set status = 'pendiente', attempts = 0, next_attempt_at = now()
where kind = 'crear_evento'
order by created_at desc limit 1;
```

El worker debe completarlo sin error y **no debe aparecer un segundo evento**
en el calendario: Google responde `409` y se trata como éxito.

### 6.4 Eliminar el evento

Cancela la reserva. Tras el siguiente ciclo del worker, el evento debe
desaparecer del calendario y la insignia volver a **No aplica**.

### 6.5 Desconectar

1. **Datos personales → Desconectar Google Calendar**.
2. Debe confirmar que se revocó el permiso.
3. Verifica en <https://myaccount.google.com/permissions> que ActivaUC ya no
   aparece.
4. Confirma que **las reservas siguen vigentes**: eso es la regla de negocio.

```sql
select status, revoked_at, access_token_encrypted, refresh_token_encrypted
from public.calendar_connections;
-- status = 'revocado' y ambas columnas de token en NULL
```

### 6.6 Renovación automática del access token

Fuerza el vencimiento y ejecuta el worker: debe renovar sin intervención.

```sql
update public.calendar_connections
set access_token_expires_at = now() - interval '1 hour';
```

---

## 7. Paso a producción

| Antes de abrir al público | Estado |
|---|---|
| Pantalla de consentimiento publicada (o interna con el dominio correcto) | |
| Redirect URI de producción registrada | |
| Redirect URI de desarrollo eliminada del cliente de producción | |
| `GOOGLE_REDIRECT_URI` con el mismo valor en Google y en los secretos | |
| `ENCRYPTION_KEY` generada con `openssl rand -base64 32`, guardada en el gestor de contraseñas | |
| Política de privacidad y términos publicados (si el tipo es Externo) | |
| Verificación de Google solicitada, si corresponde | |
| Flujo completo probado con una cuenta institucional real | |

Usa **proyectos de Google Cloud separados** para desarrollo y producción. Así
una credencial de pruebas filtrada no da acceso a los calendarios reales.

---

## 8. Diagnóstico

### Mensajes que ve la persona

El callback vuelve a la aplicación con `?calendar=error&motivo=...`, y la
interfaz traduce cada motivo (`src/pages/DatosPersonalesPage.tsx`):

| Motivo | Qué pasó | Qué hacer |
|---|---|---|
| `permiso_denegado` | Rechazó el consentimiento | Nada: es su decisión |
| `state_invalido` | La firma del `state` no coincide | Posible intento de CSRF, o el secreto cambió entre inicio y callback |
| `state_expirado` | Pasaron más de 10 min, o el `state` ya se usó | Reintentar la conexión |
| `sin_refresh_token` | Google no entregó refresh token | Revocar en myaccount.google.com y reconectar (así Google vuelve a pedir consentimiento) |
| `permisos_insuficientes` | No autorizó `calendar.events` | Reconectar aceptando todos los permisos |
| `no_configurado` | Faltan secretos en el servidor | `bash scripts/set-secrets.sh` |
| `google_error` | Google rechazó la solicitud | Revisar los registros de la función |

### Diagnóstico rápido de las credenciales

Antes de bucear en los registros, ejecuta:

```bash
bash scripts/diagnose-google.sh
```

Envía a Google un código de autorización deliberadamente inválido y
traduce la respuesta. Lo que importa es **qué** error devuelve:

| Respuesta | Significado |
|---|---|
| `invalid_grant` | Las credenciales son correctas. El problema está en otra parte |
| `invalid_client` | El `client_id` o el `client_secret` no son correctos |
| `redirect_uri_mismatch` | El URI no coincide con el registrado |

También comprueba la forma de los valores. El error más frecuente, con
diferencia, es **pegar el ID de cliente en los dos campos**: ambos
valores miden lo mismo y el secreto no empieza por `GOCSPX-`. El script
lo detecta explícitamente, porque desde el navegador sólo se ve un
genérico «Google rechazó la solicitud».

### Errores del lado de Google

| Error | Causa | Solución |
|---|---|---|
| `redirect_uri_mismatch` | La URI no coincide exactamente | Compara carácter por carácter la de Google con `GOOGLE_REDIRECT_URI` |
| `invalid_client` | ID o secreto incorrectos | Vuelve a copiarlos desde Credenciales |
| `access_denied` + «app no verificada» | Externo en pruebas y la cuenta no está en la lista | Agrégala a «Usuarios de prueba» o publica la aplicación |
| `invalid_grant` al renovar | La persona revocó el acceso desde su cuenta Google | La conexión pasa a `error` y la interfaz pide reconectar. No es reintentable |

### Registros

```bash
# panel → Functions → google-oauth-callback → Logs
# panel → Functions → process-calendar-jobs → Logs
```

Los registros son JSON con redacción obligatoria
(`supabase/functions/_shared/log.ts`): **nunca** contienen tokens, códigos de
autorización ni el secreto de cliente. Si necesitas correlacionar, usa el
`user_id` o el `reservation_id`.

### Estado de la cola

```sql
-- Resumen
select status, count(*), max(updated_at)
from public.calendar_sync_jobs group by status;

-- Trabajos que agotaron los reintentos
select reservation_id, kind, attempts, last_error, updated_at
from public.calendar_sync_jobs
where status = 'error' and attempts >= max_attempts
order by updated_at desc;

-- Conexiones que necesitan reconectarse
select user_id, status, last_error
from public.calendar_connections where status = 'error';
```

Reintentar un trabajo concreto tras corregir la causa:

```sql
update public.calendar_sync_jobs
set status = 'pendiente', attempts = 0, next_attempt_at = now(), last_error = null
where id = '<id del trabajo>';
```

---

## 9. Rotación de la clave de cifrado

Rotar `ENCRYPTION_KEY` **invalida todos los tokens guardados**, porque están
cifrados con la clave anterior. El procedimiento honesto es:

```sql
-- 1. Marcar todas las conexiones como revocadas
update public.calendar_connections
set status = 'revocado',
    access_token_encrypted = null,
    refresh_token_encrypted = null,
    revoked_at = now(),
    last_error = 'Rotación de la clave de cifrado: es necesario reconectar.';

-- 2. Cancelar los trabajos pendientes, que ya no podrán ejecutarse
update public.calendar_sync_jobs
set status = 'cancelado', last_error = 'Rotación de la clave de cifrado.'
where status in ('pendiente', 'error');
```

Luego carga la clave nueva, vuelve a desplegar y **avisa a las personas** de que
deben reconectar su calendario. Las reservas no se ven afectadas.

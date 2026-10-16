# Informe de entrega · ActivaUC 1.0

Commit: `ce41971` · Ramas `Avance` y `copilot/avance` (ambas en el mismo commit)

---

## 1. Resumen ejecutivo

El repositorio pasó de una SPA con datos simulados a una plataforma lista para
producción, con Supabase como fuente oficial de la verdad.

Lo esencial de lo que cambió:

- **El cliente dejó de poder escribir reservas.** `anon` y `authenticated` no
  tienen `INSERT`, `UPDATE` ni `DELETE` sobre `public.reservations`. La única
  vía son dos funciones transaccionales que validan identidad, rol, capacidad y
  tiempos en el servidor.
- **La concurrencia está resuelta y verificada**, no afirmada:
  `create_reservation_strict` toma un bloqueo de fila sobre el bloque antes de
  contar. 100 solicitudes simultáneas sobre capacidad 20 producen exactamente
  20 reservas, cero sobrecupos y cero duplicados.
- **Las integraciones son reales y viven en el backend.** OAuth 2.0 de Google
  con `state` firmado y tokens cifrados con AES-256-GCM; Twilio invocado sólo
  desde una Edge Function, con webhook de estados autenticado por firma. Ningún
  secreto externo llega al navegador.
- **Un fallo de integración nunca invalida una reserva.** Hay una prueba que
  falla si eso cambiara.
- **El modo mock quedó acotado a desarrollo local** y una compilación de
  producción lo rechaza, para que una demo no se confunda con el sistema real.

Las seis verificaciones (lint, typecheck, pruebas unitarias, pruebas de base de
datos, concurrencia y compilación) terminan en verde.

Lo único pendiente es configuración externa: crear las cuentas, cargar las
credenciales, ejecutar los comandos documentados y dar de alta los datos
operativos reales.

---

## 2. Matriz REQ-1 a REQ-33

La matriz completa, con la evidencia de cada requisito y el archivo de prueba
que lo respalda, está en
[REQUISITOS_IMPLEMENTADOS.md](REQUISITOS_IMPLEMENTADOS.md).

Resumen por bloque:

| Bloque | Requisitos | Estado |
|---|---|---|
| 6.1 Autenticación y roles | REQ-1 a REQ-7 | 7 de 7 implementados |
| 6.2 Disponibilidad | REQ-8 a REQ-11 | 4 de 4 implementados |
| 6.3 Reservas | REQ-12 a REQ-16 | 5 de 5 implementados |
| 6.4 Google Calendar | REQ-17 a REQ-21 | 5 de 5 implementados |
| 6.5 WhatsApp | REQ-22 a REQ-27 | 6 de 6 implementados |
| 6.6 Administración | REQ-28 a REQ-33 | 6 de 6 implementados |
| **Total** | **33** | **33 implementados** |

> El documento de origen rotula dos requisitos consecutivos como «REQ-32» en la
> sección 6.6. Aquí se numeran REQ-31 (monitoreo) y REQ-32 (cancelación
> administrativa) para poder referenciarlos sin ambigüedad.

Las 11 reglas de negocio de la sección 7 y los 6 requerimientos no funcionales
de la sección 9 están cubiertos y trazados en el mismo documento.

---

## 3. Archivos creados y modificados

126 archivos: **+27.081** líneas, **−3.938**.

### Creados (87)

**Base de datos (12)**

```
supabase/config.toml
supabase/seed.sql
supabase/cron/schedule.sql
supabase/migrations/20261016000100_core_schema.sql
supabase/migrations/20261016000200_functions.sql
supabase/migrations/20261016000300_rls_policies.sql
supabase/migrations/20261016000400_realtime_and_cron.sql
supabase/tests/00_bootstrap_local.sql
supabase/tests/10_schema.sql
supabase/tests/20_reservations.sql
supabase/tests/30_cancellations.sql
supabase/tests/40_rls.sql
supabase/tests/50_integrations.sql
```

**Edge Functions (18)**

```
supabase/functions/_shared/{env,http,crypto,log,supabase,google,twilio,phone,messages,worker_auth,calendar_tokens}.ts
supabase/functions/google-oauth-start/index.ts
supabase/functions/google-oauth-callback/index.ts
supabase/functions/google-calendar-disconnect/index.ts
supabase/functions/process-calendar-jobs/index.ts
supabase/functions/process-notification-jobs/index.ts
supabase/functions/twilio-status-webhook/index.ts
supabase/functions/cron-dispatch/index.ts
```

**Frontend (31)**

```
src/domain/{phone,pasosReserva}.ts
src/lib/{errors,format,retry,authHash}.ts
src/data/rows.ts
src/state/{authContext,useAsync,useDisponibilidad,useOnline}.ts
src/state/AuthProvider.tsx
src/components/PasosReserva.tsx
src/components/ui/{Boton,Alerta,Campo,Estados,Insignia,Modal}.tsx
src/pages/{AuthCallbackPage,RegistroExitosoPage,RestablecerPasswordPage}.tsx
src/pages/admin/{RecintosSeccion,BloquesSeccion,ReservasSeccion,IntegracionesSeccion,AuditoriaSeccion}.tsx
```

**Pruebas (6)**

```
src/domain/phone.test.ts
src/lib/{errors,retry}.test.ts
src/data/mockRepository.test.ts
src/test/{oauthCrypto,googleCalendar,twilioWhatsapp}.test.ts
vitest.config.ts
```

**Scripts y configuración (8)**

```
scripts/{db-harness,db-test,concurrency-test}.mjs
scripts/{set-secrets,deploy-functions,deploy-frontend,seed-usuarios}.sh
.gitattributes
.env.secrets.example
package-lock.json
```

**Documentación (11)**

```
docs/{REQUISITOS_IMPLEMENTADOS,CONFIGURACION_SUPABASE,CONFIGURACION_GOOGLE_CALENDAR}.md
docs/{CONFIGURACION_TWILIO_WHATSAPP,DESPLIEGUE_AWS,OPERACION,PRUEBAS,SEGURIDAD}.md
docs/{GUIA_USUARIO,GUIA_ADMINISTRADOR,INFORME_ENTREGA}.md
```

### Modificados (29)

`README.md`, `package.json`, `eslint.config.js`, `vite.config.ts`,
`.env.example`, `.gitignore`, `src/App.tsx`, `src/main.tsx`, `src/index.css`,
`src/domain/{types,reservationRules,reservationRules.test}.ts`,
`src/lib/{env,supabase}.ts`,
`src/data/{index,repository,supabaseRepository,mockRepository,seed}.ts`,
`src/components/{Navbar,ProtectedRoute}.tsx`, y las 6 páginas existentes.

### Eliminados (10)

| Archivo | Por qué |
|---|---|
| `supabase/migrations/20261015133000_activauc_schema.sql` | Reemplazado por 4 migraciones coherentes. La original tenía un `SELECT count(*) ... FOR UPDATE`, que PostgreSQL rechaza, y marcaba WhatsApp como «enviado» sin enviar nada |
| `supabase/functions/process-integrations/index.ts` | Reemplazado por los dos workers y `cron-dispatch` |
| `src/state/AppProvider.tsx` | Reemplazado por `AuthProvider` + hooks |
| `src/lib/date.ts`, `src/services/retry.ts`, `src/services/retry.test.ts` | Reemplazados por `lib/format.ts` y `lib/retry.ts` |
| `docs/{guia-uso,despliegue-s3-cloudfront,pruebas-concurrencia}.md` | Reemplazados por los 11 documentos de `docs/` |
| `yarn.lock` | Se unificó en npm (`package-lock.json`) para que CI sea reproducible |

---

## 4. Migraciones agregadas

| Archivo | Líneas | Contenido |
|---|---|---|
| `20261016000100_core_schema.sql` | 532 | 9 enumeraciones, 13 tablas, índices, restricciones `CHECK`, disparadores de `updated_at`, alta automática de perfil, esquema `private` |
| `20261016000200_functions.sql` | 1352 | 2 vistas y 19 funciones: transacciones de reserva y cancelación, colas, límite de uso, administración, webhooks |
| `20261016000300_rls_policies.sql` | 287 | `REVOKE ALL` y concesiones por columna, 20 políticas RLS, barrera anti-escalada de privilegios |
| `20261016000400_realtime_and_cron.sql` | 158 | Publicación de Realtime, configuración operativa, disparador de tareas, vista de salud, limpieza |

Las 13 tablas: `profiles`, `facilities`, `time_blocks`,
`facility_admin_assignments`, `reservations`, `reservation_audit_log`,
`calendar_connections`, `calendar_sync_jobs`, `whatsapp_messages`,
`notification_jobs`, `webhook_events`, `oauth_states`, `rate_limit_counters`.

Además, `supabase/cron/schedule.sql` queda **fuera** de las migraciones a
propósito: necesita la URL de las funciones y el `CRON_SECRET`, que son
distintos por entorno y no deben versionarse.

---

## 5. Edge Functions agregadas

| Función | JWT | Qué hace |
|---|---|---|
| `google-oauth-start` | sí | Firma el `state` y devuelve la URL de autorización. Límite de 5 por minuto |
| `google-oauth-callback` | no | Verifica la firma, consume el `state` de forma atómica, cifra los tokens y los persiste |
| `google-calendar-disconnect` | sí | Revoca en Google, borra los tokens y cancela los trabajos pendientes |
| `process-calendar-jobs` | no | Crea y elimina eventos con reintentos. Renueva el access token solo |
| `process-notification-jobs` | no | Envía por Twilio validando consentimiento y E.164 |
| `twilio-status-webhook` | no | Actualiza los estados de entrega. Valida firma; idempotente |
| `cron-dispatch` | no | Punto único de entrada a los workers: lo invoca un disparador en cuanto se encola un trabajo, y `pg_cron` cada minuto como red de seguridad |

Las que no verifican JWT se autentican por su cuenta: `state` firmado, firma de
Twilio o `x-cron-secret`, siempre con comparación en tiempo constante. Si
`CRON_SECRET` no está configurado, los workers rechazan todo.

Módulos compartidos en `_shared/`: cifrado AES-256-GCM y firma HMAC, clientes de
Google y Twilio, validación E.164, plantillas en español, CORS por lista blanca
y registro con redacción obligatoria.

---

## 6. Variables de entorno requeridas

### Públicas · frontend (`.env`)

| Variable | Obligatoria | Nota |
|---|---|---|
| `VITE_DATA_MODE` | no | `supabase` por omisión. `mock` sólo en desarrollo |
| `VITE_SUPABASE_URL` | **sí** | URL del proyecto |
| `VITE_SUPABASE_ANON_KEY` | **sí** | Clave pública. Jamás la `service_role` |
| `VITE_APP_URL` | sí en producción | Debe coincidir con las Redirect URLs de Auth |
| `VITE_SUPABASE_FUNCTIONS_URL` | no | Se deriva de `VITE_SUPABASE_URL` |
| `VITE_TIME_ZONE` | no | `America/Santiago` por omisión |

### Secretos · Edge Functions (`.env.secrets`)

| Variable | Obligatoria | Nota |
|---|---|---|
| `ENCRYPTION_KEY` | **sí** | 32 bytes en base64. `openssl rand -base64 32` |
| `CRON_SECRET` | **sí** | `openssl rand -hex 32`. También va en la base de datos |
| `GOOGLE_CLIENT_ID` | **sí** | |
| `GOOGLE_CLIENT_SECRET` | **sí** | |
| `GOOGLE_REDIRECT_URI` | **sí** | Debe coincidir exactamente con Google |
| `TWILIO_ACCOUNT_SID` | **sí** | |
| `TWILIO_AUTH_TOKEN` | **sí** | También valida la firma del webhook |
| `TWILIO_WHATSAPP_FROM` | **sí** | E.164 |
| `APP_URL` | **sí** | Destino del callback de OAuth |
| `APP_ALLOWED_ORIGINS` | no | Lista blanca de CORS |
| `APP_TIME_ZONE` | no | |
| `TWILIO_STATUS_CALLBACK_URL` | recomendada | Sin ella no hay trazabilidad de entrega |
| `TWILIO_WEBHOOK_URL` | no | Sólo si un proxy altera el host |
| `TWILIO_CONTENT_SID_*` (3) | **sí en producción** | Plantillas aprobadas por Meta |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta
Supabase: cargarlas como secretos falla.

### Despliegue (`.env.deploy` o el gestor del pipeline)

`AWS_S3_BUCKET`, `AWS_CLOUDFRONT_ID`, más las variables `VITE_*`.

### De operador

`SUPABASE_DB_URL` (incluye la contraseña de la base: no versionar).

---

## 7. Comandos ejecutados

Entorno: Node 24.22.0 y npm 11.19.1 en WSL2 (Ubuntu 24.04); PostgreSQL 16.13
local en el puerto 55432.

```bash
npm install                  # 239 paquetes
npm run lint
npm run typecheck
npm run test
npm run test:db
npm run test:concurrency
npm run build
```

> La máquina no tenía Node.js instalado y el demonio de Docker estaba detenido.
> Se instaló Node 24 en el directorio del usuario (sin `sudo`) y se levantó un
> clúster de PostgreSQL 16 con los binarios ya presentes en WSL, de modo que
> las pruebas de base de datos y concurrencia se ejecutaran de verdad y no
> quedaran como una afirmación sin respaldo.
>
> Durante la instalación, npm 10.9.3 fallaba con
> `Cannot read properties of null (reading 'edgesOut')` al resolver el árbol de
> dependencias de Vitest. Se resolvió con Node 24 (npm 11).

---

## 8. Resultado de lint

```
> eslint .
```

**Exit 0. Sin errores ni advertencias.**

ESLint cubre ahora tres ámbitos con reglas propias: `src/**` (React +
TypeScript), `supabase/functions/**` (Deno) y `scripts/**` (Node).

> La configuración anterior declaraba `files: ["**/*.js"]` sobre un proyecto
> íntegramente `.ts`/`.tsx`: **no revisaba ningún archivo**. Al corregirla
> aparecieron errores reales, incluido un `setState` sincrónico dentro de un
> efecto que provocaba renders en cascada.

---

## 9. Resultado de tests

### Vitest

```
Test Files  8 passed (8)
     Tests  225 passed (225)
```

| Archivo | Pruebas |
|---|---|
| `src/data/mockRepository.test.ts` | 58 |
| `src/domain/reservationRules.test.ts` | 34 |
| `src/test/twilioWhatsapp.test.ts` | 35 |
| `src/test/oauthCrypto.test.ts` | 24 |
| `src/test/googleCalendar.test.ts` | 23 |
| `src/lib/errors.test.ts` | 21 |
| `src/domain/phone.test.ts` | 20 |
| `src/lib/retry.test.ts` | 10 |

### Base de datos (PostgreSQL real)

```
✔ 10_schema.sql        ✔ 30_cancellations.sql   ✔ 50_integrations.sql
✔ 20_reservations.sql  ✔ 40_rls.sql             ✔ 60_block_series.sql
                                                ✔ 70_despacho_inmediato.sql

✔ 7 archivos de prueba superados
```

Cada archivo corre en su propia transacción, que se revierte. El arranque
recrea el entorno de Supabase (esquema `auth`, roles `anon`, `authenticated` y
`service_role`), así que esta suite también verifica que las migraciones se
apliquen limpiamente sobre una base vacía.

### Concurrencia

```
1) Último cupo con 2 usuarios simultáneos .......... 1 reserva, 1 "sin_cupos"
2) 100 solicitudes sobre capacidad 20 ............. 20 reservas en 799 ms
                                                     0 sobrecupos, 0 duplicados
                                                     0 errores, 20 auditorías
3) 10 solicitudes del mismo usuario a la vez ...... 1 reserva, 9 duplicadas
4) Carrera de 10 por el cupo liberado ............. 1 gana
5) 30 solicitudes sobre bloque agotado ............ 0 éxitos, 30 mensajes claros
6) 5 reintentos de la misma solicitud ............. 1 reserva, 1 trabajo, 2 avisos

✔ cero sobrecupos, cero duplicados
```

Cada solicitud usa su propia conexión y transacción, con los claims del JWT
fijados como lo hace PostgREST, y todas se liberan desde una barrera común.

---

## 10. Resultado de typecheck

```
> tsc -b --force
```

**Exit 0.** Sin errores, con `noUnusedLocals`, `noUnusedParameters`,
`erasableSyntaxOnly` y `verbatimModuleSyntax` activos.

---

## 11. Resultado de build

```
> tsc -b && vite build

dist/index.html                             0.70 kB │ gzip:  0.36 kB
dist/assets/index-BTYC64MY.css             30.71 kB │ gzip:  6.62 kB
dist/assets/rolldown-runtime-WkwZ5CU-.js    0.59 kB │ gzip:  0.36 kB
dist/assets/AdminPage-l6bERI9y.js          30.76 kB │ gzip:  8.43 kB
dist/assets/index-DvKRgiWY.js             123.91 kB │ gzip: 33.31 kB
dist/assets/supabase-DtuMx0jC.js          214.43 kB │ gzip: 55.20 kB
dist/assets/react-Bo0DSu0k.js             259.45 kB │ gzip: 82.47 kB

✓ built in 4.62s
```

**Exit 0, sin advertencias.** El panel de administración se carga de forma
diferida y las librerías van en grupos estables, para que un cambio en el código
propio no invalide su caché. Los mapas de origen se generan para depuración
local y no se suben.

---

## 12. Riesgos pendientes

1. **Las integraciones no se han ejercido contra las APIs reales de Google y
   Twilio.** Requiere cuentas con credenciales productivas. Lo verificado es el
   contrato completo con `fetch` simulado: alcances, idempotencia,
   clasificación de errores, reintentos y validación de firma. Los pasos de
   verificación con cuentas reales están en
   [CONFIGURACION_GOOGLE_CALENDAR.md](CONFIGURACION_GOOGLE_CALENDAR.md) § 6 y
   [CONFIGURACION_TWILIO_WHATSAPP.md](CONFIGURACION_TWILIO_WHATSAPP.md) § 7.

2. **Las plantillas de WhatsApp requieren aprobación de Meta**, que es un
   trámite externo de duración variable. Sin plantillas aprobadas, los envíos
   sólo funcionan en el Sandbox.

3. **La verificación de Google puede tardar** si la pantalla de consentimiento
   se publica como «Externa», porque `calendar.events` es un permiso sensible.
   Con Google Workspace institucional se evita usando el tipo «Interno».

4. **`pg_cron` y `pg_net` no se instalan desde las migraciones**, porque
   requieren privilegios que no todos los planes de Supabase conceden y romperían
   `db push`. Son un paso manual documentado.

5. **Realtime no alcanza a los visitantes anónimos**, por diseño: `anon` no
   puede leer `public.reservations`. El catálogo público se refresca cada 45
   segundos; quien inició sesión sí recibe la actualización instantánea.

6. **La capacidad se puede reducir por debajo de las reservas existentes.** Es
   deliberado: esas reservas se conservan y el sistema no acepta nuevas hasta que
   haya cupos. La interfaz lo advierte al editar.

7. **No hay pruebas de renderizado de componentes.** Se omitieron para no añadir
   `@testing-library/react` y un DOM simulado a cambio de verificar menos de lo
   que verifican las pruebas de concurrencia y RLS.

8. **Las series no se editan como serie.** `admin_create_block_series` crea una
   temporada completa de una vez y `admin_deactivate_block_series` la retira en
   bloque, pero cambiar la capacidad de una serie ya publicada sigue siendo
   bloque por bloque: no se guarda la identidad de la serie, sólo sus bloques.

9. **Un fallo del despacho inmediato es silencioso.** El disparador que invoca
   el worker al encolar va envuelto para que un problema de la integración no
   pueda impedir una reserva, así que el fallo sale como `notice` y no como
   error. El cron recoge el trabajo hasta un minuto después, de modo que el
   efecto visible es la latencia de antes, no una pérdida.

---

## 13. Configuración externa pendiente

Lo único que falta. No hay código pendiente.

| Paso | Qué hay que hacer | Documento |
|---|---|---|
| 1 | Crear el proyecto de Supabase y anotar su referencia | [CONFIGURACION_SUPABASE.md](CONFIGURACION_SUPABASE.md) § 3 |
| 2 | Crear el proyecto de Google Cloud, habilitar Calendar API y el cliente OAuth | [CONFIGURACION_GOOGLE_CALENDAR.md](CONFIGURACION_GOOGLE_CALENDAR.md) § 1–4 |
| 3 | Crear la cuenta de Twilio, el WhatsApp Sender y las 3 plantillas | [CONFIGURACION_TWILIO_WHATSAPP.md](CONFIGURACION_TWILIO_WHATSAPP.md) § 1–4 |
| 4 | Crear el bucket S3, la distribución CloudFront y el certificado | [DESPLIEGUE_AWS.md](DESPLIEGUE_AWS.md) § 2–4 |
| 5 | Generar `ENCRYPTION_KEY` y `CRON_SECRET` y cargar los secretos | [CONFIGURACION_SUPABASE.md](CONFIGURACION_SUPABASE.md) § 6 |
| 6 | Configurar las Redirect URLs de Auth y el SMTP institucional | [CONFIGURACION_SUPABASE.md](CONFIGURACION_SUPABASE.md) § 4 |
| 7 | Apuntar el dominio a CloudFront | [DESPLIEGUE_AWS.md](DESPLIEGUE_AWS.md) § 5 |
| 8 | Dar de alta los recintos, bloques y administradores reales | [GUIA_ADMINISTRADOR.md](GUIA_ADMINISTRADOR.md) |

---

## 14. Pasos exactos para producción

```bash
# ── 1. Backend ──────────────────────────────────────────────────────
npx supabase login
npx supabase link --project-ref <ref>

npx supabase db push --dry-run        # revisar
npx supabase db push                  # aplicar

#   En el panel: Database → Extensions → activar pg_cron y pg_net
#   En el panel: Authentication → URL Configuration → Redirect URLs
#   En el panel: Authentication → Providers → Email → Confirm email

# ── 2. Secretos ─────────────────────────────────────────────────────
cp .env.secrets.example .env.secrets
openssl rand -base64 32               # → ENCRYPTION_KEY
openssl rand -hex 32                  # → CRON_SECRET
#   completar .env.secrets con las credenciales de Google y Twilio

bash scripts/set-secrets.sh --verificar   # valida sin subir
bash scripts/set-secrets.sh

# ── 3. Edge Functions ───────────────────────────────────────────────
bash scripts/deploy-functions.sh

#   Comprobar que los workers no son públicos (debe dar 401)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://<ref>.supabase.co/functions/v1/process-calendar-jobs"

# ── 4. Tareas programadas ───────────────────────────────────────────
export SUPABASE_DB_URL="postgresql://postgres:<clave>@db.<ref>.supabase.co:5432/postgres"
source .env.secrets

psql "$SUPABASE_DB_URL" \
  -v functions_base_url="https://<ref>.supabase.co/functions/v1" \
  -v cron_secret="$CRON_SECRET" \
  -f supabase/cron/schedule.sql

# ── 5. Frontend ─────────────────────────────────────────────────────
cat > .env.deploy <<'EOF'
AWS_S3_BUCKET=activauc-web-prod
AWS_CLOUDFRONT_ID=EXXXXXXXXXXXXX
VITE_DATA_MODE=supabase
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<clave anon>
VITE_APP_URL=https://activauc.ejemplo.cl
VITE_TIME_ZONE=America/Santiago
EOF

bash scripts/deploy-frontend.sh --dry-run
bash scripts/deploy-frontend.sh --esperar

# ── 6. Datos operativos ─────────────────────────────────────────────
#   La persona administradora crea su cuenta en la aplicación y confirma
#   su correo; después:
bash scripts/seed-usuarios.sh --correo admin@uc.cl --todos-los-recintos
bash scripts/seed-usuarios.sh --listar

#   Luego, desde el panel: crear recintos, bloques y capacidades.

# ── 7. Verificación ─────────────────────────────────────────────────
#   CONFIGURACION_SUPABASE.md § 9, DESPLIEGUE_AWS.md § 7,
#   CONFIGURACION_GOOGLE_CALENDAR.md § 6, CONFIGURACION_TWILIO_WHATSAPP.md § 7
```

---

## 15. Evidencia de que no hay secretos en el repositorio

### Búsquedas realizadas

```bash
# Formatos de secreto de proveedores, en todo el repositorio
grep -rniE "(GOCSPX-[A-Za-z0-9_-]{10,}|sk_live_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{22}|AC[0-9a-f]{32})" \
  . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
# → sin resultados

# JWT embebidos
grep -rhoE "eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}" \
  . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
# → sin resultados

# Secretos de backend en el frontend
grep -rn "Deno\.env" src/                           # → sin resultados
grep -rniE "googleapis\.com|api\.twilio\.com" src/   # → sólo en src/test/

# Archivos .env rastreados por Git
git ls-files | grep -E "\.env"
# → .env.example y .env.secrets.example (sólo nombres de variables)
git check-ignore -v .env .env.secrets .env.deploy
# → los tres ignorados
```

### Barreras permanentes

1. **`.gitignore`** cubre `.env`, `.env.*` (con excepción de los `.example`),
   `*.pem`, `*.key`, `credentials.json`, `client_secret*.json` y
   `service-account*.json`.
2. **`src/lib/env.ts`** decodifica la clave `anon` y, si su claim `role` es
   `service_role`, la aplicación no arranca y muestra el problema.
3. **`scripts/deploy-frontend.sh`** repite esa comprobación antes de compilar y,
   después, extrae **todos** los JWT del paquete, decodifica cada payload y
   aborta si alguno tiene `role: service_role`. También busca formatos de
   secreto conocidos y los valores concretos del entorno del despliegue.
4. **`supabase/tests/10_schema.sql`** falla si las columnas de tokens pasaran a
   ser legibles por `anon` o `authenticated`, o si alguna función de `public`
   quedara ejecutable por `anon`.
5. **`supabase/functions/_shared/log.ts`** redacta antes de registrar: claves con
   nombre sensible se reemplazan, los teléfonos quedan en 4 dígitos y los correos
   en el dominio.

### Verificación del escáner

Se probó en los dos sentidos: con el paquete real no encuentra nada (`exit 0`), y
con una `service_role` key de prueba inyectada en `dist/` aborta con `exit 1` y
el mensaje correspondiente.

La primera versión del escáner buscaba **nombres** de variables y daba falsos
positivos con el propio código de defensa y con los comentarios, así que habría
abortado todos los despliegues. Se reescribió para buscar **valores**.

---

## Apéndice · defectos encontrados y corregidos

Se dejan registrados porque eran reales y los detectaron las pruebas y el
linter, no una inspección a ojo.

| # | Defecto | Impacto si no se hubiera corregido | Lo detectó |
|---|---|---|---|
| 1 | `SELECT count(*) ... FOR UPDATE` en la función de reserva original | PostgreSQL rechaza `FOR UPDATE` con funciones de agregación: **reservar habría fallado siempre** | Reescritura de la migración |
| 2 | Funciones de `public` ejecutables por `anon` | `REVOKE ... FROM anon` no surte efecto, porque `anon` hereda de `PUBLIC` | `10_schema.sql` |
| 3 | ESLint no revisaba ningún archivo | Todo el código quedaba sin análisis estático, incumpliendo el requisito de linter | Ejecutar `npm run lint` |
| 4 | `setState` sincrónico dentro de un efecto | Renders en cascada | ESLint corregido |
| 5 | `CASE` sin tipo en `fail_notification_job` | **Registrar cualquier fallo de WhatsApp habría fallado en ejecución** | `50_integrations.sql` |
| 6 | `ORDER BY` tras `UNION ALL` en `admin_integration_report` | El informe de integraciones del panel habría fallado siempre | `50_integrations.sql` |
| 7 | Escáner de secretos con falsos positivos | Habría abortado cada despliegue, enseñando a ignorar la alerta | Prueba del escáner |
| 8 | Scripts con fin de línea CRLF | `$'\r': command not found`: el despliegue no habría funcionado en Linux ni en CI | Ejecutarlos en WSL |
| 9 | `.gitignore` sin `.env` | Riesgo de versionar credenciales | Revisión de seguridad |
| 10 | Estado «enviado» de WhatsApp fijado sin enviar nada | La interfaz habría afirmado que un mensaje salió cuando no existía ningún envío | Revisión de la migración original |

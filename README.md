# ActivaUC

Plataforma web para la reserva de espacios deportivos de **Deportes UC**.

Permite consultar la disponibilidad de los recintos en tiempo real, reservar y
cancelar bloques horarios sin sobrecupos ni duplicados, sincronizar las reservas
con Google Calendar y recibir confirmaciones y recordatorios por WhatsApp.

La interfaz está íntegramente en español.

---

## Estado del proyecto

Versión **1.0**, lista para producción. Supabase es la fuente oficial del estado
de las reservas; Google Calendar y WhatsApp son integraciones informativas que
nunca condicionan la validez de una reserva.

| Capa | Tecnología | Estado |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite + TailwindCSS 4 | Implementado |
| Backend de datos | Supabase (PostgreSQL 15) con RLS | Implementado |
| Autenticación | Supabase Auth (correo y contraseña, confirmación, recuperación) | Implementado |
| Concurrencia | Función transaccional `create_reservation_strict` | Implementado y verificado con pruebas de carga |
| Tiempo real | Supabase Realtime + respaldo por intervalo | Implementado |
| Google Calendar | OAuth 2.0 real en Edge Functions, tokens cifrados | Implementado |
| WhatsApp | Twilio desde Edge Functions, con webhook de estados | Implementado |
| Recordatorios | `pg_cron` + `pg_net` + worker de notificaciones | Implementado |
| Despliegue | S3 + CloudFront (frontend), Supabase CLI (backend) | Scripts y documentación listos |

**Lo que queda por hacer es exclusivamente configuración externa**: crear las
cuentas de Google Cloud, Twilio, Supabase y AWS, cargar sus credenciales en los
gestores de secretos y ejecutar los comandos documentados. El detalle exacto
está en [docs/REQUISITOS_IMPLEMENTADOS.md](docs/REQUISITOS_IMPLEMENTADOS.md).

---

## Puesta en marcha

Requisitos: **Node.js 20.19 o superior** y **Docker** (para el entorno local de
Supabase).

```bash
npm install
# Sin pisar un .env que ya exista: «cp» a secas lo reemplaza por los
# valores de ejemplo y la aplicación deja de conectar.
[ -f .env ] || cp .env.example .env
```

### Desarrollo con el backend real (recomendado)

```bash
npx supabase start          # levanta PostgreSQL, Auth, Realtime y Studio
npx supabase db reset       # aplica migraciones y datos de ejemplo
npm run dev                 # http://localhost:5173
```

`supabase start` imprime la URL y la clave `anon` locales; cópialas a `.env`:

```bash
VITE_DATA_MODE=supabase
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key que imprimió supabase start>
VITE_APP_URL=http://localhost:5173
```

Los correos de confirmación y recuperación quedan en el buzón local:
<http://127.0.0.1:54324>.

### Desarrollo sin backend (modo demostración)

Útil para trabajar en la interfaz sin Docker:

```bash
echo "VITE_DATA_MODE=mock" > .env
npm run dev
```

El modo demostración usa datos en memoria y **deshabilita** Google Calendar y
WhatsApp, porque simular esas integraciones daría una falsa sensación de que
funcionan. Una compilación de producción con `VITE_DATA_MODE=mock` es rechazada
por la propia aplicación.

Cuentas de ejemplo (visibles en la pantalla de ingreso):

| Correo | Contraseña | Rol |
|---|---|---|
| `camila@uc.cl` | `activauc2026` | usuaria |
| `admin@uc.cl` | `activauc2026` | administradora de recintos |

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Compilación de producción a `dist/` |
| `npm run preview` | Sirve `dist/` localmente |
| `npm run lint` | ESLint sobre `src/`, `supabase/functions/` y `scripts/` |
| `npm run typecheck` | Verificación de tipos de TypeScript |
| `npm run test` | Pruebas unitarias y de integración (Vitest) |
| `npm run test:db` | Pruebas de esquema, RLS y reglas de negocio sobre PostgreSQL |
| `npm run test:concurrency` | Pruebas de concurrencia: sin sobrecupos ni duplicados |
| `npm run verify` | lint + typecheck + test + build |
| `npm run db:reset` | Reaplica migraciones y datos de ejemplo en local |
| `npm run db:push` | Aplica migraciones al proyecto remoto |
| `npm run functions:deploy` | Despliega las Edge Functions |
| `npm run secrets:set` | Carga los secretos de backend en Supabase |
| `npm run deploy:frontend` | Compila y publica en S3 + CloudFront |

---

## Estructura

```
src/
  domain/        Tipos y reglas de negocio (sin dependencias de React)
  lib/           Configuración, cliente de Supabase, errores, formato, reintentos
  data/          Repositorio: contrato, implementación Supabase y modo demostración
  state/         Sesión, disponibilidad en vivo y carga asíncrona
  components/    Navegación, rutas protegidas y biblioteca de interfaz
  pages/         Pantallas públicas, de usuario y panel de administración
  test/          Pruebas de integración de Google Calendar y Twilio

supabase/
  migrations/    Esquema, funciones, RLS, Realtime, series, despacho y canal de correo (8 migraciones ordenadas)
  functions/     7 Edge Functions + módulos compartidos en _shared/
  tests/         Pruebas SQL de esquema, reservas, cancelaciones, RLS e integraciones
  cron/          Programación de tareas con pg_cron (se ejecuta una vez por entorno)
  seed.sql       Datos de ejemplo para desarrollo

scripts/         Pruebas de base de datos y concurrencia, y despliegue
docs/            Documentación de configuración, operación, pruebas y seguridad
```

---

## Arquitectura, en breve

**La base de datos manda.** El frontend no puede insertar ni modificar reservas:
`anon` y `authenticated` no tienen privilegio de `INSERT`, `UPDATE` ni `DELETE`
sobre `public.reservations`. La única vía son dos funciones `SECURITY DEFINER`:

- `create_reservation_strict(block_id)` toma un bloqueo de fila sobre el bloque
  (`SELECT ... FOR UPDATE`), de modo que las solicitudes concurrentes se
  serializan. Verifica capacidad y duplicados, crea la reserva, registra
  auditoría y encola los trabajos de integración, todo en una transacción.
- `cancel_reservation(reservation_id, reason)` decide por el **rol real** del
  solicitante, nunca por un parámetro del cliente: el dueño necesita 2 horas de
  anticipación, el administrador asignado al recinto no.

**Las integraciones son colas, no llamadas en línea.** Al confirmar una reserva
se encolan trabajos en `calendar_sync_jobs` y `notification_jobs` con una clave
de idempotencia determinística. Dos workers (Edge Functions) los consumen con
`FOR UPDATE SKIP LOCKED`, reintentos con retroceso exponencial y tope de
intentos. Si Google o Twilio fallan, la reserva sigue siendo válida y sólo
cambia su estado informativo.

**Los secretos viven en el backend.** El navegador sólo conoce la URL del
proyecto y la clave `anon`. Los tokens de Google se guardan cifrados con
AES-256-GCM y sus columnas no tienen privilegio de lectura para ningún rol del
cliente. Twilio se invoca exclusivamente desde una Edge Function.

Detalle completo en [docs/SEGURIDAD.md](docs/SEGURIDAD.md).

---

## Documentación

| Documento | Contenido |
|---|---|
| [ARRANQUE_LOCAL.md](docs/ARRANQUE_LOCAL.md) | **Empieza aquí**: cómo levantar la página en tu computador |
| [COMPARTIR.md](docs/COMPARTIR.md) | Cómo publicarla para que la usen otras personas |
| [LIMITACIONES.md](docs/LIMITACIONES.md) | **Qué puede hacer hoy alguien a quien le pases el enlace**, y los tres topes que lo impiden |
| [BASE_DE_DATOS.md](docs/BASE_DE_DATOS.md) | Cómo funciona la base: las 13 tablas, cómo se evita el sobrecupo y por qué el navegador no puede hacer trampa |
| [REQUISITOS_IMPLEMENTADOS.md](docs/REQUISITOS_IMPLEMENTADOS.md) | Matriz REQ-1 a REQ-33 con la evidencia de cada requisito |
| [CONFIGURACION_SUPABASE.md](docs/CONFIGURACION_SUPABASE.md) | Proyecto, migraciones, Auth, Realtime y secretos |
| [CONFIGURACION_CORREO.md](docs/CONFIGURACION_CORREO.md) | Confirmación y recuperación por código, SMTP propio, correo institucional |
| [ALTERNATIVAS_PROVEEDORES.md](docs/ALTERNATIVAS_PROVEEDORES.md) | Alternativas gratuitas a Twilio para correo y WhatsApp, y qué cuesta cada una |
| [CONFIGURACION_GOOGLE_CALENDAR.md](docs/CONFIGURACION_GOOGLE_CALENDAR.md) | Google Cloud, OAuth, pantalla de consentimiento, verificación |
| [CONFIGURACION_TWILIO_WHATSAPP.md](docs/CONFIGURACION_TWILIO_WHATSAPP.md) | Cuenta, sandbox, producción, plantillas y webhook |
| [DESPLIEGUE_AWS.md](docs/DESPLIEGUE_AWS.md) | S3, CloudFront, HTTPS, dominio, caché e invalidación |
| [OPERACION.md](docs/OPERACION.md) | Tareas programadas, monitoreo, registros, recuperación y rollback |
| [PRUEBAS.md](docs/PRUEBAS.md) | Qué cubre cada suite y cómo ejecutarlas |
| [SEGURIDAD.md](docs/SEGURIDAD.md) | Modelo de amenazas, RLS, secretos y revisión aplicada |
| [GUIA_USUARIO.md](docs/GUIA_USUARIO.md) | Manual para quien reserva |
| [GUIA_ADMINISTRADOR.md](docs/GUIA_ADMINISTRADOR.md) | Manual para el personal de recintos |

Documento de requerimientos de origen:
`2.1 Documento de requerimientos de software (1).pdf`.

---

## Camino a producción

1. **Crear las cuentas externas**: Supabase, Google Cloud, Twilio y AWS.
2. **Cargar las credenciales** en los gestores seguros correspondientes
   (`scripts/set-secrets.sh` para Supabase; variables de entorno o el gestor de
   secretos del pipeline para AWS).
3. **Ejecutar los comandos documentados** de migración y despliegue.
4. **Configurar dominios, URLs públicas y datos operativos reales** (recintos,
   bloques y administradores).

Cada paso, con sus comandos exactos, está en
[docs/DESPLIEGUE_AWS.md](docs/DESPLIEGUE_AWS.md) y
[docs/CONFIGURACION_SUPABASE.md](docs/CONFIGURACION_SUPABASE.md).

---

## Licencia y datos personales

Proyecto desarrollado para Deportes UC. Los datos personales de las personas
usuarias (correo y teléfono) se tratan conforme a las políticas de protección de
datos de la institución: no se exponen en el cliente web, no son visibles para
otras personas usuarias ni para el personal administrativo, y las notificaciones
por WhatsApp requieren consentimiento explícito y revocable.

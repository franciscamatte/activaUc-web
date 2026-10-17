# Cómo funciona la base de datos

El esquema son 13 tablas, 2 vistas y 8 enumeraciones. Este documento
explica dónde vive cada cosa y, sobre todo, las decisiones de diseño que
no se deducen mirando el esquema.

---

## 1. La idea en una frase

**PostgreSQL no es sólo el almacén: es donde viven las reglas.** No hay
un servidor intermedio que valide. El navegador habla directamente con
PostgreSQL a través de Supabase, y lo que lo hace seguro es que la base
no deja hacer nada que no deba, incluso si alguien usa la API a mano con
`curl`.

Eso tiene una consecuencia que explica casi todo el diseño: **cada regla
está escrita dos veces**, en la interfaz para que la experiencia sea
buena, y en la base para que sea cierta. Si sólo estuviera en la
interfaz, bastaría abrir la consola del navegador para saltarla.

---

## 2. Las trece tablas, por grupos

### Quién es quién

| Tabla | Qué guarda |
|---|---|
| `profiles` | Nombre, teléfono, rol y consentimientos de cada persona |
| `facility_admin_assignments` | Qué administrador gestiona qué recinto |

El correo y la contraseña **no** están aquí: viven en `auth.users`, que
es de Supabase. `profiles` se crea sola cuando alguien se registra, por
un disparador (`handle_new_user`).

### Qué se puede reservar

| Tabla | Qué guarda |
|---|---|
| `facilities` | Los recintos: nombre, tipo, descripción, horario |
| `time_blocks` | Los bloques horarios: inicio, fin y capacidad máxima |

### Las reservas

| Tabla | Qué guarda |
|---|---|
| `reservations` | Quién reservó qué bloque, su estado y, si la cancelaron, quién y por qué |
| `reservation_audit_log` | Todo lo que pasó: cada reserva, cancelación, envío y cambio de consentimiento |

La bitácora es sólo-añadir: nadie la edita ni la borra, ni siquiera un
administrador. Es lo que permite reconstruir qué ocurrió.

### Las integraciones

| Tabla | Qué guarda |
|---|---|
| `calendar_connections` | El token de Google de cada persona, **cifrado** |
| `calendar_sync_jobs` | Cola: eventos de calendario por crear o borrar |
| `notification_jobs` | Cola: avisos por enviar, con su canal (WhatsApp o correo) |
| `whatsapp_messages` | Qué se envió, por dónde, y qué respondió el proveedor |
| `webhook_events` | Lo que los proveedores nos informaron, para no procesarlo dos veces |
| `oauth_states` | Los `state` de OAuth en curso, de un solo uso |

> `whatsapp_messages` registra los dos canales, correo incluido. El
> nombre es histórico: nació cuando sólo existía WhatsApp.

### Defensa

| Tabla | Qué guarda |
|---|---|
| `rate_limit_counters` | Cuántas veces hizo cada persona cada cosa, por ventana de tiempo |

---

## 3. Qué apunta a qué

Casi todo cuelga de tres tablas: `profiles`, `facilities` y
`reservations`.

```
facilities ──< time_blocks ──< reservations >── profiles
    │                              │               │
    │                              ├──< calendar_sync_jobs
    │                              ├──< notification_jobs ──< whatsapp_messages
    │                              └──< reservation_audit_log
    └──< facility_admin_assignments >── profiles
                                        └──< calendar_connections
                                        └──< oauth_states
```

Las dos vistas son comodidades de lectura, no tablas:

- **`block_availability`** · cada bloque con sus cupos ya calculados
  (`reserved_count`, `available_count`, `is_full`, `is_past`). Es lo que
  el catálogo consulta, y **no expone ningún dato personal**, por eso
  puede verla alguien sin cuenta.
- **`my_reservations`** · las reservas de quien pregunta, con el nombre
  del recinto ya resuelto.

---

## 4. Lo que de verdad importa: cómo se evita el sobrecupo

Es el problema central del proyecto. Si veinte personas pulsan
«reservar» en el mismo bloque de capacidad veinte en el mismo instante,
tiene que haber exactamente veinte reservas. Ni diecinueve ni veintiuna.

**La solución no está en la aplicación, está en la transacción.** Toda
reserva pasa por una función, `create_reservation_strict`, y nadie puede
insertar en `reservations` directamente —los privilegios no lo permiten.
Esa función, dentro de una transacción:

1. **Bloquea la fila del bloque** con `SELECT … FOR UPDATE`. A partir de
   ahí, cualquier otra reserva sobre ese mismo bloque espera su turno.
2. Cuenta las reservas vigentes **ya con el bloqueo puesto**, así que el
   número que ve es real y no puede cambiar bajo sus pies.
3. Comprueba las reglas: que haya cupo, que el bloque no haya empezado,
   que el recinto esté activo, que esa persona no tenga ya una reserva
   en ese bloque.
4. Inserta, escribe la bitácora y encola los avisos.

El paso 1 es el que hace que funcione. Sin él, dos transacciones
simultáneas leerían «quedan 1 cupo» a la vez y las dos insertarían.

**Y hay un segundo cerrojo**, por si la función tuviera un error: un
índice único parcial que hace imposible que exista más de una reserva
*vigente* de la misma persona en el mismo bloque. Si la lógica falla, la
base rechaza la fila.

La prueba de concurrencia (`scripts/concurrency-test.mjs`) lanza 100
intentos simultáneos contra un bloque de capacidad 20 y exige exactamente
20 reservas, 0 sobrecupos y 0 duplicados.

---

## 5. Por qué el navegador no puede hacer trampa

Dos mecanismos, y hacen falta los dos.

**Privilegios por columna.** El punto de partida es `REVOKE ALL`: el
cliente no puede nada. Después se conceden permisos uno por uno, y sólo
los necesarios. Por ejemplo, de `profiles` puede *leer* varias columnas
pero sólo *escribir* `full_name`. Cambiarse el rol a `administrador` no
es que esté prohibido por una regla: es que **no existe el permiso**.

**Row Level Security.** Cada tabla filtra por filas según quién
pregunta. Las reservas de otra persona no es que estén ocultas en la
interfaz: no vienen en la respuesta. Un administrador ve las de sus
recintos asignados y de ningún otro.

Encima de eso, un disparador
(`prevent_profile_privilege_escalation`) rechaza cualquier intento de
cambiar el rol, como tercera barrera.

Y las columnas de tokens de Google **no son legibles por el cliente en
absoluto**. Además están cifradas con AES-256-GCM, así que ni leyendo la
tabla directamente se obtendría nada útil.

Todo esto se prueba con los roles reales de Supabase, no simulados, en
`supabase/tests/40_rls.sql`.

---

## 6. Por qué los avisos pasan por una cola

Cuando reservas, el correo o el WhatsApp **no se envía en ese momento**.
Se encola en `notification_jobs` y un proceso aparte lo manda.

El motivo: si el envío fuera parte de la transacción de la reserva, un
problema del proveedor —que su API esté lenta o caída— haría fallar la
reserva. Y reservar tiene que funcionar aunque el correo no.

La cola además permite reintentar con esperas crecientes, programar el
recordatorio para dos horas antes del bloque, y no enviar dos veces lo
mismo: cada trabajo tiene una clave de idempotencia derivada del id de
la reserva y del canal, así que encolarlo dos veces no crea dos avisos.

Los trabajos se reparten con `FOR UPDATE SKIP LOCKED`, que permite
varios procesos en paralelo sin que dos tomen el mismo.

**La cola no espera.** Un disparador invoca al worker en el instante en
que algo se encola, así que el aviso sale en 2 o 3 segundos. `pg_cron`
sigue corriendo cada minuto, pero para lo que el disparador no puede
cubrir: reintentos, recordatorios futuros, y rescatar trabajos cuyo
proceso murió a medias.

---

## 7. Dónde está cada cosa en el repositorio

| Archivo | Qué define |
|---|---|
| `supabase/migrations/…000100_core_schema.sql` | Las 13 tablas, 8 enumeraciones, índices y restricciones |
| `…000200_functions.sql` | Las funciones: reservar, cancelar, colas, administración |
| `…000300_rls_policies.sql` | `REVOKE ALL`, privilegios por columna y las políticas RLS |
| `…000400_realtime_and_cron.sql` | Realtime y las tareas programadas |
| `…000500_block_series.sql` | Publicar una temporada de bloques de una vez |
| `…000600` y `…000700` | Despacho inmediato de las colas |
| `…000800_canal_correo.sql` | El segundo canal de avisos |

Las migraciones se aplican **en orden** y nunca se editan una vez
aplicadas: un cambio es una migración nueva. Por eso hay ocho y no una.

Las pruebas viven en `supabase/tests/`, se ejecutan contra un PostgreSQL
real y cada archivo corre en su propia transacción que se revierte al
terminar. Correrlas: `npm run test:db`. Más detalle en
[PRUEBAS.md](PRUEBAS.md).

---

## 8. Para mirarla por dentro

```bash
# Conexión (lee .env.db)
source scripts/lib/db-url.sh
psql "$SUPABASE_DB_URL"
```

```sql
-- Qué hay y cuánto
select relname, n_live_tup from pg_stat_user_tables
where schemaname = 'public' order by relname;

-- La disponibilidad tal como la ve el catálogo
select * from public.block_availability order by starts_at;

-- Qué pasó últimamente
select created_at, action, details from public.reservation_audit_log
order by created_at desc limit 20;
```

> Esa conexión entra como superusuario y **se salta RLS**: es para
> operar, no para probar la seguridad. Lo que ve el navegador se prueba
> asumiendo los roles `anon` y `authenticated`, como hace
> `40_rls.sql`.

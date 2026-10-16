# Operación

Guía para quien mantiene ActivaUC en funcionamiento: tareas programadas,
monitoreo, registros, recuperación de errores y rollback.

---

## 1. Piezas en movimiento

| Componente | Dónde corre | Qué pasa si se cae |
|---|---|---|
| Frontend | S3 + CloudFront | El sitio no carga. Las reservas existentes no se ven afectadas |
| Base de datos y Auth | Supabase | Caída total: no se puede reservar ni consultar |
| Realtime | Supabase | Los cupos dejan de actualizarse al instante; el respaldo por intervalo (45 s) los mantiene al día |
| `process-calendar-jobs` | Edge Function | Los eventos de calendario se acumulan en la cola. **Las reservas siguen siendo válidas** |
| `process-notification-jobs` | Edge Function | Los WhatsApp se acumulan en la cola. **Las reservas siguen siendo válidas** |
| `twilio-status-webhook` | Edge Function | Los estados de entrega quedan desactualizados. No afecta el envío |
| `pg_cron` | PostgreSQL | Nada se procesa ni se recuerda hasta que vuelva |

**Regla de diseño que conviene recordar:** ninguna falla de integración cambia
`reservations.status`. Supabase es la fuente oficial; Calendar y WhatsApp son
informativos.

---

## 2. Tareas programadas

### Qué hay programado

```sql
select jobid, jobname, schedule, active, command from cron.job
where jobname like 'activauc%';
```

| Tarea | Frecuencia | Qué hace |
|---|---|---|
| `activauc_integraciones` | `* * * * *` (cada minuto) | Invoca `cron-dispatch`, que a su vez corre los dos workers. Los recordatorios salen cuando su `scheduled_for` vence |
| `activauc_limpieza` | `17 * * * *` (cada hora) | Borra `oauth_states` vencidos, contadores de límite viejos y webhooks de más de 90 días |

### Historial de ejecuciones

```sql
-- cron.job_run_details sólo guarda el jobid, no el nombre: hay que
-- unirla con cron.job para saber qué tarea fue cada ejecución.
select j.jobname, d.status, d.start_time, d.end_time, d.return_message
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
order by d.start_time desc limit 20;
```

O, más corto:

```bash
npm run cron:status
```

### Pausar y reanudar

Si una integración está causando problemas, pausa la tarea. Las reservas siguen
funcionando; los trabajos se acumulan y se procesan al reanudar.

```sql
update cron.job set active = false where jobname = 'activauc_integraciones';
update cron.job set active = true  where jobname = 'activauc_integraciones';
```

### Disparar a mano

Útil para no esperar el minuto durante una verificación:

```bash
curl -s -X POST "https://<ref>.supabase.co/functions/v1/cron-dispatch" \
  -H "x-cron-secret: $CRON_SECRET" | jq
```

### Rotar el `CRON_SECRET`

```bash
NUEVO=$(openssl rand -hex 32)

# 1. Actualizarlo en las Edge Functions
npx supabase secrets set CRON_SECRET="$NUEVO"

# 2. Y en la base de datos, para que pg_cron siga autenticándose
psql "$SUPABASE_DB_URL" \
  -v functions_base_url="https://<ref>.supabase.co/functions/v1" \
  -v cron_secret="$NUEVO" \
  -f supabase/cron/schedule.sql
```

Hazlo en ese orden y de corrido: entre el paso 1 y el 2 las tareas fallarán con
`401`, y los trabajos simplemente quedan en cola.

---

## 3. Monitoreo

### Tablero rápido

```sql
-- Salud de las colas
select * from private.integration_health;

-- Actividad de las últimas 24 horas
select
  (select count(*) from public.reservations
   where created_at > now() - interval '24 hours')            as reservas_creadas,
  (select count(*) from public.reservations
   where cancelled_at > now() - interval '24 hours')          as cancelaciones,
  (select count(*) from public.reservations
   where status = 'vigente' and starts_at > now())            as reservas_vigentes,
  (select count(*) from public.calendar_sync_jobs
   where status = 'error' and attempts >= max_attempts)       as calendar_fallidos,
  (select count(*) from public.whatsapp_messages
   where status = 'fallido'
     and created_at > now() - interval '24 hours')            as whatsapp_fallidos;
```

### Señales que exigen atención

| Consulta | Umbral | Significa |
|---|---|---|
| Trabajos `pendiente` con `next_attempt_at` vencido hace más de 10 min | > 0 | `pg_cron` no está corriendo, o los workers fallan al arrancar |
| Trabajos `error` con `attempts >= max_attempts` | > 0 | Fallo definitivo: requiere intervención |
| Trabajos `procesando` con `locked_at` de más de 10 min | > 0 | Un worker murió. El siguiente reclamo los rescata automáticamente |
| `webhook_events` con `signature_valid = false` | > 0 | Alguien envía solicitudes sin firma válida, o el Auth Token cambió |
| Tasa de entrega de WhatsApp | < 95 % | Incumple el requisito no funcional de interoperabilidad |

```sql
-- Trabajos atascados
select 'calendar' as cola, id, status, attempts, next_attempt_at, last_error
from public.calendar_sync_jobs
where status in ('pendiente','error')
  and next_attempt_at < now() - interval '10 minutes'
  and attempts < max_attempts
union all
select 'whatsapp', id, status::text, attempts, next_attempt_at, last_error
from public.notification_jobs
where status in ('pendiente','error')
  and greatest(scheduled_for, next_attempt_at) < now() - interval '10 minutes'
  and attempts < max_attempts;

-- Fallos definitivos
select 'calendar' as cola, reservation_id, attempts, last_error, updated_at
from public.calendar_sync_jobs where status = 'error' and attempts >= max_attempts
union all
select 'whatsapp', reservation_id, attempts, last_error, updated_at
from public.notification_jobs where status = 'error' and attempts >= max_attempts
order by updated_at desc;

-- Tasa de entrega de los últimos 30 días (objetivo: ≥95 %)
select
  count(*) filter (where status = 'entregado') as entregados,
  count(*) filter (where status = 'fallido')   as fallidos,
  round(100.0 * count(*) filter (where status = 'entregado')
        / nullif(count(*) filter (where status in ('entregado','fallido')), 0), 1)
    as porcentaje
from public.whatsapp_messages where created_at > now() - interval '30 days';

-- Conexiones de Calendar que necesitan reconectarse
select user_id, status, last_error, updated_at
from public.calendar_connections where status = 'error';
```

### Indicador de sobrecupos

Debe devolver **cero filas, siempre**. Si alguna vez devuelve algo, hay un
defecto en el control de concurrencia y es un incidente grave.

```sql
select tb.id as bloque, tb.max_capacity, count(r.id) as reservas_vigentes
from public.time_blocks tb
join public.reservations r on r.block_id = tb.id and r.status = 'vigente'
group by tb.id, tb.max_capacity
having count(r.id) > tb.max_capacity;
```

Y éste comprueba que no haya reservas duplicadas:

```sql
select user_id, block_id, count(*)
from public.reservations where status = 'vigente'
group by user_id, block_id having count(*) > 1;
```

Conviene dejar ambas consultas como alerta programada.

---

## 4. Registros

```bash
npx supabase functions logs cron-dispatch
npx supabase functions logs process-calendar-jobs
npx supabase functions logs process-notification-jobs
npx supabase functions logs twilio-status-webhook
npx supabase functions logs google-oauth-callback

# Seguir en vivo
npx supabase functions logs process-notification-jobs --follow
```

### Qué se registra y qué no

Los registros son JSON con redacción obligatoria
(`supabase/functions/_shared/log.ts`). **Nunca** contienen:

- tokens de acceso o de refresco, ni códigos de autorización
- el `client_secret` de Google ni el Auth Token de Twilio
- `ENCRYPTION_KEY` ni `CRON_SECRET`
- teléfonos completos (sólo los últimos 4 dígitos)
- correos completos (sólo el dominio)

Para correlacionar un incidente con una persona, usa `user_id` o
`reservation_id`, que sí se registran y no son datos personales por sí mismos.

### Auditoría en la base de datos

`reservation_audit_log` guarda las acciones relevantes y no contiene datos
personales ni credenciales:

```sql
select a.created_at, a.action, a.actor_role, f.name as recinto, a.details
from public.reservation_audit_log a
left join public.facilities f on f.id = a.facility_id
order by a.created_at desc limit 50;

-- Historial completo de una reserva
select created_at, action, actor_role, details
from public.reservation_audit_log
where reservation_id = '<id>' order by created_at;
```

---

## 5. Recuperación de errores

### Reintentar un trabajo

```sql
-- Google Calendar
update public.calendar_sync_jobs
set status = 'pendiente', attempts = 0, next_attempt_at = now(), last_error = null
where id = '<id>';

-- WhatsApp
update public.notification_jobs
set status = 'pendiente', attempts = 0,
    next_attempt_at = now(), scheduled_for = now(), last_error = null
where id = '<id>';
```

Luego dispara la cola a mano, o espera el próximo minuto.

### Reintentar en bloque, tras resolver una causa común

```sql
-- Todos los de Calendar que fallaron en la última hora por algo transitorio
update public.calendar_sync_jobs
set status = 'pendiente', attempts = 0, next_attempt_at = now(), last_error = null
where status = 'error'
  and updated_at > now() - interval '1 hour'
  and last_error not ilike '%invalid_grant%'      -- requiere reconectar
  and last_error not ilike '%no tiene Google Calendar conectado%';
```

**No reintentes los fallos definitivos.** Un `invalid_grant` significa que la
persona revocó el acceso desde su cuenta Google; un `63003` de Twilio, que el
número no tiene WhatsApp. Reintentar sólo consume cuota.

### Resincronizar las reservas futuras de una persona

Cuando alguien reconecta su calendario tras un error:

```sql
insert into public.calendar_sync_jobs
  (reservation_id, user_id, kind, idempotency_key, payload)
select r.id, r.user_id, 'crear_evento',
       'cal:create:' || r.id::text,
       jsonb_build_object('reservation_id', r.id)
from public.reservations r
where r.user_id = '<user_id>'
  and r.status = 'vigente'
  and r.starts_at > now()
  and r.calendar_event_id is null
on conflict (idempotency_key) do nothing;

update public.reservations
set calendar_sync_status = 'pendiente'
where user_id = '<user_id>' and status = 'vigente'
  and starts_at > now() and calendar_event_id is null;
```

La clave de idempotencia impide crear trabajos duplicados, y el id de evento
determinístico impide eventos duplicados en Google.

### Cancelar una reserva como operador

Si hace falta intervenir sin pasar por el panel, usa la función: respeta la
auditoría y encola las integraciones. Un `UPDATE` directo se las saltaría.

```sql
-- Como administrador asignado al recinto
select set_config('request.jwt.claims',
  json_build_object('sub', '<uuid del administrador>', 'role', 'authenticated')::text,
  true);

select public.cancel_reservation('<reservation_id>', 'Cierre del recinto por emergencia');
```

### Cerrar un recinto completo

Desactivarlo lo saca del catálogo, pero **no cancela** las reservas ya hechas
(deliberadamente: cancelar en masa es una decisión, no un efecto secundario).

```sql
-- 1. Quitarlo del catálogo
update public.facilities set active = false where id = '<facility_id>';

-- 2. Ver qué reservas quedarían afectadas
select r.id, r.starts_at, p.full_name
from public.reservations r join public.profiles p on p.id = r.user_id
where r.facility_id = '<facility_id>' and r.status = 'vigente' and r.ends_at > now()
order by r.starts_at;

-- 3. Cancelarlas una a una con cancel_reservation (ver arriba), para que
--    cada persona reciba su aviso y quede registrado el motivo.
```

---

## 6. Rollback

### Frontend

```bash
git checkout <commit-anterior>
bash scripts/deploy-frontend.sh --esperar
```

Alternativa desde el versionado de S3: ver `DESPLIEGUE_AWS.md` § 9.

### Edge Functions

```bash
git checkout <commit-anterior> -- supabase/functions/
bash scripts/deploy-functions.sh
```

O una sola:

```bash
bash scripts/deploy-functions.sh --solo process-notification-jobs
```

### Base de datos

Supabase no revierte migraciones. Escribe una migración inversa:

```bash
npx supabase migration new revertir_<lo_que_sea>
# el SQL que deshace el cambio
npx supabase db reset && npm run test:db      # probar en local primero
npx supabase db push
```

### Respaldos

```bash
# Respaldo manual antes de un cambio grande
npx supabase db dump --file respaldo-$(date +%Y%m%d-%H%M).sql

# Sólo los datos
npx supabase db dump --data-only --file datos-$(date +%Y%m%d).sql
```

Supabase mantiene respaldos automáticos diarios según el plan
(**Database → Backups**). Para una restauración puntual (PITR) se requiere plan
Pro o superior.

---

## 7. Mantenimiento programado

El requisito de disponibilidad pide programar las mantenciones fuera de los
horarios de mayor demanda. Para saber cuáles son:

```sql
select extract(hour from starts_at at time zone 'America/Santiago') as hora,
       count(*) as reservas
from public.reservations
where created_at > now() - interval '30 days'
group by hora order by reservas desc;
```

Durante una mantención de la base de datos:

1. Pausa `activauc_integraciones` (los trabajos se acumulan sin perderse).
2. Realiza el cambio.
3. Reanuda la tarea.
4. Verifica que las colas se vacíen: `select * from private.integration_health;`

---

## 8. Crecimiento de los datos

Tablas que crecen de forma indefinida y conviene vigilar:

| Tabla | Crecimiento | Limpieza |
|---|---|---|
| `reservation_audit_log` | Una fila por acción | Sin limpieza automática: es el registro de auditoría. Archivar al cabo de 1–2 años |
| `whatsapp_messages` | Una fila por envío | Sin limpieza automática: es la trazabilidad exigida por REQ-27 |
| `webhook_events` | Varias por mensaje | `cleanup_ephemeral_data` borra las de más de 90 días |
| `oauth_states` | Una por intento de conexión | `cleanup_ephemeral_data` borra las vencidas |
| `rate_limit_counters` | Una por usuario, acción y minuto | Limpieza oportunista + horaria |
| `calendar_sync_jobs`, `notification_jobs` | Una por reserva e integración | Sin limpieza automática. Los completados se pueden archivar |

```sql
-- Tamaño de las tablas
select relname as tabla,
       pg_size_pretty(pg_total_relation_size(c.oid)) as tamano,
       n_live_tup as filas_aprox
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc;
```

Archivar trabajos completados de más de 90 días, si hiciera falta:

```sql
delete from public.calendar_sync_jobs
where status = 'completado' and completed_at < now() - interval '90 days';

delete from public.notification_jobs
where status in ('completado','cancelado') and updated_at < now() - interval '90 days';
```

Los `whatsapp_messages` **no** se borran junto con sus trabajos: la relación es
`on delete set null`, así que la trazabilidad se conserva.

---

## 9. Guardia: primeros pasos ante un incidente

| Síntoma reportado | Primera comprobación |
|---|---|
| «No puedo reservar» | ¿Supabase responde? ¿La persona tiene el correo confirmado? ¿El bloque tiene cupos? |
| «Dice que no hay cupos y veo que sí» | Realtime desfasado. `select * from public.block_availability where block_id = '...';` da la verdad |
| «No me llegó el WhatsApp» | ¿Tiene consentimiento y teléfono? ¿Hay trabajo en cola? ¿`pg_cron` corre? |
| «No aparece en mi calendario» | ¿Su conexión está en `conectado`? ¿El trabajo quedó en `error`? |
| «Me cancelaron la reserva» | `select * from public.reservation_audit_log where reservation_id = '...';` dice quién, cuándo y por qué |
| «El sitio no carga» | CloudFront y el estado de S3. Las reservas no se han perdido |
| Sospecha de sobrecupo | La consulta del § 3 «Indicador de sobrecupos». Si devuelve filas, es un incidente grave: preservar los datos y revisar `create_reservation_strict` |

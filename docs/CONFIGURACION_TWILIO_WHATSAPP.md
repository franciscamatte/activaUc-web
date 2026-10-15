# Configuración de Twilio WhatsApp

Envío de confirmaciones, recordatorios y avisos de cancelación administrativa
por WhatsApp (REQ-22 a REQ-27).

**El navegador nunca habla con Twilio.** La única salida es la Edge Function
`process-notification-jobs`, que lee los trabajos de la cola
`notification_jobs`.

---

## Cómo funciona

```
create_reservation_strict
   │ encola, sólo si hay consentimiento y teléfono válido
   ├─► notification_jobs (confirmacion, scheduled_for = ahora)
   └─► notification_jobs (recordatorio,  scheduled_for = inicio − 2 h)
                             │
   pg_cron (cada minuto) ──► cron-dispatch ──► process-notification-jobs
                             │ claim_notification_jobs:
                             │  · scheduled_for ya venció
                             │  · consentimiento vigente
                             │  · teléfono presente
                             │  · reserva no cancelada
                             ├─► Twilio Messages API
                             └─► whatsapp_messages (trazabilidad)
                                      ▲
   Twilio ──► twilio-status-webhook ───┘
              · valida X-Twilio-Signature
              · idempotente por (provider, sid, estado)
```

---

## 1. Cuenta de Twilio

1. Crea una cuenta en <https://www.twilio.com/try-twilio>.
2. En la consola, copia **Account SID** y **Auth Token**.
3. Para producción hace falta cuenta de pago: la de prueba sólo envía a números
   verificados.

---

## 2. Sandbox (desarrollo y pruebas)

El Sandbox permite probar el flujo completo sin trámites de aprobación.

1. Consola → **Messaging → Try it out → Send a WhatsApp message**.
2. Verás un número (normalmente `+1 415 523 8886`) y un código como
   `join <dos-palabras>`.
3. **Cada número que vaya a recibir mensajes** debe enviar ese código por
   WhatsApp al número del Sandbox. Es un requisito de WhatsApp, no de ActivaUC.
4. La sesión del Sandbox caduca a las 72 horas de inactividad; hay que repetir
   el `join`.

Configuración para el Sandbox:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=<auth token>
TWILIO_WHATSAPP_FROM=+14155238886

# Sin ContentSid: los mensajes salen como texto libre, que es lo que
# el Sandbox admite.
TWILIO_CONTENT_SID_CONFIRMACION=
TWILIO_CONTENT_SID_RECORDATORIO=
TWILIO_CONTENT_SID_CANCELACION=
```

---

## 3. Producción: WhatsApp Sender

1. Consola → **Messaging → Senders → WhatsApp senders → New sender**.
2. Vincula un número propio o compra uno en Twilio. **No puede ser un número
   que ya tenga WhatsApp personal o Business activo.**
3. Completa el perfil de empresa de Meta (**Meta Business Manager**): nombre
   legal, sitio web, categoría y datos de contacto.
4. Espera la aprobación de Meta: habitualmente de horas a algunos días.

Una vez aprobado:

```bash
TWILIO_WHATSAPP_FROM=+56XXXXXXXXX    # el número aprobado, en E.164
```

---

## 4. Plantillas aprobadas

WhatsApp sólo permite mensajes de texto libre dentro de una ventana de 24 horas
desde el último mensaje de la persona. Las notificaciones de ActivaUC son
iniciadas por la plataforma, así que **en producción requieren plantillas
aprobadas**.

Consola → **Messaging → Content Template Builder → Create new**.

Hay que crear tres plantillas. El texto debe coincidir con
`supabase/functions/_shared/messages.ts`, y el **orden de las variables es
obligatorio**.

### 4.1 Confirmación de reserva

| Campo | Valor |
|---|---|
| Nombre | `activauc_confirmacion_reserva` |
| Idioma | Español (`es`) |
| Categoría | **Utility** |

Cuerpo:

```
Hola {{1}}: tu reserva en {{2}} quedó confirmada para el {{3}}. Puedes revisarla o cancelarla en ActivaUC (hasta 2 horas antes del inicio).
```

| Variable | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Primer nombre | `Camila` |
| `{{2}}` | Nombre del recinto | `Cancha de fútbol San Joaquín` |
| `{{3}}` | Fecha y hora | `viernes 17 de octubre, 18:00` |

### 4.2 Recordatorio

| Campo | Valor |
|---|---|
| Nombre | `activauc_recordatorio_reserva` |
| Idioma | Español (`es`) |
| Categoría | **Utility** |

```
Hola {{1}}: te recordamos tu reserva en {{2}} hoy a las {{3}}. ¡Te esperamos en Deportes UC!
```

Mismas tres variables.

### 4.3 Cancelación administrativa

| Campo | Valor |
|---|---|
| Nombre | `activauc_cancelacion_admin` |
| Idioma | Español (`es`) |
| Categoría | **Utility** |

```
Hola {{1}}: lamentamos informarte que tu reserva en {{2}} del {{3}} fue cancelada por la administración del recinto (motivo: {{4}}). Puedes reservar otro bloque disponible en ActivaUC.
```

| Variable | Contenido |
|---|---|
| `{{1}}` | Primer nombre |
| `{{2}}` | Nombre del recinto |
| `{{3}}` | Fecha y hora |
| `{{4}}` | Motivo (por omisión, `mantención del recinto`) |

> Usa la categoría **Utility**, no Marketing: son notificaciones transaccionales
> de un servicio que la persona solicitó. Clasificarlas como Marketing
> encarece el envío y puede hacer que Meta rechace la plantilla.

Al aprobarse, cada plantilla tiene un **ContentSid** que empieza con `HX`:

```bash
TWILIO_CONTENT_SID_CONFIRMACION=HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TWILIO_CONTENT_SID_RECORDATORIO=HXbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
TWILIO_CONTENT_SID_CANCELACION=HXcccccccccccccccccccccccccccccccc
```

Con esas variables definidas, el worker usa la plantilla aprobada; sin ellas,
cae a texto libre. El cambio no requiere modificar código.

---

## 5. Webhook de estados

Es lo que mantiene al día `whatsapp_messages` (REQ-27).

### 5.1 Configurar la URL

```bash
TWILIO_STATUS_CALLBACK_URL=https://<ref>.supabase.co/functions/v1/twilio-status-webhook
```

ActivaUC envía esa URL en cada mensaje como `StatusCallback`, así que **no hace
falta configurarla en la consola de Twilio**. Si prefieres fijarla también a
nivel de servicio, hazlo en **Messaging → Services → tu servicio →
Integration**.

### 5.2 Seguridad

El webhook rechaza con `403` cualquier solicitud cuya firma
`X-Twilio-Signature` no valide contra el `TWILIO_AUTH_TOKEN`. Además,
`register_webhook_event` tiene una restricción única sobre
`(provider, external_id, event_type)`, de modo que una reentrega del mismo
evento se descarta: eso es la protección anti-replay.

Si hay un proxy que altera el host, la URL reconstruida puede no coincidir con
la que Twilio firmó. En ese caso, fija el valor exacto:

```bash
TWILIO_WEBHOOK_URL=https://<ref>.supabase.co/functions/v1/twilio-status-webhook
```

### 5.3 Mapeo de estados

| Estado de Twilio | Estado interno |
|---|---|
| `queued`, `accepted`, `scheduled`, `sending` | `pendiente` |
| `sent` | `enviado` |
| `delivered`, `read` | `entregado` |
| `undelivered`, `failed` | `fallido` |

Un estado anterior nunca retrocede a un mensaje ya `entregado`; un estado
desconocido se ignora sin romper nada.

---

## 6. Cargar y desplegar

```bash
bash scripts/set-secrets.sh
bash scripts/deploy-functions.sh
```

---

## 7. Verificación con la cuenta real

### 7.1 Consentimiento

1. En **Datos personales**, activa la casilla e ingresa tu número en E.164
   (`+56912345678`).
2. Prueba que un número mal formado se rechaza con un mensaje claro: debe
   indicar el formato esperado.

```sql
select whatsapp_consent, whatsapp_consent_at, right(phone, 4) as ultimos_4
from public.profiles where id = '<tu id>';
```

### 7.2 Confirmación

1. Reserva un bloque **con más de 2 horas de anticipación**.
2. Dispara la cola:

```bash
curl -s -X POST "https://<ref>.supabase.co/functions/v1/cron-dispatch" \
  -H "x-cron-secret: $CRON_SECRET" | jq
```

3. Debe llegar el WhatsApp de confirmación en español.

```sql
select kind, status, provider_message_sid, sent_at, right(to_phone, 4)
from public.whatsapp_messages order by created_at desc limit 5;
```

4. A los pocos segundos, el webhook debe actualizar el estado a `entregado`:

```sql
select provider, external_id, event_type, signature_valid, processed_at
from public.webhook_events order by created_at desc limit 5;
```

`signature_valid` debe ser `true`. Si hay filas con `false`, alguien está
enviando solicitudes sin firma válida (o el `TWILIO_AUTH_TOKEN` está mal).

### 7.3 Regla de las 2 horas (REQ-25)

Es la regla más fácil de implementar mal, así que conviene probar los dos lados:

| Caso | Resultado esperado |
|---|---|
| Reserva creada con **más** de 2 h de anticipación | Confirmación inmediata **y** recordatorio programado a `inicio − 2 h` |
| Reserva creada con **menos** de 2 h de anticipación | Sólo confirmación. **Ningún** trabajo de recordatorio |

```sql
select kind, status, scheduled_for, r.starts_at,
       (r.starts_at - nj.scheduled_for) as anticipacion
from public.notification_jobs nj
join public.reservations r on r.id = nj.reservation_id
order by nj.created_at desc limit 10;
```

Para la reserva lejana, `anticipacion` debe ser exactamente `02:00:00`. Para la
cercana, no debe existir fila con `kind = 'recordatorio'`.

### 7.4 Recordatorio

Sin esperar dos horas, adelanta la programación:

```sql
update public.notification_jobs
set scheduled_for = now(), next_attempt_at = now()
where kind = 'recordatorio' and status = 'pendiente';
```

Dispara la cola: debe llegar el recordatorio.

### 7.5 Cancelación administrativa (REQ-26)

1. Con una cuenta administradora, cancela una reserva de alguien que tenga
   WhatsApp habilitado, indicando un motivo.
2. Dispara la cola: debe llegar el aviso con el motivo incluido.

### 7.6 Revocación (REQ-23)

1. En **Datos personales**, pulsa **Eliminar número y revocar**.
2. Verifica que no lleguen más mensajes:

```sql
select phone, whatsapp_consent from public.profiles where id = '<tu id>';
-- phone en NULL y consentimiento en false

select kind, status, last_error from public.notification_jobs
where user_id = '<tu id>' order by created_at desc;
-- los pendientes quedan en 'cancelado'
```

3. Reserva otro bloque: **no** debe encolarse ninguna notificación.

---

## 8. Paso a producción

| Antes de abrir al público | Estado |
|---|---|
| Cuenta de pago (no de prueba) | |
| WhatsApp Sender aprobado por Meta | |
| Las tres plantillas aprobadas, con sus ContentSid cargados | |
| `TWILIO_WHATSAPP_FROM` con el número aprobado | |
| `TWILIO_STATUS_CALLBACK_URL` apuntando a la función pública | |
| Webhook verificado: `signature_valid = true` en `webhook_events` | |
| Flujo completo probado: confirmación, recordatorio, cancelación, revocación | |
| Alerta configurada sobre mensajes `fallido` (ver `OPERACION.md`) | |

Usa **subcuentas de Twilio** separadas para desarrollo y producción, de modo que
un Auth Token de pruebas filtrado no permita enviar mensajes reales.

---

## 9. Diagnóstico

### Códigos de error de Twilio

El worker los clasifica para decidir si reintenta
(`supabase/functions/_shared/twilio.ts`):

| Código | Significado | Reintenta | Qué hacer |
|---|---|---|---|
| `21211` | Número inválido | No | Pedir a la persona que corrija su número |
| `21610` | El destinatario se dio de baja | No | Respetar la baja; revocar su consentimiento |
| `21614` | No es un móvil válido | No | Corregir el número |
| `63003` | El destino no tiene WhatsApp | No | Informar a la persona |
| `63024` | Mensaje no permitido (fuera de ventana, sin plantilla) | No | Usar plantilla aprobada |
| `20429` | Demasiadas solicitudes | Sí | Se reintenta con retroceso |
| `20500`, `20503` | Error interno de Twilio | Sí | Se reintenta con retroceso |

### Estado de la cola

```sql
-- Resumen
select status, count(*), min(scheduled_for), max(updated_at)
from public.notification_jobs group by status;

-- Envíos fallidos definitivos
select m.kind, m.status, m.error_code, m.error_message, m.created_at,
       f.name as recinto
from public.whatsapp_messages m
left join public.reservations r on r.id = m.reservation_id
left join public.facilities f on f.id = r.facility_id
where m.status = 'fallido' order by m.created_at desc limit 20;

-- Tasa de entrega (requisito no funcional: ≥95 %)
select
  count(*) filter (where status = 'entregado')                as entregados,
  count(*) filter (where status = 'fallido')                  as fallidos,
  round(100.0 * count(*) filter (where status = 'entregado')
        / nullif(count(*) filter (where status in ('entregado','fallido')), 0), 1)
    as porcentaje_entrega
from public.whatsapp_messages
where created_at > now() - interval '30 days';
```

### Registros

```bash
npx supabase functions logs process-notification-jobs
npx supabase functions logs twilio-status-webhook
```

Los registros **no contienen** el Auth Token ni el teléfono completo: el
logger enmascara los números dejando sólo los últimos 4 dígitos
(`supabase/functions/_shared/log.ts`).

### Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| No llega ningún mensaje | `pg_cron` no está disparando | `select * from cron.job_run_details order by start_time desc limit 5;` |
| «La integración aún no está configurada» | Faltan secretos de Twilio | `bash scripts/set-secrets.sh` y volver a desplegar |
| Error `63024` en todos los envíos | Producción sin plantillas aprobadas | Cargar los ContentSid |
| Los mensajes quedan en `enviado` y nunca en `entregado` | El webhook no está llegando | Revisar `TWILIO_STATUS_CALLBACK_URL` y los registros del webhook |
| `webhook_events` con `signature_valid = false` | `TWILIO_AUTH_TOKEN` incorrecto, o un proxy altera el host | Verificar el token; fijar `TWILIO_WEBHOOK_URL` |
| Nada se envía a un usuario concreto | Revocó el consentimiento o su teléfono es inválido | `select whatsapp_consent, phone is not null from public.profiles where id = '...';` |
| En el Sandbox dejó de llegar | La sesión de 72 h caducó | Reenviar el código `join` |

### Reintentar envíos

Tras corregir la causa:

```sql
-- Un trabajo concreto
update public.notification_jobs
set status = 'pendiente', attempts = 0, next_attempt_at = now(), last_error = null
where id = '<id>';

-- Todos los que fallaron por un error transitorio en la última hora
update public.notification_jobs
set status = 'pendiente', attempts = 0, next_attempt_at = now(), last_error = null
where status = 'error'
  and updated_at > now() - interval '1 hour'
  and last_error not ilike '%no tiene WhatsApp%';
```

No reintentes los fallos definitivos (número inválido, destinatario dado de
baja): sólo consumen cuota y vuelven a fallar.

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
   disparador al encolar ───► cron-dispatch ──► process-notification-jobs
   y pg_cron cada minuto     │
   (vencidos y reintentos)   │
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
2. Verás un número y un código como `join <dos-palabras>`.

   > **El número del Sandbox depende de la cuenta.** El `+1 415 523 8886`
   > que circula en tutoriales es uno de varios; a esta cuenta le tocó un
   > `+1 737 …`. Copia el que muestre **tu** consola. Enviar desde un
   > número que no es el de tu Sandbox falla con `21654`, y el mensaje de
   > error no dice que el `From` esté mal. Para comprobar cuál es el tuyo:
   >
   > ```bash
   > curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"    >   "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages.json?PageSize=20"    >   | jq -r '.messages[] | select(.direction=="inbound") | .to'
   > ```
   >
   > El destinatario de tu propio `join` es el número del Sandbox.
3. **Cada número que vaya a recibir mensajes** debe enviar ese código por
   WhatsApp al número del Sandbox. Es un requisito de WhatsApp, no de ActivaUC.
4. La sesión del Sandbox caduca a las 72 horas de inactividad; hay que repetir
   el `join`.

Configuración para el Sandbox:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=<auth token>
TWILIO_WHATSAPP_FROM=+1XXXXXXXXXX    # el de TU Sandbox, ver arriba
```

### 2.1 En cuenta Trial, `ContentSid` es obligatorio (verificado el 16/10/2026)

Muchos tutoriales —y una versión anterior de este documento— dicen que
dentro de la ventana de 24 h que abre el `join` se puede responder con
texto libre (`Body`). **En una cuenta Trial eso no funciona.** Lo que
dice la guía de Twilio para cuentas de prueba es explícito:

> `ContentSid`: (Required) Must specify one of the Twilio-provided
> WhatsApp template messages shown on the **Try out WhatsApp** page in
> the Console. […] You'll choose from a few pre-approved WhatsApp
> template messages. You won't be able to write your own message.

Comprobado contra la API, con el `From` correcto del Sandbox, el `To`
idéntico al número que envió el `join` y la sesión abierta once minutos
antes:

```
POST /Messages.json  To=whatsapp:+569…  From=whatsapp:+1737…  Body=…
→ HTTP 400 · 21654 · ContentSid Required
```

Conviene no confundirse con un detalle: la **respuesta automática** del
Sandbox sí sale como texto libre y queda registrada como `outbound-api`.
La envía Twilio desde dentro, y no es una excepción que la cuenta pueda
usar.

#### Qué se puede probar sin pagar

Todo el encadenamiento: cola → worker → Twilio → entrega → webhook de
estados. Para eso basta poner en los `TWILIO_CONTENT_SID_*` uno de los
identificadores `HX…` que lista **Messaging → Try it out → Send a
WhatsApp message**. No se pueden leer por API —`content.twilio.com`
responde `20003` en Trial—, hay que copiarlos de la consola.

La limitación es que el **texto** será el de la plantilla de Twilio, no
el de ActivaUC, y que el número de variables tiene que coincidir:
`buildContentVariables` envía `1`, `2` y `3` (más `4` en la cancelación
administrativa), así que hace falta una plantilla de muestra con ese
mismo número de variables, o Twilio responde `63028`.

#### Qué requiere salir de Trial

Los textos propios de las secciones 4.1 a 4.3, porque crearlos usa el
Content API. Al hacerlo, el código no cambia: basta sustituir los tres
`TWILIO_CONTENT_SID_*` por los de las plantillas propias y recargar los
secretos.

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

### 4.4 Si la plantilla espera otras variables

El orden por omisión es el de arriba: `{{1}}` nombre, `{{2}}` recinto, `{{3}}`
fecha y hora, y `{{4}}` el motivo en la cancelación. Cuando la plantilla
aprobada quede con otro orden —o con menos variables—, se ajusta por
configuración, sin tocar el código:

```bash
TWILIO_CONTENT_VARS_CONFIRMACION=recinto,fechaHora,nombre
TWILIO_CONTENT_VARS_RECORDATORIO=nombre,fechaHora
TWILIO_CONTENT_VARS_CANCELACION=ninguna
```

Campos admitidos: `nombre`, `recinto`, `fechaHora`, `motivo`. El valor
`ninguna` envía la plantilla **sin** variables, que es lo que necesitan las
plantillas de muestra de Twilio. Un campo mal escrito hace fallar el trabajo
con un mensaje explícito, en lugar de enviar los datos descolocados.

Si el número de variables no coincide con el de la plantilla, Twilio responde
`63028`.

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

**Contra qué URL se valida.** La firma de Twilio se calcula sobre el URL
completo al que llamó, así que hay que validar contra ése. La función usa
`TWILIO_STATUS_CALLBACK_URL` —el que le dimos como `StatusCallback`, que es por
definición el que Twilio firma— y sólo cae en reconstruirlo a partir de la
solicitud si no está definido.

Reconstruirlo **no funciona** en una Edge Function: `request.url` llega sin el
prefijo `/functions/v1`, así que la firma nunca coincide y se rechazan con
`403` las llamadas legítimas. Fue un defecto real, corregido el 16/10/2026 tras
verlo en producción, y queda fijado en `twilioWhatsapp.test.ts` › «sin la URL
fijada no puede reconstruir la de una Edge Function».

`TWILIO_WEBHOOK_URL` sigue estando, y tiene prioridad, para el caso de un proxy
que publique un URL distinto del registrado:

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
| `21654` | `ContentSid Required` | No | Tres causas posibles, en este orden: el `From` no es el número de tu Sandbox; la cuenta exige plantilla y los `TWILIO_CONTENT_SID_*` están vacíos; o se enviaron `ContentVariables` sin `ContentSid` |
| `20003` | La función no está disponible en cuenta Trial | No | Salir de Trial; afecta al Content API, o sea a las plantillas |
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
# panel → Functions → process-notification-jobs → Logs
# panel → Functions → twilio-status-webhook → Logs
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

---

## 10. Cambiar de cuenta de Twilio

Nada en la base de datos depende de la cuenta, así que cambiarla es sólo
mover secretos. Lo que engaña es que hay tres valores que parecen
universales y son **por cuenta**.

> Twilio prohíbe en su política de uso abrir cuentas de prueba nuevas
> para seguir sin pagar, y puede suspenderlas. Esta sección vale igual
> para los casos legítimos: pasar a una cuenta de pago, a una del
> equipo, o a una de otro proyecto.

### 10.1 Qué cambia

| Variable | ¿Cambia? | Por qué |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | **Sí** | Identifica la cuenta |
| `TWILIO_AUTH_TOKEN` | **Sí** | Es de la cuenta, y se invalida al rotarlo |
| `TWILIO_WHATSAPP_FROM` | **Sí** | El número del Sandbox depende de la cuenta (§ 2) |
| `TWILIO_CONTENT_SID_*` | **Sí** | Los `HX` de muestra son de cada cuenta |
| `TWILIO_EMAIL_FROM` | No, si está vacío | Se deriva del Account SID nuevo solo |
| `TWILIO_EMAIL_*_FIJO` | Comprobar | El texto de muestra suele ser el mismo, pero hay que verificarlo |
| `TWILIO_STATUS_CALLBACK_URL` | No | Es una URL nuestra, no de Twilio |
| `ENCRYPTION_KEY`, `CRON_SECRET`, Google, `APP_*` | No | No tienen relación con Twilio |

### 10.2 Los pasos

```bash
# 1. Editar .env.secrets con el SID y el token nuevos.
#    El número y los ContentSid se dejan como estén por ahora.

# 2. Ver qué falta. El diagnóstico dice el número del Sandbox de la
#    cuenta nueva y avisa si el configurado no es el suyo.
bash scripts/diagnose-twilio.sh

# 3. Desde tu WhatsApp, enviar el «join <dos-palabras>» de la consola
#    de la cuenta nueva. Es un Sandbox distinto: el join anterior no
#    sirve.

# 4. Copiar de la consola los ContentSid de muestra y el número, y
#    volver a ejecutar el diagnóstico hasta que no marque nada.

# 5. Cargar y desplegar.
bash scripts/set-secrets.sh
bash scripts/deploy-functions.sh
```

### 10.3 Lo que queda del pasado

Los `provider_message_sid` ya guardados en `whatsapp_messages` pertenecen
a la cuenta anterior, así que dejan de poderse consultar en la consola de
Twilio. No rompe nada —la trazabilidad interna sigue completa— pero
conviene saberlo si algún día hay que auditar un envío viejo.

Y si quedaran trabajos a medio reintentar de antes del cambio, saldrán
con las credenciales nuevas, que es lo correcto.

# Correos de autenticación (REQ-5, REQ-6)

Confirmación de cuenta y recuperación de contraseña. Es el punto que
falló con direcciones `@uc.cl`, y conviene entender por qué antes de
configurar nada.

---

## 1. Qué pasó, con datos

Tres cuentas creadas el 15/10/2026 en el proyecto real:

| Correo | Enlace enviado | Enlace consumido | ¿Inició sesión? |
|---|---|---|---|
| `njllanos@uc.cl` | 20:14:00 | **20:14:20** | nunca |
| `njllanos.b@gmail.com` | 20:15:19 | 20:15:30 | sí, al instante |
| `njllanos.b@uc.cl` | 23:52:23 | nunca | nunca |

Dos problemas distintos, los dos del lado institucional:

**El enlace se consume solo.** El primero quedó usado veinte segundos
después de enviarse, y nadie inició sesión. Eso no lo hace una persona:
es el escáner de enlaces de Microsoft 365 (*Safe Links*), que abre los
enlaces de los mensajes entrantes para comprobar si son maliciosos. Los
enlaces de Supabase son **de un solo uso**, así que al abrirlos el
escáner los gasta y la persona se queda fuera, con un «enlace inválido o
caducado» que no tiene forma de resolver.

**La entrega se retrasa.** El tercero no se consumió nunca, y el correo
de recuperación de las 23:53 llegó «al cabo de un rato». Es el servidor
de la universidad reteniendo mensajes (*greylisting*) de un remitente que
no reconoce, que en este caso es el emisor compartido que Supabase usa
por omisión.

---

## 2. El arreglo: código en vez de enlace

Un código de 6 dígitos no se puede gastar por visitarlo, porque no hay
nada que visitar. Es el único arreglo robusto para el primer problema:
mientras el correo lleve un enlace de un solo uso, el escáner lo va a
abrir.

Implementado así:

- `supabase/templates/confirmacion.html` y `recuperacion.html` muestran
  `{{ .Token }}` y **ningún enlace**.
- La página `/verificar` pide el código y llama a `verifyOtp` (`email`
  para el alta, `recovery` para la contraseña).
- «Revisa tu correo», tanto en el registro como en la recuperación,
  enlaza directo a esa página.

El enlace sigue funcionando para quien lo reciba intacto —Gmail, por
ejemplo— porque Supabase manda ambos mecanismos para el mismo token. Lo
que se quitó es la **dependencia** del enlace.

### 2.1 Cargar las plantillas en el proyecto hospedado

`supabase/config.toml` las aplica al entorno local, pero un proyecto en
la nube se configura en el panel; no hay forma de hacerlo con `db push`.
Una vez, a mano:

1. Panel → **Authentication → Emails**.
2. En **Confirm signup**, pegar el contenido de
   `supabase/templates/confirmacion.html`.
3. En **Reset password**, pegar `supabase/templates/recuperacion.html`.
4. Guardar.

> Mientras no se haga esto, los correos llevan la plantilla por omisión
> de Supabase, que es un enlace: el problema del escáner sigue vivo.
> La página `/verificar` funciona igual, porque el código viaja en el
> mismo correo que el enlace, pero la plantilla por omisión no lo
> muestra.

### 2.2 Comprobarlo

```sql
-- Tras pedir un código, debe aparecer el envío y, al verificarlo,
-- la confirmación. Si `confirmado` queda con la hora del envío más
-- unos segundos y `ultimo_acceso` sigue vacío, algo volvió a abrir
-- un enlace: la plantilla no se cargó.
select email,
       confirmation_sent_at, email_confirmed_at, last_sign_in_at
from auth.users order by created_at desc limit 5;
```

En modo simulado (sin `.env`) el código es siempre `000000`.

---

## 3. El segundo problema: SMTP propio

El retraso de entrega no lo arregla el código. Lo arregla dejar de usar
el emisor por omisión de Supabase, que además **está limitado a unos
pocos correos por hora** y la propia documentación de Supabase marca
como sólo para pruebas.

Panel → **Project Settings → Authentication → SMTP Settings** →
*Enable Custom SMTP*:

| Campo | Qué poner |
|---|---|
| Host, Port | Los del proveedor (587 con STARTTLS es lo habitual) |
| Username, Password | Las credenciales del proveedor |
| Sender email | Una dirección del dominio que estés autenticando |
| Sender name | `ActivaUC` |

Y en el DNS de ese dominio, los tres registros que hacen que un correo
no se considere sospechoso: **SPF**, **DKIM** y **DMARC**. El proveedor
los entrega al dar de alta el dominio.

Tres caminos, en orden de preferencia para este proyecto:

1. **SMTP institucional de la UC.** Es el ideal: un correo
   `@uc.cl` hacia `@uc.cl` no se retiene ni se filtra. Hay que pedirlo a
   la dirección de informática, con el dominio de la aplicación.
2. **Un proveedor transaccional** (Resend, Postmark, SendGrid, Brevo;
   todos tienen plan gratuito suficiente para un curso). Requiere un
   dominio propio para autenticar; con el subdominio gratuito del
   proveedor la entrega a `@uc.cl` mejora pero no es garantía.
3. **Dejarlo como está** y asumir que a `@uc.cl` los correos tardan. Con
   el código de 6 dígitos esto ya no bloquea a nadie: el correo llega,
   aunque tarde, y el código sigue sirviendo una hora.

> **Twilio Email no sirve para esto.** En el plan de prueba el remitente
> es fijo, `ACxxxx@twilio.email`, un dominio que no controlas y que
> `@uc.cl` va a filtrar igual o peor. Para notificaciones de reserva
> —donde da igual quién firme— puede valer; para autenticación, no.

---

## 4. Caducidad

Por omisión el código vive una hora. Si con el retraso institucional
resulta corto, panel → **Authentication → Providers → Email → Email OTP
Expiration**. No conviene pasar de unas horas: es el margen en que
alguien con acceso al correo puede tomar la cuenta.

---

## 5. Limitación que queda

Que las plantillas se carguen a mano es un paso manual, y si alguien
crea otro proyecto de Supabase desde cero hay que repetirlo. La
alternativa sería la Management API de Supabase, que requiere un token
de acceso personal y añade un secreto más que custodiar; para un paso
que se hace una vez por entorno, no vale la pena.

---

## 6. Otra cosa: las notificaciones de reserva por correo

Lo de arriba es el correo de **autenticación**, que manda Supabase. Aparte
existe el correo de **notificaciones** —confirmación y recordatorio de
reserva—, que manda Twilio y que cada persona activa o no en «Datos
personales».

Son canales independientes del de WhatsApp: se puede tener uno, el otro,
los dos o ninguno. Lo decide `profiles.email_consent`, y sin
consentimiento no sale nada.

### 6.1 Lo que el plan de prueba de Twilio permite

Lo mismo que con WhatsApp: **el contenido no es libre**. Comprobado el
16/10/2026 contra la cuenta real:

```
POST comms.twilio.com/v1/Emails   (asunto y HTML de ActivaUC)
→ HTTP 400 · Invalid template: email content does not match any approved template
```

Y el remitente también es fijo, `<AccountSid>@twilio.email`.

Para ejercer la cadena completa sin pagar se fija el contenido con el de
una plantilla de muestra, copiado **tal cual** de la consola (Messaging →
Try it out → Send an email):

```bash
TWILIO_EMAIL_ASUNTO_FIJO='Reminder: Your Upcoming Appointment'
TWILIO_EMAIL_HTML_FIJO='<p><b>This is a test email from Twilio.</b></p>…'
```

> Las comillas simples no son opcionales: `.env.secrets` lo interpreta el
> shell, y un valor con espacios sin comillas rompe la carga.

Con eso verificado el 16/10/2026: reserva → cola → despacho inmediato →
worker → Twilio, correo aceptado en **3 s** con su `operationId`, y
WhatsApp en paralelo en 2 s.

### 6.2 Lo que requiere salir de Trial

Vaciar las dos variables y ya: entonces se envían el asunto y el cuerpo
propios de ActivaUC, con los datos de la reserva
(`buildSubject` / `buildEmailHtml`). Conviene además verificar un dominio
propio en Twilio y ponerlo en `TWILIO_EMAIL_FROM`, porque un correo desde
`@twilio.email` hacia `@uc.cl` se va a filtrar igual que los de
autenticación.

### 6.3 Lo que no hay

La API de correo de Twilio es **asíncrona y sin webhook de estados**: no
devuelve el identificador de un mensaje, sino un `operationId` de la
operación encolada. Eso significa que del correo se sabe que Twilio lo
aceptó, no que se entregó, y que `whatsapp_messages.status` se queda en
`enviado` sin pasar a `entregado` como sí ocurre en WhatsApp. Para
seguirle la pista hay que ir a la consola de Twilio con ese
`operationId`.

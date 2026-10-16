# Alternativas a Twilio

Consultado el **16/10/2026**. Los planes gratuitos cambian seguido y
varias de las cifras de abajo vienen de comparativas de terceros que se
contradicen entre sí, así que **confirma en la página de precios del
proveedor** antes de construir sobre ellas.

---

## 1. Lo primero: qué está bloqueando y qué no

Conviene separar dos cosas que se confunden.

**La aprobación de plantillas de WhatsApp la exige Meta, no Twilio.**
Cualquier mensaje que inicie la plataforma —y la confirmación, el
recordatorio y el aviso de cancelación lo son— necesita una plantilla
aprobada por Meta. Ningún proveedor evita eso, porque no es suyo.

**Lo que sí es de Twilio es la restricción que nos bloquea hoy:** en
cuenta Trial sólo se puede enviar con *sus* plantillas de muestra, y el
Content API —donde se crean las propias— responde `20003`. Eso es
política de Twilio, no de WhatsApp, y ahí sí hay alternativa.

Lo que ActivaUC necesita de un proveedor:

| Necesidad | Para qué |
|---|---|
| API HTTP (no sólo SMTP) | Las Edge Functions envían con `fetch`, no con SMTP |
| SMTP | Supabase Auth sólo acepta SMTP para sus correos (REQ-5, REQ-6) |
| Contenido propio | Los textos de `_shared/messages.ts` |
| Webhook de estados | REQ-27, la trazabilidad de entrega |

---

## 2. WhatsApp · Meta Cloud API directo

La alternativa real a Twilio para WhatsApp es **no usar intermediario**:
la Cloud API de Meta.

**Lo que mejora.** El acceso a la API no se cobra, y desde el primer día
puedes crear y usar **tus propias plantillas**: desaparece por completo
el problema de las muestras. También desaparece el margen que cobra
Twilio sobre cada mensaje.

**Lo que no es gratis.** Desde julio de 2025 Meta cobra **por mensaje**
entregado, no por conversación. Las de categoría *Utility* —la nuestra—
rondan **USD 0,0034–0,004** cada una según el país y la fecha de la
tarifa consultada. Y el periodo en que las plantillas *Utility* dentro
de la ventana de 24 horas eran gratis **terminó el 30/09/2026**, así que
hoy se cobran. Hay una franquicia de los primeros 1.000 mensajes de
servicio al mes por número, pero aplica a los de servicio, no a las
plantillas que inicia la plataforma.

Para dimensionarlo: 500 reservas con confirmación y recordatorio son
1.000 mensajes, del orden de **USD 3,4**. No es gratis, pero tampoco es
el obstáculo que parecía.

**Lo que hay que hacer.** Cuenta de Meta Business, un número de teléfono
que no tenga WhatsApp activo, las plantillas creadas y aprobadas, y un
medio de pago en el Billing Hub. Sin verificación de empresa el límite es
del orden de 250 destinatarios al día, que para un curso sobra.

**Lo que costaría en código.** Moderado y acotado. El worker ya está
abstraído por canal, y lo específico de Twilio vive en dos archivos:

- `_shared/twilio.ts` → un `sendWhatsApp` equivalente contra
  `graph.facebook.com/v*/{phone_number_id}/messages`, con el cuerpo de
  plantilla de Meta (`template.name` y `components`) en lugar de
  `ContentSid` y `ContentVariables`.
- `twilio-status-webhook` → Meta firma con `X-Hub-Signature-256`
  (HMAC-SHA256 del cuerpo), no con `X-Twilio-Signature` (HMAC-SHA1 de
  URL más parámetros). Hay que añadir ese verificador; el resto del
  webhook —idempotencia, mapeo de estados— se reutiliza igual.

Unas 250–300 líneas con sus pruebas. No toca la base de datos.

### Intermediarios con plan gratuito

**360dialog, Gupshup, Wati, Interakt** y similares revenden la Cloud
API. Algunos tienen plan gratuito, pero **el costo por mensaje de Meta
se paga igual**: lo gratis es su panel, no el envío. Para ActivaUC, que
ya tiene su propio panel y su propia cola, un intermediario añade
dependencia sin quitar el costo. Si se va a cambiar, conviene ir directo
a Meta.

---

## 3. Correo · aquí sí hay gratis de verdad

El correo no necesita la aprobación de nadie, así que es donde el plan
gratuito alcanza.

| Proveedor | Plan gratuito | SMTP | API | Observaciones |
|---|---|---|---|---|
| **Brevo** | 300/día | Sí | Sí | **Verifica un remitente suelto**, sin dominio propio. Añade su pie en el plan gratuito, y la cuenta pasa por aprobación |
| **Resend** | 3.000/mes, tope 100/día | Sí | Sí | Sin pie. **Exige dominio propio**: su dominio de prueba sólo escribe a tu propia dirección |
| **SMTP2GO** | 1.000/mes | Sí | Sí | Sin tarjeta y sin caducidad |
| **Mailjet** | 6.000/mes | Sí | Sí | El cupo mensual fijo más alto |
| **MailerSend** | ~500/mes (las fuentes discrepan) | Sí | Sí | Pide tarjeta al registrarse |
| **SendGrid** | Ya no tiene plan gratuito perpetuo, sólo 60 días | Sí | Sí | Descartado para esto |

### Lo que cambia la decisión: si tienes dominio o no

**Sin dominio propio → Brevo.** Es el único de la lista que deja
verificar una dirección suelta. 300/día cubre de sobra el proyecto, y
sirve a la vez para los correos de Supabase (SMTP) y para las
notificaciones (API).

**Con dominio propio → Resend.** Más limpio, sin pie añadido, y al
autenticar el dominio con SPF, DKIM y DMARC la entrega a `@uc.cl` mejora
de verdad.

### Y la opción que nadie suele considerar

**El SMTP institucional de la UC.** Es gratis, y es la única que resuelve
bien el problema de fondo: un correo que sale de un servidor `@uc.cl`
hacia `@uc.cl` no se retiene ni se filtra. Hay que pedírselo a la
dirección de informática. Para los correos de autenticación —donde el
retraso es lo que te dejó sin cuenta— es mejor que cualquier proveedor
externo.

---

## 4. Recomendación

1. **Correo de autenticación** (lo que te bloqueó con `@uc.cl`): pedir el
   SMTP institucional. Mientras llegue, **Brevo** si no tienes dominio, o
   **Resend** si lo tienes. Resuelve además el límite de ~2 correos por
   hora del servicio incorporado de Supabase, que es lo que impediría que
   tus compañeros se registren.
2. **Notificaciones por correo**: el mismo proveedor del punto 1, por su
   API. Sustituye a `_shared/twilioEmail.ts`, que es un archivo.
3. **WhatsApp**: seguir en Twilio Trial mientras baste con probar la
   cadena, y si se quiere en serio, ir **directo a Meta Cloud API**. Es
   más barato que Twilio y quita la restricción de las plantillas de
   muestra, pero hay que aceptar un costo por mensaje del orden de USD
   0,0034.

---

## Fuentes

Comparativas y tarifas consultadas el 16/10/2026. Son en su mayoría
blogs de terceros y varias cifras discrepan entre sí; están aquí para
situarse, no como referencia de precios:

- [WhatsApp API Pricing 2026 (Wati)](https://www.wati.io/en/blog/whatsapp-api-pricing-guide/)
- [WhatsApp Business API Pricing 2026 (Blueticks)](https://blueticks.co/blog/whatsapp-business-api-pricing-2026)
- [WhatsApp API Pricing: Free 24-Hour Window Ends in October (Pepper Cloud)](https://blog.peppercloud.com/whatsapp-api-pricing-everything-you-need-to-know/)
- [WhatsApp Cloud API Pricing: Meta Direct vs a Provider (Chatmitra)](https://chatmitra.com/blog/whatsapp-cloud-api-pricing/)
- [11 Best Free SMTP Servers Compared (Mailtrap)](https://mailtrap.io/blog/free-smtp-servers/)
- [Best Free Email APIs in 2026 (Sequenzy)](https://www.sequenzy.com/blog/best-free-email-apis)
- [Free Email API: which free tiers are useful (tinysend)](https://tinysend.co/blog/free-email-api)

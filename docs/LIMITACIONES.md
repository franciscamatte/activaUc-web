# Qué puede hacer hoy alguien a quien le pases el enlace

Estado al **17/10/2026**, con <https://activauc.netlify.app> publicado y
funcionando. La pregunta que responde este documento es concreta: si le
mandas el enlace a tus compañeros, ¿qué les funciona y qué no?

La respuesta corta, al **17/10/2026 por la tarde**: **todo lo esencial
funciona para cualquiera.** Crear cuenta, reservar, cancelar y recibir
los avisos por correo quedó resuelto esa tarde, con SMTP propio y el
canal de notificaciones migrado a Brevo. Lo que sigue limitado es
WhatsApp, y Google Calendar sólo si la pantalla de consentimiento está
en *Testing*.

Las secciones 2.1 a 2.2.1 describen problemas **ya resueltos**: se
conservan porque explican por qué el sistema está armado así, y porque
cualquiera que monte otro entorno se los encontrará de nuevo.

---

## 1. Lo que funciona para cualquiera, ahora

| Funcionalidad | Límite real |
|---|---|
| Ver recintos, bloques y cupos | ninguno; no requiere cuenta |
| Disponibilidad en vivo | 200 conexiones simultáneas del plan gratuito de Supabase |
| Reservar y cancelar, con cuenta | 20 reservas y 30 cancelaciones por minuto **y por persona** |
| Una reserva activa por bloque | regla de negocio (REQ), no un tope técnico |
| Cancelar hasta 2 h antes | regla de negocio (REQ-15) |

Los límites por minuto son nuestros, están en `consume_rate_limit`, y
existen para frenar un script, no a una persona: nadie reserva veinte
veces en un minuto.

---

## 2. Los tres topes que sí estorban

### 2.1 Correo de autenticación · **es el que bloquea todo**

El servicio de correo incorporado de Supabase está limitado a **2 correos
por hora**, contados **por proyecto** y compartidos entre registro,
recuperación de contraseña e invitaciones. Ese es el tope, y es oficial.

**Comprobado el 17/10/2026, y en los dos sentidos:**

- Una cuenta con un correo **ajeno a la organización de Supabase**
  (`@alumnos.colegiosma.cl`) recibió su código de confirmación sin
  problema. Varias guías de terceros afirman que el servicio incorporado
  sólo entrega a miembros de la organización; **en este proyecto no es
  así**. Una versión anterior de este documento lo daba por probable, y
  era falso.
- Encadenando solicitudes de restablecimiento de contraseña, la segunda
  ya fue rechazada: la aplicación mostró «Hiciste demasiadas solicitudes
  seguidas», que es la traducción del `429` de Supabase.

> Es decir: tus compañeros **sí** pueden registrarse, pero **de dos en
> dos por hora**, contando todo el proyecto junto. Con un curso de
> treinta personas eso es media jornada de espera, y cualquiera que pida
> recuperar su contraseña consume el cupo de otro.

Lo bueno de que el tope se note así: el `429` llega traducido a una frase
que se entiende, no a un fallo silencioso. Eso está en
`src/lib/errors.ts` y lo cubre `errors.test.ts`.

**Cómo se levanta:** SMTP propio. El cupo pasa a 30 correos por hora
—ajustable en Authentication → Rate Limits— y la entrega deja de
depender de la organización. Ver
[CONFIGURACION_CORREO.md](CONFIGURACION_CORREO.md) § 3 y
[ALTERNATIVAS_PROVEEDORES.md](ALTERNATIVAS_PROVEEDORES.md) § 3.

### 2.2 WhatsApp · ventana de 24 horas por persona

En el Sandbox de Twilio, cada número que vaya a recibir mensajes tiene
que enviar el `join <dos-palabras>` al número del Sandbox, y **la ventana
dura 24 horas** desde su último mensaje. Pasado eso, un mensaje iniciado
por la plataforma necesita una plantilla aprobada por Meta, y la de
muestra que usamos no lo es.

Medido en este proyecto:

| Cuándo | `join` | Resultado |
|---|---|---|
| 16/10 09:09 | 16/10 03:09, 6 h antes | **entregado** |
| 17/10 14:26 | 16/10 03:09, 35 h antes | **fallido · 63016** |

El `63016` de Twilio es exactamente eso: mensaje iniciado por la empresa
fuera de la ventana de 24 h. El trabajo de la cola aparece `completado`
—Twilio aceptó la petición— y el fallo lo registra el webhook de
estados en `whatsapp_messages`. Es decir, la trazabilidad funcionó: sin
el webhook, esto se habría visto como un envío correcto.

**Cómo se levanta:** salir de Trial, dar de alta un WhatsApp Sender y
crear las tres plantillas de
[CONFIGURACION_TWILIO_WHATSAPP.md](CONFIGURACION_TWILIO_WHATSAPP.md) § 4,
que Meta tiene que aprobar. Mientras no, WhatsApp sólo sirve para probar,
y sólo con quien haya hecho el `join` en las últimas 24 h.

### 2.2.1 El correo de notificaciones de Twilio sólo llega a destinatarios verificados

Descubierto el 17/10/2026 al reservar con una cuenta nueva: el aviso no
llegó, y el webhook registró

```
574002 · The recipient email address is not verified for this trial
```

En el plan de prueba, la API de correo de Twilio **sólo entrega a
direcciones que estén verificadas en la cuenta**. Es el mismo patrón que
el `join` del Sandbox de WhatsApp: sirve para probar con uno mismo y no
sirve para terceros.

Sumado a que el contenido está limitado a plantillas de muestra (§ 2.2),
el canal de correo vía Twilio **no es utilizable con el curso**. La
alternativa es Brevo, que ya está configurado para los correos de
autenticación: su API transaccional admite contenido propio y no exige
verificar a cada destinatario. Ver
[ALTERNATIVAS_PROVEEDORES.md](ALTERNATIVAS_PROVEEDORES.md) § 3.

---

### 2.3 Google Calendar · 100 personas y caducidad a los 7 días

Depende de en qué estado esté la pantalla de consentimiento (Google Auth
Platform → **Audience**):

| Estado | Quién puede conectar | Caducidad |
|---|---|---|
| **Testing** | sólo los correos añadidos como *test users*, hasta 100 | la autorización **caduca a los 7 días** |
| **In production**, sin verificar | hasta 100 en total, con la pantalla de «Google no ha verificado esta app» | sin caducidad forzada |
| Verificada por Google | sin tope | sin caducidad |

`calendar.events` es un permiso sensible, así que publicarla **no** quita
el tope de 100: hace falta la verificación, que pide política de
privacidad y un vídeo de demostración.

Para un curso, 100 personas sobra. Lo que molesta es la caducidad de 7
días del estado *Testing*: cada compañero tendría que reconectar su
calendario cada semana. Si vas a dejarlo en manos de otros, conviene
pasar a *In production* aunque salga el aviso de app no verificada.

---

### 2.4 El proyecto de Supabase se pausa solo

En el plan gratuito, **un proyecto se pausa tras una semana sin
actividad**. Reanudarlo es un botón en el panel, pero mientras está
pausado la página responde pero no funciona: nada de iniciar sesión,
reservar ni consultar disponibilidad.

Para una entrega evaluada esto importa más de lo que parece: si dejas de
tocar el proyecto y el curso lo revisa dos semanas después, se lo
encuentran caído y parecerá que no funciona.

Mitigaciones, de menos a más:

- **Entrar al panel o usar la página** cada pocos días durante el
  periodo de evaluación. El cron de un minuto genera actividad de base
  de datos, pero no está claro que cuente como actividad a estos
  efectos, así que no conviene confiarse.
- **Avisar en la entrega** que el proyecto puede necesitar reanudarse, y
  cómo.
- **Plan Pro** si el proyecto tiene que estar disponible sin vigilancia.

No lo verifiqué en este proyecto —habría que dejarlo una semana sin
tocar— así que viene de la documentación de precios de Supabase.

---

### 2.5 Dos cosas caducan solas si el proyecto queda quieto

Se juntan, y ninguna avisa:

| Qué | Plazo | Efecto |
|---|---|---|
| Proyecto de Supabase (plan gratuito) | 1 semana sin actividad | se pausa: la página responde pero no funciona |
| API key de Brevo | 90 días sin uso | deja de enviar; los avisos fallan en silencio |

La de Brevo además tiene vencimiento propio —un año si se deja el valor
por omisión— así que conviene anotar la fecha donde se vaya a mirar.

Para una entrega evaluada, lo barato es usar la página de vez en cuando
durante el periodo de revisión. Para algo que deba funcionar sin
vigilancia, hay que asumir plan de pago en Supabase y renovar la clave.

El permiso de esa clave, por cierto, es **sólo «Emails transaccionales ·
Todos»**. Es el único recurso que el código usa, así que si se filtrara
lo peor posible es que alguien envíe correos desde el remitente
verificado: no puede leer contactos, ni ver la cuenta, ni gastar saldo
de SMS o WhatsApp.

---

## 3. Topes de plataforma que no te van a afectar

Supabase y Netlify tienen cupos en sus planes gratuitos —tamaño de base
de datos, tráfico, invocaciones de funciones, minutos de compilación—
holgados de sobra para un trabajo de curso. **No los verifiqué en esta
sesión**, así que si vas a planificar sobre ellos, míralos en los paneles
respectivos y no aquí.

Otros topes nuestros, por si aparecen:

| Límite | Valor | Dónde |
|---|---|---|
| Bloques por operación de serie | 1000 | `admin_create_block_series` |
| Intentos por trabajo de calendario | 5 | `calendar_sync_jobs.max_attempts` |
| Intentos por notificación | 4 | `notification_jobs.max_attempts` |
| Inicios de OAuth por minuto y persona | 5 | `google-oauth-start` |
| Frecuencia del cron | 1 minuto | `supabase/cron/schedule.sql` |

El cron de un minuto ya no determina la latencia: lo recién encolado lo
despacha un disparador en 2–3 s, y el cron queda para reintentos,
recordatorios futuros y rescate. Ver [OPERACION.md](OPERACION.md).

---

## 4. Dónde está esto hoy

**Hecho el 17/10/2026, y verificado contra el proyecto real:**

| | Estado |
|---|---|
| SMTP propio (Brevo) | listo · cupo de 30/hora en lugar de 2 |
| Plantillas de correo con código, sin enlace | listas |
| Registro con un correo cualquiera | comprobado con tres dominios distintos |
| Avisos de reserva por correo | comprobados, por Brevo, en 2 s |

Con eso, cualquiera a quien le pases el enlace puede registrarse,
reservar, cancelar, recibir su confirmación por correo y ver la
disponibilidad en vivo.

**Lo que queda, y ninguno bloquea lo anterior:**

1. **Pasar la pantalla de Google a *In production***, si quieres que tus
   compañeros conecten su calendario sin que la autorización les caduque
   cada semana. Gratis, y sigue con el tope de 100 personas.
2. **WhatsApp**: hoy sólo funciona con quien haya hecho el `join` en las
   últimas 24 h. Para que sirva de verdad hay que salir de Trial de
   Twilio y que Meta apruebe las tres plantillas. Es lo único que cuesta
   dinero, y el correo ya cubre la misma necesidad.
3. **Vigilar las caducidades** de § 2.5 durante el periodo de
   evaluación.

---

## Fuentes

- [Supabase · Rate limits](https://supabase.com/docs/guides/auth/rate-limits) — el límite de 2 correos/hora es oficial; el valor de 30 con SMTP propio lo reportan guías de terceros, confírmalo en el panel
- [Google · Manage App Audience](https://support.google.com/cloud/answer/15549945?hl=en) y [Unverified apps](https://support.google.com/cloud/answer/7454865?hl=en) — el tope de 100 y la caducidad de 7 días
- [Twilio · error 63016](https://www.twilio.com/docs/api/errors/63016) — mensaje iniciado por la empresa fuera de la ventana de 24 h

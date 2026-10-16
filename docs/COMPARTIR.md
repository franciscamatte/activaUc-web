# Compartir ActivaUC con otras personas

`localhost:5173` sólo existe en tu computador. Para que tus compañeros
entren hay tres caminos, de menos a más definitivo.

---

## Antes de elegir: la base de datos ya es compartida

El backend —Supabase— **ya está en internet**. Las cuentas, los
recintos, los bloques y las reservas que creen tus compañeros van a la
misma base que ves tú. Lo único que falta publicar es el frontend, que
hoy corre en tu máquina.

Eso significa que, en cualquiera de las tres opciones, **las reservas
que ellos hagan son reales**: ocupan cupo, generan evento de Calendar y
mensaje de WhatsApp. Si vas a probar con mucha gente, conviene crear
recintos de prueba en vez de usar los definitivos.

---

## Opción 1 · Para un rato, desde tu computador

Vite puede exponer el servidor a tu red local. Ya está configurado con
`--host 0.0.0.0`, así que cuando arrancas con `iniciar.cmd` la salida
incluye algo como:

```
➜  Network: http://172.27.109.150:5173/
```

Quien esté **en la misma red WiFi** puede abrir esa dirección.

Pero esa IP es la de WSL, no la de tu computador en la red, así que
normalmente **no funciona desde otro equipo** sin reenviar el puerto. En
PowerShell **como administrador**:

```powershell
netsh interface portproxy add v4tov4 listenport=5173 listenaddress=0.0.0.0 connectport=5173 connectaddress=(wsl hostname -I).Trim()
```

Y luego comparte `http://<la IP de tu PC>:5173`, que obtienes con
`ipconfig`.

Sirve para mostrarlo en una reunión. **No sirve para una entrega**:
depende de que tu computador esté encendido, en la misma red, y la IP
cambia. Para deshacerlo:

```powershell
netsh interface portproxy delete v4tov4 listenport=5173 listenaddress=0.0.0.0
```

---

## Opción 2 · Un enlace público, en cinco minutos (recomendada)

Publicar el frontend en un alojamiento estático gratuito. Es lo
adecuado para que tus compañeros y el equipo docente lo usen sin que tú
tengas nada encendido.

### 2.1 Compilar

```powershell
wsl -d Ubuntu-24.04 -- bash -lc "cd /mnt/c/Users/nicol/Downloads/activaUc-web && source scripts/lib/node-env.sh && npm run build"
```

Queda todo en `dist/`: son archivos estáticos, sin servidor.

### 2.2 Subirlo

Lo más simple, sin instalar nada: <https://app.netlify.com/drop> —
arrastras la carpeta `dist` y te da una URL del tipo
`https://algo-random.netlify.app`.

Con cuenta (gratis) puedes elegir el nombre y volver a desplegar con un
comando:

```bash
npx netlify-cli deploy --prod --dir=dist
```

Alternativas equivalentes: **Vercel** (`npx vercel --prod`),
**Cloudflare Pages**, **GitHub Pages**. Cualquiera sirve: son archivos
estáticos.

### 2.3 Los cuatro ajustes que hay que hacer (importante)

Sin esto la página carga pero el inicio de sesión y Google Calendar
fallan. Sustituye `https://TU-URL` por la que te dieron.

**a) Supabase → Authentication → URL Configuration**

- *Site URL*: `https://TU-URL`
- *Redirect URLs*: añade `https://TU-URL/auth/callback`,
  `https://TU-URL/restablecer-contrasena`, `https://TU-URL/verificar`

**b) Google Cloud → Credenciales → tu cliente OAuth**

En *URIs de redireccionamiento autorizados* ya está el de Supabase. En
*Orígenes autorizados de JavaScript* añade `https://TU-URL`.

**c) Secretos del backend** — en `.env.secrets`:

```bash
APP_URL=https://TU-URL
APP_ALLOWED_ORIGINS=https://TU-URL
```

y recargarlos:

```bash
bash scripts/set-secrets.sh
bash scripts/deploy-functions.sh
```

`APP_ALLOWED_ORIGINS` es la lista blanca de CORS: si no está tu dominio,
las Edge Functions rechazan al navegador.

**d) Comprobar** que `.env` tenga la URL y la clave `anon` del proyecto
real antes de compilar, porque esos valores quedan **dentro** del
archivo compilado.

> Si cambias de URL más adelante, hay que repetir los cuatro pasos. Por
> eso conviene fijar un nombre propio en Netlify o Vercel desde el
> principio.

### 2.4 Cuidado con lo que queda público

Cualquiera con el enlace puede **crear una cuenta**. Eso es lo
pretendido (REQ-1), pero mientras sea un trabajo de curso conviene
saberlo. Lo que **no** queda expuesto:

- la clave `service_role` (nunca va al navegador; ver
  [SEGURIDAD.md](SEGURIDAD.md)),
- los tokens de Google (cifrados, y las columnas no son legibles por el
  cliente),
- los datos de otras personas (lo impide RLS, verificado en
  `supabase/tests/40_rls.sql`).

---

## Opción 3 · Compartir el código, no la página

Si lo que quieren es **ejecutarlo ellos**:

```bash
git clone https://github.com/franciscamatte/activaUc-web.git
cd activaUc-web
npm install
npm run dev
```

Sin `.env` arranca en **modo simulado**: datos de ejemplo en el
navegador, sin tocar la base real. Es la mejor manera de que revisen la
interfaz sin riesgo, y en ese modo el código de verificación es siempre
`000000`.

Para que trabajen contra la base real necesitan `.env` con la URL y la
clave `anon` —se las puedes pasar, son públicas— y estar en la lista de
*Redirect URLs* si usan otro puerto.

El detalle de cada paso está en
[ARRANQUE_LOCAL.md](ARRANQUE_LOCAL.md) § 4.

---

## Qué elegir

| Situación | Opción |
|---|---|
| Mostrarlo en una reunión, hoy | 1 |
| Entregar el trabajo, que lo usen y lo evalúen | **2** |
| Que otro desarrollador lo revise o siga el código | 3 |
| Despliegue definitivo en infraestructura de la UC | [DESPLIEGUE_AWS.md](DESPLIEGUE_AWS.md) |

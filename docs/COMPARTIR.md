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

### 2.2.1 Mejor: conectar el repositorio

Arrastrar `dist/` obliga a recompilar y volver a arrastrar con cada
cambio. Conectando el repositorio, cada `git push` a la rama elegida
redespliega solo, y `netlify.toml` ya trae el comando, la carpeta
publicada, la versión de Node y las cabeceras.

En Netlify: **Add new site → Import an existing project → GitHub**, y
elegir el repositorio. Tres cosas que hay que mirar:

**a) La rama.** Por omisión Netlify despliega la rama principal. El
trabajo vive en **`Avance`**, así que hay que cambiarla en
*Branch to deploy*, o no se publicará nada de esto.

**b) Las variables de entorno. Esto es lo que más se olvida.** `.env`
está en `.gitignore`, de modo que la compilación en Netlify no tiene la
URL ni la clave. En **Site configuration → Environment variables**:

```
VITE_SUPABASE_URL        https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY   la clave anon (pública)
VITE_DATA_MODE           supabase
```

`VITE_APP_URL` se deja **sin definir**, para que la aplicación use el
origen desde el que se la sirve. Así el mismo build sirve para el
dominio de producción y para las vistas previas de cada rama.

Sin esas variables la compilación **no falla**, pero el sitio muestra un
aviso de configuración. No muestra datos de ejemplo: `src/lib/env.ts`
rechaza el modo mock en una compilación de producción a propósito, para
que una demostración no pueda pasar por un sistema real.

**c) Los permisos del repositorio.** `activaUc-web` está bajo la cuenta
de `franciscamatte`, no bajo la tuya. Netlify necesita instalar su
aplicación de GitHub en ese repositorio, y eso suele requerir permisos
de administración sobre él.

Tres salidas, de menos a más trabajo continuo:

1. **Que la dueña lo autorice.** El repositorio es público, así que para
   ella es aceptar la instalación de la aplicación de Netlify: un clic.
   Es la opción que no deja deuda.
2. **Un *fork*.** Funciona, pero mueve el origen de los despliegues a tu
   copia. Ver § 2.2.2.
3. **Seguir arrastrando `dist/`.** No depende de nadie y no se
   desincroniza de nada.

### 2.2.2 Si despliegas desde un *fork*

El fork copia las ramas que existen en ese momento, `Avance` incluida,
y Netlify lo conecta sin tocar el repositorio original.

El costo está en que **a partir de ahí hay dos repositorios**, y el que
Netlify observa es el tuyo. Si sigues empujando sólo al del equipo, el
sitio publicado se queda atrás sin avisar: no falla, simplemente muestra
una versión vieja. Es el tipo de desincronización que se descubre tarde.

La forma de no tener que acordarse es un remoto que empuje a los dos a
la vez:

```bash
git remote add ambos https://github.com/franciscamatte/activaUc-web.git
git remote set-url --add --push ambos https://github.com/franciscamatte/activaUc-web.git
git remote set-url --add --push ambos https://github.com/<tu-usuario>/activaUc-web.git
```

Desde entonces:

```bash
git push ambos Avance
```

va a los dos, y si uno falla el comando falla: no hay forma de que uno
quede atrás en silencio. `origin` se deja apuntando al repositorio del
equipo, que es donde vive la entrega.

Para comprobar que quedó bien:

```bash
git remote -v
```

`ambos` debe aparecer con **dos** líneas `(push)`.

> Las vistas previas por rama son útiles, pero cada una tiene su propia
> URL, y esas URLs **no** están en las *Redirect URLs* de Supabase ni en
> los orígenes de Google. En una vista previa funcionará el catálogo
> público y fallará el inicio de sesión. Es esperable; lo definitivo es
> el dominio de producción.

### 2.2.2 Los créditos de Netlify se gastan en despliegues, no en visitas

Medido en esta cuenta el 17/10/2026, con el plan gratuito de 300
créditos al mes:

| Concepto | Consumo |
|---|---|
| 14 despliegues de producción | **210 créditos** |
| 599 peticiones web | 0,1 |
| Ancho de banda | 0,2 |

O sea **15 créditos por despliegue**, y el tráfico es ruido. Veinte
despliegues agotan el mes; mil visitas no se notan. Eso cambia por
completo dónde hay que tener cuidado: no en cuánta gente use la página,
sino en cuántas veces se publique.

Y conectado al repositorio, **cada `git push` dispara uno**, incluso si
el commit sólo toca documentación.

**La regla `ignore` de `netlify.toml`** lo resuelve. Llama a
[`scripts/netlify-ignore.sh`](../scripts/netlify-ignore.sh), que cancela
el build cuando el commit no toca nada que acabe en lo publicado: `src/`,
`public/`, `index.html`, la configuración de Vite o TypeScript,
`package.json`, `package-lock.json` y el propio `netlify.toml`. Lo demás
—`docs/`, `supabase/`, `scripts/`— no cambia el sitio y no merece un
despliegue.

> Ojo con la semántica, que está invertida: el comando `ignore` **cancela**
> el build al salir con **0** y lo ejecuta al salir con **1**.

Aplicado a los commits de hoy: **6 compilaciones en lugar de 16, 90
créditos en lugar de 240.** Las diez canceladas eran de documentación.

Si falta la referencia del commit anterior —primer despliegue— compila,
que es la dirección segura: equivocarse hacia «no compilar» deja el
sitio viejo publicado sin que nadie se entere.

Dos hábitos que ayudan además:

- **Agrupar los commits** y empujar una vez, en lugar de empujar cada
  uno.
- Para una prueba suelta, `npm run build` en local y mirar `dist/` con
  `npm run preview`, en vez de desplegar para ver.

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
archivo compilado. Si alguna vez ves «No hay conexión con el servidor»
al iniciar sesión, es casi siempre esto: un `.env` con los valores de
ejemplo (`https://TU-PROYECTO.supabase.co`), que es lo que deja
`cp .env.example .env` si se ejecuta sobre uno que ya funcionaba.

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

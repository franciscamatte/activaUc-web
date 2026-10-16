# Arrancar ActivaUC en tu computador

Desde cero, en este equipo (Windows 11 con WSL). Si alguien clona el
repositorio en otro computador, la sección 4 explica lo que cambia.

---

## 1. La vía corta

Abre el **Explorador de archivos**, entra en la carpeta del proyecto y
haz **doble clic en `iniciar.cmd`**.

Se abre una ventana negra, tarda unos segundos y queda así:

```
  VITE v8.x  ready in 843 ms
  ➜  Local:   http://localhost:5173/
```

Abre <http://localhost:5173> en el navegador. Listo.

**Para detenerlo:** `Ctrl+C` en esa ventana, o ciérrala.

Mientras esté abierta, cada cambio que guardes en el código se refleja
en el navegador solo, sin reiniciar nada.

---

## 2. La misma cosa desde la terminal

Si prefieres la terminal, **PowerShell** (el que viene con Windows; no
hace falta Windows Terminal ni WSL abierto aparte):

```powershell
cd C:\Users\nicol\Downloads\activaUc-web
.\iniciar.cmd
```

El `.\` delante es obligatorio en PowerShell: sin él no busca en la
carpeta actual.

### Si prefieres entrar a WSL tú

```bash
wsl -d Ubuntu-24.04
cd /mnt/c/Users/nicol/Downloads/activaUc-web
bash scripts/dev-wsl.sh
```

Es exactamente lo que hace `iniciar.cmd`. Útil cuando quieres correr
otras cosas en la misma sesión (pruebas, migraciones).

---

## 3. Por qué hace falta WSL

En este equipo **Node.js no está instalado en Windows, sólo dentro de
WSL**. Vite, npm y las pruebas corren en Linux; Windows sólo abre el
navegador. `iniciar.cmd` es el puente: traduce la ruta de Windows a la
que ve WSL y lanza el servidor allí, publicándolo en `localhost:5173`
para que el navegador de Windows lo alcance.

Si algún día instalas Node en Windows (<https://nodejs.org>, versión 22
o superior), ya no necesitas nada de esto:

```powershell
npm install
npm run dev
```

---

## 4. Desde cero en otro computador

```bash
git clone https://github.com/franciscamatte/activaUc-web.git
cd activaUc-web
npm install
cp .env.example .env     # y completar las dos variables de abajo
npm run dev
```

`.env` necesita dos valores, que están en el panel de Supabase →
**Project Settings → API**:

```bash
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<la clave anon, la pública>
```

> La `anon key` es pública por diseño: va en el navegador y lo que puede
> hacer lo limita RLS. La `service_role` **nunca** va en un `VITE_*`;
> ver [SEGURIDAD.md](SEGURIDAD.md).

Sin `.env`, la aplicación arranca igual en **modo simulado**: datos de
ejemplo en el navegador, sin backend. Sirve para ver la interfaz, y en
ese modo el código de verificación es siempre `000000`.

---

## 5. Otros comandos útiles

```bash
npm run dev          # servidor de desarrollo
npm run verify       # lint + typecheck + pruebas + build, todo junto
npm run test         # sólo las pruebas
npm run build        # compilar para producción (queda en dist/)
npm run preview      # ver el resultado de build/ como lo verá el público
```

Desde Windows, cualquiera de ellos:

```powershell
wsl -d Ubuntu-24.04 -- bash -lc "cd /mnt/c/Users/nicol/Downloads/activaUc-web && source scripts/lib/node-env.sh && npm run verify"
```

---

## 6. Si algo falla

| Síntoma | Causa y arreglo |
|---|---|
| `Command not found: npm` | Estás en PowerShell en vez de WSL. Usa `iniciar.cmd`. |
| `$'\r': command not found` | Un script quedó con fin de línea de Windows. `git config core.autocrlf false` y volver a clonar; `.gitattributes` lo evita. |
| `Port 5173 is already in use` | Ya hay un servidor corriendo. Ciérralo, o `wsl -d Ubuntu-24.04 -- pkill -f vite`. |
| La página carga pero sin datos | Falta `.env`, o está mal el `VITE_SUPABASE_URL`. La página avisa si arrancó en modo simulado. |
| `WSL no está instalado` | En PowerShell como administrador: `wsl --install -d Ubuntu-24.04`, reiniciar, y después `npm install` dentro de WSL. |

---

## 7. Para que lo vean otras personas

Lo de arriba sólo funciona en tu computador: `localhost` es tu propia
máquina y nadie más la alcanza. Para compartirlo, ver
[COMPARTIR.md](COMPARTIR.md).

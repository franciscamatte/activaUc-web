# Despliegue del frontend en AWS (S3 + CloudFront)

ActivaUC es una SPA: se compila a archivos estáticos que se sirven desde S3 a
través de CloudFront, con HTTPS obligatorio.

---

## Arquitectura

```
Navegador
    │ HTTPS
    ▼
CloudFront ──── OAC ────► Bucket S3 (privado)
    │                      dist/
    │ 403/404 → /index.html (200)   ← SPA fallback
    │
    └── HTTPS ──────────► Supabase (API, Auth, Realtime, Edge Functions)
```

El bucket queda **privado**: sólo CloudFront lo lee, mediante Origin Access
Control. No se usa el hosting estático de S3, que obligaría a exponerlo.

---

## 1. Requisitos

```bash
aws --version          # AWS CLI v2
aws sts get-caller-identity
node --version         # 20.19 o superior
```

Permisos necesarios: `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` y
`cloudfront:CreateInvalidation`.

---

## 2. Bucket S3

```bash
export AWS_REGION=sa-east-1
export AWS_S3_BUCKET=activauc-web-prod

aws s3api create-bucket \
  --bucket "$AWS_S3_BUCKET" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"

# El bucket no debe ser público: lo lee CloudFront, no internet.
aws s3api put-public-access-block \
  --bucket "$AWS_S3_BUCKET" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Cifrado en reposo
aws s3api put-bucket-encryption \
  --bucket "$AWS_S3_BUCKET" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Versionado: permite volver atrás si un despliegue sale mal
aws s3api put-bucket-versioning \
  --bucket "$AWS_S3_BUCKET" \
  --versioning-configuration Status=Enabled
```

---

## 3. Certificado TLS

CloudFront exige el certificado en **us-east-1**, independientemente de la
región del bucket.

```bash
aws acm request-certificate \
  --region us-east-1 \
  --domain-name activauc.ejemplo.cl \
  --validation-method DNS \
  --query CertificateArn --output text
```

Agrega el registro CNAME de validación en el DNS y espera:

```bash
aws acm wait certificate-validated --region us-east-1 --certificate-arn <arn>
```

---

## 4. Distribución de CloudFront

### 4.1 Origin Access Control

```bash
aws cloudfront create-origin-access-control \
  --origin-access-control-config \
    "Name=activauc-oac,Description=ActivaUC OAC,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
  --query 'OriginAccessControl.Id' --output text
```

### 4.2 Crear la distribución

Desde la consola de CloudFront (**Create distribution**):

| Sección | Campo | Valor |
|---|---|---|
| Origin | Origin domain | `activauc-web-prod.s3.sa-east-1.amazonaws.com` |
| Origin | Origin access | **Origin access control settings**, el OAC creado |
| Default behavior | Viewer protocol policy | **Redirect HTTP to HTTPS** |
| Default behavior | Allowed methods | `GET, HEAD, OPTIONS` |
| Default behavior | Cache policy | `CachingOptimized` |
| Default behavior | Compress objects | Sí |
| Settings | Price class | El que cubra la región de las personas usuarias |
| Settings | Alternate domain name | `activauc.ejemplo.cl` |
| Settings | Custom SSL certificate | El certificado de ACM |
| Settings | Security policy | `TLSv1.2_2021` o superior |
| Settings | Default root object | `index.html` |

### 4.3 SPA fallback (imprescindible)

Sin esto, recargar `/mis-reservas` devuelve un error: ese archivo no existe en
S3, porque el enrutado lo hace React Router en el navegador.

En **Error pages → Create custom error response**, dos entradas:

| HTTP error code | Customize error response | Response page path | HTTP Response code |
|---|---|---|---|
| 403 Forbidden | Yes | `/index.html` | **200** |
| 404 Not Found | Yes | `/index.html` | **200** |

S3 con OAC devuelve `403` (no `404`) para una clave inexistente, así que ambas
reglas son necesarias.

### 4.4 Política del bucket

Al crear la distribución, CloudFront ofrece copiar la política. Debe quedar así:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipal",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::activauc-web-prod/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::<cuenta>:distribution/<id-distribucion>"
      }
    }
  }]
}
```

### 4.5 Cabeceras de seguridad

En **Policies → Response headers → Create response headers policy**, y luego
asígnala al comportamiento por omisión:

| Cabecera | Valor | Para qué |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Fuerza HTTPS en visitas posteriores |
| `X-Content-Type-Options` | `nosniff` | Evita que el navegador adivine tipos |
| `X-Frame-Options` | `DENY` | Impide incrustar el sitio en un iframe |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | No filtra rutas a terceros |
| `Content-Security-Policy` | ver abajo | Limita de dónde se carga y a dónde se conecta |

CSP recomendada (sustituye `<ref>` por la referencia del proyecto de Supabase):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co;
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

`style-src` necesita `'unsafe-inline'` porque Tailwind y los estilos en línea de
React los requieren. `connect-src` debe incluir el esquema `wss:` o Realtime no
podrá abrir el WebSocket.

---

## 5. DNS

```bash
aws cloudfront get-distribution --id <id> \
  --query 'Distribution.DomainName' --output text
# → dxxxxxxxxxxxxx.cloudfront.net
```

Crea un registro **CNAME** (o un alias A de Route 53) de
`activauc.ejemplo.cl` hacia ese dominio.

---

## 6. Desplegar

### 6.1 Configuración

```bash
cat > .env.deploy <<'EOF'
AWS_S3_BUCKET=activauc-web-prod
AWS_CLOUDFRONT_ID=EXXXXXXXXXXXXX

VITE_DATA_MODE=supabase
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<clave anon>
VITE_APP_URL=https://activauc.ejemplo.cl
VITE_TIME_ZONE=America/Santiago
EOF
```

`.env.deploy` está en `.gitignore`. En un pipeline, estos valores vienen del
gestor de secretos del propio pipeline.

### 6.2 Ejecutar

```bash
bash scripts/deploy-frontend.sh --dry-run    # simula, no sube nada
bash scripts/deploy-frontend.sh              # despliega
bash scripts/deploy-frontend.sh --esperar    # y espera la invalidación
```

El script:

1. Rechaza `VITE_DATA_MODE=mock`, que sería una demo disfrazada de producción.
2. Rechaza una `service_role` key puesta donde va la `anon`, inspeccionando el
   claim `role` del JWT.
3. Ejecuta lint, typecheck y las pruebas antes de compilar.
4. Compila a `dist/`.
5. **Revisa el paquete generado** buscando referencias a secretos de backend
   (`service_role`, `GOOGLE_CLIENT_SECRET`, `TWILIO_AUTH_TOKEN`,
   `ENCRYPTION_KEY`, `CRON_SECRET`) y aborta si encuentra alguna.
6. Sube en dos pasadas, por las cabeceras de caché.
7. Invalida sólo `/index.html`.

### 6.3 Estrategia de caché

| Ruta | `Cache-Control` | Por qué |
|---|---|---|
| `/assets/*` | `public, max-age=31536000, immutable` | Los nombres llevan hash: un cambio produce un nombre nuevo |
| `/index.html` | `public, max-age=0, must-revalidate` | Debe reflejar el despliegue de inmediato |
| `/favicon.svg` | `public, max-age=86400` | Cambia muy poco |

Por eso la invalidación cubre sólo `/index.html` y `/`: invalidar `/*` costaría
más y no aporta nada, ya que los activos nunca reutilizan un nombre.

---

## 7. Verificación

```bash
SITIO=https://activauc.ejemplo.cl

# 1. HTTPS y sin caché en el documento
curl -sI "$SITIO" | grep -Ei 'HTTP/|cache-control|strict-transport'

# 2. SPA fallback: una ruta interna debe devolver 200
curl -s -o /dev/null -w '%{http_code}\n' "$SITIO/mis-reservas"      # 200
curl -s -o /dev/null -w '%{http_code}\n' "$SITIO/datos-personales"  # 200

# 3. HTTP redirige a HTTPS
curl -s -o /dev/null -w '%{http_code}\n' "http://activauc.ejemplo.cl"  # 301

# 4. Los activos se sirven como inmutables
ACTIVO=$(curl -s "$SITIO" | grep -o '/assets/[^"]*\.js' | head -1)
curl -sI "$SITIO$ACTIVO" | grep -i cache-control   # immutable

# 5. El bucket no es accesible directamente
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://activauc-web-prod.s3.sa-east-1.amazonaws.com/index.html"   # 403

# 6. Cabeceras de seguridad
curl -sI "$SITIO" | grep -Ei 'x-frame-options|x-content-type|content-security'
```

Después, en el navegador:

- Abre el sitio: sin errores en la consola.
- Inicia sesión y reserva un bloque.
- Recarga en `/mis-reservas`: debe funcionar (SPA fallback).
- Abre el catálogo en dos pestañas, reserva en una: la otra debe actualizar los
  cupos sin recargar (Realtime).
- Revisa en la pestaña de red que no haya ninguna petición a Google ni a Twilio
  desde el navegador: esas integraciones viven en el backend.

---

## 8. Integración continua (GitHub Actions)

```yaml
name: Desplegar ActivaUC

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write        # para asumir el rol de AWS con OIDC

jobs:
  verificar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test

  pruebas-de-base-de-datos:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 5
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run test:db
        env:
          ACTIVAUC_TEST_DB_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres
      - run: npm run test:concurrency
        env:
          ACTIVAUC_TEST_DB_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres

  desplegar:
    needs: [verificar, pruebas-de-base-de-datos]
    runs-on: ubuntu-latest
    environment: produccion
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: sa-east-1

      - run: bash scripts/deploy-frontend.sh
        env:
          AWS_S3_BUCKET: ${{ secrets.AWS_S3_BUCKET }}
          AWS_CLOUDFRONT_ID: ${{ secrets.AWS_CLOUDFRONT_ID }}
          VITE_DATA_MODE: supabase
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
          VITE_APP_URL: ${{ secrets.VITE_APP_URL }}
          VITE_TIME_ZONE: America/Santiago
```

Las pruebas de base de datos corren contra un PostgreSQL de servicio: el
arranque de `supabase/tests/00_bootstrap_local.sql` crea el entorno equivalente
a Supabase (esquema `auth`, roles `anon`/`authenticated`/`service_role`), así
que no hace falta Docker con la pila completa.

Usa OIDC (`role-to-assume`) en lugar de claves de acceso de larga duración.

---

## 9. Rollback

### Opción A · volver a desplegar el commit anterior

La más limpia:

```bash
git checkout <commit-anterior>
bash scripts/deploy-frontend.sh --esperar
```

### Opción B · restaurar desde el versionado de S3

Si el repositorio no está disponible:

```bash
# Versiones anteriores de index.html
aws s3api list-object-versions \
  --bucket "$AWS_S3_BUCKET" --prefix index.html \
  --query 'Versions[*].[VersionId,LastModified]' --output table

aws s3api copy-object \
  --bucket "$AWS_S3_BUCKET" \
  --copy-source "$AWS_S3_BUCKET/index.html?versionId=<id-anterior>" \
  --key index.html \
  --cache-control "public, max-age=0, must-revalidate" \
  --content-type "text/html; charset=utf-8" \
  --metadata-directive REPLACE

aws cloudfront create-invalidation \
  --distribution-id "$AWS_CLOUDFRONT_ID" --paths "/index.html" "/"
```

Funciona porque los activos antiguos siguen en el bucket: `--delete` sólo borra
lo que no está en la compilación nueva, y el `index.html` restaurado apunta a
los nombres con hash de su propia versión.

> Si un despliegue borró activos que la versión anterior necesita, restaura
> también esos objetos desde el versionado, o simplemente usa la Opción A.

### Rollback del backend

El frontend y el backend se despliegan por separado, así que puedes revertir uno
sin tocar el otro. Ver `CONFIGURACION_SUPABASE.md` § 10.

---

## 10. Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| Recargar una ruta interna da error | Faltan las respuestas de error personalizadas | Configura 403 y 404 → `/index.html` con código 200 |
| Se sigue viendo la versión anterior | No se invalidó `/index.html`, o tiene caché larga | Invalida y revisa su `Cache-Control` |
| «La aplicación no está configurada» | Las variables `VITE_*` no estaban al compilar | Se incrustan en tiempo de compilación: defínelas y vuelve a compilar |
| Realtime no conecta | La CSP no permite `wss:` | Agrega `wss://<ref>.supabase.co` a `connect-src` |
| Errores de CORS al llamar Edge Functions | El origen no está en la lista blanca | Define `APP_ALLOWED_ORIGINS` en los secretos y vuelve a desplegar las funciones |
| 403 en todo el sitio | La política del bucket no autoriza al OAC | Revisa la política y el `AWS:SourceArn` |
| El enlace del correo lleva a un error | Las Redirect URLs de Supabase no incluyen el dominio | Agrégalas en Authentication → URL Configuration |

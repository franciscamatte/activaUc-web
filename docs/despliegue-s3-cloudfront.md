# Despliegue técnico a S3 + CloudFront

## 1) Build
```bash
yarn install
yarn build
```

## 2) Bucket S3
1. Crear bucket para hosting estático.
2. Subir contenido de `dist/`.
3. Configurar documento de índice `index.html`.
4. Configurar documento de error `index.html` (SPA fallback).

## 3) CloudFront
1. Crear distribución con origen en bucket S3.
2. Viewer protocol policy: `Redirect HTTP to HTTPS`.
3. Custom error responses:
   - 403 -> `/index.html` (200)
   - 404 -> `/index.html` (200)
4. Invalidar caché: `/*` después de cada despliegue.

## 4) Variables de entorno
Configurar en pipeline/build:
- `VITE_DATA_MODE`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

No incluir secretos de Twilio ni OAuth de Google en frontend.

## 5) Seguridad
- HTTPS obligatorio en CloudFront.
- Credenciales externas solo en funciones backend/Supabase Edge Functions.
- RLS activa en tablas de Supabase (ver migración SQL).

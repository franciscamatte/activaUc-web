# ActivaUC Web

SPA en React + TypeScript para reservas de espacios deportivos de Deportes UC, basada en el documento `2.1 Documento de requerimientos de software (1)`.

## Estado
Implementación funcional con:
- Autenticación (login, registro, recuperación).
- Catálogo con filtros por fecha/tipo/horario.
- Reserva en hasta 4 pasos con validaciones de capacidad y duplicados.
- Mis reservas (vigentes / históricas) y cancelación con regla de 2 horas.
- Datos personales con consentimiento WhatsApp y conexión opcional Google Calendar.
- Panel administrador protegido por rol y recintos asignados.
- Arquitectura mock local lista para reemplazo por Supabase.
- Migraciones SQL de Supabase con RLS y función transaccional anti-sobrecupo.

## Tecnologías
- React 19 + TypeScript + React Router
- TailwindCSS 4
- ESLint
- Vitest (tests unitarios)

## Configuración
Copiar variables de entorno:
```bash
cp .env.example .env
```

Variables:
- `VITE_DATA_MODE=mock` (por defecto) usa adaptador local.
- `VITE_DATA_MODE=supabase` deja listo el contrato para backend Supabase.

## Ejecutar
```bash
yarn install
yarn dev
```

## Validaciones
```bash
yarn lint
yarn build
yarn test
```

## Supabase
Migración principal: `supabase/migrations/20261015133000_activauc_schema.sql`

Incluye:
- tablas de dominio
- índices
- restricciones
- políticas RLS
- función `create_reservation_strict` con control transaccional de concurrencia

## Documentación adicional
- `docs/guia-uso.md`
- `docs/despliegue-s3-cloudfront.md`
- `docs/pruebas-concurrencia.md`

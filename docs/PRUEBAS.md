# Pruebas

ActivaUC tiene tres suites, cada una verificando algo que las otras no pueden.

| Suite | Comando | Qué necesita | Qué cubre |
|---|---|---|---|
| Unitarias e integración | `npm run test` | Nada | Reglas de negocio, errores, reintentos, criptografía, Google Calendar y Twilio con `fetch` simulado, repositorio completo |
| Base de datos | `npm run test:db` | PostgreSQL | Esquema, privilegios, RLS con roles reales, funciones transaccionales, colas |
| Concurrencia | `npm run test:concurrency` | PostgreSQL | Sin sobrecupos ni duplicados con solicitudes simultáneas reales |

```bash
npm run verify   # lint + typecheck + test + build
```

---

## 1. Unitarias e integración (Vitest)

```bash
npm run test           # una vez
npm run test:watch     # en modo observador
```

**225 pruebas en 8 archivos.** Corren en entorno Node, sin DOM simulado: lo que
se verifica son reglas e integraciones, no renderizado.

| Archivo | Pruebas | Qué verifica |
|---|---|---|
| `src/domain/reservationRules.test.ts` | 34 | Selección de bloques, ventana de 2 h de cancelación (incluido el límite exacto), exención del administrador, regla del recordatorio, separación vigentes/pasadas, filtro por rango horario con zona horaria, validación de bloques |
| `src/domain/phone.test.ts` | 20 | Formato E.164, normalización, mensajes de ayuda en español, enmascarado |
| `src/lib/errors.test.ts` | 21 | Traducción de cada error de Supabase y PostgreSQL, clasificación (sesión expirada, sin conexión, permisos, límite), y que ningún mensaje contenga palabras en inglés |
| `src/lib/retry.test.ts` | 10 | Retroceso exponencial con fluctuación, tope máximo, qué errores se reintentan y cuáles no, cancelación por señal |
| `src/data/mockRepository.test.ts` | 47 | Recorrido completo: registro, sesión, perfil, consentimiento, filtros, reservar, duplicados, agotamiento, cancelaciones y administración |
| `src/test/oauthCrypto.test.ts` | 24 | Cifrado AES-256-GCM de tokens, detección de manipulación, firma del `state`, intento de suplantación de usuario, id determinístico de evento |
| `src/test/googleCalendar.test.ts` | 23 | Permisos mínimos, intercambio de código, renovación, idempotencia por `409`, tolerancia a `404`/`410`, clasificación de errores |
| `src/test/twilioWhatsapp.test.ts` | 35 | Envío con plantilla y con texto libre, validación de destino, códigos de error, **validación de la firma del webhook** (8 casos), plantillas en español |

### Lo que estas pruebas sí demuestran

- Que la **regla del recordatorio de 2 horas** se cumple en ambos lados del
  límite, no sólo en el caso feliz.
- Que un `state` de OAuth con el usuario alterado se rechaza: eso es el ataque
  concreto que la firma previene.
- Que una firma de webhook válida para **otra URL** se rechaza, lo que impide
  reenviar una solicitud legítima a otro endpoint.
- Que un reintento de creación de evento no duplica nada, porque el `409` de
  Google se trata como éxito.
- Que ningún mensaje de error visible queda en inglés.

### Lo que no demuestran

No hay pruebas contra las APIs reales de Google ni de Twilio: eso requiere
cuentas con credenciales productivas. El `fetch` simulado verifica el contrato
(qué se envía, cómo se interpreta cada respuesta), no que el servicio remoto se
comporte como se documenta. Los pasos de verificación con las cuentas reales
están en `CONFIGURACION_GOOGLE_CALENDAR.md` § 6 y
`CONFIGURACION_TWILIO_WHATSAPP.md` § 7.

Tampoco hay pruebas de renderizado de componentes. Se omitieron a propósito:
habrían exigido `@testing-library/react` y un DOM simulado para verificar menos
de lo que verifican las pruebas de concurrencia y RLS.

---

## 2. Base de datos

```bash
npm run test:db
```

### Requisito previo

Un PostgreSQL accesible. Cualquiera de estas opciones:

```bash
# A · Supabase local (requiere Docker)
npx supabase start
npm run test:db

# B · Cualquier PostgreSQL 15+
ACTIVAUC_TEST_DB_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres" \
  npm run test:db
```

Si no hay base disponible, el script lo dice con instrucciones en lugar de
fallar con un error de conexión en bruto.

### Cómo funciona

1. Crea una **base de datos desechable** con nombre único.
2. Aplica `supabase/tests/00_bootstrap_local.sql`, que recrea el entorno de
   Supabase: esquema `auth`, `auth.uid()`, y los roles `anon`,
   `authenticated` y `service_role` (este último con `BYPASSRLS`, igual que en
   Supabase).
3. Aplica las seis migraciones **en el mismo orden que la CLI**.
4. Ejecuta cada archivo de prueba en su propia transacción, que **revierte** al
   terminar: las pruebas no se contaminan entre sí.
5. Elimina la base.

Por eso esta suite también verifica que las migraciones se apliquen limpiamente
sobre una base vacía, que es lo que hará `supabase db push`.

### Qué cubre

| Archivo | Qué verifica |
|---|---|
| `10_schema.sql` | Las 13 tablas; RLS activa en todas; índice único de duplicados; disparadores de `updated_at`; que **toda** función `SECURITY DEFINER` fije `search_path`; restricciones de datos personales; **que ninguna función de `public` sea ejecutable por `anon`**; que las columnas de tokens no sean legibles; alta automática de perfil |
| `20_reservations.sql` | Capacidad, duplicados, agotamiento con fallo limpio; bloques pasados, inactivos y de recintos inactivos; **regla exacta del recordatorio de 2 h**; idempotencia de la cola de Calendar; límite de solicitudes por usuario |
| `30_cancellations.sql` | Ventana de 2 h; cancelación de reserva ajena (debe fallar); reserva iniciada y vencida; idempotencia de cancelar dos veces; administrador no asignado (debe fallar); administrador asignado sin ventana; aviso por WhatsApp; cupo liberado disponible al instante; encolado de eliminación de eventos en sus dos casos |
| `40_rls.sql` | Con los roles `anon` y `authenticated` **reales**: disponibilidad pública sin datos personales; aislamiento de perfiles y reservas; imposibilidad de escribir en `reservations`; imposibilidad de escalar el rol; tokens OAuth inaccesibles; administrador acotado a sus recintos; colas y webhooks reservados al backend; y una comprobación final de que ningún intento de escritura cruzada surtió efecto |
| `50_integrations.sql` | Reclamo de trabajos, retroceso exponencial, tope de intentos; sincronización exitosa; trazabilidad de WhatsApp; **idempotencia del webhook y no retroceso de «entregado»**; reintentos y fallos definitivos; revocación de consentimiento; recuperación de trabajos interrumpidos; informe de integraciones |
| `60_block_series.sql` | Creación de series (REQ-30): autorización sólo al administrador asignado; validaciones que rechazan antes de escribir; vista previa que cuenta sin escribir; serie diaria y por días de la semana **en hora local de Santiago**; repetir la serie no duplica; extender respeta lo publicado; bloques en el pasado omitidos sin fallar; desactivación en serie que conserva las reservas confirmadas |
| `70_despacho_inmediato.sql` | Los cuatro disparadores de despacho existen y son **por sentencia**; reservar y cancelar siguen funcionando con ellos puestos; y, lo que importa, **un fallo del despacho no impide reservar**: el trabajo queda encolado para que lo recoja el cron |

Las aserciones usan el `ASSERT` de PL/pgSQL: si una condición falla, la
sentencia lanza y el script reporta el archivo y el mensaje exactos.

### Salida esperada

```
✔ 10_schema.sql
    OK · las 13 tablas de dominio existen
    OK · RLS activa en todas las tablas de public
    OK · índices y disparadores presentes
    OK · todas las funciones SECURITY DEFINER fijan search_path
    OK · restricciones de datos personales presentes
    OK · ninguna función de public es ejecutable por anon
    OK · tokens y escrituras de reservas fuera del alcance del cliente
    OK · alta automática de perfil y validación de teléfono
✔ 20_reservations.sql
✔ 30_cancellations.sql
✔ 40_rls.sql
✔ 50_integrations.sql
✔ 60_block_series.sql
✔ 70_despacho_inmediato.sql

✔ 7 archivos de prueba superados
```

---

## 3. Concurrencia

```bash
npm run test:concurrency
```

Esto es lo que respalda la afirmación «no hay sobrecupos». Las pruebas SQL
corren en una sola sesión, así que **no pueden demostrar concurrencia**. Este
script abre N conexiones independientes y las libera a la vez.

### Cómo se simula una petición real

Cada solicitud usa su propia conexión **y su propia transacción**, con los
claims del JWT fijados con `set_config(..., is_local => true)`: exactamente lo
que hace PostREST en Supabase. Todas esperan en una barrera y se liberan
juntas, de modo que compiten de verdad por el bloqueo de fila del bloque.

### Escenarios

| # | Escenario | Qué prueba |
|---|---|---|
| 1 | Último cupo con 2 usuarios simultáneos (capacidad 1) | Exactamente 1 reserva; el otro recibe `sin_cupos` |
| 2 | **100 solicitudes concurrentes sobre capacidad 20** | 20 reservas, 80 rechazos, 0 duplicados, 0 errores inesperados, 20 registros de auditoría |
| 3 | El mismo usuario lanzando 10 solicitudes simultáneas | 1 reserva; 9 respuestas marcadas como duplicadas |
| 4 | Carrera de 10 aspirantes por el cupo liberado tras una cancelación | 1 gana; quedan 2 filas (1 cancelada + 1 vigente) |
| 5 | 30 solicitudes sobre un bloque ya agotado | 0 éxitos; las 30 con mensaje legible en español |
| 6 | Reintento de la misma solicitud (idempotencia) | Siempre la misma reserva; 1 trabajo de Calendar; 2 notificaciones |

### Resultado de la última ejecución

Contra PostgreSQL 16:

```
1) Último cupo con 2 usuarios simultáneos (capacidad 1)
  ✔ exactamente 1 reserva creada (obtenido: 1)
  ✔ el otro recibe "sin_cupos" (obtenido: 1)
  ✔ reservas vigentes = 1, capacidad = 1 (obtenido: 1)

2) 100 solicitudes concurrentes sobre capacidad 20
  100 solicitudes en 799 ms
  ✔ reservas vigentes = 20 (obtenido: 20)
  ✔ cero sobrecupos
  ✔ 20 solicitudes exitosas (obtenido: 20)
  ✔ 80 rechazos por "sin_cupos" (obtenido: 80)
  ✔ cero usuarios con reserva duplicada (obtenido: 0)
  ✔ cero errores inesperados (obtenido: 0)
  ✔ 20 registros de auditoría (obtenido: 20)

3) El mismo usuario lanzando 10 solicitudes simultáneas
  ✔ una sola reserva vigente (obtenido: 1)
  ✔ una sola creación efectiva (obtenido: 1)
  ✔ 9 respuestas marcadas como duplicadas (obtenido: 9)

4) Carrera por el cupo liberado tras una cancelación
  ✔ el titular toma el único cupo
  ✔ el titular cancela su reserva
  ✔ exactamente 1 aspirante obtiene el cupo (obtenido: 1)
  ✔ 2 filas en total: 1 cancelada + 1 vigente (obtenido: 2)

5) 30 solicitudes sobre un bloque ya agotado
  ✔ ninguna solicitud tardía tiene éxito (obtenido: 0)
  ✔ las 30 reciben "sin_cupos" (obtenido: 30)
  ✔ las 30 devuelven un mensaje legible (obtenido: 30)

6) Reintento de una misma solicitud (idempotencia)
  ✔ los 5 reintentos responden ok
  ✔ siempre la misma reserva (ids distintos: 1)
  ✔ una sola reserva vigente (obtenido: 1)
  ✔ un solo trabajo de Calendar (obtenido: 1)
  ✔ dos notificaciones: confirmación + recordatorio (obtenido: 2)

✔ Todas las comprobaciones de concurrencia superadas: cero sobrecupos, cero duplicados
```

### Por qué funciona

`create_reservation_strict` toma `SELECT ... FOR UPDATE` sobre la fila del
bloque **antes** de contar las reservas. Las solicitudes del mismo bloque se
serializan en ese punto, así que el conteo y la comparación contra
`max_capacity` son consistentes. El índice único parcial
`reservations_one_active_per_user_block_idx` es la segunda barrera contra
duplicados.

El bloqueo es **por fila**, no por tabla: dos bloques distintos no se bloquean
entre sí, lo que mantiene el rendimiento bajo carga.

---

## 4. Lint y tipos

```bash
npm run lint        # ESLint
npm run lint:fix
npm run typecheck   # tsc -b --force
```

ESLint cubre tres entornos con reglas propias:

| Ámbito | Entorno | Reglas destacadas |
|---|---|---|
| `src/**/*.{ts,tsx}` | Navegador | React Hooks (incluidas las del compilador de React), prohibición de `any`, `no-console` salvo `warn`/`error` |
| `supabase/functions/**/*.ts` | Deno | Globales de Deno, prohibición de `any` |
| `scripts/**/*.mjs` | Node | Estilo común |

> La configuración anterior del repositorio declaraba `files: ["**/*.js"]`, por
> lo que en la práctica no revisaba ningún archivo del proyecto: todo el código
> es `.ts`/`.tsx`. Al corregirla aparecieron errores reales, que se arreglaron.

---

## 5. Antes de integrar a la rama principal

El requisito del documento es que las pruebas corran automáticamente antes de
integrar cambios. Localmente:

```bash
npm run verify           # lint + typecheck + test + build
npm run test:db
npm run test:concurrency
```

En integración continua, el flujo de GitHub Actions de `DESPLIEGUE_AWS.md` § 8
ejecuta las tres suites (las de base de datos contra un PostgreSQL de servicio)
y bloquea el despliegue si alguna falla.

Para exigirlo, en GitHub: **Settings → Branches → Branch protection rule** sobre
`main`, marcando «Require status checks to pass» con los trabajos `verificar` y
`pruebas-de-base-de-datos`.

---

## 6. Añadir pruebas

### Una regla de negocio nueva

Modifícala en los dos lugares y prueba en los dos:

1. `supabase/migrations/20261016000200_functions.sql` — la validación que cuenta.
2. `src/domain/reservationRules.ts` — el reflejo en la interfaz.
3. `supabase/tests/` — la prueba SQL.
4. `src/domain/reservationRules.test.ts` — la prueba del cliente.

Si las dos capas se separan, la interfaz habilitará algo que el backend
rechazará (molesto pero seguro) o deshabilitará algo permitido (una función
perdida). Ambas pruebas existen para detectarlo.

### Una prueba SQL

Crea un archivo en `supabase/tests/` con el prefijo numérico que corresponda.
El corredor lo recoge solo. Patrón:

```sql
do $$
declare
  _usuario uuid;
  _resultado jsonb;
begin
  _usuario := test_helpers.create_user('nuevo@uc.cl', 'Persona Nueva');
  perform test_helpers.login_as(_usuario);

  _resultado := public.alguna_funcion(...);
  assert (_resultado ->> 'ok')::boolean, format('Falló: %s', _resultado);

  raise notice 'OK · descripción de lo que se verificó';
end;
$$;
```

Los `raise notice` que empiezan con `OK ·` se muestran en la salida del
corredor, así que sirven para documentar qué se comprobó.

### Una prueba de integración con un servicio externo

Simula `fetch` con `vi.stubGlobal` y verifica **lo que se envía** y **cómo se
interpreta cada respuesta**, incluidos los errores. Lo valioso está en los
casos límite: el `409` de Google, el `63003` de Twilio, la firma inválida. Ver
`src/test/googleCalendar.test.ts` como referencia.

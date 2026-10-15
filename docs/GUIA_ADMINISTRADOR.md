# Guía de administración · ActivaUC

Para el personal a cargo de uno o más recintos deportivos.

---

## Qué puedes hacer

Como administradora o administrador de recintos gestionas **únicamente los
recintos que tienes asignados**:

- Crear, editar y desactivar recintos.
- Publicar bloques horarios y definir su capacidad.
- Ver las reservas vigentes y el historial.
- Cancelar reservas (por mantención, por ejemplo), sin la restricción de 2 horas
  que sí aplica a las personas usuarias.
- Revisar el estado de las integraciones con Google Calendar y WhatsApp.
- Consultar la auditoría de las acciones sobre tus recintos.

Esta restricción no es sólo visual: el sistema **vuelve a verificar** en cada
operación que el recinto esté asignado a tu cuenta. No puedes modificar un
recinto ajeno ni cancelar una reserva de un recinto que no administras, aunque
tengas su identificador.

### Qué no puedes ver

El correo y el teléfono de las personas que reservan **no están disponibles en
el panel**, por protección de datos. Ves su nombre, que es lo necesario para
gestionar un recinto. Si necesitas contactar a alguien, el sistema le envía los
avisos por WhatsApp de forma automática cuando cancelas su reserva.

---

## Obtener acceso

El rol de administrador **no se puede asignar desde la aplicación**: es una
medida de seguridad deliberada. El procedimiento es:

1. Crea tu cuenta normalmente en ActivaUC y confirma tu correo.
2. Pide al equipo técnico de Deportes UC que te asigne el rol y los recintos.
   Lo hacen con un comando documentado (`scripts/seed-usuarios.sh`).
3. Vuelve a iniciar sesión: aparecerá **Administración** en la barra de
   navegación.

---

## Panel de administración

Cinco secciones.

### Recintos

Lista de los recintos a tu cargo.

**Crear uno nuevo** (botón **Agregar recinto**):

| Campo | Para qué |
|---|---|
| Nombre | Identifica el recinto. Debe ser único |
| Tipo de recinto | Se usa como filtro en el catálogo. Mantén la nomenclatura consistente: «Fútbol», no «futbol» o «Futbol 7» |
| Descripción | Lo que conviene saber antes de llegar: superficie, iluminación, camarines, cómo acceder |
| Horario de funcionamiento | Texto informativo, por ejemplo «08:00 a 22:00, lunes a sábado» |

El recinto que creas **queda asignado a tu cuenta** automáticamente.

**Editar**: cambia cualquiera de esos datos. Los cambios se ven de inmediato en
el catálogo.

**Desactivar**: el recinto deja de aparecer en el catálogo y sus bloques dejan
de ser reservables.

> Desactivar **no cancela** las reservas ya confirmadas, a propósito: cancelar
> en masa es una decisión que debes tomar tú, no un efecto secundario. Si
> necesitas liberar los bloques, cancela cada reserva desde la pestaña
> **Reservas**, donde cada persona recibirá su aviso con el motivo.

Nada se borra: puedes reactivar un recinto cuando quieras, y su historial se
conserva.

### Bloques y capacidad

Aquí publicas la disponibilidad. Elige primero el recinto.

**Agregar disponibilidad**:

| Campo | Detalle |
|---|---|
| Inicio | Fecha y hora de comienzo |
| Término | Debe ser posterior al inicio. Máximo 12 horas de duración |
| Capacidad máxima | Cuántas personas admite el bloque, entre 1 y 1000 |

El sistema impide crear dos bloques activos que empiecen a la misma hora en el
mismo recinto.

Los bloques se listan agrupados por día, del más reciente al más antiguo.

**Editar un bloque**: puedes cambiar el horario y la capacidad. Si reduces la
capacidad por debajo de las reservas ya confirmadas, **esas reservas se
mantienen**: el sistema simplemente no aceptará nuevas hasta que haya cupos
otra vez. No se cancela nada automáticamente.

**Desactivar un bloque**: deja de admitir nuevas reservas y desaparece del
catálogo. Las existentes se conservan.

#### Publicar disponibilidad de una semana

Hoy los bloques se crean uno a uno desde el panel. Para una carga semanal
grande, el equipo técnico puede hacerlo por SQL en un solo paso; pídeselo
indicando recinto, días, horas y capacidad.

### Reservas

Monitoreo y cancelación.

Filtros disponibles:

- **Recinto**: uno en particular o todos los tuyos.
- **Mostrar**: reservas vigentes, historial (pasadas y canceladas) o todas.

Cada fila muestra el recinto y horario, el nombre de quien reservó, el estado de
la reserva y el estado de sus integraciones.

**Cancelar una reserva**:

1. Pulsa **Cancelar** en la fila correspondiente.
2. **Escribe el motivo.** Se incluye en el aviso a la persona y queda registrado
   en la auditoría. Un motivo claro («mantención programada de la cancha») evita
   consultas posteriores.
3. Confirma.

Qué ocurre al cancelar:

- El cupo queda disponible **de inmediato** para otras personas.
- Si la persona tiene WhatsApp habilitado, recibe un aviso con el motivo. El
  panel te dice si se encoló ese aviso o si la persona no tiene WhatsApp
  habilitado.
- Si tenía el evento en su Google Calendar, se elimina.
- Queda registrado en la auditoría: quién canceló, cuándo y por qué.

> No estás sujeto a la ventana de 2 horas, pero no puedes cancelar una reserva
> que **ya finalizó**.

### Integraciones

Estado de las sincronizaciones con Google Calendar y de los envíos de WhatsApp
de las reservas de tus recintos.

Arriba, un resumen: total de registros, cuántos tienen error, cuántos están
pendientes y cuántos corresponden a Google Calendar.

| Estado | Qué significa |
|---|---|
| **Completado** / **Entregado** | Funcionó |
| **Pendiente** / **En proceso** | Está en cola; se resuelve solo en el próximo ciclo |
| **Con error** / **Falló** | Se agotaron los reintentos. Requiere revisión técnica |
| **Cancelado** | Ya no corresponde (por ejemplo, la reserva se canceló antes de sincronizar) |
| **Omitido** | No aplicaba (la persona no tiene WhatsApp habilitado) |

**Lo importante**: una integración con error **no invalida la reserva**. La
persona tiene su cupo garantizado; lo que falló es el evento de calendario o el
mensaje. Si ves errores, avisa al equipo técnico con la información de esta
pantalla; los pasos de recuperación están en `docs/OPERACION.md`.

### Auditoría

Registro de las acciones sobre tus recintos: reservas creadas y canceladas,
cambios en recintos y bloques, y resultados de las integraciones.

Cada entrada indica la acción, quién la realizó (usuario, administración o el
sistema), el detalle relevante y la fecha. No contiene datos personales ni
credenciales.

Es la herramienta para responder «¿qué pasó con esta reserva?»: muestra el
historial completo.

---

## Tareas frecuentes

### Publicar la disponibilidad de la semana

1. **Bloques y capacidad** → elige el recinto.
2. Crea cada bloque con su horario y capacidad.
3. Verifica en **Catálogo** que aparezcan como esperas.

### Cerrar un recinto por mantención

1. **Reservas** → filtra por ese recinto y **Reservas vigentes**.
2. Cancela cada reserva indicando el motivo. Cada persona recibirá su aviso.
3. **Recintos** → **Desactivar**, para que no se hagan nuevas reservas.
4. Al terminar la mantención, **Reactivar**.

### Ajustar la capacidad de un bloque

1. **Bloques y capacidad** → **Editar** en el bloque.
2. Cambia la capacidad y guarda.
3. El catálogo lo refleja al instante.

Recuerda: reducir la capacidad no cancela reservas existentes.

### Revisar la asistencia de un bloque

1. **Reservas** → filtra por recinto.
2. **Mostrar: Todas** y localiza el bloque por su horario.
3. Verás los nombres de quienes reservaron y el estado de cada reserva.

---

## Buenas prácticas

1. **Nomenclatura consistente en los tipos de recinto.** El tipo es un filtro
   del catálogo: si escribes «Fútbol» en uno y «futbol» en otro, aparecerán como
   dos categorías distintas.
2. **Descripciones útiles.** Lo que la persona necesita saber antes de llegar:
   dónde está, qué llevar, si hay camarines.
3. **Capacidad realista.** Es el único control de aforo: el sistema no permite
   superarla.
4. **Publica con anticipación.** Para que los recordatorios de 2 horas tengan
   sentido, los bloques deben estar disponibles antes.
5. **Motivos claros al cancelar.** El motivo llega a la persona y queda en la
   auditoría.
6. **Desactiva en vez de improvisar.** Si un recinto no está disponible,
   desactívalo: es mejor que dejarlo visible y cancelar reservas después.
7. **Revisa Integraciones de vez en cuando.** Si aparecen errores recurrentes,
   hay algo que corregir en la configuración.

---

## Preguntas frecuentes

**¿Puedo ver el teléfono de alguien para llamarle?**
No. El panel muestra sólo el nombre, por protección de datos. Al cancelar una
reserva, el sistema le avisa automáticamente por WhatsApp si tiene el número
registrado.

**¿Puedo cancelar una reserva de otro recinto?**
No. El sistema lo verifica en cada operación, no sólo en la interfaz.

**¿Qué pasa si desactivo un recinto con reservas vigentes?**
Deja de aparecer en el catálogo y no admite nuevas reservas, pero **las
existentes se mantienen**. Si necesitas liberarlas, cancélalas una a una para
que cada persona reciba su aviso.

**¿Puedo reducir la capacidad por debajo de las reservas ya hechas?**
Sí, y esas reservas se conservan. El sistema no aceptará nuevas hasta que haya
cupos disponibles de nuevo.

**Una reserva dice «Calendar: Con error». ¿Está en riesgo?**
No. La reserva es válida; lo que falló fue el evento en el calendario de esa
persona. Avisa al equipo técnico.

**¿Por qué no puedo asignarme más recintos desde el panel?**
Las asignaciones las hace el equipo técnico a propósito: así nadie puede
ampliarse el alcance por su cuenta.

**¿Puedo recuperar un recinto o bloque desactivado?**
Sí. Nada se borra: la desactivación es reversible y el historial se conserva.

**¿Puedo ver quién canceló una reserva y por qué?**
Sí, en **Auditoría**, o en la propia fila de la reserva dentro de **Reservas**.

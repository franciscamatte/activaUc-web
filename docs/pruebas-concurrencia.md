# Prueba de concurrencia (100 usuarios)

## Objetivo
Validar que `create_reservation_strict` evita sobrecupo y duplicados en alta concurrencia.

## Precondiciones
- Migración aplicada en Supabase.
- Usuarios de prueba creados.
- Un bloque con capacidad conocida (ejemplo: 20 cupos).

## Ejecución sugerida
1. Implementar script de carga (k6 o Artillery) que llame RPC `create_reservation_strict` con 100 usuarios autenticados concurrentes.
2. Disparar solicitudes simultáneas al mismo `block_id`.
3. Verificar resultados:
   - Reservas vigentes <= capacidad máxima.
   - Ningún usuario con más de 1 reserva vigente del mismo bloque.
   - Errores esperados: "No hay cupos disponibles" o "Reserva duplicada".

## Validaciones SQL
```sql
select count(*) from reservations where block_id = '<block_id>' and status = 'vigente';

select user_id, count(*)
from reservations
where block_id = '<block_id>' and status = 'vigente'
group by user_id
having count(*) > 1;
```

## Resultado esperado
- Cero sobrecupos.
- Cero duplicados.
- Integridad transaccional preservada.

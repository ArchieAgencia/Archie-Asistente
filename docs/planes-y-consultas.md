# Planes, consultas y consumo (F0, paso 4)

BORRADOR hasta revisión humana.

## Modelo
- `planes` (global): Prueba 100/día 50, Básico 300/día 60, Profesional 1.000/día 150. Valores **provisionales**.
- `organizaciones`: `estado` (prueba, activo, suspendido, baja), `plan_id`, `modo` (autoservicio, gestionada), `autonomia` (lectura, borradores, confirmacion; por defecto borradores), `tope_diario_propio`. `activa` siempre coincide con el estado (restricción de la base).
- `consultas_libro`: libro de solo agregar. Suma (+: plan, recarga, ajuste) y gasto (−: consumo). El saldo es la suma. "Sin saldo" se deriva (saldo ≤ 0).
- La aplicación (`archie_app`) solo puede insertar filas de tipo `consumo`; sumar saldo es cosa de operadores (consola) o de la renovación mensual.

## Consumo
`consumir_consultas(usuario, n, referencia, detalle)` corre en la base, bajo un candado por organización: revisa estado, saldo y tope diario (día de America/Bogota) y registra. Resultados: `ok`, `repetido` (misma referencia, no se cobra dos veces), `sin_saldo`, `tope_diario`, `suspendido`. Con 30 peticiones simultáneas sobre 100 consultas gasta exactamente lo que hay.
Sin saldo el chat se detiene; historial y ajustes siguen disponibles.

## Renovación mensual
`npm run renovar-mes` (día 1, tarea programada del servidor, rol dueño). Deja el saldo de cada cuenta **activa** en la cuota del plan, sin acumular: lo que sobra vence (ajuste negativo) y lo gastado se repone. Idempotente por mes y plan. No toca cuentas en prueba, suspendidas ni dadas de baja. Queda en la bitácora de la cuenta como "Archie AI".

## API del panel del cliente
`GET /api/panel/resumen`, `GET /api/panel/consumo`, `GET /api/panel/bitacora-equipo`, `POST /api/panel/asistencia/terminar` (solo admin). Todas exigen sesión completa y usan solo la organización de la sesión.

## Pendiente
Valores finales de planes; avisos al 80 % y al 100 %; cobro/pasarela (fuera de F0); decidir si el cambio de plan repone consultas de inmediato (hoy el operador lo hace con una recarga).

## Planes desde la base de datos y alertas de consumo (F5)
- **Planes en la administración.** La lista de planes de «Alta de cliente» y «Cambiar plan» ya no está fija en la interfaz: sale de `GET /api/consola/planes`
  (función `consola_planes`, solo planes activos, cualquier rol de operador con sesión completa). Agregar o desactivar un plan es una migración o un cambio en la tabla `planes`.
- **Alertas de consumo.** Al comenzar cada respuesta del chat se revisa el consumo del mes (America/Bogota). Al llegar al **80 %** de la cuota, o al **100 %** (cuota agotada o saldo en cero),
  se envía **un correo a los administradores activos** de esa cuenta. La tabla `alertas_consumo` (clave: cuenta, mes, umbral) garantiza un solo aviso por umbral y mes,
  incluso con varias respuestas simultáneas. Si cruza ambos umbrales a la vez, se envía solo el del 100 %.
- En cuentas **en prueba** las consultas no se renuevan: el correo y el aviso en pantalla lo dicen así y no mencionan fecha de renovación.
- El aviso en pantalla (banda superior) aparece con `consumo.alerta` = 80 o 100 mientras todavía hay saldo; sin saldo se mantiene el aviso de «Inicio».
- **Mejor esfuerzo:** si el correo falla, se registra el error y el chat sigue. Un aviso cuyo envío falló no se reintenta automáticamente (la fila ya quedó registrada).
- No verificado: envío real por Resend (las pruebas usan un correo en memoria).

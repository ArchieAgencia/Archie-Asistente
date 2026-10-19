# Archie AI: conectores de la suite (Talk, Meet, Booking), estado oct 2026

**Qué se hizo:** conectores de solo lectura para Archie Talk, Archie Meet y Archie Booking sobre un contrato de API propio (v1, `docs/contrato-suite.md`). Diez herramientas del chat, conexión cifrada por producto, pantalla «Suite Archie» en Conexiones, funciona también en el widget. Migración `0016` (aplicar tras `0015`). Pruebas: 428 → 438 en verde. Typecheck y compilación del backend y del panel, sin errores.

**Decisión de Karin:** «contrato primero» (porque Talk y Meet se construyen aparte y no existe su documentación de rutas, y el código de Calnode ya no está en el espacio de trabajo). Archie AI define lo que necesita; cada producto lo implementa.

**Probado:** adaptador y servicio contra productos simulados que cumplen el contrato y que meten datos personales de señuelo (no llegan al modelo); clave cifrada y nunca devuelta; solo administradores; aislamiento entre organizaciones; restricciones de la base; rangos inválidos; clave rechazada que marca la conexión; solo se ofrecen las herramientas de lo conectado.
**No probado:** contra Talk, Meet o Booking reales (todavía no ofrecen estas rutas); la pantalla en un navegador (compila, pero no se revisó visualmente); accesibilidad con lector de pantalla; revisión humana de seguridad.

## Para los equipos de Talk, Meet y Booking (brief corto)
1. Lean `docs/contrato-suite.md` completo; implementen solo las rutas de su producto bajo `/archie-ai/v1/<producto>/`.
2. Clave de solo lectura por cuenta (alcance `archie-ai:read`, vencimiento, IP permitida si se puede); la clave identifica la cuenta.
3. Cero datos personales en las respuestas; pruébenlo con un caso que tenga nombre, correo y teléfono.
4. Cuando una ruta esté lista, se prueba con una cuenta de prueba y se anota cualquier ajuste al contrato (versión del contrato si cambia algo).
5. Nada se despliega ni se envía sin OK de Karin.

## Pendientes
- Validar contra cada producto real.
- Escritura (segunda entrega, con borradores reversibles y tarjeta de confirmación): reservar/cancelar cita, responder o asignar conversaciones, mover tratos, crear reuniones.
- Conexión sin pegar claves.
- Guías de soporte: 6 nuevas en `soporte/archie/` (borrador; se publican solo con OK de Karin).

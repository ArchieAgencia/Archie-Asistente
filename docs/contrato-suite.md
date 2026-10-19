# Contrato de conector v1 de la suite Archie (Talk, Meet, Booking)

Estado: **BORRADOR para que lo cumplan los productos.** Archie AI ya lo consume (`src/conectores/suite/`), probado solo con productos simulados. Quien construya Archie Talk, Archie Meet o Archie Booking expone estas rutas; Archie AI no necesita más. Si un producto necesita cambiar algo, se cambia aquí primero (versión del contrato) y luego en los dos lados.

## 1. Reglas generales
- **Solo lectura.** Todas las rutas son `GET`. Este contrato no permite escribir nada.
- **Dirección:** `https://<dominio>/archie-ai/v1/<producto>/<ruta>` con `<producto>` = `talk`, `meet` o `booking`. Dominio público, https, puerto 443, **sin redirecciones** (Archie AI las rechaza). Respuesta de máximo 1 MB y en menos de 10 s.
- **Autenticación:** `Authorization: Bearer <clave>`. La clave la crea el administrador de la cuenta **dentro del producto**, solo para Archie AI, con alcance de **solo lectura** del contrato (por ejemplo `archie-ai:read`), vencimiento y, si se puede, lista de IP permitidas. **La clave identifica la cuenta (cliente)**: no hay identificador de cliente en la ruta. Toda consulta debe filtrar por esa cuenta.
- **Errores:** 401 clave inválida o vencida; 403 sin permiso; 404 ruta u objeto inexistente; 429 límite de peticiones; 5xx falla. El cuerpo del error es libre y **Archie AI nunca lo muestra**.
- **Fechas:** `AAAA-MM-DD` en consultas (en la zona horaria de la cuenta del producto). En respuestas, ISO 8601 (`2026-10-05T10:00:00-05:00` o solo fecha).
- **Dinero:** `{ "moneda": "COP", "monto": "80000" }`, monto como **texto decimal** (nunca número de punto flotante).
- **Listas:** aceptan `limite` (1 a 20; Archie AI nunca pide más de 20) y devuelven `total` (opcional) y `truncado` (booleano) si hay más filas que las devueltas.
- **Identificadores (`id`):** texto de 1 a 100 caracteres, que empiece por letra o número y use solo letras, números, `.`, `_`, `:`, `=`, `-`. Las filas con identificador inválido se descartan.
- **Campos desconocidos se ignoran.** Archie AI solo lee los campos de este documento, así que enviar de más no filtra nada, pero **no envíes datos personales de más**.

## 2. Privacidad: lo que NO debe aparecer
Ninguna ruta devuelve nombres, correos, teléfonos ni mensajes de personas que escribieron, reservaron o asistieron, ni el contenido de conversaciones o grabaciones. Archie AI descarta estos campos aunque lleguen, pero la regla de origen es no entregarlos. Los títulos de tratos y de reuniones pueden tener texto libre escrito por personas: Archie AI los limpia y se los presenta al modelo como datos, nunca como instrucciones.

## 3. Ruta común
`GET /archie-ai/v1/<producto>/info` →
```json
{ "contrato": 1, "producto": "talk", "nombre": "Mi empresa", "zona_horaria": "America/Bogota" }
```
`contrato` debe ser `1` y `producto` debe coincidir con la ruta (así una clave de un producto no se conecta por error a otro). Es la prueba que se hace al conectar.

## 4. Archie Booking
- `GET …/booking/tipos-de-cita` → `{ "tipos": [{ "id", "nombre", "duracion_min", "activo", "precio": {moneda, monto} }] }`
- `GET …/booking/disponibilidad?tipo=<id>&desde=AAAA-MM-DD&hasta=AAAA-MM-DD` (máximo 14 días) → `{ "espacios": [{ "inicio", "fin" }], "truncado" }` (hasta 40 espacios). **No reserva nada.**
- `GET …/booking/reservas?desde&hasta&estado&limite` → `{ "reservas": [{ "id", "tipo_id", "tipo", "inicio", "fin", "estado", "pagada", "monto" }], "total", "truncado" }`. `estado`: `pendiente`, `confirmada`, `completada`, `cancelada`, `no_asistio`. **Sin datos de quien reservó.**
- `GET …/booking/resumen?desde&hasta` → `{ "total", "por_estado": { "confirmada": 6, … }, "ingresos": [{moneda, monto}] }`

## 5. Archie Talk (conversaciones y CRM)
- `GET …/talk/metricas?desde&hasta` → `{ "total", "por_canal": {"whatsapp": 90}, "por_estado": {"abierta": 10}, "sin_asignar", "primera_respuesta_seg_mediana", "resolucion_seg_mediana" }`
- `GET …/talk/conversaciones?desde&hasta&estado&canal&limite` → `{ "conversaciones": [{ "id", "canal", "estado", "asignado_a", "creada", "ultima_actividad", "mensajes", "etiquetas": [] }], "total", "truncado" }`. `estado`: `abierta`, `pendiente`, `resuelta`. `asignado_a` es el **nombre de la persona del equipo**, no del cliente que escribió. **Sin contenido de mensajes.**
- `GET …/talk/embudo` → `{ "etapas": [{ "id", "nombre", "tratos", "valor": {moneda, monto} }] }`
- `GET …/talk/tratos?etapa=<id>&limite` → `{ "tratos": [{ "id", "titulo", "etapa", "valor", "creado", "ultimo_movimiento" }], "total", "truncado" }`. **Sin datos de contactos.**

## 6. Archie Meet
- `GET …/meet/reuniones?desde&hasta&estado&limite` → `{ "reuniones": [{ "id", "titulo", "inicio", "duracion_min", "estado", "participantes", "grabada" }], "total", "truncado" }`. `estado`: `programada`, `en_curso`, `finalizada`, `cancelada`. `participantes` es un **número**; **sin nombres ni correos**.
- `GET …/meet/uso?desde&hasta` → `{ "reuniones", "minutos", "grabaciones", "participantes_promedio" }`

## 7. Lista de verificación para quien implementa
1. La clave de solo lectura solo abre estas rutas y solo de su cuenta (probar con dos cuentas: una no ve lo de la otra).
2. `info` responde `contrato: 1` y el `producto` correcto.
3. Ninguna respuesta incluye datos personales (revisar con un caso que tenga nombre, correo y teléfono).
4. Montos como texto decimal con moneda; fechas ISO.
5. Estados con los valores de arriba (cualquier otro se muestra como «otro»).
6. Límite de peticiones razonable, 429 cuando se pasa, y respuestas rápidas (el chat espera máximo 20 s por herramienta).
7. Cada consulta con la clave queda en la bitácora del producto (quién, cuándo, qué ruta).

## 8. Cómo prueba Archie AI su lado
`tests/suite.test.ts` simula un producto que cumple el contrato **y mete datos personales a propósito** para comprobar que no pasan al modelo. **No está probado contra un producto real**: cuando exista un Talk, Meet o Booking, se valida con una cuenta de prueba y se ajusta el contrato si hace falta.

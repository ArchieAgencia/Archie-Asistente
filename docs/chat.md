# Chat de solo lectura (F1) — BORRADOR

Estado: construido y probado con un modelo simulado y un Archie Send de mentira. **No probado contra la API real del proveedor de IA ni contra un Archie Send real.**

## Qué hace
Una persona del cliente le pregunta a Archie AI por su Archie Send ("¿cuántos créditos me quedan?", "¿hubo errores de envío?"). El asistente consulta Archie Send con la clave de API que el administrador conectó y responde en español. **No puede enviar, crear, editar ni borrar nada**: en esta versión el catálogo solo tiene lecturas.

## Piezas
| Pieza | Archivo |
|---|---|
| Contrato con el proveedor de IA | `src/ia/modelo.ts` |
| Cliente de la API de mensajes del proveedor de IA (streaming SSE, sin SDK) | `src/ia/archie-ia.ts` |
| Modelo simulado (pruebas y desarrollo) | `src/ia/simulado.ts` |
| Cliente de Archie Send (solo GET, rutas fijas) | `src/conectores/send.ts` |
| Herramientas de lectura | `src/conectores/send-herramientas.ts` |
| Instrucciones del asistente (versionadas) | `src/chat/instrucciones.ts` |
| Conexión por organización (clave cifrada) | `src/chat/conexiones.ts` |
| Bucle del agente y conversaciones | `src/chat/servicio.ts` |
| Rutas HTTP y SSE | `src/chat/rutas.ts` |
| Pantallas | `web/src/views/Chat.vue`, `Conexiones.vue` |
| Base de datos | `migrations/0006_chat.sql` |

## Endpoints reales de Archie Send que se usan (leídos del código de Archie Send, no supuestos)
Autenticación: cabecera `Authorization: token <usuario>:<clave>`. Respuesta: `{"data": ...}`.

| Herramienta | GET |
|---|---|
| `send_listas` | `/api/lists` |
| `send_campanas` | `/api/campaigns?no_body=true&order_by=created_at&order=desc` |
| `send_campana` | `/api/campaigns/:id` (se descarta el cuerpo del correo) |
| `send_campanas_en_curso` | `/api/campaigns/running/stats` |
| `send_segmentos` | `/api/segments` |
| `send_creditos` | `/api/credits` |
| `send_errores_envio` | `/api/send-errors` |
| `send_contactos` (apagada) | `/api/subscribers` |

El cliente rechaza cualquier otra ruta antes de salir a la red. Los permisos reales los decide Archie Send según el rol de la clave: Archie AI nunca puede más que esa clave.

## Flujo de un mensaje
1. Una sola transacción: comprueba que hay conexión, bloquea la conversación (una respuesta a la vez), **cobra 1 consulta** (`consumir_consultas`, con topes y saldo) y guarda el mensaje. Si algo falla, no queda nada.
2. Bucle (máx. `ARCHIE_IA_MAX_PASOS`): llama al modelo → si pide herramientas, las ejecuta en el servidor (argumentos validados con zod, 20 s de tope) → guarda el pedido y sus resultados **juntos** → vuelve al modelo.
3. Si el proveedor falla **antes de dar una sola palabra**, se devuelve la consulta (`devolver_consulta`: solo la organización fijada, solo un consumo propio de los últimos 15 minutos, una sola vez). Si ya había texto, no se devuelve.
4. Cada vuelta del modelo queda en `uso_ia` (tokens y costo estimado); cada herramienta en `llamadas_herramienta` (nombre, argumentos acotados, resultado ok/error; **sin datos de respuesta**).

## Seguridad: lo que se hizo y por qué
- **Datos de terceros ≠ instrucciones.** Todo resultado llega al modelo dentro de `{fuente, aviso, datos}`; los textos se limpian (caracteres de control y de dirección), se acortan y se limita el número de filas (20). Las instrucciones del sistema lo repiten. El catálogo no tiene herramientas de enviar, programar, pausar, editar ni borrar; solo lecturas y tres de crear borradores (ver «Nivel 2»), así que aunque un dato diera una orden, lo peor que podría obtenerse es un borrador que se deshace con un clic.
- **Sin canal de salida.** La pantalla escribe todo como texto (sin Markdown, enlaces ni imágenes remotas) y la política CSP del sitio no permite recursos de terceros.
- **Clave de Archie Send:** cifrada AES-256-GCM atada a la organización y al propósito, se prueba antes de guardar, nunca vuelve al navegador, no entra al modelo ni a los registros (los errores de Archie Send nunca copian su cuerpo). Solo administradores la cambian; queda en la auditoría.
- **SSRF:** la dirección de Archie Send la fija el servidor (`ARCHIE_SEND_URL`); el cliente no sigue redirecciones.
- **Privacidad entre personas:** las conversaciones son de quien las escribió, incluso para otros administradores de la misma cuenta. El equipo de Archie Tech no tiene función para leerlas. La base lo refuerza con seguridad por filas.
- **Contactos:** herramienta apagada por defecto (`ARCHIE_IA_CONTACTOS=no`). Encendida: máx. 20 por llamada y 100 por conversación, correos enmascarados, sin campos personalizados ni teléfono.
- **Costo:** 1 consulta por mensaje, topes del plan, límite de 12 mensajes por minuto por persona y 60 por organización, historial recortado (resultados viejos a 3.000 caracteres, 60.000 en total), `max_tokens` por respuesta.
- **Retención:** 30 días. Vencidas = invisibles al instante y borradas por `npm run limpiar` (tarea diaria, rol dueño, solo puede borrar vencidas). La aplicación no puede cambiar el vencimiento.

## Operación
- Tarea diaria en el servidor: `ARCHIE_OWNER_URL=... npm run limpiar` (si no corre, las conversaciones vencidas quedan ocultas pero siguen guardadas).
- Poner los precios (`ARCHIE_IA_PRECIO_*`) para que `uso_ia` estime el costo.
- Con proxy (Traefik/Coolify) no hace falta nada especial para SSE; la respuesta ya manda `X-Accel-Buffering: no` por si hay Nginx delante.
- Al actualizar: `npm run migrar` (0006 y 0007). No hay roles nuevos.

## Pendiente / no verificado
- Probar con la API real del proveedor de IA (formato de eventos SSE implementado según la documentación; solo probado con respuestas simuladas) y definir el modelo y los precios.
- Probar contra un Archie Send real con una clave de rol de solo lectura; confirmar que `/api/subscribers` y `/api/send-errors` responden con ese rol.
- Revisión de abogado: texto de conversaciones y resultados de Archie Send viajan al proveedor de IA (en el exterior) — Ley 1581.
- Revisión de seguridad humana del bucle del agente y de las políticas de la base.
- Limitador de mensajes en memoria (una sola instancia).
- Nivel 3 probado solo con Archie Send simulado; los nombres de estado (`draft`, `scheduled`, `running`, `paused`, `cancelled`) y la ruta `PUT /api/campaigns/:id/status` salen del código de Archie Send, no de una instancia real. Programar solo aplica si la campaña ya tiene fecha de envío (no se editan fechas desde aquí).


## Nivel 2: borradores reversibles (F2)
Qué crea: `send_crear_lista` (lista vacía), `send_crear_segmento` (filtro guardado) y `send_crear_borrador_campana` (campaña en estado `draft`). No hay herramienta de enviar, programar, pausar, editar ni borrar: eso es nivel 3.

- **Autonomía por organización** (`organizaciones.autonomia`, la cambia el equipo desde la administración): `lectura` = el modelo ni ve las herramientas de crear; `borradores` (por defecto) y `confirmacion` = las ve. Se lee en cada mensaje.
- **Contenido del correo:** se valida ANTES de salir a la red. Solo HTML simple y las variables `{{ .Subscriber.FirstName }}` y `{{ .Subscriber.Name }}` (el cuerpo es una plantilla Go en Archie Send); se rechazan `<script`, `<iframe`, `<object`, `<embed`, `<form`, `javascript:`, atributos `on…=` y `data:text/html`. Una campaña no lleva fecha de envío, ni estado, ni remitente propio.
- **Topes:** 5 acciones por conversación y 20 por hora por organización (el modelo recibe un mensaje claro).
- **Registro:** cada cosa creada queda en `acciones` (qué, quién, en qué conversación, id y nombre en Archie Send) y en la auditoría. La app solo puede agregar y marcar como deshecha, nunca borrar. Lo creado se avisa por SSE (`accion`) y aparece en la pantalla **Acciones**.
- **Deshacer = un clic de una persona** (nunca una herramienta del modelo): `POST /api/panel/acciones/:id/deshacer`. Lo puede hacer quien lo pidió o cualquier administrador. Antes de borrar se comprueba en Archie Send que siga siendo lo que se creó: lista solo si sigue **vacía** y con el mismo nombre; campaña solo si sigue en **borrador** y con el mismo nombre; segmento con el mismo nombre. Si ya no existe, se marca deshecha sin error. La clave de Archie Send solo puede borrar rutas de lista, segmento y campaña por id.
- **Errores de Archie Send al crear:** el motivo breve (solo de 400/422, saneado a 200 caracteres) se le pasa al modelo para que lo explique; no llega a la pantalla ni a la base de datos. Un 403 se explica como «la clave no tiene permiso de gestión».
- **Requisito en Archie Send:** la clave conectada debe pertenecer a un usuario de API con permiso de gestión de listas, segmentos y campañas. Con solo lectura, crear falla con un mensaje claro.
- **Pendiente / no verificado:** probado contra un Archie Send simulado (forma de las respuestas tomada del código fuente de Archie Send, no de una instancia real); la traducción de reglas de segmento se verificó contra el código pero no contra todos los operadores; un segmento sin más datos no puede comprobarse más allá del nombre.


## Nivel 3: acciones sensibles con confirmación humana (F3)
Acciones: enviar ahora, programar (solo si ya tiene fecha futura), pausar, reanudar, cancelar y borrar una campaña. Solo con autonomía `confirmacion`.

- **El modelo solo propone.** Su única herramienta (`send_proponer_accion_campana`, campaña + acción) no ejecuta nada: lee la campaña en Archie Send, comprueba que la acción aplique a su estado y guarda una **tarjeta** en `propuestas`. No existe ninguna herramienta ni ruta que el modelo pueda usar para ejecutar.
- **El texto de la tarjeta lo escribe el servidor** (`textoTarjeta`) con datos reales: nombre, asunto, estado, listas con su número de contactos, destinatarios como máximo, créditos disponibles, fecha de envío en hora de Bogotá y si se puede traer de vuelta. El modelo no puede cambiarlo.
- **Aprobación:** `POST /api/panel/propuestas/:id/aprobar`, solo administradores con sesión completa (segundo factor) y comprobación de origen. Un miembro ve la tarjeta pero no la aprueba. La tarjeta vence a los **15 minutos**.
- **Se ejecuta exactamente lo aprobado, una sola vez:** (1) reclamo atómico `pendiente → ejecutando` (dos clics o dos personas a la vez = una sola ejecución; un disparador en la base solo admite transiciones válidas y la app no puede editar el texto); (2) se vuelve a leer la campaña y se compara su **huella** (acción, id, nombre, asunto, estado, fecha y listas) con la mostrada; si cambió, no se ejecuta; también se revalida el estado y que la autonomía siga en `confirmacion`; (3) se ejecuta y se deja constancia. **Nunca se reintenta solo**: si falla o hay tiempo agotado, la tarjeta queda `fallida` y se pide revisar en Archie Send.
- **Topes:** 3 tarjetas pendientes por conversación y 10 por hora por organización.
- **Auditoría:** `propuesta_creada`, `propuesta_aprobada`, `propuesta_rechazada`, `propuesta_ejecutada`, `propuesta_fallida` (con quién y la IP).
- **Rutas de Archie Send:** el cliente solo cambia estado de campaña por `PUT /api/campaigns/:id/status` con cuatro valores (`scheduled`, `running`, `paused`, `cancelled`) y borra campañas por id; solo se llaman desde la aprobación humana.
- **Límites conocidos:** entre la comprobación de la huella y la ejecución hay una ventana de milisegundos; si el servidor cae justo mientras ejecuta, la tarjeta queda en `ejecutando` y se pide verificar en Archie Send; el modelo escribe texto alrededor de la tarjeta (el prompt le prohíbe decir que algo se ejecutó, pero no es una garantía): por eso la tarjeta es lo que cuenta; el cansancio de aprobar es un riesgo humano que ninguna regla elimina.


## Pantalla «Instrucciones» (contexto del negocio)
- Un texto de hasta 2.000 caracteres por organización (`instrucciones_org`, migración 0009) que describe el negocio: tono, servicios, horarios, políticas. Lo guarda solo un administrador; todos lo leen.
- **Entra al asistente como información, no como permisos:** va en un bloque delimitado (`<<< … >>>`) con la advertencia de que no cambia reglas, permisos ni herramientas. Antes de guardarlo se quitan caracteres de control y de dirección, los marcadores `<<<`/`>>>` (para que no cierre el bloque) y el exceso de saltos de línea.
- **Alcance real:** aunque alguien escriba instrucciones hostiles, el modelo solo tiene las herramientas del nivel de autonomía de la cuenta, los topes y la confirmación humana para lo sensible. El texto no se puede usar para ampliar permisos.
- **Privacidad:** el texto viaja al proveedor de IA en cada pregunta; la pantalla avisa que no se pongan claves ni datos personales de contactos. La auditoría guarda solo el tamaño y la IP, no el texto.
- Completa el paso «Cuéntale a Archie AI cómo es tu negocio» de Inicio.

## Tiendas en línea (fase 2)
El catálogo de herramientas se arma según lo conectado: Archie Send (`send_*`) , tiendas (`tienda_*`) y/o pauta (`pauta_*`) y/o suite (`talk_*`, `meet_*`, `booking_*`, solo las de lo conectado; ver `docs/suite.md`), todas de solo lectura menos Send. Sin ninguna conexión, `409 sin_conexion`. Detalle técnico en `docs/tiendas.md` y `docs/pauta.md`.

## Widget
El mismo chat se puede abrir dentro de otras herramientas con una sesión propia que solo permite conversar. Ver `docs/widget.md`.

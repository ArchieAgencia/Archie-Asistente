# Conector de tiendas para Archie AI (WooCommerce, Shopify y VTEX): diseño técnico (BORRADOR, fase 2)

Estado: diseño aprobado y **construido** (ver `docs/tiendas.md`); probado solo con tiendas simuladas. Lo marcado «por verificar» no se pudo confirmar en la documentación oficial y se comprobará contra una tienda real.

## 1. Objetivo
Que el asistente responda y prepare trabajo sobre las tiendas WooCommerce de los clientes de Archie (ventas, pedidos, productos, stock, cupones), con las mismas reglas de Archie AI: primero solo lectura, después borradores reversibles y, al final, acciones sensibles con confirmación humana. Valor para Archie: reportes en lenguaje natural para los clientes de WordPress/WooCommerce, alertas de stock y de ventas, y menos tiempo armando reportes a mano.

## 2. Lo que dice la API de WooCommerce (revisado)
- Base `/wp-json/wc/v3/`, requiere WooCommerce 3.5+ y enlaces permanentes «bonitos».
- Las claves se crean en WooCommerce > Ajustes > Avanzado > API REST, con un usuario de WordPress y permiso `read`, `write` o `read_write`. **La clave hereda los permisos de ese usuario**; si el usuario se borra, la clave deja de servir.
- Por HTTPS se usa autenticación básica (clave de consumidor como usuario y secreto como contraseña). Por HTTP exigiría OAuth 1.0a: **no se soporta HTTP**.
- Algunos servidores no pasan la cabecera `Authorization`; el recurso alterno es mandar la clave en la URL. **Decisión: no lo soportamos** (las URL quedan en registros de servidores y proxies). Se documenta la solución del lado de la tienda.
- Paginación con `per_page` y `page`; totales en `X-WP-Total` y `X-WP-TotalPages`. Máximo de `per_page`: por verificar (se usará 20, como en Archie Send).
- Rutas exactas de reportes (ventas, más vendidos): por verificar en una tienda real; el plan es calcular lo que se pueda desde pedidos y productos para no depender de reportes que cambian entre versiones.

## 3. El riesgo nuevo: cada tienda es una dirección que escribe el cliente
Archie Send tiene una dirección fija puesta por el servidor. En WooCommerce la dirección la escribe cada cliente, así que un administrador malintencionado (o una cuenta comprometida) podría apuntar el conector a un servicio interno de Archie (SSRF). Defensas, todas obligatorias:
1. Solo `https`, solo puerto 443, solo nombres de dominio (nunca una IP escrita a mano, nunca credenciales ni rutas dentro de la dirección; se guarda solo el origen).
2. Antes de cada conexión se resuelve el nombre y se rechaza si **cualquiera** de las direcciones es privada, de loopback, local de enlace, CGNAT, multicast, reservada o de metadatos de nube (IPv4 e IPv6, incluidas las IPv4 mapeadas).
3. La conexión se hace **a la dirección ya validada** (se fija la IP) para que un cambio de DNS entre la comprobación y la conexión no sirva (DNS rebinding); se valida de nuevo en cada petición.
4. Sin redirecciones; tiempo y tamaño de respuesta máximos; solo `GET` a una lista cerrada de rutas.
5. Mensajes de error iguales para «no resuelve», «no responde» y «bloqueada», para que no sirva para explorar la red interna.
6. Límite de intentos de conexión por organización y registro en la auditoría.
7. La clave se guarda cifrada con la organización atada al cifrado (como la de Archie Send) y no vuelve al navegador, al modelo ni a los registros.
8. Para las pruebas automáticas, el cliente HTTP admite una opción interna (`permitirPrivadas`) que solo se inyecta desde el código de las pruebas: **no existe como variable de entorno ni como ajuste**, así que no se puede activar en un servidor.

## 4. Datos personales (Ley 1581)
Los pedidos y clientes de WooCommerce traen nombres, correos, teléfonos y direcciones. Regla de la primera entrega: **el asistente no ve ni nombres completos, ni correos, ni teléfonos, ni direcciones.** Los pedidos se muestran por número, estado, fecha, total y productos. Una herramienta de clientes, si algún día se enciende, sería como la de contactos de Archie Send: apagada por defecto, correos enmascarados y con tope. Pendiente de revisión legal antes de ofrecerlo.

## 5. Primera entrega: solo lectura (nivel 1)
Herramientas propuestas, todas `GET`, todas con campos explícitos y texto saneado:
- `woo_resumen_ventas`: ventas, número de pedidos y ticket promedio de un periodo (hoy, 7 días, mes, o fechas), por estado de pago, con moneda de la tienda.
- `woo_pedidos` y `woo_pedido`: lista (máx. 20) y detalle sin datos personales.
- `woo_productos` y `woo_producto`: búsqueda, precio, stock y estado.
- `woo_stock_bajo`: productos con stock bajo o agotados.
- `woo_mas_vendidos`: calculado desde los pedidos del periodo.
- `woo_cupones`: cupones activos, uso y vencimiento.
Todas devuelven datos de **una tienda**; si la organización tiene varias, el asistente pregunta cuál (o se elige por nombre).

## 6. Cambios en lo que ya existe
- Hoy `conexiones.ts`, el bucle del chat (`chat/servicio.ts`) y el contexto de las herramientas están escritos solo para Archie Send (un único cliente por organización). Es la parte más delicada de la entrega: se toca código ya auditado, así que se hará con las pruebas existentes como red de seguridad. `conexiones.ts` se generaliza Se generaliza a «conectores» (Send, WooCommerce) con una pieza común y un catálogo de herramientas por conector. La tabla `credenciales_conector` ya admite varios conectores y varios nombres por organización; **no hace falta tabla nueva**: la restricción `(organización, conector, nombre)` ya permite varias tiendas; solo se agrega una columna para el origen de la tienda (no es secreto).
- Pantalla **Conexiones**: tarjeta nueva «Tiendas WooCommerce» (agregar, probar, quitar). La prueba usa una consulta mínima y guarda el resultado.
- El cobro por consulta, los topes, la bitácora de herramientas y las instrucciones del negocio se reutilizan sin cambios.
- Guías de soporte nuevas: cómo crear la clave de solo lectura en WooCommerce, cómo conectarla, qué ve y qué no ve el asistente, y qué hacer si Hostinger o SiteGround bloquean la API.

## 7. Cómo se creará la clave en la tienda (recomendación para el cliente)
Crear un usuario de WordPress propio para Archie AI, con el rol de menor permiso que alcance (la clave hereda sus capacidades), y una clave API con permiso **solo lectura**. Así, aunque la clave se filtrara, no podría cambiar nada en la tienda.

## 8. Pruebas previstas
Pruebas automáticas con una tienda simulada (rutas permitidas, saneado de texto, límites, SSRF con direcciones privadas, IPv6, mapeadas, rebinding simulado, redirecciones, respuestas enormes, claves rechazadas) más una prueba manual de extremo a extremo con navegador. **Pendiente que depende de Karin:** una tienda WooCommerce de prueba (puede ser un sitio de staging) con una clave de solo lectura para validar contra la API real, y confirmar las rutas de reportes y el máximo de `per_page`.

## 9. Lo que NO incluye la primera entrega
Escribir en la tienda (crear cupones, cambiar precios, stock o estados de pedidos). Eso entra en una segunda parte, con la misma escalera de seguridad: borradores reversibles (por ejemplo, cupón en borrador) y confirmación humana para lo sensible (cambiar precios o estados de pedidos).

## 10. Decisiones que necesito de Karin
1. ¿Apruebas el alcance de solo lectura primero, sin datos personales de clientes?
2. ¿Puedes conseguir una tienda de prueba con clave de solo lectura (staging de algún cliente o una propia) para la validación real?
3. ¿Soportamos varias tiendas por cuenta desde el primer día? (recomendado: sí)


---

# Ampliación aprobada: una capa común de «tiendas» con tres adaptadores

Karin aprobó (oct. 2026) el alcance de solo lectura, sin datos personales de compradores, varias tiendas por cuenta, y que el mismo conector sirva para **Shopify** y **VTEX**. Las pruebas contra tiendas reales quedan para el final; mientras tanto todo se prueba con tiendas simuladas.

## 11. Idea central
Las herramientas del asistente son **las mismas para las tres plataformas** (`tienda_resumen_ventas`, `tienda_pedidos`, `tienda_pedido`, `tienda_productos`, `tienda_producto`, `tienda_stock_bajo`, `tienda_mas_vendidos`, `tienda_cupones`). Cada plataforma tiene un **adaptador** que traduce a su API y entrega un formato común ya saneado y sin datos personales. El asistente elige la tienda por su nombre. Así, una tienda nueva en el futuro (Mercado Libre, Magento) es solo otro adaptador.

## 12. Lo que dice cada plataforma (revisado) y qué cambia
| | WooCommerce | Shopify | VTEX |
|---|---|---|---|
| Dirección | La escribe el cliente (dominio propio) | `{tienda}.myshopify.com`, el servidor la **arma** desde un nombre validado | `{cuenta}.vtexcommercestable.com.br` (por verificar), el servidor la **arma** desde un nombre validado |
| Credencial | Clave y secreto (autenticación básica por HTTPS) | Token de acceso en la cabecera `X-Shopify-Access-Token` | `X-VTEX-API-AppKey` y `X-VTEX-API-AppToken` |
| Permiso mínimo | Clave «solo lectura» | `read_orders`, `read_products`, `read_inventory` | Rol de License Manager solo con los recursos de lectura necesarios |
| Riesgo SSRF | Alto (dirección libre): las 8 defensas | Bajo (dominio fijo) y se aplican igual | Bajo (dominio fijo) y se aplican igual |

Hallazgos que condicionan el diseño:
- **Shopify ya no permite crear «apps personalizadas» desde el administrador** (las existentes siguen funcionando); las tiendas nuevas deben usar el Dev Dashboard. La documentación consultada no deja claro el camino exacto para obtener un token en una tienda nueva sin publicar una app: **por verificar**. Primera entrega: el administrador de la cuenta pega el token que obtenga; una conexión «con un clic» (OAuth, con Archie como app de Shopify) sería una decisión posterior que exige revisión de Shopify.
- **Shopify limita `read_orders` a los últimos 60 días**; ver pedidos más antiguos exige el permiso `read_all_orders`, que Shopify aprueba caso por caso. El asistente lo dirá claramente cuando un periodo supere 60 días.
- Shopify se consulta por **GraphQL** (la API REST es la heredada). Las consultas las escribe el servidor (texto fijo, solo `query`, nunca `mutation`); el modelo solo aporta valores validados. La versión de la API va en una constante fácil de actualizar (por verificar la vigente).
- VTEX: rutas de pedidos (`/api/oms/pvt/orders`), catálogo e inventario por verificar con una tienda real.
- No se soporta enviar claves por la URL en ninguna plataforma.

## 13. Datos y límites comunes
- Mismo cliente HTTP seguro para las tres (solo `https:443`, resolución de DNS validada y fijada, sin redirecciones, tamaño y tiempo máximos, lista cerrada de rutas por adaptador).
- Sin datos personales de compradores (ni nombre, ni correo, ni teléfono, ni dirección), igual en las tres; un adaptador no puede devolver esos campos porque el formato común no los tiene.
- Dinero siempre con moneda y como entero en la unidad menor o decimal exacto (nada de decimales de punto flotante); fechas en UTC y mostradas en hora de Bogotá.
- Máximo 20 filas por llamada; tope de llamadas por conversación.

## 14. Piezas a construir
1. `conectores/http-seguro.ts`: resolución y validación de direcciones, IP fijada, `GET`/`POST` limitado.
2. `conectores/tiendas/`: interfaz `AdaptadorTienda`, formato común, y los tres adaptadores.
3. `conectores/tiendas-herramientas.ts`: herramientas comunes (nivel 1).
4. Conexiones generalizadas (`ServicioConexiones` → conectores por tipo, varias tiendas), migración con la columna de origen y tipo.
5. Chat generalizado: el catálogo de herramientas se arma según lo conectado (Archie Send y/o tiendas) y las herramientas de tienda reciben el cliente de la tienda elegida.
6. Pantalla Conexiones: «Tiendas» (agregar, probar, quitar) con formularios por plataforma.
7. Guías de soporte por plataforma y la guía «Qué ve y qué no ve el asistente de tu tienda».

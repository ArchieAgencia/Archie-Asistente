# Conector de tiendas (fase 2): WooCommerce, Shopify y VTEX

Estado: construido y probado **solo con tiendas simuladas**. Falta validar contra una tienda real de cada plataforma. El diseño y las decisiones están en `docs/woocommerce-diseno.md`.

## Piezas
- `src/conectores/http-seguro.ts`: cliente HTTP anti-SSRF (única salida a Internet de los conectores de tiendas).
- `src/conectores/tiendas/tipos.ts`: formato común (sin datos personales de compradores), errores (`ErrorTienda`), dinero exacto como texto decimal, saneado de texto.
- `src/conectores/tiendas/base.ts`: `ClienteApi`, lista cerrada de rutas por adaptador, traducción de errores HTTP.
- `woocommerce.ts`, `shopify.ts`, `vtex.ts`: un adaptador por plataforma. `fabrica.ts` crea el adaptador desde las credenciales.
- `src/conectores/tiendas/herramientas.ts`: las nueve herramientas comunes (nivel 1, solo lectura).
- `src/chat/tiendas.ts`: `ServicioTiendas` (conectar, quitar, listar, resolutor para el chat).
- `src/chat/servicio.ts`: el catálogo del chat se arma según lo conectado; sin Archie Send, su cliente es un centinela que falla si algo lo usa.
- Migración `0013`: columna `origen` (no secreta), nombre único por organización entre tiendas (sin importar mayúsculas ni plataforma) y plataformas permitidas.
- API: `GET /api/panel/tiendas`, `POST /api/panel/tiendas`, `POST /api/panel/tiendas/quitar` (solo administradores cambian).

## Reglas de seguridad aplicadas
1. SSRF: solo `https` y puerto 443; solo nombres de dominio; se resuelve el DNS en cada petición y **todas** las direcciones deben ser públicas (IPv4, IPv6, mapeadas, NAT64, 6to4, Teredo…); la conexión va a la IP ya validada; certificado validado contra el nombre; sin redirecciones; 10 s y 1 MB por petición. Shopify y VTEX arman el dominio en el servidor desde un nombre validado; solo WooCommerce acepta un dominio libre.
2. Lista cerrada de rutas por adaptador y solo lectura (Shopify: GraphQL con consultas fijas que empiezan por `query`; el modelo solo aporta variables, y la búsqueda se sanea y se separan los operadores).
3. Sin datos de compradores: el formato común no tiene campos para ellos; WooCommerce además pide solo los campos usados (`_fields`, por verificar en tienda real).
4. Credenciales: cifradas (AES-256-GCM) con la organización atada al cifrado y el conector como contexto; nunca vuelven al navegador, al modelo, a la auditoría ni a los registros. Sin claves en la URL.
5. Conectar: solo administradores, límite de 10 intentos por 15 minutos por organización, prueba contra la tienda antes de guardar, tope de 10 tiendas y nombre único bajo un candado por organización, auditoría `conexion_tienda_guardada` / `conexion_tienda_quitada` (sin secretos).
6. Aislamiento: todo pasa por `conOrg` (seguridad por filas); una organización no ve ni resuelve tiendas de otra.
7. Texto de la tienda (nombres de productos, cupones) se sanea y llega al modelo marcado como datos de terceros, nunca como instrucciones.
8. Si la tienda rechaza las credenciales (401), la conexión se marca como fallida y Conexiones lo muestra.

## Límites y comportamiento conocido
- Resumen de ventas y más vendidos revisan hasta 250 pedidos; si hay más, `truncado` y un aviso en la respuesta.
- Shopify: con `read_orders` solo hay 60 días de pedidos. El adaptador comprueba `read_all_orders` y, si falta, responde `periodo_fuera_de_alcance` en vez de dar un total incompleto.
- VTEX: stock bajo, más vendidos (necesita líneas de pedido) y cupones no disponibles (`no_soportado`). Shopify: cupones no disponibles.
- Tiempo máximo de una herramienta: 20 s. Si se agota, la petición HTTP en curso termina sola dentro de su propio tope de 10 s (no se puede cancelar a mitad).
- Respuestas de más de 1 MB se rechazan (`respuesta_invalida`): una tienda con pedidos muy pesados podría necesitar una página más pequeña.
- Un sitio WooCommerce que redirija (http→https, o sin/con `www`) no se sigue: el administrador debe escribir la dirección final.
- Zona horaria: los periodos se calculan en hora de Bogotá (UTC-5 todo el año).

## Por verificar contra tiendas reales (no se pudo confirmar en la documentación)
- WooCommerce: `_fields` en `wc/v3/orders`, tope de `per_page`, `dates_are_gmt`, `data/currencies/current`.
- Shopify: versión de la API (`2026-07` en una constante), campos `totalInventory`, filtro `inventory_total`, `paymentGatewayNames`, `shippingLine`, cómo obtener el token en cuentas nuevas.
- VTEX: sufijo `.vtexcommercestable.com.br`, rutas de pedidos y catálogo, tope de `per_page`, rol mínimo de License Manager.

## Operación
- No hay variables de entorno nuevas. Aplicar la migración `0013` con `npm run migrar` (no requiere ejecutar `aprovisionar` de nuevo).
- Reversa: quitar el código; la migración `0013` solo agrega una columna, un índice y una restricción, sin tocar datos existentes. Para revertir la base: `DROP INDEX credenciales_tienda_nombre; ALTER TABLE credenciales_conector DROP CONSTRAINT credenciales_tienda_plataforma, DROP COLUMN origen;` (se pierde solo el dato de «origen»).
- Pruebas: `tests/tiendas.test.ts` (adaptadores y herramientas con tiendas simuladas), `tests/tiendas-servicio.test.ts` (conexiones, chat y base de datos), `tests/http-seguro.test.ts` (cliente seguro).

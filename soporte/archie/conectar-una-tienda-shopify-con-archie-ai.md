---
titulo: Cómo conectar una tienda Shopify con Archie AI
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: conexiones, shopify, tienda, token
fecha: 2026-10
estado: BORRADOR (la forma de obtener el token en tiendas nuevas de Shopify está por verificar; verificado solo con una tienda simulada)
---

# Cómo conectar una tienda Shopify con Archie AI

## Qué vas a lograr
Que Archie AI pueda **consultar** ventas, pedidos, productos y stock de tu tienda Shopify. Solo lee: **no cambia nada** y **no ve datos personales de tus compradores**.

## Antes de empezar
- Ser **administrador** de tu cuenta de Archie AI y tener acceso de propietario o con permiso de apps en Shopify.
- Necesitas un **token de acceso de la API de administración** con permisos de **solo lectura**: `read_orders`, `read_products` y `read_inventory`.
- Shopify cambió cómo se crean las apps: desde 2026 las «apps personalizadas» ya no se crean desde el administrador de la tienda en cuentas nuevas, y se hacen desde el **Dev Dashboard**. Las tiendas que ya tenían una app personalizada la siguen usando. *(Por verificar: el camino exacto para obtener el token puede variar según tu cuenta; pide ayuda a Archie si no lo encuentras.)*
- Límite de Shopify: con el permiso `read_orders` solo se pueden consultar los **pedidos de los últimos 60 días**. Para ver más atrás, la app necesita el permiso especial `read_all_orders`, que Shopify aprueba caso por caso.

## Pasos
1. Crea (o abre) en Shopify la app que usarás para Archie AI y dale **solo** los permisos de lectura indicados.
   `[Captura: Shopify, permisos de la app con read_orders, read_products y read_inventory]`
2. Instala la app en tu tienda y copia el **token de acceso de la API de administración** (suele empezar por `shpat_`). Solo se muestra una vez.
3. En **Archie AI**, entra a **Conexiones → Tiendas en línea → Conectar una tienda**.
4. Plataforma: **Shopify**. Ponle un nombre. En «Dirección de la tienda en Shopify» escribe `tu-tienda.myshopify.com` (la dirección interna, no tu dominio propio). Pega el token.
   `[Captura: formulario de Archie AI para conectar una tienda Shopify]`
5. Pulsa **Probar y conectar**.

## Resultado esperado
Aparece «Listo: Archie AI ya puede consultar…» y la tienda queda **Conectada**.

## Qué no está disponible en Shopify
Los cupones (descuentos) todavía no se consultan en Shopify. Si lo pides, Archie AI te lo dirá con claridad.

## Problemas frecuentes
- **«La tienda rechazó esas credenciales»:** el token es incorrecto, venció o la app se desinstaló. Genera uno nuevo.
- **«Las credenciales no tienen permiso de lectura»:** falta alguno de los permisos (`read_orders`, `read_products`, `read_inventory`).
- **«La tienda no permite consultar pedidos de ese periodo»:** pediste pedidos de hace más de 60 días y la app no tiene `read_all_orders`.
- **Dirección no válida:** usa solo `nombre.myshopify.com` o el nombre solo.

## Cuándo contactar a soporte
Si no logras obtener el token o el error continúa con un token nuevo. Envíanos el mensaje de la pantalla y la hora aproximada. **No nos envíes el token.**

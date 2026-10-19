---
titulo: Cómo conectar una tienda WooCommerce con Archie AI
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: conexiones, woocommerce, tienda, clave de api
fecha: 2026-10
estado: BORRADOR (verificado solo con una tienda simulada; falta probarlo con una tienda real)
---

# Cómo conectar una tienda WooCommerce con Archie AI

## Qué vas a lograr
Que Archie AI pueda **consultar** las ventas, pedidos, productos, stock y cupones de tu tienda WooCommerce. Solo lee: **no cambia nada** en tu tienda y **no ve nombres, correos, teléfonos ni direcciones de tus compradores**.

## Antes de empezar
- Ser **administrador** de tu cuenta de Archie AI.
- Tener acceso de administrador en el WordPress de la tienda.
- La tienda debe tener WooCommerce 3.5 o superior, abrirse por **https** y tener los **enlaces permanentes** activados con un formato distinto de «Simple» (Ajustes → Enlaces permanentes).
- Recomendado: un usuario de WordPress **solo para Archie AI**. La clave hereda los permisos de ese usuario; por eso conviene que sea uno con el rol más bajo que alcance para leer pedidos y productos (por ejemplo, «Gestor de la tienda» o un rol propio de solo lectura si tu sitio lo tiene). Si ese usuario se borra, la clave deja de funcionar.

## Pasos
1. En WordPress entra a **WooCommerce → Ajustes → Avanzado → API REST** y pulsa **Añadir clave**.
   `[Captura: WooCommerce, Ajustes → Avanzado → API REST]`
2. Descripción: «Archie AI». Usuario: el que preparaste para Archie AI. Permisos: **Solo lectura**.
3. Pulsa **Generar clave API**. WooCommerce muestra la **clave de consumidor** (empieza por `ck_`) y el **secreto de consumidor** (empieza por `cs_`). Solo se muestran una vez: cópialas ahora.
   `[Captura: pantalla con la clave y el secreto generados (tapa los valores)]`
4. En **Archie AI**, entra a **Conexiones → Tiendas en línea → Conectar una tienda**.
5. Plataforma: **WooCommerce**. Ponle un **nombre** a la tienda (con ese nombre la pedirás en el chat). En «Dirección del sitio» escribe solo el dominio (por ejemplo, `mitienda.com`). Pega la clave y el secreto.
   `[Captura: formulario de Archie AI para conectar una tienda WooCommerce]`
6. Pulsa **Probar y conectar**.

## Resultado esperado
Aparece «Listo: Archie AI ya puede consultar…» y la tienda queda en la lista con la etiqueta **Conectada**. Las credenciales se guardan cifradas y no vuelven a mostrarse.

## Cambiar o quitar la conexión
- Para cambiar las credenciales: repite los pasos 4 a 6 con el **mismo nombre** (reemplaza las anteriores).
- Para quitarla: **Desconectar** junto a la tienda y confirma. Después, en WooCommerce, borra también la clave (API REST → Revocar), así queda sin efecto en los dos lados.

## Problemas frecuentes
- **«La tienda rechazó esas credenciales»:** revisa que copiaste la clave y el secreto completos y sin espacios, y que el usuario de la clave siga existiendo. Si el servidor bloquea la cabecera de autorización, mira la guía «Qué hacer si no puedes conectar tu tienda».
- **«No encontramos la API en esa dirección»:** confirma que la dirección es la del sitio de la tienda y que los enlaces permanentes no están en «Simple».
- **«Esa dirección no es válida o no está permitida»:** solo se aceptan dominios con https, sin puerto, sin IP y sin rutas (`mitienda.com`, no `mitienda.com/tienda`).
- **Un nombre ya en uso:** cada tienda necesita un nombre distinto, aunque sea de otra plataforma.

## Cuándo contactar a soporte
Si sigues viendo el error después de generar una clave nueva. Envíanos el mensaje de la pantalla, el dominio de la tienda y la hora aproximada. **No nos envíes la clave ni el secreto.**

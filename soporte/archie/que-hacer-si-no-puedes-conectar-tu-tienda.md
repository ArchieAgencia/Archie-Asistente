---
titulo: Qué hacer si no puedes conectar tu tienda
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: conexiones, tienda, woocommerce, hostinger, siteground, solucion de problemas
fecha: 2026-10
estado: BORRADOR (los ajustes de Hostinger y SiteGround deben probarse en una cuenta real)
---

# Qué hacer si no puedes conectar tu tienda

## Qué vas a lograr
Resolver los errores más comunes al conectar una tienda, sobre todo en WooCommerce.

## Antes de empezar
Ten a la mano la dirección de la tienda y acceso de administrador al WordPress (o a tu hosting).

## Pasos
1. Lee el mensaje de error de Archie AI y búscalo en «Problemas frecuentes».
2. Abre en tu navegador `https://tudominio.com/wp-json/` (cambia `tudominio.com`). Debe mostrar un texto con muchas llaves. Si da error 404, ve al punto de los enlaces permanentes.
3. Si el texto aparece pero Archie AI dice «rechazó las credenciales» con una clave recién creada, tu servidor puede estar **quitando la cabecera de autorización**. Pídele a tu hosting (Hostinger, SiteGround u otro) que **permita la cabecera Authorization hacia PHP**, o haz que lo haga la persona que administra tu sitio. Es un ajuste del lado de la tienda.

## Problemas frecuentes
- **No encontramos la API (404):** en WordPress, Ajustes → Enlaces permanentes: elige cualquier opción distinta de «Simple» y guarda.
- **«La tienda rechazó esas credenciales» con claves correctas:** el servidor quita la cabecera de autorización (punto 3 de los pasos). No se soporta poner la clave en la dirección web, porque esas direcciones quedan en registros de servidores: no es seguro.
- **«No pudimos conectar con la tienda» o «tardó demasiado»:** un firewall o plugin de seguridad (Wordfence, Cloudflare u otro) puede estar bloqueando las peticiones. Pide que permitan la API REST de WooCommerce (`/wp-json/wc/`) para las peticiones con clave.
- **«Esa dirección no es válida o no está permitida»:** solo dominios con https, sin puerto, sin IP y sin rutas.
- **La tienda está en un servidor privado, una intranet o una dirección local:** no se puede conectar; Archie AI solo llega a tiendas públicas en Internet.
- **El sitio redirige a otra dirección (por ejemplo, de `mitienda.com` a `www.mitienda.com`):** escribe en Archie AI la dirección final (la que queda después de la redirección).

## Cuándo contactar a soporte
Si ya revisaste lo anterior. Envíanos el mensaje de la pantalla, el dominio de la tienda y la hora aproximada. **No nos envíes claves ni secretos.**

---
titulo: Cómo conectar una tienda VTEX con Archie AI
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: conexiones, vtex, tienda, app key
fecha: 2026-10
estado: BORRADOR (rutas y permisos de VTEX por verificar con una tienda real; verificado solo con una tienda simulada)
---

# Cómo conectar una tienda VTEX con Archie AI

## Qué vas a lograr
Que Archie AI pueda **consultar** ventas, pedidos y productos de tu tienda VTEX. Solo lee: **no cambia nada** y **no ve datos personales de tus compradores**.

## Antes de empezar
- Ser **administrador** de tu cuenta de Archie AI y tener acceso al **License Manager** de VTEX.
- Una **llave de aplicación** (App Key y App Token) con un rol que **solo pueda leer** pedidos y catálogo. Crea un rol propio con lo mínimo necesario en lugar de usar el de administrador. *(Por verificar: los nombres exactos de los recursos de lectura en tu cuenta.)*

## Pasos
1. En VTEX entra al **License Manager** y crea un **rol** de solo lectura para pedidos (OMS) y catálogo.
   `[Captura: VTEX, License Manager, creación del rol]`
2. Crea una **llave de aplicación** y asígnale ese rol. Copia el **App Key** y el **App Token**; el token se muestra una sola vez.
3. En **Archie AI**, entra a **Conexiones → Tiendas en línea → Conectar una tienda**.
4. Plataforma: **VTEX**. Ponle un nombre. En «Cuenta de VTEX» escribe el nombre de tu cuenta (por ejemplo, `micuenta`). Pega el App Key y el App Token.
   `[Captura: formulario de Archie AI para conectar una tienda VTEX]`
5. Pulsa **Probar y conectar**.

## Resultado esperado
Aparece «Listo: Archie AI ya puede consultar…» y la tienda queda **Conectada**.

## Qué no está disponible en VTEX
Por ahora, en VTEX no están disponibles las consultas de **stock bajo**, **más vendidos** y **cupones**. Archie AI te lo dirá con claridad si lo pides.

## Problemas frecuentes
- **«La tienda rechazó esas credenciales»:** App Key o App Token incorrectos, o la llave se desactivó.
- **«Las credenciales no tienen permiso de lectura»:** al rol le falta permiso sobre pedidos o catálogo.
- **«No pudimos conectar con la tienda»:** revisa que el nombre de la cuenta sea el correcto.

## Cuándo contactar a soporte
Si el error continúa con una llave nueva. Envíanos el mensaje de la pantalla y la hora aproximada. **No nos envíes el token.**

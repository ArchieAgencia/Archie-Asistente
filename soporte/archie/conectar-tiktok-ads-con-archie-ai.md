---
titulo: Cómo conectar tu cuenta de TikTok Ads con Archie AI
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: conexiones, tiktok, pauta, token
fecha: 2026-10
estado: BORRADOR (todo el detalle de TikTok está por verificar con una cuenta real; verificado solo con una plataforma simulada)
---

# Cómo conectar tu cuenta de TikTok Ads con Archie AI

## Qué vas a lograr
Que Archie AI pueda **consultar** gasto, alcance, clics y resultados de tus campañas de TikTok. Solo lee: **no crea ni cambia anuncios** ni presupuestos, y **no ve datos de personas**.

## Antes de empezar
- Ser **administrador** de tu cuenta de Archie AI.
- Acceso a **TikTok Ads Manager** y un **token de acceso de la API** con permiso de **solo lectura de reportes**. *(Por verificar: el camino exacto para obtener el token y sus permisos; TikTok pide una app de desarrollador aprobada.)*
- El **ID del anunciante** (número largo que aparece en TikTok Ads Manager).

## Pasos
1. Obtén el token de acceso con permiso de solo lectura de reportes y cópialo.
   `[Captura: TikTok for Business, token de acceso con permisos de lectura]`
2. En **Archie AI**, entra a **Conexiones → Pauta digital → Conectar una cuenta publicitaria**.
3. Plataforma: **TikTok Ads**. Ponle un nombre, escribe el ID del anunciante y pega el token.
   `[Captura: formulario de Archie AI para conectar TikTok Ads]`
4. Pulsa **Probar y conectar**.

## Resultado esperado
Aparece «Listo: Archie AI ya puede consultar…» y la cuenta queda **Conectada**.

## Qué cambia frente a Meta
En TikTok no se puede elegir qué cuenta como «resultado» (mensajes, compras, leads): se usa el resultado que TikTok asocia al objetivo de cada campaña.

## Problemas frecuentes
- **«La plataforma rechazó ese token»:** incorrecto o vencido. Genera uno nuevo.
- **«No tiene permiso de lectura»:** el token no incluye reportes o no tiene acceso a ese anunciante.
- **«No encontró esa cuenta»:** revisa el ID del anunciante.

## Cuándo contactar a soporte
Si no logras obtener el token o el error sigue con uno nuevo. Envíanos el mensaje de la pantalla. **No nos envíes el token.**

---
titulo: Cómo conectar tu cuenta de Meta Ads con Archie AI
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: conexiones, meta, facebook, instagram, pauta, token
fecha: 2026-10
estado: BORRADOR (los pasos dentro de Meta están por verificar; verificado solo con una plataforma simulada)
---

# Cómo conectar tu cuenta de Meta Ads con Archie AI

## Qué vas a lograr
Que Archie AI pueda **consultar** el gasto, el alcance, los clics y los resultados de tus campañas de Facebook e Instagram. Solo lee: **no crea ni cambia anuncios**, no toca presupuestos y **no ve datos de tu audiencia ni de personas**.

## Antes de empezar
- Ser **administrador** de tu cuenta de Archie AI.
- Tener acceso de administrador al **Business Manager** (Meta Business Suite) donde está la cuenta publicitaria.
- Un **token de acceso de un usuario del sistema** con el permiso **solo de lectura de anuncios (`ads_read`)** y la cuenta publicitaria asignada. *(Por verificar: Meta puede pedir que la app que genera el token tenga acceso aprobado; ese trámite lo hace Meta y puede tardar.)*
- El **número de la cuenta publicitaria** (lo ves en el Administrador de anuncios; empieza por `act_` o es solo el número).

## Pasos
1. En Meta Business Suite, crea un **usuario del sistema** solo para Archie AI y asígnale la cuenta publicitaria con acceso de **solo lectura**.
   `[Captura: Meta Business Suite, usuario del sistema con la cuenta publicitaria asignada]`
2. Genera el **token** del usuario del sistema con el permiso `ads_read` únicamente y cópialo (solo se muestra una vez).
3. En **Archie AI**, entra a **Conexiones → Pauta digital → Conectar una cuenta publicitaria**.
4. Plataforma: **Meta Ads**. Ponle un nombre fácil de decir («Casa Trenza»), escribe el número de la cuenta y pega el token.
   `[Captura: formulario de Archie AI para conectar Meta Ads]`
5. Pulsa **Probar y conectar**.

## Resultado esperado
Aparece «Listo: Archie AI ya puede consultar la pauta de…» y la cuenta queda **Conectada**.

## Problemas frecuentes
- **«La plataforma rechazó ese token»:** el token es incorrecto o venció. Genera uno nuevo.
- **«El token funciona, pero no tiene permiso…»:** falta `ads_read` o la cuenta publicitaria no está asignada al usuario del sistema.
- **«No encontró esa cuenta»:** revisa el número de la cuenta publicitaria.
- **Ya hay una conexión con ese nombre:** elige otro nombre; no importan las mayúsculas.

## Cuándo contactar a soporte
Si no logras generar el token o el error sigue con un token nuevo. Envíanos el mensaje de la pantalla y la hora aproximada. **No nos envíes el token.**

---
titulo: Cómo hacerle preguntas a Archie AI sobre tu tienda
categoria: Usar el asistente
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador y miembros
etiquetas: chat, tienda, ventas, pedidos, productos, stock
fecha: 2026-10
estado: BORRADOR (verificado solo con una tienda simulada)
---

# Cómo hacerle preguntas a Archie AI sobre tu tienda

## Qué vas a lograr
Consultar en lenguaje natural las ventas, pedidos, productos, stock y cupones de tus tiendas conectadas.

## Antes de empezar
Un administrador debe haber conectado al menos una tienda en **Conexiones** (mira la guía de tu plataforma: WooCommerce, Shopify o VTEX).

## Pasos
1. Entra a **Conversaciones** y escribe tu pregunta. Cada pregunta usa **1 consulta**.
2. Si tienes varias tiendas, di cuál por su nombre («¿Cómo va la tienda Zapatos esta semana?»). Si no lo dices, Archie AI te pregunta.
3. Pide el periodo con palabras comunes: hoy, ayer, últimos 7 días, últimos 30 días, este mes, el mes pasado, o fechas concretas. Las fechas se cuentan en hora de Bogotá.

## Ejemplos que funcionan
- «¿Cuánto vendimos este mes en la tienda principal?»
- «¿Cuáles son los 5 productos más vendidos en los últimos 30 días?»
- «Muéstrame los últimos pedidos cancelados.»
- «¿Qué productos tienen menos de 3 unidades?»
- «¿Qué cupones hay activos y cuánto se han usado?»

## Qué esperar
- Las ventas cuentan pedidos **pagados o completados** y se separan por moneda.
- Si hay más de 250 pedidos en el periodo, la respuesta es **parcial** (los más recientes) y Archie AI te lo dice.
- Algunas consultas no existen en todas las plataformas: cupones no están en Shopify; stock bajo, más vendidos y cupones no están en VTEX.
- Shopify solo entrega los pedidos de los últimos 60 días, salvo que la app tenga un permiso especial.

## Problemas frecuentes
- **«Indica cuál tienda»:** tienes varias conectadas; escribe el nombre exacto.
- **«Esa tienda no está conectada»:** el nombre no coincide con ninguna; revisa la lista en Conexiones.
- **«Las credenciales dejaron de funcionar»:** un administrador debe crear unas nuevas en la tienda y reemplazarlas en Conexiones.

## Cuándo contactar a soporte
Si una cifra no coincide con tu panel y el periodo es corto (menos de 250 pedidos). Envíanos la pregunta, el periodo y la cifra que esperabas.

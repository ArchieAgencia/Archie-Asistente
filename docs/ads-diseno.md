# Conector de pauta (Meta Ads y TikTok Ads) para Archie AI: diseño técnico (BORRADOR, fase 2)

Estado: diseño APROBADO por Karin (token pegado por el administrador, solo lectura y métricas, cuentas reales al final) y construido; ver `docs/pauta.md`. Las herramientas finales son `pauta_cuentas`, `pauta_resumen`, `pauta_ranking` y `pauta_comparar`. Clientify queda en pausa hasta nuevo aviso.

## 1. Objetivo
Que el asistente responda en lenguaje natural sobre la pauta de los clientes de Archie (gasto, resultados, campañas, conjuntos y anuncios) y arme reportes, con las mismas reglas de siempre: primero solo lectura, sin datos personales de personas, varias cuentas por organización, y escalera de seguridad si algún día se escribe (pausar o cambiar presupuestos solo con tarjeta de confirmación humana).

## 2. Lo verificado y lo pendiente
- Meta: los «insights» se leen en `/{cuenta-publicitaria|campaña|conjunto|anuncio}/insights`, con el permiso `ads_read` y una app de Meta. Parámetros documentados: `fields`, `breakdowns`, `date_preset` (sin indicar, ~30 días). Versión de la API vista en la documentación: v25.0 (se deja en una constante). **Por verificar:** `level`, `time_range`, `limit`/paginación, límites de peticiones, tipo de token a largo plazo para usuario del sistema, y revisión de la app por Meta para acceso estándar a cuentas de terceros.
- TikTok: no se pudo leer la documentación oficial desde aquí (la página no entrega el contenido). Se conoce, sin confirmar, el reporte integrado (`/report/integrated/get/`) con cabecera `Access-Token`. **Por verificar todo** con la documentación y una cuenta real. Este chat ya tiene un conector de TikTok for Business de uso propio de Karin; sirve para explorar, pero el producto necesita su propio acceso por cliente.
- Cumplimiento: usar la API de Meta con cuentas de clientes exige que la app tenga acceso aprobado (revisión de app y verificación del negocio). Es un trámite con tiempos de Meta, no de código.

## 3. Cómo se conecta cada cliente (decisión necesaria)
Opciones: (A) el administrador pega un token de lectura (usuario del sistema de Meta / token de TikTok) en Conexiones, como con las tiendas; (B) conexión con un clic por OAuth, con Archie como app de Meta y de TikTok. B es mejor para vender, pero exige apps aprobadas por las plataformas y guardar tokens que se renuevan. **Recomendación:** empezar con A (sirve a los clientes que Archie ya administra, donde Archie ya tiene acceso), y dejar B como segunda entrega.

## 4. Diseño (mismo patrón que las tiendas)
- Capa común `AdaptadorPauta` con dos adaptadores (Meta, TikTok) y un formato común: cuenta, campaña, conjunto, anuncio; métricas comunes (gasto, impresiones, alcance, clics, CTR, CPC, CPM, resultados/conversiones, costo por resultado) con dinero exacto y moneda.
- Mismo cliente HTTP seguro (host fijo armado en el servidor: `graph.facebook.com` y el de TikTok Business), solo GET, rutas en lista cerrada, token en cabecera (nunca en la URL; Meta acepta el token por cabecera `Authorization: Bearer`, por verificar), sin redirecciones, tope de tiempo y tamaño.
- Herramientas (nivel 1, solo lectura): `pauta_cuentas`, `pauta_resumen` (gasto y resultados de un periodo), `pauta_campanas` (ranking con filtros), `pauta_anuncios_top`, `pauta_comparar_periodos`. Periodos en hora de Bogotá y moneda de la cuenta.
- Sin datos personales: solo métricas agregadas. No se piden audiencias, leads ni datos de personas.
- Credenciales: cifradas por organización como las tiendas; varias cuentas con nombre único; auditoría y límite de intentos.
- Alertas útiles después (con el sistema de alertas existente): gasto del día por encima del tope, anuncio sin entrega, presupuesto del mes al 80 %.
- Valor para Archie: reportes de pauta en un mensaje (reemplaza armar el reporte a mano), comparación de periodos y detección de campañas con costo por resultado alto, para el reporte por correo que ya se manda a clientes.

## 5. Lo que NO incluye la primera entrega
Escribir en las cuentas (pausar, cambiar presupuesto, crear anuncios), audiencias, leads, y OAuth con un clic.

## 6. Pruebas
Con plataformas simuladas (rutas permitidas, métricas exactas, paginación, errores 400/401/403/429/5xx, token vencido, aislamiento por organización) y una prueba manual en navegador. **Pendiente que depende de Karin:** una cuenta publicitaria de prueba de cada plataforma (o una de un cliente, de solo lectura) con su token, y confirmar los detalles marcados «por verificar».

## 7. Decisiones que necesito de Karin
1. ¿Apruebas empezar con el token pegado por el administrador (opción A)?
2. ¿Primera entrega solo lectura y solo métricas agregadas?
3. ¿Qué cuentas reales puedo usar para la validación final (por ejemplo, la de Casa Trenza)?

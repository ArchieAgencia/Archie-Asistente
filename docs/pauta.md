# Conector de pauta (fase 2): Meta Ads y TikTok Ads

Estado: construido y probado **solo con plataformas simuladas**. Falta validar con una cuenta real de cada plataforma. Diseño aprobado en `docs/ads-diseno.md`. Solo lectura y solo métricas agregadas.

## Piezas
- `src/conectores/pauta/tipos.ts`: formato común (cuenta, campaña, conjunto, anuncio; métricas), `ErrorPauta`, dinero exacto, métricas derivadas (CTR, CPC, CPM, costo por resultado) calculadas aquí con decimales exactos.
- `meta.ts` (Graph API, `VERSION_META`), `tiktok.ts` (Business API), `fabrica.ts`.
- `herramientas.ts`: `pauta_cuentas`, `pauta_resumen`, `pauta_ranking`, `pauta_comparar`.
- `src/chat/pauta.ts`: `ServicioPauta` (conectar, quitar, listar, resolutor). Reutiliza `credenciales_conector` con conector `pauta_meta` / `pauta_tiktok`.
- Migración `0014`: nombre único por organización entre cuentas de pauta (sin importar mayúsculas ni plataforma) y plataformas permitidas.
- API: `GET /api/panel/pauta`, `POST /api/panel/pauta`, `POST /api/panel/pauta/quitar` (solo administradores cambian).
- Web: sección «Pauta digital» en Conexiones; el chat entiende `pauta_*`.

## Seguridad aplicada
1. Mismo cliente HTTP anti-SSRF de las tiendas. Hosts fijos armados en el servidor (`graph.facebook.com`, `business-api.tiktok.com`); el administrador solo aporta un número de cuenta validado por expresión regular y un token.
2. Solo GET (Meta) y rutas en lista cerrada; en Meta el token va en la cabecera `Authorization`, en TikTok en `Access-Token`; nunca en la URL. La paginación usa solo el cursor `after`, jamás la URL `next` entregada por la plataforma.
3. Sin datos de personas: se piden solo campos de métricas y el formato común no tiene dónde guardar audiencias, leads ni contactos (probado con respuestas que los incluyen).
4. Token cifrado con la organización y el conector atados al cifrado; nunca vuelve al navegador, al modelo, a la auditoría ni a los registros.
5. Conectar: solo administradores, 10 intentos por 15 minutos por organización, prueba contra la plataforma antes de guardar, máximo 20 cuentas y nombre único bajo candado por organización, auditoría `conexion_pauta_guardada` / `conexion_pauta_quitada` sin secretos.
6. Errores de la plataforma se traducen a códigos propios; el cuerpo de la respuesta nunca se muestra.
7. Si la plataforma rechaza el token, la conexión se marca como fallida y Conexiones lo muestra.
8. Los nombres de campañas llegan al modelo marcados como datos de terceros, no como instrucciones.

## Límites conocidos
- Topes de paginación: 5 páginas de 100; si hay más, `truncado`.
- Fechas en la zona horaria de la cuenta; atribución puede cambiar cifras por horas (aviso en cada respuesta).
- TikTok: el argumento `resultado` responde `no_soportado` (usa el resultado del objetivo de la campaña).
- Meta: el mapeo de resultados (mensajes, compras, leads, clics en enlace) usa tipos de acción de `actions`.

## Por verificar con cuentas reales
- Meta: versión vigente de la API, `time_range`/`level`/paginación, códigos de error (190, 102, 10, 200–299, 4, 17, 32, 613, 80000+), tipos de acción por resultado, token de usuario del sistema con `ads_read`, aprobación de la app y verificación del negocio (trámite de Meta).
- TikTok: todo el detalle: host, rutas `/open_api/v1.3/advertiser/info/` y `/report/integrated/get/`, cabecera, códigos (40100, 40102, 40104–40106, 403xx, 5xxxx), métricas disponibles y zona horaria.
- No se probó contra la API real de ninguna de las dos.

## Reversa
La migración `0014` solo agrega un índice único y una restricción. Para volver atrás: `DROP INDEX credenciales_pauta_nombre; ALTER TABLE credenciales_conector DROP CONSTRAINT credenciales_pauta_plataforma;` y borrar las filas con conector `pauta_%` (los tokens se pierden: se vuelven a pegar). Hacer copia de seguridad antes.

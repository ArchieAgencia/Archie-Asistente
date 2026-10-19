# Archie asistente

Asistente de IA de Archie Tech: producto independiente que opera las herramientas del cliente (Archie Send primero) por API.
Diseño completo: documento del proyecto Archie, "Archie: asistente de IA como producto independiente (diseño técnico v2)".

**Estado:** en desarrollo local, sin desplegar. Hecho: base multicliente con seguridad por filas, cifrado de secretos, autenticación (sesiones, 2FA, recuperación de acceso), chat de solo lectura, borradores reversibles, acciones con confirmación, instrucciones y alertas, widget embebible, conectores (Archie Send, pauta Meta y TikTok, tiendas, y Talk, Meet y Booking de solo lectura sobre un contrato propio: probados contra productos simulados, todavía NO contra los reales), panel del cliente (Vue 3) y consola del equipo de Archie (clientes, conexiones, uso y costos de IA, widget y claves, equipo y alertas, "Mi cuenta" como cliente). Los detalles y lo que NO se ha probado están en `CHANGELOG.md` y en `docs/`.

## Requisitos
Node 22 y PostgreSQL (el CI usa 17; en desarrollo también se ha probado con 16). Las pruebas de base de datos se saltan si no hay `ARCHIE_TEST_ADMIN_URL`).

## Comandos
```bash
npm ci            # instalar dependencias exactas
npm run typecheck # tipos
npm test          # pruebas (con ARCHIE_TEST_ADMIN_URL apuntando a un PostgreSQL de pruebas, corre también las de aislamiento)
npm run build     # compilar a dist/
npm start         # levantar (PORT por defecto 8800)
(cd web && npm ci && npm run build)   # interfaz web (Vue 3); la imagen la compila sola
```
Chequeo: `curl http://127.0.0.1:8800/salud`

## Cómo se despliega
1. Se sube a GitHub (rama propia + pull request a `main`).
2. El CI (`.github/workflows/ci.yml`) verifica y compila la imagen. En `main` la publica en `ghcr.io/archieagencia/archie-asistente` con la etiqueta del commit (`:<sha>`) y `:main`.
3. Coolify descarga esa imagen (no compila en el servidor) y la despliega **solo con aprobación de Karin**. Auto Deploy apagado.
4. Reversa: volver a desplegar la etiqueta del commit anterior.

La imagen de GHCR es privada: Coolify necesita una credencial de solo lectura de paquetes (`read:packages`), guardada en Coolify y Bitwarden. Nunca en el repositorio ni en el chat.

## Reglas
Cero secretos en el código; configuración por variables de entorno (ver `.env.example`, con valores falsos); licencia propietaria (ver `LICENSE`).

## Base de datos
- Tres roles: `archie_owner` (migra), `archie_app` (la aplicación: sin superusuario ni BYPASSRLS) y `archie_preauth` (sin login; dueño de las funciones de login y sesión). Se crean con `src/db/aprovisionar.ts`, una sola vez, con el administrador de PostgreSQL; las contraseñas llegan por variables de entorno.
- Migraciones numeradas en `migrations/` (`src/db/migrar.ts`): se aplican una vez, con candado, y se detecta si una ya aplicada fue modificada.
- Toda tabla con datos de cliente lleva `org_id` y seguridad por filas `FORCE`. La organización la fija el servidor con `conOrg()`; sin ella no se ve ni se escribe nada.
- Secretos de conectores: AES-256-GCM, con la organización y el propósito atados al cifrado, y claves maestras versionadas (`ARCHIE_CLAVES_MAESTRAS`, `ARCHIE_CLAVE_ACTIVA`) para poder rotarlas.

## Operación (comandos de operador)
Se ejecutan una vez o cuando haga falta, con variables de entorno temporales; **no** son parte del servicio. En la imagen están en `dist/cli/`.
- `npm run aprovisionar`: crea los roles y la base (administrador de PostgreSQL; ver `src/cli/aprovisionar.ts`).
- `npm run migrar`: aplica migraciones pendientes (dueño). Copia de seguridad antes en producción.
- `npm run crear-admin`: crea una organización y su primer administrador; muestra la contraseña inicial una sola vez.
- `npm run resetear-2fa`: desactiva el segundo factor de quien perdió el teléfono y cierra sus sesiones.
- `npm run crear-operador` y `npm run regenerar-2fa-operador`: crean una persona del equipo de Archie para la consola (segundo factor obligatorio) o regeneran su 2FA.
- `npm run marcar-cuenta-propia`: marca cuál organización es la de Archie Tech (variables `ARCHIE_OWNER_URL` y `ARCHIE_ORG_ID`); habilita "Mi cuenta" en la consola. Solo una organización puede ser la propia.
- `npm run renovar-mes` y `npm run limpiar`: renovación mensual de saldos y limpieza de datos vencidos.

Autenticación (rutas `/auth/*`): ver `docs/autenticacion.md`. Variables nuevas: `DATABASE_URL`, `ARCHIE_ORIGEN`, `ARCHIE_PROXY_SALTOS` (ver `.env.example`).

## Documentación
Técnica y de operación en `docs/` (autenticación, chat, widget, pauta, tiendas, contrato de la suite, consola del equipo, invitaciones, planes y consultas). Borradores de guías para la página de soporte de clientes en `soporte/`: se publican solo con el OK de Karin. Prueba local con Docker: `demo/LEEME.md`.

## Contribuir
Rama por tarea y pull request a `main`; commits en formato convencional (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Antes de abrir el pull request: `npm run typecheck`, `npm test` y compilar la interfaz. La plantilla del pull request trae la lista de verificación.

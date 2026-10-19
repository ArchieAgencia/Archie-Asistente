# Widget embebible de Archie AI (F4)

Estado: construido y probado **solo con herramientas anfitrionas simuladas**. No se probó dentro de un Archie Send real, ni con un sitio https real incrustando el iframe (ver «No verificado»).

## Para qué sirve
Que Archie AI aparezca dentro de otras herramientas de la suite (Archie Send, y las que vengan) con un botón flotante. Quien chatea es una persona que **ya es usuaria** de la organización en Archie AI (incluida con la contratación de la herramienta).

## Flujo
1. El administrador, en el panel (**Widget**), autoriza los **sitios** donde se podrá abrir el widget y crea una **clave de incrustación** por herramienta (se muestra una vez; en la base solo está su hash SHA-256).
2. Cuando una persona abre el asistente, el **servidor** de la herramienta llama `POST /api/widget/sesion` con `Authorization: Bearer aiw_…` y `{ "email" }`. Archie AI valida la clave, comprueba que la persona es usuaria activa de **esa** organización y devuelve `{ url, expiraEnSegundos: 120 }` con un enlace de **un solo uso** en el fragmento (`#c=…`, no viaja al servidor ni queda en registros).
3. La página carga `/widget.js` y llama `ArchieAI.montar({ obtenerUrl })`. Al abrir, el script verifica que la URL sea del mismo sitio que el script y la carga en un iframe con `sandbox`.
4. El iframe (`/widget/<org>`) quita el fragmento de la dirección, **canjea** el enlace (`POST /api/widget/canjear`) por una sesión de **2 horas** que vive solo en memoria del iframe (sin cookies de terceros, sin almacenamiento) y conversa por `/api/widget/*`.
5. Al vencer la sesión, el iframe avisa al padre (`postMessage`) y la próxima vez se pide un enlace nuevo.

## Qué puede y qué no puede el widget
- Sí: conversar (consultar Archie Send, tiendas y pauta; crear borradores si la autonomía lo permite). Cuenta como una consulta del plan, igual que en el panel. Las conversaciones son privadas de cada persona y son las mismas que ve en el panel.
- No: aprobar tarjetas de confirmación, deshacer acciones, cambiar conexiones, instrucciones, equipo ni seguridad. No existen esas rutas para la sesión del widget: **las acciones sensibles solo se aprueban en el panel con 2FA**.
- La sesión del widget no sirve en el panel, ni la cookie del panel sirve en el widget (credenciales distintas, tablas distintas).

## Rutas
- Panel (administrador con sesión completa): `GET /api/panel/widget`, `POST /api/panel/widget/origenes`, `…/origenes/quitar`, `…/claves`, `…/claves/quitar`.
- Servidor a servidor: `POST /api/widget/sesion`.
- Iframe: `POST /api/widget/canjear`; con sesión del widget: `POST /api/widget/chat` (SSE, mismo manejador y límites que el panel), `GET /api/widget/conversaciones[/:id]`, `POST /api/widget/conversaciones/:id/borrar`, `GET /api/widget/estado`, `POST /api/widget/salir`.
- Página `GET /widget/<org>` con `Content-Security-Policy: frame-ancestors <sitios autorizados>` (o `'none'` si no hay ninguno o el identificador no existe) y sin `X-Frame-Options`. El resto de la interfaz sigue con `frame-ancestors 'none'` y `DENY`.

## Seguridad aplicada
1. Clave de incrustación de 256 bits aleatorios, solo su hash en la base, la aplicación no puede leer hashes (permisos por columna). Máximo 5 vigentes. Revocar cierra de inmediato todas las sesiones abiertas con ella.
2. Enlace de un solo uso, 2 minutos, canje atómico (con dos peticiones a la vez gana una). La función de canje exige que la persona, la organización y la clave sigan vigentes.
3. Sesión del widget: 2 horas fijas (no se renueva), solo hash en la base, se resuelve en cada petición (si se desactiva a la persona, se da de baja la organización o se revoca la clave, deja de servir).
4. Clave y persona son siempre de la misma organización (clave foránea compuesta); seguridad por filas en las tres tablas. Rol nuevo `archie_widget` (sin herencia) dueño de cuatro funciones mínimas.
5. Orígenes: solo `https://nombre` (sin puerto, ruta, usuario, IP ni caracteres que permitan inyectar otra regla de política); validado en el servicio y en la base. Máximo 10.
6. Límites de frecuencia: pedir enlace por IP y por clave, canjear por IP; el chat comparte los límites del panel.
7. Errores iguales ante claves malas (no revelan nada). Auditoría de orígenes, claves y enlaces creados (sin secretos; solo el prefijo de la clave).
8. `widget.js`: solo carga URLs del mismo sitio que el script con la forma `/widget/<uuid>`; escucha mensajes solo del propio iframe y del mismo sitio.

## Riesgos y límites conocidos
- **Una clave filtrada permite abrir el widget como cualquier usuario de esa organización**, porque la herramienta anfitriona es quien afirma quién es la persona. Mitigaciones: la clave vive solo en el servidor, se ve su último uso, se revoca al instante, el widget no puede aprobar acciones sensibles y, desde esta versión, **toda sesión del widget rige como «miembro»** aunque la persona sea administradora (no ve tarjetas ni acciones de otras personas). Sigue pudiendo leer lo que esa persona vería al conversar. Mejora futura: limitar claves a una lista de correos.
- La sesión dura 2 horas aunque se cierre la herramienta anfitriona (hay `POST /api/widget/salir`, pero no se llama sola al cerrar).
- Limitador de frecuencia en memoria (una instancia).
- Con `allow-same-origin` en el `sandbox` del iframe: el iframe es de otro origen que la página anfitriona, así que no hay escape; el `sandbox` solo quita permisos (navegar la página superior, formularios fuera, etc.).

## No verificado
- No se probó dentro de un Archie Send real ni con un sitio https real enmarcando el iframe (en pruebas se comprueba la política `frame-ancestors` enviada, no el bloqueo del navegador).
- Accesibilidad con lector de pantalla y revisión humana de seguridad (sesiones, políticas de base).

## Operación y reversa
- Aplicar migración `0015`; **ejecutar `aprovisionar` de nuevo** (crea el rol `archie_widget`; es idempotente). `npm run limpiar` borra sesiones de widget vencidas hace más de 1 día.
- Reversa: `DROP FUNCTION widget_clave_resolver(bytea), widget_origenes_org(uuid), widget_canjear(bytea,bytea,integer), widget_resolver(bytea); DROP TABLE sesiones_widget, incrustacion_claves, incrustacion_origenes;` (las herramientas anfitrionas dejan de abrir el widget; el panel no se afecta). Copia de seguridad antes.

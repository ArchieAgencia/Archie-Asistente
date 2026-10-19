# Consola del equipo (F0, paso 6)

BORRADOR hasta revisión humana. Es la parte más sensible del producto: conviene una segunda revisión de un desarrollador de confianza antes de usarla con clientes reales.

## Principios
- **Operadores aparte.** Tabla `operadores`, sin organización. 2FA obligatorio desde que se crean (`totp_secreto NOT NULL`); no hay forma de entrar sin segundo factor.
- **Nadie entra como un cliente.** No existe esa ruta. El equipo ejecuta funciones acotadas de la base.
- **Cookie propia** `archie_op` (y tablas distintas): una sesión de cliente no abre la consola ni al revés.
- **Cada acción que escribe pide un código 2FA nuevo.** Un código sirve para una sola acción: la base consume la autorización dentro de la misma función; dos peticiones simultáneas con el mismo código solo ejecutan una. El paso TOTP solo se acepta si es mayor al último usado.
- **Bitácora visible al cliente** (`acciones_operador`, solo agregar): quién (por nombre), cuándo y qué. Más la auditoría interna.
- **Mínimo privilegio en la base.** Funciones `SECURITY DEFINER` con dueño `archie_consola` (NOLOGIN, sin heredar al rol dueño). `archie_app` no puede leer ni escribir `operadores`, `sesiones_operador` ni `acciones_operador` (solo leer la suya). `credenciales_conector` solo se cuenta (columnas `id`, `org_id`), nunca se leen secretos.

## Roles
| Acción | admin | soporte | finanzas |
|---|---|---|---|
| Leer (resumen, clientes, ficha, bitácora global) | sí | sí | sí |
| Crear cliente, suspender/reactivar/baja | sí | no | no |
| Reenviar la invitación del administrador del cliente | sí | sí | no |
| Saldo (recarga/ajuste), cambiar plan | sí | no | sí |
| Modo, autonomía, asistencia, restablecer 2FA de un cliente | sí | sí | no |

## Reglas de negocio
- Ajuste exige motivo (el cliente lo ve) y el saldo nunca queda negativo. Máximo 100.000 por movimiento.
- Suspender o dar de baja cierra todas las sesiones del cliente.
- Restablecer el 2FA de un cliente solo si la cuenta está en modo **gestionada** o con **asistencia** vigente (1–72 h). El cliente puede terminar la asistencia cuando quiera.
- Alta de cliente: **invita por correo** al administrador (enlace de un solo uso que vence en 7 días; ver `docs/invitaciones.md`). Ya no existen contraseñas temporales. Si el correo no sale, la cuenta queda creada y se reenvía desde la ficha (código nuevo; roles admin y soporte).

## Comandos del servidor (rol dueño)
`npm run crear-operador`, `npm run regenerar-2fa-operador`, `npm run renovar-mes`. La contraseña inicial y el secreto 2FA se muestran una sola vez: guardar en Bitwarden.

## Rutas
`/api/consola/auth/{login,2fa,logout}`, `GET /api/consola/{yo,resumen,clientes,clientes/:id,bitacora}`, `POST /api/consola/clientes` y `/clientes/:id/{plan,saldo,estado,modo,autonomia,asistencia,resetear-2fa}`.

## Riesgos y pendientes
- Quien robe la cookie del operador **y** tenga un código válido puede actuar: por eso cada escritura pide código nuevo y queda registrada.
- Límite de frecuencia en memoria (una sola instancia).
- El rol dueño hereda las políticas de `archie_preauth` (ya existía); `archie_consola` se concedió sin herencia. Revisar si se quita también para preauth.
- Falta: gestión de operadores desde la consola (hoy por comando), recuperación del 2FA del operador sin acceso al servidor, alertas por correo ante acciones sensibles.

## Consola ampliada (octubre 2026, migración 0017) — BORRADOR hasta revisión humana

### Mi cuenta · Archie Tech
- La cuenta propia se marca desde el servidor (rol dueño): `ARCHIE_OWNER_URL=... ARCHIE_ORG_ID=<uuid> npm run marcar-cuenta-propia`. Solo puede haber una; ni la aplicación ni la consola pueden cambiar esa marca.
- Botón «Mi cuenta · Archie Tech» en la consola (aparece solo si hay cuenta propia). La función `consola_abrir_mi_cuenta` exige una sesión de operador con segundo factor completo, crea (la primera vez) un usuario del equipo en esa cuenta con correo `equipo-<id>@equipo.archie.invalid` y una contraseña aleatoria que nadie conoce, y abre una sesión de cliente. El cuerpo de la petición no puede escoger otra organización.
- Rol en la cuenta propia: administración → administrador; soporte y finanzas → miembro. Cambiar el rol del operador lo sincroniza y cierra su sesión abierta.
- La sesión dura como máximo 4 h (y nunca más que la sesión del operador); hay una sola por persona; se cierra al salir de la consola o al desactivar a la persona. Marca `sesiones.puente_operador`: la aplicación no puede escribir esa columna (permiso de columnas), así que no se puede fabricar. Con 2FA de administradores obligatorio, la sesión puente no pide otro enrolamiento porque ya pasó el del operador.
- Queda en la bitácora de la cuenta propia (`mi_cuenta_abierta`).

### Conexiones, uso y widget por cliente
- La consola solo tiene permiso de columnas sobre `credenciales_conector` (sin `secreto`), `incrustacion_claves` (sin el hash), `llamadas_herramienta` (sin argumentos).
- Quitar una conexión: solo si `prueba_ok = false`; admin o soporte; código nuevo; bitácora del cliente (`conexion_quitada`). Revocar clave del widget: admin o soporte; cierra sus sesiones (`widget_clave_revocada`).
- Uso: `GET /api/consola/uso?mes=AAAA-MM` y `/clientes/:id/uso`. El costo sale de `uso_ia.costo_micro_usd`, calculado con las tarifas del servidor: es una estimación.

### Equipo de Archie (solo administración)
- Invitar crea el operador inactivo y una invitación de 48 h; el enlace solo viaja por correo (token en el fragmento). La persona elige su contraseña y escanea su propio secreto; hasta confirmar un código no se modifica nada y la cuenta sigue inactiva. Tope de 8 intentos por invitación; reenviar genera un enlace nuevo y mata el anterior.
- Desactivar cierra al instante sus sesiones (consola y Mi cuenta). No se puede desactivar ni cambiar el rol a uno mismo, ni dejar al equipo sin administración activa.
- Si alguien pierde el teléfono: `npm run regenerar-2fa-operador` en el servidor (a propósito no hay botón).
- Alertas: toda escritura de la consola avisa por correo a las administraciones activas (asunto «Consola de Archie AI: …»). Es un extra: si falla el correo, la acción se completa y queda igual en la bitácora.

### Limitaciones conocidas / no probado
- Probado con pruebas automáticas y en un navegador de pruebas contra datos de demostración. No probado: correo real (Resend), lectores de pantalla, segundo factor con una app real de celular, ni una revisión de seguridad humana (recomendada para `consola_abrir_mi_cuenta`, la activación de operadores y los permisos de columnas).
- Pendiente ya conocido: el rol dueño (`archie_owner`) hereda `archie_preauth` y por eso ve todas las organizaciones; cambiarlo rompe los comandos de operador (`resetear-2fa`, `renovar-mes`), que habría que rehacer con `conOrg`.
- Las alertas se envían aunque la persona que actúa sea la única administradora (le llega a ella misma).

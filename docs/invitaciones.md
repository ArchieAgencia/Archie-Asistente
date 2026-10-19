# Invitaciones por correo y equipo del cliente (F0, paso 5)

BORRADOR hasta revisión humana. Reemplaza la contraseña temporal del alta de cliente: **nadie ve ni comparte contraseñas**; cada persona crea la suya con un enlace de un solo uso.

## Flujos
1. **Alta de cliente (equipo de Archie, con código 2FA nuevo).** `consola_invitar_cliente` crea la organización, las consultas del plan inicial y una invitación para el administrador. El servidor envía el correo.
2. **Invitar al equipo (administrador del cliente).** Desde *Equipo y bitácora*: correo y rol (admin o miembro). Reenviar genera un enlace nuevo; revocar lo anula.
3. **Aceptar.** La persona abre el enlace, ve a qué organización y con qué rol la invitan, escribe nombre y contraseña (mín. 12 caracteres) y la cuenta se crea. No inicia sesión sola: entra después con su correo y contraseña y activa los dos pasos.
4. **Reenvío del equipo de Archie.** Si el administrador no recibió el correo: *Reenviar invitación* en la ficha (código nuevo). Queda en la bitácora que el cliente ve.

## Seguridad del enlace
- Token de 256 bits (`randomBytes(32)`, base64url). En la base solo se guarda su **SHA-256**; la aplicación ni siquiera puede leer esa columna (`GRANT SELECT` por columnas sin `token_hash`).
- El enlace es `…/invitacion#t=TOKEN`. El token va en el **fragmento**: no llega al servidor, ni a registros de acceso, ni al encabezado `Referer`. La página lo lee, lo borra de la barra de direcciones y lo envía por POST (nunca en la URL de la API).
- **Un solo uso y vence en 7 días.** Aceptar es atómico (`UPDATE … WHERE usada_en IS NULL … RETURNING` + crear usuario en la misma función): con cinco aceptaciones simultáneas gana una (probado). Si el correo ya tiene cuenta, todo se deshace y la invitación sigue pendiente.
- Reenviar o reinvitar **revoca** el enlace anterior. Una sola invitación pendiente por correo y organización (índice único parcial).
- Ver o aceptar una invitación inexistente, usada, revocada o vencida devuelve **el mismo error** (404 `invitacion_invalida`).
- Rutas públicas con límite de frecuencia por IP, entrada validada (el token debe tener exactamente el formato de 43 caracteres) y comprobación de origen en POST.
- Funciones previas a la sesión (`invitacion_ver`, `invitacion_aceptar`) con dueño `archie_invita` (NOLOGIN, sin herencia): solo puede leer invitaciones y datos mínimos de organización y crear usuarios.

## Reglas del equipo del cliente
- Solo **administradores activos** invitan, reenvían, revocan, cambian roles y desactivan. El servicio lo vuelve a comprobar **dentro de la transacción** (otra petición pudo desactivarlo justo antes).
- **Siempre queda al menos un administrador activo**: nadie se cambia a sí mismo (ni rol ni estado) y los cambios de equipo de una organización se serializan con un candado (dos administradores que se desactivan a la vez: gana uno, probado).
- Desactivar o cambiar de rol **cierra las sesiones** de esa persona. Reactivar la deja entrar de nuevo.
- Topes contra abuso (por organización): 10 invitaciones por hora, 25 pendientes, 25 personas.
- Todo queda en la auditoría de la cuenta: `invitacion_creada`, `invitacion_reenviada`, `invitacion_revocada`, `invitacion_aceptada`, `miembro_desactivado`, `miembro_reactivado`, `rol_cambiado`.
- Un correo pertenece a **una sola organización** (decisión de F0). Quien invita **no puede averiguar** si el correo existe en otra organización: la invitación se crea igual y el problema se le muestra a la persona invitada al abrir el enlace (`yaTieneCuenta`). El equipo de Archie sí ve ese conflicto al dar de alta (409) porque es personal de confianza.

## Correo
- `ARCHIE_CORREO=consola` (por defecto, solo desarrollo): **no envía nada**; escribe el correo en el registro del servidor y la respuesta de la API devuelve el enlace para poder probar. Está prohibido en producción (el servicio no arranca).
- `ARCHIE_CORREO=resend`: envío real por la API de Resend (una llamada HTTPS, sin librería). Exige `RESEND_API_KEY` y `ARCHIE_CORREO_REMITENTE`. La clave solo vive en variables de entorno (Coolify y Bitwarden).
- `ARCHIE_CORREO_SOLO_A` (recomendado en la etapa de pruebas): lista de direcciones (`a@x.com`) o dominios (`@x.com`) a los que se permite enviar; cualquier otro destinatario se descarta. Con Resend, `delivered@resend.dev` sirve para pruebas sin correos reales.
- Si el envío falla, la acción **no se cae**: se registra un error sin el correo ni el token, la respuesta dice `enviado: false` y se puede reenviar. El envío lleva clave de idempotencia para no duplicar.
- La plantilla escapa todo dato escrito por personas (nombre de empresa, nombre de quien invita) y quita saltos de línea del asunto. Maquetada con tablas y estilos en línea; texto alterno incluido.
- Pendiente de Karin: verificar un dominio remitente en Resend (SPF y DKIM) y definir el remitente.

## Pruebas
`tests/invitaciones.test.ts` (16, contra PostgreSQL real con roles sin privilegios) y `tests/correo.test.ts` (11). Cubren: aceptar y un solo uso, contraseña débil que no gasta el enlace, vencida y revocada, carrera de 5 aceptaciones, reenvío del equipo, fallo de correo, miembros sin permisos, reinvitar, correo ya existente en otra organización, aislamiento entre organizaciones (404), desactivar cierra sesiones, último administrador bajo concurrencia, tope por hora, permisos de columnas en la base y auditoría.

## No probado
Envío real por Resend (solo se probó con un proveedor simulado y con el correo de consola), cómo se ve el correo en Gmail, Outlook y celulares, y entrega a la bandeja principal (depende del dominio y su reputación).

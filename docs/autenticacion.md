# Autenticación (F0, paso 3): decisiones y límites

## Qué hace
- `POST /auth/login` (correo + contraseña). Si la persona tiene 2FA, responde `requiere_2fa` y entrega una **sesión pendiente** (5 min) que no abre nada.
- `POST /auth/2fa` (código de 6 dígitos). Cambia la sesión pendiente por una completa **con token nuevo** (la pendiente se borra).
- `POST /auth/logout`, `GET /auth/yo`, `POST /auth/password`, `POST /auth/2fa/iniciar` (pide contraseña), `POST /auth/2fa/confirmar`.
- No existe registro público: las organizaciones y su primer administrador los crea el operador (`npm run crear-admin`).

## Decisiones
- Cookie `archie_sid`: `HttpOnly`, `SameSite=Lax`, `Secure` en producción. El token es aleatorio de 256 bits; en la base solo se guarda su SHA-256.
- Sesión absoluta de 12 h. Sin vencimiento por inactividad (pendiente, decisión de producto).
- CSRF: `SameSite=Lax` + rechazo de peticiones con cabecera `Origin` distinta de `ARCHIE_ORIGEN`. El widget embebible (F4) usará otro mecanismo (sesiones cortas servidor a servidor), no esta cookie.
- Bloqueo: 5 fallos seguidos (contraseña, código 2FA o reconfirmación de contraseña) bloquean la cuenta 15 min. Tras vencer el bloqueo, el contador arranca de nuevo en 1; un acceso completo lo reinicia.
- **Reserva atómica del intento** (migración 0012, auditoría de oct. 2026): en el inicio de sesión del cliente y de la consola el intento se cuenta ANTES de evaluar la contraseña (`reservar_intento_login`, `consola_reservar_intento`: una sola sentencia que solo suma si la cuenta no está bloqueada). Así, con 100 peticiones en paralelo solo se evalúan 5. Si la contraseña es correcta y falta el segundo factor, la reserva se devuelve (`liberar_intento_login`). En el código 2FA y de recuperación del cliente, el fallo se cuenta dentro de la transacción con la fila del usuario bloqueada; en el 2FA de la consola se reserva antes de verificar el código.
- Toda función SECURITY DEFINER lleva `pg_temp` al final de su `search_path` (hay una prueba que lo exige).
- Nota (I3): `src/db/renovacion.ts` lee organizaciones gracias a que `archie_owner` hereda `archie_preauth`; si algún día se quita esa herencia hay que darle un GRANT explícito.
- Nota (H6): `app.org_id` es una variable de sesión que el rol de la app puede cambiar con SQL; el aislamiento depende de que **todo SQL sea parametrizado**. Regla de revisión: nunca concatenar texto en una consulta (candidato a regla de Semgrep en CI).
- Respuestas de error idénticas para correo inexistente, contraseña mala, cuenta bloqueada o inactiva. Se calcula un hash de relleno para igualar tiempos.
- Límite de frecuencia en memoria: 30 intentos por IP y 10 por correo cada 15 min. Válido para **una sola instancia**; con varias hay que moverlo a la base de datos.
- IP: se toma del último proxy de confianza (`ARCHIE_PROXY_SALTOS`); un cliente no puede falsearla con `X-Forwarded-For`.
- TOTP estándar (SHA-1, 6 dígitos, 30 s, ±1 intervalo). Cada código se acepta una sola vez (`totp_ultimo_paso`, bajo bloqueo de fila para que dos peticiones simultáneas no lo reutilicen). El secreto se guarda cifrado (AES-256-GCM) con la organización y el usuario atados al cifrado.
- Auditoría de solo agregar: `login_ok`, `login_fallido`, `login_bloqueado`, `login_clave_ok`, `mfa_fallido`, `logout`, `2fa_activado`, `password_cambiada`, etc. Guarda la IP; **no** guarda correos ni contraseñas.
- Cambiar la contraseña cierra todas las demás sesiones de esa persona.

## 2FA obligatorio para administradores
- Variable `ARCHIE_2FA_ADMIN` (`obligatorio` por defecto; `opcional` solo en desarrollo y pruebas: **en producción la configuración se niega a arrancar con `opcional`**).
- Un administrador sin 2FA puede iniciar sesión, pero el servidor responde `403 2fa_obligatoria` a todo salvo ver su perfil, activar el 2FA y cambiar la contraseña. La interfaz lo lleva a **Seguridad**. Si un miembro pasa a administrador, se le exige en su siguiente petición. Los miembros no están obligados.
- Si el equipo reinicia el 2FA de un administrador, esa persona vuelve a quedar en el estado «debe activarlo» al entrar.

## Recuperación de acceso (punto 6 del MVP)
**Códigos de recuperación del 2FA**
- Al activar el segundo factor se generan 10 códigos de 16 caracteres (80 bits, alfabeto sin 0/O/1/I/L). Se muestran **una sola vez**; en la base solo queda su hash (SHA-256 con prefijo propio). Pedir un juego nuevo (`POST /auth/2fa/codigos`, con la contraseña y sesión completa) invalida el anterior.
- Entran por `POST /auth/2fa` con `{ recuperacion }` en lugar de `{ codigo }`. Un solo `UPDATE ... WHERE usado_en IS NULL` decide quién gana si llegan dos peticiones con el mismo código. Los fallos cuentan para el bloqueo de la cuenta y para el límite por IP.
- Usar un código deja auditoría (`login_codigo_recuperacion`, con los que quedan) y envía un correo de aviso a la persona. La interfaz la lleva a Seguridad para generar un juego nuevo.
- Un trigger impide "des-usar" un código aunque alguien tenga acceso de aplicación.

**Recuperación de contraseña por correo**
- `POST /auth/recuperar { email }` responde siempre lo mismo y **no espera** al envío del correo (ni el contenido ni el tiempo revelan si el correo tiene cuenta). Límites: por IP, por correo y máximo 3 solicitudes por hora por persona; una solicitud nueva anula las anteriores.
- El enlace (`/restablecer#t=<token>`, token en el fragmento) sirve una vez y vence en 30 minutos. En la base solo está el hash. Lo aplica la función `recuperacion_aplicar` (rol propio `archie_recupera`, sin herencia): cambia la contraseña, levanta el bloqueo por intentos, **cierra todas las sesiones** de la persona y anula otros enlaces pendientes.
- **No salta el segundo factor**: tras restablecer, si la persona tiene 2FA, se lo piden igual. Un correo avisa del cambio.
- Cuentas del equipo de Archie (consola): sin recuperación por correo; se usan los comandos `resetear-2fa` / `regenerar-2fa-operador` y el restablecimiento por el operador.

**Limpieza (`npm run limpiar`, tarea diaria, rol dueño)** — **hay que programarla en el servidor** (cron o tarea de Coolify). Borra: conversaciones vencidas, sesiones (clientes y equipo) vencidas hace más de 1 día, enlaces de recuperación vencidos hace más de 1 día e invitaciones aceptadas o revocadas hace más de 90 días. Las invitaciones vencidas sin aceptar se conservan (la consola las usa para reenviar). Por las políticas de la base, el rol dueño solo puede borrar esas filas.

## Pendiente
1. ~~Obligar 2FA a los administradores~~ (hecho, oct. 2026). Queda por decidir si se obliga también a los miembros, y que el reinicio del 2FA por el equipo siga siendo una acción con registro.
2. Límites de frecuencia compartidos entre varias instancias (hoy en memoria de cada proceso).
3. Envío real de los correos de seguridad por Resend: probado solo con correo en memoria y consola.
4. Revisión humana de un desarrollador de confianza de esta parte antes de usarla con clientes reales.

## Riesgos conocidos y aceptados
- Quien conozca un correo puede bloquearlo 15 min con intentos fallidos (compromiso estándar contra la fuerza bruta). Si molesta, se cambia por bloqueo por IP + correo.
- La IP es un dato personal (Ley 1581): debe declararse en la política de tratamiento y tener plazo de retención. Pendiente de revisión legal.

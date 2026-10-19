# Probar Archie AI en tu computador

BORRADOR. Este entorno es solo de prueba: corre en tu computador, no envía correos y no toca nada de producción.

## Qué necesitas
Docker Desktop (o Docker Engine) funcionando, y la carpeta del proyecto.

## Pasos (una línea cada uno, desde la carpeta del proyecto)
1. `bash demo/preparar.sh` — construye todo y te muestra las claves de ejemplo. Guarda el secreto del segundo factor en tu aplicación de autenticación.
2. Abre http://localhost:8800 en el navegador.
3. Para apagar: `docker compose -f demo/docker-compose.yml down`
4. Para volver a encender: `docker compose -f demo/docker-compose.yml up -d`

## Recorrido sugerido
Cliente (`/entrar`): entrar, ver Inicio y Consultas, activar la verificación en dos pasos en Seguridad, cambiar la contraseña, ver "Equipo y bitácora" e invitar a una persona de tu equipo (Equipo y bitácora > Invitar a alguien).
Equipo (`/equipo-archie`): entrar con clave y código, ver clientes, abrir la ficha, mover saldo (pide código nuevo cada vez: espera a que cambie), cambiar plan, suspender y reactivar, activar el modo asistencia, crear un cliente nuevo (se invita a su administrador por correo). Luego vuelve a la cuenta del cliente y mira que la bitácora muestra cada acción con tu nombre.

## Invitaciones en la prueba local (no se envía ningún correo real)
En la prueba local el correo **no sale**: al invitar, la pantalla muestra un recuadro amarillo con el enlace de la invitación (solo en pruebas) y el mismo correo queda escrito en los registros (`docker compose -f demo/docker-compose.yml logs app`). Copia el enlace en una ventana privada del navegador, crea la contraseña y entra. El enlace sirve una sola vez. En producción el correo sale por Resend y esa caja amarilla no aparece.

## Qué todavía no existe (llega en las siguientes fases)
Chat con el asistente, conexión con Archie Send y recuperación de contraseña por correo.

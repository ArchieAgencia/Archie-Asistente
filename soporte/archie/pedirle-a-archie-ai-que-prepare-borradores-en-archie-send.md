---
titulo: Cómo pedirle a Archie AI que prepare listas, segmentos y borradores de campaña
categoria: Chat
producto: Archie AI
version: 0.0.2 (en desarrollo)
plan: Todos
publico: Cliente (administrador y miembro)
etiquetas: chat, borradores, listas, segmentos, campanas
fecha: 2026-10
estado: BORRADOR (probado en un navegador de pruebas con IA y Archie Send simulados; falta probar con Archie Send real y con la IA real)
---

# Cómo pedirle a Archie AI que prepare listas, segmentos y borradores de campaña

## Qué vas a lograr
Que Archie AI cree por ti, en tu Archie Send, una **lista vacía**, un **segmento** o una **campaña en borrador**, y poder deshacerlo si no te sirve.

## Antes de empezar
- Archie Send debe estar conectado en **Conexiones**. La clave de API conectada debe tener permiso de gestión de listas, segmentos y campañas en Archie Send (si solo es de lectura, Archie AI te avisará que no puede crear).
- Tu cuenta debe tener la autonomía «Leer y preparar borradores» (es la que viene por defecto). Si Archie AI te dice que solo puede consultar, escríbenos.
- Cada mensaje usa 1 consulta.

## Pasos
1. Entra a **Conversaciones** y escribe lo que necesitas, con los datos importantes. Por ejemplo: «Crea una lista llamada Clientes VIP con doble confirmación».
   `[Captura: conversación pidiendo crear una lista]`
2. Para una campaña, dile el nombre, el asunto, a qué lista va y qué debe decir. Archie AI puede pedirte algún dato que falte antes de crearla.
3. Cuando termine, verás el recuadro **Lo que preparé en esta conversación** con lo que creó.
   `[Captura: recuadro con la lista creada y el botón Deshacer]`
4. Revisa el resultado en tu Archie Send. Una campaña queda **en borrador: nunca se envía sola**. Tú la revisas y la envías desde Archie Send.

## Qué puedes pedir y qué no
- Sí: crear una lista vacía, guardar un segmento (por ejemplo, contactos cuyo correo contiene «@empresa.co») y crear un borrador de campaña.
- No: enviar o programar una campaña, pausarla, editarla, borrarla, ni agregar o quitar contactos. Para eso Archie AI te explicará cómo hacerlo en Archie Send.
- El contenido del correo debe ser HTML simple. Solo se permiten las variables de nombre `{{ .Subscriber.FirstName }}` y `{{ .Subscriber.Name }}`. No se aceptan scripts, formularios ni contenido incrustado.
- Hay un máximo de 5 cosas creadas por conversación y 20 por hora en toda tu cuenta.

## Resultado esperado
Lo creado aparece en tu Archie Send y en la pantalla **Acciones** de Archie AI.

## Problemas frecuentes
- **«La clave no tiene permiso para crear»:** en Archie Send, dale al usuario de API un rol con permiso de gestión y vuelve a conectarlo en Conexiones.
- **«Archie Send rechazó los datos»:** puede ser un nombre repetido, una lista que no existe o un remitente sin verificar. Archie AI te contará el motivo; corrige el dato y pídelo otra vez.
- **Archie AI dice que alcanzó el máximo:** espera una hora o abre una conversación nueva.

## Cuándo contactar a soporte
Si Archie AI crea algo distinto de lo que pediste o no puedes deshacerlo. Envíanos el nombre de lo creado y la hora aproximada (nunca claves ni contraseñas).

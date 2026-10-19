---
titulo: Cómo conectar Archie Send con Archie AI
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: conexiones, archie send, clave de api
fecha: 2026-10
estado: BORRADOR (verificado en un navegador de pruebas con un Archie Send simulado; falta probarlo con un Archie Send real)
---

# Cómo conectar Archie Send con Archie AI

## Qué vas a lograr
Que Archie AI pueda **consultar** tus listas, campañas, segmentos, créditos y errores de envío de Archie Send. En esta versión no envía, crea ni cambia nada.

## Antes de empezar
- Ser **administrador** de tu cuenta de Archie AI.
- Tener acceso de administración en tu Archie Send para crear un usuario de API.

## Pasos
1. En **Archie Send**, entra a **Usuarios** y crea un usuario de tipo **API** solo para Archie AI.
   `[Captura: Archie Send, pantalla Usuarios con la opción de crear usuario de tipo API]`
2. Asígnale un rol que solo pueda **leer**: campañas, listas, contactos, envío y rebotes.
3. Si Archie Send te lo permite, ponle fecha de vencimiento y un límite bajo de peticiones por minuto.
4. Copia el **usuario** y la **clave**. Archie Send solo muestra la clave una vez.
5. En **Archie AI**, entra a **Conexiones** → **Archie Send**.
   `[Captura: pantalla Conexiones con el formulario «Conectar con una clave de API»]`
6. Pega el usuario y la clave y pulsa **Probar y conectar**.

## Resultado esperado
Aparece el aviso verde «Listo: Archie AI ya puede consultar tu Archie Send» y la etiqueta **Conectado**. La clave se guarda cifrada y no vuelve a mostrarse.

## Cambiar o quitar la clave
- Para cambiarla: repite los pasos 5 y 6 (reemplaza la anterior).
- Para quitarla: **Desconectar** → confirma. Se borra la clave guardada.

## Problemas frecuentes
- **«Archie Send rechazó esa clave»:** revisa que el usuario y la clave estén completos y sin espacios, y que la clave no haya vencido.
- **«La clave funciona, pero no tiene permiso»:** el rol de ese usuario de API no puede leer listas. Edítalo en Archie Send.
- **«La clave dejó de funcionar»** (etiqueta en Conexiones): la clave venció o la borraron en Archie Send. Crea una nueva y reemplázala.
- **No ves el formulario:** solo los administradores pueden conectar herramientas.

## Cuándo contactar a soporte
Si sigues viendo un error después de crear una clave nueva. Envíanos el mensaje que te muestra la pantalla y la hora aproximada. **No nos envíes la clave.**

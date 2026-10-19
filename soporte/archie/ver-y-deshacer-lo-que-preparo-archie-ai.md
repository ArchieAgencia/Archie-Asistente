---
titulo: Cómo ver y deshacer lo que preparó Archie AI
categoria: Chat
producto: Archie AI
version: 0.0.2 (en desarrollo)
plan: Todos
publico: Cliente (administrador y miembro)
etiquetas: acciones, deshacer, borradores
fecha: 2026-10
estado: BORRADOR (probado en un navegador de pruebas con Archie Send simulado)
---

# Cómo ver y deshacer lo que preparó Archie AI

## Qué vas a lograr
Ver todo lo que Archie AI creó en tu Archie Send y borrarlo con un clic si no lo quieres.

## Antes de empezar
Nada especial. Los administradores ven todo lo de la cuenta; cada miembro ve solo lo que se creó en sus conversaciones.

## Pasos
1. En el menú, entra a **Acciones**. Verás qué se creó, el nombre, quién lo pidió, cuándo y el estado.
   `[Captura: pantalla Acciones con una lista creada]`
2. Pulsa **Deshacer** en la fila que quieras.
3. Confirma con **Sí, borrar «nombre»**. Archie AI lo borra de tu Archie Send.
   `[Captura: confirmación de Deshacer]`
4. La fila pasa a **Deshecha**. También puedes deshacer desde el recuadro «Lo que preparé en esta conversación» dentro del chat.

## Cuándo se puede deshacer
- **Lista:** solo si sigue **vacía** y con el mismo nombre. Si ya tiene contactos, no se borra desde aquí para que no pierdas nada; bórrala directamente en Archie Send si quieres.
- **Campaña:** solo si sigue **en borrador** y con el mismo nombre.
- **Segmento:** si sigue con el mismo nombre.
- Si ya lo borraste tú en Archie Send, la acción se marca como deshecha sin error.

## Resultado esperado
Lo borrado desaparece de Archie Send y la acción queda como «Deshecha» en el historial. El historial no se borra.

## Problemas frecuentes
- **«No se puede deshacer desde aquí»:** la lista ya tiene contactos, la campaña ya no está en borrador o cambió de nombre. Revísala en Archie Send.
- **«La clave no tiene permiso para borrar»:** el usuario de API conectado necesita un rol con permiso de gestión en Archie Send.

## Cuándo contactar a soporte
Si algo no se puede deshacer y crees que debería. Envíanos el nombre y la hora (nunca claves).

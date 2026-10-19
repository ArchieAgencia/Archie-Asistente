---
titulo: Cómo poner Archie AI dentro de tu herramienta con el widget
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: widget, incrustar, clave, sitios autorizados
fecha: 2026-10
estado: BORRADOR (verificado solo con una herramienta anfitriona simulada)
---

# Cómo poner Archie AI dentro de tu herramienta con el widget

## Qué vas a lograr
Que tu equipo use Archie AI desde un botón dentro de otra herramienta (por ejemplo, Archie Send), sin salir de ella.

## Antes de empezar
- Ser **administrador** de tu cuenta de Archie AI.
- Que cada persona que usará el widget **ya sea usuaria** de tu cuenta de Archie AI, con el mismo correo que usa en la herramienta.
- Alguien que pueda editar el **servidor** y la **página** de la herramienta donde se mostrará el botón (para Archie Send, lo hace Archie Tech).

## Pasos
1. En Archie AI entra a **Widget → Sitios autorizados** y escribe la dirección de la herramienta con https (por ejemplo `https://tuherramienta.com`, sin ruta ni puerto). Pulsa **Autorizar sitio**. Sin sitios autorizados, el widget no se puede abrir en ninguna parte.
   `[Captura: pantalla Widget con un sitio autorizado]`
2. En **Claves de incrustación**, escribe el nombre de la herramienta y pulsa **Crear clave**. **Cópiala en ese momento**: no se vuelve a mostrar. Guárdala en tu gestor de contraseñas.
3. Entrega la clave a quien configura el **servidor** de la herramienta. La clave va **solo en el servidor**, nunca en el código de la página ni en el navegador.
4. Esa persona sigue las instrucciones de la sección **Cómo instalarlo** de la misma pantalla (pedir el enlace desde el servidor y cargar `widget.js` en la página).
5. Abre la herramienta con tu usuario: aparece el botón **Archie AI**. Pulsa y haz una pregunta.
   `[Captura: botón y ventana del widget dentro de la herramienta]`

## Resultado esperado
La ventana abre el chat de Archie AI. Cada pregunta usa **1 consulta** de tu plan y la conversación queda también en tu panel.

## Qué puede y qué no puede hacer el widget
Puede consultar tus datos y preparar borradores. **No aprueba acciones sensibles** (enviar, programar, pausar, borrar): si el asistente propone una, te avisa y la apruebas **en el panel de Archie AI** con tu verificación en dos pasos.

## Si una clave se filtra
Entra a **Widget → Claves de incrustación → Revocar**. Se cierran de inmediato todas las sesiones que se abrieron con esa clave. Crea una nueva y cámbiala en el servidor de la herramienta.

## Problemas frecuentes
- **El botón no aparece o la ventana queda en blanco:** revisa que el sitio esté autorizado exactamente (mismo https y mismo nombre) y que el script se cargue.
- **«La sesión del asistente terminó o el enlace ya se usó»:** cierra y vuelve a abrir el asistente; cada enlace sirve una sola vez y por 2 minutos.
- **El servidor recibe «usuario_no_encontrado»:** esa persona no es usuaria de tu cuenta de Archie AI o usa otro correo. Invítala en **Equipo y bitácora**.
- **«Llegaste al máximo»:** hasta 10 sitios y 5 claves vigentes; quita o revoca alguno.

## Cuándo contactar a soporte
Si el widget no abre después de revisar lo anterior. Envíanos la herramienta, la hora y el mensaje que ves. **No nos envíes la clave.**

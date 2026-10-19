# Conectores de la suite: Archie Talk, Meet y Booking (fase 2, solo lectura)

Estado: construido y probado en local contra productos **simulados** que cumplen el [contrato v1](contrato-suite.md). No probado contra Talk, Meet ni Booking reales (Talk y Meet se construyen aparte; Booking parte de Calnode).

## Qué hace
El administrador conecta cada producto en **Conexiones → Suite Archie** con su dominio y una clave de solo lectura. El asistente gana herramientas **solo del producto conectado** (el modelo no ve las demás):

| Producto | Herramientas |
|---|---|
| Archie Talk | `talk_metricas`, `talk_conversaciones`, `talk_embudo`, `talk_tratos` |
| Archie Meet | `meet_reuniones`, `meet_uso` |
| Archie Booking | `booking_tipos`, `booking_disponibilidad`, `booking_reservas`, `booking_resumen` |

Las de métricas comparan con el periodo anterior de la misma duración. Máximo 20 filas por consulta.

## Seguridad y privacidad
- Formatos sin campos para personas: nombre, correo, teléfono y mensajes **no existen en el modelo de datos del conector**, así que no pueden llegar al asistente aunque el producto los envíe (hay prueba con datos personales de señuelo).
- Dirección: dominio público, https, puerto 443, sin IP ni nombres internos, mismo cliente HTTP seguro de tiendas y pauta (IP validada antes de conectar, sin redirecciones, tope de tiempo y de tamaño). Rutas en lista cerrada por producto; nada del modelo entra en la ruta.
- La clave se guarda cifrada con la organización atada al cifrado, no vuelve al navegador, ni al modelo, ni a los registros. Solo administradores conectan o desconectan; hay auditoría (`conexion_suite_guardada`, `conexion_suite_quitada`) sin secretos.
- Al conectar se comprueba que `info` diga `contrato: 1` y el producto correcto. Si una clave deja de funcionar durante el chat, la conexión se marca y la pantalla lo muestra.
- Una conexión por producto y organización (la base lo impide). Migración `0016`.
- Resultados al modelo marcados como datos de terceros (`fuente: suite`); los títulos se limpian de caracteres de control.
- Dentro del widget funciona igual (solo lectura).

## Lo que no hace
Escribir en ninguno de los productos: no responde conversaciones, no mueve tratos, no crea ni cancela reuniones ni reservas. Cuando se quiera, entra en una segunda entrega con la misma escalera (borradores reversibles y tarjeta de confirmación humana para lo sensible, p. ej. reservar o cancelar una cita).

## Pendiente
- Validar contra cada producto real y ajustar el contrato.
- Conexión sin pegar claves (autorización entre productos de la suite).
- Revisión legal (Ley 1581): títulos de tratos y reuniones pueden contener texto libre.

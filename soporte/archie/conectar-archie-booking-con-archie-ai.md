---
titulo: Cómo conectar Archie Booking con Archie AI
categoria: Conexiones
producto: Archie AI
version: 0.0.1 (en desarrollo)
plan: Todos
publico: Administrador
etiquetas: conexiones, archie booking, suite, clave
fecha: 2026-10
estado: BORRADOR (verificado solo con una herramienta simulada; los pasos dentro de Archie Booking dependen de que ya ofrezca el conector de Archie AI)
---

# Cómo conectar Archie Booking con Archie AI

## Qué vas a lograr
Que Archie AI pueda **consultar** tus tipos de cita, los espacios libres de tu agenda y tus reservas (con su estado e ingresos). Solo lee: **no responde, no reserva y no cambia nada** en Archie Booking, y **no ve mensajes ni datos de las personas**.

## Antes de empezar
- Ser **administrador** de tu cuenta de Archie AI y de Archie Booking.
- Que tu Archie Booking ya tenga activado el **conector de Archie AI** (si no ves la opción, escríbenos).
- La **dirección** de tu Archie Booking (por ejemplo `citas.tuempresa.com`), solo el dominio, con https.

## Pasos
1. En Archie Booking, crea una **clave de acceso solo para Archie AI** con permiso de **solo lectura** (y, si la opción existe, con vencimiento).
   `[Captura: pantalla de claves de acceso de Archie Booking]`
2. Copia la clave. Solo se muestra una vez.
3. En Archie AI entra a **Conexiones** y baja hasta **Suite Archie**.
4. Elige **Archie Booking**, escribe la dirección (sin rutas ni puertos) y pega la clave.
5. Pulsa **Probar y conectar**.
   `[Captura: formulario de Suite Archie con Archie Booking elegido]`

## Resultado esperado
Aparece «Archie Booking» como **Conectada**. Prueba preguntando en el chat. La clave se guarda cifrada y no vuelve a mostrarse.

## Problemas frecuentes
Mira «Qué hacer si no puedes conectar una herramienta de la suite».

## Cuándo contactar a soporte
Si tu Archie Booking no ofrece el conector de Archie AI o el error no se explica en la guía. No nos envíes la clave.

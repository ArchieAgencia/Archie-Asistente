-- Fase 2: conectores de la suite (Archie Talk, Archie Meet, Archie Booking) sobre el contrato de conector v1.
-- Reutiliza credenciales_conector: el conector se llama suite_<producto>, hay una sola conexión por producto y organización (nombre fijo «principal»).
-- La columna «origen» (no secreta) guarda el dominio de la herramienta.

ALTER TABLE credenciales_conector ADD CONSTRAINT credenciales_suite_producto
  CHECK (conector NOT LIKE 'suite\_%' OR (conector IN ('suite_talk', 'suite_meet', 'suite_booking') AND nombre = 'principal'));

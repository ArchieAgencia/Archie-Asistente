-- F3 (nivel 3): acciones sensibles con confirmación humana. El asistente SOLO propone; una persona aprueba una tarjeta
-- escrita por el servidor con datos reales, y se ejecuta exactamente lo aprobado, una sola vez.

CREATE TABLE propuestas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,                       -- quien pidió en la conversación
  conversacion_id uuid,
  herramienta text NOT NULL CHECK (length(herramienta) <= 60),
  accion text NOT NULL CHECK (accion IN ('enviar_ahora', 'programar', 'pausar', 'reanudar', 'cancelar', 'borrar')),
  objeto_id integer NOT NULL CHECK (objeto_id > 0),          -- id de la campaña en Archie Send
  objeto_nombre text NOT NULL CHECK (length(objeto_nombre) BETWEEN 1 AND 200),
  texto text NOT NULL CHECK (length(texto) BETWEEN 1 AND 4000),   -- lo que se le mostró a la persona (escrito por el servidor)
  huella text NOT NULL CHECK (huella ~ '^[0-9a-f]{64}$'),         -- resumen de la campaña tal como se mostró; si cambia, no se ejecuta
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'ejecutando', 'ejecutada', 'fallida', 'rechazada')),
  codigo text CHECK (length(codigo) <= 60),
  tool_use_id text CHECK (length(tool_use_id) <= 100),
  creada_en timestamptz NOT NULL DEFAULT now(),
  expira_en timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  resuelta_en timestamptz,
  resuelta_por uuid,
  FOREIGN KEY (usuario_id, org_id) REFERENCES usuarios (id, org_id) ON DELETE CASCADE,
  UNIQUE (org_id, tool_use_id)
);
CREATE INDEX propuestas_org_fecha ON propuestas (org_id, creada_en DESC);
CREATE INDEX propuestas_conversacion ON propuestas (conversacion_id);

ALTER TABLE propuestas ENABLE ROW LEVEL SECURITY;
ALTER TABLE propuestas FORCE ROW LEVEL SECURITY;
CREATE POLICY aislamiento ON propuestas
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT ON propuestas TO archie_app;
GRANT UPDATE (estado, codigo, resuelta_en, resuelta_por) ON propuestas TO archie_app;

-- Solo transiciones válidas: pendiente → ejecutando | rechazada; ejecutando → ejecutada | fallida. Nada vuelve atrás ni se reabre.
CREATE FUNCTION propuestas_transicion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado = OLD.estado THEN RETURN NEW; END IF;
  IF (OLD.estado = 'pendiente' AND NEW.estado IN ('ejecutando', 'rechazada'))
     OR (OLD.estado = 'ejecutando' AND NEW.estado IN ('ejecutada', 'fallida')) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'transicion_invalida' USING ERRCODE = '22023';
END $$;
CREATE TRIGGER propuestas_transicion BEFORE UPDATE ON propuestas FOR EACH ROW EXECUTE FUNCTION propuestas_transicion();

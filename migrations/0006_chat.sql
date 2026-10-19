-- F1: chat de solo lectura. Conversaciones (retención 30 días), mensajes, bitácora de herramientas y devolución de consultas.
-- Todo con seguridad por filas por organización. Las conversaciones son PRIVADAS de cada persona (usuario_id).

-- Estado de la prueba de conexión de cada conector (no es secreto).
ALTER TABLE credenciales_conector
  ADD COLUMN probada_en timestamptz,
  ADD COLUMN prueba_ok boolean;
-- La aplicación podía crear y borrar conexiones; ahora también marca la prueba.
-- (UPDATE ya estaba concedido en 0001.)

CREATE TABLE conversaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,
  titulo text NOT NULL DEFAULT 'Conversación nueva' CHECK (length(titulo) BETWEEN 1 AND 120),
  contactos_vistos integer NOT NULL DEFAULT 0 CHECK (contactos_vistos >= 0),  -- tope de 100 por conversación (lo aplica el servicio)
  en_curso_hasta timestamptz,                                                  -- candado: una respuesta a la vez por conversación
  creada_en timestamptz NOT NULL DEFAULT now(),
  actualizada_en timestamptz NOT NULL DEFAULT now(),
  vence_en timestamptz NOT NULL DEFAULT now() + interval '30 days',
  FOREIGN KEY (usuario_id, org_id) REFERENCES usuarios (id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id)
);
CREATE INDEX conversaciones_usuario ON conversaciones (org_id, usuario_id, actualizada_en DESC);
CREATE INDEX conversaciones_vence ON conversaciones (vence_en);

CREATE TABLE mensajes (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  conversacion_id uuid NOT NULL,
  rol text NOT NULL CHECK (rol IN ('user', 'assistant')),
  contenido jsonb NOT NULL,          -- bloques de contenido tal como los usa el modelo (texto, uso de herramienta, resultado)
  creado_en timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversacion_id, org_id) REFERENCES conversaciones (id, org_id) ON DELETE CASCADE
);
CREATE INDEX mensajes_conversacion ON mensajes (conversacion_id, id);

-- Registro de solo agregar: qué herramienta corrió, con qué argumentos y cómo terminó. Sin respuestas ni datos de contactos.
CREATE TABLE llamadas_herramienta (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  usuario_id uuid,
  conversacion_id uuid,
  herramienta text NOT NULL CHECK (length(herramienta) <= 60),
  argumentos jsonb NOT NULL DEFAULT '{}'::jsonb,
  ok boolean NOT NULL,
  codigo text CHECK (length(codigo) <= 60),   -- p. ej. http_403, tiempo_agotado, argumentos_invalidos
  duracion_ms integer CHECK (duracion_ms >= 0),
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llamadas_org_fecha ON llamadas_herramienta (org_id, creado_en);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversaciones', 'mensajes', 'llamadas_herramienta'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY aislamiento ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE ON conversaciones TO archie_app;
GRANT UPDATE (titulo, contactos_vistos, en_curso_hasta, actualizada_en) ON conversaciones TO archie_app;
GRANT SELECT, INSERT ON mensajes TO archie_app;                 -- los mensajes no se editan
GRANT SELECT, INSERT ON llamadas_herramienta TO archie_app;     -- solo agregar
GRANT USAGE ON SEQUENCE mensajes_id_seq, llamadas_herramienta_id_seq TO archie_app;

-- Limpieza: el dueño (tarea programada `npm run limpiar`) puede borrar SOLO conversaciones vencidas, de todas las organizaciones.
-- (Borrar con WHERE exige también poder LEER la fila, por eso hay una política de lectura igual de estrecha: solo vencidas.)
CREATE POLICY purga_ver ON conversaciones FOR SELECT TO archie_owner USING (vence_en < now());
CREATE POLICY purga ON conversaciones FOR DELETE TO archie_owner USING (vence_en < now());
GRANT SELECT, DELETE ON conversaciones TO archie_owner;
GRANT SELECT ON mensajes TO archie_owner;

-- Devolución de una consulta cuando el proveedor de IA falló antes de dar ninguna respuesta.
-- Estrecha: solo la organización fijada, solo un consumo propio de los últimos 15 minutos, una sola vez por consumo.
CREATE FUNCTION devolver_consulta(p_ref text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
  v_n integer;
BEGIN
  IF v_org IS NULL OR p_ref IS NULL OR length(p_ref) > 190 THEN RETURN false; END IF;
  SELECT -cantidad INTO v_n FROM consultas_libro
    WHERE org_id = v_org AND tipo = 'consumo' AND referencia = p_ref AND creado_en > now() - interval '15 minutes';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia, detalle)
    VALUES (v_org, 'ajuste', v_n, 'dev:' || p_ref, 'Devolución automática: el proveedor de IA no respondió')
    ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION devolver_consulta(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION devolver_consulta(text) TO archie_app, archie_owner;

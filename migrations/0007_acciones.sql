-- F2 (nivel 2): borradores reversibles. Cada cosa que Archie AI crea en una herramienta del cliente queda registrada aquí,
-- con lo necesario para poder deshacerla de forma segura.

CREATE TABLE acciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,
  conversacion_id uuid,
  herramienta text NOT NULL CHECK (length(herramienta) <= 60),
  nivel smallint NOT NULL DEFAULT 2 CHECK (nivel IN (2, 3)),
  argumentos jsonb NOT NULL DEFAULT '{}'::jsonb,
  objeto_tipo text NOT NULL CHECK (objeto_tipo IN ('lista', 'segmento', 'campana')),
  objeto_id integer NOT NULL CHECK (objeto_id > 0),
  objeto_nombre text NOT NULL CHECK (length(objeto_nombre) BETWEEN 1 AND 200),
  estado text NOT NULL DEFAULT 'hecha' CHECK (estado IN ('hecha', 'deshecha')),
  tool_use_id text CHECK (length(tool_use_id) <= 100),
  creada_en timestamptz NOT NULL DEFAULT now(),
  deshecha_en timestamptz,
  deshecha_por uuid,
  FOREIGN KEY (usuario_id, org_id) REFERENCES usuarios (id, org_id) ON DELETE CASCADE,
  UNIQUE (org_id, tool_use_id)
);
CREATE INDEX acciones_org_fecha ON acciones (org_id, creada_en DESC);
CREATE INDEX acciones_conversacion ON acciones (conversacion_id);

ALTER TABLE acciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE acciones FORCE ROW LEVEL SECURITY;
CREATE POLICY aislamiento ON acciones
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- La app agrega y marca como deshecha; nunca borra ni cambia lo que se hizo.
GRANT SELECT, INSERT ON acciones TO archie_app;
GRANT UPDATE (estado, deshecha_en, deshecha_por) ON acciones TO archie_app;

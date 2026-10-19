-- Pantalla «Instrucciones»: contexto del negocio que el equipo de cada cuenta le da a Archie AI (tono, servicios, políticas, horarios).
-- Una sola fila por organización. Es información, no permisos: no puede cambiar las reglas ni las herramientas del asistente.

CREATE TABLE instrucciones_org (
  org_id uuid PRIMARY KEY REFERENCES organizaciones (id) ON DELETE CASCADE,
  texto text NOT NULL CHECK (length(texto) <= 2000),
  actualizado_por uuid,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE instrucciones_org ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrucciones_org FORCE ROW LEVEL SECURITY;
CREATE POLICY aislamiento ON instrucciones_org
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT ON instrucciones_org TO archie_app;
GRANT UPDATE (texto, actualizado_por, actualizado_en) ON instrucciones_org TO archie_app;

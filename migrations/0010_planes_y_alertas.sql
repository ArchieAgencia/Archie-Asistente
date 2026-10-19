-- Planes para la administración (en vez de una lista fija en la interfaz) y registro de alertas de consumo (una por umbral y mes).

GRANT SELECT ON planes TO archie_consola;

CREATE FUNCTION consola_planes(p_token bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'cuotaMensual', cuota_mensual, 'topeDiario', tope_diario) ORDER BY cuota_mensual, id)
    FROM planes WHERE activo), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION consola_planes(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consola_planes(bytea) TO archie_app;
GRANT CREATE ON SCHEMA public TO archie_consola;
ALTER FUNCTION consola_planes(bytea) OWNER TO archie_consola;
REVOKE CREATE ON SCHEMA public FROM archie_consola;

-- Alertas de consumo ya avisadas: una fila por organización, mes (Bogotá, AAAA-MM) y umbral (80 o 100). Evita repetir el correo.
CREATE TABLE alertas_consumo (
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  mes text NOT NULL CHECK (mes ~ '^\d{4}-\d{2}$'),
  umbral smallint NOT NULL CHECK (umbral IN (80, 100)),
  creada_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, mes, umbral)
);
ALTER TABLE alertas_consumo ENABLE ROW LEVEL SECURITY;
ALTER TABLE alertas_consumo FORCE ROW LEVEL SECURITY;
CREATE POLICY aislamiento ON alertas_consumo
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON alertas_consumo TO archie_app;

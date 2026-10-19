-- Widget embebible: Archie AI dentro de otras herramientas (Archie Send, etc.).
-- Piezas: (1) orígenes (sitios) autorizados a incrustar el widget de cada organización, (2) claves de incrustación (servidor a servidor)
-- con las que la herramienta anfitriona pide una sesión corta para una persona que ya es usuaria de la organización, (3) esas sesiones.
-- Rol nuevo: archie_widget (NOLOGIN, sin herencia), creado por src/db/aprovisionar.ts (ejecútalo de nuevo al actualizar: es idempotente).

CREATE TABLE incrustacion_origenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  -- Solo https://nombre (sin puerto, ruta ni caracteres que permitan inyectar otra regla en la política de contenido).
  origen text NOT NULL CHECK (origen ~ '^https://[a-z0-9]([a-z0-9.-]{0,250}[a-z0-9])?$' AND position('..' in origen) = 0),
  creado_por uuid,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, origen)
);

CREATE TABLE incrustacion_claves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  nombre text NOT NULL CHECK (char_length(nombre) BETWEEN 1 AND 60),
  prefijo text NOT NULL CHECK (char_length(prefijo) BETWEEN 4 AND 12), -- primeros caracteres, solo para reconocerla en pantalla
  clave_hash bytea NOT NULL UNIQUE,                                     -- SHA-256 de 256 bits aleatorios: la clave nunca se guarda
  creada_por uuid,
  creada_en timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz,
  revocada_en timestamptz,
  UNIQUE (id, org_id)
);

CREATE TABLE sesiones_widget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,
  clave_id uuid NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('canje', 'sesion')), -- canje: un solo uso y dura minutos; sesion: la que usa el widget
  token_hash bytea NOT NULL UNIQUE,
  expira_en timestamptz NOT NULL,
  usada_en timestamptz,
  creada_en timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (usuario_id, org_id) REFERENCES usuarios (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (clave_id, org_id) REFERENCES incrustacion_claves (id, org_id) ON DELETE CASCADE -- la clave y la persona son siempre de la misma organización
);
CREATE INDEX sesiones_widget_expira ON sesiones_widget (expira_en);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incrustacion_origenes', 'incrustacion_claves', 'sesiones_widget'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY aislamiento ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- La aplicación administra orígenes y claves, y crea sesiones; nunca lee un hash ni puede "reabrir" un canje usado.
GRANT SELECT, INSERT, DELETE ON incrustacion_origenes TO archie_app;
GRANT SELECT (id, org_id, nombre, prefijo, creada_por, creada_en, ultimo_uso, revocada_en), INSERT ON incrustacion_claves TO archie_app;
GRANT UPDATE (ultimo_uso, revocada_en) ON incrustacion_claves TO archie_app;
GRANT SELECT (id, org_id, usuario_id, clave_id, tipo, expira_en, usada_en), INSERT, DELETE ON sesiones_widget TO archie_app;

-- Rol archie_widget: lo mínimo para identificar una clave, canjear un enlace y resolver una sesión del widget antes de conocer la organización.
GRANT USAGE ON SCHEMA public TO archie_widget;
GRANT SELECT ON incrustacion_claves, incrustacion_origenes TO archie_widget;
GRANT SELECT, INSERT ON sesiones_widget TO archie_widget;
GRANT UPDATE (usada_en) ON sesiones_widget TO archie_widget;
GRANT SELECT (id, org_id, rol, activo) ON usuarios TO archie_widget;
GRANT SELECT (id, activa) ON organizaciones TO archie_widget;
CREATE POLICY widget_claves ON incrustacion_claves FOR SELECT TO archie_widget USING (true);
CREATE POLICY widget_origenes ON incrustacion_origenes FOR SELECT TO archie_widget USING (true);
CREATE POLICY widget_sesiones ON sesiones_widget FOR ALL TO archie_widget USING (true) WITH CHECK (true);
CREATE POLICY widget_usuarios_ver ON usuarios FOR SELECT TO archie_widget USING (true);
CREATE POLICY widget_organizaciones_ver ON organizaciones FOR SELECT TO archie_widget USING (true);

-- ¿A qué organización pertenece esta clave? (clave vigente y organización activa)
CREATE FUNCTION widget_clave_resolver(p_hash bytea)
RETURNS TABLE (clave_id uuid, org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.id, c.org_id FROM incrustacion_claves c JOIN organizaciones o ON o.id = c.org_id
   WHERE c.clave_hash = p_hash AND c.revocada_en IS NULL AND o.activa
$$;

-- Sitios autorizados a incrustar el widget de una organización (para la política frame-ancestors de esa página).
CREATE FUNCTION widget_origenes_org(p_org uuid)
RETURNS TABLE (origen text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT g.origen FROM incrustacion_origenes g JOIN organizaciones o ON o.id = g.org_id
   WHERE g.org_id = p_org AND o.activa ORDER BY g.origen LIMIT 10
$$;

-- Canjea el enlace de un solo uso por una sesión de widget. Una sola petición gana; la clave y la persona deben seguir vigentes.
-- Error P0002 = el enlace no sirve (no existe, usado, vencido, persona o clave ya no vigentes): un mismo mensaje para todos los casos.
CREATE FUNCTION widget_canjear(p_canje_hash bytea, p_sesion_hash bytea, p_segundos integer)
RETURNS TABLE (r_usuario uuid, r_org uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF p_canje_hash IS NULL OR p_sesion_hash IS NULL OR p_segundos IS NULL OR p_segundos < 60 OR p_segundos > 28800 THEN
    RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023';
  END IF;
  UPDATE sesiones_widget SET usada_en = now()
   WHERE token_hash = p_canje_hash AND tipo = 'canje' AND usada_en IS NULL AND expira_en > now()
     AND EXISTS (SELECT 1 FROM usuarios u JOIN organizaciones o ON o.id = u.org_id
                  WHERE u.id = sesiones_widget.usuario_id AND u.org_id = sesiones_widget.org_id AND u.activo AND o.activa)
     AND EXISTS (SELECT 1 FROM incrustacion_claves c WHERE c.id = sesiones_widget.clave_id AND c.revocada_en IS NULL)
  RETURNING sesiones_widget.usuario_id AS uid, sesiones_widget.org_id AS oid, sesiones_widget.clave_id AS cid INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'canje_invalido' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO sesiones_widget (org_id, usuario_id, clave_id, tipo, token_hash, expira_en)
  VALUES (r.oid, r.uid, r.cid, 'sesion', p_sesion_hash, now() + make_interval(secs => p_segundos));
  RETURN QUERY SELECT r.uid, r.oid;
END $$;

-- Resuelve la sesión del widget. Deja de servir si la clave se revocó, la persona se desactivó o la organización se dio de baja.
CREATE FUNCTION widget_resolver(p_hash bytea)
RETURNS TABLE (sesion_id uuid, usuario_id uuid, org_id uuid, rol text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.id, s.usuario_id, s.org_id, u.rol
  FROM sesiones_widget s
  JOIN usuarios u ON u.id = s.usuario_id AND u.org_id = s.org_id
  JOIN organizaciones o ON o.id = s.org_id
  JOIN incrustacion_claves c ON c.id = s.clave_id
  WHERE s.token_hash = p_hash AND s.tipo = 'sesion' AND s.expira_en > now() AND u.activo AND o.activa AND c.revocada_en IS NULL
$$;

GRANT CREATE ON SCHEMA public TO archie_widget;
REVOKE ALL ON FUNCTION widget_clave_resolver(bytea), widget_origenes_org(uuid), widget_canjear(bytea, bytea, integer), widget_resolver(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION widget_clave_resolver(bytea), widget_origenes_org(uuid), widget_canjear(bytea, bytea, integer), widget_resolver(bytea) TO archie_app;
ALTER FUNCTION widget_clave_resolver(bytea) OWNER TO archie_widget;
ALTER FUNCTION widget_origenes_org(uuid) OWNER TO archie_widget;
ALTER FUNCTION widget_canjear(bytea, bytea, integer) OWNER TO archie_widget;
ALTER FUNCTION widget_resolver(bytea) OWNER TO archie_widget;
REVOKE CREATE ON SCHEMA public FROM archie_widget;

-- Limpieza (`npm run limpiar`): el dueño borra solo sesiones del widget vencidas hace más de 1 día.
GRANT SELECT, DELETE ON sesiones_widget TO archie_owner;
CREATE POLICY purga_ver ON sesiones_widget FOR SELECT TO archie_owner USING (expira_en < now() - interval '1 day');
CREATE POLICY purga ON sesiones_widget FOR DELETE TO archie_owner USING (expira_en < now() - interval '1 day');

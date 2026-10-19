-- Archie asistente: núcleo multicliente (organizaciones, usuarios, sesiones, credenciales de conectores, uso de IA, auditoría).
-- Se ejecuta con el rol dueño (archie_owner). Requiere los roles creados por src/db/aprovisionar.ts:
--   archie_owner   (dueño, migra)
--   archie_app     (aplicación: sin superusuario, sin BYPASSRLS)
--   archie_preauth (NOLOGIN: dueño de las funciones que operan ANTES de conocer la organización)

CREATE TABLE organizaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 200),
  activa boolean NOT NULL DEFAULT true,
  creada_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  email text NOT NULL CONSTRAINT email_en_minusculas CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  password_hash text NOT NULL,
  rol text NOT NULL CHECK (rol IN ('admin', 'miembro')),
  totp_secreto bytea,
  totp_clave_version integer,
  totp_activo boolean NOT NULL DEFAULT false,
  activo boolean NOT NULL DEFAULT true,
  intentos_fallidos integer NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
-- Un correo pertenece a una sola organización (decisión de F0; se puede ampliar).
CREATE UNIQUE INDEX usuarios_email_unico ON usuarios (email);

CREATE TABLE sesiones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  expira_en timestamptz NOT NULL,
  creada_en timestamptz NOT NULL DEFAULT now(),
  ip inet,
  agente text,
  -- La sesión y el usuario deben pertenecer a la misma organización.
  FOREIGN KEY (usuario_id, org_id) REFERENCES usuarios (id, org_id) ON DELETE CASCADE
);
CREATE INDEX sesiones_expira ON sesiones (expira_en);

CREATE TABLE credenciales_conector (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  conector text NOT NULL CHECK (conector ~ '^[a-z][a-z0-9_-]{1,40}$'),
  nombre text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 100),
  secreto bytea NOT NULL,            -- cifrado AES-256-GCM (nunca texto plano)
  clave_version integer NOT NULL,
  creada_por uuid,
  creada_en timestamptz NOT NULL DEFAULT now(),
  rotada_en timestamptz,
  UNIQUE (org_id, conector, nombre)
);

CREATE TABLE uso_ia (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  usuario_id uuid,
  modelo text NOT NULL,
  tokens_entrada integer NOT NULL CHECK (tokens_entrada >= 0),
  tokens_salida integer NOT NULL CHECK (tokens_salida >= 0),
  tokens_cache integer NOT NULL DEFAULT 0 CHECK (tokens_cache >= 0),
  costo_micro_usd bigint NOT NULL DEFAULT 0 CHECK (costo_micro_usd >= 0),
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uso_ia_org_fecha ON uso_ia (org_id, creado_en);

CREATE TABLE auditoria (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  usuario_id uuid,
  accion text NOT NULL,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_org_fecha ON auditoria (org_id, creado_en);

-- Seguridad por filas: el cliente (org) lo fija el servidor con set_config('app.org_id', ..., true).
-- Sin organización fijada, la comparación da NULL y no se ve ni se escribe nada (falla cerrado).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios', 'sesiones', 'credenciales_conector', 'uso_ia', 'auditoria'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY aislamiento ON %I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

ALTER TABLE organizaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizaciones FORCE ROW LEVEL SECURITY;
CREATE POLICY aislamiento ON organizaciones
  USING (id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Permisos mínimos del rol de la aplicación.
GRANT USAGE ON SCHEMA public TO archie_app, archie_preauth;
GRANT SELECT ON organizaciones TO archie_app;
GRANT SELECT, INSERT, UPDATE ON usuarios TO archie_app;
GRANT SELECT, INSERT, DELETE ON sesiones TO archie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON credenciales_conector TO archie_app;
GRANT SELECT, INSERT ON uso_ia TO archie_app;       -- sin UPDATE ni DELETE: registro de solo agregar
GRANT SELECT, INSERT ON auditoria TO archie_app;    -- sin UPDATE ni DELETE: registro de solo agregar
GRANT USAGE ON SEQUENCE uso_ia_id_seq, auditoria_id_seq TO archie_app;

-- Operaciones previas a conocer la organización (login y sesión): solo por funciones
-- con permisos acotados, de dueño archie_preauth. La aplicación NO puede leer usuarios sin organización.
GRANT SELECT ON usuarios, sesiones, organizaciones TO archie_preauth;
GRANT UPDATE (intentos_fallidos, bloqueado_hasta) ON usuarios TO archie_preauth;
CREATE POLICY preauth_usuarios ON usuarios FOR SELECT TO archie_preauth USING (true);
CREATE POLICY preauth_usuarios_cuenta ON usuarios FOR UPDATE TO archie_preauth USING (true) WITH CHECK (true);
CREATE POLICY preauth_sesiones ON sesiones FOR SELECT TO archie_preauth USING (true);
CREATE POLICY preauth_organizaciones ON organizaciones FOR SELECT TO archie_preauth USING (true);

CREATE FUNCTION buscar_usuario_para_login(p_email text)
RETURNS TABLE (id uuid, org_id uuid, password_hash text, rol text, totp_activo boolean, activo boolean, bloqueado_hasta timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.org_id, u.password_hash, u.rol, u.totp_activo, (u.activo AND o.activa), u.bloqueado_hasta
  FROM usuarios u JOIN organizaciones o ON o.id = u.org_id
  WHERE u.email = lower(p_email)
$$;

CREATE FUNCTION resolver_sesion(p_token_hash bytea)
RETURNS TABLE (sesion_id uuid, usuario_id uuid, org_id uuid, rol text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id, s.usuario_id, s.org_id, u.rol
  FROM sesiones s
  JOIN usuarios u ON u.id = s.usuario_id AND u.org_id = s.org_id
  JOIN organizaciones o ON o.id = s.org_id
  WHERE s.token_hash = p_token_hash AND s.expira_en > now() AND u.activo AND o.activa
$$;

CREATE FUNCTION registrar_login_fallido(p_usuario_id uuid, p_max integer, p_bloqueo_min integer)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE usuarios
  SET intentos_fallidos = intentos_fallidos + 1,
      bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= p_max
                             THEN now() + make_interval(mins => p_bloqueo_min) ELSE bloqueado_hasta END
  WHERE id = p_usuario_id
$$;

-- Cambiar el dueño exige que el nuevo dueño pueda crear en el esquema: se concede y se retira de inmediato.
GRANT CREATE ON SCHEMA public TO archie_preauth;
ALTER FUNCTION buscar_usuario_para_login(text) OWNER TO archie_preauth;
ALTER FUNCTION resolver_sesion(bytea) OWNER TO archie_preauth;
ALTER FUNCTION registrar_login_fallido(uuid, integer, integer) OWNER TO archie_preauth;
REVOKE CREATE ON SCHEMA public FROM archie_preauth;
REVOKE ALL ON FUNCTION buscar_usuario_para_login(text), resolver_sesion(bytea), registrar_login_fallido(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION buscar_usuario_para_login(text), resolver_sesion(bytea), registrar_login_fallido(uuid, integer, integer) TO archie_app;

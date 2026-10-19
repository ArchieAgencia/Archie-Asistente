-- Punto 6 del MVP: códigos de recuperación del segundo factor, recuperación de contraseña por correo y limpieza de datos vencidos.
-- Rol nuevo: archie_recupera (NOLOGIN, sin herencia), creado por src/db/aprovisionar.ts (ejecútalo de nuevo al actualizar: es idempotente).

-- ---------------------------------------------------------------------------------------------------------
-- 1. Códigos de recuperación del segundo factor: 10 por persona, de un solo uso. Solo se guarda su hash (SHA-256 de 80 bits aleatorios).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE codigos_recuperacion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,
  codigo_hash bytea NOT NULL UNIQUE,
  creado_en timestamptz NOT NULL DEFAULT now(),
  usado_en timestamptz,
  FOREIGN KEY (usuario_id, org_id) REFERENCES usuarios (id, org_id) ON DELETE CASCADE
);
CREATE INDEX codigos_recuperacion_usuario ON codigos_recuperacion (usuario_id);
ALTER TABLE codigos_recuperacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE codigos_recuperacion FORCE ROW LEVEL SECURITY;
CREATE POLICY aislamiento ON codigos_recuperacion
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- La aplicación crea, marca como usado y reemplaza (borra) el juego completo. No puede "des-usar" un código.
GRANT SELECT, INSERT, DELETE ON codigos_recuperacion TO archie_app;
GRANT UPDATE (usado_en) ON codigos_recuperacion TO archie_app;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Recuperación de contraseña: enlace de un solo uso (30 minutos). En la base solo está el hash del token.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE recuperaciones_password (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  creada_en timestamptz NOT NULL DEFAULT now(),
  expira_en timestamptz NOT NULL,
  usada_en timestamptz,
  FOREIGN KEY (usuario_id, org_id) REFERENCES usuarios (id, org_id) ON DELETE CASCADE
);
CREATE INDEX recuperaciones_password_usuario ON recuperaciones_password (usuario_id, creada_en DESC);
ALTER TABLE recuperaciones_password ENABLE ROW LEVEL SECURITY;
ALTER TABLE recuperaciones_password FORCE ROW LEVEL SECURITY;
CREATE POLICY aislamiento ON recuperaciones_password
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- La aplicación solicita (crea) y anula las solicitudes anteriores; no puede leer el hash ni usar un enlace.
GRANT INSERT ON recuperaciones_password TO archie_app;
GRANT SELECT (id, org_id, usuario_id, creada_en, expira_en, usada_en) ON recuperaciones_password TO archie_app;
GRANT UPDATE (usada_en) ON recuperaciones_password TO archie_app;

-- Rol archie_recupera: lo mínimo para aplicar un enlace de recuperación antes de que exista sesión.
GRANT USAGE ON SCHEMA public TO archie_recupera;
GRANT SELECT, UPDATE (usada_en) ON recuperaciones_password TO archie_recupera;
GRANT SELECT (id, org_id, email, activo) ON usuarios TO archie_recupera;
GRANT UPDATE (password_hash, intentos_fallidos, bloqueado_hasta) ON usuarios TO archie_recupera;
GRANT SELECT (id, activa) ON organizaciones TO archie_recupera;
GRANT SELECT (id, usuario_id), DELETE ON sesiones TO archie_recupera;
GRANT INSERT ON auditoria TO archie_recupera;
GRANT USAGE ON SEQUENCE auditoria_id_seq TO archie_recupera;
CREATE POLICY recupera_recuperaciones ON recuperaciones_password FOR ALL TO archie_recupera USING (true) WITH CHECK (true);
CREATE POLICY recupera_usuarios_ver ON usuarios FOR SELECT TO archie_recupera USING (true);
CREATE POLICY recupera_usuarios_cambiar ON usuarios FOR UPDATE TO archie_recupera USING (true) WITH CHECK (true);
CREATE POLICY recupera_organizaciones_ver ON organizaciones FOR SELECT TO archie_recupera USING (true);
CREATE POLICY recupera_sesiones ON sesiones FOR ALL TO archie_recupera USING (true) WITH CHECK (true);
CREATE POLICY recupera_auditoria_agregar ON auditoria FOR INSERT TO archie_recupera WITH CHECK (true);

-- Aplica el enlace: lo consume (una sola petición gana), cambia la contraseña, levanta el bloqueo por intentos, cierra TODAS las sesiones
-- de la persona y anula cualquier otro enlace pendiente. No salta el segundo factor: al entrar se pedirá igual.
-- Error P0002 = el enlace no sirve (no existe, usado, vencido, cuenta inactiva): el mismo mensaje para todos los casos.
CREATE FUNCTION recuperacion_aplicar(p_token_hash bytea, p_password_hash text)
RETURNS TABLE (usuario_id uuid, org_id uuid, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  IF p_token_hash IS NULL OR p_password_hash IS NULL THEN RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023'; END IF;
  UPDATE recuperaciones_password SET usada_en = now()
   WHERE token_hash = p_token_hash AND usada_en IS NULL AND expira_en > now()
     AND EXISTS (SELECT 1 FROM usuarios u JOIN organizaciones o ON o.id = u.org_id
                  WHERE u.id = recuperaciones_password.usuario_id AND u.org_id = recuperaciones_password.org_id AND u.activo AND o.activa)
  RETURNING recuperaciones_password.usuario_id AS uid, recuperaciones_password.org_id AS oid INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'enlace_invalido' USING ERRCODE = 'P0002'; END IF;
  UPDATE usuarios SET password_hash = p_password_hash, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = r.uid;
  DELETE FROM sesiones WHERE sesiones.usuario_id = r.uid;
  UPDATE recuperaciones_password SET usada_en = now() WHERE recuperaciones_password.usuario_id = r.uid AND usada_en IS NULL;
  INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES (r.oid, r.uid, 'password_restablecida', '{}'::jsonb);
  RETURN QUERY SELECT r.uid, r.oid, (SELECT u.email FROM usuarios u WHERE u.id = r.uid);
END $$;

GRANT CREATE ON SCHEMA public TO archie_recupera;
REVOKE ALL ON FUNCTION recuperacion_aplicar(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recuperacion_aplicar(bytea, text) TO archie_app;
ALTER FUNCTION recuperacion_aplicar(bytea, text) OWNER TO archie_recupera;
REVOKE CREATE ON SCHEMA public FROM archie_recupera;

-- Un código o enlace usado no se puede "des-usar": la columna solo pasa de vacía a llena, una vez (ni siquiera con acceso a la aplicación).
CREATE FUNCTION solo_marcar_usado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'codigos_recuperacion' THEN
    IF NEW.usado_en IS DISTINCT FROM OLD.usado_en AND (OLD.usado_en IS NOT NULL OR NEW.usado_en IS NULL) THEN RAISE EXCEPTION 'ya_usado' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.usada_en IS DISTINCT FROM OLD.usada_en AND (OLD.usada_en IS NOT NULL OR NEW.usada_en IS NULL) THEN
    RAISE EXCEPTION 'ya_usado' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER codigos_solo_marcar BEFORE UPDATE ON codigos_recuperacion FOR EACH ROW EXECUTE FUNCTION solo_marcar_usado();
CREATE TRIGGER recuperaciones_solo_marcar BEFORE UPDATE ON recuperaciones_password FOR EACH ROW EXECUTE FUNCTION solo_marcar_usado();

-- ---------------------------------------------------------------------------------------------------------
-- 3. Limpieza (tarea programada `npm run limpiar`): el dueño puede borrar SOLO filas ya sin uso, de todas las organizaciones.
--    - sesiones vencidas hace más de 1 día
--    - enlaces de recuperación vencidos hace más de 1 día (o ya usados)
--    - invitaciones ya aceptadas o revocadas hace más de 90 días (las vencidas sin aceptar se conservan: la consola las usa para reenviar)
-- ---------------------------------------------------------------------------------------------------------
GRANT SELECT, DELETE ON sesiones, recuperaciones_password, invitaciones TO archie_owner;
CREATE POLICY purga_ver ON sesiones FOR SELECT TO archie_owner USING (expira_en < now() - interval '1 day');
CREATE POLICY purga ON sesiones FOR DELETE TO archie_owner USING (expira_en < now() - interval '1 day');
CREATE POLICY purga_ver ON recuperaciones_password FOR SELECT TO archie_owner USING (expira_en < now() - interval '1 day');
CREATE POLICY purga ON recuperaciones_password FOR DELETE TO archie_owner USING (expira_en < now() - interval '1 day');
CREATE POLICY purga_ver ON invitaciones FOR SELECT TO archie_owner
  USING ((usada_en IS NOT NULL AND usada_en < now() - interval '90 days') OR (revocada_en IS NOT NULL AND revocada_en < now() - interval '90 days'));
CREATE POLICY purga ON invitaciones FOR DELETE TO archie_owner
  USING ((usada_en IS NOT NULL AND usada_en < now() - interval '90 days') OR (revocada_en IS NOT NULL AND revocada_en < now() - interval '90 days'));

-- Paso 5 de F0: invitaciones por correo. Reemplaza la contraseña temporal del alta de cliente.
--
-- Qué resuelve:
--   1. El equipo de Archie da de alta un cliente y el sistema invita a su administrador (nadie ve ni comparte contraseñas).
--   2. Un administrador del cliente invita a su propio equipo (admin o miembro).
--   3. Quien recibe la invitación crea su contraseña con un enlace de un solo uso que vence.
--
-- El token (256 bits) solo viaja en el enlace del correo. En la base se guarda su hash (SHA-256): quien lea la tabla no puede aceptar invitaciones.
-- Una invitación está "pendiente" si no se usó, no se revocó y no venció.
--
-- Rol nuevo: archie_invita (NOLOGIN), creado por src/db/aprovisionar.ts (ejecútalo de nuevo al actualizar: es idempotente).
-- Dueño de las funciones que operan ANTES de que exista sesión (ver y aceptar una invitación). Mismo método que archie_consola:
-- el dueño se lo asigna a las funciones pero no hereda sus permisos.

CREATE TABLE invitaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  email text NOT NULL CONSTRAINT invitacion_email_en_minusculas CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  rol text NOT NULL CHECK (rol IN ('admin', 'miembro')),
  token_hash bytea NOT NULL UNIQUE,
  nombre_sugerido text CHECK (length(nombre_sugerido) BETWEEN 1 AND 120),
  invitado_por_usuario uuid,           -- quién invitó (usuario del cliente) o...
  invitado_por_operador uuid,          -- ...(operador del equipo de Archie); uno de los dos
  creada_en timestamptz NOT NULL DEFAULT now(),
  expira_en timestamptz NOT NULL,
  usada_en timestamptz,
  revocada_en timestamptz,
  CONSTRAINT un_solo_origen CHECK (num_nonnulls(invitado_por_usuario, invitado_por_operador) = 1),
  CONSTRAINT no_usada_y_revocada CHECK (usada_en IS NULL OR revocada_en IS NULL)
);
-- Una sola invitación pendiente por correo y organización (las vencidas se revocan al reinvitar).
CREATE UNIQUE INDEX invitaciones_pendiente_unica ON invitaciones (org_id, email) WHERE usada_en IS NULL AND revocada_en IS NULL;
CREATE INDEX invitaciones_org_fecha ON invitaciones (org_id, creada_en DESC);

ALTER TABLE invitaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitaciones FORCE ROW LEVEL SECURITY;
CREATE POLICY aislamiento ON invitaciones
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Aplicación: puede crear, ver (sin el hash del token) y revocar. No puede marcar una invitación como usada ni cambiar su vencimiento.
GRANT INSERT ON invitaciones TO archie_app;
GRANT SELECT (id, org_id, email, rol, nombre_sugerido, invitado_por_usuario, invitado_por_operador, creada_en, expira_en, usada_en, revocada_en) ON invitaciones TO archie_app;
GRANT UPDATE (revocada_en) ON invitaciones TO archie_app;

-- Rol archie_invita: lo mínimo para ver y aceptar una invitación. Lo crea src/db/aprovisionar.ts (el dueño no puede crear roles).
GRANT USAGE ON SCHEMA public TO archie_invita;
GRANT SELECT, UPDATE (usada_en) ON invitaciones TO archie_invita;
GRANT SELECT (id, nombre, activa) ON organizaciones TO archie_invita;
GRANT SELECT (id, email) ON usuarios TO archie_invita;
GRANT INSERT ON usuarios TO archie_invita;
GRANT INSERT ON auditoria TO archie_invita;
GRANT USAGE ON SEQUENCE auditoria_id_seq TO archie_invita;
CREATE POLICY invita_invitaciones_ver ON invitaciones FOR SELECT TO archie_invita USING (true);
CREATE POLICY invita_invitaciones_usar ON invitaciones FOR UPDATE TO archie_invita USING (true) WITH CHECK (true);
CREATE POLICY invita_organizaciones_ver ON organizaciones FOR SELECT TO archie_invita USING (true);
CREATE POLICY invita_usuarios_ver ON usuarios FOR SELECT TO archie_invita USING (true);
CREATE POLICY invita_usuarios_crear ON usuarios FOR INSERT TO archie_invita WITH CHECK (true);
CREATE POLICY invita_auditoria_agregar ON auditoria FOR INSERT TO archie_invita WITH CHECK (true);

-- Rol de la consola: crea invitaciones al dar de alta un cliente y las reenvía; ve cuáles están pendientes (nunca el hash).
GRANT INSERT ON invitaciones TO archie_consola;
GRANT SELECT (id, org_id, email, rol, nombre_sugerido, creada_en, expira_en, usada_en, revocada_en, invitado_por_operador) ON invitaciones TO archie_consola;
GRANT UPDATE (revocada_en) ON invitaciones TO archie_consola;
CREATE POLICY consola_invitaciones_ver ON invitaciones FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_invitaciones_crear ON invitaciones FOR INSERT TO archie_consola WITH CHECK (true);
CREATE POLICY consola_invitaciones_revocar ON invitaciones FOR UPDATE TO archie_consola USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------------------------------------
-- Funciones previas a la sesión (dueño archie_invita). Errores: P0002 = la invitación no sirve (no existe, usada, revocada o vencida:
-- el mismo mensaje para todos los casos), 23505 = ese correo ya tiene cuenta.
-- ---------------------------------------------------------------------------------------------------------

CREATE FUNCTION invitacion_ver(p_token_hash bytea)
RETURNS TABLE (organizacion text, email text, rol text, nombre_sugerido text, expira_en timestamptz, ya_tiene_cuenta boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.nombre, i.email, i.rol, i.nombre_sugerido, i.expira_en, EXISTS (SELECT 1 FROM usuarios u WHERE u.email = i.email)
  FROM invitaciones i JOIN organizaciones o ON o.id = i.org_id
  WHERE i.token_hash = p_token_hash AND i.usada_en IS NULL AND i.revocada_en IS NULL AND i.expira_en > now() AND o.activa
$$;

-- Consume la invitación y crea el usuario en una sola operación: si el correo ya tiene cuenta (23505), todo se deshace y la invitación sigue pendiente.
CREATE FUNCTION invitacion_aceptar(p_token_hash bytea, p_nombre text, p_password_hash text)
RETURNS TABLE (usuario_id uuid, org_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE i record; v_usuario uuid := gen_random_uuid();
BEGIN
  IF p_nombre IS NULL OR length(trim(p_nombre)) NOT BETWEEN 1 AND 120 OR p_password_hash IS NULL THEN
    RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023';
  END IF;
  -- Una sola petición puede ganar: la segunda no encuentra la fila pendiente.
  UPDATE invitaciones SET usada_en = now()
   WHERE token_hash = p_token_hash AND usada_en IS NULL AND revocada_en IS NULL AND expira_en > now()
     AND EXISTS (SELECT 1 FROM organizaciones o WHERE o.id = invitaciones.org_id AND o.activa)
  RETURNING invitaciones.id, invitaciones.org_id, invitaciones.email, invitaciones.rol INTO i;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitacion_invalida' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO usuarios (id, org_id, email, password_hash, rol, nombre) VALUES (v_usuario, i.org_id, i.email, p_password_hash, i.rol, trim(p_nombre));
  INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES (i.org_id, v_usuario, 'invitacion_aceptada', jsonb_build_object('rol', i.rol));
  RETURN QUERY SELECT v_usuario, i.org_id;
END $$;

-- ---------------------------------------------------------------------------------------------------------
-- Consola: el alta de cliente invita al administrador (ya no hay contraseña temporal) y la invitación se puede reenviar.
-- ---------------------------------------------------------------------------------------------------------

DROP FUNCTION consola_crear_cliente(bytea, text, text, text, text, text);

CREATE FUNCTION consola_invitar_cliente(p_token bytea, p_nombre text, p_email text, p_token_invitacion bytea, p_nombre_admin text, p_plan text)
RETURNS TABLE (org_id uuid, expira_en timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record; v_org uuid := gen_random_uuid(); v_plan text := coalesce(p_plan, 'prueba'); v_email text := lower(trim(p_email)); v_expira timestamptz := now() + interval '7 days';
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin'], true);
  IF p_nombre IS NULL OR length(trim(p_nombre)) NOT BETWEEN 1 AND 200 OR v_email IS NULL OR p_token_invitacion IS NULL
     OR NOT EXISTS (SELECT 1 FROM planes WHERE id = v_plan AND activo) THEN
    RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023';
  END IF;
  -- Un correo pertenece a una sola organización: se avisa antes de crear nada.
  -- También si ya tiene una invitación pendiente en otra organización (el equipo de Archie es de confianza para ver esto; los clientes no).
  IF EXISTS (SELECT 1 FROM usuarios u WHERE u.email = v_email)
     OR EXISTS (SELECT 1 FROM invitaciones i WHERE i.email = v_email AND i.usada_en IS NULL AND i.revocada_en IS NULL AND i.expira_en > now()) THEN
    RAISE EXCEPTION 'ya_existe' USING ERRCODE = '23505';
  END IF;
  INSERT INTO organizaciones (id, nombre, plan_id) VALUES (v_org, trim(p_nombre), v_plan);
  INSERT INTO invitaciones (org_id, email, rol, token_hash, nombre_sugerido, invitado_por_operador, expira_en)
    VALUES (v_org, v_email, 'admin', p_token_invitacion, nullif(trim(p_nombre_admin), ''), v_op.op_id, v_expira);
  INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia, operador_id, detalle)
    SELECT v_org, 'plan', cuota_mensual, 'plan:' || to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM') || ':' || id, v_op.op_id, 'Consultas del plan inicial'
    FROM planes WHERE id = v_plan AND cuota_mensual > 0;
  INSERT INTO auditoria (org_id, usuario_id, accion) VALUES (v_org, NULL, 'organizacion_creada');
  PERFORM consola_registrar(v_org, v_op.op_id, v_op.op_nombre, 'cliente_creado', 'Creó la cuenta del cliente con el plan ' || v_plan || ' e invitó a ' || v_email);
  RETURN QUERY SELECT v_org, v_expira;
END $$;

-- Reenvía la invitación del administrador que aún no entró: revoca las pendientes y crea una nueva para el mismo correo.
CREATE FUNCTION consola_reenviar_invitacion(p_token bytea, p_org uuid, p_token_invitacion bytea)
RETURNS TABLE (email text, expira_en timestamptz, nombre_sugerido text, organizacion text, rol text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record; v_ant record; v_nombre text; v_expira timestamptz := now() + interval '7 days';
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin', 'soporte'], true);
  IF p_token_invitacion IS NULL THEN RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023'; END IF;
  SELECT o.nombre INTO v_nombre FROM organizaciones o WHERE o.id = p_org AND o.activa FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  -- La más reciente de la organización, en cualquier estado. Si ya se aceptó, no hay nada que reenviar.
  SELECT i.email AS correo, i.rol AS rol_i, i.nombre_sugerido AS sugerido, i.usada_en AS usada INTO v_ant
    FROM invitaciones i WHERE i.org_id = p_org ORDER BY i.creada_en DESC LIMIT 1;
  IF NOT FOUND OR v_ant.usada IS NOT NULL THEN RAISE EXCEPTION 'no_hay_invitacion' USING ERRCODE = 'P0002'; END IF;
  UPDATE invitaciones SET revocada_en = now() WHERE invitaciones.org_id = p_org AND invitaciones.email = v_ant.correo AND usada_en IS NULL AND revocada_en IS NULL;
  INSERT INTO invitaciones (org_id, email, rol, token_hash, nombre_sugerido, invitado_por_operador, expira_en)
    VALUES (p_org, v_ant.correo, v_ant.rol_i, p_token_invitacion, v_ant.sugerido, v_op.op_id, v_expira);
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'invitacion_reenviada', 'Reenvió la invitación a ' || v_ant.correo);
  RETURN QUERY SELECT v_ant.correo, v_expira, v_ant.sugerido, v_nombre, v_ant.rol_i;
END $$;

-- Cambio de dueño y permisos (primero los permisos, mientras el dueño sigue siendo archie_owner; luego el cambio).
GRANT CREATE ON SCHEMA public TO archie_invita, archie_consola;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['invitacion_ver(bytea)', 'invitacion_aceptar(bytea, text, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO archie_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO archie_invita', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['consola_invitar_cliente(bytea, text, text, bytea, text, text)', 'consola_reenviar_invitacion(bytea, uuid, bytea)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO archie_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO archie_consola', f);
  END LOOP;
END $$;
-- La ficha del cliente ahora también lista las invitaciones (el hash del token nunca sale de la base).
-- La función ya pertenece a archie_consola, así que se reemplaza actuando como ese rol (el dueño puede asumirlo; no lo hereda).
SET LOCAL ROLE archie_consola;
CREATE OR REPLACE FUNCTION consola_ficha(p_token bytea, p_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; v_inicio timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota';
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  SELECT jsonb_build_object(
    'id', o.id, 'nombre', o.nombre, 'estado', o.estado, 'modo', o.modo, 'autonomia', o.autonomia, 'creada', o.creada_en,
    'topeDiarioPropio', o.tope_diario_propio, 'asistenciaHasta', o.asistencia_hasta,
    'plan', jsonb_build_object('id', p.id, 'nombre', p.nombre, 'cuota', p.cuota_mensual, 'topeDiario', p.tope_diario),
    'saldo', (SELECT coalesce(sum(cantidad), 0) FROM consultas_libro WHERE org_id = o.id),
    'consumidoMes', (SELECT coalesce(-sum(cantidad), 0) FROM consultas_libro WHERE org_id = o.id AND tipo = 'consumo' AND creado_en >= v_inicio),
    'conexiones', (SELECT count(*) FROM credenciales_conector WHERE org_id = o.id),
    'equipo', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'nombre', u.nombre, 'rol', u.rol, 'totpActivo', u.totp_activo, 'activo', u.activo) ORDER BY u.creado_en), '[]'::jsonb)
               FROM usuarios u WHERE u.org_id = o.id),
    'invitaciones', (SELECT coalesce(jsonb_agg(jsonb_build_object('email', v.email, 'rol', v.rol, 'creada', v.creada_en, 'expira', v.expira_en,
                       'estado', CASE WHEN v.usada_en IS NOT NULL THEN 'aceptada' WHEN v.revocada_en IS NOT NULL THEN 'revocada' WHEN v.expira_en <= now() THEN 'vencida' ELSE 'pendiente' END)
                       ORDER BY v.creada_en DESC), '[]'::jsonb)
               FROM (SELECT id, email, rol, creada_en, expira_en, usada_en, revocada_en FROM invitaciones WHERE org_id = o.id ORDER BY creada_en DESC LIMIT 20) v),
    'bitacora', (SELECT coalesce(jsonb_agg(jsonb_build_object('cuando', b.creado_en, 'quien', b.operador_nombre, 'accion', b.accion, 'detalle', b.detalle) ORDER BY b.creado_en DESC, b.id DESC), '[]'::jsonb)
                 FROM (SELECT * FROM acciones_operador WHERE org_id = o.id ORDER BY creado_en DESC, id DESC LIMIT 50) b)
  ) INTO r FROM organizaciones o JOIN planes p ON p.id = o.plan_id WHERE o.id = p_org;
  IF r IS NULL THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  RETURN r;
END $$;
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM archie_invita, archie_consola;

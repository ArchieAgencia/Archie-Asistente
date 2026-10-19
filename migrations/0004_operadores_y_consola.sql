-- Paso 6 de F0: operadores (equipo de Archie Tech) y consola de administración.
-- Principios:
--  * Los operadores NO son usuarios de ninguna organización: tabla aparte, 2FA obligatorio desde la creación.
--  * Nadie "entra como" un cliente. El operador solo ejecuta funciones acotadas de la base (SECURITY DEFINER, dueño archie_consola).
--  * Toda acción que escribe exige un código 2FA nuevo (un código, una acción) y queda en la bitácora que el cliente también ve.
--  * La aplicación (archie_app) no puede leer ni escribir las tablas de operadores.
-- Requiere el rol archie_consola (NOLOGIN) creado por src/db/aprovisionar.ts.

ALTER TABLE organizaciones ADD COLUMN asistencia_hasta timestamptz;  -- modo asistencia: hasta cuándo el equipo puede ayudar en la cuenta

CREATE TABLE operadores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CONSTRAINT op_email_minusculas CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  nombre text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 120),
  rol text NOT NULL CHECK (rol IN ('admin', 'soporte', 'finanzas')),
  password_hash text NOT NULL,
  totp_secreto bytea NOT NULL,            -- obligatorio: no existe un operador sin segundo factor
  totp_clave_version integer NOT NULL,
  totp_ultimo_paso bigint,
  activo boolean NOT NULL DEFAULT true,
  intentos_fallidos integer NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sesiones_operador (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operador_id uuid NOT NULL REFERENCES operadores (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expira_en timestamptz NOT NULL,
  creada_en timestamptz NOT NULL DEFAULT now(),
  ip inet,
  agente text,
  mfa_ok boolean NOT NULL,
  reauth_hasta timestamptz               -- código nuevo verificado: vale para UNA acción y vence en segundos
);
CREATE INDEX sesiones_operador_expira ON sesiones_operador (expira_en);

-- Bitácora de acciones del equipo sobre un cliente. El cliente la ve completa. Solo se agrega.
CREATE TABLE acciones_operador (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  operador_id uuid REFERENCES operadores (id) ON DELETE SET NULL,
  operador_nombre text NOT NULL CHECK (length(operador_nombre) BETWEEN 1 AND 120),
  accion text NOT NULL CHECK (accion ~ '^[a-z][a-z0-9_]{1,60}$'),
  detalle text NOT NULL CHECK (length(detalle) <= 400),
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acciones_operador_org_fecha ON acciones_operador (org_id, creado_en);
ALTER TABLE acciones_operador ENABLE ROW LEVEL SECURITY;
ALTER TABLE acciones_operador FORCE ROW LEVEL SECURITY;
CREATE POLICY ver ON acciones_operador FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY dueno ON acciones_operador FOR ALL TO archie_owner
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY consola_ver ON acciones_operador FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_agregar ON acciones_operador FOR INSERT TO archie_consola WITH CHECK (true);
GRANT SELECT ON acciones_operador TO archie_app;
GRANT SELECT, INSERT ON acciones_operador TO archie_consola;
GRANT USAGE ON SEQUENCE acciones_operador_id_seq TO archie_consola;

-- Permisos mínimos del rol de la consola (dueño de las funciones de operador). Sin borrar clientes, sin tocar contraseñas.
GRANT USAGE ON SCHEMA public TO archie_consola;
GRANT SELECT ON planes TO archie_consola;
GRANT SELECT, INSERT ON organizaciones TO archie_consola;
GRANT UPDATE (estado, activa, plan_id, modo, autonomia, tope_diario_propio, asistencia_hasta) ON organizaciones TO archie_consola;
GRANT SELECT, INSERT ON usuarios TO archie_consola;
GRANT UPDATE (totp_activo, totp_secreto, totp_clave_version, totp_ultimo_paso, intentos_fallidos, bloqueado_hasta) ON usuarios TO archie_consola;
GRANT SELECT, DELETE ON sesiones TO archie_consola;
GRANT SELECT, INSERT ON consultas_libro TO archie_consola;
GRANT USAGE ON SEQUENCE consultas_libro_id_seq TO archie_consola;
GRANT SELECT, INSERT ON auditoria TO archie_consola;
GRANT USAGE ON SEQUENCE auditoria_id_seq TO archie_consola;
GRANT SELECT ON uso_ia TO archie_consola;
GRANT SELECT (id, org_id) ON credenciales_conector TO archie_consola;  -- solo cuenta cuántas conexiones hay: nunca lee los secretos
GRANT SELECT, UPDATE (intentos_fallidos, bloqueado_hasta, totp_ultimo_paso) ON operadores TO archie_consola;
GRANT SELECT, INSERT, DELETE, UPDATE (reauth_hasta) ON sesiones_operador TO archie_consola;

CREATE POLICY consola_organizaciones_ver ON organizaciones FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_organizaciones_crear ON organizaciones FOR INSERT TO archie_consola WITH CHECK (true);
CREATE POLICY consola_organizaciones_cambiar ON organizaciones FOR UPDATE TO archie_consola USING (true) WITH CHECK (true);
CREATE POLICY consola_usuarios_ver ON usuarios FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_usuarios_crear ON usuarios FOR INSERT TO archie_consola WITH CHECK (true);
CREATE POLICY consola_usuarios_cambiar ON usuarios FOR UPDATE TO archie_consola USING (true) WITH CHECK (true);
CREATE POLICY consola_sesiones_ver ON sesiones FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_sesiones_cerrar ON sesiones FOR DELETE TO archie_consola USING (true);
CREATE POLICY consola_libro_ver ON consultas_libro FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_libro_agregar ON consultas_libro FOR INSERT TO archie_consola WITH CHECK (true);
CREATE POLICY consola_auditoria_agregar ON auditoria FOR INSERT TO archie_consola WITH CHECK (true);
CREATE POLICY consola_auditoria_ver ON auditoria FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_uso_ver ON uso_ia FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_conectores_ver ON credenciales_conector FOR SELECT TO archie_consola USING (true);

-- ---------------------------------------------------------------------------------------------------------
-- Funciones. Todas: SECURITY DEFINER, dueño archie_consola, search_path fijo, sin permiso para PUBLIC.
-- Los errores usan códigos propios: 42501 (no autorizado / falta código), 22023 (dato inválido), P0002 (no existe).
-- ---------------------------------------------------------------------------------------------------------

-- Interna: valida la sesión del operador, su rol y (si escribe) consume el código nuevo. No se concede a archie_app.
CREATE FUNCTION consola_validar(p_token bytea, p_roles text[], p_escribe boolean)
RETURNS TABLE (op_id uuid, op_nombre text, op_rol text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record;
BEGIN
  SELECT so.id AS sid, so.reauth_hasta AS reauth, o.id AS oid, o.nombre AS onombre, o.rol AS orol INTO s
  FROM sesiones_operador so JOIN operadores o ON o.id = so.operador_id
  WHERE so.token_hash = p_token AND so.expira_en > now() AND so.mfa_ok AND o.activo
  FOR UPDATE OF so;
  IF NOT FOUND OR NOT (s.orol = ANY (p_roles)) THEN
    RAISE EXCEPTION 'no_autorizado' USING ERRCODE = '42501';
  END IF;
  IF p_escribe THEN
    IF s.reauth IS NULL OR s.reauth <= now() THEN
      RAISE EXCEPTION 'requiere_codigo' USING ERRCODE = '42501';
    END IF;
    UPDATE sesiones_operador SET reauth_hasta = NULL WHERE id = s.sid;
  END IF;
  RETURN QUERY SELECT s.oid, s.onombre, s.orol;
END $$;

-- Interna: registra una acción en la bitácora del cliente (visible para él) y en la auditoría.
CREATE FUNCTION consola_registrar(p_org uuid, p_op uuid, p_nombre text, p_accion text, p_detalle text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO acciones_operador (org_id, operador_id, operador_nombre, accion, detalle) VALUES (p_org, p_op, p_nombre, p_accion, left(p_detalle, 400));
  INSERT INTO auditoria (org_id, usuario_id, accion, detalle) VALUES (p_org, NULL, 'operador_' || p_accion, jsonb_build_object('operador', p_op));
$$;

-- --- Acceso del operador ---

CREATE FUNCTION consola_buscar_operador(p_email text)
RETURNS TABLE (id uuid, password_hash text, activo boolean, bloqueado_hasta timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.id, o.password_hash, o.activo, o.bloqueado_hasta FROM operadores o WHERE o.email = lower(p_email)
$$;

CREATE FUNCTION consola_registrar_fallido(p_op uuid, p_max integer, p_bloqueo_min integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE operadores SET intentos_fallidos = intentos_fallidos + 1,
    bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= p_max THEN now() + make_interval(mins => p_bloqueo_min) ELSE bloqueado_hasta END
  WHERE id = p_op
$$;

CREATE FUNCTION consola_crear_sesion_pendiente(p_op uuid, p_token_hash bytea, p_segundos integer, p_ip inet, p_agente text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO sesiones_operador (operador_id, token_hash, expira_en, ip, agente, mfa_ok)
  VALUES (p_op, p_token_hash, now() + make_interval(secs => p_segundos), p_ip, left(p_agente, 200), false)
$$;

CREATE FUNCTION consola_datos_2fa(p_token_hash bytea)
RETURNS TABLE (op_id uuid, secreto bytea, clave_version integer, ultimo_paso bigint, mfa_ok boolean, bloqueado_hasta timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.id, o.totp_secreto, o.totp_clave_version, o.totp_ultimo_paso, so.mfa_ok, o.bloqueado_hasta
  FROM sesiones_operador so JOIN operadores o ON o.id = so.operador_id
  WHERE so.token_hash = p_token_hash AND so.expira_en > now() AND o.activo
$$;

-- Cambia la sesión pendiente por una completa (token nuevo). El paso TOTP solo se acepta si es MAYOR que el último: un código no se reutiliza.
CREATE FUNCTION consola_completar_sesion(p_token_pendiente bytea, p_token_nuevo bytea, p_segundos integer, p_paso bigint, p_ip inet, p_agente text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op uuid; v_filas integer;
BEGIN
  SELECT so.operador_id INTO v_op FROM sesiones_operador so JOIN operadores o ON o.id = so.operador_id
  WHERE so.token_hash = p_token_pendiente AND so.expira_en > now() AND NOT so.mfa_ok AND o.activo
  FOR UPDATE OF so;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE operadores SET totp_ultimo_paso = p_paso, intentos_fallidos = 0, bloqueado_hasta = NULL
   WHERE id = v_op AND (totp_ultimo_paso IS NULL OR totp_ultimo_paso < p_paso);
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas = 0 THEN RETURN false; END IF;
  DELETE FROM sesiones_operador WHERE token_hash = p_token_pendiente;
  INSERT INTO sesiones_operador (operador_id, token_hash, expira_en, ip, agente, mfa_ok)
  VALUES (v_op, p_token_nuevo, now() + make_interval(secs => p_segundos), p_ip, left(p_agente, 200), true);
  RETURN true;
END $$;

CREATE FUNCTION consola_resolver_sesion(p_token_hash bytea)
RETURNS TABLE (sesion_id uuid, op_id uuid, nombre text, email text, rol text, mfa_ok boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT so.id, o.id, o.nombre, o.email, o.rol, so.mfa_ok
  FROM sesiones_operador so JOIN operadores o ON o.id = so.operador_id
  WHERE so.token_hash = p_token_hash AND so.expira_en > now() AND o.activo
$$;

CREATE FUNCTION consola_cerrar_sesion(p_token_hash bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM sesiones_operador WHERE token_hash = p_token_hash
$$;

-- Código nuevo para una acción sensible: acepta el paso solo si es mayor al último y deja la sesión "reautenticada" 90 segundos.
CREATE FUNCTION consola_reautenticar(p_token_hash bytea, p_paso bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op uuid; v_filas integer;
BEGIN
  SELECT so.operador_id INTO v_op FROM sesiones_operador so JOIN operadores o ON o.id = so.operador_id
  WHERE so.token_hash = p_token_hash AND so.expira_en > now() AND so.mfa_ok AND o.activo
  FOR UPDATE OF so;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE operadores SET totp_ultimo_paso = p_paso, intentos_fallidos = 0, bloqueado_hasta = NULL
   WHERE id = v_op AND (totp_ultimo_paso IS NULL OR totp_ultimo_paso < p_paso);
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas = 0 THEN RETURN false; END IF;
  UPDATE sesiones_operador SET reauth_hasta = now() + interval '90 seconds' WHERE token_hash = p_token_hash;
  RETURN true;
END $$;

-- --- Lecturas (cualquier rol de operador) ---

CREATE FUNCTION consola_resumen(p_token bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_inicio timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota';
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  RETURN jsonb_build_object(
    'activos', (SELECT count(*) FROM organizaciones WHERE estado = 'activo'),
    'prueba', (SELECT count(*) FROM organizaciones WHERE estado = 'prueba'),
    'suspendidos', (SELECT count(*) FROM organizaciones WHERE estado = 'suspendido'),
    'sinSaldo', (SELECT count(*) FROM organizaciones o WHERE o.estado IN ('prueba','activo')
                  AND coalesce((SELECT sum(cantidad) FROM consultas_libro l WHERE l.org_id = o.id), 0) <= 0),
    'consultasMes', (SELECT coalesce(-sum(cantidad), 0) FROM consultas_libro WHERE tipo = 'consumo' AND creado_en >= v_inicio)
  );
END $$;

CREATE FUNCTION consola_clientes(p_token bytea, p_busca text, p_filtro text, p_limite integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_inicio timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota';
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  IF p_filtro IS NOT NULL AND p_filtro NOT IN ('prueba','activo','suspendido','baja','sin_saldo') THEN
    RAISE EXCEPTION 'filtro_invalido' USING ERRCODE = '22023';
  END IF;
  RETURN coalesce((SELECT jsonb_agg(f ORDER BY f->>'nombre') FROM (
    SELECT jsonb_build_object(
      'id', o.id, 'nombre', o.nombre, 'estado', o.estado, 'plan', p.nombre, 'cuota', p.cuota_mensual,
      'saldo', s.saldo, 'sinSaldo', (o.estado IN ('prueba','activo') AND s.saldo <= 0),
      'consumidoMes', coalesce(c.mes, 0), 'modo', o.modo, 'ultimoUso', c.ultimo,
      'admin', (SELECT u.email FROM usuarios u WHERE u.org_id = o.id AND u.rol = 'admin' ORDER BY u.creado_en LIMIT 1)) AS f
    FROM organizaciones o JOIN planes p ON p.id = o.plan_id
    CROSS JOIN LATERAL (SELECT coalesce(sum(cantidad), 0)::bigint AS saldo FROM consultas_libro WHERE org_id = o.id) s
    LEFT JOIN LATERAL (SELECT -sum(cantidad) FILTER (WHERE creado_en >= v_inicio) AS mes, max(creado_en) AS ultimo
                       FROM consultas_libro WHERE org_id = o.id AND tipo = 'consumo') c ON true
    WHERE (p_busca IS NULL OR p_busca = '' OR o.nombre ILIKE '%' || replace(replace(replace(p_busca, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           OR EXISTS (SELECT 1 FROM usuarios u WHERE u.org_id = o.id AND u.email ILIKE '%' || replace(replace(replace(p_busca, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
      AND (p_filtro IS NULL OR p_filtro = '' OR (p_filtro = 'sin_saldo' AND o.estado IN ('prueba','activo') AND s.saldo <= 0)
           OR (p_filtro <> 'sin_saldo' AND o.estado = p_filtro))
    ORDER BY o.nombre LIMIT least(greatest(coalesce(p_limite, 100), 1), 500)) q), '[]'::jsonb);
END $$;

CREATE FUNCTION consola_ficha(p_token bytea, p_org uuid)
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
    'bitacora', (SELECT coalesce(jsonb_agg(jsonb_build_object('cuando', b.creado_en, 'quien', b.operador_nombre, 'accion', b.accion, 'detalle', b.detalle) ORDER BY b.creado_en DESC, b.id DESC), '[]'::jsonb)
                 FROM (SELECT * FROM acciones_operador WHERE org_id = o.id ORDER BY creado_en DESC, id DESC LIMIT 50) b)
  ) INTO r FROM organizaciones o JOIN planes p ON p.id = o.plan_id WHERE o.id = p_org;
  IF r IS NULL THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  RETURN r;
END $$;

CREATE FUNCTION consola_bitacora(p_token bytea, p_limite integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('cuando', b.creado_en, 'quien', b.operador_nombre, 'cliente', o.nombre, 'orgId', o.id, 'accion', b.accion, 'detalle', b.detalle) ORDER BY b.creado_en DESC, b.id DESC)
    FROM (SELECT * FROM acciones_operador ORDER BY creado_en DESC, id DESC LIMIT least(greatest(coalesce(p_limite, 100), 1), 500)) b
    JOIN organizaciones o ON o.id = b.org_id), '[]'::jsonb);
END $$;

-- --- Escrituras (código nuevo obligatorio; cada una queda en la bitácora del cliente) ---

CREATE FUNCTION consola_crear_cliente(p_token bytea, p_nombre text, p_email text, p_password_hash text, p_nombre_admin text, p_plan text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record; v_org uuid := gen_random_uuid(); v_usuario uuid := gen_random_uuid(); v_plan text := coalesce(p_plan, 'prueba');
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin'], true);
  IF p_nombre IS NULL OR length(trim(p_nombre)) NOT BETWEEN 1 AND 200 OR p_email IS NULL OR p_password_hash IS NULL
     OR NOT EXISTS (SELECT 1 FROM planes WHERE id = v_plan AND activo) THEN
    RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023';
  END IF;
  INSERT INTO organizaciones (id, nombre, plan_id) VALUES (v_org, trim(p_nombre), v_plan);
  INSERT INTO usuarios (id, org_id, email, password_hash, rol, nombre) VALUES (v_usuario, v_org, lower(trim(p_email)), p_password_hash, 'admin', nullif(trim(p_nombre_admin), ''));
  INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia, operador_id, detalle)
    SELECT v_org, 'plan', cuota_mensual, 'plan:' || to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM') || ':' || id, v_op.op_id, 'Consultas del plan inicial'
    FROM planes WHERE id = v_plan AND cuota_mensual > 0;
  INSERT INTO auditoria (org_id, usuario_id, accion) VALUES (v_org, v_usuario, 'organizacion_creada');
  PERFORM consola_registrar(v_org, v_op.op_id, v_op.op_nombre, 'cliente_creado', 'Creó la cuenta del cliente con el plan ' || v_plan);
  RETURN v_org;
END $$;

CREATE FUNCTION consola_cambiar_plan(p_token bytea, p_org uuid, p_plan text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record; v_nombre text;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','finanzas'], true);
  SELECT nombre INTO v_nombre FROM planes WHERE id = p_plan AND activo;
  IF v_nombre IS NULL THEN RAISE EXCEPTION 'plan_invalido' USING ERRCODE = '22023'; END IF;
  UPDATE organizaciones SET plan_id = p_plan WHERE id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'plan_cambiado', 'Cambió el plan a ' || v_nombre);
END $$;

-- p_tipo: 'recarga' (suma, cantidad > 0) o 'ajuste' (suma o resta, exige motivo).
CREATE FUNCTION consola_agregar_saldo(p_token bytea, p_org uuid, p_cantidad integer, p_tipo text, p_motivo text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record; v_motivo text := nullif(trim(coalesce(p_motivo, '')), ''); v_saldo bigint;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','finanzas'], true);
  IF p_tipo NOT IN ('recarga','ajuste') OR p_cantidad IS NULL OR p_cantidad = 0 OR abs(p_cantidad) > 100000
     OR (p_tipo = 'recarga' AND p_cantidad < 0) OR (p_tipo = 'ajuste' AND v_motivo IS NULL) OR length(coalesce(v_motivo, '')) > 200 THEN
    RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizaciones WHERE id = p_org) THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text, 727)); -- mismo candado que el consumo: el saldo no se mueve a medias
  IF p_cantidad < 0 AND (SELECT coalesce(sum(cantidad), 0) FROM consultas_libro WHERE org_id = p_org) + p_cantidad < 0 THEN
    RAISE EXCEPTION 'saldo_negativo' USING ERRCODE = '22023';
  END IF;
  INSERT INTO consultas_libro (org_id, tipo, cantidad, operador_id, detalle) VALUES (p_org, p_tipo, p_cantidad, v_op.op_id, left(coalesce(v_motivo, 'Recarga del equipo'), 300));
  SELECT coalesce(sum(cantidad), 0) INTO v_saldo FROM consultas_libro WHERE org_id = p_org;
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'saldo_' || p_tipo,
    CASE WHEN p_cantidad > 0 THEN 'Agregó ' ELSE 'Quitó ' END || abs(p_cantidad) || ' consultas al saldo' || coalesce(': ' || v_motivo, ''));
  RETURN v_saldo;
END $$;

CREATE FUNCTION consola_cambiar_estado(p_token bytea, p_org uuid, p_estado text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin'], true);
  IF p_estado NOT IN ('prueba','activo','suspendido','baja') THEN RAISE EXCEPTION 'estado_invalido' USING ERRCODE = '22023'; END IF;
  UPDATE organizaciones SET estado = p_estado, activa = (p_estado IN ('prueba','activo')) WHERE id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  IF p_estado IN ('suspendido','baja') THEN DELETE FROM sesiones WHERE org_id = p_org; END IF; -- se cierran las sesiones abiertas
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'estado_cambiado',
    CASE p_estado WHEN 'suspendido' THEN 'Suspendió la cuenta' WHEN 'baja' THEN 'Dio de baja la cuenta' WHEN 'activo' THEN 'Dejó la cuenta activa' ELSE 'Dejó la cuenta en prueba' END);
END $$;

CREATE FUNCTION consola_cambiar_modo(p_token bytea, p_org uuid, p_modo text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','soporte'], true);
  IF p_modo NOT IN ('autoservicio','gestionada') THEN RAISE EXCEPTION 'modo_invalido' USING ERRCODE = '22023'; END IF;
  UPDATE organizaciones SET modo = p_modo WHERE id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'modo_cambiado',
    'Cambió el modo de atención a ' || CASE p_modo WHEN 'gestionada' THEN 'gestionada por Archie Tech' ELSE 'autoservicio' END);
END $$;

CREATE FUNCTION consola_cambiar_autonomia(p_token bytea, p_org uuid, p_autonomia text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','soporte'], true);
  IF p_autonomia NOT IN ('lectura','borradores','confirmacion') THEN RAISE EXCEPTION 'autonomia_invalida' USING ERRCODE = '22023'; END IF;
  UPDATE organizaciones SET autonomia = p_autonomia WHERE id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'autonomia_cambiada',
    'Cambió la autonomía a ' || CASE p_autonomia WHEN 'lectura' THEN 'solo leer' WHEN 'borradores' THEN 'leer y preparar borradores' ELSE 'actuar con tu confirmación' END);
END $$;

-- p_horas 1..72 activa o renueva el modo asistencia; 0 lo termina.
CREATE FUNCTION consola_asistencia(p_token bytea, p_org uuid, p_horas integer)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record; v_hasta timestamptz;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','soporte'], true);
  IF p_horas IS NULL OR p_horas < 0 OR p_horas > 72 THEN RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023'; END IF;
  v_hasta := CASE WHEN p_horas = 0 THEN NULL ELSE now() + make_interval(hours => p_horas) END;
  UPDATE organizaciones SET asistencia_hasta = v_hasta WHERE id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, CASE WHEN p_horas = 0 THEN 'asistencia_terminada' ELSE 'asistencia_activada' END,
    CASE WHEN p_horas = 0 THEN 'Terminó el modo asistencia' ELSE 'Activó el modo asistencia por ' || p_horas || ' h' END);
  RETURN v_hasta;
END $$;

-- Restablecer el 2FA de una persona del cliente: solo con la cuenta en modo gestionado o con el modo asistencia activo.
CREATE FUNCTION consola_resetear_2fa(p_token bytea, p_org uuid, p_usuario uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_op record; v_org record; v_email text;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','soporte'], true);
  SELECT modo, asistencia_hasta INTO v_org FROM organizaciones WHERE id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  IF v_org.modo <> 'gestionada' AND (v_org.asistencia_hasta IS NULL OR v_org.asistencia_hasta <= now()) THEN
    RAISE EXCEPTION 'requiere_asistencia' USING ERRCODE = '22023';
  END IF;
  UPDATE usuarios SET totp_activo = false, totp_secreto = NULL, totp_clave_version = NULL, totp_ultimo_paso = NULL, intentos_fallidos = 0, bloqueado_hasta = NULL
   WHERE id = p_usuario AND org_id = p_org RETURNING email INTO v_email;
  IF v_email IS NULL THEN RAISE EXCEPTION 'usuario_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  DELETE FROM sesiones WHERE usuario_id = p_usuario AND org_id = p_org;
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'dos_pasos_reseteado', 'Restableció la verificación en dos pasos de ' || v_email);
END $$;

-- El cliente puede terminar el modo asistencia cuando quiera (la organización sale de la sesión, no de la entrada).
CREATE FUNCTION panel_terminar_asistencia()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'no_autorizado' USING ERRCODE = '42501'; END IF;
  UPDATE organizaciones SET asistencia_hasta = NULL WHERE id = v_org AND asistencia_hasta IS NOT NULL;
  IF FOUND THEN PERFORM consola_registrar(v_org, NULL, 'El cliente', 'asistencia_terminada', 'Terminó el modo asistencia'); END IF;
END $$;

-- Cambio de dueño (mismo método que las funciones de archie_preauth: se concede CREATE y se retira de inmediato).
GRANT CREATE ON SCHEMA public TO archie_consola;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'consola_validar(bytea, text[], boolean)', 'consola_registrar(uuid, uuid, text, text, text)',
    'consola_buscar_operador(text)', 'consola_registrar_fallido(uuid, integer, integer)',
    'consola_crear_sesion_pendiente(uuid, bytea, integer, inet, text)', 'consola_datos_2fa(bytea)',
    'consola_completar_sesion(bytea, bytea, integer, bigint, inet, text)', 'consola_resolver_sesion(bytea)',
    'consola_cerrar_sesion(bytea)', 'consola_reautenticar(bytea, bigint)',
    'consola_resumen(bytea)', 'consola_clientes(bytea, text, text, integer)', 'consola_ficha(bytea, uuid)', 'consola_bitacora(bytea, integer)',
    'consola_crear_cliente(bytea, text, text, text, text, text)', 'consola_cambiar_plan(bytea, uuid, text)',
    'consola_agregar_saldo(bytea, uuid, integer, text, text)', 'consola_cambiar_estado(bytea, uuid, text)',
    'consola_cambiar_modo(bytea, uuid, text)', 'consola_cambiar_autonomia(bytea, uuid, text)',
    'consola_asistencia(bytea, uuid, integer)', 'consola_resetear_2fa(bytea, uuid, uuid)', 'panel_terminar_asistencia()'
  ] LOOP
    -- Primero los permisos (mientras el dueño sigue siendo archie_owner: después ya no podría quitarlos) y luego el cambio de dueño.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    -- Las dos funciones internas solo las llaman las demás funciones de la consola (mismo dueño): nadie más las ejecuta.
    IF f NOT LIKE 'consola_validar%' AND f NOT LIKE 'consola_registrar(%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO archie_app', f);
    END IF;
    EXECUTE format('ALTER FUNCTION %s OWNER TO archie_consola', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM archie_consola;

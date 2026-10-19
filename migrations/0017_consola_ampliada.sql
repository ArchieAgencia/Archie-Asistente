-- Consola del equipo ampliada (octubre 2026):
--  1. "Mi cuenta · Archie Tech": una cuenta propia (cliente 0) que el equipo usa como si fuera un cliente. Cada persona del equipo entra con
--     SU identidad (su sesión de operador con segundo factor) a SU usuario dentro de la cuenta propia. Nadie entra a la cuenta de un cliente.
--  2. Conexiones por cliente (solo estado; nunca se lee el secreto) y retiro de una conexión que está fallando.
--  3. Uso y costos de IA por cliente y por mes.
--  4. Widget por cliente: sitios y claves (sin valores), con revocación.
--  5. Equipo de Archie: invitar, activar, desactivar y cambiar el rol de operadores, con bitácora propia.
-- No hay roles nuevos: las funciones pertenecen a archie_consola (igual que las de 0004). Tras actualizar: aprovisionar y migrar.

-- ---------------------------------------------------------------------------------------------------------
-- A. Estructura
-- ---------------------------------------------------------------------------------------------------------

-- La cuenta propia se marca desde el servidor (rol dueño), nunca desde la API: ningún rol de la aplicación ni de la consola puede cambiar este campo.
ALTER TABLE organizaciones ADD COLUMN es_propia boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX organizaciones_una_propia ON organizaciones (es_propia) WHERE es_propia;

-- Sesión de cliente abierta desde la consola (puente). La aplicación NO puede escribir esta columna: solo la consola (por función).
ALTER TABLE sesiones ADD COLUMN puente_operador uuid REFERENCES operadores (id) ON DELETE CASCADE;
CREATE INDEX sesiones_puente ON sesiones (puente_operador) WHERE puente_operador IS NOT NULL;
REVOKE INSERT ON sesiones FROM archie_app;
GRANT INSERT (id, org_id, usuario_id, token_hash, expira_en, creada_en, ip, agente, mfa_ok) ON sesiones TO archie_app;

ALTER TABLE operadores ADD COLUMN activado_en timestamptz;  -- NULL = invitado que aún no activa su cuenta
UPDATE operadores SET activado_en = creado_en;
ALTER TABLE operadores ALTER COLUMN activado_en SET DEFAULT now();  -- los creados desde el servidor (crear-operador) nacen activos; los invitados se insertan con NULL

-- Cada operador tiene como máximo un usuario en la cuenta propia.
CREATE TABLE operadores_cuenta_propia (
  operador_id uuid PRIMARY KEY REFERENCES operadores (id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,
  org_id uuid NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usuario_id),
  FOREIGN KEY (usuario_id, org_id) REFERENCES usuarios (id, org_id) ON DELETE CASCADE
);

-- Invitación de un operador. La contraseña y el secreto del segundo factor quedan EN ESPERA aquí hasta que la persona confirma un código:
-- el operador no se modifica antes. Una invitación por operador; el enlace (token) solo existe en el correo.
CREATE TABLE invitaciones_operador (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operador_id uuid NOT NULL UNIQUE REFERENCES operadores (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expira_en timestamptz NOT NULL,
  creada_en timestamptz NOT NULL DEFAULT now(),
  intentos smallint NOT NULL DEFAULT 0,
  password_hash text,
  totp_secreto bytea,
  totp_clave_version integer
);

-- Bitácora de acciones sobre el propio equipo (no pertenecen a ningún cliente). Solo se agrega.
CREATE TABLE bitacora_equipo (
  id bigserial PRIMARY KEY,
  operador_id uuid REFERENCES operadores (id) ON DELETE SET NULL,
  operador_nombre text NOT NULL CHECK (length(operador_nombre) BETWEEN 1 AND 120),
  accion text NOT NULL CHECK (accion ~ '^[a-z][a-z0-9_]{1,60}$'),
  detalle text NOT NULL CHECK (length(detalle) <= 400),
  creado_en timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------------------
-- B. Permisos mínimos del rol de la consola
-- ---------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON operadores_cuenta_propia, invitaciones_operador TO archie_consola;
GRANT UPDATE (intentos, password_hash, totp_secreto, totp_clave_version) ON invitaciones_operador TO archie_consola;
GRANT DELETE ON invitaciones_operador TO archie_consola;
GRANT SELECT, INSERT ON bitacora_equipo TO archie_consola;
GRANT USAGE ON SEQUENCE bitacora_equipo_id_seq TO archie_consola;

GRANT INSERT ON operadores TO archie_consola;
GRANT UPDATE (rol, activo, password_hash, totp_secreto, totp_clave_version, activado_en) ON operadores TO archie_consola;
GRANT UPDATE (rol, nombre, activo) ON usuarios TO archie_consola;

GRANT INSERT ON sesiones TO archie_consola;
CREATE POLICY consola_sesiones_crear ON sesiones FOR INSERT TO archie_consola WITH CHECK (true);

-- Conexiones: ahora ve el estado (nunca la columna del secreto) y puede quitar una.
GRANT SELECT (conector, nombre, origen, probada_en, prueba_ok, creada_en, rotada_en) ON credenciales_conector TO archie_consola;
GRANT DELETE ON credenciales_conector TO archie_consola;
CREATE POLICY consola_conectores_quitar ON credenciales_conector FOR DELETE TO archie_consola USING (true);

-- Uso de herramientas (sin argumentos): para ver cuáles se usan más y cuántas fallan.
GRANT SELECT (org_id, herramienta, ok, codigo, creado_en) ON llamadas_herramienta TO archie_consola;
CREATE POLICY consola_llamadas_ver ON llamadas_herramienta FOR SELECT TO archie_consola USING (true);

-- Widget: sitios, claves (sin el hash) y sesiones.
GRANT SELECT ON incrustacion_origenes TO archie_consola;
CREATE POLICY consola_origenes_ver ON incrustacion_origenes FOR SELECT TO archie_consola USING (true);
GRANT SELECT (id, org_id, nombre, prefijo, creada_en, ultimo_uso, revocada_en) ON incrustacion_claves TO archie_consola;
GRANT UPDATE (revocada_en) ON incrustacion_claves TO archie_consola;
CREATE POLICY consola_claves_ver ON incrustacion_claves FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_claves_revocar ON incrustacion_claves FOR UPDATE TO archie_consola USING (true) WITH CHECK (true);
GRANT SELECT (id, org_id, clave_id, tipo, expira_en), DELETE ON sesiones_widget TO archie_consola;
CREATE POLICY consola_sesiones_widget_ver ON sesiones_widget FOR SELECT TO archie_consola USING (true);
CREATE POLICY consola_sesiones_widget_cerrar ON sesiones_widget FOR DELETE TO archie_consola USING (true);

-- ---------------------------------------------------------------------------------------------------------
-- C. Funciones. Mismas reglas que en 0004: SECURITY DEFINER, search_path fijo (con pg_temp al final), sin permiso para PUBLIC.
-- ---------------------------------------------------------------------------------------------------------

-- Interna: bitácora del equipo.
CREATE FUNCTION consola_registrar_equipo(p_op uuid, p_nombre text, p_accion text, p_detalle text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO bitacora_equipo (operador_id, operador_nombre, accion, detalle) VALUES (p_op, p_nombre, p_accion, left(p_detalle, 400));
$$;

-- Cerrar la sesión del operador también cierra las sesiones de "Mi cuenta" que abrió.
GRANT CREATE ON SCHEMA public TO archie_consola;
DO $$ BEGIN SET LOCAL ROLE archie_consola; DROP FUNCTION consola_cerrar_sesion(bytea); RESET ROLE; END $$;
REVOKE CREATE ON SCHEMA public FROM archie_consola;
CREATE FUNCTION consola_cerrar_sesion(p_token_hash bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op uuid;
BEGIN
  DELETE FROM sesiones_operador WHERE token_hash = p_token_hash RETURNING operador_id INTO v_op;
  IF v_op IS NOT NULL THEN DELETE FROM sesiones WHERE puente_operador = v_op; END IF;
END $$;

-- --- Conexiones por cliente ---

CREATE FUNCTION consola_conexiones(p_token bytea, p_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  IF NOT EXISTS (SELECT 1 FROM organizaciones WHERE id = p_org) THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'conector', c.conector, 'nombre', c.nombre, 'origen', c.origen,
      'probadaEn', c.probada_en, 'pruebaOk', c.prueba_ok, 'creadaEn', c.creada_en, 'rotadaEn', c.rotada_en) ORDER BY c.conector, c.nombre)
    FROM credenciales_conector c WHERE c.org_id = p_org), '[]'::jsonb);
END $$;

-- Solo se quita una conexión que la última prueba marcó como fallida: las que funcionan las administra el cliente.
CREATE FUNCTION consola_quitar_conexion(p_token bytea, p_org uuid, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op record; v_c record;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','soporte'], true);
  SELECT c.conector, c.nombre, c.prueba_ok INTO v_c FROM credenciales_conector c WHERE c.id = p_id AND c.org_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'conexion_no_encontrada' USING ERRCODE = 'P0002'; END IF;
  IF v_c.prueba_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'conexion_sana' USING ERRCODE = '22023'; END IF;
  DELETE FROM credenciales_conector WHERE id = p_id AND org_id = p_org;
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'conexion_quitada', 'Quitó la conexión ' || v_c.conector || ' (' || v_c.nombre || ') porque estaba fallando');
END $$;

-- --- Uso y costos de IA ---

CREATE FUNCTION consola_uso_clientes(p_token bytea, p_mes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_ini timestamptz; v_fin timestamptz; r jsonb;
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  IF p_mes IS NULL OR p_mes !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'mes_invalido' USING ERRCODE = '22023'; END IF;
  v_ini := (p_mes || '-01')::date::timestamp AT TIME ZONE 'America/Bogota';
  v_fin := v_ini + interval '1 month';
  SELECT jsonb_build_object(
    'mes', p_mes,
    'clientes', coalesce(jsonb_agg(f ORDER BY (f->>'costoMicroUsd')::bigint DESC, f->>'nombre'), '[]'::jsonb),
    'total', jsonb_build_object(
      'consultas', coalesce(sum((f->>'consultas')::bigint), 0), 'tokensEntrada', coalesce(sum((f->>'tokensEntrada')::bigint), 0),
      'tokensSalida', coalesce(sum((f->>'tokensSalida')::bigint), 0), 'costoMicroUsd', coalesce(sum((f->>'costoMicroUsd')::bigint), 0),
      'errores', coalesce(sum((f->>'errores')::bigint), 0))) INTO r
  FROM (SELECT jsonb_build_object('id', o.id, 'nombre', o.nombre, 'estado', o.estado, 'propia', o.es_propia,
      'consultas', coalesce((SELECT -sum(l.cantidad) FROM consultas_libro l WHERE l.org_id = o.id AND l.tipo = 'consumo' AND l.creado_en >= v_ini AND l.creado_en < v_fin), 0),
      'tokensEntrada', u.ent, 'tokensSalida', u.sal, 'tokensCache', u.cache, 'costoMicroUsd', u.costo,
      'errores', (SELECT count(*) FROM llamadas_herramienta h WHERE h.org_id = o.id AND NOT h.ok AND h.creado_en >= v_ini AND h.creado_en < v_fin)) AS f
    FROM organizaciones o
    CROSS JOIN LATERAL (SELECT coalesce(sum(tokens_entrada), 0)::bigint AS ent, coalesce(sum(tokens_salida), 0)::bigint AS sal,
        coalesce(sum(tokens_cache), 0)::bigint AS cache, coalesce(sum(costo_micro_usd), 0)::bigint AS costo
      FROM uso_ia WHERE org_id = o.id AND creado_en >= v_ini AND creado_en < v_fin) u) q;
  RETURN r;
END $$;

CREATE FUNCTION consola_uso_cliente(p_token bytea, p_org uuid, p_mes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_ini timestamptz; v_fin timestamptz; r jsonb;
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  IF p_mes IS NULL OR p_mes !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'mes_invalido' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM organizaciones WHERE id = p_org) THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  v_ini := (p_mes || '-01')::date::timestamp AT TIME ZONE 'America/Bogota';
  v_fin := v_ini + interval '1 month';
  SELECT jsonb_build_object(
    'mes', p_mes,
    'consultas', coalesce((SELECT -sum(l.cantidad) FROM consultas_libro l WHERE l.org_id = p_org AND l.tipo = 'consumo' AND l.creado_en >= v_ini AND l.creado_en < v_fin), 0),
    'tokensEntrada', (SELECT coalesce(sum(tokens_entrada), 0) FROM uso_ia WHERE org_id = p_org AND creado_en >= v_ini AND creado_en < v_fin),
    'tokensSalida', (SELECT coalesce(sum(tokens_salida), 0) FROM uso_ia WHERE org_id = p_org AND creado_en >= v_ini AND creado_en < v_fin),
    'tokensCache', (SELECT coalesce(sum(tokens_cache), 0) FROM uso_ia WHERE org_id = p_org AND creado_en >= v_ini AND creado_en < v_fin),
    'costoMicroUsd', (SELECT coalesce(sum(costo_micro_usd), 0) FROM uso_ia WHERE org_id = p_org AND creado_en >= v_ini AND creado_en < v_fin),
    'llamadas', (SELECT count(*) FROM llamadas_herramienta WHERE org_id = p_org AND creado_en >= v_ini AND creado_en < v_fin),
    'errores', (SELECT count(*) FROM llamadas_herramienta WHERE org_id = p_org AND NOT ok AND creado_en >= v_ini AND creado_en < v_fin),
    'herramientas', coalesce((SELECT jsonb_agg(jsonb_build_object('herramienta', t.herramienta, 'usos', t.usos, 'errores', t.errores) ORDER BY t.usos DESC, t.herramienta)
        FROM (SELECT herramienta, count(*) AS usos, count(*) FILTER (WHERE NOT ok) AS errores FROM llamadas_herramienta
              WHERE org_id = p_org AND creado_en >= v_ini AND creado_en < v_fin GROUP BY herramienta ORDER BY count(*) DESC, herramienta LIMIT 10) t), '[]'::jsonb),
    'codigosError', coalesce((SELECT jsonb_agg(jsonb_build_object('codigo', e.codigo, 'veces', e.veces) ORDER BY e.veces DESC, e.codigo)
        FROM (SELECT coalesce(codigo, 'sin_codigo') AS codigo, count(*) AS veces FROM llamadas_herramienta
              WHERE org_id = p_org AND NOT ok AND creado_en >= v_ini AND creado_en < v_fin GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 5) e), '[]'::jsonb),
    'modelos', coalesce((SELECT jsonb_agg(jsonb_build_object('modelo', m.modelo, 'tokens', m.tokens, 'costoMicroUsd', m.costo) ORDER BY m.costo DESC, m.modelo)
        FROM (SELECT modelo, sum(tokens_entrada + tokens_salida)::bigint AS tokens, sum(costo_micro_usd)::bigint AS costo FROM uso_ia
              WHERE org_id = p_org AND creado_en >= v_ini AND creado_en < v_fin GROUP BY modelo) m), '[]'::jsonb),
    'serie', (SELECT jsonb_agg(jsonb_build_object('mes', to_char(m AT TIME ZONE 'America/Bogota', 'YYYY-MM'),
        'consultas', coalesce((SELECT -sum(l.cantidad) FROM consultas_libro l WHERE l.org_id = p_org AND l.tipo = 'consumo' AND l.creado_en >= m AND l.creado_en < m + interval '1 month'), 0),
        'costoMicroUsd', (SELECT coalesce(sum(costo_micro_usd), 0) FROM uso_ia WHERE org_id = p_org AND creado_en >= m AND creado_en < m + interval '1 month')) ORDER BY m)
      FROM generate_series(v_ini - interval '5 months', v_ini, interval '1 month') m)
  ) INTO r;
  RETURN r;
END $$;

-- --- Widget por cliente ---

CREATE FUNCTION consola_widget(p_token bytea, p_org uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  IF NOT EXISTS (SELECT 1 FROM organizaciones WHERE id = p_org) THEN RAISE EXCEPTION 'cliente_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object(
    'origenes', coalesce((SELECT jsonb_agg(jsonb_build_object('origen', o.origen, 'creadoEn', o.creado_en) ORDER BY o.origen) FROM incrustacion_origenes o WHERE o.org_id = p_org), '[]'::jsonb),
    'claves', coalesce((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'nombre', k.nombre, 'prefijo', k.prefijo, 'creadaEn', k.creada_en, 'ultimoUso', k.ultimo_uso, 'revocada', k.revocada_en IS NOT NULL) ORDER BY k.creada_en DESC)
        FROM incrustacion_claves k WHERE k.org_id = p_org), '[]'::jsonb),
    'sesionesActivas', (SELECT count(*) FROM sesiones_widget s WHERE s.org_id = p_org AND s.tipo = 'sesion' AND s.expira_en > now()));
END $$;

CREATE FUNCTION consola_revocar_clave(p_token bytea, p_org uuid, p_clave uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op record; v_k record;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','soporte'], true);
  UPDATE incrustacion_claves SET revocada_en = now() WHERE id = p_clave AND org_id = p_org AND revocada_en IS NULL RETURNING nombre, prefijo INTO v_k;
  IF NOT FOUND THEN RAISE EXCEPTION 'clave_no_encontrada' USING ERRCODE = 'P0002'; END IF;
  DELETE FROM sesiones_widget WHERE clave_id = p_clave AND org_id = p_org;
  PERFORM consola_registrar(p_org, v_op.op_id, v_op.op_nombre, 'widget_clave_revocada', 'Revocó la clave del widget "' || v_k.nombre || '" (' || v_k.prefijo || '…)');
END $$;

-- --- Equipo de Archie ---

CREATE FUNCTION consola_operadores(p_token bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin'], false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'email', o.email, 'nombre', o.nombre, 'rol', o.rol, 'activo', o.activo,
      'pendiente', o.activado_en IS NULL, 'bloqueadoHasta', CASE WHEN o.bloqueado_hasta > now() THEN o.bloqueado_hasta END,
      'creado', o.creado_en, 'invitacionExpira', i.expira_en,
      'ultimoAcceso', (SELECT max(s.creada_en) FROM sesiones_operador s WHERE s.operador_id = o.id AND s.mfa_ok)) ORDER BY o.nombre, o.email)
    FROM operadores o LEFT JOIN invitaciones_operador i ON i.operador_id = o.id), '[]'::jsonb);
END $$;

CREATE FUNCTION consola_bitacora_equipo(p_token bytea, p_limite integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin'], false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('cuando', b.creado_en, 'quien', b.operador_nombre, 'accion', b.accion, 'detalle', b.detalle) ORDER BY b.creado_en DESC, b.id DESC)
    FROM (SELECT * FROM bitacora_equipo ORDER BY creado_en DESC, id DESC LIMIT least(greatest(coalesce(p_limite, 50), 1), 200)) b), '[]'::jsonb);
END $$;

-- Quién recibe los correos de alerta por acciones sensibles: las personas administradoras activas del equipo.
CREATE FUNCTION consola_destinatarios_alerta(p_token bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  RETURN coalesce((SELECT jsonb_agg(o.email ORDER BY o.email) FROM operadores o WHERE o.activo AND o.rol = 'admin' AND o.activado_en IS NOT NULL), '[]'::jsonb);
END $$;

-- p_id lo genera el servidor (el secreto del segundo factor se cifra atado a ese identificador). El operador queda inactivo hasta que active su cuenta.
CREATE FUNCTION consola_invitar_operador(p_token bytea, p_id uuid, p_email text, p_nombre text, p_rol text, p_password_hash text, p_secreto bytea, p_version integer, p_token_inv bytea)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op record; v_exp timestamptz := now() + interval '48 hours'; v_email text := lower(trim(p_email));
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin'], true);
  IF p_rol NOT IN ('admin','soporte','finanzas') OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 320
     OR p_nombre IS NULL OR length(trim(p_nombre)) NOT BETWEEN 1 AND 120 OR p_password_hash IS NULL OR p_secreto IS NULL THEN
    RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023';
  END IF;
  INSERT INTO operadores (id, email, nombre, rol, password_hash, totp_secreto, totp_clave_version, activo, activado_en)
    VALUES (p_id, v_email, trim(p_nombre), p_rol, p_password_hash, p_secreto, p_version, false, NULL);
  INSERT INTO invitaciones_operador (operador_id, token_hash, expira_en) VALUES (p_id, p_token_inv, v_exp);
  PERFORM consola_registrar_equipo(v_op.op_id, v_op.op_nombre, 'operador_invitado', 'Invitó a ' || v_email || ' como ' || p_rol);
  RETURN v_exp;
END $$;

CREATE FUNCTION consola_reenviar_invitacion_operador(p_token bytea, p_operador uuid, p_token_inv bytea)
RETURNS TABLE (email text, nombre text, rol text, expira_en timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op record; v_o record; v_exp timestamptz := now() + interval '48 hours';
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin'], true);
  SELECT o.email AS e, o.nombre AS n, o.rol AS r, o.activado_en AS a INTO v_o FROM operadores o WHERE o.id = p_operador;
  IF NOT FOUND THEN RAISE EXCEPTION 'operador_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  IF v_o.a IS NOT NULL THEN RAISE EXCEPTION 'ya_activado' USING ERRCODE = '22023'; END IF;
  DELETE FROM invitaciones_operador WHERE operador_id = p_operador;
  INSERT INTO invitaciones_operador (operador_id, token_hash, expira_en) VALUES (p_operador, p_token_inv, v_exp);
  PERFORM consola_registrar_equipo(v_op.op_id, v_op.op_nombre, 'invitacion_reenviada', 'Reenvió la invitación a ' || v_o.e);
  RETURN QUERY SELECT v_o.e, v_o.n, v_o.r, v_exp;
END $$;

CREATE FUNCTION consola_estado_operador(p_token bytea, p_operador uuid, p_activo boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op record; v_o record;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin'], true);
  IF p_operador = v_op.op_id THEN RAISE EXCEPTION 'no_a_ti_mismo' USING ERRCODE = '22023'; END IF;
  SELECT o.email AS e, o.rol AS r, o.activo AS act, o.activado_en AS a INTO v_o FROM operadores o WHERE o.id = p_operador FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operador_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  IF v_o.a IS NULL THEN RAISE EXCEPTION 'pendiente_de_activar' USING ERRCODE = '22023'; END IF;
  IF NOT p_activo AND v_o.r = 'admin' AND v_o.act
     AND NOT EXISTS (SELECT 1 FROM operadores x WHERE x.id <> p_operador AND x.activo AND x.rol = 'admin') THEN
    RAISE EXCEPTION 'ultimo_admin' USING ERRCODE = '22023';
  END IF;
  UPDATE operadores SET activo = p_activo WHERE id = p_operador;
  IF NOT p_activo THEN
    DELETE FROM sesiones_operador WHERE operador_id = p_operador;
    DELETE FROM sesiones WHERE puente_operador = p_operador;
  END IF;
  PERFORM consola_registrar_equipo(v_op.op_id, v_op.op_nombre, CASE WHEN p_activo THEN 'operador_reactivado' ELSE 'operador_desactivado' END,
    CASE WHEN p_activo THEN 'Reactivó a ' ELSE 'Desactivó a ' END || v_o.e);
END $$;

CREATE FUNCTION consola_rol_operador(p_token bytea, p_operador uuid, p_rol text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op record; v_o record;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin'], true);
  IF p_rol NOT IN ('admin','soporte','finanzas') THEN RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023'; END IF;
  IF p_operador = v_op.op_id THEN RAISE EXCEPTION 'no_a_ti_mismo' USING ERRCODE = '22023'; END IF;
  SELECT o.email AS e, o.rol AS r, o.activo AS act INTO v_o FROM operadores o WHERE o.id = p_operador FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operador_no_encontrado' USING ERRCODE = 'P0002'; END IF;
  IF p_rol <> 'admin' AND v_o.r = 'admin' AND v_o.act
     AND NOT EXISTS (SELECT 1 FROM operadores x WHERE x.id <> p_operador AND x.activo AND x.rol = 'admin') THEN
    RAISE EXCEPTION 'ultimo_admin' USING ERRCODE = '22023';
  END IF;
  UPDATE operadores SET rol = p_rol WHERE id = p_operador;
  -- Su usuario en "Mi cuenta" sigue al rol (administrador o miembro) y sus sesiones abiertas se cierran para que el cambio sea inmediato.
  UPDATE usuarios SET rol = CASE WHEN p_rol = 'admin' THEN 'admin' ELSE 'miembro' END
   WHERE id IN (SELECT usuario_id FROM operadores_cuenta_propia WHERE operador_id = p_operador);
  DELETE FROM sesiones WHERE puente_operador = p_operador;
  PERFORM consola_registrar_equipo(v_op.op_id, v_op.op_nombre, 'rol_cambiado', 'Cambió el rol de ' || v_o.e || ' a ' || p_rol);
END $$;

-- --- Activación de un operador invitado (sin sesión: protegida por el enlace de 256 bits y por un tope de intentos) ---

CREATE FUNCTION consola_ver_invitacion_operador(p_token_hash bytea)
RETURNS TABLE (operador_id uuid, email text, nombre text, rol text, expira_en timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT o.id, o.email, o.nombre, o.rol, i.expira_en FROM invitaciones_operador i JOIN operadores o ON o.id = i.operador_id
  WHERE i.token_hash = p_token_hash AND i.expira_en > now() AND o.activado_en IS NULL
$$;

-- Cada intento (aunque sea correcto) cuenta; pasado el tope la invitación deja de servir y hay que reenviarla.
CREATE FUNCTION consola_reservar_intento_activacion(p_token_hash bytea, p_max integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH r AS (UPDATE invitaciones_operador SET intentos = intentos + 1 WHERE token_hash = p_token_hash AND expira_en > now() AND intentos < p_max RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r)
$$;

CREATE FUNCTION consola_guardar_activacion(p_token_hash bytea, p_password_hash text, p_secreto bytea, p_version integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH r AS (UPDATE invitaciones_operador SET password_hash = p_password_hash, totp_secreto = p_secreto, totp_clave_version = p_version
             WHERE token_hash = p_token_hash AND expira_en > now() RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r)
$$;

CREATE FUNCTION consola_datos_activacion(p_token_hash bytea)
RETURNS TABLE (operador_id uuid, email text, secreto bytea, clave_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT o.id, o.email, i.totp_secreto, i.totp_clave_version FROM invitaciones_operador i JOIN operadores o ON o.id = i.operador_id
  WHERE i.token_hash = p_token_hash AND i.expira_en > now() AND o.activado_en IS NULL AND i.totp_secreto IS NOT NULL AND i.password_hash IS NOT NULL
$$;

CREATE FUNCTION consola_completar_activacion(p_token_hash bytea, p_paso bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v record;
BEGIN
  SELECT i.id AS iid, i.operador_id AS oid, i.password_hash AS ph, i.totp_secreto AS ts, i.totp_clave_version AS tv, o.nombre AS nombre INTO v
  FROM invitaciones_operador i JOIN operadores o ON o.id = i.operador_id
  WHERE i.token_hash = p_token_hash AND i.expira_en > now() AND o.activado_en IS NULL AND i.totp_secreto IS NOT NULL AND i.password_hash IS NOT NULL
  FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE operadores SET password_hash = v.ph, totp_secreto = v.ts, totp_clave_version = v.tv, totp_ultimo_paso = p_paso,
    activo = true, activado_en = now(), intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = v.oid;
  DELETE FROM invitaciones_operador WHERE id = v.iid;
  PERFORM consola_registrar_equipo(v.oid, v.nombre, 'operador_activado', 'Activó su cuenta');
  RETURN true;
END $$;

-- --- Mi cuenta · Archie Tech ---

CREATE FUNCTION consola_hay_cuenta_propia(p_token bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  RETURN EXISTS (SELECT 1 FROM organizaciones WHERE es_propia AND activa);
END $$;

-- Abre una sesión de cliente en la cuenta propia para ESTE operador (nunca para otro, nunca en otra organización).
-- p_password_hash: hash de una clave aleatoria que nadie conoce (el usuario del equipo no inicia sesión por la puerta de los clientes).
CREATE FUNCTION consola_abrir_mi_cuenta(p_token bytea, p_token_cliente bytea, p_segundos integer, p_password_hash text, p_ip inet, p_agente text)
RETURNS TABLE (org uuid, nombre_org text, usuario uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op record; v_org record; v_email text; v_nombre text; v_rol text; v_usuario uuid; v_op_exp timestamptz; v_seg integer;
BEGIN
  SELECT * INTO v_op FROM consola_validar(p_token, ARRAY['admin','soporte','finanzas'], false);
  SELECT o.id AS id, o.nombre AS nombre INTO v_org FROM organizaciones o WHERE o.es_propia AND o.activa;
  IF NOT FOUND THEN RAISE EXCEPTION 'cuenta_propia_no_configurada' USING ERRCODE = 'P0002'; END IF;
  SELECT s.expira_en INTO v_op_exp FROM sesiones_operador s WHERE s.token_hash = p_token;
  v_seg := least(greatest(coalesce(p_segundos, 3600), 60), 4 * 3600, greatest(floor(extract(epoch FROM (v_op_exp - now())))::integer, 60));
  v_rol := CASE WHEN v_op.op_rol = 'admin' THEN 'admin' ELSE 'miembro' END;
  v_nombre := v_op.op_nombre;
  v_email := 'equipo-' || substr(replace(v_op.op_id::text, '-', ''), 1, 12) || '@equipo.archie.invalid';
  SELECT c.usuario_id INTO v_usuario FROM operadores_cuenta_propia c WHERE c.operador_id = v_op.op_id AND c.org_id = v_org.id;
  IF v_usuario IS NULL THEN
    IF p_password_hash IS NULL THEN RAISE EXCEPTION 'datos_invalidos' USING ERRCODE = '22023'; END IF;
    v_usuario := gen_random_uuid();
    INSERT INTO usuarios (id, org_id, email, password_hash, rol, nombre) VALUES (v_usuario, v_org.id, v_email, p_password_hash, v_rol, v_nombre);
    INSERT INTO operadores_cuenta_propia (operador_id, usuario_id, org_id) VALUES (v_op.op_id, v_usuario, v_org.id);
  ELSE
    UPDATE usuarios SET rol = v_rol, nombre = v_nombre, activo = true WHERE id = v_usuario AND org_id = v_org.id;
  END IF;
  DELETE FROM sesiones WHERE puente_operador = v_op.op_id;  -- una sola a la vez
  INSERT INTO sesiones (org_id, usuario_id, token_hash, expira_en, ip, agente, mfa_ok, puente_operador)
    VALUES (v_org.id, v_usuario, p_token_cliente, now() + make_interval(secs => v_seg), p_ip, left(p_agente, 200), true, v_op.op_id);
  PERFORM consola_registrar(v_org.id, v_op.op_id, v_op.op_nombre, 'mi_cuenta_abierta', 'Abrió Mi cuenta como ' || v_rol);
  RETURN QUERY SELECT v_org.id, v_org.nombre, v_usuario;
END $$;

-- ---------------------------------------------------------------------------------------------------------
-- D. Permisos de ejecución y cambio de dueño (mismo método que 0004)
-- ---------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO archie_consola;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'consola_registrar_equipo(uuid, text, text, text)', 'consola_cerrar_sesion(bytea)',
    'consola_conexiones(bytea, uuid)', 'consola_quitar_conexion(bytea, uuid, uuid)',
    'consola_uso_clientes(bytea, text)', 'consola_uso_cliente(bytea, uuid, text)',
    'consola_widget(bytea, uuid)', 'consola_revocar_clave(bytea, uuid, uuid)',
    'consola_operadores(bytea)', 'consola_bitacora_equipo(bytea, integer)', 'consola_destinatarios_alerta(bytea)',
    'consola_invitar_operador(bytea, uuid, text, text, text, text, bytea, integer, bytea)',
    'consola_reenviar_invitacion_operador(bytea, uuid, bytea)', 'consola_estado_operador(bytea, uuid, boolean)', 'consola_rol_operador(bytea, uuid, text)',
    'consola_ver_invitacion_operador(bytea)', 'consola_reservar_intento_activacion(bytea, integer)', 'consola_guardar_activacion(bytea, text, bytea, integer)',
    'consola_datos_activacion(bytea)', 'consola_completar_activacion(bytea, bigint)',
    'consola_hay_cuenta_propia(bytea)', 'consola_abrir_mi_cuenta(bytea, bytea, integer, text, inet, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    -- La bitácora interna solo la llaman las demás funciones de la consola (mismo dueño).
    IF f NOT LIKE 'consola_registrar_equipo%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO archie_app', f);
    END IF;
    EXECUTE format('ALTER FUNCTION %s OWNER TO archie_consola', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM archie_consola;

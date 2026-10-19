-- Endurecimiento tras la auditoría (octubre 2026):
--  1. Bloqueo por intentos fallidos sin carrera: el intento se RESERVA (contador atómico) ANTES de verificar la contraseña o el código,
--     así 100 peticiones en paralelo ya no se evalúan todas antes de que el bloqueo surta efecto.
--  2. Todas las funciones SECURITY DEFINER pasan a tener pg_temp al final de su search_path (defensa en profundidad: una tabla temporal
--     no puede esconder a una tabla real aunque algún día un rol reciba el permiso TEMP).

-- ---------------------------------------------------------------------------------------------------------
-- 1. Reserva de intentos. Reservar = sumar 1 al contador SOLO si la cuenta no está bloqueada (una sola sentencia: las demás esperan el bloqueo de fila).
--    Si el bloqueo ya venció, el contador arranca de nuevo en 1. Devuelve true si el intento puede evaluarse.
--    Liberar = deshacer la reserva cuando la contraseña fue correcta (el segundo factor sigue pendiente): no cuenta como fallo.
--    Requiere p_max >= 2.
-- ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION reservar_intento_login(p_usuario_id uuid, p_max integer, p_bloqueo_min integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH r AS (
    UPDATE usuarios SET
      intentos_fallidos = CASE WHEN bloqueado_hasta IS NOT NULL THEN 1 ELSE intentos_fallidos + 1 END,
      bloqueado_hasta = CASE WHEN bloqueado_hasta IS NULL AND intentos_fallidos + 1 >= p_max THEN now() + make_interval(mins => p_bloqueo_min) ELSE NULL END
    WHERE id = p_usuario_id AND (bloqueado_hasta IS NULL OR bloqueado_hasta <= now())
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r)
$$;

CREATE FUNCTION liberar_intento_login(p_usuario_id uuid, p_max integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE usuarios SET
    intentos_fallidos = greatest(intentos_fallidos - 1, 0),
    bloqueado_hasta = CASE WHEN greatest(intentos_fallidos - 1, 0) < p_max THEN NULL ELSE bloqueado_hasta END
  WHERE id = p_usuario_id
$$;

CREATE FUNCTION consola_reservar_intento(p_operador_id uuid, p_max integer, p_bloqueo_min integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH r AS (
    UPDATE operadores SET
      intentos_fallidos = CASE WHEN bloqueado_hasta IS NOT NULL THEN 1 ELSE intentos_fallidos + 1 END,
      bloqueado_hasta = CASE WHEN bloqueado_hasta IS NULL AND intentos_fallidos + 1 >= p_max THEN now() + make_interval(mins => p_bloqueo_min) ELSE NULL END
    WHERE id = p_operador_id AND (bloqueado_hasta IS NULL OR bloqueado_hasta <= now())
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r)
$$;

CREATE FUNCTION consola_liberar_intento(p_operador_id uuid, p_max integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE operadores SET
    intentos_fallidos = greatest(intentos_fallidos - 1, 0),
    bloqueado_hasta = CASE WHEN greatest(intentos_fallidos - 1, 0) < p_max THEN NULL ELSE bloqueado_hasta END
  WHERE id = p_operador_id
$$;

GRANT CREATE ON SCHEMA public TO archie_preauth, archie_consola;
REVOKE ALL ON FUNCTION reservar_intento_login(uuid, integer, integer), liberar_intento_login(uuid, integer),
  consola_reservar_intento(uuid, integer, integer), consola_liberar_intento(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reservar_intento_login(uuid, integer, integer), liberar_intento_login(uuid, integer),
  consola_reservar_intento(uuid, integer, integer), consola_liberar_intento(uuid, integer) TO archie_app;
ALTER FUNCTION reservar_intento_login(uuid, integer, integer) OWNER TO archie_preauth;
ALTER FUNCTION liberar_intento_login(uuid, integer) OWNER TO archie_preauth;
ALTER FUNCTION consola_reservar_intento(uuid, integer, integer) OWNER TO archie_consola;
ALTER FUNCTION consola_liberar_intento(uuid, integer) OWNER TO archie_consola;
REVOKE CREATE ON SCHEMA public FROM archie_preauth, archie_consola;

-- ---------------------------------------------------------------------------------------------------------
-- 2. pg_temp al final del search_path de TODA función SECURITY DEFINER del esquema público (cada una se modifica actuando como su dueño).
-- ---------------------------------------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, pg_get_userbyid(p.proowner) AS dueno
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%pg_temp%')
    ORDER BY 2, 1::text
  LOOP
    IF r.dueno <> current_user THEN EXECUTE format('SET LOCAL ROLE %I', r.dueno); END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', r.f);
    RESET ROLE;
  END LOOP;
END $$;

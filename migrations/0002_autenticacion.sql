-- Paso 3 de F0: autenticación. Segundo factor (TOTP) con protección contra reutilización de códigos
-- y sesiones "pendientes de segundo factor".

ALTER TABLE usuarios ADD COLUMN totp_ultimo_paso bigint;           -- último intervalo TOTP aceptado (evita reutilizar un código)
ALTER TABLE sesiones ADD COLUMN mfa_ok boolean NOT NULL DEFAULT true; -- false = contraseña correcta, falta el segundo factor

-- resolver_sesion ahora informa si la sesión ya pasó el segundo factor.
DROP FUNCTION resolver_sesion(bytea);
CREATE FUNCTION resolver_sesion(p_token_hash bytea)
RETURNS TABLE (sesion_id uuid, usuario_id uuid, org_id uuid, rol text, mfa_ok boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id, s.usuario_id, s.org_id, u.rol, s.mfa_ok
  FROM sesiones s
  JOIN usuarios u ON u.id = s.usuario_id AND u.org_id = s.org_id
  JOIN organizaciones o ON o.id = s.org_id
  WHERE s.token_hash = p_token_hash AND s.expira_en > now() AND u.activo AND o.activa
$$;

GRANT CREATE ON SCHEMA public TO archie_preauth;
ALTER FUNCTION resolver_sesion(bytea) OWNER TO archie_preauth;
REVOKE CREATE ON SCHEMA public FROM archie_preauth;
REVOKE ALL ON FUNCTION resolver_sesion(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolver_sesion(bytea) TO archie_app;

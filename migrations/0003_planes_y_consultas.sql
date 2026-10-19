-- Paso 4 de F0: planes, estado del cliente, libro de consultas (solo agregar) y consumo atómico con topes.
-- Los valores de los planes son provisionales: se ajustan con una migración nueva o desde la consola (F0.6).

CREATE TABLE planes (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{1,30}$'),
  nombre text NOT NULL CHECK (length(nombre) BETWEEN 1 AND 60),
  cuota_mensual integer NOT NULL CHECK (cuota_mensual >= 0),
  tope_diario integer NOT NULL CHECK (tope_diario > 0),
  activo boolean NOT NULL DEFAULT true
);
INSERT INTO planes (id, nombre, cuota_mensual, tope_diario) VALUES
  ('prueba', 'Prueba', 100, 50),
  ('basico', 'Básico', 300, 60),
  ('profesional', 'Profesional', 1000, 150);
GRANT SELECT ON planes TO archie_app, archie_preauth;

ALTER TABLE organizaciones
  ADD COLUMN estado text NOT NULL DEFAULT 'prueba' CHECK (estado IN ('prueba', 'activo', 'suspendido', 'baja')),
  ADD COLUMN plan_id text NOT NULL DEFAULT 'prueba' REFERENCES planes (id),
  ADD COLUMN modo text NOT NULL DEFAULT 'autoservicio' CHECK (modo IN ('autoservicio', 'gestionada')),
  ADD COLUMN autonomia text NOT NULL DEFAULT 'borradores' CHECK (autonomia IN ('lectura', 'borradores', 'confirmacion')),
  ADD COLUMN tope_diario_propio integer CHECK (tope_diario_propio > 0);
-- "activa" (que usa el inicio de sesión) siempre coincide con el estado: suspendido y baja no entran.
ALTER TABLE organizaciones ADD CONSTRAINT activa_segun_estado CHECK (activa = (estado IN ('prueba', 'activo')));

-- Libro de consultas: cada fila suma (+) o gasta (−). El saldo es la suma. Nunca se edita ni se borra.
CREATE TABLE consultas_libro (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizaciones (id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('plan', 'recarga', 'consumo', 'ajuste')),
  cantidad integer NOT NULL CHECK (cantidad <> 0),
  referencia text CHECK (length(referencia) <= 200),  -- idempotencia: la misma referencia no se cobra dos veces
  usuario_id uuid,
  operador_id uuid,
  detalle text CHECK (length(detalle) <= 300),
  creado_en timestamptz NOT NULL DEFAULT now(),
  CHECK ((tipo = 'consumo' AND cantidad < 0) OR (tipo IN ('plan', 'recarga') AND cantidad > 0) OR tipo = 'ajuste')
);
CREATE UNIQUE INDEX consultas_libro_referencia ON consultas_libro (org_id, referencia) WHERE referencia IS NOT NULL;
CREATE INDEX consultas_libro_org_fecha ON consultas_libro (org_id, creado_en);

ALTER TABLE consultas_libro ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultas_libro FORCE ROW LEVEL SECURITY;
CREATE POLICY ver ON consultas_libro FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- La aplicación solo puede registrar CONSUMOS. Sumar saldo (plan, recarga, ajuste) es cosa de operadores.
CREATE POLICY consumir ON consultas_libro FOR INSERT TO archie_app
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid AND tipo = 'consumo');
CREATE POLICY dueno ON consultas_libro FOR ALL TO archie_owner
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON consultas_libro TO archie_app;
GRANT USAGE ON SEQUENCE consultas_libro_id_seq TO archie_app;

-- Consumo atómico: revisa estado, saldo y tope diario y registra, todo bajo un candado por organización,
-- para que dos peticiones a la vez no gasten más de lo que hay. Corre con los permisos de quien llama (seguridad por filas).
CREATE FUNCTION consumir_consultas(p_usuario uuid, p_n integer, p_ref text, p_detalle text DEFAULT NULL)
RETURNS TABLE (resultado text, saldo_restante bigint)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
  v_estado text; v_tope integer; v_saldo bigint; v_hoy bigint; v_inicio timestamptz;
BEGIN
  IF v_org IS NULL OR p_n IS NULL OR p_n < 1 OR p_n > 100 THEN RAISE EXCEPTION 'parametros_invalidos'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text, 727));
  SELECT o.estado, coalesce(o.tope_diario_propio, p.tope_diario) INTO v_estado, v_tope
    FROM organizaciones o JOIN planes p ON p.id = o.plan_id WHERE o.id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'organizacion_no_encontrada'; END IF;
  SELECT coalesce(sum(cantidad), 0) INTO v_saldo FROM consultas_libro WHERE org_id = v_org;
  IF p_ref IS NOT NULL AND EXISTS (SELECT 1 FROM consultas_libro WHERE org_id = v_org AND referencia = p_ref) THEN
    RETURN QUERY SELECT 'repetido'::text, v_saldo; RETURN;
  END IF;
  IF v_estado NOT IN ('prueba', 'activo') THEN RETURN QUERY SELECT 'suspendido'::text, v_saldo; RETURN; END IF;
  IF v_saldo < p_n THEN RETURN QUERY SELECT 'sin_saldo'::text, v_saldo; RETURN; END IF;
  v_inicio := date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota';
  SELECT coalesce(-sum(cantidad), 0) INTO v_hoy FROM consultas_libro
    WHERE org_id = v_org AND tipo = 'consumo' AND creado_en >= v_inicio;
  IF v_hoy + p_n > v_tope THEN RETURN QUERY SELECT 'tope_diario'::text, v_saldo; RETURN; END IF;
  INSERT INTO consultas_libro (org_id, tipo, cantidad, referencia, usuario_id, detalle)
    VALUES (v_org, 'consumo', -p_n, p_ref, p_usuario, left(p_detalle, 300));
  RETURN QUERY SELECT 'ok'::text, v_saldo - p_n;
END $$;
REVOKE ALL ON FUNCTION consumir_consultas(uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consumir_consultas(uuid, integer, text, text) TO archie_app, archie_owner;

-- Nombre visible de cada persona (para el saludo y la bitácora). Opcional.
ALTER TABLE usuarios ADD COLUMN nombre text CHECK (length(nombre) BETWEEN 1 AND 120);

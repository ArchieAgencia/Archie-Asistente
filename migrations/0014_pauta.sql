-- Fase 2: conector de pauta (Meta Ads, TikTok Ads). Reutiliza credenciales_conector (como las tiendas):
-- el conector se llama pauta_<plataforma> y el nombre es el que le da el administrador a la cuenta publicitaria.
-- La columna «origen» (no secreta) ya existe desde 0013: aquí guarda el identificador de la cuenta publicitaria.

CREATE UNIQUE INDEX credenciales_pauta_nombre ON credenciales_conector (org_id, lower(nombre)) WHERE conector LIKE 'pauta\_%';

ALTER TABLE credenciales_conector ADD CONSTRAINT credenciales_pauta_plataforma
  CHECK (conector NOT LIKE 'pauta\_%' OR conector IN ('pauta_meta', 'pauta_tiktok'));

-- Fase 2: conector de tiendas (WooCommerce, Shopify, VTEX). Reutiliza credenciales_conector (varias por organización):
-- el conector se llama tienda_<plataforma> y el nombre es el que le da el administrador a la tienda.

-- Dato NO secreto para mostrar en Conexiones (dominio o cuenta de la tienda). Los secretos siguen cifrados en «secreto».
ALTER TABLE credenciales_conector ADD COLUMN origen text CHECK (origen IS NULL OR length(origen) <= 253);

-- El nombre de una tienda es único en la organización sin importar la plataforma ni las mayúsculas:
-- el asistente elige la tienda por nombre y no puede haber dos que se confundan.
CREATE UNIQUE INDEX credenciales_tienda_nombre ON credenciales_conector (org_id, lower(nombre)) WHERE conector LIKE 'tienda\_%';

-- Solo se aceptan las plataformas conocidas para el conector de tiendas.
ALTER TABLE credenciales_conector ADD CONSTRAINT credenciales_tienda_plataforma
  CHECK (conector NOT LIKE 'tienda\_%' OR conector IN ('tienda_woocommerce', 'tienda_shopify', 'tienda_vtex'));

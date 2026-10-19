#!/usr/bin/env bash
# Prepara el entorno de PRUEBA local: base de datos, un cliente de ejemplo y una persona del equipo.
# Las claves se generan al azar en demo/.env (solo para esta prueba). Se puede repetir: pregunta antes de borrar nada.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "Ya existe un entorno de prueba (demo/.env)."
  read -r -p "¿Borrarlo y empezar de cero? (escribe SI para confirmar): " r
  [ "$r" = "SI" ] || { echo "No se cambió nada."; exit 0; }
  docker compose down -v >/dev/null 2>&1 || true
fi

cat > .env <<ENV
DEMO_CLAVE_ADMIN_BD=$(openssl rand -hex 16)
DEMO_CLAVE_OWNER=$(openssl rand -hex 16)
DEMO_CLAVE_APP=$(openssl rand -hex 16)
DEMO_CLAVES_MAESTRAS=1:$(openssl rand -base64 32)
ENV
chmod 600 .env
set -a; . ./.env; set +a

echo "1/5 Construyendo la imagen (la primera vez tarda unos minutos)..."
docker compose build app
echo "2/5 Iniciando la base de datos..."
docker compose up -d db --wait

corre() { docker compose run --rm --no-deps -T "$@"; }
echo "3/5 Creando roles y base de datos..."
corre -e ARCHIE_ADMIN_URL="postgres://postgres:${DEMO_CLAVE_ADMIN_BD}@db:5432/postgres" -e ARCHIE_DB_NOMBRE=archie \
  -e ARCHIE_DB_CLAVE_OWNER="${DEMO_CLAVE_OWNER}" -e ARCHIE_DB_CLAVE_APP="${DEMO_CLAVE_APP}" app node dist/cli/aprovisionar.js
OWNER="postgres://archie_owner:${DEMO_CLAVE_OWNER}@db:5432/archie"
corre -e ARCHIE_OWNER_URL="$OWNER" app node dist/cli/migrar.js

echo "4/5 Creando un cliente de ejemplo..."
CLAVE_CLIENTE="$(openssl rand -base64 15 | tr '+/' '-_' | tr -d '=')"
corre -e ARCHIE_OWNER_URL="$OWNER" -e ARCHIE_ORG_NOMBRE="Clínica Dental Sonríe (ejemplo)" -e ARCHIE_ADMIN_EMAIL=sonia@ejemplo.test \
  -e ARCHIE_ADMIN_PASSWORD="$CLAVE_CLIENTE" app node dist/cli/crear-admin.js

echo "5/5 Creando tu usuario del equipo (administración)..."
CLAVE_EQUIPO="$(openssl rand -base64 18 | tr '+/' '-_' | tr -d '=')"
SALIDA="$(corre -e ARCHIE_OWNER_URL="$OWNER" -e ARCHIE_OP_EMAIL=karin@ejemplo.test -e ARCHIE_OP_NOMBRE="Karin Henao" -e ARCHIE_OP_ROL=admin \
  -e ARCHIE_OP_PASSWORD="$CLAVE_EQUIPO" app node dist/cli/crear-operador.js)"

docker compose up -d app --wait
cat <<FIN

LISTO. Abre http://localhost:8800

Cliente de ejemplo (entra en /entrar):
  correo: sonia@ejemplo.test
  clave:  $CLAVE_CLIENTE

Equipo de Archie Tech (entra en /equipo-archie):
  correo: karin@ejemplo.test
  clave:  $CLAVE_EQUIPO
$SALIDA

Agrega el secreto del segundo factor a tu aplicación de autenticación AHORA: no se vuelve a mostrar.
Estas claves son solo de esta prueba. Para apagar: docker compose -f demo/docker-compose.yml down
FIN

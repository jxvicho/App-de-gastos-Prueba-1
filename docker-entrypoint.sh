#!/bin/sh
set -e

echo "⏳ Generando cliente de Prisma..."
npx prisma generate

echo "⏳ Esperando a que Postgres esté listo y aplicando migraciones..."
ATTEMPTS=0
until npx prisma migrate deploy; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 15 ]; then
    echo "❌ Postgres no respondió a tiempo. Revisa 'docker compose logs postgres'."
    exit 1
  fi
  echo "   Postgres aún no está listo, reintentando en 2s... (intento $ATTEMPTS/15)"
  sleep 2
done

echo "🌱 Cargando catálogo de bancos (seed)..."
npm run prisma:seed || echo "   (seed ya se había corrido antes, o falló de forma no crítica)"

echo "🚀 Arrancando el servidor..."
exec "$@"

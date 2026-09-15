FROM node:20-alpine

# Fuentes para el reporte semanal (src/services/weeklyReportImage.ts, con
# @napi-rs/canvas): ttf-dejavu para el texto, font-noto-emoji para los
# íconos de categoría (son emoji reales guardados en Category.icon, no
# íconos vectoriales). fontconfig hace que @napi-rs/canvas las encuentre
# por nombre de familia sin tener que registrar rutas a mano. openssl lo
# necesita el motor de Prisma para conectarse a Postgres (sin esto falla
# con "Could not parse schema engine response" en node:20-alpine).
RUN apk add --no-cache fontconfig ttf-dejavu font-noto-emoji openssl

WORKDIR /app

# Copiamos primero solo los manifiestos para aprovechar la caché de Docker:
# si no cambian package.json/package-lock.json, no reinstala dependencias
# en cada rebuild.
COPY package.json ./
RUN npm install

# El código fuente se monta como volumen en docker-compose.yml para desarrollo
# (así los cambios que hagas se reflejan sin reconstruir la imagen), pero lo
# copiamos también aquí para que la imagen funcione standalone si hace falta.
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]

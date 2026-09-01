FROM node:20-alpine

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

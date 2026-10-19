# Archie asistente: imagen de producción (multi-etapa, usuario sin privilegios).
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine AS interfaz
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/public ./public
COPY web/src ./src
RUN npm run build

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=interfaz /web/dist ./web/dist
COPY migrations ./migrations
ARG ARCHIE_VERSION=0.0.0-dev
ENV ARCHIE_VERSION=${ARCHIE_VERSION}
USER node
EXPOSE 8800
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8800/salud >/dev/null 2>&1 || exit 1
CMD ["node", "dist/index.js"]

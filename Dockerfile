FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/val-access.db

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY views ./views

RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

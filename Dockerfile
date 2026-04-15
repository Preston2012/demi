# --- Build stage ---
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ src/
RUN npm run build

# --- Production stage ---
FROM node:22-slim AS production

WORKDIR /app

# Non-root user
RUN groupadd -r demiurge && useradd -r -g demiurge -m demiurge

COPY package.json package-lock.json ./
ENV HUSKY=0
RUN apt-get update && apt-get install -y python3 make g++ && npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3 && npm rebuild sharp && npm cache clean --force

COPY --from=builder /app/dist/ dist/
COPY .env.example .env.example

# models/ is NOT baked into the image. Mount via docker-compose volume
# or place the ONNX model in the container at /app/models/ manually.
# Without a model, Demiurge falls back to lexical-only search.

# Data directory (persisted via volume)
RUN mkdir -p /app/data /app/backups && chown -R demiurge:demiurge /app/data /app/backups

USER demiurge

ENV NODE_ENV=production

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/api/v1/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]

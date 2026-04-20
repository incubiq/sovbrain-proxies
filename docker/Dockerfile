# sovBrain BYO AI Proxy — Docker reference image
#
# Build: docker build -t sovbrain-proxy .
# Run:   docker run --env-file .env -p 8787:8787 sovbrain-proxy

# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app

# Run as non-root for defence in depth
RUN addgroup -S sovbrain && adduser -S sovbrain -G sovbrain
USER sovbrain

COPY --from=builder /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Container-level health check hits /health (unauth, returns "ok")
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]

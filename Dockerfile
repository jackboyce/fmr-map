# ── Build stage ───────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files and install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy installed deps from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY server/   ./server/
COPY public/   ./public/
COPY package.json ./

# Own everything as appuser
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

# Healthcheck — hits the /api/years endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/years || exit 1

CMD ["node", "server/index.js"]

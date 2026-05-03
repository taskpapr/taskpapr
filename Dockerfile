# ── Build stage ───────────────────────────────────────────────
# Using Node 22 (required for built-in node:sqlite)
FROM node:22-alpine AS deps

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Non-root user for security
RUN addgroup -S taskpapr && adduser -S taskpapr -G taskpapr

WORKDIR /app

# Copy deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=taskpapr:taskpapr . .

# Data directory — mount an external volume here
RUN mkdir -p /data && chown taskpapr:taskpapr /data

USER taskpapr

ENV NODE_ENV=production
ENV PORT=3033
# DB path — override by mounting a volume at /data
ENV DB_PATH=/data/taskpapr.db

EXPOSE 3033

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3033/api/columns || exit 1

CMD ["node", "server.js"]
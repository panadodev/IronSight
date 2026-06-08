FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL=postgresql://postgres:postgres@postgres:5432/ironsight
ENV REDIS_URL=redis://redis:6379
# JWT_SECRET must be set at runtime — the server refuses to start if it is empty
ENV JWT_SECRET=""
ENV SESSION_TTL_SECONDS=86400
ENV LOGIN_RATE_LIMIT_PER_MINUTE=10
ENV PG_POOL_MAX=20
ENV PG_IDLE_TIMEOUT_MS=30000
# Discord OAuth — must be provided at runtime
ENV DISCORD_CLIENT_ID=""
ENV DISCORD_CLIENT_SECRET=""
# Public-facing base URL used to derive OAuth callback URIs
ENV APP_URL=""
# Optional: override the derived Discord redirect URI
ENV DISCORD_REDIRECT_URI=""
# Optional: override the derived Steam return URL / realm
ENV STEAM_RETURN_URL=""
ENV STEAM_REALM=""
# Discord ID of the configured system administrator account
ENV SYS_ADMIN_DISCORD_ID=""

COPY --from=build /app /app

EXPOSE 3000
CMD ["npm", "run", "start"]

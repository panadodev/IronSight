FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN NODE_OPTIONS="--max-old-space-size=1024" npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

# Application defaults
ENV NODE_ENV=production
ENV PORT=7123
ENV SESSION_TTL_SECONDS=86400
ENV LOGIN_RATE_LIMIT_PER_MINUTE=10
ENV PG_POOL_MAX=20
ENV PG_IDLE_TIMEOUT_MS=30000

# Required at runtime (injected by container orchestrator):
#   - DATABASE_URL or POSTGRESQL_URI (PostgreSQL connection string)
#   - REDIS_URL or REDIS_URI (Redis connection string)
#   - JWT_SECRET (session signing secret; server refuses to start if empty)
#   - DISCORD_CLIENT_ID (Discord OAuth app ID)
#   - DISCORD_CLIENT_SECRET (Discord OAuth app secret)
#   - APP_URL (public base URL for OAuth callbacks)
# Optional at runtime:
#   - DISCORD_BOT_TOKEN (Discord bot token; enables Discord moderation + member join DMs)
#   - DISCORD_REDIRECT_URI (override callback URL derivation)
#   - STEAM_RETURN_URL (override Steam OpenID return URL derivation)
#   - STEAM_REALM (override Steam OpenID realm derivation)
#   - SYS_ADMIN_DISCORD_ID (Discord ID of system administrator)

COPY --from=build /app /app

# Fail the build if databases are unreachable.
# Pass credentials with: docker build --build-arg DATABASE_URL=... --build-arg REDIS_URL=...
# These args are NOT baked into the final image.
ARG DATABASE_URL
ARG POSTGRESQL_URI
ARG REDIS_URL
ARG REDIS_URI
RUN node scripts/check-db.mjs

EXPOSE 7123
# Start the bot in the background, then run the web server in the foreground.
# If DISCORD_BOT_TOKEN is unset the bot exits immediately and the server continues normally.
CMD ["sh", "-c", "node bot.js & npm run start"]

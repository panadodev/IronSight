// Backend configuration: environment + sysadmin constants. Imports dotenv
// first so process.env is populated before env is built.

import "dotenv/config";

export const SESSION_COOKIE = "panel_session";
export const PENDING_LINK_COOKIE = "pending_identity";

export const SYSADMIN = {
  globalOrgId: "__global__",
  sysadminRoleId: "sysadmin",
  username: "panado",
};

export function chooseConnectionUrl(primary, secondary) {
  const first = primary?.trim();
  const second = secondary?.trim();

  if (first && second) {
    // Coolify often injects localhost defaults in DATABASE_URL/REDIS_URL while
    // POSTGRESQL_URI/REDIS_URI points to the actual service.
    const firstIsLocal = /localhost|127\.0\.0\.1|\[::1\]|::1/i.test(first);
    const secondIsLocal = /localhost|127\.0\.0\.1|\[::1\]|::1/i.test(second);
    if (firstIsLocal && !secondIsLocal) return second;
  }

  return first || second;
}

export function parseEnvList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: chooseConnectionUrl(
    process.env.DATABASE_URL,
    process.env.POSTGRESQL_URI,
  ),
  redisUrl: chooseConnectionUrl(process.env.REDIS_URL, process.env.REDIS_URI),
  jwtSecret: process.env.JWT_SECRET,
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 24),
  loginRateLimitPerMinute: Number(
    process.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? 10,
  ),
  appUrl: process.env.APP_URL ?? process.env.PUBLIC_APP_URL,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET,
  sysAdminDiscordId: process.env.SYS_ADMIN_DISCORD_ID,
  sysAdminSteamId: process.env.SYSADMIN_STEAM_ID,
  // DISCORD_AUTH_CALLBACK is the legacy key used in .env; DISCORD_REDIRECT_URI takes precedence
  discordRedirectUri:
    process.env.DISCORD_REDIRECT_URI ?? process.env.DISCORD_AUTH_CALLBACK,
  steamRealm: process.env.STEAM_REALM,
  // STEAM_AUTH_CALLBACK is the legacy key used in .env; STEAM_RETURN_URL takes precedence
  steamReturnUrl:
    process.env.STEAM_RETURN_URL ?? process.env.STEAM_AUTH_CALLBACK,
  pterodactylEncryptionSecret:
    process.env.PTERODACTYL_ENCRYPTION_KEY ?? process.env.JWT_SECRET,
  discordBotToken: process.env.DISCORD_BOT_TOKEN,
};

if (!env.databaseUrl) {
  console.warn(
    "[config] Missing DATABASE_URL (or POSTGRESQL_URI). API routes will return 503 until fixed.",
  );
}
if (!env.redisUrl) {
  console.warn(
    "[config] Missing REDIS_URL (or REDIS_URI). API routes will return 503 until fixed.",
  );
}
if (!env.jwtSecret) {
  console.warn(
    "[config] Missing JWT_SECRET. API routes will return 503 until fixed.",
  );
}
if (!env.discordClientId || !env.discordClientSecret) {
  console.warn(
    "[config] Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET. Discord OAuth will return 503.",
  );
}
if (!env.sysAdminDiscordId?.trim()) {
  console.warn(
    "[config] Missing SYS_ADMIN_DISCORD_ID. API startup will fail until fixed.",
  );
}
if (!env.sysAdminSteamId?.trim()) {
  console.warn(
    "[config] Missing SYSADMIN_STEAM_ID. Sysadmin seeding will fail until fixed.",
  );
}
if (env.jwtSecret && !process.env.PTERODACTYL_ENCRYPTION_KEY?.trim()) {
  console.warn(
    "[config] Missing PTERODACTYL_ENCRYPTION_KEY. Falling back to JWT_SECRET for Pterodactyl key encryption.",
  );
}

/* eslint-disable prettier/prettier */
import { Queue } from "bullmq";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import "dotenv/config";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { Pool } from "pg";

const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_ME_URL = "https://discord.com/api/users/@me";
const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";
const SYSADMIN = {
  globalOrgId: "__global__",
  sysadminRoleId: "sysadmin",
  username: "panado",
};

function chooseConnectionUrl(primary, secondary) {
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

function parseEnvList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parsePterodactylAllowedHosts(value) {
  if (!value) return [];
  const items = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.map((item) => {
    try {
      const url = new URL(item);
      return url.hostname.toLowerCase();
    } catch {
      return item.toLowerCase();
    }
  });
}

const env = {
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
  pterodactylAllowedHosts: parsePterodactylAllowedHosts(
    process.env.PTERODACTYL_ALLOWED_HOSTS,
  ),
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
if (!env.pterodactylAllowedHosts.length) {
  console.warn(
    "[config] Missing PTERODACTYL_ALLOWED_HOSTS. Pterodactyl endpoints will return 503 until configured.",
  );
}

let pool;
let redis;
let queue;
let initError = null;
let initialized = false;
let initializationPromise = null;

const SESSION_COOKIE = "panel_session";
const PENDING_LINK_COOKIE = "pending_identity";
let pterodactylEncryptionKey;
let pterodactylEncryptionKeyV2;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getPterodactylEncryptionKey() {
  if (pterodactylEncryptionKey) return pterodactylEncryptionKey;
  const secret = String(env.pterodactylEncryptionSecret ?? "").trim();
  if (!secret) return null;
  // Legacy SHA-256 key — used only for decrypting v1-prefixed ciphertexts.
  pterodactylEncryptionKey = crypto
    .createHash("sha256")
    .update(secret)
    .digest();
  return pterodactylEncryptionKey;
}

function getPterodactylEncryptionKeyV2() {
  if (pterodactylEncryptionKeyV2) return pterodactylEncryptionKeyV2;
  const secret = String(env.pterodactylEncryptionSecret ?? "").trim();
  if (!secret) return null;
  pterodactylEncryptionKeyV2 = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("ironsight-v2-salt", "utf8"),
      Buffer.from("pterodactyl-encryption", "utf8"),
      32,
    ),
  );
  return pterodactylEncryptionKeyV2;
}

function encryptPterodactylApiKey(apiKey) {
  const key = getPterodactylEncryptionKeyV2();
  if (!key) throw new Error("pterodactyl_encryption_unconfigured");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(apiKey), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v2",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(":");
}

function decryptPterodactylApiKey(payload) {
  const [version, ivB64, ciphertextB64, authTagB64] = String(
    payload ?? "",
  ).split(":");
  if (!ivB64 || !ciphertextB64 || !authTagB64) {
    throw new Error("pterodactyl_encryption_invalid_payload");
  }

  let key;
  if (version === "v1") {
    key = getPterodactylEncryptionKey();
  } else if (version === "v2") {
    key = getPterodactylEncryptionKeyV2();
  } else {
    throw new Error("pterodactyl_encryption_invalid_payload");
  }
  if (!key) throw new Error("pterodactyl_encryption_unconfigured");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagB64, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function normalizePterodactylPanelUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) throw new Error("panel_url_required");
  if (!env.pterodactylAllowedHosts.length) {
    throw new Error("pterodactyl_allowed_hosts_unconfigured");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("panel_url_invalid");
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("panel_url_invalid");
  }
  if (parsed.username || parsed.password) {
    throw new Error("panel_url_invalid");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!env.pterodactylAllowedHosts.includes(hostname)) {
    throw new Error("panel_url_host_not_allowed");
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";

  return parsed.toString().replace(/\/+$/, "");
}

function getPterodactylSecurityConfigError() {
  if (!env.pterodactylAllowedHosts.length) {
    return json(
      {
        error:
          "Pterodactyl integration is not configured: PTERODACTYL_ALLOWED_HOSTS is required.",
      },
      503,
    );
  }
  if (!getPterodactylEncryptionKey()) {
    return json(
      {
        error:
          "Pterodactyl integration is not configured: PTERODACTYL_ENCRYPTION_KEY or JWT_SECRET is required.",
      },
      503,
    );
  }

  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Parse a user-supplied pagination limit safely: a missing, non-numeric, or
// non-positive value falls back to `fallback` rather than producing NaN, which
// would otherwise blow up the Redis/SQL query with `LIMIT NaN`.
function parseLimit(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

async function auditLog({
  orgId,
  actorUserId,
  targetUserId = null,
  resourceType = null,
  resourceId = null,
  actionType,
  actionCategory = "admin",
  severity = 1,
  metadata = {},
  beforeState = null,
  afterState = null,
  ipAddress = null,
  userAgent = null,
  sessionId = null,
}) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO audit_logs (
        org_id, actor_user_id, target_user_id, resource_type, resource_id,
        action_type, action_category, severity, metadata, before_state, after_state,
        ip_address, user_agent, session_id, correlation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        orgId,
        actorUserId,
        targetUserId,
        resourceType,
        resourceId,
        actionType,
        actionCategory,
        severity,
        JSON.stringify(metadata),
        beforeState ? JSON.stringify(beforeState) : null,
        afterState ? JSON.stringify(afterState) : null,
        ipAddress,
        userAgent,
        sessionId,
        crypto.randomUUID(),
      ],
    );
  } catch (err) {
    console.error("[audit] Failed to log action:", err.message);
  }
}

function redirect(location, headers = new Headers()) {
  headers.set("location", location);
  return new Response(null, { status: 302, headers });
}

function getClientIp(request) {
  // Prefer the edge-provided client IP (Cloudflare), which a client cannot
  // forge. Fall back to the right-most x-forwarded-for hop (closest to our
  // edge) rather than the left-most, which is fully client-controlled.
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return "unknown";
}

// Generic Redis sliding-window-ish limiter. Returns a 429 response when the
// caller exceeds `limit` actions within `windowSeconds`, otherwise null.
// Fails open (returns null) if Redis is unavailable, matching rateLimitLogin.
async function checkRateLimit(key, limit, windowSeconds = 60) {
  if (!redis) return null;
  try {
    const n = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1, key, String(windowSeconds),
    );
    if (n > limit) {
      return json({ error: "Too many requests. Slow down." }, 429);
    }
  } catch {
    return null;
  }
  return null;
}

function parseMaybeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  const str = String(value).trim();
  if (!str) return [];
  if (str.startsWith("[") && str.endsWith("]")) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) return arr.filter(Boolean).map(String);
    } catch {
      // fall back to csv
    }
  }
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function canWriteTodos(session) {
  if (session?.canWrite) return true;
  if (session?.orgOwnerOrgIds?.length) return true;
  if (session?.orgAdminOrgIds?.length) return true;
  if (!session?.groups?.length) return false;
  return session.groups.some((g) => g.admin || g.editUsers);
}

function isGlobalAdmin(session) {
  if (session?.globalAdmin) return true;
  return Boolean(session?.groups?.some((g) => g.admin));
}

function isConfiguredSysAdmin(session) {
  const configuredDiscordId = String(env.sysAdminDiscordId ?? "").trim();
  if (!configuredDiscordId) return false;
  return String(session?.discordId ?? "") === configuredDiscordId;
}

function requireConfiguredSysAdmin(session) {
  if (!String(env.sysAdminDiscordId ?? "").trim()) {
    return {
      error: json(
        {
          error:
            "Server misconfigured: SYS_ADMIN_DISCORD_ID is required for sysadmin endpoints",
        },
        503,
      ),
    };
  }

  if (!isConfiguredSysAdmin(session)) {
    return {
      error: json({ error: "Forbidden: SYS_ADMIN_DISCORD_ID required" }, 403),
    };
  }

  return { error: null };
}

function canManageOrg(session, orgId) {
  return session.orgAdminOrgIds.includes(orgId);
}

function canViewOrgAsOwner(session, orgId) {
  // Check if user is org owner
  return session.orgAdminOrgIds.includes(orgId);
}

function orgHasPermission(session, orgId, permissionId) {
  return (
    canManageOrg(session, orgId) ||
    (session.orgPermissions?.[orgId] ?? []).includes(permissionId)
  );
}

// Permission IDs that may be assigned to a custom role via the role editor.
// Must stay in sync with the `permissions` table seed in runMigrations().
const ASSIGNABLE_PERMISSIONS = [
  "todo_read",
  "todo_write",
  "todo_delete",
  "org_manage",
  "role_create",
  "rcon_access",
  "scripts_view",
  "scripts_manage",
  "presets_manage",
  "status_view",
  "servers_manage",
  "tickets_view",
  "tickets_manage",
  "tickets_player_intel",
  "ban_configs_manage",
  "toxicity_manage",
  "predefines_manage",
  "bans_delete",
  "players_view",
  "ip_read",
  "bans_manage",
  "triggers_manage",
  "discord_mod",
];

function getBaseUrl(request) {
  return env.appUrl ?? new URL(request.url).origin;
}

function getDiscordRedirectUri(request) {
  return (
    env.discordRedirectUri ?? `${getBaseUrl(request)}/api/auth/discord/callback`
  );
}

function getSteamRealm(request) {
  return env.steamRealm ?? getBaseUrl(request);
}

function getSteamReturnUrl(request) {
  return env.steamReturnUrl ?? `${getBaseUrl(request)}/api/auth/steam/callback`;
}

function sanitizeNext(nextValue) {
  const next = String(nextValue ?? "/todo").trim();
  if (!next.startsWith("/") || next.startsWith("//")) return "/todo";
  return next;
}

function sessionCookie(value, maxAgeSeconds) {
  return serializeCookie(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

function pendingLinkCookie(value, maxAgeSeconds) {
  return serializeCookie(PENDING_LINK_COOKIE, value, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

function signPendingLink(payload) {
  return jwt.sign({ kind: "pending-link", ...payload }, env.jwtSecret, {
    expiresIn: 60 * 15,
  });
}

function signDiscordState(payload) {
  return jwt.sign({ kind: "discord-oauth-state", ...payload }, env.jwtSecret, {
    expiresIn: 60 * 10,
  });
}

function verifyDiscordState(stateToken) {
  try {
    const payload = jwt.verify(stateToken, env.jwtSecret);
    if (payload?.kind !== "discord-oauth-state") return null;
    return {
      next: sanitizeNext(payload.next),
      flow: String(payload.flow ?? "staff"),
    };
  } catch {
    return null;
  }
}

function clearPendingLinkHeaders(headers = new Headers()) {
  headers.append("set-cookie", pendingLinkCookie("", 0));
  return headers;
}

function getPendingLink(request) {
  const cookies = parseCookie(request.headers.get("cookie") ?? "");
  const token = cookies[PENDING_LINK_COOKIE];
  if (!token) return null;

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    if (payload?.kind !== "pending-link") return null;
    return {
      discordId: String(payload.discordId),
      username: String(payload.username),
      next: sanitizeNext(payload.next),
    };
  } catch {
    return null;
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION unix_now()
    RETURNS BIGINT LANGUAGE SQL STABLE AS $$
      SELECT EXTRACT(EPOCH FROM NOW())::BIGINT
    $$
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      discord_id TEXT UNIQUE,
      steam_id TEXT UNIQUE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      CONSTRAINT chk_users_identity_present CHECK (discord_id IS NOT NULL OR steam_id IS NOT NULL)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      expires_at BIGINT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      org_id TEXT PRIMARY KEY,
      guild_id TEXT UNIQUE,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      role_id TEXT PRIMARY KEY,
      role_name TEXT NOT NULL UNIQUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      permission_id TEXT PRIMARY KEY,
      permission_name TEXT NOT NULL UNIQUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_discord_roles (
      role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
      discord_role_id TEXT NOT NULL,
      PRIMARY KEY (role_id, discord_role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organization_members (
      org_id TEXT NOT NULL,
      user_id UUID NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id),
      CONSTRAINT fk_org_members_org FOREIGN KEY (org_id) REFERENCES organizations(org_id) ON DELETE CASCADE,
      CONSTRAINT fk_org_members_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      CONSTRAINT fk_org_members_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_id UUID PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      last_used_at BIGINT,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      todo_id UUID PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(user_id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      completed_at BIGINT,
      CONSTRAINT chk_todos_status CHECK (status IN ('todo', 'in_progress', 'completed', 'blocked'))
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_steam_id ON users(steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON organization_members(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON organization_members(user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_todos_org_id ON todos(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_todos_assigned_to ON todos(assigned_to)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status)`,
  );

  // ── Ticket system ──────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_types (
      ticket_type_id SERIAL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      ticket_type_name TEXT NOT NULL,
      ticket_type_description TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_type_roles (
      ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(ticket_type_id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
      PRIMARY KEY (ticket_type_id, role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id SERIAL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      ticket_type_id INTEGER REFERENCES ticket_types(ticket_type_id) ON DELETE SET NULL,
      created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(user_id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      category TEXT,
      title TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      closed_at BIGINT,
      CONSTRAINT chk_tickets_status CHECK (status IN ('open', 'waiting_response', 'closed')),
      CONSTRAINT chk_tickets_priority CHECK (priority IN ('urgent', 'high', 'normal', 'low'))
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
      message_id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_audit_log (
      audit_id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details JSONB,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ticket_types_org_id ON ticket_types(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_tickets_org_id ON tickets(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id ON ticket_messages(ticket_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ticket_audit_ticket_id ON ticket_audit_log(ticket_id)`,
  );

  // Additive migrations
  await pool.query(
    `ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE`,
  );

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_ticket_types_org_name'
      ) THEN
        ALTER TABLE ticket_types ADD CONSTRAINT uq_ticket_types_org_name
          UNIQUE (org_id, ticket_type_name);
      END IF;
    END $$
  `);

  // Add ticket_type_category column for differentiating player report types
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ticket_types' AND column_name = 'ticket_type_category'
      ) THEN
        ALTER TABLE ticket_types ADD COLUMN ticket_type_category TEXT NOT NULL DEFAULT 'generic'
          CHECK (ticket_type_category IN ('generic', 'player_single', 'player_multi'));
      END IF;
    END $$
  `);

  // Fix categories for ticket types seeded before the category column existed.
  // "Player Report" and cheating/toxicity names → player_single; teaming → player_multi.
  await pool.query(`
    UPDATE ticket_types
    SET ticket_type_category = 'player_single'
    WHERE ticket_type_category = 'generic'
      AND (
        LOWER(ticket_type_name) LIKE '%player report%'
        OR LOWER(ticket_type_name) IN ('cheating', 'toxicity')
      )
  `);
  await pool.query(`
    UPDATE ticket_types
    SET ticket_type_category = 'player_multi'
    WHERE ticket_type_category = 'generic'
      AND LOWER(ticket_type_name) IN ('teaming')
  `);

  // Add is_enabled column to track which ticket types are active for an org
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ticket_types' AND column_name = 'is_enabled'
      ) THEN
        ALTER TABLE ticket_types ADD COLUMN is_enabled BOOLEAN NOT NULL DEFAULT true;
      END IF;
    END $$
  `);

  // Add reported_players column to tickets for structured player Steam ID references
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tickets' AND column_name = 'reported_players'
      ) THEN
        ALTER TABLE tickets ADD COLUMN reported_players TEXT[] NOT NULL DEFAULT '{}';
      END IF;
    END $$
  `);

  // Allow NULL actor_user_id in discord_mod_log for externally-synced bans
  // Guard: table may not exist yet on first migration pass
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'discord_mod_log') THEN
        ALTER TABLE discord_mod_log ALTER COLUMN actor_user_id DROP NOT NULL;
      END IF;
    END $$
  `);

  // ── Public identity links (Discord + Steam for portal ticket submitters) ──

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_identity_links (
      link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      discord_id TEXT NOT NULL UNIQUE,
      discord_username TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_public_identity_links_discord_id ON public_identity_links(discord_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_public_identity_links_steam_id ON public_identity_links(steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_public_identity_links_user_id ON public_identity_links(user_id)`,
  );

  // Audit logs for staff actions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      actor_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE SET NULL,
      target_user_id UUID NULL REFERENCES users(user_id) ON DELETE SET NULL,
      resource_type TEXT NULL,
      resource_id TEXT NULL,
      action_type TEXT NOT NULL,
      action_category TEXT NULL,
      severity SMALLINT NOT NULL DEFAULT 1,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      before_state JSONB NULL,
      after_state JSONB NULL,
      ip_address INET NULL,
      user_agent TEXT NULL,
      session_id TEXT NULL,
      correlation_id UUID NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_org_id ON audit_logs(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id ON audit_logs(actor_user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user_id ON audit_logs(target_user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)`,
  );

  // ── Servers ──────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      server_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_name TEXT NOT NULL,
      owner_org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      api_key_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      added_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_servers_owner_org_id ON servers(owner_org_id)`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS ptero_identifier TEXT`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS rcon_host TEXT`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS rcon_port INTEGER`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS rcon_password_enc TEXT`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS game_port INTEGER`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS last_health_ping BIGINT`,
  );

  // ── Text chat log ─────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS text_chat_log (
      id BIGSERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      player_name TEXT,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      team_message BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_text_chat_log_server_id ON text_chat_log(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_text_chat_log_created_at ON text_chat_log(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_text_chat_log_steam_id ON text_chat_log(steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_text_chat_log_server_created ON text_chat_log(server_id, created_at)`,
  );

  // ── PVP log ─────────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pvp_log (
      id BIGSERIAL PRIMARY KEY,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      killer_steam_id TEXT NOT NULL,
      victim_name TEXT NOT NULL,
      combatlog_cache JSONB NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pvp_log_server_id ON pvp_log(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pvp_log_created_at ON pvp_log(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pvp_log_killer_steam_id ON pvp_log(killer_steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pvp_log_server_created ON pvp_log(server_id, created_at)`,
  );

  // ── Player reports ───────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_reports (
      id BIGSERIAL PRIMARY KEY,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      report_type TEXT NOT NULL,
      report_reason TEXT NOT NULL,
      report_description TEXT NOT NULL DEFAULT '',
      reporter_name TEXT NOT NULL,
      reporter_steam_id TEXT NOT NULL,
      reported_steam_id TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_reports_server_id ON player_reports(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_reports_created_at ON player_reports(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_reports_reported_steam_id ON player_reports(reported_steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_reports_server_created ON player_reports(server_id, created_at)`,
  );

  // ── Team events ──────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_events (
      id BIGSERIAL PRIMARY KEY,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      team_members JSONB NOT NULL DEFAULT '[]',
      team_leader TEXT NOT NULL,
      event_time BIGINT NOT NULL DEFAULT unix_now(),
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      CONSTRAINT chk_team_events_type CHECK (event_type IN ('created', 'joined', 'left'))
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_team_events_server_id ON team_events(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_team_events_created_at ON team_events(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_team_events_server_created ON team_events(server_id, created_at)`,
  );

  // -- Pterodactyl integration -----------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ptero_api_keys (
      org_id TEXT PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
      panel_url TEXT NOT NULL,
      api_key TEXT,
      api_key_encrypted TEXT,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      last_used_at BIGINT,
      created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL
    )
  `);
  await pool.query(
    `ALTER TABLE ptero_api_keys ALTER COLUMN api_key DROP NOT NULL`,
  );
  await pool.query(
    `ALTER TABLE ptero_api_keys ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT`,
  );
  await pool.query(
    `ALTER TABLE ptero_api_keys ADD COLUMN IF NOT EXISTS last_used_at BIGINT`,
  );
  await pool.query(
    `ALTER TABLE ptero_api_keys ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL`,
  );

  // ── RCON scripts ────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_scripts (
      script_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      min_rank INTEGER NOT NULL DEFAULT 1,
      created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_scripts_org_id ON org_scripts(org_id)`,
  );

  // ── Manage Org configs: predefines, toxicity, ban/mute reasons ─────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_predefines (
      predefine_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      extra_keywords TEXT[] NOT NULL DEFAULT '{}',
      content TEXT NOT NULL,
      created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_predefines_org_id ON org_predefines(org_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_toxicity_config (
      org_id TEXT PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
      yellow TEXT[] NOT NULL DEFAULT '{}',
      red TEXT[] NOT NULL DEFAULT '{}',
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  // Ban/mute reasons. category is one of: cheating, teaming, toxicity, mute.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ban_reasons (
      reason_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      CONSTRAINT chk_org_ban_reasons_category
        CHECK (category IN ('cheating', 'teaming', 'toxicity', 'mute'))
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_ban_reasons_org_id ON org_ban_reasons(org_id)`,
  );

  // Per-category note format templates (one row per org+category).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ban_note_formats (
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      note_format TEXT NOT NULL DEFAULT '',
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (org_id, category),
      CONSTRAINT chk_org_ban_note_formats_category
        CHECK (category IN ('cheating', 'teaming', 'toxicity', 'mute'))
    )
  `);

  // ── Plugin presets ──────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_plugins (
      plugin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'umod',
      umod_slug TEXT,
      installed_version TEXT,
      latest_version TEXT,
      latest_updated_at BIGINT,
      assigned_tags JSONB NOT NULL DEFAULT '[]',
      risk INTEGER NOT NULL DEFAULT 2 CHECK (risk IN (1,2,3)),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      UNIQUE(org_id, name)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_plugins_org_id ON org_plugins(org_id)`,
  );

  // ── Player bans / mutes ──────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_bans (
      ban_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      action_type TEXT NOT NULL DEFAULT 'ban',
      identifier TEXT NOT NULL,
      identifier_type TEXT NOT NULL,
      category TEXT,
      reason TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      expires_at BIGINT,
      issued_at BIGINT NOT NULL DEFAULT unix_now(),
      issued_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      revoked_at BIGINT,
      revoked_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      CONSTRAINT chk_ban_action_type CHECK (action_type IN ('ban', 'mute')),
      CONSTRAINT chk_ban_identifier_type CHECK (identifier_type IN ('steam_id', 'ip'))
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bans_org_id ON player_bans(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bans_identifier ON player_bans(identifier)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bans_issued_at ON player_bans(issued_at)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ban_server_targets (
      ban_id UUID NOT NULL REFERENCES player_bans(ban_id) ON DELETE CASCADE,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      PRIMARY KEY (ban_id, server_id)
    )
  `);

  // ── External API keys (BattleMetrics / Steam / Proxycheck) per org ─────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_external_api_keys (
      key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      service TEXT NOT NULL,
      key_encrypted TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      priority INT NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      rate_limited_until BIGINT,
      last_used_at BIGINT,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      CONSTRAINT chk_ext_api_key_service
        CHECK (service IN ('battlemetrics', 'steam', 'proxycheck'))
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_external_api_keys_org_service
     ON org_external_api_keys(org_id, service)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_external_api_key_stats (
      key_id                   UUID   NOT NULL REFERENCES org_external_api_keys(key_id) ON DELETE CASCADE,
      bucket_hour              BIGINT NOT NULL,
      org_id                   TEXT   NOT NULL,
      service                  TEXT   NOT NULL,
      rate_limit_max           INT,
      rate_limit_min_remaining INT,
      sample_count             INT    NOT NULL DEFAULT 1,
      PRIMARY KEY (key_id, bucket_hour)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ext_api_key_stats_org_bucket
     ON org_external_api_key_stats(org_id, bucket_hour DESC)`,
  );

  // ── Player data cache tables ───────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_cache (
      steam_id TEXT PRIMARY KEY,
      display_name TEXT,
      avatar_url TEXT,
      steam_profile_visibility TEXT,
      steam_profile_created_at BIGINT,
      steam_rust_hours NUMERIC(10,1),
      steam_data_public BOOLEAN NOT NULL DEFAULT TRUE,
      bm_id TEXT,
      bm_profile_created_at BIGINT,
      bm_private BOOLEAN NOT NULL DEFAULT FALSE,
      bm_rust_hours NUMERIC(10,1),
      bm_aimtrain_hours NUMERIC(10,1),
      bm_server_count INT NOT NULL DEFAULT 0,
      bm_rust_bans_count INT NOT NULL DEFAULT 0,
      bm_rust_bans_last_ban BIGINT,
      bm_rust_bans_banned BOOLEAN NOT NULL DEFAULT FALSE,
      bm_cheating_reports INT NOT NULL DEFAULT 0,
      bm_teaming_reports INT NOT NULL DEFAULT 0,
      bm_other_reports INT NOT NULL DEFAULT 0,
      bm_kills INT NOT NULL DEFAULT 0,
      bm_deaths INT NOT NULL DEFAULT 0,
      steam_cached_at BIGINT,
      bm_cached_at BIGINT,
      activity_cached_at BIGINT,
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_cache_bm_id ON player_cache(bm_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_cache_expires ON player_cache(cache_expires_at)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_bm_sessions (
      steam_id TEXT NOT NULL,
      bm_server_id TEXT NOT NULL,
      server_name TEXT,
      hours_played NUMERIC(10,1) NOT NULL DEFAULT 0,
      last_seen BIGINT,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (steam_id, bm_server_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bm_sessions_steam_id
     ON player_bm_sessions(steam_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_friends_meta (
      steam_id TEXT PRIMARY KEY,
      friends_public BOOLEAN NOT NULL DEFAULT TRUE,
      friend_count INT NOT NULL DEFAULT 0,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_friends (
      steam_id TEXT NOT NULL,
      friend_steam_id TEXT NOT NULL,
      first_seen BIGINT NOT NULL DEFAULT unix_now(),
      last_confirmed BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (steam_id, friend_steam_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_friends_steam_id
     ON player_friends(steam_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_ip_history (
      id BIGSERIAL PRIMARY KEY,
      steam_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      server_id UUID REFERENCES servers(server_id) ON DELETE SET NULL,
      server_name TEXT,
      is_vpn BOOLEAN,
      first_seen BIGINT NOT NULL DEFAULT unix_now(),
      last_seen BIGINT NOT NULL DEFAULT unix_now(),
      UNIQUE(steam_id, ip_address)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_ip_history_steam_id
     ON player_ip_history(steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_ip_history_ip_address
     ON player_ip_history(ip_address)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ip_metadata (
      ip_address TEXT PRIMARY KEY,
      is_proxy BOOLEAN,
      is_vpn BOOLEAN,
      isp TEXT,
      country TEXT,
      asn TEXT,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_related_accounts (
      steam_id TEXT NOT NULL,
      related_bm_id TEXT NOT NULL,
      related_name TEXT,
      match_count INT NOT NULL DEFAULT 1,
      has_bm_bans BOOLEAN NOT NULL DEFAULT FALSE,
      bm_ban_count INT NOT NULL DEFAULT 0,
      has_eac_bans BOOLEAN NOT NULL DEFAULT FALSE,
      eac_last_ban BIGINT,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000,
      PRIMARY KEY (steam_id, related_bm_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_related_accounts_steam_id
     ON player_related_accounts(steam_id)`,
  );

  // ── Alt-detection enrichment (additive) ──────────────────────────────────────
  // Connection classification from proxycheck (residential/business/mobile/
  // proxy_vpn/hosting). Existing rows keep is_proxy/is_vpn; conn_type is finer.
  await pool.query(
    `ALTER TABLE ip_metadata ADD COLUMN IF NOT EXISTS conn_type TEXT`,
  );
  // BattleMetrics name-identifier history for the subject (used for name matching).
  await pool.query(
    `ALTER TABLE player_cache ADD COLUMN IF NOT EXISTS bm_name_aliases JSONB`,
  );
  // Per-related-account evidence computed at refresh time.
  for (const col of [
    `related_steam_id TEXT`,
    `name_aliases JSONB`,
    `name_similarity INT`,
    `shared_ips JSONB`,
    `non_proxy_linked BOOLEAN`,
    `mutual_friends JSONB`,
    `shared_groups JSONB`,
    `server_overlap JSONB`,
    `co_presence JSONB`,
    `alt_confidence TEXT`,
  ]) {
    await pool.query(
      `ALTER TABLE player_related_accounts ADD COLUMN IF NOT EXISTS ${col}`,
    );
  }
  // Raw BM session windows for subject + enriched alts, used to compute temporal
  // co-presence (alt-switching vs co-play). Kept separate from the aggregate
  // player_bm_sessions table which only stores per-server totals.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_session_windows (
      steam_id TEXT NOT NULL,
      bm_server_id TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      stopped_at BIGINT,
      PRIMARY KEY (steam_id, bm_server_id, started_at)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_session_windows_steam_id
     ON player_session_windows(steam_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_bm_bans_cache (
      id BIGSERIAL PRIMARY KEY,
      steam_id TEXT NOT NULL,
      bm_ban_id TEXT NOT NULL UNIQUE,
      bm_org_id TEXT,
      bm_org_name TEXT,
      reason TEXT,
      note TEXT,
      expires_at BIGINT,
      banned_at BIGINT,
      permanent BOOLEAN NOT NULL DEFAULT TRUE,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bm_bans_cache_steam_id
     ON player_bm_bans_cache(steam_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_player_sightings (
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      steam_id TEXT NOT NULL,
      last_seen_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (org_id, steam_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_player_sightings_org_id
     ON org_player_sightings(org_id)`,
  );

  // ── Discord Moderation ────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_messages (
      message_id TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL DEFAULT '',
      author_discord_id TEXT NOT NULL,
      author_username TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      attachments JSONB NOT NULL DEFAULT '[]',
      discord_created_at BIGINT NOT NULL,
      indexed_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (org_id, message_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_messages_org_channel
     ON discord_messages(org_id, channel_id, discord_created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_messages_author
     ON discord_messages(org_id, author_discord_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_messages_indexed_at
     ON discord_messages(indexed_at)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_mod_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      target_discord_id TEXT NOT NULL,
      target_username TEXT NOT NULL DEFAULT '',
      action_type TEXT NOT NULL,
      reason TEXT,
      duration_seconds INTEGER,
      expires_at BIGINT,
      actor_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_mod_log_org_id
     ON discord_mod_log(org_id, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_mod_log_target
     ON discord_mod_log(org_id, target_discord_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_channel_sync (
      channel_id TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      channel_name TEXT NOT NULL DEFAULT '',
      last_message_id TEXT,
      synced_at BIGINT,
      PRIMARY KEY (org_id, channel_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_member_notify_cursor (
      org_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      last_checked_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (org_id, guild_id)
    )
  `);

  await pool.query(`
    ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
  `);

  await pool.query(`
    ALTER TABLE todos ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_blacklisted_words (
      word_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      word TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      UNIQUE (org_id, word)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_blacklisted_words_org_id ON org_blacklisted_words(org_id)`,
  );

  // ── RIPE Atlas network monitoring ─────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ripe_atlas_config (
      org_id              TEXT    PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
      api_key_enc         TEXT    NOT NULL,
      countries           TEXT[]  NOT NULL DEFAULT '{US,GB,DE,FR,NL,SG,AU,JP,BR,CA}',
      probes_per_country  INTEGER NOT NULL DEFAULT 3,
      created_at          BIGINT  NOT NULL DEFAULT unix_now(),
      updated_at          BIGINT  NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ripe_atlas_measurements (
      id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id          TEXT    NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      server_id       UUID    NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      atlas_msm_id    BIGINT  NOT NULL,
      target_ip       TEXT    NOT NULL,
      country         TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending',
      created_at      BIGINT  NOT NULL DEFAULT unix_now(),
      results_fetched_at BIGINT
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ripe_atlas_msm_org_status
     ON org_ripe_atlas_measurements(org_id, status, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ripe_atlas_msm_server
     ON org_ripe_atlas_measurements(server_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ripe_atlas_results (
      id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id           TEXT         NOT NULL,
      server_id        UUID         NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      country          TEXT         NOT NULL,
      reachable        BOOLEAN      NOT NULL,
      avg_rtt          NUMERIC(10,2),
      min_rtt          NUMERIC(10,2),
      max_rtt          NUMERIC(10,2),
      probe_count      INTEGER      NOT NULL DEFAULT 0,
      reachable_count  INTEGER      NOT NULL DEFAULT 0,
      measured_at      BIGINT       NOT NULL
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ripe_atlas_results_server_country
     ON org_ripe_atlas_results(server_id, country, measured_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ripe_atlas_results_org
     ON org_ripe_atlas_results(org_id, measured_at DESC)`,
  );
}

async function migrateTimestampsToUnix() {
  await pool.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT c.table_name, c.column_name, c.column_default
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.data_type = 'timestamp with time zone'
      LOOP
        -- Drop the default first so PostgreSQL can change the type without
        -- trying to cast a TIMESTAMPTZ expression (e.g. NOW()) to BIGINT.
        IF r.column_default IS NOT NULL THEN
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT',
            r.table_name, r.column_name
          );
        END IF;
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I TYPE BIGINT USING EXTRACT(EPOCH FROM %I)::BIGINT',
          r.table_name, r.column_name, r.column_name
        );
        IF r.column_default LIKE '%interval%' OR r.column_default LIKE '%INTERVAL%' THEN
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT unix_now() + 2592000',
            r.table_name, r.column_name
          );
        ELSIF r.column_default IS NOT NULL AND (r.column_default LIKE '%now()%' OR r.column_default LIKE '%NOW()%') THEN
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT unix_now()',
            r.table_name, r.column_name
          );
        END IF;
      END LOOP;
    END $$
  `);
}

async function migratePterodactylApiKeys() {
  const key = getPterodactylEncryptionKey();
  if (!key) return;

  const { rows } = await pool.query(
    `SELECT org_id, api_key
     FROM ptero_api_keys
     WHERE api_key IS NOT NULL
       AND COALESCE(api_key_encrypted, '') = ''`,
  );

  for (const row of rows) {
    const encrypted = encryptPterodactylApiKey(String(row.api_key));
    await pool.query(
      `UPDATE ptero_api_keys
       SET api_key_encrypted = $2,
           api_key = NULL,
           updated_at = unix_now()
       WHERE org_id = $1`,
      [String(row.org_id), encrypted],
    );
  }
}

async function loadPterodactylCredentials(orgId) {
  const keyRow = await pool.query(
    `SELECT panel_url, api_key, api_key_encrypted
     FROM ptero_api_keys
     WHERE org_id = $1
     LIMIT 1`,
    [orgId],
  );
  if (!keyRow.rows[0]) return null;

  const row = keyRow.rows[0];
  let apiKey = null;

  if (row.api_key_encrypted) {
    apiKey = decryptPterodactylApiKey(String(row.api_key_encrypted));
  } else if (row.api_key) {
    apiKey = String(row.api_key);
    const encrypted = encryptPterodactylApiKey(apiKey);
    await pool.query(
      `UPDATE ptero_api_keys
       SET api_key_encrypted = $2,
           api_key = NULL,
           updated_at = unix_now()
       WHERE org_id = $1`,
      [orgId, encrypted],
    );
  }

  if (!apiKey) throw new Error("pterodactyl_api_key_missing");

  return {
    panelUrl: String(row.panel_url),
    apiKey,
  };
}

async function ensureRolePermissionSeed() {
  await pool.query(
    `INSERT INTO roles (role_id, role_name)
     VALUES
      ('org_member', 'Member'),
      ('org_admin', 'Admin'),
      ('org_owner', 'Owner'),
      ('org_disabled', 'Disabled')
     ON CONFLICT (role_id) DO UPDATE SET role_name = EXCLUDED.role_name`,
  );

  await pool.query(
    `INSERT INTO permissions (permission_id, permission_name)
     VALUES
      ('todo_read',           'View todos'),
      ('todo_write',          'Create and edit todos'),
      ('todo_delete',         'Delete todos'),
      ('org_manage',          'Manage organization members'),
      ('role_create',         'Create and manage custom roles'),
      ('rcon_access',         'Use RCON console'),
      ('scripts_view',        'View RCON scripts'),
      ('scripts_manage',      'Manage RCON scripts'),
      ('presets_manage',      'Manage server presets'),
      ('status_view',         'View server status'),
      ('servers_manage',      'Manage server connections'),
      ('tickets_view',        'View support tickets'),
      ('tickets_manage',      'Manage and respond to tickets'),
      ('tickets_player_intel','View player intelligence panel in tickets'),
      ('ban_configs_manage',  'Manage ban and mute configurations'),
      ('toxicity_manage',     'Manage toxicity filters'),
      ('predefines_manage',   'Manage ticket pre-defines'),
      ('bans_delete',         'Delete and revoke bans'),
      ('players_view',        'View player lookup and player list'),
      ('ip_read',             'View player IP addresses and location'),
      ('bans_manage',         'Issue and manage bans and mutes'),
      ('triggers_manage',     'Configure threat triggers'),
      ('discord_mod',         'Use Discord moderation')
     ON CONFLICT (permission_id) DO UPDATE SET permission_name = EXCLUDED.permission_name`,
  );

  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     VALUES
      ('org_member', 'todo_write'),
      ('org_admin', 'todo_write'),
      ('org_admin', 'todo_delete'),
      ('org_admin', 'org_manage'),
      ('org_owner', 'todo_write'),
      ('org_owner', 'todo_delete'),
      ('org_owner', 'org_manage'),
      ('org_owner', 'role_create')
     ON CONFLICT (role_id, permission_id) DO NOTHING`,
  );
}

async function migrateLegacyData() {
  const legacyOrgsExists = await pool.query(
    `SELECT to_regclass('public.orgs') IS NOT NULL AS exists`,
  );
  if (!legacyOrgsExists.rows[0]?.exists) return;

  const { rows: legacyOrgs } = await pool.query(
    "SELECT org_id, guild_id, discord_ids FROM orgs",
  );
  for (const org of legacyOrgs) {
    const orgId = String(org.org_id);
    const guildId = org.guild_id == null ? null : String(org.guild_id);

    await pool.query(
      `INSERT INTO organizations (org_id, guild_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id)
       DO UPDATE SET guild_id = COALESCE(EXCLUDED.guild_id, organizations.guild_id),
                     name = COALESCE(organizations.name, EXCLUDED.name)`,
      [orgId, guildId, orgId],
    );

    for (const discordId of parseMaybeList(org.discord_ids)) {
      const existing = await getUserByDiscordId(discordId);
      const userId = existing?.userId ?? crypto.randomUUID();

      if (!existing) {
        await pool.query(
          `INSERT INTO users (user_id, username, discord_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (discord_id) DO NOTHING`,
          [userId, `user_${discordId.slice(-6)}`, discordId],
        );
      }

      const resolved = existing ?? (await getUserByDiscordId(discordId));
      if (!resolved) continue;

      await pool.query(
        `INSERT INTO organization_members (org_id, user_id, role_id)
         VALUES ($1, $2, 'org_member')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [orgId, resolved.userId],
      );
    }
  }

  const legacyOrgAdminsExists = await pool.query(
    `SELECT to_regclass('public.org_admins') IS NOT NULL AS exists`,
  );
  if (legacyOrgAdminsExists.rows[0]?.exists) {
    const { rows } = await pool.query(
      "SELECT org_id, discord_id FROM org_admins",
    );
    for (const row of rows) {
      const orgId = String(row.org_id);
      const discordId = String(row.discord_id);
      const user = await getUserByDiscordId(discordId);
      if (!user) continue;

      await pool.query(
        `INSERT INTO organization_members (org_id, user_id, role_id)
         VALUES ($1, $2, 'org_admin')
         ON CONFLICT (org_id, user_id)
         DO UPDATE SET role_id = 'org_admin'`,
        [orgId, user.userId],
      );
    }
  }

  const legacyTodoExists = await pool.query(
    `SELECT to_regclass('public.todo') IS NOT NULL AS exists`,
  );
  if (legacyTodoExists.rows[0]?.exists) {
    const { rows } = await pool.query(
      `SELECT todo_id, todo_heading, todo_description, todo_status, assigned_to, org_id, created_unix, completed_unix, created_by
       FROM todo`,
    );

    for (const row of rows) {
      const todoId = String(row.todo_id);
      if (!/^[0-9a-fA-F-]{36}$/.test(todoId)) continue;

      const assignedUser = row.assigned_to
        ? await getUserByDiscordId(String(row.assigned_to))
        : null;
      const createdByUser = row.created_by
        ? await getUserByDiscordId(String(row.created_by))
        : null;

      const createdAt = Number.isFinite(Number(row.created_unix))
        ? Number(row.created_unix)
        : Math.floor(Date.now() / 1000);
      const completedAt = Number.isFinite(Number(row.completed_unix))
        ? Number(row.completed_unix)
        : null;

      await pool.query(
        `INSERT INTO todos (todo_id, org_id, title, description, status, created_by, assigned_to, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, unix_now(), $9)
         ON CONFLICT (todo_id) DO NOTHING`,
        [
          todoId,
          String(row.org_id),
          String(row.todo_heading),
          row.todo_description == null ? "" : String(row.todo_description),
          row.todo_status == null ? "todo" : String(row.todo_status),
          createdByUser?.userId ?? null,
          assignedUser?.userId ?? null,
          createdAt,
          completedAt,
        ],
      );
    }
  }
}

async function ensureSysadminSeed() {
  await pool.query(
    `INSERT INTO organizations (org_id, guild_id, name)
     VALUES ($1, NULL, 'Global')
     ON CONFLICT (org_id) DO UPDATE SET name = EXCLUDED.name`,
    [SYSADMIN.globalOrgId],
  );

  const sysAdminDiscordId = env.sysAdminDiscordId?.trim();
  const sysAdminSteamId = env.sysAdminSteamId?.trim();

  if (!sysAdminDiscordId || !sysAdminSteamId) {
    throw new Error(
      "SYSADMIN_STEAM_ID and SYS_ADMIN_DISCORD_ID must be set to seed the sysadmin account",
    );
  }

  const existingRes = await pool.query(
    `SELECT user_id
     FROM users
     WHERE discord_id = $1 OR steam_id = $2
     LIMIT 1`,
    [sysAdminDiscordId, sysAdminSteamId],
  );

  const existing = existingRes.rows[0];
  let userId;
  if (existing) {
    userId = String(existing.user_id);
    await pool.query(
      `UPDATE users
       SET username = $2,
           discord_id = $3,
           steam_id = $4,
           updated_at = unix_now()
       WHERE user_id = $1`,
      [userId, SYSADMIN.username, sysAdminDiscordId, sysAdminSteamId],
    );
  } else {
    userId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (user_id, username, discord_id, steam_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, SYSADMIN.username, sysAdminDiscordId, sysAdminSteamId],
    );
  }

  await pool.query(
    `INSERT INTO organization_members (org_id, user_id, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id)
     DO UPDATE SET role_id = EXCLUDED.role_id`,
    [SYSADMIN.globalOrgId, userId, SYSADMIN.sysadminRoleId],
  );
}

async function pingDependencies() {
  await pool.query("SELECT 1");
  await redis.ping();
  await queue.waitUntilReady();
}

async function loadUserAccess(userId) {
  const { rows } = await pool.query(
    `SELECT om.org_id, om.role_id, rp.permission_id
     FROM organization_members om
     LEFT JOIN role_permissions rp ON rp.role_id = om.role_id
     WHERE om.user_id = $1`,
    [userId],
  );

  const permissions = new Set();
  const orgAdminOrgIds = new Set();
  const orgOwnerOrgIds = new Set();
  const orgPermissionsMap = {};

  for (const row of rows) {
    const orgId = String(row.org_id);
    const roleId = String(row.role_id);
    const permissionId =
      row.permission_id == null ? null : String(row.permission_id);

    if (permissionId) {
      permissions.add(permissionId);
      if (!orgPermissionsMap[orgId]) orgPermissionsMap[orgId] = new Set();
      orgPermissionsMap[orgId].add(permissionId);
    }

    if (
      orgId !== SYSADMIN.globalOrgId &&
      (roleId === "org_admin" || roleId === "org_owner")
    ) {
      orgAdminOrgIds.add(orgId);
    }

    if (orgId !== SYSADMIN.globalOrgId && roleId === "org_owner") {
      orgOwnerOrgIds.add(orgId);
    }
  }

  const canWrite = permissions.has("todo_write");
  const canDeleteBans = permissions.has("bans_delete");
  const groups = [
    {
      groupId: "member",
      admin: false,
      editUsers: permissions.has("org_manage"),
      editGroups: permissions.has("role_create"),
    },
  ];

  const orgPermissions = Object.fromEntries(
    Object.entries(orgPermissionsMap).map(([orgId, set]) => [orgId, Array.from(set)]),
  );

  return {
    groups,
    globalAdmin: false,
    canWrite,
    canDeleteBans,
    orgAdminOrgIds: Array.from(orgAdminOrgIds),
    orgOwnerOrgIds: Array.from(orgOwnerOrgIds),
    orgPermissions,
  };
}

async function init() {
  if (initialized) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    if (
      !env.databaseUrl ||
      !env.redisUrl ||
      !env.jwtSecret ||
      !env.sysAdminDiscordId?.trim()
    ) {
      throw new Error(
        "Required environment variables are missing for API startup (DATABASE_URL/POSTGRESQL_URI, REDIS_URL/REDIS_URI, JWT_SECRET, SYS_ADMIN_DISCORD_ID).",
      );
    }

    pool = new Pool({
      connectionString: env.databaseUrl,
      max: Number(process.env.PG_POOL_MAX ?? 20),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5000),
    });

    redis = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });

    const bullRedis = new Redis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    queue = new Queue("panel-jobs", {
      connection: bullRedis,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });

    await ensureSchema();
    await migrateTimestampsToUnix();
    await migratePterodactylApiKeys();
    await ensureRolePermissionSeed();
    await migrateLegacyData();
    await pingDependencies();

    initialized = true;
    initError = null;
    console.info("[startup] PostgreSQL, Redis, and BullMQ are reachable.");

    setInterval(() => {
      triggerRipeAtlasMeasurements().catch((e) =>
        console.error("[ripe-atlas] measure job:", e.message),
      );
    }, 5 * 60 * 1000);
    setInterval(() => {
      fetchPendingRipeAtlasResults().catch((e) =>
        console.error("[ripe-atlas] results job:", e.message),
      );
    }, 2 * 60 * 1000);
  })().catch((error) => {
    initError = error;
    console.error("[startup] dependency ping failed", error);
    throw error;
  });

  return initializationPromise;
}

async function createSessionForUser(user, options = {}) {
  const access = await loadUserAccess(user.userId);

  const sid = crypto.randomUUID();
  const token = jwt.sign({ sid }, env.jwtSecret, {
    expiresIn: env.sessionTtlSeconds,
  });
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const ipAddress = options.ipAddress ?? null;
  const userAgent = options.userAgent ?? null;
  const expiresAt = Math.floor(Date.now() / 1000) + env.sessionTtlSeconds;

  const session = {
    userId: String(user.userId),
    username: String(user.username),
    discordId: String(user.discordId),
    steamId: user.steamId == null ? null : String(user.steamId),
    groups: access.groups,
    orgAdminOrgIds: access.orgAdminOrgIds,
    orgOwnerOrgIds: access.orgOwnerOrgIds,
    orgPermissions: access.orgPermissions,
    globalAdmin: access.globalAdmin,
    canWrite: access.canWrite,
    canDeleteBans: access.canDeleteBans,
  };

  await redis.set(
    `session:${sid}`,
    JSON.stringify(session),
    "EX",
    env.sessionTtlSeconds,
  );
  await pool.query(
    `INSERT INTO sessions (session_id, user_id, token_hash, created_at, expires_at, ip_address, user_agent, revoked)
     VALUES ($1, $2, $3, unix_now(), $4, $5, $6, FALSE)`,
    [
      sid,
      session.userId,
      tokenHash,
      expiresAt,
      ipAddress,
      userAgent,
    ],
  );

  if (options.redirectTo) {
    const headers = clearPendingLinkHeaders(new Headers());
    headers.append("set-cookie", sessionCookie(token, env.sessionTtlSeconds));
    return redirect(options.redirectTo, headers);
  }

  const response = json({
    ok: true,
    user: {
      userId: session.userId,
      username: session.username,
      discordId: session.discordId,
      steamId: session.steamId,
      groups: session.groups,
      orgAdminOrgIds: session.orgAdminOrgIds,
    },
  });

  response.headers.append(
    "set-cookie",
    sessionCookie(token, env.sessionTtlSeconds),
  );
  return response;
}

async function getSession(request) {
  const cookies = parseCookie(request.headers.get("cookie") ?? "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    const sid = decoded?.sid;
    if (!sid || typeof sid !== "string") return null;

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const dbSessionRes = await pool.query(
      `SELECT session_id
       FROM sessions
       WHERE session_id = $1
         AND token_hash = $2
         AND revoked = FALSE
         AND expires_at > unix_now()
       LIMIT 1`,
      [sid, tokenHash],
    );
    if (!dbSessionRes.rows[0]) return null;

    const raw = await redis.get(`session:${sid}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function requireSession(request) {
  const session = await getSession(request);
  if (!session) {
    return { error: json({ error: "Unauthorized" }, 401) };
  }
  return { session };
}

async function listUserOrganizations(userId) {
  const { rows } = await pool.query(
    `SELECT o.org_id,
            o.guild_id,
            o.name,
            COALESCE(array_agg(DISTINCT u.discord_id) FILTER (WHERE u.discord_id IS NOT NULL), '{}') AS discord_ids
     FROM organizations o
     JOIN organization_members self_m ON self_m.org_id = o.org_id
     LEFT JOIN organization_members all_m ON all_m.org_id = o.org_id
     LEFT JOIN users u ON u.user_id = all_m.user_id
     WHERE self_m.user_id = $1
       AND o.org_id <> $2
       AND self_m.role_id != 'org_disabled'
     GROUP BY o.org_id, o.guild_id, o.name
     ORDER BY o.org_id`,
    [userId, SYSADMIN.globalOrgId],
  );

  return rows.map((row) => ({
    orgId: String(row.org_id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    name: row.name == null ? null : String(row.name),
    discordIds: Array.isArray(row.discord_ids)
      ? row.discord_ids.filter(Boolean).map(String)
      : [],
  }));
}

async function listAllOrganizations() {
  const { rows } = await pool.query(
    `SELECT o.org_id,
            o.guild_id,
            o.name,
            COALESCE(array_agg(DISTINCT u.discord_id) FILTER (WHERE u.discord_id IS NOT NULL), '{}') AS discord_ids
     FROM organizations o
     LEFT JOIN organization_members all_m ON all_m.org_id = o.org_id
     LEFT JOIN users u ON u.user_id = all_m.user_id
     WHERE o.org_id <> $1
     GROUP BY o.org_id, o.guild_id, o.name
     ORDER BY o.org_id`,
    [SYSADMIN.globalOrgId],
  );

  return rows.map((row) => ({
    orgId: String(row.org_id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    name: row.name == null ? null : String(row.name),
    discordIds: Array.isArray(row.discord_ids)
      ? row.discord_ids.filter(Boolean).map(String)
      : [],
  }));
}

async function loadUsersByOrgIds(orgIds) {
  if (!orgIds.length) return [];

  const { rows } = await pool.query(
    `SELECT DISTINCT u.user_id, u.username, u.discord_id, u.steam_id
     FROM users u
     JOIN organization_members om ON om.user_id = u.user_id
     WHERE om.org_id = ANY($1::text[])
       AND om.org_id <> $2`,
    [orgIds, SYSADMIN.globalOrgId],
  );

  return rows.map((row) => ({
    userId: String(row.user_id),
    username: String(row.username),
    discordId: row.discord_id == null ? null : String(row.discord_id),
    steamId: row.steam_id == null ? null : String(row.steam_id),
  }));
}

async function getUserByDiscordId(discordId) {
  const { rows } = await pool.query(
    `SELECT user_id, username, discord_id, steam_id
     FROM users
     WHERE discord_id = $1
     LIMIT 1`,
    [discordId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    username: String(row.username),
    discordId: String(row.discord_id),
    steamId: row.steam_id == null ? null : String(row.steam_id),
  };
}

async function fetchDiscordGuildMember(guildId, discordId) {
  if (!env.discordBotToken || !guildId) return null;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
      { headers: { Authorization: `Bot ${env.discordBotToken}` } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    // Prefer server nickname, then global_name, then username
    return data.nick || data.user?.global_name || data.user?.username || null;
  } catch {
    return null;
  }
}

async function getTodoRowsForOrgs(orgIds, userId, adminOrgIds = []) {
  if (!orgIds.length) return [];

  const { rows } = await pool.query(
    `SELECT t.todo_id,
            t.title,
            t.description,
            t.status,
            t.priority,
            t.is_public,
            assignee.discord_id AS assignee_discord_id,
            t.org_id,
            t.created_at AS created_unix,
            t.completed_at AS completed_unix,
            creator.discord_id AS created_by_discord_id
     FROM todos t
     LEFT JOIN users assignee ON assignee.user_id = t.assigned_to
     LEFT JOIN users creator ON creator.user_id = t.created_by
     WHERE t.org_id = ANY($1::text[])
       AND (
         t.is_public = true
         OR t.assigned_to = $2
         OR t.created_by = $2
         OR t.org_id = ANY($3::text[])
       )
     ORDER BY t.created_at DESC`,
    [orgIds, userId, adminOrgIds.length ? adminOrgIds : ["__never__"]],
  );

  return rows.map((row) => ({
    id: String(row.todo_id),
    title: String(row.title),
    details: row.description == null ? "" : String(row.description),
    status: row.status == null ? "todo" : String(row.status),
    priority: row.priority == null ? "medium" : String(row.priority),
    isPublic: Boolean(row.is_public),
    assigneeDiscordId:
      row.assignee_discord_id == null ? null : String(row.assignee_discord_id),
    orgId: row.org_id == null ? "" : String(row.org_id),
    createdUnix: Number(row.created_unix ?? 0),
    completedUnix:
      row.completed_unix == null ? null : Number(row.completed_unix),
    createdBy:
      row.created_by_discord_id == null
        ? null
        : String(row.created_by_discord_id),
  }));
}

async function withStartupGuard(handler) {
  try {
    await init();
  } catch {
    return json({ error: "Service dependencies are unavailable." }, 503);
  }

  return handler();
}

async function scanDel(pattern) {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

async function rateLimitLogin(request) {
  if (!redis) return null;

  const ip = getClientIp(request);
  const limiterKey = `rl:login:${ip}`;
  try {
    const attempts = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1, limiterKey, '60',
    );
    if (attempts > env.loginRateLimitPerMinute) {
      return json(
        { error: "Too many login attempts. Try again in a minute." },
        429,
      );
    }
  } catch {
    // Fail-open on limiter backend issues to avoid locking out legitimate users.
    return null;
  }

  return null;
}

async function exchangeDiscordCode(request, code) {
  if (!env.discordClientId || !env.discordClientSecret) {
    throw new Error("discord_config_missing");
  }

  const tokenRes = await fetch(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.discordClientId,
      client_secret: env.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: getDiscordRedirectUri(request),
    }),
  });

  if (!tokenRes.ok) {
    const tokenErrorText = await tokenRes.text();
    console.error("[auth:discord] token exchange failed", {
      status: tokenRes.status,
      redirectUri: getDiscordRedirectUri(request),
      body: tokenErrorText,
    });
    throw new Error("discord_token_exchange_failed");
  }

  const tokenBody = await tokenRes.json();
  if (!tokenBody?.access_token) {
    console.error("[auth:discord] token response missing access_token", {
      redirectUri: getDiscordRedirectUri(request),
      tokenBody,
    });
    throw new Error("discord_token_exchange_failed");
  }

  const userRes = await fetch(DISCORD_ME_URL, {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
  });
  if (!userRes.ok) {
    const userErrorText = await userRes.text();
    console.error("[auth:discord] user lookup failed", {
      status: userRes.status,
      body: userErrorText,
    });
    throw new Error("discord_user_lookup_failed");
  }

  const me = await userRes.json();
  return {
    discordId: String(me.id),
    username: String(
      me.global_name || me.username || `user_${String(me.id).slice(-6)}`,
    ),
  };
}

async function verifySteamResponse(params) {
  const verification = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    verification.append(key, value);
  }
  verification.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: verification.toString(),
  });

  if (!response.ok) {
    throw new Error("Steam verification request failed.");
  }

  const body = await response.text();
  if (!body.includes("is_valid:true")) {
    throw new Error("Steam OpenID validation failed.");
  }
}

async function handleDiscordStart(request) {
  const limited = await rateLimitLogin(request);
  if (limited) return limited;

  if (!env.discordClientId || !env.discordClientSecret) {
    return json({ error: "Discord OAuth is not configured." }, 503);
  }
  if (!env.jwtSecret) {
    return json({ error: "JWT secret is not configured." }, 503);
  }

  const next = sanitizeNext(new URL(request.url).searchParams.get("next"));
  const state = signDiscordState({ next });

  const authorizeParams = new URLSearchParams({
    client_id: env.discordClientId,
    response_type: "code",
    redirect_uri: getDiscordRedirectUri(request),
    scope: "identify",
    state,
  });

  return redirect(`${DISCORD_AUTHORIZE_URL}?${authorizeParams.toString()}`);
}

async function handlePublicDiscordStart(request) {
  const limited = await rateLimitLogin(request);
  if (limited) return limited;

  if (!env.discordClientId || !env.discordClientSecret) {
    return json({ error: "Discord OAuth is not configured." }, 503);
  }
  if (!env.jwtSecret) {
    return json({ error: "JWT secret is not configured." }, 503);
  }

  const url = new URL(request.url);
  const org = String(url.searchParams.get("org") ?? "").trim();
  const next = org ? `/support?org=${encodeURIComponent(org)}` : "/support";
  const state = signDiscordState({ next, flow: "public" });

  const authorizeParams = new URLSearchParams({
    client_id: env.discordClientId,
    response_type: "code",
    redirect_uri: getDiscordRedirectUri(request),
    scope: "identify",
    state,
  });

  return redirect(`${DISCORD_AUTHORIZE_URL}?${authorizeParams.toString()}`);
}

async function handleDiscordCallback(request) {
  const limited = await rateLimitLogin(request);
  if (limited) return limited;

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return redirect("/login?error=discord_callback_invalid");
  }

  const stateData = verifyDiscordState(state);
  if (!stateData) {
    return redirect("/login?error=discord_state_invalid");
  }

  try {
    const discordUser = await exchangeDiscordCode(request, code);

    try {
      await init();
    } catch {
      return redirect("/login?error=service_unavailable");
    }

    const existingRes = await pool.query(
      "SELECT user_id, username, discord_id, steam_id FROM users WHERE discord_id = $1 LIMIT 1",
      [discordUser.discordId],
    );

    const existing = existingRes.rows[0];
    if (existing?.steam_id) {
      if (String(existing.username) !== discordUser.username) {
        await pool.query(
          "UPDATE users SET username = $1, updated_at = unix_now() WHERE user_id = $2",
          [discordUser.username, String(existing.user_id)],
        );
      }
      return createSessionForUser(
        {
          userId: String(existing.user_id),
          username: discordUser.username,
          discordId: String(existing.discord_id),
          steamId: String(existing.steam_id),
        },
        {
          redirectTo: sanitizeNext(stateData.next),
          ipAddress: getClientIp(request),
          userAgent: request.headers.get("user-agent") ?? null,
        },
      );
    }

    const pendingToken = signPendingLink({
      discordId: discordUser.discordId,
      username: discordUser.username,
      next: sanitizeNext(stateData.next),
    });

    const headers = new Headers();
    headers.append("set-cookie", pendingLinkCookie(pendingToken, 60 * 15));
    const stepUrl =
      stateData.flow === "public" ? "/support?step=steam" : "/login?step=steam";
    return redirect(stepUrl, headers);
  } catch (error) {
    const reason = String(error?.message ?? "discord_auth_failed");
    const known = new Set([
      "discord_config_missing",
      "discord_token_exchange_failed",
      "discord_user_lookup_failed",
    ]);
    const code = known.has(reason) ? reason : "discord_auth_failed";
    return redirect(`/login?error=${encodeURIComponent(code)}`);
  }
}

async function handlePendingLinkStatus(request) {
  const pending = getPendingLink(request);
  return json({ pending });
}

async function handleSteamStart(request) {
  const limited = await rateLimitLogin(request);
  if (limited) return limited;

  const pending = getPendingLink(request);
  if (!pending) {
    return redirect("/login?error=steam_requires_discord");
  }

  const nonce = crypto.randomUUID();
  await redis.set(`openid:steam:${nonce}`, "1", "EX", 60 * 10);

  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": `${getSteamReturnUrl(request)}?nonce=${encodeURIComponent(nonce)}`,
    "openid.realm": getSteamRealm(request),
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });

  return redirect(`${STEAM_OPENID_URL}?${params.toString()}`);
}

async function handleSteamCallback(request) {
  const limited = await rateLimitLogin(request);
  if (limited) return limited;

  const url = new URL(request.url);
  const nonce = String(url.searchParams.get("nonce") ?? "").trim();
  const pending = getPendingLink(request);

  if (!nonce || !pending) {
    return redirect(
      "/login?error=steam_state_invalid",
      clearPendingLinkHeaders(new Headers()),
    );
  }

  const nonceKey = `openid:steam:${nonce}`;
  const nonceExists = await redis.getdel(nonceKey);
  if (!nonceExists) {
    return redirect(
      "/login?error=steam_state_expired",
      clearPendingLinkHeaders(new Headers()),
    );
  }

  try {
    await verifySteamResponse(url.searchParams);
    const claimedId = url.searchParams.get("openid.claimed_id") ?? "";
    const match = claimedId.match(/\/id\/(\d+)$/);
    if (!match) {
      throw new Error("Steam claimed ID missing.");
    }

    const steamId = match[1];
    const conflictingSteam = await pool.query(
      "SELECT user_id, discord_id FROM users WHERE steam_id = $1 LIMIT 1",
      [steamId],
    );
    const conflictingRow = conflictingSteam.rows[0];
    if (
      conflictingRow &&
      String(conflictingRow.discord_id) !== pending.discordId
    ) {
      return redirect(
        "/login?error=steam_already_linked",
        clearPendingLinkHeaders(new Headers()),
      );
    }

    const existingUserRes = await pool.query(
      "SELECT user_id, username, discord_id, steam_id FROM users WHERE discord_id = $1 LIMIT 1",
      [pending.discordId],
    );
    const existingUser = existingUserRes.rows[0];

    if (existingUser) {
      await pool.query(
        `UPDATE users
         SET username = $2,
             steam_id = $3,
             updated_at = unix_now()
         WHERE user_id = $1`,
        [String(existingUser.user_id), pending.username, steamId],
      );

      return createSessionForUser(
        {
          userId: String(existingUser.user_id),
          username: pending.username,
          discordId: pending.discordId,
          steamId,
        },
        {
          redirectTo: pending.next,
          ipAddress: getClientIp(request),
          userAgent: request.headers.get("user-agent") ?? null,
        },
      );
    }

    const userId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO users (user_id, username, discord_id, steam_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, pending.username, pending.discordId, steamId],
      );
    } catch (err) {
      if (err.code === "23505")
        return redirect("/login?error=steam_already_linked", clearPendingLinkHeaders(new Headers()));
      throw err;
    }

    return createSessionForUser(
      {
        userId,
        username: pending.username,
        discordId: pending.discordId,
        steamId,
      },
      {
        redirectTo: pending.next,
        ipAddress: getClientIp(request),
        userAgent: request.headers.get("user-agent") ?? null,
      },
    );
  } catch {
    return redirect(
      "/login?error=steam_auth_failed",
      clearPendingLinkHeaders(new Headers()),
    );
  }
}

async function handleLogout(request) {
  const cookies = parseCookie(request.headers.get("cookie") ?? "");
  const token = cookies[SESSION_COOKIE];
  if (token) {
    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      if (decoded?.sid && typeof decoded.sid === "string") {
        await redis.del(`session:${decoded.sid}`);
        await pool.query(
          "UPDATE sessions SET revoked = TRUE WHERE session_id = $1",
          [decoded.sid],
        );
      }
    } catch {
      // ignore invalid token
    }
  }

  const response = json({ ok: true });
  response.headers.append("set-cookie", sessionCookie("", 0));
  response.headers.append("set-cookie", pendingLinkCookie("", 0));
  return response;
}

async function handleAuthMe(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  // Re-derive access from fresh DB data so role/permission changes and older
  // sessions (created before per-org permissions were stored) are reflected
  // without requiring re-login.
  const freshAccess = await loadUserAccess(session.userId);

  return json({
    user: {
      userId: session.userId,
      username: session.username,
      discordId: session.discordId,
      steamId: session.steamId,
      groups: freshAccess.groups,
      orgAdminOrgIds: freshAccess.orgAdminOrgIds,
      orgOwnerOrgIds: freshAccess.orgOwnerOrgIds ?? [],
      orgPermissions: freshAccess.orgPermissions ?? {},
      globalAdmin: isGlobalAdmin(session),
      isSysAdmin: isConfiguredSysAdmin(session),
    },
  });
}

async function handleUpdateAuthMe(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const username = String(body?.username ?? "").trim();
  if (!username) {
    return json({ error: "username is required" }, 400);
  }
  if (username.length > 64) {
    return json({ error: "username must be 64 characters or fewer" }, 400);
  }

  await pool.query(
    `UPDATE users
     SET username = $2,
         updated_at = unix_now()
     WHERE user_id = $1`,
    [session.userId, username],
  );

  const cookies = parseCookie(request.headers.get("cookie") ?? "");
  const token = cookies[SESSION_COOKIE];
  if (token) {
    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      const sid = decoded?.sid;
      if (sid && typeof sid === "string") {
        const raw = await redis.get(`session:${sid}`);
        if (raw) {
          const cached = JSON.parse(raw);
          cached.username = username;
          await redis.set(`session:${sid}`, JSON.stringify(cached), "KEEPTTL");
        }
      }
    } catch {
      // Ignore invalid session cookie during profile update
    }
  }

  const globalAdmin = isGlobalAdmin(session);
  const isSysAdmin = isConfiguredSysAdmin(session);

  return json({
    ok: true,
    user: {
      userId: session.userId,
      username,
      discordId: session.discordId,
      steamId: session.steamId,
      groups: session.groups,
      orgAdminOrgIds: session.orgAdminOrgIds,
      globalAdmin,
      isSysAdmin,
    },
  });
}

async function handleCreateOrganization(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const sysAdminCheck = requireConfiguredSysAdmin(session);
  if (sysAdminCheck.error) return sysAdminCheck.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const name = String(body?.name ?? "").trim();
  const explicitOrgId = body?.orgId == null ? "" : String(body.orgId).trim();
  const guildId = body?.guildId == null ? null : String(body.guildId).trim();

  if (!name) {
    return json({ error: "name is required" }, 400);
  }

  const derivedOrgId =
    explicitOrgId ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);

  if (!derivedOrgId || !/^[a-z0-9_\-]+$/.test(derivedOrgId)) {
    return json({ error: "orgId is invalid" }, 400);
  }

  if (derivedOrgId === SYSADMIN.globalOrgId) {
    return json({ error: "orgId is reserved" }, 400);
  }

  const existing = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [derivedOrgId],
  );
  if (existing.rows[0]) {
    return json({ error: "Organization ID already exists" }, 409);
  }

  if (guildId) {
    const guildConflict = await pool.query(
      "SELECT org_id FROM organizations WHERE guild_id = $1 LIMIT 1",
      [guildId],
    );
    if (guildConflict.rows[0]) {
      return json(
        { error: "guildId is already linked to an organization" },
        409,
      );
    }
  }

  try {
    await pool.query(
      `INSERT INTO organizations (org_id, guild_id, name)
       VALUES ($1, $2, $3)`,
      [derivedOrgId, guildId || null, name],
    );
  } catch (err) {
    if (err.code === "23505") return json({ error: "Organization ID already exists" }, 409);
    throw err;
  }

  // Make the creator an owner
  await pool.query(
    `INSERT INTO organization_members (org_id, user_id, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id)
     DO UPDATE SET role_id = EXCLUDED.role_id`,
    [derivedOrgId, session.userId, "org_owner"],
  );

  await ensureDefaultTicketTypes(derivedOrgId);

  // Refresh the caller's cached session so orgAdminOrgIds includes the new org
  // immediately — without this the client would see "no orgs" until re-login.
  const cookies = parseCookie(request.headers.get("cookie") ?? "");
  const token = cookies[SESSION_COOKIE];
  if (token) {
    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      const sid = decoded?.sid;
      if (sid && typeof sid === "string") {
        const raw = await redis.get(`session:${sid}`);
        if (raw) {
          const cached = JSON.parse(raw);
          if (!cached.orgAdminOrgIds.includes(derivedOrgId)) {
            cached.orgAdminOrgIds = [...cached.orgAdminOrgIds, derivedOrgId];
          }
          await redis.set(`session:${sid}`, JSON.stringify(cached), "KEEPTTL");
        }
      }
    } catch {
      // Non-fatal: session refresh failed; user can re-login to pick up the change.
    }
  }

  return json(
    {
      ok: true,
      organization: {
        orgId: derivedOrgId,
        guildId: guildId || null,
        name,
      },
    },
    201,
  );
}

async function handleTodoBootstrap(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const userOrgs = await listUserOrganizations(session.userId);
  const orgIds = userOrgs.map((org) => org.orgId);

  const membersCacheKey = `cache:members:${orgIds.sort().join("|")}`;
  let members;

  const cached = await redis.get(membersCacheKey);
  if (cached) {
    try {
      members = JSON.parse(cached);
    } catch {
      members = null;
    }
  }

  if (!members) {
    members = await loadUsersByOrgIds(orgIds);
    await redis.set(membersCacheKey, JSON.stringify(members), "EX", 30);
  }

  const adminOrgIds = [
    ...(session.orgAdminOrgIds ?? []),
    ...(session.orgOwnerOrgIds ?? []),
  ];
  const todos = await getTodoRowsForOrgs(orgIds, session.userId, adminOrgIds);

  // Re-derive access using fresh DB data so stale sessions, role/permission
  // changes, and org owners (who have implicit write access) all get the correct
  // values without requiring re-login. This also backfills older sessions that
  // were created before per-org permissions were stored on the session.
  const freshAccess = await loadUserAccess(session.userId);
  const freshSession = { ...session, ...freshAccess };
  const canWrite = canWriteTodos(freshSession);

  try {
    const cookies = parseCookie(request.headers.get("cookie") ?? "");
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const decoded = jwt.verify(token, env.jwtSecret);
      const sid = decoded?.sid;
      if (sid && typeof sid === "string") {
        const raw = await redis.get(`session:${sid}`);
        if (raw) {
          const cached = JSON.parse(raw);
          cached.canWrite = canWrite;
          cached.canDeleteBans = freshAccess.canDeleteBans;
          cached.orgAdminOrgIds = freshAccess.orgAdminOrgIds;
          cached.orgOwnerOrgIds = freshAccess.orgOwnerOrgIds;
          cached.orgPermissions = freshAccess.orgPermissions;
          cached.groups = freshAccess.groups;
          await redis.set(`session:${sid}`, JSON.stringify(cached), "KEEPTTL");
        }
      }
    }
  } catch {
    // Non-fatal: user can re-login to pick up the change if this fails.
  }

  return json({
    user: {
      userId: session.userId,
      username: session.username,
      discordId: session.discordId,
      steamId: session.steamId,
      groups: freshAccess.groups,
      orgAdminOrgIds: freshAccess.orgAdminOrgIds,
      orgOwnerOrgIds: freshAccess.orgOwnerOrgIds ?? [],
      orgPermissions: freshAccess.orgPermissions ?? {},
      isSysAdmin: isConfiguredSysAdmin(session),
      globalAdmin: isConfiguredSysAdmin(session),
    },
    orgs: userOrgs,
    members,
    todos,
    canWrite,
  });
}

async function handleCreateTodo(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const title = String(body?.title ?? "").trim();
  const details = String(body?.details ?? "").trim();
  const assigneeDiscordId =
    body?.assigneeDiscordId == null
      ? null
      : String(body.assigneeDiscordId).trim();
  const orgId = String(body?.orgId ?? "").trim();
  const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
  const priority = VALID_PRIORITIES.includes(body?.priority)
    ? body.priority
    : "medium";
  const isPublic = Boolean(body?.isPublic);

  if (!title || !orgId || !assigneeDiscordId) {
    return json(
      { error: "title, orgId, and assigneeDiscordId are required" },
      400,
    );
  }

  if (!canWriteTodos(session, orgId)) {
    return json({ error: "Forbidden" }, 403);
  }

  const orgs = await listUserOrganizations(session.userId);
  const org = orgs.find((o) => o.orgId === orgId);
  if (!org) {
    return json({ error: "You do not belong to that organization" }, 403);
  }

  const assignee = await getUserByDiscordId(assigneeDiscordId);
  if (!assignee) {
    return json({ error: "Assignee user not found." }, 400);
  }

  const assigneeMember = await pool.query(
    `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
    [orgId, assignee.userId],
  );
  if (!assigneeMember.rows[0]) {
    return json(
      { error: "Assignee Discord ID is not a member of this organization" },
      400,
    );
  }

  const todoId = crypto.randomUUID();
  const createdUnix = nowUnix();
  await pool.query(
    `INSERT INTO todos (todo_id, title, description, status, priority, is_public, assigned_to, org_id, created_by)
     VALUES ($1, $2, $3, 'todo', $4, $5, $6, $7, $8)`,
    [todoId, title, details, priority, isPublic, assignee.userId, orgId, session.userId],
  );

  await queue.add("todo-created", {
    todoId,
    orgId,
    assigneeDiscordId,
    createdByDiscordId: session.discordId,
    createdUnix,
  });

  return json(
    {
      todo: {
        id: todoId,
        title,
        details,
        status: "todo",
        priority,
        isPublic,
        assigneeDiscordId,
        orgId,
        createdUnix,
        completedUnix: null,
        createdBy: session.discordId,
      },
    },
    201,
  );
}

async function handleUpdateTodo(request, todoId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const title = body?.title == null ? null : String(body.title).trim();
  const details = body?.details == null ? null : String(body.details).trim();
  const status = body?.status == null ? null : String(body.status).trim();
  const assigneeDiscordId =
    body?.assigneeDiscordId == null
      ? null
      : String(body.assigneeDiscordId).trim();
  const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
  const priority =
    body?.priority != null && VALID_PRIORITIES.includes(body.priority)
      ? body.priority
      : null;
  const isPublic = body?.isPublic == null ? null : Boolean(body.isPublic);

  const existingRes = await pool.query(
    "SELECT todo_id, org_id, status, completed_at FROM todos WHERE todo_id = $1 LIMIT 1",
    [todoId],
  );
  const existing = existingRes.rows[0];
  if (!existing) return json({ error: "Todo not found" }, 404);

  if (!canWriteTodos(session, String(existing.org_id))) {
    return json({ error: "Forbidden" }, 403);
  }

  const orgs = await listUserOrganizations(session.userId);
  if (!orgs.some((org) => org.orgId === String(existing.org_id))) {
    return json({ error: "Forbidden" }, 403);
  }

  let assigneeUserId = null;
  if (assigneeDiscordId) {
    const assignee = await getUserByDiscordId(assigneeDiscordId);
    if (!assignee) {
      return json({ error: "Assignee user not found." }, 400);
    }
    assigneeUserId = assignee.userId;

    const assigneeMember = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
      [String(existing.org_id), assigneeUserId],
    );
    if (!assigneeMember.rows[0]) {
      return json(
        { error: "Assignee Discord ID is not in this organization" },
        400,
      );
    }
  }

  await pool.query(
    `UPDATE todos
     SET title = COALESCE($2, title),
         description = COALESCE($3, description),
         status = COALESCE($4, status),
         priority = COALESCE($6, priority),
         is_public = COALESCE($7, is_public),
         assigned_to = COALESCE($5, assigned_to),
         completed_at = CASE
           WHEN $4 = 'completed' AND completed_at IS NULL THEN unix_now()
           WHEN $4 IS NOT NULL AND $4 != 'completed' THEN NULL
           ELSE completed_at
         END,
         updated_at = unix_now()
     WHERE todo_id = $1`,
    [todoId, title, details, status, assigneeUserId, priority, isPublic],
  );

  return json({ ok: true });
}

async function handleDeleteTodo(request, todoId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const existingRes = await pool.query(
    "SELECT todo_id, org_id FROM todos WHERE todo_id = $1 LIMIT 1",
    [todoId],
  );
  const existing = existingRes.rows[0];
  if (!existing) return json({ error: "Todo not found" }, 404);

  if (!orgHasPermission(session, String(existing.org_id), "todo_delete")) {
    return json({ error: "Forbidden" }, 403);
  }

  const orgs = await listUserOrganizations(session.userId);
  if (!orgs.some((org) => org.orgId === String(existing.org_id))) {
    return json({ error: "Forbidden" }, 403);
  }

  await pool.query("DELETE FROM todos WHERE todo_id = $1", [todoId]);
  return json({ ok: true });
}

async function handleAddOrgMember(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const discordId = String(body?.discordId ?? "").trim();
  const username = String(body?.username ?? "").trim();
  if (!discordId) {
    return json({ error: "discordId is required" }, 400);
  }

  const orgRes = await pool.query(
    "SELECT org_id, guild_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org) {
    return json({ error: "Organization not found" }, 404);
  }

  let member = await getUserByDiscordId(discordId);
  let wasNewUser = false;
  if (!member) {
    const userId = crypto.randomUUID();
    const guildUsername = await fetchDiscordGuildMember(org.guild_id, discordId);
    const resolvedName = username || guildUsername || `user_${discordId.slice(-6)}`;
    await pool.query(
      `INSERT INTO users (user_id, username, discord_id)
       VALUES ($1, $2, $3)`,
      [userId, resolvedName, discordId],
    );
    member = {
      userId,
      username: resolvedName,
      discordId,
      steamId: null,
    };
    wasNewUser = true;
  }

  const beforeMembership = await pool.query(
    `SELECT role_id FROM organization_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, member.userId],
  );
  const wasAlreadyMember = beforeMembership.rows.length > 0;

  await pool.query(
    `INSERT INTO organization_members (org_id, user_id, role_id)
     VALUES ($1, $2, 'org_member')
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [orgId, member.userId],
  );

  await scanDel("cache:members:*");

  // Audit log
  if (!wasAlreadyMember) {
    await auditLog({
      orgId,
      actorUserId: session.userId,
      targetUserId: member.userId,
      resourceType: "org_member",
      resourceId: member.userId,
      actionType: "ORG_MEMBER_ADDED",
      actionCategory: "staff_management",
      severity: 2,
      metadata: {
        wasNewUser,
        discordId,
        username: member.username,
      },
      afterState: {
        orgId,
        userId: member.userId,
        roleId: "org_member",
      },
    });
  }

  return json({ ok: true, orgId, discordId });
}

async function handleGrantOrgAdmin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin/owner role required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const discordId = String(body?.discordId ?? "").trim();
  if (!discordId) {
    return json({ error: "discordId is required" }, 400);
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org) {
    return json({ error: "Organization not found" }, 404);
  }

  const member = await getUserByDiscordId(discordId);
  if (!member) {
    return json(
      { error: "discordId must be a member of this organization first" },
      400,
    );
  }

  const membershipRes = await pool.query(
    `SELECT role_id FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
    [orgId, member.userId],
  );
  if (!membershipRes.rows[0]) {
    return json(
      { error: "discordId must be a member of this organization first" },
      400,
    );
  }

  const beforeState = membershipRes.rows[0];

  if (
    beforeState.role_id === "org_owner" &&
    !session.orgOwnerOrgIds?.includes(orgId)
  ) {
    return json(
      { error: "Forbidden: only owners can modify an owner account" },
      403,
    );
  }

  await pool.query(
    `UPDATE organization_members
     SET role_id = 'org_admin'
     WHERE org_id = $1 AND user_id = $2`,
    [orgId, member.userId],
  );

  // Audit log
  await auditLog({
    orgId,
    actorUserId: session.userId,
    targetUserId: member.userId,
    resourceType: "org_member",
    resourceId: member.userId,
    actionType: "ORG_ADMIN_GRANTED",
    actionCategory: "staff_management",
    severity: 3,
    metadata: {
      discordId,
      username: member.username,
    },
    beforeState: {
      orgId,
      userId: member.userId,
      roleId: beforeState.role_id,
    },
    afterState: {
      orgId,
      userId: member.userId,
      roleId: "org_admin",
    },
  });

  return json({ ok: true, orgId, discordId });
}

async function handleCreateOrgRole(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "role_create")) {
    return json({ error: "Forbidden: role_create permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const roleName = String(body?.roleName ?? "").trim();
  const permissions = Array.isArray(body?.permissions) ? body.permissions : [];
  const discordRoleIds = Array.isArray(body?.discordRoleIds)
    ? body.discordRoleIds.map((id) => String(id).trim()).filter(Boolean)
    : [];

  if (!roleName) {
    return json({ error: "roleName is required" }, 400);
  }

  // Verify org exists
  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) {
    return json({ error: "Organization not found" }, 404);
  }

  // Generate a role ID based on org and role name
  const roleId =
    `${orgId}_${roleName.toLowerCase().replace(/\s+/g, "_")}`.slice(0, 64);

  // Check if role already exists
  const existingRole = await pool.query(
    "SELECT role_id FROM roles WHERE role_id = $1 LIMIT 1",
    [roleId],
  );
  if (existingRole.rows[0]) {
    return json({ error: "A role with this name already exists" }, 409);
  }

  // Create the role
  try {
    await pool.query(
      `INSERT INTO roles (role_id, role_name)
       VALUES ($1, $2)`,
      [roleId, roleName],
    );
  } catch (err) {
    if (err.code === "23505") {
      return json({ error: "A role with this name already exists" }, 409);
    }
    throw err;
  }

  // Add permissions to the role
  if (permissions.length > 0) {
    const filteredPermissions = permissions.filter((p) =>
      ASSIGNABLE_PERMISSIONS.includes(String(p).trim()),
    );

    // Prevent privilege escalation: custom role_create users cannot grant
    // permissions they don't hold themselves.
    if (!isGlobalAdmin(session) && !canManageOrg(session, orgId)) {
      const userPerms = new Set(session.orgPermissions?.[orgId] ?? []);
      const escalated = filteredPermissions.filter((p) => !userPerms.has(p));
      if (escalated.length > 0) {
        return json({ error: "Cannot grant permissions you do not hold" }, 403);
      }
    }

    if (filteredPermissions.length > 0) {
      for (const permission of filteredPermissions) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT (role_id, permission_id) DO NOTHING`,
          [roleId, permission],
        );
      }
    }
  }

  // Link Discord roles
  for (const discordRoleId of discordRoleIds) {
    await pool.query(
      `INSERT INTO role_discord_roles (role_id, discord_role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [roleId, discordRoleId],
    );
  }

  // Audit log
  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "role",
    resourceId: roleId,
    actionType: "ROLE_CREATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: {
      roleName,
      roleId,
      permissions,
      discordRoleIds,
    },
  });

  return json(
    {
      ok: true,
      role: {
        roleId,
        roleName,
        orgId,
        permissions,
        discordRoleIds,
      },
    },
    201,
  );
}

async function handleListOrgRoles(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "role_create") && !orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: role_create or org_manage permission required" }, 403);
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  const { rows } = await pool.query(
    `SELECT r.role_id, r.role_name,
            COALESCE(array_agg(DISTINCT rp.permission_id ORDER BY rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '{}') AS permissions,
            COALESCE(array_agg(DISTINCT ttr.ticket_type_id ORDER BY ttr.ticket_type_id) FILTER (WHERE ttr.ticket_type_id IS NOT NULL), '{}') AS ticket_type_ids,
            COALESCE(array_agg(DISTINCT rdr.discord_role_id ORDER BY rdr.discord_role_id) FILTER (WHERE rdr.discord_role_id IS NOT NULL), '{}') AS discord_role_ids
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
     LEFT JOIN ticket_type_roles ttr ON ttr.role_id = r.role_id
     LEFT JOIN role_discord_roles rdr ON rdr.role_id = r.role_id
     WHERE r.role_id LIKE ($1 || '_%')
       AND r.role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
     GROUP BY r.role_id, r.role_name
     ORDER BY r.role_name ASC`,
    [orgId],
  );

  return json({
    roles: rows.map((row) => ({
      roleId: String(row.role_id),
      roleName: String(row.role_name),
      permissions: Array.isArray(row.permissions) ? row.permissions : [],
      ticketTypeIds: Array.isArray(row.ticket_type_ids)
        ? row.ticket_type_ids.map(Number)
        : [],
      discordRoleIds: Array.isArray(row.discord_role_ids)
        ? row.discord_role_ids
        : [],
    })),
  });
}

async function handleUpdateOrgRole(request, orgId, roleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "role_create")) {
    return json({ error: "Forbidden: role_create permission required" }, 403);
  }

  if (!roleId.startsWith(`${orgId}_`)) {
    return json({ error: "Role does not belong to this organization" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const roleExists = await pool.query(
    `SELECT role_id FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  if (!roleExists.rows[0]) return json({ error: "Role not found" }, 404);

  if (body?.roleName !== undefined) {
    const roleName = String(body.roleName).trim();
    if (!roleName) return json({ error: "roleName cannot be empty" }, 400);
    if (roleName.length > 64) return json({ error: "roleName too long" }, 400);
    await pool.query(`UPDATE roles SET role_name = $1 WHERE role_id = $2`, [
      roleName,
      roleId,
    ]);
  }

  const hasPermissions = Array.isArray(body?.permissions);
  const hasTicketTypes = Array.isArray(body?.ticketTypeIds);
  const hasDiscordRoles = Array.isArray(body?.discordRoleIds);

  if (hasPermissions || hasTicketTypes || hasDiscordRoles) {
    let filteredPerms = [];
    if (hasPermissions) {
      filteredPerms = body.permissions
        .map((p) => String(p).trim())
        .filter((p) => ASSIGNABLE_PERMISSIONS.includes(p));

      // Prevent privilege escalation: custom role_create users cannot grant
      // permissions they don't hold themselves, but may preserve ones already
      // on the role that were set by someone with higher access.
      if (!isGlobalAdmin(session) && !canManageOrg(session, orgId)) {
        const userPerms = new Set(session.orgPermissions?.[orgId] ?? []);
        const currentPermsRes = await pool.query(
          `SELECT permission_id FROM role_permissions WHERE role_id = $1`,
          [roleId],
        );
        const currentPerms = new Set(
          currentPermsRes.rows.map((r) => String(r.permission_id)),
        );
        const escalated = filteredPerms.filter(
          (p) => !userPerms.has(p) && !currentPerms.has(p),
        );
        if (escalated.length > 0) {
          return json({ error: "Cannot grant permissions you do not hold" }, 403);
        }
      }
    }

    let validTypeIds = [];
    if (hasTicketTypes) {
      const rawIds = body.ticketTypeIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);
      if (rawIds.length > 0) {
        const typeRes = await pool.query(
          `SELECT ticket_type_id FROM ticket_types WHERE org_id = $1 AND ticket_type_id = ANY($2)`,
          [orgId, rawIds],
        );
        validTypeIds = typeRes.rows.map((r) => Number(r.ticket_type_id));
      }
    }

    const filteredDiscordRoleIds = hasDiscordRoles
      ? body.discordRoleIds.map((id) => String(id).trim()).filter(Boolean)
      : [];

    const client = await pool.connect();
    try {
      await client.query(`BEGIN`);
      if (hasPermissions) {
        await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [
          roleId,
        ]);
        for (const permId of filteredPerms) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [roleId, permId],
          );
        }
      }
      if (hasTicketTypes) {
        await client.query(`DELETE FROM ticket_type_roles WHERE role_id = $1`, [
          roleId,
        ]);
        for (const typeId of validTypeIds) {
          await client.query(
            `INSERT INTO ticket_type_roles (ticket_type_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [typeId, roleId],
          );
        }
      }
      if (hasDiscordRoles) {
        await client.query(`DELETE FROM role_discord_roles WHERE role_id = $1`, [
          roleId,
        ]);
        for (const discordRoleId of filteredDiscordRoleIds) {
          await client.query(
            `INSERT INTO role_discord_roles (role_id, discord_role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [roleId, discordRoleId],
          );
        }
      }
      await client.query(`COMMIT`);
    } catch (err) {
      await client.query(`ROLLBACK`);
      throw err;
    } finally {
      client.release();
    }
  }

  const { rows } = await pool.query(
    `SELECT r.role_id, r.role_name,
            COALESCE(array_agg(DISTINCT rp.permission_id ORDER BY rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '{}') AS permissions,
            COALESCE(array_agg(DISTINCT ttr.ticket_type_id ORDER BY ttr.ticket_type_id) FILTER (WHERE ttr.ticket_type_id IS NOT NULL), '{}') AS ticket_type_ids,
            COALESCE(array_agg(DISTINCT rdr.discord_role_id ORDER BY rdr.discord_role_id) FILTER (WHERE rdr.discord_role_id IS NOT NULL), '{}') AS discord_role_ids
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
     LEFT JOIN ticket_type_roles ttr ON ttr.role_id = r.role_id
     LEFT JOIN role_discord_roles rdr ON rdr.role_id = r.role_id
     WHERE r.role_id = $1
     GROUP BY r.role_id, r.role_name`,
    [roleId],
  );

  const role = rows[0];
  return json({
    ok: true,
    role: {
      roleId: String(role.role_id),
      roleName: String(role.role_name),
      permissions: Array.isArray(role.permissions) ? role.permissions : [],
      ticketTypeIds: Array.isArray(role.ticket_type_ids)
        ? role.ticket_type_ids.map(Number)
        : [],
      discordRoleIds: Array.isArray(role.discord_role_ids)
        ? role.discord_role_ids
        : [],
    },
  });
}

async function handleDeleteOrgRole(request, orgId, roleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "role_create")) {
    return json({ error: "Forbidden: role_create permission required" }, 403);
  }

  if (!roleId.startsWith(`${orgId}_`)) {
    return json({ error: "Role does not belong to this organization" }, 403);
  }

  const roleExists = await pool.query(
    `SELECT role_id FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  if (!roleExists.rows[0]) return json({ error: "Role not found" }, 404);

  // Reassign members on this custom role back to org_member
  await pool.query(
    `UPDATE organization_members SET role_id = 'org_member'
     WHERE org_id = $1 AND role_id = $2`,
    [orgId, roleId],
  );

  // CASCADE handles role_permissions cleanup
  await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "role",
    resourceId: roleId,
    actionType: "ROLE_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { roleId },
  });

  return json({ ok: true });
}

async function handleRemoveOrgMember(request, orgId, userId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  if (!userId) {
    return json({ error: "userId is required" }, 400);
  }

  const orgRes = await pool.query(
    "SELECT org_id, guild_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) {
    return json({ error: "Organization not found" }, 404);
  }

  const memberRes = await pool.query(
    `SELECT om.role_id, u.username, u.discord_id FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId],
  );
  if (!memberRes.rows[0]) {
    return json({ error: "Member not found in organization" }, 404);
  }

  const beforeState = memberRes.rows[0];

  // Configured sys admin can never be removed
  const configuredSysAdminDiscordId = String(
    env.sysAdminDiscordId ?? "",
  ).trim();
  if (
    configuredSysAdminDiscordId &&
    beforeState.discord_id === configuredSysAdminDiscordId
  ) {
    return json({ error: "This member cannot be removed" }, 403);
  }

  // Only org owners can remove other org owners
  const actorIsOwner =
    (session.orgOwnerOrgIds ?? []).includes(orgId) ||
    isConfiguredSysAdmin(session);
  if (beforeState.role_id === "org_owner" && !actorIsOwner) {
    return json({ error: "Only org owners can remove other owners" }, 403);
  }

  await pool.query(
    `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );

  // Remove Discord roles associated with their staff role (best-effort)
  await removeAllDiscordRolesForRole(
    orgRes.rows[0].guild_id,
    beforeState.discord_id,
    beforeState.role_id,
  );

  await scanDel("cache:members:*");

  // Audit log
  await auditLog({
    orgId,
    actorUserId: session.userId,
    targetUserId: userId,
    resourceType: "org_member",
    resourceId: userId,
    actionType: "ORG_MEMBER_REMOVED",
    actionCategory: "staff_management",
    severity: 3,
    metadata: {
      username: beforeState.username,
    },
    beforeState: {
      orgId,
      userId,
      roleId: beforeState.role_id,
    },
  });

  return json({ ok: true, orgId, userId });
}

async function handleUpdateOrgMemberTeam(request, orgId, userId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  if (!userId) {
    return json({ error: "userId is required" }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const newTeam = String(body?.team ?? "").trim();
  if (!newTeam) {
    return json({ error: "team is required in request body" }, 400);
  }

  // Legacy friendly-name mapping
  let resolvedTeam = newTeam === "management" ? "org_admin" : newTeam;

  const builtInRoles = ["org_member", "org_admin", "org_owner", "org_disabled"];

  if (!builtInRoles.includes(resolvedTeam)) {
    // Must be a valid custom role belonging to this org
    if (!resolvedTeam.startsWith(`${orgId}_`)) {
      return json({ error: "Invalid role" }, 400);
    }
    const customRoleRes = await pool.query(
      `SELECT role_id FROM roles WHERE role_id = $1 LIMIT 1`,
      [resolvedTeam],
    );
    if (!customRoleRes.rows[0]) {
      return json({ error: "Invalid role" }, 400);
    }

    // Prevent escalation-by-proxy: a non-admin/owner actor (e.g. a custom role
    // holding org_manage) cannot assign a member to a role that grants
    // permissions the actor does not personally hold.
    if (!canManageOrg(session, orgId)) {
      const rolePermsRes = await pool.query(
        `SELECT permission_id FROM role_permissions WHERE role_id = $1`,
        [resolvedTeam],
      );
      const userPerms = new Set(session.orgPermissions?.[orgId] ?? []);
      const escalated = rolePermsRes.rows
        .map((r) => String(r.permission_id))
        .filter((p) => !userPerms.has(p));
      if (escalated.length > 0) {
        return json(
          { error: "Cannot assign a role granting permissions you do not hold" },
          403,
        );
      }
    }
  }

  // Determine if the actor is an org owner (vs just admin)
  const actorIsOwner =
    (session.orgOwnerOrgIds ?? []).includes(orgId) ||
    isConfiguredSysAdmin(session);

  // Only owners can assign built-in elevated roles
  if (
    (resolvedTeam === "org_admin" || resolvedTeam === "org_owner") &&
    !actorIsOwner
  ) {
    return json(
      { error: "Only org owners can assign admin or owner roles" },
      403,
    );
  }

  const orgRes = await pool.query(
    "SELECT org_id, guild_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) {
    return json({ error: "Organization not found" }, 404);
  }

  const memberRes = await pool.query(
    `SELECT om.role_id, u.username, u.discord_id FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId],
  );
  if (!memberRes.rows[0]) {
    return json({ error: "Member not found in organization" }, 404);
  }

  const beforeState = memberRes.rows[0];

  // Admins cannot modify org owners
  if (beforeState.role_id === "org_owner" && !actorIsOwner) {
    return json({ error: "Only org owners can modify other owners" }, 403);
  }

  if (beforeState.role_id === resolvedTeam) {
    return json({ ok: true, orgId, userId, message: "Team unchanged" });
  }

  await pool.query(
    `UPDATE organization_members SET role_id = $1 WHERE org_id = $2 AND user_id = $3`,
    [resolvedTeam, orgId, userId],
  );

  // Sync Discord roles: remove old role's Discord roles, add new role's (best-effort)
  await syncDiscordRolesOnRoleChange(
    orgRes.rows[0].guild_id,
    beforeState.discord_id,
    beforeState.role_id,
    resolvedTeam,
  );

  await scanDel("cache:members:*");

  // Audit log
  await auditLog({
    orgId,
    actorUserId: session.userId,
    targetUserId: userId,
    resourceType: "org_member",
    resourceId: userId,
    actionType: "ORG_MEMBER_TEAM_CHANGED",
    actionCategory: "staff_management",
    severity: 2,
    metadata: {
      username: beforeState.username,
      newTeam: resolvedTeam,
    },
    beforeState: {
      orgId,
      userId,
      roleId: beforeState.role_id,
    },
    afterState: {
      orgId,
      userId,
      roleId: resolvedTeam,
    },
  });

  return json({ ok: true, orgId, userId });
}

async function handleGetOrgStaffStats(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  const statsCacheKey = `org:staff-stats:${orgId}`;
  try {
    const cached = await redis.get(statsCacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch {}

  const [bans30dRes, tickets30dRes, openTicketsRes, onlineRes, memberStatsRes] =
    await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS cnt FROM player_bans
         WHERE org_id = $1 AND NOT revoked AND issued_at > unix_now() - 2592000`,
        [orgId],
      ),
      pool.query(
        `SELECT COUNT(*) AS cnt FROM tickets
         WHERE org_id = $1 AND created_at > unix_now() - 2592000`,
        [orgId],
      ),
      pool.query(
        `SELECT COUNT(*) AS cnt FROM tickets WHERE org_id = $1 AND status != 'closed'`,
        [orgId],
      ),
      pool.query(
        `SELECT COUNT(DISTINCT s.user_id) AS cnt
         FROM sessions s
         JOIN organization_members om ON om.user_id = s.user_id
         WHERE om.org_id = $1 AND NOT s.revoked AND s.expires_at > unix_now()
           AND s.created_at > unix_now() - 3600`,
        [orgId],
      ),
      pool.query(
        `SELECT
           om.user_id,
           u.steam_id,
           COALESCE((
             SELECT COUNT(*) FROM tickets t
             WHERE t.assigned_to = om.user_id AND t.org_id = $1
               AND t.status = 'closed' AND t.closed_at > unix_now() - 604800
           ), 0) AS tickets_7d,
           COALESCE((
             SELECT COUNT(*) FROM tickets t
             WHERE t.assigned_to = om.user_id AND t.org_id = $1
               AND t.status = 'closed' AND t.closed_at > unix_now() - 2592000
           ), 0) AS tickets_30d,
           COALESCE((
             SELECT COUNT(*) FROM tickets t
             WHERE t.assigned_to = om.user_id AND t.org_id = $1 AND t.status = 'closed'
           ), 0) AS tickets_all,
           (
             SELECT MAX(s2.created_at)
             FROM sessions s2 WHERE s2.user_id = om.user_id AND NOT s2.revoked
           ) AS last_panel_login,
           (
             SELECT MAX(ops.last_seen_at)
             FROM org_player_sightings ops
             WHERE ops.steam_id = u.steam_id AND ops.org_id = $1
           ) AS last_ingame,
           (
             SELECT MAX(pb.issued_at)
             FROM player_bans pb WHERE pb.issued_by = om.user_id AND pb.org_id = $1
           ) AS last_ban,
           COALESCE((
             SELECT SUM(pbs.hours_played)
             FROM player_bm_sessions pbs WHERE pbs.steam_id = u.steam_id
           ), 0) AS ingame_hours_all
         FROM organization_members om
         JOIN users u ON u.user_id = om.user_id
         WHERE om.org_id = $1`,
        [orgId],
      ),
    ]);

  const result = {
    orgStats: {
      bans30d: Number(bans30dRes.rows[0]?.cnt ?? 0),
      tickets30d: Number(tickets30dRes.rows[0]?.cnt ?? 0),
      openTickets: Number(openTicketsRes.rows[0]?.cnt ?? 0),
      onlineNow: Number(onlineRes.rows[0]?.cnt ?? 0),
    },
    memberStats: memberStatsRes.rows.map((r) => ({
      userId: String(r.user_id),
      tickets7d: Number(r.tickets_7d),
      tickets30d: Number(r.tickets_30d),
      ticketsAll: Number(r.tickets_all),
      lastPanelLogin: r.last_panel_login ? Number(r.last_panel_login) : null,
      lastIngame: r.last_ingame ? Number(r.last_ingame) : null,
      lastBan: r.last_ban ? Number(r.last_ban) : null,
      ingameHoursAll: Number(r.ingame_hours_all),
    })),
  };

  try {
    await redis.set(statsCacheKey, JSON.stringify(result), "EX", 60);
  } catch {}

  return json(result);
}

async function handleGetOrgMembers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.discord_id, u.steam_id, om.role_id
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1`,
    [orgId],
  );

  return json({
    members: rows.map((row) => ({
      userId: String(row.user_id),
      username: String(row.username),
      discordId: row.discord_id == null ? null : String(row.discord_id),
      steamId: row.steam_id == null ? null : String(row.steam_id),
      roleId: String(row.role_id),
    })),
  });
}

async function handleGetStaffAuditLog(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId");
  const limit = parseLimit(url.searchParams.get("limit"), 50, 500);
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset"))) || 0);

  if (!staffId) {
    return json({ error: "staffId query parameter is required" }, 400);
  }

  const memberCheck = await pool.query(
    `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
    [orgId, staffId],
  );
  if (!memberCheck.rows[0]) {
    return json({ error: "Staff member not found in this organization" }, 404);
  }

  const logsRes = await pool.query(
    `SELECT
       id, actor_user_id, target_user_id, resource_type, resource_id,
       action_type, action_category, severity, metadata, before_state, after_state,
       created_at
     FROM audit_logs
     WHERE org_id = $1 AND actor_user_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [orgId, staffId, limit, offset],
  );

  const countRes = await pool.query(
    `SELECT COUNT(*) as total FROM audit_logs WHERE org_id = $1 AND actor_user_id = $2`,
    [orgId, staffId],
  );

  const logs = logsRes.rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    targetUserId: row.target_user_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    actionType: row.action_type,
    actionCategory: row.action_category,
    severity: row.severity,
    metadata: row.metadata,
    beforeState: row.before_state,
    afterState: row.after_state,
    createdAt: row.created_at ? Number(row.created_at) : null,
  }));

  return json({
    logs,
    total: Number(countRes.rows[0]?.total ?? 0),
    limit,
    offset,
  });
}

async function handleGetImpersonateViewOrgMember(request, orgId, userId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  // Only management+ can view another member's perspective
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
  }

  if (!userId) {
    return json({ error: "userId is required" }, 400);
  }

  // Verify target user is a member of the organization
  const memberRes = await pool.query(
    `SELECT u.user_id, u.username, u.discord_id, u.steam_id, om.role_id
     FROM users u
     JOIN organization_members om ON om.user_id = u.user_id
     WHERE om.org_id = $1 AND u.user_id = $2`,
    [orgId, userId],
  );

  if (!memberRes.rows[0]) {
    return json(
      { error: "Target user is not a member of this organization" },
      404,
    );
  }

  const targetMember = memberRes.rows[0];
  const targetAccess = await loadUserAccess(targetMember.user_id);

  // Log the view-only impersonation access
  await auditLog({
    orgId,
    actorUserId: session.userId,
    targetUserId: targetMember.user_id,
    resourceType: "org_member",
    resourceId: targetMember.user_id,
    actionType: "ORG_MEMBER_VIEW_ACCESSED",
    actionCategory: "staff_management",
    severity: 2,
    metadata: {
      username: targetMember.username,
      viewType: "read_only",
    },
  });

  return json({
    ok: true,
    member: {
      userId: String(targetMember.user_id),
      username: String(targetMember.username),
      discordId:
        targetMember.discord_id == null
          ? null
          : String(targetMember.discord_id),
      steamId:
        targetMember.steam_id == null ? null : String(targetMember.steam_id),
      roleId: String(targetMember.role_id),
    },
    access: {
      orgAdminOrgIds: targetAccess.orgAdminOrgIds.filter((id) => id === orgId),
      canWrite: targetAccess.canWrite,
      groups: targetAccess.groups,
      permissions: Array.from(
        new Set(
          targetAccess.groups.flatMap((g) => {
            const perms = [];
            if (g.editUsers) perms.push("org_manage");
            if (g.editGroups) perms.push("role_create");
            return perms;
          }),
        ),
      ),
    },
    viewOnly: true,
    viewedAt: Math.floor(Date.now() / 1000),
  });
}

async function handleGetOrgDetails(request, orgId) {
  const { session, error } = await requireOrgMemberOrAdmin(request, orgId);
  if (error) return error;
  void session;

  const orgRes = await pool.query(
    "SELECT org_id, guild_id, name, created_at FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org) {
    return json({ error: "Organization not found" }, 404);
  }

  return json({
    organization: {
      orgId: String(org.org_id),
      guildId: org.guild_id == null ? null : String(org.guild_id),
      name: String(org.name),
      createdAt:
        org.created_at == null ? null : Number(org.created_at),
    },
  });
}

async function handleUpdateOrgDetails(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const name = body?.name == null ? null : String(body.name).trim();
  // guildId omitted (undefined) → don't touch it; explicit null → unlink; string → set/change
  const guildIdRaw = body?.guildId;
  const guildId =
    guildIdRaw === undefined ? undefined : guildIdRaw === null ? null : String(guildIdRaw).trim() || null;

  if (name !== null && !name) {
    return json({ error: "name cannot be empty" }, 400);
  }
  if (guildId !== undefined && guildId !== null && !/^\d{17,20}$/.test(guildId)) {
    return json({ error: "guildId must be a valid Discord snowflake" }, 400);
  }

  if (guildId) {
    const conflict = await pool.query(
      "SELECT org_id FROM organizations WHERE guild_id = $1 AND org_id <> $2 LIMIT 1",
      [guildId, orgId],
    );
    if (conflict.rows[0]) {
      return json(
        { error: "guildId is already linked to another organization" },
        409,
      );
    }
  }

  const result = await pool.query(
    `UPDATE organizations
     SET name = COALESCE($2, name),
         guild_id = CASE WHEN $3 THEN $4::text ELSE guild_id END
     WHERE org_id = $1
     RETURNING org_id, guild_id, name, created_at`,
    [orgId, name, guildId !== undefined, guildId ?? null],
  );

  const updated = result.rows[0];
  if (!updated) {
    return json({ error: "Organization not found" }, 404);
  }

  return json({
    ok: true,
    organization: {
      orgId: String(updated.org_id),
      guildId: updated.guild_id == null ? null : String(updated.guild_id),
      name: String(updated.name),
      createdAt:
        updated.created_at == null
          ? null
          : Number(updated.created_at),
    },
  });
}

async function handleListRoles(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const sysAdminCheck = requireConfiguredSysAdmin(session);
  if (sysAdminCheck.error) return sysAdminCheck.error;

  const res = await pool.query(
    `SELECT role_id, role_name FROM roles ORDER BY role_name ASC`,
  );

  return json({
    roles: res.rows.map((row) => ({
      roleId: String(row.role_id),
      roleName: String(row.role_name),
    })),
  });
}

async function handleCreateRole(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const sysAdminCheck = requireConfiguredSysAdmin(session);
  if (sysAdminCheck.error) return sysAdminCheck.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const roleName = body?.roleName == null ? null : String(body.roleName).trim();
  if (!roleName) {
    return json({ error: "roleName is required" }, 400);
  }

  const roleId = roleName
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  if (!roleId) {
    return json({ error: "Could not generate roleId from roleName" }, 400);
  }

  const existing = await pool.query(
    `SELECT role_id FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  if (existing.rows[0]) {
    return json({ error: "Role already exists with that ID" }, 409);
  }

  await pool.query(`INSERT INTO roles (role_id, role_name) VALUES ($1, $2)`, [
    roleId,
    roleName,
  ]);

  return json({
    ok: true,
    role: {
      roleId,
      roleName,
    },
  });
}

async function handleListPermissions(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const sysAdminCheck = requireConfiguredSysAdmin(session);
  if (sysAdminCheck.error) return sysAdminCheck.error;

  const res = await pool.query(
    `SELECT permission_id, permission_name FROM permissions ORDER BY permission_name ASC`,
  );

  return json({
    permissions: res.rows.map((row) => ({
      permissionId: String(row.permission_id),
      permissionName: String(row.permission_name),
    })),
  });
}

async function handleGetRolePermissions(request, roleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const sysAdminCheck = requireConfiguredSysAdmin(session);
  if (sysAdminCheck.error) return sysAdminCheck.error;

  const res = await pool.query(
    `SELECT p.permission_id, p.permission_name, CASE WHEN rp.role_id IS NOT NULL THEN true ELSE false END AS granted
     FROM permissions p
     LEFT JOIN role_permissions rp ON p.permission_id = rp.permission_id AND rp.role_id = $1
     ORDER BY p.permission_name ASC`,
    [roleId],
  );

  return json({
    roleId,
    permissions: res.rows.map((row) => ({
      permissionId: String(row.permission_id),
      permissionName: String(row.permission_name),
      granted: Boolean(row.granted),
    })),
  });
}

async function handleUpdateRolePermissions(request, roleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const sysAdminCheck = requireConfiguredSysAdmin(session);
  if (sysAdminCheck.error) return sysAdminCheck.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const permissionIds = Array.isArray(body?.permissionIds)
    ? body.permissionIds.map(String)
    : [];

  const roleExists = await pool.query(
    `SELECT role_id FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  if (!roleExists.rows[0]) {
    return json({ error: "Role not found" }, 404);
  }

  const client = await pool.connect();
  try {
    await client.query(`BEGIN`);
    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [
      roleId,
    ]);
    for (const permId of permissionIds) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleId, permId],
      );
    }
    await client.query(`COMMIT`);
    return json({ ok: true, roleId, permissionIds });
  } catch (err) {
    await client.query(`ROLLBACK`);
    throw err;
  } finally {
    client.release();
  }
}

// ── Default ticket types ─────────────────────────────────────────────────────

const DEFAULT_TICKET_TYPES = [
  {
    name: "Cheating",
    description: "Report a player for cheating (aimbot, ESP, scripts, macros).",
    category: "player_single",
  },
  {
    name: "Teaming",
    description: "Report players for teaming or group size violations.",
    category: "player_multi",
  },
  {
    name: "Toxicity",
    description: "Report a player for toxicity, harassment, or hate speech.",
    category: "player_single",
  },
  {
    name: "Support",
    description: "General questions and support requests.",
    category: "generic",
  },
  {
    name: "VIP",
    description: "Issues related to VIP memberships or perks.",
    category: "generic",
  },
  {
    name: "Appeal",
    description: "Appeal a ban or mute on this server.",
    category: "generic",
  },
];

async function ensureDefaultTicketTypes(orgId) {
  for (const t of DEFAULT_TICKET_TYPES) {
    await pool.query(
      `INSERT INTO ticket_types (org_id, ticket_type_name, ticket_type_description, ticket_type_category)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, ticket_type_name) DO UPDATE SET ticket_type_category = $4`,
      [orgId, t.name, t.description, t.category],
    );
  }
}

// ── Ticket Redis cache ────────────────────────────────────────────────────────

function ticketCacheKey(ticketId) {
  return `ticket:${ticketId}`;
}

async function cacheTicket(ticket) {
  const key = ticketCacheKey(ticket.ticket_id);
  let ttl;
  if (ticket.closed_at) {
    const expireAt = ticket.closed_at + 7 * 24 * 3600;
    ttl = expireAt - Math.floor(Date.now() / 1000);
  } else {
    ttl = 30 * 24 * 3600;
  }
  if (ttl > 0) {
    await redis.set(key, JSON.stringify(ticket), "EX", ttl);
  }
}

async function getCachedTicket(ticketId) {
  const raw = await redis.get(ticketCacheKey(ticketId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function invalidateTicketCache(ticketId) {
  await redis.del(ticketCacheKey(ticketId));
}

// ── Ticket DB helpers ─────────────────────────────────────────────────────────

async function loadTicketFromDb(ticketId) {
  const { rows } = await pool.query(
    `SELECT t.ticket_id, t.org_id, t.ticket_type_id, t.created_by, t.assigned_to,
            t.status, t.priority, t.title,
            t.created_at,
            t.updated_at,
            t.closed_at,
            t.reported_players,
            tt.ticket_type_name,
            creator.username AS created_by_username, creator.steam_id AS created_by_steam_id,
            assignee.username AS assigned_to_username
     FROM tickets t
     LEFT JOIN ticket_types tt ON tt.ticket_type_id = t.ticket_type_id
     LEFT JOIN users creator ON creator.user_id = t.created_by
     LEFT JOIN users assignee ON assignee.user_id = t.assigned_to
     WHERE t.ticket_id = $1
     LIMIT 1`,
    [ticketId],
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    ticket_id: Number(row.ticket_id),
    org_id: String(row.org_id),
    ticket_type_id: row.ticket_type_id ? Number(row.ticket_type_id) : null,
    ticket_type_name: row.ticket_type_name ?? null,
    created_by: row.created_by ? String(row.created_by) : null,
    created_by_username: row.created_by_username ?? null,
    created_by_steam_id: row.created_by_steam_id ?? null,
    assigned_to: row.assigned_to ? String(row.assigned_to) : null,
    assigned_to_username: row.assigned_to_username ?? null,
    status: String(row.status),
    priority: String(row.priority),
    title: String(row.title),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    closed_at: row.closed_at ? Number(row.closed_at) : null,
    reported_players: Array.isArray(row.reported_players) ? row.reported_players.map(String) : [],
  };
}

async function loadTicketMessages(ticketId) {
  const { rows } = await pool.query(
    `SELECT tm.message_id, tm.ticket_id, tm.user_id, tm.message, tm.is_internal,
            tm.created_at,
            u.username, u.steam_id
     FROM ticket_messages tm
     LEFT JOIN users u ON u.user_id = tm.user_id
     WHERE tm.ticket_id = $1
     ORDER BY tm.created_at ASC`,
    [ticketId],
  );
  return rows.map((row) => ({
    messageId: Number(row.message_id),
    ticketId: Number(row.ticket_id),
    userId: row.user_id ? String(row.user_id) : null,
    username: row.username ?? null,
    steamId: row.steam_id ?? null,
    message: String(row.message),
    isInternal: Boolean(row.is_internal),
    createdAt: Number(row.created_at),
  }));
}

// ── Public Steam auth (ticket submission, no Discord required) ────────────────

async function handlePublicSteamStart(request) {
  const limited = await rateLimitLogin(request);
  if (limited) return limited;

  // Public portal Steam auth requires Discord to be linked first
  const pending = getPendingLink(request);
  if (!pending) {
    return redirect("/support?error=steam_requires_discord");
  }

  const url = new URL(request.url);
  const org = String(url.searchParams.get("org") ?? "").trim();

  const nonce = crypto.randomUUID();
  await redis.set(
    `openid:public:${nonce}`,
    JSON.stringify({ org }),
    "EX",
    60 * 10,
  );

  const returnUrl = `${getBaseUrl(request)}/api/auth/steam/public/callback`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": `${returnUrl}?nonce=${encodeURIComponent(nonce)}`,
    "openid.realm": getSteamRealm(request),
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return redirect(`${STEAM_OPENID_URL}?${params.toString()}`);
}

async function handlePublicSteamCallback(request) {
  const limited = await rateLimitLogin(request);
  if (limited) return limited;

  const url = new URL(request.url);
  const nonce = String(url.searchParams.get("nonce") ?? "").trim();
  const pending = getPendingLink(request);

  if (!nonce || !pending) {
    return redirect(
      "/support?error=steam_state_invalid",
      clearPendingLinkHeaders(new Headers()),
    );
  }

  const nonceKey = `openid:public:${nonce}`;
  const raw = await redis.getdel(nonceKey);
  if (!raw) {
    return redirect(
      "/support?error=steam_state_expired",
      clearPendingLinkHeaders(new Headers()),
    );
  }

  let nonceData;
  try {
    nonceData = JSON.parse(raw);
  } catch {
    return redirect(
      "/support?error=steam_state_invalid",
      clearPendingLinkHeaders(new Headers()),
    );
  }

  const orgParam = String(nonceData.org ?? "").trim();

  try {
    await verifySteamResponse(url.searchParams);
    const claimedId = url.searchParams.get("openid.claimed_id") ?? "";
    const match = claimedId.match(/\/id\/(\d+)$/);
    if (!match) throw new Error("Steam claimed ID missing.");

    const steamId = match[1];

    // Reject if this Steam is already linked to a different Discord account
    const conflictRes = await pool.query(
      "SELECT user_id, discord_id FROM users WHERE steam_id = $1 LIMIT 1",
      [steamId],
    );
    const conflictRow = conflictRes.rows[0];
    if (
      conflictRow &&
      conflictRow.discord_id &&
      String(conflictRow.discord_id) !== pending.discordId
    ) {
      return redirect(
        "/support?error=steam_already_linked",
        clearPendingLinkHeaders(new Headers()),
      );
    }

    // Find existing user — prefer match by discord_id, fall back to steam_id
    const existingRes = await pool.query(
      `SELECT user_id, username, discord_id, steam_id FROM users
       WHERE discord_id = $1 OR steam_id = $2
       ORDER BY CASE WHEN discord_id = $1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [pending.discordId, steamId],
    );
    const existingUser = existingRes.rows[0];

    let userId;
    if (existingUser) {
      userId = String(existingUser.user_id);
      await pool.query(
        `UPDATE users
         SET username = $2, discord_id = $3, steam_id = $4, updated_at = unix_now()
         WHERE user_id = $1`,
        [userId, pending.username, pending.discordId, steamId],
      );
    } else {
      userId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (user_id, username, discord_id, steam_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, pending.username, pending.discordId, steamId],
      );
    }

    // Upsert into public_identity_links (tracks portal-linked identities)
    await pool.query(
      `INSERT INTO public_identity_links (discord_id, discord_username, steam_id, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_id)
       DO UPDATE SET discord_username = EXCLUDED.discord_username,
                     steam_id = EXCLUDED.steam_id,
                     user_id = EXCLUDED.user_id,
                     updated_at = unix_now()`,
      [pending.discordId, pending.username, steamId, userId],
    );

    // If org is known from the nonce, go straight to submit; otherwise go to
    // pending.next which may carry ?org=... from the initial Discord start.
    const redirectTo = orgParam
      ? `/submit?org=${encodeURIComponent(orgParam)}`
      : (pending.next ?? "/support");

    return createSessionForUser(
      {
        userId,
        username: pending.username,
        discordId: pending.discordId,
        steamId,
      },
      {
        redirectTo,
        ipAddress: getClientIp(request),
        userAgent: request.headers.get("user-agent") ?? null,
      },
    );
  } catch {
    return redirect(
      "/support?error=steam_auth_failed",
      clearPendingLinkHeaders(new Headers()),
    );
  }
}

// ── Public org listing ────────────────────────────────────────────────────────

async function handleListOrgs() {
  const { rows } = await pool.query(
    `SELECT org_id, name FROM organizations WHERE org_id <> $1 ORDER BY name ASC`,
    [SYSADMIN.globalOrgId],
  );
  return json({
    orgs: rows.map((row) => {
      const name = String(row.name);
      const short =
        name
          .split(/\s+/)
          .filter(Boolean)
          .map((p) => p[0])
          .join("")
          .slice(0, 3)
          .toUpperCase() || String(row.org_id).slice(0, 3).toUpperCase();
      return { orgId: String(row.org_id), name, short };
    }),
  });
}

// ── Ticket type endpoints ─────────────────────────────────────────────────────

async function handleListOrgTicketTypes(request, orgId) {
  const { session } = await requireSession(request);

  const orgRes = await pool.query(
    `SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (!orgRes.rows[0]) {
    return json({ error: "Organization not found" }, 404);
  }

  // Seed defaults if this org has never had ticket types configured
  const countRes = await pool.query(
    `SELECT COUNT(*) AS n FROM ticket_types WHERE org_id = $1`,
    [orgId],
  );
  if (Number(countRes.rows[0].n) === 0) {
    await ensureDefaultTicketTypes(orgId);
  }

  let query = `SELECT ticket_type_id, ticket_type_name, ticket_type_description, ticket_type_category, is_enabled
     FROM ticket_types WHERE org_id = $1`;

  // Public users only see enabled ticket types
  if (!session) {
    query += ` AND is_enabled = true`;
  }

  query += ` ORDER BY ticket_type_id ASC`;

  const { rows } = await pool.query(query, [orgId]);
  return json({
    ticketTypes: rows.map((row) => ({
      ticketTypeId: Number(row.ticket_type_id),
      name: String(row.ticket_type_name),
      description: String(row.ticket_type_description),
      category: String(row.ticket_type_category),
      isEnabled: Boolean(row.is_enabled),
    })),
  });
}

async function handleUpdateOrgTicketType(request, orgId, ticketTypeId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!canManageOrg(session, orgId)) {
    return json({ error: "Not authorized to manage this org" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { isEnabled } = body;
  if (typeof isEnabled !== "boolean") {
    return json({ error: "isEnabled must be a boolean" }, 400);
  }

  const res = await pool.query(
    `UPDATE ticket_types SET is_enabled = $1 WHERE ticket_type_id = $2 AND org_id = $3`,
    [isEnabled, ticketTypeId, orgId],
  );

  if (res.rowCount === 0) {
    return json({ error: "Ticket type not found" }, 404);
  }

  return json({ ok: true });
}

// ── Ticket CRUD ───────────────────────────────────────────────────────────────

async function handleCreateTicket(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!session.steamId) {
    return json(
      {
        error:
          "Steam account required. Link your Steam account before submitting a ticket.",
      },
      403,
    );
  }

  const rl = await checkRateLimit(`rl:ticket:${session.userId}`, 10, 60);
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const orgId = String(body?.orgId ?? "").trim();
  const ticketTypeId =
    body?.ticketTypeId != null ? Number(body.ticketTypeId) : null;
  const title = String(body?.title ?? "").trim();
  const message = String(body?.message ?? "").trim();
  const reportedPlayers = (Array.isArray(body?.reportedPlayers) ? body.reportedPlayers : [])
    .map((s) => String(s).trim())
    .filter((s) => /^7656119\d{10}$/.test(s))
    .slice(0, 10);

  if (!orgId || !title || !message) {
    return json({ error: "orgId, title, and message are required" }, 400);
  }
  if (title.length > 255)
    return json({ error: "title must be 255 characters or fewer" }, 400);
  if (message.length > 10000)
    return json({ error: "message is too long" }, 400);

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  if (ticketTypeId !== null) {
    const typeRes = await pool.query(
      "SELECT ticket_type_id FROM ticket_types WHERE ticket_type_id = $1 AND org_id = $2 LIMIT 1",
      [ticketTypeId, orgId],
    );
    if (!typeRes.rows[0])
      return json(
        { error: "Ticket type not found for this organization" },
        400,
      );
  }

  const txClient = await pool.connect();
  let ticketId;
  try {
    await txClient.query(`BEGIN`);
    const result = await txClient.query(
      `INSERT INTO tickets (org_id, ticket_type_id, created_by, title, reported_players)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ticket_id`,
      [orgId, ticketTypeId, session.userId, title, reportedPlayers],
    );
    ticketId = Number(result.rows[0].ticket_id);
    await txClient.query(
      `INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES ($1, $2, $3)`,
      [ticketId, session.userId, message],
    );
    await txClient.query(
      `INSERT INTO ticket_audit_log (ticket_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [ticketId, session.userId, "created", JSON.stringify({ title, orgId, ticketTypeId })],
    );
    await txClient.query(`COMMIT`);
  } catch (err) {
    await txClient.query(`ROLLBACK`);
    throw err;
  } finally {
    txClient.release();
  }

  const ticket = await loadTicketFromDb(ticketId);
  if (ticket) await cacheTicket(ticket);

  return json({ ok: true, ticketId }, 201);
}

async function handleGetTicket(request, ticketIdStr) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const id = Number(ticketIdStr);
  if (!Number.isInteger(id) || id <= 0)
    return json({ error: "Invalid ticket ID" }, 400);

  let ticket = await getCachedTicket(id);
  if (!ticket) {
    ticket = await loadTicketFromDb(id);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    await cacheTicket(ticket);
  }

  if (ticket.created_by !== session.userId) {
    if (isGlobalAdmin(session)) {
      // Global admin can view any ticket
    } else if (canManageOrg(session, ticket.org_id)) {
      // Org admin/owner can view all tickets
    } else {
      const perms = session.orgPermissions?.[ticket.org_id] ?? [];
      const hasPermission = perms.includes("tickets_view") || perms.includes("tickets_manage");
      if (!hasPermission) return json({ error: "Forbidden" }, 403);

      // Enforce ticket type restriction if the role has specific types assigned
      if (ticket.ticket_type_id !== null) {
        const typeRes = await pool.query(
          `SELECT 1 FROM organization_members om
           JOIN ticket_type_roles ttr ON ttr.role_id = om.role_id
           WHERE om.org_id = $1 AND om.user_id = $2
           LIMIT 1`,
          [ticket.org_id, session.userId],
        );
        if (typeRes.rows.length > 0) {
          // Role has type restrictions — check if this ticket's type is allowed
          const allowed = await pool.query(
            `SELECT 1 FROM organization_members om
             JOIN ticket_type_roles ttr ON ttr.role_id = om.role_id
             WHERE om.org_id = $1 AND om.user_id = $2 AND ttr.ticket_type_id = $3
             LIMIT 1`,
            [ticket.org_id, session.userId, ticket.ticket_type_id],
          );
          if (!allowed.rows[0]) return json({ error: "Forbidden" }, 403);
        }
      }
    }
  }

  const messages = await loadTicketMessages(id);

  const isViewerStaff =
    isGlobalAdmin(session) ||
    canManageOrg(session, ticket.org_id) ||
    orgHasPermission(session, ticket.org_id, "tickets_view") ||
    orgHasPermission(session, ticket.org_id, "tickets_manage");

  const returnedMessages = isViewerStaff
    ? messages
    : messages
        .filter((m) => !m.isInternal)
        .map((m) =>
          m.userId !== session.userId
            ? { ...m, username: null, steamId: null }
            : m,
        );

  return json({ ticket, messages: returnedMessages });
}

function filterPlayerIpData(playerData, canSeeIp) {
  if (canSeeIp || !playerData) return playerData;
  const result = { ...playerData };
  if (Array.isArray(result.ipHistory)) {
    result.ipHistory = result.ipHistory.map((entry) => ({
      ...entry,
      ipAddress: null,
      country: null,
      isp: null,
    }));
  }
  if (Array.isArray(result.relatedAccounts)) {
    result.relatedAccounts = result.relatedAccounts.map((account) => ({
      ...account,
      sharedIps: Array.isArray(account.sharedIps)
        ? account.sharedIps.map((s) => ({ ...s, ip: null, isp: null, country: null }))
        : account.sharedIps,
    }));
  }
  return result;
}

async function handleGetTicketPlayerIntel(request, ticketIdStr) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const id = Number(ticketIdStr);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Invalid ticket ID" }, 400);

  let ticket = await getCachedTicket(id);
  if (!ticket) {
    ticket = await loadTicketFromDb(id);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
  }

  const hasIntelPerm = orgHasPermission(session, ticket.org_id, "tickets_player_intel");
  if (!isGlobalAdmin(session) && !canManageOrg(session, ticket.org_id) && !hasIntelPerm) {
    return json({ error: "Forbidden: tickets_player_intel permission required" }, 403);
  }

  const canSeeIp = orgHasPermission(session, ticket.org_id, "ip_read");
  const steamIds = ticket.reported_players ?? [];
  if (steamIds.length === 0) return json({ players: [] });

  const players = await Promise.all(
    steamIds.map(async (steamId) => {
      const [playerData, orgBansRes] = await Promise.all([
        (async () => {
          const fromRedis = await getPlayerDataFromRedis(steamId);
          if (fromRedis) {
            if (fromRedis.isStale) {
              refreshPlayerData(steamId, ticket.org_id).catch(() => {});
            }
            return fromRedis;
          }
          const cached = await getPlayerCacheData(steamId);
          if (!cached) {
            refreshPlayerData(steamId, ticket.org_id).catch(() => {});
            return null;
          }
          if (cached.isStale) {
            refreshPlayerData(steamId, ticket.org_id).catch(() => {});
          }
          return cached;
        })(),
        pool.query(
          `SELECT pb.ban_id, pb.action_type, pb.category, pb.reason, pb.note,
                  pb.expires_at, pb.issued_at, pb.revoked, pb.revoked_at,
                  u.username AS issued_by_username
           FROM player_bans pb
           LEFT JOIN users u ON u.user_id = pb.issued_by
           WHERE pb.org_id = $1 AND pb.identifier = $2 AND pb.identifier_type = 'steam_id'
           ORDER BY pb.issued_at DESC`,
          [ticket.org_id, steamId],
        ),
      ]);

      const orgBans = orgBansRes.rows.map((r) => ({
        banId: String(r.ban_id),
        actionType: String(r.action_type),
        category: r.category ?? null,
        reason: String(r.reason),
        note: String(r.note),
        expiresAt: r.expires_at ? Number(r.expires_at) : null,
        issuedAt: Number(r.issued_at),
        revoked: Boolean(r.revoked),
        revokedAt: r.revoked_at ? Number(r.revoked_at) : null,
        issuedByUsername: r.issued_by_username ?? null,
      }));

      if (!playerData) {
        return { steamId, fetching: true, orgBans };
      }
      return { ...filterPlayerIpData(playerData, canSeeIp), orgBans };
    }),
  );

  return json({ players });
}

async function handleAddTicketMessage(request, ticketIdStr) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const id = Number(ticketIdStr);
  if (!Number.isInteger(id) || id <= 0)
    return json({ error: "Invalid ticket ID" }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const message = String(body?.message ?? "").trim();
  if (!message) return json({ error: "message is required" }, 400);
  if (message.length > 10000)
    return json({ error: "message is too long" }, 400);

  const isInternal = Boolean(body?.isInternal);

  const ticket = await loadTicketFromDb(id);
  if (!ticket) return json({ error: "Ticket not found" }, 404);

  const isCreator = ticket.created_by === session.userId;

  // Check staff permission
  const isStaff =
    isGlobalAdmin(session) ||
    orgHasPermission(session, ticket.org_id, "tickets_view") ||
    orgHasPermission(session, ticket.org_id, "tickets_manage");

  // Creator can add messages, staff can add messages
  if (!isCreator && !isStaff) return json({ error: "Forbidden" }, 403);

  // Internal notes are staff-only; non-staff cannot post internal notes.
  if (isInternal && !isStaff) return json({ error: "Forbidden" }, 403);

  // Only block public messages on closed tickets; staff can still post internal notes.
  if (ticket.status === "closed" && !isInternal)
    return json({ error: "Cannot add messages to a closed ticket" }, 400);

  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal) VALUES ($1, $2, $3, $4)`,
    [id, session.userId, message, isInternal],
  );

  if (isCreator && ticket.status === "waiting_response") {
    await pool.query(
      `UPDATE tickets SET status = 'open', updated_at = unix_now() WHERE ticket_id = $1`,
      [id],
    );
  } else {
    await pool.query(
      `UPDATE tickets SET updated_at = unix_now() WHERE ticket_id = $1`,
      [id],
    );
  }

  await invalidateTicketCache(id);
  const updated = await loadTicketFromDb(id);
  if (updated) await cacheTicket(updated);

  return json({ ok: true });
}

async function handleUpdateTicket(request, ticketIdStr) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const id = Number(ticketIdStr);
  if (!Number.isInteger(id) || id <= 0)
    return json({ error: "Invalid ticket ID" }, 400);

  const ticket = await loadTicketFromDb(id);
  if (!ticket) return json({ error: "Ticket not found" }, 404);

  if (isGlobalAdmin(session)) {
    // Global admin can update any ticket
  } else {
    // Regular user must have tickets_manage permission to update tickets
    const hasPermission = orgHasPermission(
      session,
      ticket.org_id,
      "tickets_manage",
    );
    if (!hasPermission) {
      return json({ error: "Forbidden: tickets_manage permission required" }, 403);
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const status = body?.status == null ? null : String(body.status).trim();
  const priority = body?.priority == null ? null : String(body.priority).trim();
  const hasAssigned = Object.prototype.hasOwnProperty.call(
    body ?? {},
    "assignedTo",
  );
  const assignedTo = hasAssigned
    ? body.assignedTo == null
      ? null
      : String(body.assignedTo)
    : undefined;

  if (status && !["open", "waiting_response", "closed"].includes(status)) {
    return json({ error: "Invalid status" }, 400);
  }
  if (priority && !["urgent", "high", "normal", "low"].includes(priority)) {
    return json({ error: "Invalid priority" }, 400);
  }

  const setClauses = ["updated_at = unix_now()"];
  const values = [];
  let idx = 1;

  if (status !== null) {
    setClauses.push(`status = $${idx++}`);
    values.push(status);
  }
  if (priority !== null) {
    setClauses.push(`priority = $${idx++}`);
    values.push(priority);
  }
  if (assignedTo !== undefined) {
    setClauses.push(`assigned_to = $${idx++}`);
    values.push(assignedTo);
  }
  if (status === "closed") {
    setClauses.push("closed_at = unix_now()");
  } else if (status && status !== "closed" && ticket.status === "closed") {
    setClauses.push("closed_at = NULL");
  }

  if (setClauses.length === 1)
    return json({ error: "No fields to update" }, 400);

  values.push(id);
  await pool.query(
    `UPDATE tickets SET ${setClauses.join(", ")} WHERE ticket_id = $${idx}`,
    values,
  );

  await pool.query(
    `INSERT INTO ticket_audit_log (ticket_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [
      id,
      session.userId,
      "updated",
      JSON.stringify({ status, priority, assignedTo }),
    ],
  );

  await invalidateTicketCache(id);
  const updated = await loadTicketFromDb(id);
  if (updated) await cacheTicket(updated);

  return json({ ok: true });
}

async function handleListOrgTickets(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let allowedTypeIds = null; // null = no restriction

  if (isGlobalAdmin(session)) {
    // Global admin sees all tickets
  } else if (canManageOrg(session, orgId)) {
    // Org admin/owner sees all tickets
  } else {
    const perms = session.orgPermissions?.[orgId] ?? [];
    const hasPermission = perms.includes("tickets_view") || perms.includes("tickets_manage");
    if (!hasPermission) return json({ error: "Forbidden" }, 403);

    // Restrict to ticket types the role is explicitly assigned to (empty = no restriction)
    const typeRes = await pool.query(
      `SELECT ttr.ticket_type_id
       FROM organization_members om
       JOIN ticket_type_roles ttr ON ttr.role_id = om.role_id
       WHERE om.org_id = $1 AND om.user_id = $2`,
      [orgId, session.userId],
    );
    if (typeRes.rows.length > 0) {
      allowedTypeIds = typeRes.rows.map((r) => Number(r.ticket_type_id));
    }
  }

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");
  const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset"))) || 0);

  const conditions = ["t.org_id = $1"];
  const values = [orgId];
  let idx = 2;

  if (statusFilter) {
    conditions.push(`t.status = $${idx++}`);
    values.push(statusFilter);
  }
  if (allowedTypeIds !== null) {
    conditions.push(`t.ticket_type_id = ANY($${idx++})`);
    values.push(allowedTypeIds);
  }
  values.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT t.ticket_id, t.org_id, t.ticket_type_id, t.created_by, t.assigned_to,
            t.status, t.priority, t.title,
            t.created_at,
            t.updated_at,
            t.closed_at,
            tt.ticket_type_name,
            creator.username AS created_by_username, creator.steam_id AS created_by_steam_id,
            assignee.username AS assigned_to_username
     FROM tickets t
     LEFT JOIN ticket_types tt ON tt.ticket_type_id = t.ticket_type_id
     LEFT JOIN users creator ON creator.user_id = t.created_by
     LEFT JOIN users assignee ON assignee.user_id = t.assigned_to
     WHERE ${conditions.join(" AND ")}
     ORDER BY t.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );

  return json({
    tickets: rows.map((row) => ({
      ticket_id: Number(row.ticket_id),
      org_id: String(row.org_id),
      ticket_type_id: row.ticket_type_id ? Number(row.ticket_type_id) : null,
      ticket_type_name: row.ticket_type_name ?? null,
      created_by: row.created_by ? String(row.created_by) : null,
      created_by_username: row.created_by_username ?? null,
      created_by_steam_id: row.created_by_steam_id ?? null,
      assigned_to: row.assigned_to ? String(row.assigned_to) : null,
      assigned_to_username: row.assigned_to_username ?? null,
      status: String(row.status),
      priority: String(row.priority),
      title: String(row.title),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      closed_at: row.closed_at ? Number(row.closed_at) : null,
    })),
  });
}

async function handleListMyTickets(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const { rows } = await pool.query(
    `SELECT t.ticket_id, t.org_id, t.ticket_type_id,
            t.status, t.priority, t.title,
            t.created_at,
            t.updated_at,
            t.closed_at,
            tt.ticket_type_name,
            o.name AS org_name
     FROM tickets t
     LEFT JOIN ticket_types tt ON tt.ticket_type_id = t.ticket_type_id
     LEFT JOIN organizations o ON o.org_id = t.org_id
     WHERE t.created_by = $1
     ORDER BY t.created_at DESC
     LIMIT 100`,
    [session.userId],
  );

  return json({
    tickets: rows.map((row) => ({
      ticket_id: Number(row.ticket_id),
      org_id: String(row.org_id),
      org_name: row.org_name ?? null,
      ticket_type_id: row.ticket_type_id ? Number(row.ticket_type_id) : null,
      ticket_type_name: row.ticket_type_name ?? null,
      status: String(row.status),
      priority: String(row.priority),
      title: String(row.title),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      closed_at: row.closed_at ? Number(row.closed_at) : null,
    })),
  });
}

// ── Pterodactyl integration ──────────────────────────────────────────────────

async function handleSavePteroKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const apiKey = String(body?.apiKey ?? "").trim();
  let panelUrl;

  try {
    panelUrl = normalizePterodactylPanelUrl(body?.panelUrl ?? "");
  } catch (err) {
    const code = String(err?.message ?? "panel_url_invalid");
    if (code === "pterodactyl_allowed_hosts_unconfigured") {
      return json(
        {
          error:
            "Pterodactyl integration is not configured: PTERODACTYL_ALLOWED_HOSTS is required.",
        },
        503,
      );
    }
    if (code === "panel_url_host_not_allowed") {
      return json(
        {
          error: `panelUrl host must match one of: ${env.pterodactylAllowedHosts.join(", ")}`,
        },
        400,
      );
    }
    return json(
      { error: "panelUrl must be a valid allowed http/https URL" },
      400,
    );
  }

  if (!panelUrl || !apiKey) {
    return json({ error: "panelUrl and apiKey are required" }, 400);
  }

  let testRes;
  try {
    testRes = await fetch(`${panelUrl}/api/application/servers?per_page=1`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "Application/vnd.pterodactyl.v1+json",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return json(
      {
        error: `Could not reach Pterodactyl panel: ${String(err.message ?? err)}`,
      },
      502,
    );
  }

  if (testRes.status === 401 || testRes.status === 403) {
    return json({ error: "Invalid Pterodactyl API key" }, 400);
  }
  if (!testRes.ok) {
    return json({ error: `Pterodactyl returned HTTP ${testRes.status}` }, 502);
  }

  await pool.query(
    `INSERT INTO ptero_api_keys (
       org_id,
       panel_url,
       api_key,
       api_key_encrypted,
       updated_at,
       created_by_user_id,
       last_used_at
     )
     VALUES ($1, $2, NULL, $3, unix_now(), $4, NULL)
     ON CONFLICT (org_id)
     DO UPDATE SET panel_url = EXCLUDED.panel_url,
                   api_key = NULL,
                   api_key_encrypted = EXCLUDED.api_key_encrypted,
                   created_by_user_id = EXCLUDED.created_by_user_id,
                   updated_at = unix_now()`,
    [orgId, panelUrl, encryptPterodactylApiKey(apiKey), session.userId],
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "pterodactyl_api_key",
    resourceId: orgId,
    actionType: "PTERODACTYL_API_KEY_SET",
    actionCategory: "server_management",
    severity: 3,
    metadata: {
      panelHost: new URL(panelUrl).host,
    },
  });

  return json({ ok: true, panelUrl });
}

async function handleGetPteroKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  const res = await pool.query(
    "SELECT panel_url, updated_at FROM ptero_api_keys WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!res.rows[0]) return json({ connected: false });

  const row = res.rows[0];
  return json({
    connected: true,
    panelUrl: String(row.panel_url),
    updatedAt: row.updated_at ? Number(row.updated_at) : null,
  });
}

async function handleDeletePteroKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  await pool.query("DELETE FROM ptero_api_keys WHERE org_id = $1", [orgId]);

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "pterodactyl_api_key",
    resourceId: orgId,
    actionType: "PTERODACTYL_API_KEY_REMOVED",
    actionCategory: "server_management",
    severity: 3,
  });

  return json({ ok: true });
}

async function handleListPteroServers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch (err) {
    console.error("[ptero] Failed to load credentials:", err.message);
    return json({ error: "Stored Pterodactyl credentials are invalid." }, 500);
  }

  if (!credentials) {
    return json({ error: "Pterodactyl not connected for this org" }, 400);
  }

  const { panelUrl, apiKey } = credentials;

  const servers = [];
  let page = 1;
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    let pteroRes;
    try {
      pteroRes = await fetch(
        `${panelUrl}/api/application/servers?include=allocations,node&per_page=50&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "Application/vnd.pterodactyl.v1+json",
          },
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch (err) {
      return json(
        {
          error: `Could not reach Pterodactyl panel: ${String(err.message ?? err)}`,
        },
        502,
      );
    }

    if (!pteroRes.ok) {
      return json(
        { error: `Pterodactyl returned HTTP ${pteroRes.status}` },
        502,
      );
    }

    const data = await pteroRes.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    const included = Array.isArray(data?.included) ? data.included : [];
    const includedAttributesByRef = new Map(
      included
        .filter((entry) => entry?.type && entry?.id)
        .map((entry) => [`${entry.type}:${entry.id}`, entry?.attributes ?? {}]),
    );

    for (const item of items) {
      const attr = item?.attributes ?? {};
      const relationships = item?.relationships ?? {};

      const allocRefs = Array.isArray(relationships?.allocations?.data)
        ? relationships.allocations.data
        : [];
      const allocEntries = allocRefs.map((ref) => {
        const refKey = `${ref?.type ?? ""}:${ref?.id ?? ""}`;
        const resolved = includedAttributesByRef.get(refKey) ?? {};
        return {
          ...resolved,
          ...(ref?.attributes ?? {}),
        };
      });
      const defaultAlloc =
        allocEntries.find((a) => a?.is_default) ?? allocEntries[0] ?? {};

      const nodeRef = relationships?.node?.data;
      const nodeKey = `${nodeRef?.type ?? ""}:${nodeRef?.id ?? ""}`;
      const nodeAttr = {
        ...(includedAttributesByRef.get(nodeKey) ?? {}),
        ...(nodeRef?.attributes ?? {}),
      };

      servers.push({
        pteroId: attr.id,
        uuid: attr.uuid,
        identifier: attr.identifier,
        name: attr.name ?? "",
        description: attr.description ?? "",
        suspended: Boolean(attr.suspended),
        ip: defaultAlloc.ip ?? null,
        port: defaultAlloc.port ?? null,
        nodeName: nodeAttr.name ?? null,
        nodeFqdn: nodeAttr.fqdn ?? null,
        egg: attr.egg ?? null,
        status: attr.status ?? null,
        createdAt: attr.created_at ?? null,
        limits: {
          memory: attr.limits?.memory ?? 0,
          cpu: attr.limits?.cpu ?? 0,
          disk: attr.limits?.disk ?? 0,
          swap: attr.limits?.swap ?? 0,
          io: attr.limits?.io ?? 0,
        },
      });
    }

    const pagination = data?.meta?.pagination;
    if (!pagination || page >= pagination.total_pages) break;
    page++;
  }

  await pool.query(
    `UPDATE ptero_api_keys
     SET last_used_at = unix_now()
     WHERE org_id = $1`,
    [orgId],
  );

  return json({ servers });
}

async function handleImportPteroServer(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const serverName = String(body?.serverName ?? "").trim();
  const pteroIdentifier = String(body?.pteroIdentifier ?? "").trim() || null;
  if (!serverName) return json({ error: "serverName is required" }, 400);
  if (serverName.length > 128) {
    return json({ error: "serverName too long" }, 400);
  }
  if (pteroIdentifier && pteroIdentifier.length > 64) {
    return json({ error: "pteroIdentifier too long" }, 400);
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  const plainApiKey = crypto.randomBytes(32).toString("hex");
  const apiKeyHash = crypto
    .createHash("sha256")
    .update(plainApiKey)
    .digest("hex");
  const serverId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO servers (server_id, server_name, owner_org_id, api_key_hash, added_by_user_id, ptero_identifier)
     VALUES ($1, $2, $3, $4, (SELECT user_id FROM users WHERE user_id = $5 LIMIT 1), $6)`,
    [serverId, serverName, orgId, apiKeyHash, session.userId, pteroIdentifier],
  );

  return json(
    {
      ok: true,
      server: { serverId, serverName, ownerOrgId: orgId, pteroIdentifier },
      apiKey: plainApiKey,
    },
    201,
  );
}

const PTERO_HEADERS = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  Accept: "Application/vnd.pterodactyl.v1+json",
});

// Fetch all servers from the Pterodactyl Application API. Throws an Error with
// a `.code` ("ptero_unreachable" | "ptero_http") on failure.
async function fetchPteroApplicationServers(panelUrl, apiKey) {
  const servers = [];
  let page = 1;
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    let res;
    try {
      res = await fetch(
        `${panelUrl}/api/application/servers?include=allocations,node&per_page=50&page=${page}`,
        { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(10000) },
      );
    } catch (err) {
      const e = new Error(String(err?.message ?? err));
      e.code = "ptero_unreachable";
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.code = "ptero_http";
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    const included = Array.isArray(data?.included) ? data.included : [];
    const includedByRef = new Map(
      included
        .filter((entry) => entry?.type && entry?.id)
        .map((entry) => [`${entry.type}:${entry.id}`, entry?.attributes ?? {}]),
    );

    for (const item of items) {
      const attr = item?.attributes ?? {};
      const relationships = item?.relationships ?? {};

      const allocRefs = Array.isArray(relationships?.allocations?.data)
        ? relationships.allocations.data
        : [];
      const allocEntries = allocRefs.map((ref) => ({
        ...(includedByRef.get(`${ref?.type ?? ""}:${ref?.id ?? ""}`) ?? {}),
        ...(ref?.attributes ?? {}),
      }));
      const defaultAlloc =
        allocEntries.find((a) => a?.is_default) ?? allocEntries[0] ?? {};

      const nodeRef = relationships?.node?.data;
      const nodeAttr = {
        ...(includedByRef.get(`${nodeRef?.type ?? ""}:${nodeRef?.id ?? ""}`) ??
          {}),
        ...(nodeRef?.attributes ?? {}),
      };

      servers.push({
        pteroId: attr.id,
        uuid: attr.uuid,
        identifier: attr.identifier,
        name: attr.name ?? "",
        suspended: Boolean(attr.suspended),
        ip: defaultAlloc.ip ?? null,
        port: defaultAlloc.port ?? null,
        nodeId: attr.node ?? (nodeRef?.id != null ? Number(nodeRef.id) : null),
        nodeName: nodeAttr.name ?? null,
        installStatus: attr.status ?? null,
        limits: {
          memory: attr.limits?.memory ?? 0,
          cpu: attr.limits?.cpu ?? 0,
          disk: attr.limits?.disk ?? 0,
        },
      });
    }

    const pagination = data?.meta?.pagination;
    if (!pagination || page >= pagination.total_pages) break;
    page++;
  }
  return servers;
}

// Fetch nodes (capacity + maintenance) from the Application API.
async function fetchPteroNodes(panelUrl, apiKey) {
  const nodes = [];
  let page = 1;
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    let res;
    try {
      res = await fetch(
        `${panelUrl}/api/application/nodes?per_page=50&page=${page}`,
        { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(10000) },
      );
    } catch (err) {
      const e = new Error(String(err?.message ?? err));
      e.code = "ptero_unreachable";
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.code = "ptero_http";
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    for (const item of items) {
      const a = item?.attributes ?? {};
      nodes.push({
        id: a.id,
        name: a.name ?? "",
        fqdn: a.fqdn ?? null,
        maintenanceMode: Boolean(a.maintenance_mode),
        memory: a.memory ?? 0,
        disk: a.disk ?? 0,
        memoryOverallocate: a.memory_overallocate ?? 0,
        diskOverallocate: a.disk_overallocate ?? 0,
      });
    }

    const pagination = data?.meta?.pagination;
    if (!pagination || page >= pagination.total_pages) break;
    page++;
  }
  return nodes;
}

// Live per-server utilization via the Client API. Returns null when the stored
// key cannot use the client API (e.g. it is an application-only key) or on any
// transient error — the caller treats null as "no live data".
async function fetchPteroServerResources(panelUrl, apiKey, identifier) {
  let res;
  try {
    res = await fetch(
      `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/resources`,
      { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(8000) },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const a = data?.attributes ?? {};
  const r = a.resources ?? {};
  return {
    state: a.current_state ?? null,
    resources: {
      memoryBytes: r.memory_bytes ?? 0,
      cpuAbsolute: r.cpu_absolute ?? 0,
      diskBytes: r.disk_bytes ?? 0,
      networkRxBytes: r.network_rx_bytes ?? 0,
      networkTxBytes: r.network_tx_bytes ?? 0,
      uptime: r.uptime ?? 0,
    },
  };
}

// Combined status payload: node inventory + servers + best-effort live stats.
async function handleGetPteroStatus(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "status_view") &&
      !orgHasPermission(session, orgId, "servers_manage")) {
    return json({ error: "Forbidden: status_view or servers_manage permission required" }, 403);
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch (err) {
    console.error("[ptero] Failed to load credentials:", err.message);
    return json({ error: "Stored Pterodactyl credentials are invalid." }, 500);
  }
  if (!credentials) return json({ connected: false });

  const { panelUrl, apiKey } = credentials;

  let servers, nodes;
  try {
    [servers, nodes] = await Promise.all([
      fetchPteroApplicationServers(panelUrl, apiKey),
      fetchPteroNodes(panelUrl, apiKey),
    ]);
  } catch (err) {
    if (err?.code === "ptero_unreachable") {
      return json(
        { error: `Could not reach Pterodactyl panel: ${err.message}` },
        502,
      );
    }
    return json({ error: `Pterodactyl returned ${err.message}` }, 502);
  }

  // Probe live resources on one server first. If the stored key can't use the
  // client API, skip the fan-out to avoid a burst of failing requests.
  let liveSupported = false;
  const liveByIdentifier = {};
  const candidates = servers.filter((s) => s.identifier);
  if (candidates.length > 0) {
    const probe = await fetchPteroServerResources(
      panelUrl,
      apiKey,
      candidates[0].identifier,
    );
    if (probe) {
      liveSupported = true;
      liveByIdentifier[candidates[0].identifier] = probe;
      const rest = candidates.slice(1, 60);
      const results = await Promise.allSettled(
        rest.map((s) =>
          fetchPteroServerResources(panelUrl, apiKey, s.identifier),
        ),
      );
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value) {
          liveByIdentifier[rest[i].identifier] = r.value;
        }
      });
    }
  }

  // Only surface servers that are registered in IronSight.
  const { rows: registeredRows } = await pool.query(
    `SELECT server_id, server_name, ptero_identifier, last_health_ping FROM servers WHERE owner_org_id = $1 AND ptero_identifier IS NOT NULL`,
    [orgId],
  );
  const registeredByIdentifier = new Map(
    registeredRows.map((r) => [r.ptero_identifier, r]),
  );

  const mergedServers = servers
    .filter((s) => s.identifier && registeredByIdentifier.has(s.identifier))
    .map((s) => {
      const reg = registeredByIdentifier.get(s.identifier);
      return {
        ...s,
        live: liveByIdentifier[s.identifier] ?? null,
        ironsightServerId: reg.server_id,
        ironsightServerName: reg.server_name,
        lastHealthPing: reg.last_health_ping
          ? Number(reg.last_health_ping)
          : null,
      };
    });

  await pool.query(
    `UPDATE ptero_api_keys SET last_used_at = unix_now() WHERE org_id = $1`,
    [orgId],
  );

  return json({
    connected: true,
    liveSupported,
    nodes,
    servers: mergedServers,
  });
}

// Mint a short-lived Wings websocket token + socket URL for a server so the
// browser can stream live stats. Requires a client-capable API key.
async function handleGetPteroServerWebsocket(request, orgId, identifier) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "rcon_access") &&
      !orgHasPermission(session, orgId, "servers_manage")) {
    return json({ error: "Forbidden: rcon_access or servers_manage permission required" }, 403);
  }

  // Verify the requested identifier belongs to a server registered under this org.
  // Without this check a user could pass any arbitrary Pterodactyl identifier and
  // obtain websocket credentials for a server owned by a different organization if
  // both orgs share the same Pterodactyl panel.
  const ownershipRes = await pool.query(
    `SELECT server_id FROM servers WHERE ptero_identifier = $1 AND owner_org_id = $2 LIMIT 1`,
    [identifier, orgId],
  );
  if (!ownershipRes.rows[0]) {
    return json({ error: "Server not found in this organization" }, 404);
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch (err) {
    console.error("[ptero] Failed to load credentials:", err.message);
    return json({ error: "Stored Pterodactyl credentials are invalid." }, 500);
  }
  if (!credentials) {
    return json({ error: "Pterodactyl not connected for this org" }, 400);
  }

  const { panelUrl, apiKey } = credentials;
  let res;
  try {
    res = await fetch(
      `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/websocket`,
      { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(8000) },
    );
  } catch (err) {
    return json(
      {
        error: `Could not reach Pterodactyl panel: ${String(err.message ?? err)}`,
      },
      502,
    );
  }

  if (res.status === 401 || res.status === 403) {
    return json(
      {
        error:
          "The stored key cannot open the live websocket. A Pterodactyl client API key is required for real-time stats.",
      },
      400,
    );
  }
  if (!res.ok) {
    return json({ error: `Pterodactyl returned HTTP ${res.status}` }, 502);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ error: "Invalid response from panel" }, 502);
  }
  const attr = data?.data ?? data?.attributes ?? {};
  if (!attr.socket || !attr.token) {
    return json({ error: "Panel did not return websocket credentials" }, 502);
  }

  return json({ socket: attr.socket, token: attr.token });
}

async function handleDeleteServer(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT server_id, owner_org_id, server_name FROM servers WHERE server_id = $1 LIMIT 1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);

  const { owner_org_id } = serverRes.rows[0];
  if (!orgHasPermission(session, owner_org_id, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  await pool.query(`DELETE FROM servers WHERE server_id = $1`, [serverId]);

  try {
    const userOrgs = await listUserOrganizations(session.userId);
    if (userOrgs.length) await invalidateServerListCache(userOrgs.map((o) => o.orgId));
  } catch {}

  return json({ ok: true });
}

async function handleRotateServerKey(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT server_id, server_name, owner_org_id FROM servers WHERE server_id = $1 LIMIT 1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);

  const { owner_org_id, server_name } = serverRes.rows[0];
  if (!orgHasPermission(session, owner_org_id, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  const plainApiKey = crypto.randomBytes(32).toString("hex");
  const apiKeyHash = crypto
    .createHash("sha256")
    .update(plainApiKey)
    .digest("hex");

  await pool.query(
    `UPDATE servers SET api_key_hash = $2 WHERE server_id = $1`,
    [serverId, apiKeyHash],
  );

  return json({ ok: true, apiKey: plainApiKey, serverName: server_name });
}

// ── Server registration & chat ingest ────────────────────────────────────────

async function handleRegisterServer(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const serverName = String(body?.serverName ?? "").trim();
  const orgId = String(body?.orgId ?? "").trim();

  if (!serverName || !orgId) {
    return json({ error: "serverName and orgId are required" }, 400);
  }
  if (serverName.length > 128) {
    return json({ error: "serverName must be 128 characters or fewer" }, 400);
  }

  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  const plainApiKey = crypto.randomBytes(32).toString("hex");
  const apiKeyHash = crypto
    .createHash("sha256")
    .update(plainApiKey)
    .digest("hex");
  const serverId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO servers (server_id, server_name, owner_org_id, api_key_hash, added_by_user_id)
     VALUES ($1, $2, $3, $4, (SELECT user_id FROM users WHERE user_id = $5 LIMIT 1))`,
    [serverId, serverName, orgId, apiKeyHash, session.userId],
  );

  try {
    const userOrgs = await listUserOrganizations(session.userId);
    if (userOrgs.length) await invalidateServerListCache(userOrgs.map((o) => o.orgId));
  } catch {}

  return json(
    {
      ok: true,
      server: { serverId, serverName, ownerOrgId: orgId },
      apiKey: plainApiKey,
    },
    201,
  );
}

async function invalidateServerListCache(orgIds) {
  try {
    await redis.del(`servers:by-orgs:${[...orgIds].sort().join("|")}`);
  } catch {}
}

async function handleListServers(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const userOrgs = await listUserOrganizations(session.userId);
  if (!userOrgs.length) return json({ servers: [] });

  const orgIds = userOrgs.map((o) => o.orgId);
  const serversCacheKey = `servers:by-orgs:${[...orgIds].sort().join("|")}`;

  try {
    const cached = await redis.get(serversCacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch {}

  const { rows } = await pool.query(
    `SELECT server_id, server_name, owner_org_id, created_at, ptero_identifier,
            rcon_host, rcon_port, game_port, tags, last_health_ping,
            (rcon_password_enc IS NOT NULL AND rcon_host IS NOT NULL AND rcon_port IS NOT NULL) AS rcon_configured
     FROM servers
     WHERE owner_org_id = ANY($1::text[])
     ORDER BY server_name ASC`,
    [orgIds],
  );

  const result = {
    servers: rows.map((row) => ({
      serverId: String(row.server_id),
      serverName: String(row.server_name),
      ownerOrgId: String(row.owner_org_id),
      createdAt: row.created_at ? Number(row.created_at) : null,
      pteroIdentifier: row.ptero_identifier ?? null,
      rconConfigured: row.rcon_configured === true,
      rconHost: row.rcon_host ?? null,
      rconPort: row.rcon_port ?? null,
      gamePort: row.game_port ?? null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      lastHealthPing: row.last_health_ping
        ? Number(row.last_health_ping)
        : null,
    })),
  };

  try {
    await redis.set(serversCacheKey, JSON.stringify(result), "EX", 30);
  } catch {}

  return json(result);
}

// ── Public org server list (for ticket submission portal) ────────────────────

async function handleListPublicOrgServers(request, orgId) {
  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  const { rows } = await pool.query(
    `SELECT server_id, server_name, tags
     FROM servers
     WHERE owner_org_id = $1
     ORDER BY server_name ASC`,
    [orgId],
  );
  return json({
    servers: rows.map((r) => ({
      serverId: String(r.server_id),
      serverName: String(r.server_name),
      tags: Array.isArray(r.tags) ? r.tags : [],
    })),
  });
}

// ── Scripts ──────────────────────────────────────────────────────────────────

async function handleListScripts(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "scripts_view")) {
    return json({ error: "Forbidden: scripts_view permission required" }, 403);
  }

  const { rows } = await pool.query(
    `SELECT script_id, name, command, description, min_rank, created_at, updated_at
     FROM org_scripts WHERE org_id = $1 ORDER BY name ASC`,
    [orgId],
  );

  return json({
    scripts: rows.map((row) => ({
      id: String(row.script_id),
      name: String(row.name),
      command: String(row.command),
      description: String(row.description),
      minRank: Number(row.min_rank),
      createdAt: row.created_at ? Number(row.created_at) : null,
      updatedAt: row.updated_at ? Number(row.updated_at) : null,
    })),
  });
}

async function handleCreateScript(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "scripts_manage")) {
    return json({ error: "Forbidden: scripts_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const name = String(body?.name ?? "").trim();
  const command = String(body?.command ?? "").trim();
  const description = String(body?.description ?? "").trim();
  const minRank = Number(body?.minRank ?? 1);

  if (!name) return json({ error: "name is required" }, 400);
  if (!command) return json({ error: "command is required" }, 400);
  if (name.length > 128)
    return json({ error: "name must be 128 characters or fewer" }, 400);
  if (!Number.isInteger(minRank) || minRank < 1 || minRank > 5)
    return json({ error: "minRank must be 1–5" }, 400);

  const { rows } = await pool.query(
    `INSERT INTO org_scripts (org_id, name, command, description, min_rank, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING script_id, name, command, description, min_rank, created_at, updated_at`,
    [orgId, name, command, description, minRank, session.userId],
  );
  const row = rows[0];

  return json(
    {
      script: {
        id: String(row.script_id),
        name: String(row.name),
        command: String(row.command),
        description: String(row.description),
        minRank: Number(row.min_rank),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      },
    },
    201,
  );
}

async function handleUpdateScript(request, orgId, scriptId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "scripts_manage")) {
    return json({ error: "Forbidden: scripts_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const existingRes = await pool.query(
    `SELECT script_id FROM org_scripts WHERE script_id = $1 AND org_id = $2`,
    [scriptId, orgId],
  );
  if (!existingRes.rows[0]) return json({ error: "Script not found" }, 404);

  const setClauses = [];
  const params = [];

  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return json({ error: "name is required" }, 400);
    if (name.length > 128)
      return json({ error: "name must be 128 characters or fewer" }, 400);
    params.push(name);
    setClauses.push(`name = $${params.length}`);
  }
  if (body?.command !== undefined) {
    const command = String(body.command).trim();
    if (!command) return json({ error: "command is required" }, 400);
    params.push(command);
    setClauses.push(`command = $${params.length}`);
  }
  if (body?.description !== undefined) {
    params.push(String(body.description).trim());
    setClauses.push(`description = $${params.length}`);
  }
  if (body?.minRank !== undefined) {
    const minRank = Number(body.minRank);
    if (!Number.isInteger(minRank) || minRank < 1 || minRank > 5)
      return json({ error: "minRank must be 1–5" }, 400);
    params.push(minRank);
    setClauses.push(`min_rank = $${params.length}`);
  }

  if (setClauses.length === 0)
    return json({ error: "No fields to update" }, 400);
  setClauses.push(`updated_at = unix_now()`);

  params.push(scriptId);
  params.push(orgId);

  const { rows } = await pool.query(
    `UPDATE org_scripts SET ${setClauses.join(", ")}
     WHERE script_id = $${params.length - 1} AND org_id = $${params.length}
     RETURNING script_id, name, command, description, min_rank, created_at, updated_at`,
    params,
  );
  const row = rows[0];

  return json({
    script: {
      id: String(row.script_id),
      name: String(row.name),
      command: String(row.command),
      description: String(row.description),
      minRank: Number(row.min_rank),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    },
  });
}

async function handleDeleteScript(request, orgId, scriptId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "scripts_manage")) {
    return json({ error: "Forbidden: scripts_manage permission required" }, 403);
  }

  const res = await pool.query(
    `DELETE FROM org_scripts WHERE script_id = $1 AND org_id = $2`,
    [scriptId, orgId],
  );
  if (res.rowCount === 0) return json({ error: "Script not found" }, 404);

  return json({ ok: true });
}

// ── Manage Org: Pre-defines ─────────────────────────────────────────────────

function serializePredefine(row) {
  return {
    id: String(row.predefine_id),
    keyword: String(row.keyword),
    extraKeywords: Array.isArray(row.extra_keywords) ? row.extra_keywords : [],
    content: String(row.content),
  };
}

async function requireOrgMemberOrAdmin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return { error };
  const memberRes = await pool.query(
    `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, session.userId],
  );
  if (!memberRes.rows[0] && !canManageOrg(session, orgId)) {
    return { error: json({ error: "Forbidden" }, 403) };
  }
  return { session };
}

async function handleListOrgPredefines(request, orgId) {
  const { session, error } = await requireOrgMemberOrAdmin(request, orgId);
  if (error) return error;
  void session;

  const { rows } = await pool.query(
    `SELECT predefine_id, keyword, extra_keywords, content
     FROM org_predefines WHERE org_id = $1 ORDER BY keyword ASC`,
    [orgId],
  );
  return json({ predefines: rows.map(serializePredefine) });
}

function normalizeExtraKeywords(value) {
  if (!Array.isArray(value)) return [];
  return value.map((k) => String(k).trim()).filter((k) => k.length > 0);
}

async function handleCreateOrgPredefine(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "predefines_manage")) {
    return json({ error: "Forbidden: predefines_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const keyword = String(body?.keyword ?? "").trim();
  const content = String(body?.content ?? "").trim();
  const extraKeywords = normalizeExtraKeywords(body?.extraKeywords);
  if (!keyword) return json({ error: "Keyword is required." }, 400);
  if (!content) return json({ error: "Content is required." }, 400);
  if (keyword.length > 128)
    return json({ error: "Keyword must be 128 characters or fewer." }, 400);

  const { rows } = await pool.query(
    `INSERT INTO org_predefines (org_id, keyword, extra_keywords, content, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING predefine_id, keyword, extra_keywords, content`,
    [orgId, keyword, extraKeywords, content, session.userId],
  );
  return json({ predefine: serializePredefine(rows[0]) }, 201);
}

async function handleUpdateOrgPredefine(request, orgId, predefineId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "predefines_manage")) {
    return json({ error: "Forbidden: predefines_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const existing = await pool.query(
    `SELECT predefine_id FROM org_predefines WHERE predefine_id = $1 AND org_id = $2`,
    [predefineId, orgId],
  );
  if (!existing.rows[0]) return json({ error: "Pre-define not found" }, 404);

  const setClauses = [];
  const params = [];
  if (body?.keyword !== undefined) {
    const keyword = String(body.keyword).trim();
    if (!keyword) return json({ error: "Keyword is required." }, 400);
    if (keyword.length > 128)
      return json({ error: "Keyword must be 128 characters or fewer." }, 400);
    params.push(keyword);
    setClauses.push(`keyword = $${params.length}`);
  }
  if (body?.content !== undefined) {
    const content = String(body.content).trim();
    if (!content) return json({ error: "Content is required." }, 400);
    params.push(content);
    setClauses.push(`content = $${params.length}`);
  }
  if (body?.extraKeywords !== undefined) {
    params.push(normalizeExtraKeywords(body.extraKeywords));
    setClauses.push(`extra_keywords = $${params.length}`);
  }
  if (setClauses.length === 0)
    return json({ error: "No fields to update" }, 400);
  setClauses.push(`updated_at = unix_now()`);

  params.push(predefineId);
  params.push(orgId);
  const { rows } = await pool.query(
    `UPDATE org_predefines SET ${setClauses.join(", ")}
     WHERE predefine_id = $${params.length - 1} AND org_id = $${params.length}
     RETURNING predefine_id, keyword, extra_keywords, content`,
    params,
  );
  return json({ predefine: serializePredefine(rows[0]) });
}

async function handleDeleteOrgPredefine(request, orgId, predefineId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "predefines_manage")) {
    return json({ error: "Forbidden: predefines_manage permission required" }, 403);
  }

  const res = await pool.query(
    `DELETE FROM org_predefines WHERE predefine_id = $1 AND org_id = $2`,
    [predefineId, orgId],
  );
  if (res.rowCount === 0) return json({ error: "Pre-define not found" }, 404);
  return json({ ok: true });
}

// ── Manage Org: Toxicity phrases ────────────────────────────────────────────

async function handleGetOrgToxicity(request, orgId) {
  const { session, error } = await requireOrgMemberOrAdmin(request, orgId);
  if (error) return error;
  void session;

  const toxicityCacheKey = `org:toxicity:${orgId}`;
  try {
    const cached = await redis.get(toxicityCacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch {}

  const { rows } = await pool.query(
    `SELECT yellow, red FROM org_toxicity_config WHERE org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  const result = {
    yellow: Array.isArray(row?.yellow) ? row.yellow : [],
    red: Array.isArray(row?.red) ? row.red : [],
  };

  try {
    await redis.set(toxicityCacheKey, JSON.stringify(result), "EX", 60);
  } catch {}

  return json(result);
}

async function handleSetOrgToxicity(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "toxicity_manage")) {
    return json({ error: "Forbidden: toxicity_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const cleanPhrases = (value) =>
    Array.isArray(value)
      ? value.map((p) => String(p).trim()).filter((p) => p.length > 0)
      : null;

  // Accept either a single { kind, phrases } update or a full { yellow, red }.
  let column = null;
  let phrases = null;
  if (body?.kind === "yellow" || body?.kind === "red") {
    column = body.kind;
    phrases = cleanPhrases(body.phrases);
    if (phrases === null)
      return json({ error: "phrases must be an array" }, 400);
  }

  const setYellow = column === "yellow" ? phrases : cleanPhrases(body?.yellow);
  const setRed = column === "red" ? phrases : cleanPhrases(body?.red);

  await pool.query(
    `INSERT INTO org_toxicity_config (org_id, yellow, red, updated_at)
     VALUES ($1, COALESCE($2::text[], '{}'), COALESCE($3::text[], '{}'), unix_now())
     ON CONFLICT (org_id) DO UPDATE SET
       yellow = COALESCE($2::text[], org_toxicity_config.yellow),
       red = COALESCE($3::text[], org_toxicity_config.red),
       updated_at = unix_now()`,
    [orgId, setYellow, setRed],
  );

  const { rows } = await pool.query(
    `SELECT yellow, red FROM org_toxicity_config WHERE org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  try { await redis.del(`org:toxicity:${orgId}`); } catch {}
  return json({
    yellow: Array.isArray(row?.yellow) ? row.yellow : [],
    red: Array.isArray(row?.red) ? row.red : [],
  });
}

// ── Manage Org: Ban/mute configs ────────────────────────────────────────────

const BAN_CONFIG_CATEGORIES = ["cheating", "teaming", "toxicity", "mute"];

const DEFAULT_BAN_NOTE_FORMATS = {
  cheating:
    "Ban issued for cheating.\n\nEvidence: \nDemo/clip link: \nDate of offense: \nReviewed by: ",
  teaming:
    "Ban issued for teaming.\n\nGroup size limit: \nPlayers involved: \nEvidence: \nReviewed by: ",
  toxicity:
    "Ban issued for toxicity.\n\nChat log excerpt:\n\nContext: \nPrevious warnings: \nReviewed by: ",
  mute: "Mute issued for toxicity.\n\nChat log excerpt:\n\nContext: \nPrevious warnings: \nReviewed by: ",
};

async function buildOrgBanConfig(orgId) {
  const banConfigCacheKey = `org:ban-config:${orgId}`;
  try {
    const cached = await redis.get(banConfigCacheKey);
    if (cached) return JSON.parse(cached);
  } catch {}

  const reasonsRes = await pool.query(
    `SELECT reason_id, category, label FROM org_ban_reasons
     WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  const notesRes = await pool.query(
    `SELECT category, note_format FROM org_ban_note_formats WHERE org_id = $1`,
    [orgId],
  );

  const noteByCat = {};
  for (const row of notesRes.rows) noteByCat[row.category] = row.note_format;

  const make = (category) => ({
    reasons: reasonsRes.rows
      .filter((r) => r.category === category)
      .map((r) => ({ id: String(r.reason_id), label: String(r.label) })),
    noteFormat: noteByCat[category] ?? DEFAULT_BAN_NOTE_FORMATS[category] ?? "",
  });

  const result = {
    configs: {
      cheating: make("cheating"),
      teaming: make("teaming"),
      toxicity: make("toxicity"),
    },
    mute: make("mute"),
  };

  try {
    await redis.set(banConfigCacheKey, JSON.stringify(result), "EX", 60);
  } catch {}

  return result;
}

async function handleGetOrgBanConfigs(request, orgId) {
  const { session, error } = await requireOrgMemberOrAdmin(request, orgId);
  if (error) return error;
  void session;
  return json(await buildOrgBanConfig(orgId));
}

async function handleCreateBanReason(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "ban_configs_manage")) {
    return json({ error: "Forbidden: ban_configs_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const category = String(body?.category ?? "").trim();
  const label = String(body?.label ?? "").trim();
  if (!BAN_CONFIG_CATEGORIES.includes(category))
    return json({ error: "Invalid category" }, 400);
  if (!label) return json({ error: "Reason cannot be empty." }, 400);
  if (label.length > 200)
    return json({ error: "Reason must be 200 characters or fewer." }, 400);

  const { rows } = await pool.query(
    `INSERT INTO org_ban_reasons (org_id, category, label)
     VALUES ($1, $2, $3)
     RETURNING reason_id, label`,
    [orgId, category, label],
  );
  try { await redis.del(`org:ban-config:${orgId}`); } catch {}
  return json(
    {
      reason: { id: String(rows[0].reason_id), label: String(rows[0].label) },
    },
    201,
  );
}

async function handleUpdateBanReason(request, orgId, reasonId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "ban_configs_manage")) {
    return json({ error: "Forbidden: ban_configs_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const label = String(body?.label ?? "").trim();
  if (!label) return json({ error: "Reason cannot be empty." }, 400);
  if (label.length > 200)
    return json({ error: "Reason must be 200 characters or fewer." }, 400);

  const { rows } = await pool.query(
    `UPDATE org_ban_reasons SET label = $1
     WHERE reason_id = $2 AND org_id = $3
     RETURNING reason_id, label`,
    [label, reasonId, orgId],
  );
  if (!rows[0]) return json({ error: "Reason not found" }, 404);
  try { await redis.del(`org:ban-config:${orgId}`); } catch {}
  return json({
    reason: { id: String(rows[0].reason_id), label: String(rows[0].label) },
  });
}

async function handleDeleteBanReason(request, orgId, reasonId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "ban_configs_manage")) {
    return json({ error: "Forbidden: ban_configs_manage permission required" }, 403);
  }

  const res = await pool.query(
    `DELETE FROM org_ban_reasons WHERE reason_id = $1 AND org_id = $2`,
    [reasonId, orgId],
  );
  if (res.rowCount === 0) return json({ error: "Reason not found" }, 404);
  try { await redis.del(`org:ban-config:${orgId}`); } catch {}
  return json({ ok: true });
}

async function handleSetBanNoteFormat(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "ban_configs_manage")) {
    return json({ error: "Forbidden: ban_configs_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const category = String(body?.category ?? "").trim();
  const noteFormat = String(body?.noteFormat ?? "");
  if (!BAN_CONFIG_CATEGORIES.includes(category))
    return json({ error: "Invalid category" }, 400);

  await pool.query(
    `INSERT INTO org_ban_note_formats (org_id, category, note_format, updated_at)
     VALUES ($1, $2, $3, unix_now())
     ON CONFLICT (org_id, category) DO UPDATE SET
       note_format = EXCLUDED.note_format, updated_at = unix_now()`,
    [orgId, category, noteFormat],
  );
  try { await redis.del(`org:ban-config:${orgId}`); } catch {}
  return json({ ok: true, category, noteFormat });
}

// ── Plugin presets ────────────────────────────────────────────────────────────

async function handleListPlugins(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
    return json({ error: "Forbidden: presets_manage permission required" }, 403);
  }

  const { rows } = await pool.query(
    `SELECT plugin_id, name, source, umod_slug, installed_version, latest_version,
            latest_updated_at, assigned_tags, risk, enabled, created_at
     FROM org_plugins WHERE org_id = $1 ORDER BY name ASC`,
    [orgId],
  );

  return json({
    plugins: rows.map((r) => ({
      id: r.plugin_id,
      name: r.name,
      source: r.source,
      umodSlug: r.umod_slug ?? null,
      installedVersion: r.installed_version ?? null,
      latestVersion: r.latest_version ?? null,
      latestUpdatedAt: r.latest_updated_at ?? null,
      assignedTags: Array.isArray(r.assigned_tags) ? r.assigned_tags : [],
      risk: r.risk,
      enabled: r.enabled,
      createdAt: r.created_at,
    })),
  });
}

async function handleCreatePlugin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
    return json({ error: "Forbidden: presets_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const name = String(body?.name ?? "").trim();
  const source = String(body?.source ?? "umod").trim();
  if (!name) return json({ error: "name is required" }, 400);
  if (!["umod", "custom"].includes(source))
    return json({ error: "source must be umod or custom" }, 400);

  const umodSlug =
    source === "umod" ? String(body?.umodSlug ?? "").trim() || null : null;
  const installedVersion = String(body?.installedVersion ?? "").trim() || null;
  const latestVersion = String(body?.latestVersion ?? "").trim() || null;
  const latestUpdatedAt = body?.latestUpdatedAt
    ? Number(body.latestUpdatedAt)
    : null;
  const assignedTags = Array.isArray(body?.assignedTags)
    ? body.assignedTags.map(String).filter(Boolean)
    : [];
  const risk = Number(body?.risk ?? 2);
  if (![1, 2, 3].includes(risk))
    return json({ error: "risk must be 1, 2, or 3" }, 400);

  const { rows } = await pool.query(
    `INSERT INTO org_plugins
       (org_id, name, source, umod_slug, installed_version, latest_version,
        latest_updated_at, assigned_tags, risk, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
     ON CONFLICT (org_id, name) DO NOTHING
     RETURNING plugin_id`,
    [
      orgId,
      name,
      source,
      umodSlug,
      installedVersion,
      latestVersion,
      latestUpdatedAt,
      JSON.stringify(assignedTags),
      risk,
    ],
  );

  if (rows.length === 0) {
    return json({ error: "A plugin with that name already exists" }, 409);
  }

  return json({ ok: true, pluginId: rows[0].plugin_id });
}

async function handleUpdatePlugin(request, orgId, pluginId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
    return json({ error: "Forbidden: presets_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const setClauses = [];
  const params = [];

  if (body?.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) return json({ error: "name cannot be empty" }, 400);
    params.push(n);
    setClauses.push(`name = $${params.length}`);
  }
  if (body?.risk !== undefined) {
    const r = Number(body.risk);
    if (![1, 2, 3].includes(r))
      return json({ error: "risk must be 1, 2, or 3" }, 400);
    params.push(r);
    setClauses.push(`risk = $${params.length}`);
  }
  if (body?.enabled !== undefined) {
    params.push(Boolean(body.enabled));
    setClauses.push(`enabled = $${params.length}`);
  }
  if (body?.assignedTags !== undefined) {
    const tags = Array.isArray(body.assignedTags)
      ? body.assignedTags.map(String).filter(Boolean)
      : [];
    params.push(JSON.stringify(tags));
    setClauses.push(`assigned_tags = $${params.length}`);
  }
  if (body?.installedVersion !== undefined) {
    params.push(String(body.installedVersion).trim() || null);
    setClauses.push(`installed_version = $${params.length}`);
  }
  if (body?.latestVersion !== undefined) {
    params.push(String(body.latestVersion).trim() || null);
    setClauses.push(`latest_version = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return json({ error: "No fields to update" }, 400);
  }

  params.push(pluginId);
  params.push(orgId);

  const res = await pool.query(
    `UPDATE org_plugins SET ${setClauses.join(", ")}
     WHERE plugin_id = $${params.length - 1} AND org_id = $${params.length}
     RETURNING name, enabled, assigned_tags`,
    params,
  );

  if (res.rowCount === 0) return json({ error: "Plugin not found" }, 404);

  return json({ ok: true });
}

async function handleDeletePlugin(request, orgId, pluginId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
    return json({ error: "Forbidden: presets_manage permission required" }, 403);
  }

  const res = await pool.query(
    `DELETE FROM org_plugins WHERE plugin_id = $1 AND org_id = $2`,
    [pluginId, orgId],
  );
  if (res.rowCount === 0) return json({ error: "Plugin not found" }, 404);

  return json({ ok: true });
}

async function getServersForRcon(orgId, tags) {
  const { rows } = await pool.query(
    `SELECT server_id, rcon_host, rcon_port, rcon_password_enc
     FROM servers
     WHERE owner_org_id = $1
       AND rcon_host IS NOT NULL
       AND rcon_port IS NOT NULL
       AND rcon_password_enc IS NOT NULL
       AND tags && $2::text[]`,
    [orgId, tags],
  );
  return rows;
}

async function handlePluginPush(request, orgId, pluginId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
    return json({ error: "Forbidden: presets_manage permission required" }, 403);
  }

  const pluginRes = await pool.query(
    `SELECT name, assigned_tags, latest_version FROM org_plugins
     WHERE plugin_id = $1 AND org_id = $2`,
    [pluginId, orgId],
  );
  if (!pluginRes.rows[0]) return json({ error: "Plugin not found" }, 404);

  const { name, assigned_tags, latest_version } = pluginRes.rows[0];
  // Strip control chars before interpolating into the RCON console command.
  const safeName = String(name).replace(/[\r\n\x00-\x1f]/g, "");
  const tags = Array.isArray(assigned_tags) ? assigned_tags : [];

  const results = { pushed: [], failed: [] };

  if (tags.length > 0) {
    const servers = await getServersForRcon(orgId, tags);
    await Promise.allSettled(
      servers.map(async (s) => {
        let password;
        try {
          password = decryptPterodactylApiKey(String(s.rcon_password_enc));
        } catch {
          results.failed.push(s.server_id);
          return;
        }
        const rconUrl = `ws://${s.rcon_host}:${s.rcon_port}/${encodeURIComponent(password)}`;
        try {
          await executeRconCommand(rconUrl, `oxide.reload ${safeName}`);
          results.pushed.push(s.server_id);
        } catch {
          results.failed.push(s.server_id);
        }
      }),
    );
  }

  if (latest_version) {
    await pool.query(
      `UPDATE org_plugins SET installed_version = latest_version WHERE plugin_id = $1`,
      [pluginId],
    );
  }

  return json({ ok: true, ...results });
}

async function handleUnloadRisk(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
    return json({ error: "Forbidden: presets_manage permission required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const risk = Number(body?.risk ?? 0);
  if (![1, 2, 3].includes(risk))
    return json({ error: "risk must be 1, 2, or 3" }, 400);

  const { rows: plugins } = await pool.query(
    `SELECT plugin_id, name, assigned_tags FROM org_plugins
     WHERE org_id = $1 AND risk = $2 AND enabled = TRUE`,
    [orgId, risk],
  );

  const results = { unloaded: [], failed: [] };

  await Promise.allSettled(
    plugins.map(async (p) => {
      const tags = Array.isArray(p.assigned_tags) ? p.assigned_tags : [];
      if (tags.length === 0) return;
      const servers = await getServersForRcon(orgId, tags);
      await Promise.allSettled(
        servers.map(async (s) => {
          let password;
          try {
            password = decryptPterodactylApiKey(String(s.rcon_password_enc));
          } catch {
            results.failed.push({
              pluginId: p.plugin_id,
              serverId: s.server_id,
            });
            return;
          }
          const rconUrl = `ws://${s.rcon_host}:${s.rcon_port}/${encodeURIComponent(password)}`;
          try {
            await executeRconCommand(
              rconUrl,
              `oxide.unload ${String(p.name).replace(/[\r\n\x00-\x1f]/g, "")}`,
            );
            results.unloaded.push({
              pluginId: p.plugin_id,
              serverId: s.server_id,
            });
          } catch {
            results.failed.push({
              pluginId: p.plugin_id,
              serverId: s.server_id,
            });
          }
        }),
      );
    }),
  );

  await pool.query(
    `UPDATE org_plugins SET enabled = FALSE WHERE org_id = $1 AND risk = $2 AND enabled = TRUE`,
    [orgId, risk],
  );

  return json({ ok: true, ...results });
}

// ── Plugin Configs (Pterodactyl file discovery) ────────────────────────────────

function parseOxidePluginMeta(content) {
  const info = content.match(
    /\[Info\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)\]/,
  );
  const desc = content.match(/\[Description\s*\(\s*"([^"]*)"\s*\)\]/);
  if (!info) return null;
  return {
    name: info[1],
    author: info[2],
    version: info[3],
    description: desc ? desc[1] : null,
  };
}

function parseOxidePluginList(output) {
  const map = {};
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !/^\d+\s/.test(trimmed)) continue;
    const failedMatch = trimmed.match(/^\d+\s+(\S+)\s+-\s+Failed to compile:\s*(.*)/);
    if (failedMatch) {
      map[failedMatch[1]] = { status: "failed", error: failedMatch[2].trim() };
      continue;
    }
    const activeMatch = trimmed.match(/-\s+([\w.]+)\.cs(?:\s*\([^)]*\))?\s*$/);
    if (activeMatch) {
      map[activeMatch[1]] = { status: "active" };
    }
  }
  return map;
}

function safePluginName(raw) {
  const name = String(raw ?? "").trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name) || name.includes(".."))
    return null;
  return name;
}

async function fetchPteroFileList(panelUrl, apiKey, identifier, directory) {
  const res = await fetch(
    `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/files/list?directory=${encodeURIComponent(directory)}`,
    { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(12000) },
  );
  if (!res.ok) throw new Error(`ptero_file_list_${res.status}`);
  const data = await res.json();
  return (data?.data ?? []).map((f) => f.attributes).filter(Boolean);
}

async function fetchPteroFileContents(panelUrl, apiKey, identifier, filePath) {
  const res = await fetch(
    `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/files/contents?file=${encodeURIComponent(filePath)}`,
    { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`ptero_file_read_${res.status}`);
  return res.text();
}

async function writePteroFile(panelUrl, apiKey, identifier, filePath, content) {
  const res = await fetch(
    `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/files/write?file=${encodeURIComponent(filePath)}`,
    {
      method: "POST",
      headers: { ...PTERO_HEADERS(apiKey), "Content-Type": "text/plain" },
      body: content,
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`ptero_file_write_${res.status}`);
}

async function deletePteroFiles(panelUrl, apiKey, identifier, root, files) {
  const res = await fetch(
    `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/files/delete`,
    {
      method: "POST",
      headers: { ...PTERO_HEADERS(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ root, files }),
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!res.ok) throw new Error(`ptero_file_delete_${res.status}`);
}

async function handleListPteroPlugins(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT owner_org_id, ptero_identifier, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const { owner_org_id, ptero_identifier, rcon_host, rcon_port, rcon_password_enc } =
    serverRes.rows[0];

  if (
    !orgHasPermission(session, owner_org_id, "presets_manage") &&
    !orgHasPermission(session, owner_org_id, "servers_manage")
  ) {
    return json({ error: "Forbidden" }, 403);
  }
  if (!ptero_identifier)
    return json({ error: "Server has no Pterodactyl identifier" }, 400);

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(owner_org_id);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  let files;
  try {
    files = await fetchPteroFileList(
      panelUrl,
      apiKey,
      ptero_identifier,
      "/oxide/plugins",
    );
  } catch (err) {
    return json({ error: `Failed to list plugins: ${err.message}` }, 502);
  }

  const csFiles = files.filter(
    (f) => f.is_file && f.name.toLowerCase().endsWith(".cs"),
  );

  const settled = await Promise.allSettled(
    csFiles.map(async (f) => {
      let meta = null;
      try {
        const src = await fetchPteroFileContents(
          panelUrl,
          apiKey,
          ptero_identifier,
          `/oxide/plugins/${f.name}`,
        );
        meta = parseOxidePluginMeta(src);
      } catch {
        // metadata unavailable — use filename fallback
      }
      const pluginName = f.name.replace(/\.cs$/i, "");
      return {
        fileName: f.name,
        pluginName,
        name: meta?.name ?? pluginName,
        author: meta?.author ?? null,
        version: meta?.version ?? null,
        description: meta?.description ?? null,
        modifiedAt: f.modified_at ?? null,
      };
    }),
  );

  const plugins = settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Enrich with live status from RCON if available
  let statusMap = {};
  if (rcon_host && rcon_port && rcon_password_enc) {
    try {
      const password = decryptPterodactylApiKey(String(rcon_password_enc));
      const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(password)}`;
      const result = await executeRconCommand(rconUrl, "oxide.plugins");
      statusMap = parseOxidePluginList(result.response);
    } catch {
      // RCON unavailable — return plugins without live status
    }
  }

  return json({
    plugins: plugins.map((p) => ({
      ...p,
      status: statusMap[p.pluginName]?.status ?? null,
      compileError: statusMap[p.pluginName]?.error ?? null,
    })),
    rconAvailable: rcon_host != null && rcon_port != null && rcon_password_enc != null,
  });
}

async function handleGetPteroPluginConfig(request, serverId, rawName) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const pluginName = safePluginName(rawName);
  if (!pluginName) return json({ error: "Invalid plugin name" }, 400);

  const serverRes = await pool.query(
    `SELECT owner_org_id, ptero_identifier FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const { owner_org_id, ptero_identifier } = serverRes.rows[0];

  if (
    !orgHasPermission(session, owner_org_id, "presets_manage") &&
    !orgHasPermission(session, owner_org_id, "servers_manage")
  ) {
    return json({ error: "Forbidden" }, 403);
  }
  if (!ptero_identifier)
    return json({ error: "Server has no Pterodactyl identifier" }, 400);

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(owner_org_id);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  try {
    const content = await fetchPteroFileContents(
      panelUrl,
      apiKey,
      ptero_identifier,
      `/oxide/config/${pluginName}.json`,
    );
    return json({ content });
  } catch (err) {
    if (err.message.includes("404")) return json({ content: null });
    return json({ error: `Failed to read config: ${err.message}` }, 502);
  }
}

async function handleSavePteroPluginConfig(request, serverId, rawName) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const pluginName = safePluginName(rawName);
  if (!pluginName) return json({ error: "Invalid plugin name" }, 400);

  const serverRes = await pool.query(
    `SELECT owner_org_id, ptero_identifier, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const { owner_org_id, ptero_identifier, rcon_host, rcon_port, rcon_password_enc } =
    serverRes.rows[0];

  if (!orgHasPermission(session, owner_org_id, "presets_manage")) {
    return json(
      { error: "Forbidden: presets_manage permission required" },
      403,
    );
  }
  if (!ptero_identifier)
    return json({ error: "Server has no Pterodactyl identifier" }, 400);

  let content;
  try {
    content = await request.text();
  } catch {
    return json({ error: "Failed to read request body" }, 400);
  }
  if (!content || content.length > 1_048_576)
    return json({ error: "Config body is empty or exceeds 1 MB" }, 400);
  try {
    JSON.parse(content);
  } catch {
    return json({ error: "Config must be valid JSON" }, 400);
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(owner_org_id);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  try {
    await writePteroFile(
      panelUrl,
      apiKey,
      ptero_identifier,
      `/oxide/config/${pluginName}.json`,
      content,
    );
  } catch (err) {
    return json({ error: `Failed to write config: ${err.message}` }, 502);
  }

  // Reload plugin via RCON so the new config takes effect
  if (rcon_host && rcon_port && rcon_password_enc) {
    let password;
    try {
      password = decryptPterodactylApiKey(String(rcon_password_enc));
    } catch {
      return json({
        ok: true,
        saved: true,
        rconError: "Failed to decrypt RCON password",
      });
    }
    const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(password)}`;
    try {
      const result = await executeRconCommand(
        rconUrl,
        `oxide.reload ${pluginName}`,
      );
      return json({ ok: true, saved: true, rconOutput: result.response });
    } catch (err) {
      return json({ ok: true, saved: true, rconError: err.message });
    }
  }

  return json({ ok: true, saved: true, rconOutput: null });
}

async function handlePteroPluginCmd(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT owner_org_id, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const { owner_org_id, rcon_host, rcon_port, rcon_password_enc } =
    serverRes.rows[0];

  if (!orgHasPermission(session, owner_org_id, "presets_manage")) {
    return json(
      { error: "Forbidden: presets_manage permission required" },
      403,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const cmd = String(body?.cmd ?? "").trim();
  const pluginName = safePluginName(body?.pluginName);

  if (!pluginName) return json({ error: "Invalid plugin name" }, 400);
  if (!["reload", "unload"].includes(cmd))
    return json({ error: "cmd must be reload or unload" }, 400);

  if (!rcon_host || !rcon_port || !rcon_password_enc)
    return json({ error: "RCON not configured for this server" }, 400);

  let password;
  try {
    password = decryptPterodactylApiKey(String(rcon_password_enc));
  } catch {
    return json({ error: "Failed to decrypt RCON password" }, 500);
  }

  const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(password)}`;
  const rconCmd =
    cmd === "reload"
      ? `oxide.reload ${pluginName}`
      : `oxide.unload ${pluginName}`;

  try {
    const result = await executeRconCommand(rconUrl, rconCmd);
    return json({
      ok: true,
      output: result.response,
      consoleLogs: result.consoleLogs,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

async function handleBulkDeletePteroPlugin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !orgHasPermission(session, orgId, "presets_manage") &&
    !canManageOrg(session, orgId)
  ) {
    return json({ error: "Forbidden" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const pluginName = safePluginName(body?.pluginName);
  if (!pluginName) return json({ error: "Invalid plugin name" }, 400);
  const deleteConfig = body?.deleteConfig === true;

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  const serversRes = await pool.query(
    `SELECT server_id, server_name, ptero_identifier FROM servers WHERE owner_org_id = $1 AND ptero_identifier IS NOT NULL`,
    [orgId],
  );
  const allServerRows = serversRes.rows;

  const requestedIds = Array.isArray(body?.serverIds) ? body.serverIds : null;
  const serverRows = requestedIds
    ? allServerRows.filter(
        (s) => requestedIds.includes(s.server_id),
      )
    : allServerRows;
  if (serverRows.length === 0)
    return json({ error: "No matching servers found" }, 400);

  const results = await Promise.allSettled(
    serverRows.map(async (s) => {
      await deletePteroFiles(
        panelUrl,
        apiKey,
        s.ptero_identifier,
        "/oxide/plugins",
        [`${pluginName}.cs`],
      );
      if (deleteConfig) {
        try {
          await deletePteroFiles(
            panelUrl,
            apiKey,
            s.ptero_identifier,
            "/oxide/config",
            [`${pluginName}.json`],
          );
        } catch {
          // Config file may not exist — ignore
        }
      }
    }),
  );

  return json({
    results: serverRows.map((s, i) => ({
      serverId: s.server_id,
      serverName: s.server_name,
      ok: results[i].status === "fulfilled",
      error:
        results[i].status === "rejected" ? String(results[i].reason) : null,
    })),
  });
}

async function handleBulkUploadPteroPlugin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !orgHasPermission(session, orgId, "presets_manage") &&
    !canManageOrg(session, orgId)
  ) {
    return json({ error: "Forbidden" }, 403);
  }

  const url = new URL(request.url);
  const rawFileName = url.searchParams.get("fileName") ?? "";
  if (
    !/^[a-zA-Z0-9._-]{1,64}\.cs$/i.test(rawFileName) ||
    rawFileName.includes("..")
  ) {
    return json({ error: "Invalid fileName parameter" }, 400);
  }
  const fileName = rawFileName;

  let content;
  try {
    content = await request.text();
  } catch {
    return json({ error: "Failed to read request body" }, 400);
  }
  if (!content || content.length > 10_485_760)
    return json({ error: "File body is empty or exceeds 10 MB" }, 400);

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  const rawServerIds = url.searchParams.get("serverIds");
  const requestedIds = rawServerIds
    ? rawServerIds.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const serversRes = await pool.query(
    `SELECT server_id, server_name, ptero_identifier FROM servers WHERE owner_org_id = $1 AND ptero_identifier IS NOT NULL`,
    [orgId],
  );
  const allServerRows = serversRes.rows;
  const serverRows = requestedIds
    ? allServerRows.filter((s) => requestedIds.includes(s.server_id))
    : allServerRows;
  if (serverRows.length === 0)
    return json({ error: "No matching servers found" }, 400);

  const results = await Promise.allSettled(
    serverRows.map((s) =>
      writePteroFile(
        panelUrl,
        apiKey,
        s.ptero_identifier,
        `/oxide/plugins/${fileName}`,
        content,
      ),
    ),
  );

  return json({
    fileName,
    results: serverRows.map((s, i) => ({
      serverId: s.server_id,
      serverName: s.server_name,
      ok: results[i].status === "fulfilled",
      error:
        results[i].status === "rejected" ? String(results[i].reason) : null,
    })),
  });
}

// ── Server RCON credentials ───────────────────────────────────────────────────

async function handleSetServerRcon(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT owner_org_id FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);

  const { owner_org_id } = serverRes.rows[0];
  if (!orgHasPermission(session, owner_org_id, "servers_manage")) {
    return json({ error: "Forbidden: servers_manage permission required" }, 403);
  }

  const encKey = getPterodactylEncryptionKey();
  if (!encKey) {
    return json(
      {
        error:
          "Encryption not configured (PTERODACTYL_ENCRYPTION_KEY or JWT_SECRET required)",
      },
      503,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const rconHost = String(body?.rconHost ?? "").trim();
  const rconPort = Number(body?.rconPort ?? 0);
  const rconPassword = String(body?.rconPassword ?? "").trim();
  const gamePort = body?.gamePort != null ? Number(body.gamePort) : null;
  const tags = Array.isArray(body?.tags)
    ? body.tags.map(String).filter(Boolean)
    : null;

  if (!rconHost) return json({ error: "rconHost is required" }, 400);
  if (!rconPort || rconPort < 1 || rconPort > 65535)
    return json({ error: "rconPort must be 1–65535" }, 400);
  if (!rconPassword) return json({ error: "rconPassword is required" }, 400);

  const encryptedPass = encryptPterodactylApiKey(rconPassword);

  const setClauses = [
    "rcon_host = $1",
    "rcon_port = $2",
    "rcon_password_enc = $3",
  ];
  const params = [rconHost, rconPort, encryptedPass];

  if (gamePort !== null) {
    params.push(gamePort);
    setClauses.push(`game_port = $${params.length}`);
  }
  if (tags !== null) {
    params.push(tags);
    setClauses.push(`tags = $${params.length}`);
  }

  params.push(serverId);
  await pool.query(
    `UPDATE servers SET ${setClauses.join(", ")} WHERE server_id = $${params.length}`,
    params,
  );

  const rconUrl = `ws://${rconHost}:${rconPort}/${encodeURIComponent(rconPassword)}`;
  let testPassed = false;
  let testError = null;
  try {
    await executeRconCommand(rconUrl, "version");
    testPassed = true;
  } catch (err) {
    testError = String(err?.message ?? err);
  }

  return json({ ok: true, testPassed, testError });
}

async function handleGetServerRconStatus(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT owner_org_id, rcon_host, rcon_port, rcon_password_enc, game_port, tags
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);

  const {
    owner_org_id,
    rcon_host,
    rcon_port,
    rcon_password_enc,
    game_port,
    tags,
  } = serverRes.rows[0];
  if (!orgHasPermission(session, owner_org_id, "rcon_access") &&
      !orgHasPermission(session, owner_org_id, "status_view")) {
    return json({ error: "Forbidden: rcon_access or status_view permission required" }, 403);
  }

  return json({
    configured: !!(rcon_host && rcon_port && rcon_password_enc),
    rconHost: rcon_host ?? null,
    rconPort: rcon_port ?? null,
    gamePort: game_port ?? null,
    tags: Array.isArray(tags) ? tags : [],
  });
}

function executeRconCommand(rconUrl, command) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let commandSent = false;
    const consoleLogs = [];

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      settle(reject, new Error("RCON connection timed out"));
    }, 10000);

    const ws = new WebSocket(rconUrl);
    const requestId = Math.floor(Math.random() * 100000) + 1;

    ws.addEventListener("open", () => {
      commandSent = true;
      ws.send(
        JSON.stringify({
          Identifier: requestId,
          Message: command,
          Name: "WebRcon",
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.Identifier === requestId) {
          try {
            ws.close(1000, "Done");
          } catch {
            /* noop */
          }
          settle(resolve, { response: String(msg.Message ?? ""), consoleLogs });
        } else if (msg.Identifier === -1 && commandSent) {
          consoleLogs.push(String(msg.Message ?? ""));
        }
      } catch {
        // ignore non-JSON messages
      }
    });

    ws.addEventListener("error", () => {
      settle(reject, new Error("RCON connection failed"));
    });

    ws.addEventListener("close", ({ code }) => {
      if (code !== 1000 && code !== 1001) {
        settle(reject, new Error(`RCON disconnected (${code})`));
      }
    });
  });
}

async function handleExecRconCommand(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT owner_org_id, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);

  const { owner_org_id, rcon_host, rcon_port, rcon_password_enc } =
    serverRes.rows[0];

  if (!orgHasPermission(session, owner_org_id, "rcon_access")) {
    return json({ error: "Forbidden: rcon_access permission required" }, 403);
  }

  const rl = await checkRateLimit(
    `rl:rcon:${session.userId}:${serverId}`,
    30,
    60,
  );
  if (rl) return rl;

  if (!rcon_host || !rcon_port || !rcon_password_enc) {
    return json({ error: "RCON not configured for this server" }, 400);
  }

  let rconPassword;
  try {
    rconPassword = decryptPterodactylApiKey(rcon_password_enc);
  } catch {
    return json({ error: "RCON credentials corrupted" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const command = String(body?.command ?? "").trim();
  if (!command) return json({ error: "command is required" }, 400);

  const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(rconPassword)}`;

  let rconResult = null;
  let rconErr = null;
  try {
    rconResult = await executeRconCommand(rconUrl, command);
  } catch (err) {
    rconErr = String(err?.message ?? err);
  }

  auditLog({
    orgId: owner_org_id,
    actorUserId: session.userId,
    resourceType: "server",
    resourceId: serverId,
    actionType: "RCON_COMMAND",
    actionCategory: "server_management",
    severity: 2,
    metadata: { command, success: rconErr === null },
    ipAddress: getClientIp(request),
  });

  if (rconErr) return json({ error: `RCON error: ${rconErr}` }, 502);
  return json({ ok: true, response: rconResult.response, consoleLogs: rconResult.consoleLogs });
}

async function handleServerHealthCheck(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) {
    return json(
      {
        error:
          "Missing API key (x-api-key header or Authorization: Bearer <key>)",
      },
      401,
    );
  }

  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKeyRaw)
    .digest("hex");

  const serverRes = await pool.query(
    "SELECT server_id, server_name FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) {
    return json({ error: "Invalid API key" }, 401);
  }
  const server = serverRes.rows[0];

  await pool.query(
    `UPDATE servers SET last_health_ping = unix_now() WHERE server_id = $1`,
    [server.server_id],
  );

  console.log(
    `[health-check] ping from server=${server.server_name} (${server.server_id})`,
  );
  return json({ ok: true });
}

const CHAT_INGEST_RATE_LIMIT_PER_MINUTE = 120;

async function handleIngestChatMessage(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) {
    console.log("[ingest:chat] rejected — missing API key");
    return json(
      {
        error:
          "Missing API key (x-api-key header or Authorization: Bearer <key>)",
      },
      401,
    );
  }

  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKeyRaw)
    .digest("hex");

  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) {
    console.log("[ingest:chat] rejected — invalid API key");
    return json({ error: "Invalid API key" }, 401);
  }
  const server = serverRes.rows[0];

  const rlKey = `rl:chat:${server.server_id}`;
  try {
    const attempts = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1,
      rlKey,
      "60",
    );
    if (attempts > CHAT_INGEST_RATE_LIMIT_PER_MINUTE) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
  } catch {
    // fail-open
  }

  let body;
  try {
    body = await request.json();
  } catch {
    console.log(
      `[ingest:chat] rejected — invalid JSON body (server=${server.server_name})`,
    );
    return json({ error: "Invalid JSON body" }, 400);
  }

  const message = String(body?.message ?? "").trim();
  const steamId = String(body?.steam_id ?? "").trim();
  const teamMessage = body?.team_message === true || body?.team_message === 1;
  const playerName =
    body?.player_name == null ? null : String(body.player_name).trim();

  if (!message || !steamId) {
    console.log(
      `[ingest:chat] rejected — missing message or steam_id (server=${server.server_name})`,
    );
    return json({ error: "message and steam_id are required" }, 400);
  }
  if (message.length > 1000) {
    console.log(
      `[ingest:chat] rejected — message too long (server=${server.server_name}, steamId=${steamId})`,
    );
    return json({ error: "message must be 1000 characters or fewer" }, 400);
  }
  if (steamId.length > 64)
    return json({ error: "steam_id must be 64 characters or fewer" }, 400);
  if (playerName && playerName.length > 128)
    return json({ error: "player_name must be 128 characters or fewer" }, 400);

  const insertRes = await pool.query(
    `INSERT INTO text_chat_log (message, steam_id, player_name, server_id, server_name, team_message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [
      message,
      steamId,
      playerName ?? null,
      server.server_id,
      server.server_name,
      teamMessage,
    ],
  );
  const row = insertRes.rows[0];
  const createdUnix = Number(row.created_at);

  console.log(
    `[ingest:chat] stored — id=${row.id} server=${server.server_name} player=${playerName ?? steamId} team=${teamMessage} msg=${JSON.stringify(message)}`,
  );

  // Cache in Redis sorted set (last 7 days window)
  const cacheKey = `chat:server:${server.server_id}`;
  const cacheEntry = JSON.stringify({
    id: String(row.id),
    message,
    steamId,
    playerName: playerName ?? null,
    teamMessage,
    ts: createdUnix,
  });
  const sevenDaysAgo = createdUnix - 7 * 24 * 3600;
  try {
    await redis.zadd(cacheKey, createdUnix, cacheEntry);
    await redis.zremrangebyscore(cacheKey, "-inf", sevenDaysAgo);
    await redis.expire(cacheKey, 7 * 24 * 3600);
  } catch {
    // Redis caching is best-effort; message is already persisted in Postgres
  }

  return json({ ok: true, id: String(row.id) }, 201);
}

async function handleGetChatLogs(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const serverId = (url.searchParams.get("serverId") ?? "").trim();
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  const limit = parseLimit(url.searchParams.get("limit"), 100, 200);
  // before: exclusive upper timestamp cursor (for loading older messages)
  // after: exclusive lower timestamp cursor (for polling new messages)
  const beforeParam = url.searchParams.get("before");
  const afterParam = url.searchParams.get("after");
  const before = beforeParam != null ? Math.floor(Number(beforeParam)) : null;
  const after = afterParam != null ? Math.floor(Number(afterParam)) : null;

  if (!serverId) return json({ error: "serverId is required" }, 400);

  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE server_id = $1 LIMIT 1",
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const server = serverRes.rows[0];

  if (!orgHasPermission(session, server.owner_org_id, "players_view") && !isConfiguredSysAdmin(session)) {
    return json({ error: "Forbidden: players_view permission required" }, 403);
  }

  const nowUnixTs = Math.floor(Date.now() / 1000);
  const startUnix = startParam
    ? Math.floor(Number(startParam))
    : nowUnixTs - 6 * 3600;
  const endUnix = endParam ? Math.floor(Number(endParam)) : nowUnixTs;

  if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix)) {
    return json({ error: "Invalid start or end parameter" }, 400);
  }
  if (startUnix > endUnix) {
    return json({ error: "start must not be after end" }, 400);
  }

  const fetch_limit = limit + 1; // fetch one extra to determine hasMore

  const sevenDaysAgoUnix = nowUnixTs - 7 * 24 * 3600;
  const cacheKey = `chat:server:${serverId}`;

  // Serve from Redis cache if the entire window falls within the last 7 days
  if (startUnix >= sevenDaysAgoUnix) {
    try {
      const cacheExists = await redis.exists(cacheKey);
      if (cacheExists) {
        let rawEntries;
        if (after != null) {
          // Poll for new messages: ascending from (after to endUnix
          rawEntries = await redis.zrangebyscore(
            cacheKey, `(${after}`, endUnix, "LIMIT", 0, fetch_limit,
          );
        } else {
          // Initial load or "before" cursor: descending newest-first
          const scoreMax = before != null ? `(${before}` : endUnix;
          rawEntries = await redis.zrevrangebyscore(
            cacheKey, scoreMax, startUnix, "LIMIT", 0, fetch_limit,
          );
        }
        if (rawEntries.length > 0) {
          const hasMore = rawEntries.length > limit;
          const lines = rawEntries
            .slice(0, limit)
            .map((raw) => {
              try { return JSON.parse(raw); } catch { return null; }
            })
            .filter(Boolean);
          // after-poll returns ASC; normalize to DESC for consistency
          if (after != null) lines.reverse();
          return json({ lines, hasMore });
        }
      }
    } catch {
      // fall through to Postgres on Redis error
    }
  }

  // PostgreSQL fallback
  const conditions = [
    "server_id = $1",
    "created_at >= $2",
    "created_at <= $3",
  ];
  const params = [serverId, startUnix, endUnix];
  let idx = 4;

  if (before != null) {
    conditions.push(`created_at < $${idx++}`);
    params.push(before);
  }
  if (after != null) {
    conditions.push(`created_at > $${idx++}`);
    params.push(after);
  }

  const order = after != null ? "ASC" : "DESC";
  params.push(fetch_limit);

  const { rows } = await pool.query(
    `SELECT id, message, steam_id, player_name, team_message, created_at AS ts
     FROM text_chat_log
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at ${order}
     LIMIT $${idx}`,
    params,
  );

  const hasMore = rows.length > limit;
  let lines = rows.slice(0, limit).map((row) => ({
    id: String(row.id),
    message: String(row.message),
    steamId: String(row.steam_id),
    playerName: row.player_name == null ? null : String(row.player_name),
    teamMessage: Boolean(row.team_message),
    ts: Number(row.ts),
  }));
  // after-poll returns ASC; normalize to DESC for consistency
  if (after != null) lines.reverse();

  return json({ lines, hasMore });
}

const PVP_INGEST_RATE_LIMIT_PER_MINUTE = 120;

async function handleIngestPvp(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) {
    return json(
      {
        error:
          "Missing API key (x-api-key header or Authorization: Bearer <key>)",
      },
      401,
    );
  }

  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKeyRaw)
    .digest("hex");
  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) return json({ error: "Invalid API key" }, 401);
  const server = serverRes.rows[0];

  const rlKey = `rl:pvp:${server.server_id}`;
  try {
    const attempts = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1, rlKey, '60',
    );
    if (attempts > PVP_INGEST_RATE_LIMIT_PER_MINUTE) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
  } catch {
    // fail-open
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const killerSteamId = String(body?.killer_steam_id ?? "").trim();
  const victimName = String(body?.victim_name ?? "").trim();
  const combatlogCache = body?.combatlog_cache ?? {};

  if (!killerSteamId || !victimName) {
    return json({ error: "killer_steam_id and victim_name are required" }, 400);
  }
  if (killerSteamId.length > 64)
    return json(
      { error: "killer_steam_id must be 64 characters or fewer" },
      400,
    );
  if (victimName.length > 128)
    return json({ error: "victim_name must be 128 characters or fewer" }, 400);
  if (typeof combatlogCache !== "object" || Array.isArray(combatlogCache))
    return json({ error: "combatlog_cache must be a JSON object" }, 400);
  if (JSON.stringify(combatlogCache).length > 65536)
    return json({ error: "combatlog_cache must be 64 KB or less" }, 400);

  const insertRes = await pool.query(
    `INSERT INTO pvp_log (server_id, server_name, killer_steam_id, victim_name, combatlog_cache)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [
      server.server_id,
      server.server_name,
      killerSteamId,
      victimName,
      JSON.stringify(combatlogCache),
    ],
  );
  const row = insertRes.rows[0];
  const createdUnix = Number(row.created_at);

  const cacheKey = `pvp:server:${server.server_id}`;
  const cacheEntry = JSON.stringify({
    id: String(row.id),
    killerSteamId,
    victimName,
    combatlogCache,
    ts: createdUnix,
  });
  const sevenDaysAgo = createdUnix - 7 * 24 * 3600;
  try {
    await redis.zadd(cacheKey, createdUnix, cacheEntry);
    await redis.zremrangebyscore(cacheKey, "-inf", sevenDaysAgo);
    await redis.expire(cacheKey, 7 * 24 * 3600);
  } catch {
    // best-effort cache; message already persisted in Postgres
  }

  return json({ ok: true, id: String(row.id) }, 201);
}

async function handleGetPvpLogs(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const serverId = (url.searchParams.get("serverId") ?? "").trim();
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  const limit = parseLimit(url.searchParams.get("limit"), 200, 500);

  if (!serverId) return json({ error: "serverId is required" }, 400);

  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE server_id = $1 LIMIT 1",
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const server = serverRes.rows[0];

  if (
    !orgHasPermission(session, server.owner_org_id, "players_view") &&
    !isConfiguredSysAdmin(session)
  ) {
    return json({ error: "Forbidden: players_view permission required" }, 403);
  }

  const nowUnixTs = Math.floor(Date.now() / 1000);
  const startUnix = startParam
    ? Math.floor(Number(startParam))
    : nowUnixTs - 6 * 3600;
  const endUnix = endParam ? Math.floor(Number(endParam)) : nowUnixTs;

  if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix)) {
    return json({ error: "Invalid start or end parameter" }, 400);
  }
  if (startUnix > endUnix) {
    return json({ error: "start must not be after end" }, 400);
  }

  const sevenDaysAgoUnix = nowUnixTs - 7 * 24 * 3600;
  const cacheKey = `pvp:server:${serverId}`;

  if (startUnix >= sevenDaysAgoUnix) {
    try {
      const cacheExists = await redis.exists(cacheKey);
      if (cacheExists) {
        const rawEntries = await redis.zrangebyscore(
          cacheKey,
          startUnix,
          endUnix,
          "LIMIT",
          0,
          limit,
        );
        if (rawEntries.length > 0) {
          const lines = rawEntries
            .map((raw) => {
              try {
                return JSON.parse(raw);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          return json({ lines });
        }
      }
    } catch {
      // fall through to Postgres
    }
  }

  const { rows } = await pool.query(
    `SELECT id, killer_steam_id, victim_name, combatlog_cache,
            created_at AS ts
     FROM pvp_log
     WHERE server_id = $1
       AND created_at >= $2
       AND created_at <= $3
     ORDER BY created_at ASC
     LIMIT $4`,
    [serverId, startUnix, endUnix, limit],
  );

  const lines = rows.map((row) => ({
    id: String(row.id),
    killerSteamId: String(row.killer_steam_id),
    victimName: String(row.victim_name),
    combatlogCache: row.combatlog_cache ?? {},
    ts: Number(row.ts),
  }));

  return json({ lines });
}

const REPORTS_INGEST_RATE_LIMIT_PER_MINUTE = 60;

async function handleIngestReport(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) {
    return json(
      {
        error:
          "Missing API key (x-api-key header or Authorization: Bearer <key>)",
      },
      401,
    );
  }

  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKeyRaw)
    .digest("hex");
  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) return json({ error: "Invalid API key" }, 401);
  const server = serverRes.rows[0];

  const rlKey = `rl:reports:${server.server_id}`;
  try {
    const attempts = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1, rlKey, '60',
    );
    if (attempts > REPORTS_INGEST_RATE_LIMIT_PER_MINUTE) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
  } catch {
    // fail-open
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const reportType = String(body?.report_type ?? "").trim();
  const reportReason = String(body?.report_reason ?? "").trim();
  const reportDescription = String(body?.report_description ?? "").trim();
  const reporterName = String(body?.reporter_name ?? "").trim();
  const reporterSteamId = String(body?.reporter_steam_id ?? "").trim();
  const reportedSteamId = String(body?.reported_steam_id ?? "").trim();

  if (
    !reportType ||
    !reportReason ||
    !reporterName ||
    !reporterSteamId ||
    !reportedSteamId
  ) {
    return json(
      {
        error:
          "report_type, report_reason, reporter_name, reporter_steam_id, and reported_steam_id are required",
      },
      400,
    );
  }
  if (reportType.length > 64)
    return json({ error: "report_type must be 64 characters or fewer" }, 400);
  if (reportReason.length > 256)
    return json(
      { error: "report_reason must be 256 characters or fewer" },
      400,
    );
  if (reportDescription.length > 2000)
    return json(
      { error: "report_description must be 2000 characters or fewer" },
      400,
    );
  if (reporterName.length > 128)
    return json(
      { error: "reporter_name must be 128 characters or fewer" },
      400,
    );
  if (reporterSteamId.length > 64)
    return json(
      { error: "reporter_steam_id must be 64 characters or fewer" },
      400,
    );
  if (reportedSteamId.length > 64)
    return json(
      { error: "reported_steam_id must be 64 characters or fewer" },
      400,
    );

  const insertRes = await pool.query(
    `INSERT INTO player_reports
       (server_id, server_name, report_type, report_reason, report_description,
        reporter_name, reporter_steam_id, reported_steam_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      server.server_id,
      server.server_name,
      reportType,
      reportReason,
      reportDescription,
      reporterName,
      reporterSteamId,
      reportedSteamId,
    ],
  );
  const row = insertRes.rows[0];
  const createdUnix = Number(row.created_at);

  const cacheKey = `reports:server:${server.server_id}`;
  const cacheEntry = JSON.stringify({
    id: String(row.id),
    reportType,
    reportReason,
    reportDescription,
    reporterName,
    reporterSteamId,
    reportedSteamId,
    ts: createdUnix,
  });
  const sevenDaysAgo = createdUnix - 7 * 24 * 3600;
  try {
    await redis.zadd(cacheKey, createdUnix, cacheEntry);
    await redis.zremrangebyscore(cacheKey, "-inf", sevenDaysAgo);
    await redis.expire(cacheKey, 7 * 24 * 3600);
  } catch {
    // best-effort cache; report already persisted in Postgres
  }

  return json({ ok: true, id: String(row.id) }, 201);
}

async function handleGetReports(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const serverId = (url.searchParams.get("serverId") ?? "").trim();
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  const limit = parseLimit(url.searchParams.get("limit"), 200, 500);

  if (!serverId) return json({ error: "serverId is required" }, 400);

  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE server_id = $1 LIMIT 1",
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const server = serverRes.rows[0];

  const memberRes = await pool.query(
    "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1",
    [server.owner_org_id, session.userId],
  );
  if (!memberRes.rows[0] && !isConfiguredSysAdmin(session)) {
    return json({ error: "Forbidden" }, 403);
  }

  const nowUnixTs = Math.floor(Date.now() / 1000);
  const startUnix = startParam
    ? Math.floor(Number(startParam))
    : nowUnixTs - 6 * 3600;
  const endUnix = endParam ? Math.floor(Number(endParam)) : nowUnixTs;

  if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix)) {
    return json({ error: "Invalid start or end parameter" }, 400);
  }
  if (startUnix > endUnix) {
    return json({ error: "start must not be after end" }, 400);
  }

  const sevenDaysAgoUnix = nowUnixTs - 7 * 24 * 3600;
  const cacheKey = `reports:server:${serverId}`;

  if (startUnix >= sevenDaysAgoUnix) {
    try {
      const cacheExists = await redis.exists(cacheKey);
      if (cacheExists) {
        const rawEntries = await redis.zrangebyscore(
          cacheKey,
          startUnix,
          endUnix,
          "LIMIT",
          0,
          limit,
        );
        if (rawEntries.length > 0) {
          const lines = rawEntries
            .map((raw) => {
              try {
                return JSON.parse(raw);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          return json({ lines });
        }
      }
    } catch {
      // fall through to Postgres
    }
  }

  const { rows } = await pool.query(
    `SELECT id, report_type, report_reason, report_description,
            reporter_name, reporter_steam_id, reported_steam_id,
            created_at AS ts
     FROM player_reports
     WHERE server_id = $1
       AND created_at >= $2
       AND created_at <= $3
     ORDER BY created_at ASC
     LIMIT $4`,
    [serverId, startUnix, endUnix, limit],
  );

  const lines = rows.map((row) => ({
    id: String(row.id),
    reportType: String(row.report_type),
    reportReason: String(row.report_reason),
    reportDescription: String(row.report_description),
    reporterName: String(row.reporter_name),
    reporterSteamId: String(row.reporter_steam_id),
    reportedSteamId: String(row.reported_steam_id),
    ts: Number(row.ts),
  }));

  return json({ lines });
}

const TEAM_INGEST_RATE_LIMIT_PER_MINUTE = 120;

async function handleIngestTeamEvent(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) {
    return json(
      {
        error:
          "Missing API key (x-api-key header or Authorization: Bearer <key>)",
      },
      401,
    );
  }

  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKeyRaw)
    .digest("hex");
  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) return json({ error: "Invalid API key" }, 401);
  const server = serverRes.rows[0];

  const rlKey = `rl:team:${server.server_id}`;
  try {
    const attempts = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1, rlKey, '60',
    );
    if (attempts > TEAM_INGEST_RATE_LIMIT_PER_MINUTE) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
  } catch {
    // fail-open
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const eventType = String(body?.event_type ?? "").trim();
  const teamLeader = String(body?.team_leader ?? "").trim();
  const teamMembers = body?.team_members;
  const eventTimeRaw = body?.event_time;

  if (!eventType || !teamLeader) {
    return json({ error: "event_type and team_leader are required" }, 400);
  }
  if (!["created", "joined", "left"].includes(eventType)) {
    return json(
      { error: "event_type must be one of: created, joined, left" },
      400,
    );
  }
  if (!Array.isArray(teamMembers)) {
    return json({ error: "team_members must be an array" }, 400);
  }
  if (teamLeader.length > 128)
    return json({ error: "team_leader must be 128 characters or fewer" }, 400);
  if (teamMembers.length > 100)
    return json(
      { error: "team_members must contain 100 entries or fewer" },
      400,
    );

  let eventTime = new Date();
  if (eventTimeRaw != null) {
    const parsed = new Date(eventTimeRaw);
    if (!Number.isFinite(parsed.getTime())) {
      return json(
        { error: "event_time must be a valid ISO timestamp or Unix seconds" },
        400,
      );
    }
    eventTime = parsed;
  }

  const safeMembers = teamMembers.map((m) => String(m).slice(0, 128));

  const insertRes = await pool.query(
    `INSERT INTO team_events (server_id, server_name, event_type, team_members, team_leader, event_time)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [
      server.server_id,
      server.server_name,
      eventType,
      JSON.stringify(safeMembers),
      teamLeader,
      Math.floor(eventTime.getTime() / 1000),
    ],
  );
  const row = insertRes.rows[0];
  const createdUnix = Number(row.created_at);
  const eventTimeUnix = Math.floor(eventTime.getTime() / 1000);

  const cacheKey = `team:server:${server.server_id}`;
  const cacheEntry = JSON.stringify({
    id: String(row.id),
    eventType,
    teamLeader,
    teamMembers: safeMembers,
    eventTimeUnix,
    ts: createdUnix,
  });
  const sevenDaysAgo = createdUnix - 7 * 24 * 3600;
  try {
    await redis.zadd(cacheKey, createdUnix, cacheEntry);
    await redis.zremrangebyscore(cacheKey, "-inf", sevenDaysAgo);
    await redis.expire(cacheKey, 7 * 24 * 3600);
  } catch {
    // best-effort cache; event already persisted in Postgres
  }

  return json({ ok: true, id: String(row.id) }, 201);
}

async function handleGetTeamEvents(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const serverId = (url.searchParams.get("serverId") ?? "").trim();
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  const limit = parseLimit(url.searchParams.get("limit"), 200, 500);

  if (!serverId) return json({ error: "serverId is required" }, 400);

  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE server_id = $1 LIMIT 1",
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const server = serverRes.rows[0];

  const memberRes = await pool.query(
    "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1",
    [server.owner_org_id, session.userId],
  );
  if (!memberRes.rows[0] && !isConfiguredSysAdmin(session)) {
    return json({ error: "Forbidden" }, 403);
  }

  const nowUnixTs = Math.floor(Date.now() / 1000);
  const startUnix = startParam
    ? Math.floor(Number(startParam))
    : nowUnixTs - 6 * 3600;
  const endUnix = endParam ? Math.floor(Number(endParam)) : nowUnixTs;

  if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix)) {
    return json({ error: "Invalid start or end parameter" }, 400);
  }
  if (startUnix > endUnix) {
    return json({ error: "start must not be after end" }, 400);
  }

  const sevenDaysAgoUnix = nowUnixTs - 7 * 24 * 3600;
  const cacheKey = `team:server:${serverId}`;

  if (startUnix >= sevenDaysAgoUnix) {
    try {
      const cacheExists = await redis.exists(cacheKey);
      if (cacheExists) {
        const rawEntries = await redis.zrangebyscore(
          cacheKey,
          startUnix,
          endUnix,
          "LIMIT",
          0,
          limit,
        );
        if (rawEntries.length > 0) {
          const lines = rawEntries
            .map((raw) => {
              try {
                return JSON.parse(raw);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          return json({ lines });
        }
      }
    } catch {
      // fall through to Postgres
    }
  }

  const { rows } = await pool.query(
    `SELECT id, event_type, team_members, team_leader,
            event_time AS event_time_unix,
            created_at AS ts
     FROM team_events
     WHERE server_id = $1
       AND created_at >= $2
       AND created_at <= $3
     ORDER BY created_at ASC
     LIMIT $4`,
    [serverId, startUnix, endUnix, limit],
  );

  const lines = rows.map((row) => ({
    id: String(row.id),
    eventType: String(row.event_type),
    teamLeader: String(row.team_leader),
    teamMembers: Array.isArray(row.team_members) ? row.team_members : [],
    eventTimeUnix: Number(row.event_time_unix),
    ts: Number(row.ts),
  }));

  return json({ lines });
}

// ── Ban / Mute handlers ──────────────────────────────────────────────────────

async function handleListOrgBans(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "bans_manage"))
    return json({ error: "Forbidden: bans_manage permission required" }, 403);

  const url = new URL(request.url);
  const actionType = url.searchParams.get("type") ?? "ban";
  const identifier = url.searchParams.get("identifier") ?? null;

  const { rows } = await pool.query(
    `SELECT b.ban_id, b.org_id, b.action_type, b.identifier, b.identifier_type,
            b.category, b.reason, b.note, b.expires_at, b.issued_at,
            b.issued_by, b.revoked, b.revoked_at, b.revoked_by,
            u.username AS issued_by_name,
            COALESCE(
              json_agg(bst.server_id::text) FILTER (WHERE bst.server_id IS NOT NULL),
              '[]'::json
            ) AS server_ids
     FROM player_bans b
     LEFT JOIN users u ON u.user_id = b.issued_by
     LEFT JOIN ban_server_targets bst ON bst.ban_id = b.ban_id
     WHERE b.org_id = $1 AND b.action_type = $2
       AND ($3::text IS NULL OR b.identifier = $3)
     GROUP BY b.ban_id, u.username
     ORDER BY b.issued_at DESC
     LIMIT 500`,
    [orgId, actionType, identifier],
  );

  return json({
    bans: rows.map((r) => ({
      banId: String(r.ban_id),
      orgId: String(r.org_id),
      actionType: String(r.action_type),
      identifier: String(r.identifier),
      identifierType: String(r.identifier_type),
      category: r.category ?? null,
      reason: String(r.reason),
      note: String(r.note),
      expiresAt: r.expires_at ? Number(r.expires_at) : null,
      issuedAt: Number(r.issued_at),
      issuedBy: r.issued_by ? String(r.issued_by) : null,
      issuedByName: r.issued_by_name ?? null,
      revoked: Boolean(r.revoked),
      revokedAt: r.revoked_at ? Number(r.revoked_at) : null,
      serverIds: Array.isArray(r.server_ids) ? r.server_ids : [],
    })),
  });
}

async function handleCreateBan(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "bans_manage"))
    return json({ error: "Forbidden: bans_manage permission required" }, 403);

  const rl = await checkRateLimit(`rl:ban:${session.userId}`, 30, 60);
  if (rl) return rl;

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const {
    actionType = "ban",
    identifier,
    identifierType,
    reason: rawReason = "",
    note: rawNote = "",
    expiresAt,
    serverIds = [],
    category,
  } = body;

  // Cap free-text fields to bound DB writes and RCON command size.
  const reason = String(rawReason).slice(0, 500);
  const note = String(rawNote).slice(0, 1000);

  if (!identifier?.trim())
    return json({ error: "identifier is required" }, 400);
  if (!["steam_id", "ip"].includes(identifierType)) {
    return json({ error: "identifierType must be 'steam_id' or 'ip'" }, 400);
  }

  if (identifierType === "steam_id" && !/^\d{17}$/.test(identifier.trim())) {
    return json({ error: "identifier must be a 17-digit Steam64 ID" }, 400);
  }
  if (
    identifierType === "ip" &&
    !/^(\d{1,3}\.){3}\d{1,3}$|^[\da-fA-F:]+$/.test(identifier.trim())
  ) {
    return json(
      { error: "identifier must be a valid IPv4 or IPv6 address" },
      400,
    );
  }
  if (!["ban", "mute"].includes(actionType)) {
    return json({ error: "actionType must be 'ban' or 'mute'" }, 400);
  }
  if (identifierType === "ip" && actionType === "mute") {
    return json({ error: "Cannot mute by IP address" }, 400);
  }

  const banId = crypto.randomUUID();
  let expiresAtUnix = null;
  if (expiresAt != null && expiresAt !== "") {
    const n = Number(expiresAt);
    if (!Number.isFinite(n) || n < 0)
      return json({ error: "expiresAt must be a valid Unix timestamp" }, 400);
    expiresAtUnix = Math.trunc(n);
  }

  await pool.query(
    `INSERT INTO player_bans (ban_id, org_id, action_type, identifier, identifier_type, category, reason, note, expires_at, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      banId,
      orgId,
      actionType,
      identifier.trim(),
      identifierType,
      category ?? null,
      reason,
      note,
      expiresAtUnix,
      session.userId,
    ],
  );

  const validServerIds = [];
  if (serverIds.length > 0) {
    const serverCheck = await pool.query(
      `SELECT server_id FROM servers WHERE server_id = ANY($1::uuid[]) AND owner_org_id = $2`,
      [serverIds, orgId],
    );
    for (const row of serverCheck.rows) {
      const sid = String(row.server_id);
      await pool.query(
        `INSERT INTO ban_server_targets (ban_id, server_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [banId, sid],
      );
      validServerIds.push(sid);
    }
  }

  const rconResults = [];
  if (validServerIds.length > 0 && actionType !== "mute") {
    const serversWithRcon = await pool.query(
      `SELECT server_id, server_name, rcon_host, rcon_port, rcon_password_enc
       FROM servers
       WHERE server_id = ANY($1::uuid[])
         AND rcon_host IS NOT NULL
         AND rcon_port IS NOT NULL
         AND rcon_password_enc IS NOT NULL`,
      [validServerIds],
    );

    for (const srv of serversWithRcon.rows) {
      try {
        const password = decryptPterodactylApiKey(
          String(srv.rcon_password_enc),
        );
        const rconUrl = `ws://${srv.rcon_host}:${srv.rcon_port}/${encodeURIComponent(password)}`;
        const safeId = identifier.trim();
        let command;
        if (actionType === "mute") {
          command = `mute ${safeId}`;
        } else if (identifierType === "ip") {
          command = `banip ${safeId}`;
        } else {
          const safeReason = reason
            .replace(/[\r\n\x00-\x1f]/g, " ")
            .replace(/"/g, "'");
          command = `ban ${safeId} "${safeReason}"`;
        }
        const result = await executeRconCommand(rconUrl, command);
        rconResults.push({
          serverId: String(srv.server_id),
          serverName: String(srv.server_name),
          ok: true,
          response: result.response,
        });
      } catch (err) {
        rconResults.push({
          serverId: String(srv.server_id),
          serverName: String(srv.server_name),
          ok: false,
          error: String(err.message),
        });
      }
    }
  }

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: actionType === "mute" ? "mute" : "ban",
    resourceId: banId,
    actionType: actionType === "mute" ? "MUTE_CREATED" : "BAN_CREATED",
    actionCategory: "moderation",
    severity: 3,
    metadata: {
      identifier: identifier.trim(),
      identifierType,
      reason,
      category: category ?? null,
      expiresAt: expiresAtUnix,
      serverIds: validServerIds,
    },
    ipAddress: getClientIp(request),
  });

  return json({ ok: true, banId, rconResults }, 201);
}

async function handleUpdateBan(request, orgId, banId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "bans_manage"))
    return json({ error: "Forbidden: bans_manage permission required" }, 403);

  const banCheck = await pool.query(
    `SELECT ban_id, action_type FROM player_bans WHERE ban_id = $1 AND org_id = $2`,
    [banId, orgId],
  );
  if (!banCheck.rows[0]) return json({ error: "Ban not found" }, 404);
  const existingActionType = String(banCheck.rows[0].action_type);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const sets = [];
  const params = [banId, orgId];
  let idx = 3;

  if (body.reason !== undefined) {
    sets.push(`reason = $${idx}`);
    params.push(String(body.reason).slice(0, 500));
    idx++;
  }
  if (body.note !== undefined) {
    sets.push(`note = $${idx}`);
    params.push(String(body.note).slice(0, 1000));
    idx++;
  }
  if ("expiresAt" in body) {
    let expiresAtUnix = null;
    if (body.expiresAt != null && body.expiresAt !== "") {
      const n = Number(body.expiresAt);
      if (!Number.isFinite(n) || n < 0)
        return json({ error: "expiresAt must be a valid Unix timestamp" }, 400);
      expiresAtUnix = Math.trunc(n);
    }
    sets.push(`expires_at = $${idx}`);
    params.push(expiresAtUnix);
    idx++;
  }

  if (sets.length > 0) {
    await pool.query(
      `UPDATE player_bans SET ${sets.join(", ")} WHERE ban_id = $1 AND org_id = $2`,
      params,
    );
  }

  const changes = {};
  if (body.reason !== undefined) changes.reason = body.reason;
  if (body.note !== undefined) changes.note = body.note;
  if ("expiresAt" in body) changes.expiresAt = body.expiresAt;

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: existingActionType === "mute" ? "mute" : "ban",
    resourceId: banId,
    actionType: existingActionType === "mute" ? "MUTE_UPDATED" : "BAN_UPDATED",
    actionCategory: "moderation",
    severity: 2,
    metadata: { changes },
    ipAddress: getClientIp(request),
  });

  return json({ ok: true });
}

async function handleRevokeBan(request, orgId, banId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "bans_delete"))
    return json({ error: "Forbidden" }, 403);

  const banCheck = await pool.query(
    `SELECT ban_id, identifier, identifier_type, action_type
     FROM player_bans WHERE ban_id = $1 AND org_id = $2 AND revoked = FALSE`,
    [banId, orgId],
  );
  if (!banCheck.rows[0])
    return json({ error: "Ban not found or already revoked" }, 404);

  const { identifier, identifier_type, action_type } = banCheck.rows[0];

  await pool.query(
    `UPDATE player_bans SET revoked = TRUE, revoked_at = unix_now(), revoked_by = $3
     WHERE ban_id = $1 AND org_id = $2`,
    [banId, orgId, session.userId],
  );

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: action_type === "mute" ? "mute" : "ban",
    resourceId: banId,
    actionType: action_type === "mute" ? "MUTE_REVOKED" : "BAN_REVOKED",
    actionCategory: "moderation",
    severity: 3,
    metadata: { identifier: String(identifier), identifierType: String(identifier_type) },
    ipAddress: getClientIp(request),
  });

  const rconResults = [];
  if (action_type !== "mute") {
    const targetServers = await pool.query(
      `SELECT s.server_id, s.server_name, s.rcon_host, s.rcon_port, s.rcon_password_enc
       FROM ban_server_targets bst
       JOIN servers s ON s.server_id = bst.server_id
       WHERE bst.ban_id = $1
         AND s.rcon_host IS NOT NULL
         AND s.rcon_port IS NOT NULL
         AND s.rcon_password_enc IS NOT NULL`,
      [banId],
    );

    for (const srv of targetServers.rows) {
      try {
        const password = decryptPterodactylApiKey(String(srv.rcon_password_enc));
        const rconUrl = `ws://${srv.rcon_host}:${srv.rcon_port}/${encodeURIComponent(password)}`;
        let command;
        if (identifier_type === "ip") {
          command = `unbanip ${String(identifier)}`;
        } else {
          command = `unban ${String(identifier)}`;
        }
        const result = await executeRconCommand(rconUrl, command);
        rconResults.push({
          serverId: String(srv.server_id),
          serverName: String(srv.server_name),
          ok: true,
          response: result.response,
        });
      } catch (err) {
        rconResults.push({
          serverId: String(srv.server_id),
          serverName: String(srv.server_name),
          ok: false,
          error: String(err.message),
        });
      }
    }
  }

  return json({ ok: true, rconResults });
}

const MUTE_CHECK_RATE_LIMIT_PER_MINUTE = 60;

async function handleMuteCheck(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) {
    return json(
      {
        error:
          "Missing API key (x-api-key header or Authorization: Bearer <key>)",
      },
      401,
    );
  }

  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKeyRaw)
    .digest("hex");

  const serverRes = await pool.query(
    "SELECT server_id, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) {
    return json({ error: "Invalid API key" }, 401);
  }
  const server = serverRes.rows[0];

  const rlKey = `rl:mute-check:${server.server_id}`;
  try {
    const attempts = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1, rlKey, '60',
    );
    if (attempts > MUTE_CHECK_RATE_LIMIT_PER_MINUTE) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
  } catch {
    // fail-open on Redis errors
  }

  const url = new URL(request.url);
  const steamId = (url.searchParams.get("steam_id") ?? "").trim();
  if (!steamId) {
    return json({ error: "steam_id query parameter is required" }, 400);
  }
  if (!/^\d{1,20}$/.test(steamId)) {
    return json({ error: "Invalid steam_id" }, 400);
  }

  const { rows } = await pool.query(
    `SELECT reason, expires_at
     FROM player_bans
     WHERE org_id = $1
       AND identifier = $2
       AND identifier_type = 'steam_id'
       AND action_type = 'mute'
       AND revoked = FALSE
       AND (expires_at IS NULL OR expires_at > unix_now())
     ORDER BY issued_at DESC
     LIMIT 1`,
    [server.owner_org_id, steamId],
  );

  if (!rows[0]) {
    return json({ muted: false });
  }

  const row = rows[0];
  const expiresUnix = row.expires_at ? Number(row.expires_at) : null;

  return json({
    muted: true,
    permanent: expiresUnix === null,
    reason: String(row.reason),
    expiresAt: expiresUnix,
    expiresUnix,
  });
}

const MUTE_SYNC_RATE_LIMIT_PER_MINUTE = 120;

async function handleIngestMuteSync(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw)
    return json({ error: "Missing API key (x-api-key header or Authorization: Bearer <key>)" }, 401);

  const apiKeyHash = crypto.createHash("sha256").update(apiKeyRaw).digest("hex");
  const serverRes = await pool.query(
    "SELECT server_id, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) return json({ error: "Invalid API key" }, 401);
  const server = serverRes.rows[0];

  const rlKey = `rl:mute-sync:${server.server_id}`;
  try {
    const attempts = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1,
      rlKey,
      "60",
    );
    if (attempts > MUTE_SYNC_RATE_LIMIT_PER_MINUTE)
      return json({ error: "Rate limit exceeded" }, 429);
  } catch {
    // fail-open
  }

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.steam_ids))
    return json({ error: "steam_ids array is required" }, 400);

  const steamIds = body.steam_ids
    .filter((id) => typeof id === "string" && /^765611\d{11}$/.test(id.trim()))
    .map((id) => id.trim())
    .slice(0, 350);

  if (steamIds.length === 0) return json({ active_mutes: {} });

  const { rows } = await pool.query(
    `SELECT pb.identifier, pb.expires_at
     FROM player_bans pb
     WHERE pb.action_type = 'mute'
       AND pb.revoked = FALSE
       AND (pb.expires_at IS NULL OR pb.expires_at > unix_now())
       AND pb.identifier = ANY($1)
       AND pb.identifier_type = 'steam_id'
       AND pb.org_id = $2
       AND (
         NOT EXISTS (SELECT 1 FROM ban_server_targets bst WHERE bst.ban_id = pb.ban_id)
         OR EXISTS (SELECT 1 FROM ban_server_targets bst WHERE bst.ban_id = pb.ban_id AND bst.server_id = $3)
       )`,
    [steamIds, server.owner_org_id, server.server_id],
  );

  const active_mutes = {};
  for (const row of rows) {
    active_mutes[row.identifier] = row.expires_at ? Number(row.expires_at) : null;
  }

  return json({ active_mutes });
}

async function handleGetBlacklistedWords(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "triggers_manage"))
    return json({ error: "Forbidden" }, 403);

  const { rows } = await pool.query(
    `SELECT word_id, word, created_at FROM org_blacklisted_words WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  return json({
    words: rows.map((r) => ({
      word_id: r.word_id,
      word: r.word,
      created_at: Number(r.created_at),
    })),
  });
}

async function handleAddBlacklistedWord(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "triggers_manage"))
    return json({ error: "Forbidden" }, 403);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const word = (body.word ?? "").trim().toLowerCase();
  if (!word) return json({ error: "word is required" }, 400);
  if (word.length > 100) return json({ error: "word must be 100 characters or fewer" }, 400);

  const { rows } = await pool.query(
    `INSERT INTO org_blacklisted_words (org_id, word)
     VALUES ($1, $2)
     ON CONFLICT (org_id, word) DO NOTHING
     RETURNING word_id, word, created_at`,
    [orgId, word],
  );

  if (!rows[0]) {
    const existing = await pool.query(
      `SELECT word_id, word, created_at FROM org_blacklisted_words WHERE org_id = $1 AND word = $2`,
      [orgId, word],
    );
    const r = existing.rows[0];
    return json({ word_id: r.word_id, word: r.word, created_at: Number(r.created_at) }, 200);
  }

  const r = rows[0];
  return json({ word_id: r.word_id, word: r.word, created_at: Number(r.created_at) }, 201);
}

async function handleDeleteBlacklistedWord(request, orgId, wordId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "triggers_manage"))
    return json({ error: "Forbidden" }, 403);

  const result = await pool.query(
    `DELETE FROM org_blacklisted_words WHERE word_id = $1 AND org_id = $2`,
    [wordId, orgId],
  );

  if (result.rowCount === 0) return json({ error: "Word not found" }, 404);
  return json({ ok: true });
}

async function handleGetBlacklistedWordsForServer(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) return json({ error: "Missing API key" }, 401);

  const apiKeyHash = crypto.createHash("sha256").update(apiKeyRaw).digest("hex");
  const serverRes = await pool.query(
    "SELECT server_id, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) return json({ error: "Invalid API key" }, 401);
  const server = serverRes.rows[0];

  const { rows } = await pool.query(
    `SELECT word FROM org_blacklisted_words WHERE org_id = $1 ORDER BY created_at ASC`,
    [server.owner_org_id],
  );

  return new Response(rows.map((r) => r.word).join(";"), {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function initializeInfra() {
  try {
    await init();
  } catch {
    // startup failures are exposed via API startup guard responses
  }
}

// ── RIPE Atlas helpers and background jobs ────────────────────────────────────

const RIPE_ATLAS_BASE = "https://atlas.ripe.net/api/v2";

async function ripeAtlasFetch(apiKey, path, opts = {}) {
  return fetch(`${RIPE_ATLAS_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
    signal: opts.signal ?? AbortSignal.timeout(20000),
  });
}

async function ripeAtlasGetCredits(apiKey) {
  const res = await ripeAtlasFetch(apiKey, "/credits/");
  if (!res.ok) throw new Error(`Credits API HTTP ${res.status}`);
  const data = await res.json();
  return {
    currentBalance: data.current_balance ?? null,
    estimatedDailyIncome: data.estimated_daily_income ?? null,
    maxDailyIncome: data.max_daily_income ?? null,
  };
}

async function ripeAtlasCreateMeasurement(apiKey, targetIp, country, probesPerCountry) {
  const body = {
    definitions: [
      {
        target: targetIp,
        af: 4,
        type: "ping",
        description: `IronSight ping ${targetIp}`,
        packets: 3,
        packet_interval: 1000,
      },
    ],
    probes: [{ type: "country", value: country, requested: probesPerCountry }],
    is_oneoff: true,
  };
  console.log("[ripe-atlas] creating measurement:", JSON.stringify(body));
  const res = await ripeAtlasFetch(apiKey, "/measurements/", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("[ripe-atlas] create measurement error body:", JSON.stringify(err));
    const detail = err?.error?.detail ?? err?.detail ?? `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const data = await res.json();
  const msmId = data.measurements?.[0];
  if (!msmId) throw new Error("No measurement ID returned by RIPE Atlas");
  return msmId;
}

async function triggerRipeAtlasMeasurements() {
  const { rows: configs } = await pool.query(
    `SELECT org_id, api_key_enc, countries, probes_per_country FROM org_ripe_atlas_config`,
  );
  if (!configs.length) return;

  for (const cfg of configs) {
    let apiKey;
    try {
      apiKey = decryptExternalApiKey(String(cfg.api_key_enc));
    } catch {
      continue;
    }

    const { rows: servers } = await pool.query(
      `SELECT server_id, server_name, rcon_host FROM servers WHERE owner_org_id = $1 AND rcon_host IS NOT NULL`,
      [cfg.org_id],
    );
    if (!servers.length) continue;

    const countries = Array.isArray(cfg.countries) ? cfg.countries : [];
    const probesPerCountry = Number(cfg.probes_per_country) || 3;

    for (const server of servers) {
      for (const country of countries) {
        try {
          const msmId = await ripeAtlasCreateMeasurement(
            apiKey,
            server.rcon_host,
            country,
            probesPerCountry,
          );
          await pool.query(
            `INSERT INTO org_ripe_atlas_measurements
             (org_id, server_id, atlas_msm_id, target_ip, country)
             VALUES ($1, $2, $3, $4, $5)`,
            [cfg.org_id, server.server_id, msmId, server.rcon_host, country],
          );
        } catch (err) {
          console.warn(
            `[ripe-atlas] measurement failed org=${cfg.org_id} server=${server.server_name} country=${country}: ${err.message}`,
          );
        }
      }
    }
  }
}

async function fetchPendingRipeAtlasResults() {
  const { rows: pending } = await pool.query(
    `SELECT id, org_id, server_id, atlas_msm_id, country, created_at
     FROM org_ripe_atlas_measurements
     WHERE status = 'pending'
       AND created_at < unix_now() - 120
       AND results_fetched_at IS NULL
     ORDER BY created_at ASC
     LIMIT 50`,
  );
  if (!pending.length) return;

  const orgIds = [...new Set(pending.map((m) => m.org_id))];
  const { rows: cfgRows } = await pool.query(
    `SELECT org_id, api_key_enc FROM org_ripe_atlas_config WHERE org_id = ANY($1::text[])`,
    [orgIds],
  );
  const keysByOrg = new Map();
  for (const cfg of cfgRows) {
    try {
      keysByOrg.set(cfg.org_id, decryptExternalApiKey(String(cfg.api_key_enc)));
    } catch {
      continue;
    }
  }

  for (const msm of pending) {
    const apiKey = keysByOrg.get(msm.org_id);
    if (!apiKey) continue;

    try {
      const res = await ripeAtlasFetch(
        apiKey,
        `/measurements/${msm.atlas_msm_id}/results/?format=json`,
      );
      const results = res.ok ? await res.json().catch(() => []) : [];

      await pool.query(
        `UPDATE org_ripe_atlas_measurements
         SET status = 'completed', results_fetched_at = unix_now()
         WHERE id = $1`,
        [msm.id],
      );

      if (!Array.isArray(results) || !results.length) continue;

      let totalRtt = 0;
      let minRtt = Infinity;
      let maxRtt = -Infinity;
      let reachableCount = 0;

      for (const r of results) {
        const avg = r.avg;
        if (avg != null && Number(avg) > 0) {
          reachableCount++;
          totalRtt += Number(avg);
          if (r.min != null && Number(r.min) < minRtt) minRtt = Number(r.min);
          if (r.max != null && Number(r.max) > maxRtt) maxRtt = Number(r.max);
        }
      }

      const reachable = reachableCount > 0;
      const avgRtt = reachable ? totalRtt / reachableCount : null;

      await pool.query(
        `INSERT INTO org_ripe_atlas_results
         (org_id, server_id, country, reachable, avg_rtt, min_rtt, max_rtt, probe_count, reachable_count, measured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          msm.org_id,
          msm.server_id,
          msm.country,
          reachable,
          avgRtt != null ? avgRtt.toFixed(2) : null,
          minRtt !== Infinity ? minRtt : null,
          maxRtt !== -Infinity ? maxRtt : null,
          results.length,
          reachableCount,
          Number(msm.created_at),
        ],
      );
    } catch (err) {
      console.warn(
        `[ripe-atlas] results fetch failed msm=${msm.atlas_msm_id}: ${err.message}`,
      );
    }
  }

  await pool.query(
    `DELETE FROM org_ripe_atlas_measurements WHERE created_at < unix_now() - 7200`,
  );
  await pool.query(
    `DELETE FROM org_ripe_atlas_results WHERE measured_at < unix_now() - 86400`,
  );
}

// ── External API key helpers (BM / Steam / Proxycheck) ───────────────────────

function encryptExternalApiKey(apiKey) {
  return encryptPterodactylApiKey(apiKey);
}

function decryptExternalApiKey(payload) {
  return decryptPterodactylApiKey(payload);
}

async function getAvailableExternalKeys(orgId, service) {
  const { rows } = await pool.query(
    `SELECT key_id, key_encrypted
     FROM org_external_api_keys
     WHERE org_id = $1
       AND service = $2
       AND enabled = TRUE
       AND (rate_limited_until IS NULL OR rate_limited_until < unix_now())
     ORDER BY priority DESC, last_used_at ASC NULLS FIRST`,
    [orgId, service],
  );
  const keys = [];
  for (const r of rows) {
    try {
      keys.push({ keyId: String(r.key_id), key: decryptExternalApiKey(String(r.key_encrypted)) });
    } catch {
      console.warn(`[ext-api] key ${r.key_id} for org ${orgId}/${service} failed to decrypt, skipping`);
    }
  }
  return keys;
}

async function markExternalKeyRateLimited(keyId, retryAfterSeconds) {
  const secs = Math.min(Math.max(Number(retryAfterSeconds) || 60, 1), 7200);
  await pool.query(
    `UPDATE org_external_api_keys
     SET rate_limited_until = unix_now() + $1
     WHERE key_id = $2`,
    [secs, keyId],
  );
}

async function markExternalKeyUsed(keyId) {
  await pool.query(
    `UPDATE org_external_api_keys SET last_used_at = unix_now() WHERE key_id = $1`,
    [keyId],
  );
}

async function recordRateLimitStats(keyId, orgId, service, resp) {
  const limitHdr = resp.headers.get("X-Rate-Limit-Limit");
  const remainingHdr = resp.headers.get("X-Rate-Limit-Remaining");
  const bucketHour = Math.floor(Date.now() / 1000 / 3600) * 3600;

  if (!limitHdr || !remainingHdr) {
    // Steam doesn't return rate-limit headers; track call count only so the
    // frontend can display "X / 100,000 calls today".
    if (service !== "steam") return;
    await pool.query(
      `INSERT INTO org_external_api_key_stats
         (key_id, bucket_hour, org_id, service, rate_limit_max, rate_limit_min_remaining)
       VALUES ($1, $2, $3, $4, NULL, NULL)
       ON CONFLICT (key_id, bucket_hour) DO UPDATE SET
         sample_count = org_external_api_key_stats.sample_count + 1`,
      [keyId, bucketHour, orgId, service],
    );
    return;
  }

  const rateMax = parseInt(limitHdr, 10);
  const remaining = parseInt(remainingHdr, 10);
  if (isNaN(rateMax) || isNaN(remaining) || rateMax <= 0) return;
  await pool.query(
    `INSERT INTO org_external_api_key_stats
       (key_id, bucket_hour, org_id, service, rate_limit_max, rate_limit_min_remaining)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (key_id, bucket_hour) DO UPDATE SET
       rate_limit_max = EXCLUDED.rate_limit_max,
       rate_limit_min_remaining = LEAST(
         org_external_api_key_stats.rate_limit_min_remaining,
         EXCLUDED.rate_limit_min_remaining
       ),
       sample_count = org_external_api_key_stats.sample_count + 1`,
    [keyId, bucketHour, orgId, service, rateMax, remaining],
  );
}

// Tries each available key in priority order; returns Response or null if all fail
async function externalFetchWithRotation(orgId, service, buildRequest) {
  const keys = await getAvailableExternalKeys(orgId, service);
  if (!keys.length) return null;

  for (const { keyId, key } of keys) {
    const { url, options } = buildRequest(key);
    let resp;
    try {
      resp = await fetch(url, options ?? {});
    } catch (err) {
      console.warn(
        `[ext-api:${service}] key=${keyId} network error: ${err.message}`,
      );
      continue;
    }

    if (resp.status === 429) {
      const retryAfter = parseFloat(resp.headers.get("Retry-After") ?? "60");
      await markExternalKeyRateLimited(keyId, retryAfter);
      console.warn(
        `[ext-api:${service}] key=${keyId} rate-limited (${retryAfter}s), trying next`,
      );
      continue;
    }

    await markExternalKeyUsed(keyId);
    recordRateLimitStats(keyId, orgId, service, resp).catch((e) =>
      console.warn(`[ext-api:${service}] stats write failed: ${e.message}`),
    );
    return resp;
  }

  return null;
}

async function bmFetch(orgId, url, opts = {}) {
  return externalFetchWithRotation(orgId, "battlemetrics", (key) => ({
    url,
    options: {
      ...opts,
      headers: { Authorization: `Bearer ${key}`, ...(opts.headers ?? {}) },
    },
  }));
}

async function steamApiFetch(orgId, path, params = {}) {
  return externalFetchWithRotation(orgId, "steam", (key) => {
    const u = new URL(`https://api.steampowered.com${path}`);
    u.searchParams.set("key", key);
    for (const [k, v] of Object.entries(params))
      u.searchParams.set(k, String(v));
    return { url: u.toString(), options: {} };
  });
}

const VALID_IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[\da-fA-F:]+$/;

async function proxycheckApiFetch(orgId, ipList) {
  const list = Array.isArray(ipList) ? ipList : [String(ipList)];
  const validIps = list.filter((ip) => VALID_IP_RE.test(String(ip).trim()));
  if (!validIps.length) return null;
  const ips = validIps.join(",");
  return externalFetchWithRotation(orgId, "proxycheck", (key) => ({
    url: `https://proxycheck.io/v2/${ips}?key=${encodeURIComponent(key)}&vpn=1&asn=1`,
    options: {},
  }));
}

// ── Player data fetchers ──────────────────────────────────────────────────────

const RUST_APP_ID = 252490;
const AIM_SERVER_KEYWORDS = ["ukn", "aim"];

async function findBMIdBySteamId(steamId, orgId) {
  const keys = await getAvailableExternalKeys(orgId, "battlemetrics");
  if (!keys.length) {
    console.warn(
      `[player:bm] org=${orgId} has no BattleMetrics API keys — go to Manage Org → API Keys to add one`,
    );
    return null;
  }

  const payload = JSON.stringify({
    data: [
      {
        type: "identifier",
        attributes: { type: "steamID", identifier: String(steamId) },
      },
    ],
  });

  const resp = await bmFetch(
    orgId,
    "https://api.battlemetrics.com/players/match",
    {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
    },
  );

  if (!resp) {
    console.warn(
      `[player:bm] all BM keys for org=${orgId} are rate-limited or failed`,
    );
    return null;
  }
  if (!resp.ok) {
    let body = "";
    try {
      body = await resp.text();
    } catch {}
    console.warn(
      `[player:bm] BM API returned ${resp.status} for steamId=${steamId}: ${body.slice(0, 200)}`,
    );
    return null;
  }

  const json = await resp.json();
  for (const entry of json.data ?? []) {
    if (entry.attributes?.type === "steamID") {
      const bmId = entry.relationships?.player?.data?.id;
      if (bmId) {
        console.log(`[player:bm] resolved steamId=${steamId} → bmId=${bmId}`);
        return String(bmId);
      }
    }
  }

  console.log(
    `[player:bm] steamId=${steamId} not found in BattleMetrics (player may not have played on any tracked server)`,
  );
  return null;
}

async function fetchSteamPlayerData(steamId, orgId) {
  const [summaryResp, playtimeResp] = await Promise.all([
    steamApiFetch(orgId, "/ISteamUser/GetPlayerSummaries/v0002/", {
      steamids: steamId,
    }),
    steamApiFetch(orgId, "/IPlayerService/GetOwnedGames/v0001/", {
      steamid: steamId,
      include_appinfo: "0",
      include_played_free_games: "0",
    }),
  ]);

  let displayName = null,
    avatarUrl = null,
    profileVisibility = null,
    profileCreatedAt = null,
    summaryOk = false;

  if (summaryResp?.ok) {
    const json = await summaryResp.json();
    const p = json.response?.players?.[0];
    if (p) {
      summaryOk = true;
      displayName = p.personaname ?? null;
      avatarUrl = p.avatarmedium ?? null;
      const visState =
        p.profilestate === 0 ? 0 : (p.communityvisibilitystate ?? 1);
      profileVisibility =
        { 0: "Not Configured", 1: "Private", 2: "Private", 3: "Public" }[
          visState
        ] ?? "Private";
      profileCreatedAt = p.timecreated ?? null;
    }
  }

  let rustHours = null,
    hoursPublic = false;
  if (playtimeResp?.ok) {
    const json = await playtimeResp.json();
    const games = json.response?.games;
    if (games?.length) {
      hoursPublic = true;
      const rust = games.find((g) => g.appid === RUST_APP_ID);
      if (rust) rustHours = Math.round((rust.playtime_forever / 60) * 10) / 10;
    }
  }

  return {
    success: summaryOk,
    displayName,
    avatarUrl,
    profileVisibility,
    profileCreatedAt,
    rustHours,
    hoursPublic,
  };
}

async function fetchBMPlayerData(bmId, orgId) {
  const url =
    `https://api.battlemetrics.com/players/${encodeURIComponent(bmId)}` +
    `?include=server,identifier&fields[server]=name,ip,port`;
  const resp = await bmFetch(orgId, url);
  if (!resp?.ok) return null;

  const json = await resp.json();
  const steamIdentifier = (json.included ?? []).find(
    (inc) => inc.type === "identifier" && inc.attributes?.type === "steamID",
  );

  let bmRustHours = 0,
    bmAimtrainHours = 0,
    serverCount = 0,
    totalIncluded = 0;
  const sessions = [];

  for (const entry of json.included ?? []) {
    if (entry.type !== "server") continue;
    totalIncluded++;
    if (entry.relationships?.game?.data?.id !== "rust") continue;

    const hours = (entry.meta?.timePlayed ?? 0) / 3600;
    serverCount++;
    bmRustHours += hours;
    if (
      AIM_SERVER_KEYWORDS.some((kw) =>
        entry.attributes?.name?.toLowerCase().includes(kw),
      )
    )
      bmAimtrainHours += hours;

    sessions.push({
      bmServerId: String(entry.id),
      serverName: entry.attributes?.name ?? null,
      hoursPlayed: Math.round(hours * 10) / 10,
      lastSeen: entry.meta?.lastSeen ? Math.floor(new Date(entry.meta.lastSeen).getTime() / 1000) : null,
    });
  }

  const rustBans = steamIdentifier?.attributes?.metadata?.rustBans ?? null;

  // BM tracks every name a player has used as a "name" identifier — this is our
  // alias history for name-similarity matching (Steam exposes none via API).
  const nameAliases = (json.included ?? [])
    .filter(
      (inc) => inc.type === "identifier" && inc.attributes?.type === "name",
    )
    .map((inc) => inc.attributes?.identifier)
    .filter(Boolean);

  return {
    bmProfileCreatedAt: json.data?.attributes?.createdAt
      ? Math.floor(new Date(json.data.attributes.createdAt).getTime() / 1000)
      : null,
    bmPrivate: json.data?.attributes?.private ?? false,
    bmRustHours: Math.round(bmRustHours * 10) / 10,
    bmAimtrainHours: Math.round(bmAimtrainHours * 10) / 10,
    bmServerCount: serverCount,
    bmRustBansCount: rustBans?.count ?? 0,
    bmRustBansLastBan: rustBans?.lastBan ? Math.floor(new Date(rustBans.lastBan).getTime() / 1000) : null,
    bmRustBansBanned: rustBans?.banned ?? false,
    nameAliases,
    sessions,
    hoursInaccurate: totalIncluded >= 250,
  };
}

async function fetchBMRelatedIdentifiers(bmId, orgId) {
  const url =
    `https://api.battlemetrics.com/players/${encodeURIComponent(bmId)}` +
    `/relationships/related-identifiers?version=%5E0.1.0`;
  const resp = await bmFetch(orgId, url);
  if (!resp?.ok) return { ips: [], relatedPlayers: [] };

  const data = await resp.json();
  const ips = [];
  // bmId -> { matchCount, sharedIps:Set<ip>, sharedTypes:{identifierType:count} }
  const related = {};

  for (const identifier of data.data ?? []) {
    const idType = identifier.attributes?.type ?? null;
    const idValue = identifier.attributes?.identifier ?? null;

    if (idType === "ip" && idValue) {
      const isProxy =
        identifier.attributes?.metadata?.connectionInfo?.proxy === true;
      ips.push({ ip: idValue, isProxy });
    }

    // Every related player listed under this identifier shares THIS identifier
    // with the subject — so for an "ip" identifier we learn exactly which IP
    // links each alt, not just that they share something.
    for (const rel of identifier.relationships?.relatedPlayers?.data ?? []) {
      if (rel.id === bmId) continue; // self-reference
      const entry =
        related[rel.id] ??
        (related[rel.id] = {
          matchCount: 0,
          sharedIps: new Set(),
          sharedTypes: {},
        });
      entry.matchCount += 1;
      if (idType)
        entry.sharedTypes[idType] = (entry.sharedTypes[idType] ?? 0) + 1;
      if (idType === "ip" && idValue) entry.sharedIps.add(idValue);
    }
  }

  const relatedPlayers = Object.entries(related)
    .sort((a, b) => b[1].matchCount - a[1].matchCount)
    .slice(0, 20)
    .map(([id, v]) => ({
      bmId: id,
      matchCount: v.matchCount,
      sharedIps: Array.from(v.sharedIps),
      sharedTypes: v.sharedTypes,
    }));

  return { ips, relatedPlayers };
}

async function fetchBMPlayerBans(bmId, orgId) {
  const url =
    `https://api.battlemetrics.com/bans` +
    `?version=%5E0.1.0&filter[player]=${encodeURIComponent(bmId)}` +
    `&include=organization&page[size]=100`;
  const resp = await bmFetch(orgId, url);
  if (!resp?.ok) return [];

  const data = await resp.json();
  const orgs = {};
  for (const inc of data.included ?? []) {
    if (inc.type === "organization")
      orgs[inc.id] = inc.attributes?.name ?? null;
  }

  return (data.data ?? []).map((ban) => {
    const orgRef = ban.relationships?.organization?.data?.id;
    return {
      bmBanId: String(ban.id),
      bmOrgId: orgRef ? String(orgRef) : null,
      bmOrgName: orgRef ? (orgs[orgRef] ?? null) : null,
      reason: ban.attributes?.reason ?? null,
      note: ban.attributes?.note ?? null,
      expiresAt: ban.attributes?.expires
        ? Math.floor(new Date(ban.attributes.expires).getTime() / 1000)
        : null,
      bannedAt: ban.attributes?.timestamp
        ? Math.floor(new Date(ban.attributes.timestamp).getTime() / 1000)
        : null,
      permanent: ban.attributes?.permanent ?? !ban.attributes?.expires,
    };
  });
}

async function fetchBMActivity(bmId, orgId) {
  const url =
    `https://api.battlemetrics.com/activity` +
    `?tagTypeMode=and&filter[types][blacklist]=event:query` +
    `&filter[players]=${encodeURIComponent(bmId)}` +
    `&include=organization,user&page[size]=1000`;

  const CHEAT_KW = [
    "cheat",
    "hack",
    "aim",
    "wallhack",
    "wh",
    "esp",
    "fly",
    "head",
    "vision",
    "speed",
  ];
  const TEAM_KW = [
    " team",
    "teaming",
    "teamming",
    "limit",
    "rule",
    "alliance",
    "max",
    "group",
    "duo",
    "trio",
    "quad",
    "squad",
    "man",
  ];

  let nextUrl = url;
  const activities = [];
  while (nextUrl) {
    const resp = await bmFetch(orgId, nextUrl);
    if (!resp?.ok) break;
    const json = await resp.json();
    activities.push(...(json.data ?? []));
    nextUrl = json.links?.next ?? null;
  }

  const reporters = {
    cheating: new Set(),
    teaming: new Set(),
    other: new Set(),
  };
  let kills = 0,
    deaths = 0;

  for (const activity of activities) {
    const attrs = activity.attributes;

    if (
      attrs.messageType === "rustLog:playerReport" &&
      String(attrs.data?.forPlayerId) === String(bmId)
    ) {
      const text = (
        (attrs.data.reason ?? "").replace(
          /\[cheat\]|\[spam\]|\[abusive\]/g,
          "",
        ) +
        " " +
        (attrs.data.message ?? "")
      ).toLowerCase();

      let category = "other";
      if (CHEAT_KW.some((w) => text.includes(w))) category = "cheating";
      else if (TEAM_KW.some((w) => text.includes(w))) category = "teaming";
      else if (attrs.data.reportType === "cheat") category = "cheating";

      reporters[category].add(attrs.data.fromPlayerId);
    } else if (attrs.messageType === "rustLog:playerDeath:PVP") {
      if (String(attrs.data?.killer_id) === String(bmId)) kills++;
      else if (String(attrs.data?.player_id) === String(bmId)) deaths++;
    }
  }

  return {
    cheatingReports: reporters.cheating.size,
    teamingReports: reporters.teaming.size,
    otherReports: reporters.other.size,
    kills,
    deaths,
  };
}

async function fetchSteamFriends(steamId, orgId) {
  const resp = await steamApiFetch(orgId, "/ISteamUser/GetFriendList/v0001/", {
    steamid: steamId,
    relationship: "friend",
  });

  if (!resp || resp.status === 401 || resp.status === 403) {
    return { isPublic: false, friends: null };
  }
  if (!resp.ok) return { isPublic: false, friends: null };

  const json = await resp.json();
  const friends = json.friendslist?.friends;
  if (!friends) return { isPublic: false, friends: [] };

  return {
    isPublic: true,
    friends: friends.map((f) => String(f.steamid)),
  };
}

// Returns the player's Steam group GIDs, or null when the profile/groups are
// private or the call fails. Note: GetUserGroupList only returns GIDs (no names
// or member counts), so shared-group evidence is a GID intersection count.
async function fetchSteamGroups(steamId, orgId) {
  const resp = await steamApiFetch(orgId, "/ISteamUser/GetUserGroupList/v1/", {
    steamid: steamId,
  });
  if (!resp?.ok) return null;
  const json = await resp.json().catch(() => null);
  if (!json?.response?.success) return null;
  return (json.response.groups ?? []).map((g) => String(g.gid));
}

// Returns recent BM session windows [{bmServerId, startedAt, stoppedAt}] for a
// player, used to compute temporal co-presence with the subject. Capped to avoid
// pulling a player's entire history.
async function fetchBMSessions(bmId, orgId, { maxPages = 5, sinceUnix = null } = {}) {
  let url =
    `https://api.battlemetrics.com/players/${encodeURIComponent(bmId)}` +
    `/relationships/sessions?page[size]=100`;
  const out = [];
  let pages = 0;
  while (url && pages < maxPages) {
    const resp = await bmFetch(orgId, url);
    if (!resp?.ok) break;
    const json = await resp.json().catch(() => null);
    if (!json) break;
    for (const s of json.data ?? []) {
      const start = s.attributes?.start
        ? Math.floor(new Date(s.attributes.start).getTime() / 1000)
        : null;
      const stop = s.attributes?.stop
        ? Math.floor(new Date(s.attributes.stop).getTime() / 1000)
        : null;
      const serverId = s.relationships?.server?.data?.id
        ? String(s.relationships.server.data.id)
        : null;
      if (start == null || serverId == null) continue;
      if (sinceUnix != null && (stop ?? start) < sinceUnix) continue;
      out.push({ bmServerId: serverId, startedAt: start, stoppedAt: stop });
    }
    url = json.links?.next ?? null;
    pages++;
  }
  return out;
}

async function fetchRelatedAccountDetails(relatedPlayers, orgId) {
  const sinceUnix = Math.floor(Date.now() / 1000) - 90 * 86400;
  const settled = await Promise.allSettled(
    relatedPlayers.slice(0, 12).map(async (rel) => {
      const { bmId, matchCount, sharedIps = [], sharedTypes = {} } = rel;
      const profileResp = await bmFetch(
        orgId,
        `https://api.battlemetrics.com/players/${encodeURIComponent(bmId)}?include=identifier&version=%5E0.1.0`,
      );
      if (!profileResp?.ok) return null;

      const profileJson = await profileResp.json();
      const included = profileJson.included ?? [];
      const steamIdInc = included.find(
        (inc) =>
          inc.type === "identifier" && inc.attributes?.type === "steamID",
      );
      const relatedSteamId = steamIdInc?.attributes?.identifier
        ? String(steamIdInc.attributes.identifier)
        : null;
      const nameAliases = included
        .filter(
          (inc) => inc.type === "identifier" && inc.attributes?.type === "name",
        )
        .map((inc) => inc.attributes?.identifier)
        .filter(Boolean);
      const rustBans = steamIdInc?.attributes?.metadata?.rustBans;

      // Ban count + social/activity enrichment in parallel. Steam calls need the
      // resolved steamID; sessions need the BM id. All failures degrade to empty.
      const [bansResp, friendsRes, groups, sessions] = await Promise.all([
        bmFetch(
          orgId,
          `https://api.battlemetrics.com/bans?version=%5E0.1.0&filter[player]=${encodeURIComponent(bmId)}`,
        ),
        relatedSteamId
          ? fetchSteamFriends(relatedSteamId, orgId).catch(() => ({
              isPublic: false,
              friends: null,
            }))
          : Promise.resolve({ isPublic: false, friends: null }),
        relatedSteamId
          ? fetchSteamGroups(relatedSteamId, orgId).catch(() => null)
          : Promise.resolve(null),
        fetchBMSessions(bmId, orgId, { sinceUnix }).catch(() => []),
      ]);

      let bmBanCount = 0;
      if (bansResp?.ok) {
        const bansJson = await bansResp.json();
        bmBanCount = bansJson.data?.length ?? 0;
      }

      return {
        relatedBmId: String(bmId),
        relatedSteamId,
        relatedName: profileJson.data?.attributes?.name ?? null,
        nameAliases,
        matchCount,
        sharedIps,
        sharedTypes,
        friends: friendsRes?.friends ?? null,
        groups,
        sessions,
        hasBmBans: bmBanCount > 0,
        bmBanCount,
        hasEacBans: (rustBans?.count ?? 0) > 0,
        eacLastBan: rustBans?.lastBan
          ? Math.floor(new Date(rustBans.lastBan).getTime() / 1000)
          : null,
      };
    }),
  );

  return settled
    .filter((r) => {
      if (r.status === "rejected") {
        console.warn(`[player] related account fetch error: ${r.reason?.message}`);
        return false;
      }
      return r.value !== null;
    })
    .map((r) => r.value);
}

// ── Alt-account evidence + scoring ────────────────────────────────────────────

// Dice bigram similarity (0..100). Same algorithm as the frontend similarity()
// helper, kept here so the score is computed server-side once at refresh time.
function nameBigramSimilarity(a, b) {
  const grams = (s) => {
    const t = (s ?? "").toLowerCase().replace(/\s+/g, "");
    const g = new Set();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  A.forEach((g) => B.has(g) && inter++);
  return Math.round((2 * inter * 100) / (A.size + B.size || 1));
}

function bestNameSimilarity(subjectAliases, altAliases) {
  let best = 0;
  for (const s of subjectAliases) {
    for (const a of altAliases) {
      const sim = nameBigramSimilarity(s, a);
      if (sim > best) best = sim;
    }
  }
  return best;
}

// Classify whether two players were ever online together on shared servers.
// alt_switch  = many shared-server sessions but never overlapping → likely one
//               person switching accounts.
// co_play     = sessions frequently overlap → likely teammates, NOT an alt.
// inconclusive = too little shared-server data to tell.
function computeCoPresence(subjectWindows, altWindows) {
  const byServer = (windows) => {
    const m = new Map();
    for (const w of windows) {
      if (!m.has(w.bmServerId)) m.set(w.bmServerId, []);
      m.get(w.bmServerId).push(w);
    }
    return m;
  };
  const subjByServer = byServer(subjectWindows);
  const altByServer = byServer(altWindows);
  const sharedServers = [...altByServer.keys()].filter((s) =>
    subjByServer.has(s),
  );
  if (!sharedServers.length)
    return { verdict: "inconclusive", sharedServers: 0, altSessions: 0, overlapping: 0, ratio: 0 };

  let altSessions = 0;
  let overlapping = 0;
  for (const srv of sharedServers) {
    const sw = subjByServer.get(srv);
    for (const a of altByServer.get(srv)) {
      altSessions++;
      const aStart = a.startedAt;
      const aStop = a.stoppedAt ?? a.startedAt;
      if (sw.some((s) => s.startedAt <= aStop && aStart <= (s.stoppedAt ?? s.startedAt)))
        overlapping++;
    }
  }
  const ratio = altSessions ? overlapping / altSessions : 0;
  let verdict;
  if (altSessions < 5) verdict = "inconclusive";
  else if (ratio >= 0.3) verdict = "co_play";
  else if (overlapping === 0) verdict = "alt_switch";
  else verdict = "inconclusive";
  return {
    verdict,
    sharedServers: sharedServers.length,
    altSessions,
    overlapping,
    ratio: Math.round(ratio * 100),
  };
}

// Pure rollup of all signals for one related account into an evidence object +
// confidence tier. `subject` carries the subject's aliases/friends/groups/
// session data; `ipMetaByIp` maps a shared IP to its proxycheck classification.
function computeAltEvidence(subject, alt, ipMetaByIp) {
  const STRONG = new Set(["residential", "business", "mobile"]);

  const sharedIps = (alt.sharedIps ?? []).map((ip) => {
    const m = ipMetaByIp[ip] ?? {};
    return {
      ip,
      connType: m.connType ?? null,
      isp: m.isp ?? null,
      asn: m.asn ?? null,
      country: m.country ?? null,
    };
  });
  const nonProxyLinked = sharedIps.some((x) => STRONG.has(x.connType));

  const subjAliases = subject.aliases?.length
    ? subject.aliases
    : subject.displayName
      ? [subject.displayName]
      : [];
  const altAliases = alt.nameAliases?.length
    ? alt.nameAliases
    : alt.relatedName
      ? [alt.relatedName]
      : [];
  const nameSimilarity = bestNameSimilarity(subjAliases, altAliases);

  const subjFriends = subject.friends ?? new Set();
  const mutualFriends = (alt.friends ?? []).filter((f) => subjFriends.has(f));

  const subjGroups = subject.groups ?? new Set();
  const sharedGroups = (alt.groups ?? []).filter((g) => subjGroups.has(g));

  const subjServers = subject.serverIds ?? new Set();
  const altServers = new Set((alt.sessions ?? []).map((s) => s.bmServerId));
  const serverOverlap = [...altServers].filter((s) => subjServers.has(s));

  const coPresence = computeCoPresence(
    subject.sessionWindows ?? [],
    alt.sessions ?? [],
  );

  // Weighted rollup. Residential/business shared IPs are the strongest signal;
  // VPN/proxy/hosting contribute nothing (they're shared by thousands). Frequent
  // co-play actively lowers the score (teammates, not the same person).
  let score = 0;
  const resBiz = sharedIps.filter(
    (x) => x.connType === "residential" || x.connType === "business",
  ).length;
  const mob = sharedIps.filter((x) => x.connType === "mobile").length;
  if (resBiz > 0) score += 45 + Math.min(15, (resBiz - 1) * 5);
  else if (mob > 0) score += 25;
  if (nameSimilarity >= 70) score += 20;
  else if (nameSimilarity >= 45) score += 10;
  score += Math.min(15, mutualFriends.length * 5);
  score += Math.min(8, sharedGroups.length * 4);
  if (coPresence.verdict === "alt_switch") score += 20;
  else if (coPresence.verdict === "co_play") score -= 15;
  if (alt.hasEacBans || alt.hasBmBans) score += 5;
  score = Math.max(0, Math.min(100, score));

  let altConfidence;
  if (score >= 70) altConfidence = "high";
  else if (score >= 45) altConfidence = "likely";
  else if (score >= 20) altConfidence = "possible";
  else altConfidence = "unlikely";

  return {
    ...alt,
    sharedIps,
    nonProxyLinked,
    nameSimilarity,
    mutualFriends,
    sharedGroups,
    serverOverlap,
    coPresence,
    altConfidence,
    altScore: score,
  };
}

// Normalize proxycheck's free-form `type` (plus the proxy flag) into one of the
// five connection classes the UI groups IPs by. Returns null when unknown.
function classifyConnType(meta) {
  const t = (meta.type ?? "").toLowerCase();
  if (meta.proxy === "yes" || t.includes("vpn") || t.includes("proxy") || t === "tor")
    return "proxy_vpn";
  if (t.includes("hosting") || t.includes("data center") || t.includes("server"))
    return "hosting";
  if (t.includes("business")) return "business";
  if (t.includes("wireless") || t.includes("mobile") || t.includes("cellular"))
    return "mobile";
  if (t.includes("residential")) return "residential";
  return null;
}

async function runProxycheckForIps(ipList, orgId) {
  if (!ipList.length) return {};
  const results = {};
  let classified = 0;
  let unknown = 0;
  for (let i = 0; i < ipList.length; i += 100) {
    const chunk = ipList.slice(i, i + 100);
    const resp = await proxycheckApiFetch(orgId, chunk);
    if (!resp) {
      console.warn(
        `[proxycheck] org=${orgId} — no response (no enabled proxycheck API key for this org?)`,
      );
      continue;
    }
    if (!resp.ok) {
      console.warn(`[proxycheck] org=${orgId} — HTTP ${resp.status}`);
      continue;
    }
    const data = await resp.json().catch(() => null);
    if (!data) {
      console.warn(`[proxycheck] org=${orgId} — non-JSON response`);
      continue;
    }
    // proxycheck signals key/quota problems via status !== "ok" (e.g. "denied").
    if (data.status && data.status !== "ok") {
      console.warn(
        `[proxycheck] org=${orgId} — status=${data.status} message=${data.message ?? "(none)"}`,
      );
    }
    for (const [ip, meta] of Object.entries(data)) {
      if (ip === "status" || ip === "message" || typeof meta !== "object")
        continue;
      const connType = classifyConnType(meta);
      if (connType) classified++;
      else unknown++;
      results[ip] = {
        isProxy: meta.proxy === "yes",
        isVpn: (meta.type ?? "") === "VPN",
        connType,
        // proxycheck's v2 ASN response uses `provider`/`organisation`, not `isp`.
        isp: meta.isp ?? meta.provider ?? meta.organisation ?? null,
        country: meta.country ?? null,
        asn: meta.asn ?? null,
      };
    }
  }
  console.log(
    `[proxycheck] org=${orgId} — ${Object.keys(results).length} IP(s): ${classified} classified, ${unknown} unknown type`,
  );
  return results;
}

// ── Player Redis cache helpers ────────────────────────────────────────────────

const playerRedisKey = (steamId) => `player:data:${steamId}`;
const playerFetchLock = (steamId) => `player:fetching:${steamId}`;
const PLAYER_REDIS_TTL = 30 * 24 * 3600; // 30 days — matches PostgreSQL cache_expires_at

async function getPlayerDataFromRedis(steamId) {
  try {
    const raw = await redis.get(playerRedisKey(steamId));
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

async function writePlayerDataToRedis(steamId) {
  try {
    const data = await getPlayerCacheData(steamId);
    if (!data) return;
    await redis.set(
      playerRedisKey(steamId),
      JSON.stringify(data),
      "EX",
      PLAYER_REDIS_TTL,
    );
  } catch (err) {
    console.error(`[player] redis write error for ${steamId}:`, err.message);
  }
}

async function acquirePlayerFetchLock(steamId) {
  try {
    const result = await redis.set(
      playerFetchLock(steamId),
      "1",
      "NX",
      "EX",
      120, // 2-minute lock TTL — refreshPlayerData should always complete within this
    );
    return result === "OK";
  } catch {
    return true; // fail-open: if Redis is down, allow the refresh
  }
}

async function releasePlayerFetchLock(steamId) {
  try {
    await redis.del(playerFetchLock(steamId));
  } catch {}
}

// ── Player cache write helpers ────────────────────────────────────────────────

async function ensurePlayerCacheRow(steamId) {
  await pool.query(
    `INSERT INTO player_cache (steam_id) VALUES ($1)
     ON CONFLICT (steam_id) DO NOTHING`,
    [steamId],
  );
}

async function writeSteamDataToCache(steamId, data) {
  await ensurePlayerCacheRow(steamId);
  await pool.query(
    `UPDATE player_cache SET
       display_name             = COALESCE($2, display_name),
       avatar_url               = COALESCE($3, avatar_url),
       steam_profile_visibility = $4,
       steam_profile_created_at = COALESCE($5, steam_profile_created_at),
       steam_rust_hours         = CASE WHEN $6 THEN $7 ELSE steam_rust_hours END,
       steam_data_public        = $6,
       steam_cached_at          = unix_now(),
       cache_expires_at         = unix_now() + 2592000
     WHERE steam_id = $1`,
    [
      steamId,
      data.displayName,
      data.avatarUrl,
      data.profileVisibility,
      data.profileCreatedAt,
      data.hoursPublic,
      data.rustHours,
    ],
  );
}

async function writeBMDataToCache(steamId, bmId, data) {
  await ensurePlayerCacheRow(steamId);
  await pool.query(
    `UPDATE player_cache SET
       bm_id                = $2,
       bm_profile_created_at = COALESCE($3, bm_profile_created_at),
       bm_private           = $4,
       bm_rust_hours        = $5,
       bm_aimtrain_hours    = $6,
       bm_server_count      = $7,
       bm_rust_bans_count   = $8,
       bm_rust_bans_last_ban = $9,
       bm_rust_bans_banned  = $10,
       bm_name_aliases      = $11,
       bm_cached_at         = unix_now(),
       cache_expires_at     = unix_now() + 2592000
     WHERE steam_id = $1`,
    [
      steamId,
      bmId,
      data.bmProfileCreatedAt,
      data.bmPrivate,
      data.bmRustHours,
      data.bmAimtrainHours,
      data.bmServerCount,
      data.bmRustBansCount,
      data.bmRustBansLastBan,
      data.bmRustBansBanned,
      data.nameAliases ? JSON.stringify(data.nameAliases) : null,
    ],
  );
}

async function writeActivityToCache(steamId, data) {
  await pool.query(
    `UPDATE player_cache SET
       bm_cheating_reports = $2,
       bm_teaming_reports  = $3,
       bm_other_reports    = $4,
       bm_kills            = $5,
       bm_deaths           = $6,
       activity_cached_at  = unix_now()
     WHERE steam_id = $1`,
    [
      steamId,
      data.cheatingReports,
      data.teamingReports,
      data.otherReports,
      data.kills,
      data.deaths,
    ],
  );
}

async function writeBMSessionsToCache(steamId, sessions) {
  if (!sessions.length) return;
  await pool.query(
    `INSERT INTO player_bm_sessions
       (steam_id, bm_server_id, server_name, hours_played, last_seen)
     SELECT $1, unnest($2::text[]), unnest($3::text[]),
            unnest($4::numeric[]), unnest($5::BIGINT[])
     ON CONFLICT (steam_id, bm_server_id) DO UPDATE SET
       server_name  = EXCLUDED.server_name,
       hours_played = EXCLUDED.hours_played,
       last_seen    = EXCLUDED.last_seen,
       cached_at    = unix_now()`,
    [
      steamId,
      sessions.map((s) => s.bmServerId),
      sessions.map((s) => s.serverName),
      sessions.map((s) => s.hoursPlayed),
      sessions.map((s) => s.lastSeen),
    ],
  );
}

async function writeBMBansToCache(steamId, bans) {
  if (!bans.length) return;
  await pool.query(
    `INSERT INTO player_bm_bans_cache
       (steam_id, bm_ban_id, bm_org_id, bm_org_name, reason, note,
        expires_at, banned_at, permanent)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]),
            unnest($4::text[]), unnest($5::text[]), unnest($6::text[]),
            unnest($7::bigint[]), unnest($8::bigint[]), unnest($9::boolean[])
     ON CONFLICT (bm_ban_id) DO UPDATE SET
       bm_org_name      = EXCLUDED.bm_org_name,
       reason           = EXCLUDED.reason,
       note             = EXCLUDED.note,
       expires_at       = EXCLUDED.expires_at,
       permanent        = EXCLUDED.permanent,
       cached_at        = unix_now(),
       cache_expires_at = unix_now() + 2592000`,
    [
      bans.map(() => steamId),
      bans.map((b) => b.bmBanId),
      bans.map((b) => b.bmOrgId),
      bans.map((b) => b.bmOrgName),
      bans.map((b) => b.reason),
      bans.map((b) => b.note),
      bans.map((b) => b.expiresAt),
      bans.map((b) => b.bannedAt),
      bans.map((b) => b.permanent),
    ],
  );
}

async function writeIpsToHistory(steamId, ips) {
  if (!ips.length) return;
  await pool.query(
    `INSERT INTO player_ip_history (steam_id, ip_address, is_vpn, last_seen)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::boolean[]), unix_now()
     ON CONFLICT (steam_id, ip_address) DO UPDATE SET
       last_seen = unix_now(),
       is_vpn    = COALESCE(EXCLUDED.is_vpn, player_ip_history.is_vpn)`,
    [
      ips.map(() => steamId),
      ips.map((x) => x.ip),
      ips.map((x) => x.isProxy),
    ],
  );
}

async function writeRelatedAccountsToCache(steamId, accounts) {
  if (!accounts.length) return;
  // Per-row insert (≤ 20 rows) — the evidence columns are JSONB, which doesn't
  // unnest cleanly the way the old scalar-only bulk insert did.
  for (const a of accounts) {
    await pool.query(
      `INSERT INTO player_related_accounts
         (steam_id, related_bm_id, related_steam_id, related_name, name_aliases,
          match_count, has_bm_bans, bm_ban_count, has_eac_bans, eac_last_ban,
          name_similarity, shared_ips, non_proxy_linked, mutual_friends,
          shared_groups, server_overlap, co_presence, alt_confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (steam_id, related_bm_id) DO UPDATE SET
         related_steam_id = EXCLUDED.related_steam_id,
         related_name     = COALESCE(EXCLUDED.related_name, player_related_accounts.related_name),
         name_aliases     = EXCLUDED.name_aliases,
         match_count      = EXCLUDED.match_count,
         has_bm_bans      = EXCLUDED.has_bm_bans,
         bm_ban_count     = EXCLUDED.bm_ban_count,
         has_eac_bans     = EXCLUDED.has_eac_bans,
         eac_last_ban     = EXCLUDED.eac_last_ban,
         name_similarity  = EXCLUDED.name_similarity,
         shared_ips       = EXCLUDED.shared_ips,
         non_proxy_linked = EXCLUDED.non_proxy_linked,
         mutual_friends   = EXCLUDED.mutual_friends,
         shared_groups    = EXCLUDED.shared_groups,
         server_overlap   = EXCLUDED.server_overlap,
         co_presence      = EXCLUDED.co_presence,
         alt_confidence   = EXCLUDED.alt_confidence,
         cached_at        = unix_now(),
         cache_expires_at = unix_now() + 2592000`,
      [
        steamId,
        a.relatedBmId,
        a.relatedSteamId ?? null,
        a.relatedName ?? null,
        a.nameAliases ? JSON.stringify(a.nameAliases) : null,
        a.matchCount ?? 0,
        a.hasBmBans ?? false,
        a.bmBanCount ?? 0,
        a.hasEacBans ?? false,
        a.eacLastBan ?? null,
        a.nameSimilarity ?? null,
        a.sharedIps ? JSON.stringify(a.sharedIps) : null,
        a.nonProxyLinked ?? null,
        a.mutualFriends ? JSON.stringify(a.mutualFriends) : null,
        a.sharedGroups ? JSON.stringify(a.sharedGroups) : null,
        a.serverOverlap ? JSON.stringify(a.serverOverlap) : null,
        a.coPresence ? JSON.stringify(a.coPresence) : null,
        a.altConfidence ?? null,
      ],
    );
  }
}

async function writeSessionWindowsToCache(steamId, windows) {
  await pool.query(`DELETE FROM player_session_windows WHERE steam_id = $1`, [
    steamId,
  ]);
  if (!windows.length) return;
  await pool.query(
    `INSERT INTO player_session_windows (steam_id, bm_server_id, started_at, stopped_at)
     SELECT $1, unnest($2::text[]), unnest($3::bigint[]), unnest($4::bigint[])
     ON CONFLICT (steam_id, bm_server_id, started_at) DO NOTHING`,
    [
      steamId,
      windows.map((w) => w.bmServerId),
      windows.map((w) => w.startedAt),
      windows.map((w) => w.stoppedAt),
    ],
  );
}

async function writeFriendsToCache(steamId, result) {
  await pool.query(
    `INSERT INTO player_friends_meta (steam_id, friends_public, friend_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (steam_id) DO UPDATE SET
       friends_public   = $2,
       friend_count     = $3,
       cached_at        = unix_now(),
       cache_expires_at = unix_now() + 2592000`,
    [steamId, result.isPublic, result.friends?.length ?? 0],
  );

  if (!result.isPublic || !result.friends?.length) return;

  const nowUnix = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO player_friends (steam_id, friend_steam_id, last_confirmed)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::bigint[])
     ON CONFLICT (steam_id, friend_steam_id) DO UPDATE SET
       last_confirmed = EXCLUDED.last_confirmed`,
    [
      result.friends.map(() => steamId),
      result.friends,
      result.friends.map(() => nowUnix),
    ],
  );
}

async function writeProxycheckToCache(ipResults) {
  for (const [ip, meta] of Object.entries(ipResults)) {
    await pool.query(
      `INSERT INTO ip_metadata (ip_address, is_proxy, is_vpn, conn_type, isp, country, asn)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ip_address) DO UPDATE SET
         is_proxy  = $2, is_vpn = $3, conn_type = $4, isp = $5,
         country   = $6, asn = $7,
         cached_at = unix_now(),
         cache_expires_at = unix_now() + 2592000`,
      [ip, meta.isProxy, meta.isVpn, meta.connType, meta.isp, meta.country, meta.asn],
    );
    await pool.query(
      `UPDATE player_ip_history SET is_vpn = $2 WHERE ip_address = $1`,
      [ip, meta.isVpn],
    );
  }
}

// ── Main player refresh orchestrator ─────────────────────────────────────────

async function refreshPlayerData(steamId, orgId) {
  const locked = await acquirePlayerFetchLock(steamId);
  if (!locked) {
    console.log(`[player:refresh] ${steamId} — already in progress, skipping`);
    return;
  }

  console.log(`[player:refresh] ${steamId} org=${orgId} — starting`);

  try {
    const [steamData, bmIdResult] = await Promise.all([
      fetchSteamPlayerData(steamId, orgId),
      (async () => {
        const { rows } = await pool.query(
          `SELECT bm_id FROM player_cache WHERE steam_id = $1 LIMIT 1`,
          [steamId],
        );
        return rows[0]?.bm_id ?? null;
      })(),
    ]);

    console.log(
      `[player:refresh] ${steamId} — steam ok=${steamData.success} name=${steamData.displayName ?? "(none)"} existingBmId=${bmIdResult ?? "none"}`,
    );

    let bmId = bmIdResult;

    if (steamData.success) {
      await writeSteamDataToCache(steamId, steamData);
    } else {
      console.warn(
        `[player:refresh] ${steamId} — steam fetch failed (no steam key for org ${orgId}?)`,
      );
      await ensurePlayerCacheRow(steamId);
    }

    if (!bmId) {
      bmId = await findBMIdBySteamId(steamId, orgId);
      if (bmId) {
        console.log(`[player:refresh] ${steamId} — resolved bmId=${bmId}`);
      } else {
        console.warn(
          `[player:refresh] ${steamId} — BM ID not found (no BM key for org ${orgId}? player not in BM?)`,
        );
      }
    }

    let bmData = null;
    let relIdentifiers = { ips: [], relatedPlayers: [] };
    let bmBans = [];

    if (bmId) {
      [bmData, relIdentifiers, bmBans] = await Promise.all([
        fetchBMPlayerData(bmId, orgId),
        fetchBMRelatedIdentifiers(bmId, orgId),
        fetchBMPlayerBans(bmId, orgId),
      ]);

      console.log(
        `[player:refresh] ${steamId} bmId=${bmId} — bmData ok=${!!bmData} ips=${relIdentifiers.ips.length} relatedPlayers=${relIdentifiers.relatedPlayers.length} bans=${bmBans.length}`,
      );

      if (bmData) {
        await writeBMDataToCache(steamId, bmId, bmData);
        await writeBMSessionsToCache(steamId, bmData.sessions);
      }
      await writeIpsToHistory(steamId, relIdentifiers.ips);
      await writeBMBansToCache(steamId, bmBans);
    }

    // Write core data (Steam + BM profile/sessions/bans/IPs) to Redis immediately
    // so the frontend polling can respond without waiting for the slower tasks below
    await writePlayerDataToRedis(steamId);
    console.log(`[player:refresh] ${steamId} — core data written to Redis`);

    // Secondary pass: friends, activity, related account details, proxycheck
    // Awaited inside the try block so the fetch lock is held for the full duration,
    // preventing a concurrent refresh from acquiring the lock and then having its
    // Redis write overwritten by this chain finishing late.
    const ipsOnly = relIdentifiers.ips.map((x) => x.ip);
    const sinceUnix = Math.floor(Date.now() / 1000) - 90 * 86400;
    try {
      // Phase A: subject-side enrichment. Proxycheck (IP classification),
      // friends, groups and session windows are all inputs to the alt scoring
      // that follows, so they must complete first.
      const [subjectFriends, , ipResults, subjectGroups, subjectWindows] =
        await Promise.all([
          fetchSteamFriends(steamId, orgId),
          bmId
            ? fetchBMActivity(bmId, orgId).then((r) =>
                writeActivityToCache(steamId, r),
              )
            : Promise.resolve(null),
          ipsOnly.length
            ? runProxycheckForIps(ipsOnly, orgId)
            : Promise.resolve({}),
          fetchSteamGroups(steamId, orgId),
          bmId ? fetchBMSessions(bmId, orgId, { sinceUnix }) : Promise.resolve([]),
        ]);

      // Fallback classification: when proxycheck is unavailable (no key) or
      // returns no usable `type`, fall back to BattleMetrics' own
      // connectionInfo.proxy flag so VPN/proxy/hosting IPs are still flagged
      // rather than showing as "unknown". BM only tells us proxy-vs-not, so this
      // can only yield `proxy_vpn` (it can't distinguish residential/business).
      for (const { ip, isProxy } of relIdentifiers.ips) {
        if (!isProxy) continue;
        const existing = ipResults[ip];
        if (!existing) {
          ipResults[ip] = {
            isProxy: true,
            isVpn: false,
            connType: "proxy_vpn",
            isp: null,
            country: null,
            asn: null,
          };
        } else if (!existing.connType) {
          existing.connType = "proxy_vpn";
          existing.isProxy = true;
        }
      }

      await Promise.all([
        writeFriendsToCache(steamId, subjectFriends),
        writeProxycheckToCache(ipResults),
        writeSessionWindowsToCache(steamId, subjectWindows),
      ]);

      // Phase B: per-alt enrichment + evidence scoring against the subject.
      if (bmId && relIdentifiers.relatedPlayers.length) {
        const altDetails = await fetchRelatedAccountDetails(
          relIdentifiers.relatedPlayers,
          orgId,
        );
        const subjectCtx = {
          aliases: bmData?.nameAliases ?? [],
          displayName: steamData.displayName ?? null,
          friends: new Set(subjectFriends?.friends ?? []),
          groups: new Set(subjectGroups ?? []),
          serverIds: new Set((bmData?.sessions ?? []).map((s) => s.bmServerId)),
          sessionWindows: subjectWindows,
        };
        const scored = altDetails.map((alt) =>
          computeAltEvidence(subjectCtx, alt, ipResults),
        );
        await writeRelatedAccountsToCache(steamId, scored);
      }
    } catch (err) {
      console.error(
        `[player:refresh] ${steamId} — background task error: ${err.message}`,
      );
    }
    await writePlayerDataToRedis(steamId);
    console.log(`[player:refresh] ${steamId} — background tasks done, Redis updated`);
  } catch (err) {
    console.error(
      `[player:refresh] ${steamId} — refresh failed: ${err.message}`,
    );
  } finally {
    await releasePlayerFetchLock(steamId);
  }
}

async function getPlayerCacheData(steamId) {
  const [profile, sessions, bans, friendsMeta, ips, related] =
    await Promise.all([
      pool.query(
        `SELECT *, cache_expires_at < unix_now() AS is_stale
         FROM player_cache WHERE steam_id = $1`,
        [steamId],
      ),
      pool.query(
        `SELECT bm_server_id, server_name, hours_played, last_seen
         FROM player_bm_sessions WHERE steam_id = $1
         ORDER BY hours_played DESC`,
        [steamId],
      ),
      pool.query(
        `SELECT bm_ban_id, bm_org_id, bm_org_name, reason, note,
                expires_at, banned_at, permanent, cached_at
         FROM player_bm_bans_cache WHERE steam_id = $1
         ORDER BY banned_at DESC NULLS LAST`,
        [steamId],
      ),
      pool.query(
        `SELECT friends_public, friend_count, cached_at, cache_expires_at
         FROM player_friends_meta WHERE steam_id = $1`,
        [steamId],
      ),
      pool.query(
        `SELECT pih.ip_address, pih.is_vpn, pih.server_name, pih.first_seen, pih.last_seen,
                im.is_proxy, im.conn_type, im.isp, im.country, im.asn
         FROM player_ip_history pih
         LEFT JOIN ip_metadata im ON im.ip_address = pih.ip_address
         WHERE pih.steam_id = $1
         ORDER BY pih.last_seen DESC`,
        [steamId],
      ),
      pool.query(
        `SELECT related_bm_id, related_steam_id, related_name, name_aliases,
                match_count, has_bm_bans, bm_ban_count, has_eac_bans, eac_last_ban,
                name_similarity, shared_ips, non_proxy_linked, mutual_friends,
                shared_groups, server_overlap, co_presence, alt_confidence, cached_at
         FROM player_related_accounts WHERE steam_id = $1
         ORDER BY match_count DESC`,
        [steamId],
      ),
    ]);

  const p = profile.rows[0] ?? null;
  if (!p) return null;

  const friendsMetaRow = friendsMeta.rows[0] ?? null;
  let friendsList = null;
  if (friendsMetaRow?.friends_public) {
    const fr = await pool.query(
      `SELECT friend_steam_id FROM player_friends WHERE steam_id = $1`,
      [steamId],
    );
    friendsList = fr.rows.map((r) => String(r.friend_steam_id));
  }

  return {
    steamId: String(p.steam_id),
    displayName: p.display_name ?? null,
    avatarUrl: p.avatar_url ?? null,
    steam: {
      profileVisibility: p.steam_profile_visibility ?? null,
      profileCreatedAt: p.steam_profile_created_at ?? null,
      rustHours: p.steam_rust_hours != null ? Number(p.steam_rust_hours) : null,
      dataPublic: Boolean(p.steam_data_public),
      cachedAt: p.steam_cached_at ?? null,
    },
    bm: p.bm_id
      ? {
          id: p.bm_id,
          profileCreatedAt: p.bm_profile_created_at ?? null,
          private: Boolean(p.bm_private),
          rustHours: p.bm_rust_hours != null ? Number(p.bm_rust_hours) : null,
          aimtrainHours:
            p.bm_aimtrain_hours != null ? Number(p.bm_aimtrain_hours) : null,
          serverCount: Number(p.bm_server_count),
          rustBansCount: Number(p.bm_rust_bans_count),
          rustBansLastBan: p.bm_rust_bans_last_ban ?? null,
          rustBansBanned: Boolean(p.bm_rust_bans_banned),
          cheatingReports: Number(p.bm_cheating_reports),
          teamingReports: Number(p.bm_teaming_reports),
          otherReports: Number(p.bm_other_reports),
          kills: Number(p.bm_kills),
          deaths: Number(p.bm_deaths),
          cachedAt: p.bm_cached_at ?? null,
          activityCachedAt: p.activity_cached_at ?? null,
        }
      : null,
    bmSessions: sessions.rows.map((r) => ({
      bmServerId: String(r.bm_server_id),
      serverName: r.server_name ?? null,
      hoursPlayed: Number(r.hours_played),
      lastSeen: r.last_seen ?? null,
    })),
    bmBans: bans.rows.map((r) => ({
      bmBanId: String(r.bm_ban_id),
      bmOrgId: r.bm_org_id ?? null,
      bmOrgName: r.bm_org_name ?? null,
      reason: r.reason ?? null,
      note: r.note ?? null,
      expiresAt: r.expires_at ?? null,
      bannedAt: r.banned_at ?? null,
      permanent: Boolean(r.permanent),
    })),
    friends: {
      public: friendsMetaRow?.friends_public ?? null,
      friendCount: friendsMetaRow?.friend_count ?? null,
      friends: friendsList,
      wasPublic: friendsMetaRow
        ? !friendsMetaRow.friends_public && friendsList !== null
        : false,
      cachedAt: friendsMetaRow?.cached_at ?? null,
    },
    ipHistory: ips.rows.map((r) => ({
      ipAddress: String(r.ip_address),
      isVpn: r.is_vpn ?? null,
      isProxy: r.is_proxy ?? null,
      connType: r.conn_type ?? null,
      isp: r.isp ?? null,
      country: r.country ?? null,
      asn: r.asn ?? null,
      serverName: r.server_name ?? null,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    })),
    relatedAccounts: related.rows.map((r) => ({
      relatedBmId: String(r.related_bm_id),
      relatedSteamId: r.related_steam_id ?? null,
      relatedName: r.related_name ?? null,
      nameAliases: r.name_aliases ?? null,
      matchCount: Number(r.match_count),
      hasBmBans: Boolean(r.has_bm_bans),
      bmBanCount: Number(r.bm_ban_count),
      hasEacBans: Boolean(r.has_eac_bans),
      eacLastBan: r.eac_last_ban ?? null,
      nameSimilarity: r.name_similarity ?? null,
      sharedIps: r.shared_ips ?? [],
      nonProxyLinked: r.non_proxy_linked ?? null,
      mutualFriends: r.mutual_friends ?? [],
      sharedGroups: r.shared_groups ?? [],
      serverOverlap: r.server_overlap ?? [],
      coPresence: r.co_presence ?? null,
      altConfidence: r.alt_confidence ?? null,
      cachedAt: r.cached_at,
    })),
    isStale: Boolean(p.is_stale),
    cacheExpiresAt: p.cache_expires_at,
  };
}

// ── External API key route handlers ──────────────────────────────────────────

async function handleListExternalKeys(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json({ error: "Forbidden: servers_manage permission required" }, 403);

  const { rows } = await pool.query(
    `SELECT key_id, org_id, service, label, priority, enabled,
            rate_limited_until, last_used_at, created_at
     FROM org_external_api_keys
     WHERE org_id = $1
     ORDER BY service, priority DESC, created_at`,
    [orgId],
  );

  return json({
    keys: rows.map((r) => ({
      keyId: String(r.key_id),
      service: r.service,
      label: r.label,
      priority: Number(r.priority),
      enabled: Boolean(r.enabled),
      rateLimitedUntil: r.rate_limited_until ?? null,
      lastUsedAt: r.last_used_at ?? null,
      createdAt: r.created_at,
    })),
  });
}

async function handleAddExternalKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json({ error: "Forbidden: servers_manage permission required" }, 403);

  if (!getPterodactylEncryptionKey())
    return json(
      {
        error:
          "Encryption not configured (PTERODACTYL_ENCRYPTION_KEY or JWT_SECRET required)",
      },
      503,
    );

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const service = String(body?.service ?? "")
    .trim()
    .toLowerCase();
  const rawKey = String(body?.key ?? "").trim();
  const label = String(body?.label ?? "")
    .trim()
    .slice(0, 128);
  const priority = Number(body?.priority ?? 0);

  if (!["battlemetrics", "steam", "proxycheck"].includes(service))
    return json(
      { error: "service must be battlemetrics, steam, or proxycheck" },
      400,
    );
  if (!rawKey) return json({ error: "key is required" }, 400);
  if (rawKey.length > 512)
    return json({ error: "key is too long (max 512 characters)" }, 400);

  let keyEncrypted;
  try {
    keyEncrypted = encryptExternalApiKey(rawKey);
  } catch {
    return json({ error: "Encryption error" }, 500);
  }

  const { rows } = await pool.query(
    `INSERT INTO org_external_api_keys
       (org_id, service, key_encrypted, label, priority, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING key_id, service, label, priority, enabled, created_at`,
    [orgId, service, keyEncrypted, label, priority, session.userId],
  );

  const r = rows[0];
  return json(
    {
      keyId: String(r.key_id),
      service: r.service,
      label: r.label,
      priority: Number(r.priority),
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
    },
    201,
  );
}

async function handleUpdateExternalKey(request, orgId, keyId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json({ error: "Forbidden: servers_manage permission required" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const sets = [];
  const params = [keyId, orgId];
  let idx = 3;

  if ("label" in body) {
    sets.push(`label = $${idx++}`);
    params.push(String(body.label).trim().slice(0, 128));
  }
  if ("priority" in body) {
    sets.push(`priority = $${idx++}`);
    params.push(Number(body.priority));
  }
  if ("enabled" in body) {
    sets.push(`enabled = $${idx++}`);
    params.push(Boolean(body.enabled));
  }
  if (body.clearRateLimit === true) {
    sets.push(`rate_limited_until = NULL`);
  }

  if (!sets.length) return json({ error: "Nothing to update" }, 400);

  const { rowCount } = await pool.query(
    `UPDATE org_external_api_keys SET ${sets.join(", ")}
     WHERE key_id = $1 AND org_id = $2`,
    params,
  );
  if (!rowCount) return json({ error: "Key not found" }, 404);

  return json({ ok: true });
}

async function handleDeleteExternalKey(request, orgId, keyId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json({ error: "Forbidden: servers_manage permission required" }, 403);

  const { rowCount } = await pool.query(
    `DELETE FROM org_external_api_keys WHERE key_id = $1 AND org_id = $2`,
    [keyId, orgId],
  );
  if (!rowCount) return json({ error: "Key not found" }, 404);

  return json({ ok: true });
}

async function handleGetExternalKeyStats(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json({ error: "Forbidden: servers_manage permission required" }, 403);

  const sinceHour = Math.floor(Date.now() / 1000 / 3600) * 3600 - 47 * 3600;

  const [{ rows }, pcRows] = await Promise.all([
    pool.query(
      `SELECT key_id::text AS key_id, bucket_hour, rate_limit_max,
              rate_limit_min_remaining, sample_count
       FROM org_external_api_key_stats
       WHERE org_id = $1 AND bucket_hour >= $2
       ORDER BY key_id, bucket_hour`,
      [orgId, sinceHour],
    ),
    pool.query(
      `SELECT key_id::text AS key_id, key_encrypted
       FROM org_external_api_keys
       WHERE org_id = $1 AND service = 'proxycheck'`,
      [orgId],
    ),
  ]);

  const stats = {};
  for (const r of rows) {
    if (!stats[r.key_id]) stats[r.key_id] = [];
    stats[r.key_id].push({
      bucket: Number(r.bucket_hour),
      rateMax: r.rate_limit_max != null ? Number(r.rate_limit_max) : null,
      minRemaining: r.rate_limit_min_remaining != null ? Number(r.rate_limit_min_remaining) : null,
      sampleCount: Number(r.sample_count),
    });
  }

  const proxycheckUsage = {};
  await Promise.all(
    pcRows.rows.map(async (r) => {
      try {
        const key = decryptExternalApiKey(String(r.key_encrypted));
        const resp = await fetch(
          `https://proxycheck.io/dashboard/export/usage/?key=${encodeURIComponent(key)}`,
        );
        if (resp.ok) {
          const data = await resp.json();
          proxycheckUsage[String(r.key_id)] = {
            queriesDay: Number(data["Queries Today"] ?? 0),
            dailyLimit: Number(data["Daily Limit"] ?? 0),
          };
        }
      } catch {
        // non-critical — usage bar just won't show for this key
      }
    }),
  );

  return json({ stats, proxycheckUsage });
}

// ── RIPE Atlas config and results handlers ────────────────────────────────────

async function handleGetRipeAtlasConfig(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json({ error: "Forbidden: servers_manage permission required" }, 403);

  const { rows } = await pool.query(
    `SELECT api_key_enc, countries, probes_per_country, created_at, updated_at
     FROM org_ripe_atlas_config WHERE org_id = $1`,
    [orgId],
  );

  if (!rows[0]) return json({ config: null, credits: null });

  const row = rows[0];
  let credits = null;
  try {
    const apiKey = decryptExternalApiKey(String(row.api_key_enc));
    credits = await ripeAtlasGetCredits(apiKey);
  } catch {
    // non-critical
  }

  return json({
    config: {
      countries: Array.isArray(row.countries) ? row.countries : [],
      probesPerCountry: Number(row.probes_per_country),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    },
    credits,
  });
}

async function handlePutRipeAtlasConfig(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json({ error: "Forbidden: servers_manage permission required" }, 403);

  if (!getPterodactylEncryptionKey())
    return json({ error: "Encryption not configured (PTERODACTYL_ENCRYPTION_KEY or JWT_SECRET required)" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const countries = Array.isArray(body?.countries)
    ? body.countries
        .filter((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c))
        .slice(0, 30)
    : [];
  if (!countries.length)
    return json({ error: "At least one country code is required" }, 400);

  const probesPerCountry = Math.min(Math.max(Number(body?.probesPerCountry ?? 3), 1), 10);

  const { rows: existing } = await pool.query(
    `SELECT org_id FROM org_ripe_atlas_config WHERE org_id = $1`,
    [orgId],
  );

  if (existing[0]) {
    const setClauses = [
      `countries = $2`,
      `probes_per_country = $3`,
      `updated_at = unix_now()`,
    ];
    const params = [orgId, countries, probesPerCountry];
    if (body?.apiKey?.trim()) {
      setClauses.push(`api_key_enc = $${params.length + 1}`);
      params.push(encryptExternalApiKey(body.apiKey.trim()));
    }
    await pool.query(
      `UPDATE org_ripe_atlas_config SET ${setClauses.join(", ")} WHERE org_id = $1`,
      params,
    );
  } else {
    const rawKey = String(body?.apiKey ?? "").trim();
    if (!rawKey) return json({ error: "API key is required when enabling monitoring" }, 400);
    await pool.query(
      `INSERT INTO org_ripe_atlas_config (org_id, api_key_enc, countries, probes_per_country)
       VALUES ($1, $2, $3, $4)`,
      [orgId, encryptExternalApiKey(rawKey), countries, probesPerCountry],
    );
  }

  const { rows: updated } = await pool.query(
    `SELECT api_key_enc, countries, probes_per_country, created_at, updated_at
     FROM org_ripe_atlas_config WHERE org_id = $1`,
    [orgId],
  );
  const row = updated[0];
  let credits = null;
  try {
    credits = await ripeAtlasGetCredits(decryptExternalApiKey(String(row.api_key_enc)));
  } catch {
    // non-critical
  }

  return json({
    config: {
      countries: Array.isArray(row.countries) ? row.countries : [],
      probesPerCountry: Number(row.probes_per_country),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    },
    credits,
  });
}

async function handleDeleteRipeAtlasConfig(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json({ error: "Forbidden: servers_manage permission required" }, 403);

  await pool.query(`DELETE FROM org_ripe_atlas_config WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM org_ripe_atlas_measurements WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM org_ripe_atlas_results WHERE org_id = $1`, [orgId]);

  return json({ ok: true });
}

async function handleGetRipeAtlasResults(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "status_view") &&
    !orgHasPermission(session, orgId, "servers_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const { rows: cfgRows } = await pool.query(
    `SELECT countries, probes_per_country FROM org_ripe_atlas_config WHERE org_id = $1`,
    [orgId],
  );
  if (!cfgRows[0]) return json({ configured: false });

  const { rows: servers } = await pool.query(
    `SELECT server_id, server_name, rcon_host
     FROM servers WHERE owner_org_id = $1 AND rcon_host IS NOT NULL
     ORDER BY server_name`,
    [orgId],
  );

  const { rows: results } = await pool.query(
    `SELECT DISTINCT ON (server_id, country)
       server_id, country, reachable, avg_rtt, min_rtt, max_rtt,
       probe_count, reachable_count, measured_at
     FROM org_ripe_atlas_results
     WHERE org_id = $1 AND measured_at > unix_now() - 3600
     ORDER BY server_id, country, measured_at DESC`,
    [orgId],
  );

  const { rows: pendingRows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM org_ripe_atlas_measurements
     WHERE org_id = $1 AND status = 'pending' AND created_at > unix_now() - 600`,
    [orgId],
  );

  return json({
    configured: true,
    countries: cfgRows[0].countries,
    probesPerCountry: Number(cfgRows[0].probes_per_country),
    servers: servers.map((s) => ({
      serverId: String(s.server_id),
      serverName: s.server_name,
      rconHost: s.rcon_host,
    })),
    results: results.map((r) => ({
      serverId: String(r.server_id),
      country: r.country,
      reachable: r.reachable,
      avgRtt: r.avg_rtt != null ? Number(r.avg_rtt) : null,
      minRtt: r.min_rtt != null ? Number(r.min_rtt) : null,
      maxRtt: r.max_rtt != null ? Number(r.max_rtt) : null,
      probeCount: Number(r.probe_count),
      reachableCount: Number(r.reachable_count),
      measuredAt: Number(r.measured_at),
    })),
    pendingCount: Number(pendingRows[0]?.cnt ?? 0),
  });
}

// ── Player connect ingest ─────────────────────────────────────────────────────

const CONNECT_INGEST_RATE_LIMIT_PER_MINUTE = 300;

async function handleIngestPlayerConnect(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) return json({ error: "Missing API key" }, 401);

  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKeyRaw)
    .digest("hex");
  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) return json({ error: "Invalid API key" }, 401);
  const server = serverRes.rows[0];

  const rlKey = `rl:connect:${server.server_id}`;
  try {
    const attempts = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1, rlKey, '60',
    );
    if (attempts > CONNECT_INGEST_RATE_LIMIT_PER_MINUTE)
      return json({ error: "Rate limit exceeded" }, 429);
  } catch {}

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const steamId = String(body?.steam_id ?? "").trim();
  const ip = body?.ip ? String(body.ip).trim() : null;
  const playerName = body?.player_name ? String(body.player_name).trim() : null;

  if (!steamId) return json({ error: "steam_id is required" }, 400);
  if (!/^765611\d{11}$/.test(steamId))
    return json({ error: "Invalid Steam ID" }, 400);

  // Record the IP immediately with server context
  if (ip) {
    await pool.query(
      `INSERT INTO player_ip_history (steam_id, ip_address, server_id, server_name, last_seen)
       VALUES ($1, $2, $3, $4, unix_now())
       ON CONFLICT (steam_id, ip_address) DO UPDATE SET
         last_seen   = unix_now(),
         server_id   = EXCLUDED.server_id,
         server_name = EXCLUDED.server_name`,
      [steamId, ip, server.server_id, server.server_name],
    );
  }

  // Update display name from in-game name if we don't have a Steam-sourced one yet
  if (playerName) {
    await ensurePlayerCacheRow(steamId);
    await pool.query(
      `UPDATE player_cache SET display_name = $2
       WHERE steam_id = $1 AND display_name IS NULL`,
      [steamId, playerName],
    );
  }

  // Refresh on every join, but throttle to once per hour per player.
  // Also force a refresh if BM data was never successfully fetched (bm_cached_at IS NULL)
  // so a partial Steam-only cache doesn't block BM data from ever being populated.
  const cacheCheck = await pool.query(
    `SELECT steam_cached_at, bm_cached_at FROM player_cache WHERE steam_id = $1 LIMIT 1`,
    [steamId],
  );
  const cacheRow = cacheCheck.rows[0];
  const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
  const needsRefresh =
    !cacheRow ||
    !cacheRow.steam_cached_at ||
    !cacheRow.bm_cached_at ||
    Number(cacheRow.steam_cached_at) < oneHourAgo;

  if (needsRefresh) {
    refreshPlayerData(steamId, server.owner_org_id).catch((err) =>
      console.error(
        `[ingest:connect] refresh error for ${steamId}:`,
        err.message,
      ),
    );
  }

  const refreshReason = !cacheRow
    ? "no-cache"
    : !cacheRow.steam_cached_at
      ? "steam-never-fetched"
      : !cacheRow.bm_cached_at
        ? "bm-never-fetched"
        : needsRefresh
          ? "stale(>1h)"
          : "fresh";
  console.log(
    `[ingest:connect] player=${playerName ?? steamId} server=${server.server_name} refresh=${needsRefresh}(${refreshReason}) ip=${ip ?? "-"}`,
  );

  return json({ ok: true });
}

// ── Player lookup route handlers ──────────────────────────────────────────────

function isValidSteamId(steamId) {
  return /^765611\d{11}$/.test(String(steamId));
}

async function handleGetPlayer(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ error: "orgId query parameter required" }, 400);

  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "player",
    resourceId: steamId,
    actionType: "PLAYER_VIEWED",
    actionCategory: "player_management",
    severity: 1,
    metadata: { steamId },
    ipAddress: getClientIp(request),
  });

  const canSeeIp = orgHasPermission(session, orgId, "ip_read");

  // Redis first — avoids 6 PostgreSQL queries on the hot path
  const fromRedis = await getPlayerDataFromRedis(steamId);
  if (fromRedis) {
    if (fromRedis.isStale) {
      refreshPlayerData(steamId, orgId).catch((err) =>
        console.error(`[player] bg refresh error for ${steamId}:`, err.message),
      );
    }
    return json(filterPlayerIpData(fromRedis, canSeeIp));
  }

  // Redis miss — fall back to PostgreSQL
  const cached = await getPlayerCacheData(steamId);

  if (!cached) {
    // No cache at all — kick off background refresh and tell the client to poll
    refreshPlayerData(steamId, orgId).catch((err) =>
      console.error(`[player] bg refresh error for ${steamId}:`, err.message),
    );
    return json({ fetching: true });
  }

  if (cached.isStale) {
    // Return stale data immediately; refresh in the background
    refreshPlayerData(steamId, orgId).catch((err) =>
      console.error(`[player] bg refresh error for ${steamId}:`, err.message),
    );
  }

  return json(filterPlayerIpData(cached, canSeeIp));
}

async function handleRefreshPlayer(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ error: "orgId query parameter required" }, 400);

  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const canSeeIp = orgHasPermission(session, orgId, "ip_read");

  // Clear Redis so refreshPlayerData can acquire the lock and write fresh data
  try {
    await redis.del(playerRedisKey(steamId));
  } catch {}
  await refreshPlayerData(steamId, orgId);
  const fresh =
    (await getPlayerDataFromRedis(steamId)) ??
    (await getPlayerCacheData(steamId));
  if (!fresh) return json({ error: "Failed to fetch player data" }, 502);
  return json(filterPlayerIpData(fresh, canSeeIp));
}

// ── Sysadmin: clear all player cache ─────────────────────────────────────────

async function handleClearAllPlayerCache(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isConfiguredSysAdmin(session))
    return json({ error: "Forbidden: sysadmin only" }, 403);

  // Delete all player data keys from Redis (data + fetch locks)
  let redisCleared = 0;
  try {
    const dataKeys = await redis.keys("player:data:*");
    const lockKeys = await redis.keys("player:fetching:*");
    const allKeys = [...dataKeys, ...lockKeys];
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
      redisCleared = dataKeys.length;
    }
  } catch {}

  // Delete main profile rows; other tables are overwritten on next refresh
  const { rowCount } = await pool.query(`DELETE FROM player_cache`);

  return json({ ok: true, redisCleared, dbCleared: rowCount ?? 0 });
}

// ── Player reports by Steam ID ────────────────────────────────────────────────

async function handleGetPlayerReports(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ error: "orgId query parameter required" }, 400);

  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const { rows } = await pool.query(
    `SELECT pr.id, pr.report_type, pr.report_reason, pr.report_description,
            pr.reporter_name, pr.reporter_steam_id, pr.server_name, pr.created_at
     FROM player_reports pr
     JOIN servers s ON s.server_id = pr.server_id
     WHERE pr.reported_steam_id = $1
       AND s.owner_org_id = $2
     ORDER BY pr.created_at DESC
     LIMIT 200`,
    [steamId, orgId],
  );

  const reports = rows.map((row) => ({
    id: String(row.id),
    reportType: String(row.report_type),
    reportReason: String(row.report_reason),
    reportDescription: String(row.report_description),
    reporterName: String(row.reporter_name),
    reporterSteamId: String(row.reporter_steam_id),
    serverName: String(row.server_name),
    createdAt: Number(row.created_at),
  }));

  return json({ reports });
}

// ── Org player search (ticket submission) ────────────────────────────────────

async function handleSearchOrgPlayers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return json({ players: [] });

  if (redis) {
    try {
      const count = await redis.eval(
        `local n = redis.call('INCR', KEYS[1])
         if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
         return n`,
        1, `rl:player-search:${session.userId}`, "60",
      );
      if (count > 60) return json({ error: "Too many requests" }, 429);
    } catch {}
  }

  const { rows } = await pool.query(
    `SELECT pc.steam_id, COALESCE(pc.display_name, pc.steam_id) AS name, ops.last_seen_at
     FROM org_player_sightings ops
     JOIN player_cache pc ON pc.steam_id = ops.steam_id
     WHERE ops.org_id = $1
       AND (
         pc.display_name ILIKE $2
         OR pc.steam_id LIKE $3
       )
     ORDER BY ops.last_seen_at DESC
     LIMIT 20`,
    [orgId, `%${q}%`, `${q}%`],
  );

  return json({
    players: rows.map((r) => ({
      steamId: String(r.steam_id),
      name: String(r.name),
      lastSeenAt: Number(r.last_seen_at),
    })),
  });
}

// ── Org player list (cached players + live RCON online status) ────────────────

async function handleGetOrgPlayerList(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const cacheKey = `player-list:${orgId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch {}

  const serversRes = await pool.query(
    `SELECT server_id, server_name, rcon_host, rcon_port, rcon_password_enc
     FROM servers
     WHERE owner_org_id = $1
       AND rcon_host IS NOT NULL
       AND rcon_port IS NOT NULL
       AND rcon_password_enc IS NOT NULL`,
    [orgId],
  );

  const servers = [];
  const onlineMap = new Map(); // steamId -> { serverId, serverName, ping }

  if (serversRes.rows.length > 0) {
    const serverResults = await Promise.allSettled(
      serversRes.rows.map(async (srv) => {
        let password;
        try {
          password = decryptPterodactylApiKey(String(srv.rcon_password_enc));
        } catch {
          return {
            serverId: String(srv.server_id),
            serverName: String(srv.server_name),
            rconError: "Credentials corrupted",
            players: [],
          };
        }
        const rconUrl = `ws://${srv.rcon_host}:${srv.rcon_port}/${encodeURIComponent(password)}`;
        try {
          const { response } = await executeRconCommand(
            rconUrl,
            "global.playerlist",
          );
          let rawPlayers;
          try {
            rawPlayers = JSON.parse(response);
          } catch {
            return {
              serverId: String(srv.server_id),
              serverName: String(srv.server_name),
              rconError: "Failed to parse playerlist",
              players: [],
            };
          }
          if (!Array.isArray(rawPlayers)) {
            return {
              serverId: String(srv.server_id),
              serverName: String(srv.server_name),
              rconError: "Unexpected response format",
              players: [],
            };
          }
          return {
            serverId: String(srv.server_id),
            serverName: String(srv.server_name),
            rconError: null,
            players: rawPlayers
              .map((p) => ({
                steamId: String(p.SteamID ?? ""),
                name: String(p.DisplayName ?? ""),
                ping: Number(p.Ping ?? 0),
              }))
              .filter((p) => /^\d{17}$/.test(p.steamId)),
          };
        } catch (err) {
          return {
            serverId: String(srv.server_id),
            serverName: String(srv.server_name),
            rconError: String(err.message),
            players: [],
          };
        }
      }),
    );

    for (const result of serverResults) {
      const val =
        result.status === "fulfilled"
          ? result.value
          : {
              serverId: "?",
              serverName: "?",
              rconError: String(result.reason?.message ?? result.reason),
              players: [],
            };
      servers.push({
        serverId: val.serverId,
        serverName: val.serverName,
        rconError: val.rconError,
        playerCount: val.players.length,
      });
      for (const p of val.players) {
        onlineMap.set(p.steamId, {
          serverId: val.serverId,
          serverName: val.serverName,
          ping: p.ping,
        });
      }
    }

    const onlineSteamIds = [...onlineMap.keys()];
    if (onlineSteamIds.length > 0) {
      try {
        await pool.query(
          `INSERT INTO org_player_sightings (org_id, steam_id, last_seen_at)
           SELECT $1, unnest($2::text[]), unix_now()
           ON CONFLICT (org_id, steam_id) DO UPDATE SET last_seen_at = unix_now()`,
          [orgId, onlineSteamIds],
        );
      } catch {}
    }
  }

  // All sighted players for this org with cache data, excluding active org bans
  const sightingsRes = await pool.query(
    `SELECT pc.steam_id, pc.display_name, pc.avatar_url,
            pc.steam_rust_hours, pc.steam_profile_created_at,
            pc.bm_rust_hours, pc.bm_kills, pc.bm_deaths,
            pc.bm_cheating_reports, pc.bm_teaming_reports, pc.bm_other_reports,
            pc.bm_rust_bans_count
     FROM org_player_sightings ops
     JOIN player_cache pc ON pc.steam_id = ops.steam_id
     WHERE ops.org_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM player_bans pb
         WHERE pb.identifier = pc.steam_id
           AND pb.identifier_type = 'steam_id'
           AND pb.org_id = $1
           AND pb.revoked = FALSE
           AND pb.action_type = 'ban'
           AND (pb.expires_at IS NULL OR pb.expires_at > unix_now())
       )
     ORDER BY ops.last_seen_at DESC`,
    [orgId],
  );

  const allSteamIds = sightingsRes.rows.map((r) => r.steam_id);
  let ipMap = {};
  if (allSteamIds.length > 0) {
    const ipRes = await pool.query(
      `SELECT DISTINCT ON (pih.steam_id)
              pih.steam_id, im.is_proxy, im.country
       FROM player_ip_history pih
       LEFT JOIN ip_metadata im ON im.ip_address = pih.ip_address
       WHERE pih.steam_id = ANY($1)
         AND (
           pih.server_id IS NULL
           OR pih.server_id IN (SELECT server_id FROM servers WHERE owner_org_id = $2)
         )
       ORDER BY pih.steam_id, pih.last_seen DESC`,
      [allSteamIds, orgId],
    );
    ipMap = Object.fromEntries(ipRes.rows.map((r) => [r.steam_id, r]));
  }

  const enriched = sightingsRes.rows.map((cache) => {
    const online = onlineMap.get(cache.steam_id);
    const ip = ipMap[cache.steam_id] ?? null;

    const totalHours =
      cache.steam_rust_hours != null
        ? Number(cache.steam_rust_hours)
        : cache.bm_rust_hours != null
          ? Number(cache.bm_rust_hours)
          : 0;
    const kills = Number(cache.bm_kills ?? 0);
    const deaths = Number(cache.bm_deaths ?? 0);
    const kd = deaths > 0 ? kills / deaths : kills > 0 ? kills : 0;
    const reportCount =
      Number(cache.bm_cheating_reports ?? 0) +
      Number(cache.bm_teaming_reports ?? 0) +
      Number(cache.bm_other_reports ?? 0);
    const accountAgeDays = cache.steam_profile_created_at
      ? Math.floor((Date.now() / 1000 - Number(cache.steam_profile_created_at)) / 86400)
      : 0;

    // Weighted signal approach mirroring Trigger page specs
    let sigScore = 0;
    if (ip?.is_proxy) sigScore += 0.5;
    if (Number(cache.bm_rust_bans_count ?? 0) > 0) sigScore += 0.3;
    if (accountAgeDays > 0 && accountAgeDays < 365) sigScore += 0.4;
    if (totalHours > 0 && totalHours < 100) sigScore += 0.3;
    if (reportCount >= 1) sigScore += 0.1;
    if (reportCount >= 5) sigScore += 0.3;
    const susScore = Math.min(Math.round(sigScore * 100), 100);

    return {
      steamId: cache.steam_id,
      name: cache.display_name ?? "",
      isOnline: !!online,
      serverId: online?.serverId ?? null,
      serverName: online?.serverName ?? null,
      ping: online?.ping ?? null,
      susScore,
      rustHours: totalHours,
      bmHours: cache.bm_rust_hours != null ? Number(cache.bm_rust_hours) : 0,
      kills,
      deaths,
      kd: Math.round(kd * 100) / 100,
      reportCount,
      isProxy: ip?.is_proxy ?? false,
      country: ip?.country ?? null,
      avatarUrl: cache.avatar_url ?? null,
      bmBans: Number(cache.bm_rust_bans_count ?? 0),
      accountAgeDays,
    };
  });

  const result = { players: enriched, servers };

  try {
    await redis.set(cacheKey, JSON.stringify(result), "EX", 30);
  } catch {}

  return json(result);
}

async function _handleApiRequest(request) {
  const earlyUrl = new URL(request.url);
  const earlyPath = earlyUrl.pathname;

  // Discord OAuth start/callback should not be blocked by the global startup guard.
  if (earlyPath === "/api/auth/discord/start" && request.method === "GET") {
    return handleDiscordStart(request);
  }
  if (
    earlyPath === "/api/auth/public/discord/start" &&
    request.method === "GET"
  ) {
    return handlePublicDiscordStart(request);
  }
  if (earlyPath === "/api/auth/discord/callback" && request.method === "GET") {
    return handleDiscordCallback(request);
  }

  return withStartupGuard(async () => {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/health" && request.method === "GET") {
      await pingDependencies();
      return json({ ok: true, postgres: true, redis: true, queue: true });
    }

    if (pathname === "/api/auth/steam/start" && request.method === "GET") {
      return handleSteamStart(request);
    }

    if (pathname === "/api/auth/steam/callback" && request.method === "GET") {
      return handleSteamCallback(request);
    }

    if (pathname === "/api/auth/pending-link" && request.method === "GET") {
      return handlePendingLinkStatus(request);
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      return handleLogout(request);
    }

    if (pathname === "/api/auth/me" && request.method === "GET") {
      return handleAuthMe(request);
    }
    if (pathname === "/api/auth/me" && request.method === "PATCH") {
      return handleUpdateAuthMe(request);
    }

    if (pathname === "/api/internal/discord/message" && request.method === "POST") {
      return handleIngestDiscordMessage(request);
    }

    if (pathname === "/api/todo/bootstrap" && request.method === "GET") {
      return handleTodoBootstrap(request);
    }

    if (pathname === "/api/todo" && request.method === "POST") {
      return handleCreateTodo(request);
    }

    // Public org listing and ticket type listing
    if (pathname === "/api/orgs" && request.method === "GET") {
      return handleListOrgs();
    }

    if (pathname === "/api/orgs" && request.method === "POST") {
      return handleCreateOrganization(request);
    }

    // Public Steam auth for ticket submission
    if (
      pathname === "/api/auth/steam/public/start" &&
      request.method === "GET"
    ) {
      return handlePublicSteamStart(request);
    }
    if (
      pathname === "/api/auth/steam/public/callback" &&
      request.method === "GET"
    ) {
      return handlePublicSteamCallback(request);
    }

    // Ticket routes
    if (pathname === "/api/tickets" && request.method === "POST") {
      return handleCreateTicket(request);
    }
    if (pathname === "/api/tickets/mine" && request.method === "GET") {
      return handleListMyTickets(request);
    }

    const todoMatch = pathname.match(/^\/api\/todo\/([a-zA-Z0-9-]+)$/);
    if (todoMatch && request.method === "PATCH") {
      return handleUpdateTodo(request, todoMatch[1]);
    }
    if (todoMatch && request.method === "DELETE") {
      return handleDeleteTodo(request, todoMatch[1]);
    }

    const ticketMatch = pathname.match(/^\/api\/tickets\/(\d+)$/);
    if (ticketMatch && request.method === "GET") {
      return handleGetTicket(request, ticketMatch[1]);
    }
    if (ticketMatch && request.method === "PATCH") {
      return handleUpdateTicket(request, ticketMatch[1]);
    }

    const ticketPlayerIntelMatch = pathname.match(
      /^\/api\/tickets\/(\d+)\/player-intel$/,
    );
    if (ticketPlayerIntelMatch && request.method === "GET") {
      return handleGetTicketPlayerIntel(request, ticketPlayerIntelMatch[1]);
    }

    const ticketMessagesMatch = pathname.match(
      /^\/api\/tickets\/(\d+)\/messages$/,
    );
    if (ticketMessagesMatch && request.method === "POST") {
      return handleAddTicketMessage(request, ticketMessagesMatch[1]);
    }

    const orgMembersMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/members$/,
    );
    if (orgMembersMatch && request.method === "POST") {
      return handleAddOrgMember(request, orgMembersMatch[1]);
    }
    if (orgMembersMatch && request.method === "GET") {
      return handleGetOrgMembers(request, orgMembersMatch[1]);
    }

    const orgStaffStatsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/staff-stats$/,
    );
    if (orgStaffStatsMatch && request.method === "GET") {
      return handleGetOrgStaffStats(request, orgStaffStatsMatch[1]);
    }

    const orgAdminsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/admins$/,
    );
    if (orgAdminsMatch && request.method === "POST") {
      return handleGrantOrgAdmin(request, orgAdminsMatch[1]);
    }

    const orgDiscordRolesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord-roles$/,
    );
    if (orgDiscordRolesMatch && request.method === "GET") {
      return handleGetOrgDiscordRoles(request, orgDiscordRolesMatch[1]);
    }

    const orgRolesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/roles$/,
    );
    if (orgRolesMatch && request.method === "GET") {
      return handleListOrgRoles(request, orgRolesMatch[1]);
    }
    if (orgRolesMatch && request.method === "POST") {
      return handleCreateOrgRole(request, orgRolesMatch[1]);
    }

    const orgRoleDetailMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/roles\/([a-zA-Z0-9_-]+)$/,
    );
    if (orgRoleDetailMatch && request.method === "PATCH") {
      return handleUpdateOrgRole(
        request,
        orgRoleDetailMatch[1],
        orgRoleDetailMatch[2],
      );
    }
    if (orgRoleDetailMatch && request.method === "DELETE") {
      return handleDeleteOrgRole(
        request,
        orgRoleDetailMatch[1],
        orgRoleDetailMatch[2],
      );
    }

    const orgMemberDetailMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/members\/([a-zA-Z0-9_-]+)$/,
    );
    if (orgMemberDetailMatch && request.method === "DELETE") {
      return handleRemoveOrgMember(
        request,
        orgMemberDetailMatch[1],
        orgMemberDetailMatch[2],
      );
    }
    if (orgMemberDetailMatch && request.method === "PATCH") {
      return handleUpdateOrgMemberTeam(
        request,
        orgMemberDetailMatch[1],
        orgMemberDetailMatch[2],
      );
    }

    const orgMemberImpersonateMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/members\/([a-zA-Z0-9_-]+)\/impersonate$/,
    );
    if (orgMemberImpersonateMatch && request.method === "POST") {
      return handleGetImpersonateViewOrgMember(
        request,
        orgMemberImpersonateMatch[1],
        orgMemberImpersonateMatch[2],
      );
    }

    const orgAuditLogsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/audit-logs$/,
    );
    if (orgAuditLogsMatch && request.method === "GET") {
      return handleGetStaffAuditLog(request, orgAuditLogsMatch[1]);
    }

    // Discord moderation routes
    const discordSyncMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/sync$/,
    );
    if (discordSyncMatch && request.method === "POST") {
      return handleDiscordSync(request, discordSyncMatch[1]);
    }

    const discordChannelsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/channels$/,
    );
    if (discordChannelsMatch && request.method === "GET") {
      return handleGetDiscordChannels(request, discordChannelsMatch[1]);
    }

    const discordMessagesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/messages$/,
    );
    if (discordMessagesMatch && request.method === "GET") {
      return handleGetDiscordMessages(request, discordMessagesMatch[1]);
    }

    const discordModMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/mod$/,
    );
    if (discordModMatch && request.method === "POST") {
      return handleDiscordModAction(request, discordModMatch[1]);
    }

    const discordModLogMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/mod-log$/,
    );
    if (discordModLogMatch && request.method === "GET") {
      return handleGetDiscordModLog(request, discordModLogMatch[1]);
    }

    const discordBansSyncMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/bans\/sync$/,
    );
    if (discordBansSyncMatch && request.method === "POST") {
      return handleSyncDiscordBans(request, discordBansSyncMatch[1]);
    }

    const discordBansMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/bans$/,
    );
    if (discordBansMatch && request.method === "GET") {
      return handleGetDiscordBans(request, discordBansMatch[1]);
    }

    const discordMembersMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/members$/,
    );
    if (discordMembersMatch && request.method === "GET") {
      return handleSearchDiscordMembers(request, discordMembersMatch[1]);
    }

    const orgTicketTypesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-types$/,
    );
    if (orgTicketTypesMatch && request.method === "GET") {
      return handleListOrgTicketTypes(request, orgTicketTypesMatch[1]);
    }

    const orgTicketTypeMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-types\/(\d+)$/,
    );
    if (orgTicketTypeMatch && request.method === "PATCH") {
      return handleUpdateOrgTicketType(
        request,
        orgTicketTypeMatch[1],
        parseInt(orgTicketTypeMatch[2]),
      );
    }

    const orgTicketsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/tickets$/,
    );
    if (orgTicketsMatch && request.method === "GET") {
      return handleListOrgTickets(request, orgTicketsMatch[1]);
    }

    const orgDetailsMatch = pathname.match(/^\/api\/orgs\/([a-zA-Z0-9_-]+)$/);
    if (orgDetailsMatch && request.method === "GET") {
      return handleGetOrgDetails(request, orgDetailsMatch[1]);
    }
    if (orgDetailsMatch && request.method === "PATCH") {
      return handleUpdateOrgDetails(request, orgDetailsMatch[1]);
    }

    if (pathname === "/api/roles" && request.method === "GET") {
      return handleListRoles(request);
    }

    if (pathname === "/api/roles" && request.method === "POST") {
      return handleCreateRole(request);
    }

    if (pathname === "/api/permissions" && request.method === "GET") {
      return handleListPermissions(request);
    }

    const rolePermissionsMatch = pathname.match(
      /^\/api\/roles\/([a-zA-Z0-9_-]+)\/permissions$/,
    );
    if (rolePermissionsMatch && request.method === "GET") {
      return handleGetRolePermissions(request, rolePermissionsMatch[1]);
    }
    if (rolePermissionsMatch && request.method === "PATCH") {
      return handleUpdateRolePermissions(request, rolePermissionsMatch[1]);
    }

    // Manage Org: pre-defines CRUD
    const orgPredefinesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/predefines$/,
    );
    if (orgPredefinesMatch && request.method === "GET")
      return handleListOrgPredefines(request, orgPredefinesMatch[1]);
    if (orgPredefinesMatch && request.method === "POST")
      return handleCreateOrgPredefine(request, orgPredefinesMatch[1]);

    const orgPredefineDetailMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/predefines\/([a-f0-9-]+)$/,
    );
    if (orgPredefineDetailMatch && request.method === "PATCH")
      return handleUpdateOrgPredefine(
        request,
        orgPredefineDetailMatch[1],
        orgPredefineDetailMatch[2],
      );
    if (orgPredefineDetailMatch && request.method === "DELETE")
      return handleDeleteOrgPredefine(
        request,
        orgPredefineDetailMatch[1],
        orgPredefineDetailMatch[2],
      );

    // Manage Org: toxicity phrases
    const orgToxicityMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/toxicity$/,
    );
    if (orgToxicityMatch && request.method === "GET")
      return handleGetOrgToxicity(request, orgToxicityMatch[1]);
    if (orgToxicityMatch && request.method === "PATCH")
      return handleSetOrgToxicity(request, orgToxicityMatch[1]);

    // Manage Org: ban/mute configs
    const orgBanConfigsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ban-configs$/,
    );
    if (orgBanConfigsMatch && request.method === "GET")
      return handleGetOrgBanConfigs(request, orgBanConfigsMatch[1]);

    const orgBanReasonsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ban-configs\/reasons$/,
    );
    if (orgBanReasonsMatch && request.method === "POST")
      return handleCreateBanReason(request, orgBanReasonsMatch[1]);

    const orgBanReasonDetailMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ban-configs\/reasons\/([a-f0-9-]+)$/,
    );
    if (orgBanReasonDetailMatch && request.method === "PATCH")
      return handleUpdateBanReason(
        request,
        orgBanReasonDetailMatch[1],
        orgBanReasonDetailMatch[2],
      );
    if (orgBanReasonDetailMatch && request.method === "DELETE")
      return handleDeleteBanReason(
        request,
        orgBanReasonDetailMatch[1],
        orgBanReasonDetailMatch[2],
      );

    const orgBanNoteMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ban-configs\/note$/,
    );
    if (orgBanNoteMatch && request.method === "PUT")
      return handleSetBanNoteFormat(request, orgBanNoteMatch[1]);

    // Player bans / mutes
    const orgBansMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bans$/,
    );
    if (orgBansMatch && request.method === "GET")
      return handleListOrgBans(request, orgBansMatch[1]);
    if (orgBansMatch && request.method === "POST")
      return handleCreateBan(request, orgBansMatch[1]);

    const orgBanDetailMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bans\/([a-f0-9-]+)$/,
    );
    if (orgBanDetailMatch && request.method === "PATCH")
      return handleUpdateBan(
        request,
        orgBanDetailMatch[1],
        orgBanDetailMatch[2],
      );
    if (orgBanDetailMatch && request.method === "DELETE")
      return handleRevokeBan(
        request,
        orgBanDetailMatch[1],
        orgBanDetailMatch[2],
      );

    // Scripts CRUD
    const orgScriptsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/scripts$/,
    );
    if (orgScriptsMatch && request.method === "GET")
      return handleListScripts(request, orgScriptsMatch[1]);
    if (orgScriptsMatch && request.method === "POST")
      return handleCreateScript(request, orgScriptsMatch[1]);

    const orgScriptMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/scripts\/([a-f0-9-]+)$/,
    );
    if (orgScriptMatch && request.method === "PATCH")
      return handleUpdateScript(request, orgScriptMatch[1], orgScriptMatch[2]);
    if (orgScriptMatch && request.method === "DELETE")
      return handleDeleteScript(request, orgScriptMatch[1], orgScriptMatch[2]);

    // Plugin presets CRUD
    const orgPluginsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/plugins$/,
    );
    if (orgPluginsMatch && request.method === "GET")
      return handleListPlugins(request, orgPluginsMatch[1]);
    if (orgPluginsMatch && request.method === "POST")
      return handleCreatePlugin(request, orgPluginsMatch[1]);

    const orgPluginUnloadRiskMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/plugins\/unload-risk$/,
    );
    if (orgPluginUnloadRiskMatch && request.method === "POST")
      return handleUnloadRisk(request, orgPluginUnloadRiskMatch[1]);

    const orgPluginPushMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/plugins\/([a-f0-9-]+)\/push$/,
    );
    if (orgPluginPushMatch && request.method === "POST")
      return handlePluginPush(
        request,
        orgPluginPushMatch[1],
        orgPluginPushMatch[2],
      );

    const orgPluginMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/plugins\/([a-f0-9-]+)$/,
    );
    if (orgPluginMatch && request.method === "PATCH")
      return handleUpdatePlugin(request, orgPluginMatch[1], orgPluginMatch[2]);
    if (orgPluginMatch && request.method === "DELETE")
      return handleDeletePlugin(request, orgPluginMatch[1], orgPluginMatch[2]);

    if (pathname === "/api/servers" && request.method === "GET") {
      return handleListServers(request);
    }
    if (pathname === "/api/servers" && request.method === "POST") {
      return handleRegisterServer(request);
    }

    const serverIdMatch = pathname.match(/^\/api\/servers\/([a-f0-9-]+)$/);
    if (serverIdMatch && request.method === "DELETE") {
      return handleDeleteServer(request, serverIdMatch[1]);
    }
    const serverRotateMatch = pathname.match(
      /^\/api\/servers\/([a-f0-9-]+)\/rotate-key$/,
    );
    if (serverRotateMatch && request.method === "POST") {
      return handleRotateServerKey(request, serverRotateMatch[1]);
    }

    // Plugin Configs via Pterodactyl
    const serverPteroPluginsMatch = pathname.match(
      /^\/api\/servers\/([a-f0-9-]+)\/ptero-plugins$/,
    );
    if (serverPteroPluginsMatch && request.method === "GET")
      return handleListPteroPlugins(request, serverPteroPluginsMatch[1]);

    const serverPteroPluginCmdMatch = pathname.match(
      /^\/api\/servers\/([a-f0-9-]+)\/ptero-plugin-cmd$/,
    );
    if (serverPteroPluginCmdMatch && request.method === "POST")
      return handlePteroPluginCmd(request, serverPteroPluginCmdMatch[1]);

    const serverPteroConfigMatch = pathname.match(
      /^\/api\/servers\/([a-f0-9-]+)\/ptero-plugin-config\/([^/]+)$/,
    );
    if (serverPteroConfigMatch && request.method === "GET")
      return handleGetPteroPluginConfig(
        request,
        serverPteroConfigMatch[1],
        decodeURIComponent(serverPteroConfigMatch[2]),
      );
    if (serverPteroConfigMatch && request.method === "POST")
      return handleSavePteroPluginConfig(
        request,
        serverPteroConfigMatch[1],
        decodeURIComponent(serverPteroConfigMatch[2]),
      );

    const orgPluginBulkDeleteMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ptero-plugin-bulk-delete$/,
    );
    if (orgPluginBulkDeleteMatch && request.method === "POST")
      return handleBulkDeletePteroPlugin(request, orgPluginBulkDeleteMatch[1]);

    const orgPluginUploadMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ptero-plugin-upload$/,
    );
    if (orgPluginUploadMatch && request.method === "POST")
      return handleBulkUploadPteroPlugin(request, orgPluginUploadMatch[1]);

    // Server RCON
    const serverRconMatch = pathname.match(
      /^\/api\/servers\/([a-f0-9-]+)\/rcon$/,
    );
    if (serverRconMatch && request.method === "GET")
      return handleGetServerRconStatus(request, serverRconMatch[1]);
    if (serverRconMatch && request.method === "PATCH")
      return handleSetServerRcon(request, serverRconMatch[1]);

    const serverRconExecMatch = pathname.match(
      /^\/api\/servers\/([a-f0-9-]+)\/rcon\/exec$/,
    );
    if (serverRconExecMatch && request.method === "POST")
      return handleExecRconCommand(request, serverRconExecMatch[1]);

    const orgPteroMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ptero$/,
    );
    if (orgPteroMatch && request.method === "GET") {
      return handleGetPteroKey(request, orgPteroMatch[1]);
    }
    if (orgPteroMatch && request.method === "POST") {
      return handleSavePteroKey(request, orgPteroMatch[1]);
    }
    if (orgPteroMatch && request.method === "DELETE") {
      return handleDeletePteroKey(request, orgPteroMatch[1]);
    }

    const orgPteroServersMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ptero\/servers$/,
    );
    if (orgPteroServersMatch && request.method === "GET") {
      return handleListPteroServers(request, orgPteroServersMatch[1]);
    }

    const orgPteroStatusMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ptero\/status$/,
    );
    if (orgPteroStatusMatch && request.method === "GET") {
      return handleGetPteroStatus(request, orgPteroStatusMatch[1]);
    }

    const orgPteroImportMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ptero\/servers\/import$/,
    );
    if (orgPteroImportMatch && request.method === "POST") {
      return handleImportPteroServer(request, orgPteroImportMatch[1]);
    }

    const orgPteroWsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ptero\/servers\/([a-zA-Z0-9]+)\/websocket$/,
    );
    if (orgPteroWsMatch && request.method === "GET") {
      return handleGetPteroServerWebsocket(
        request,
        orgPteroWsMatch[1],
        orgPteroWsMatch[2],
      );
    }

    if (pathname === "/api/server-health-check" && request.method === "GET") {
      return handleServerHealthCheck(request);
    }

    if (pathname === "/api/ingest/connect" && request.method === "POST")
      return handleIngestPlayerConnect(request);

    if (pathname === "/api/ingest/chat" && request.method === "POST") {
      return handleIngestChatMessage(request);
    }

    if (pathname === "/api/chat/logs" && request.method === "GET") {
      return handleGetChatLogs(request);
    }

    if (pathname === "/api/ingest/pvp" && request.method === "POST") {
      return handleIngestPvp(request);
    }

    if (pathname === "/api/pvp/logs" && request.method === "GET") {
      return handleGetPvpLogs(request);
    }

    if (pathname === "/api/ingest/reports" && request.method === "POST") {
      return handleIngestReport(request);
    }

    if (pathname === "/api/reports/logs" && request.method === "GET") {
      return handleGetReports(request);
    }

    if (pathname === "/api/teaminfo") {
      if (request.method === "POST") return handleIngestTeamEvent(request);
      if (request.method === "GET") return handleGetTeamEvents(request);
    }

    if (pathname === "/api/mute-check" && request.method === "GET")
      return handleMuteCheck(request);

    if (pathname === "/api/ingest/mute-sync" && request.method === "POST")
      return handleIngestMuteSync(request);

    if (pathname === "/api/blacklisted-words" && request.method === "GET")
      return handleGetBlacklistedWordsForServer(request);

    // External API key rate limit stats
    const orgExternalKeyStatsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/external-keys\/stats$/,
    );
    if (orgExternalKeyStatsMatch && request.method === "GET")
      return handleGetExternalKeyStats(request, orgExternalKeyStatsMatch[1]);

    // External API keys (BM / Steam / Proxycheck) per org
    const orgExternalKeysMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/external-keys$/,
    );
    if (orgExternalKeysMatch && request.method === "GET")
      return handleListExternalKeys(request, orgExternalKeysMatch[1]);
    if (orgExternalKeysMatch && request.method === "POST")
      return handleAddExternalKey(request, orgExternalKeysMatch[1]);

    const orgExternalKeyDetailMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/external-keys\/([a-f0-9-]+)$/,
    );
    if (orgExternalKeyDetailMatch && request.method === "PATCH")
      return handleUpdateExternalKey(
        request,
        orgExternalKeyDetailMatch[1],
        orgExternalKeyDetailMatch[2],
      );
    if (orgExternalKeyDetailMatch && request.method === "DELETE")
      return handleDeleteExternalKey(
        request,
        orgExternalKeyDetailMatch[1],
        orgExternalKeyDetailMatch[2],
      );

    // RIPE Atlas network monitoring
    const orgRipeAtlasConfigMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ripe-atlas\/config$/,
    );
    if (orgRipeAtlasConfigMatch) {
      if (request.method === "GET")
        return handleGetRipeAtlasConfig(request, orgRipeAtlasConfigMatch[1]);
      if (request.method === "PUT")
        return handlePutRipeAtlasConfig(request, orgRipeAtlasConfigMatch[1]);
      if (request.method === "DELETE")
        return handleDeleteRipeAtlasConfig(request, orgRipeAtlasConfigMatch[1]);
    }

    const orgRipeAtlasResultsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ripe-atlas\/results$/,
    );
    if (orgRipeAtlasResultsMatch && request.method === "GET")
      return handleGetRipeAtlasResults(request, orgRipeAtlasResultsMatch[1]);

    // Blacklisted words (management UI)
    const orgBlacklistedWordsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/blacklisted-words$/,
    );
    if (orgBlacklistedWordsMatch && request.method === "GET")
      return handleGetBlacklistedWords(request, orgBlacklistedWordsMatch[1]);
    if (orgBlacklistedWordsMatch && request.method === "POST")
      return handleAddBlacklistedWord(request, orgBlacklistedWordsMatch[1]);

    const orgBlacklistedWordDetailMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/blacklisted-words\/([a-f0-9-]+)$/,
    );
    if (orgBlacklistedWordDetailMatch && request.method === "DELETE")
      return handleDeleteBlacklistedWord(
        request,
        orgBlacklistedWordDetailMatch[1],
        orgBlacklistedWordDetailMatch[2],
      );

    // Public server list (for ticket submission portal — no auth required)
    const orgPublicServersMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/public-servers$/,
    );
    if (orgPublicServersMatch && request.method === "GET")
      return handleListPublicOrgServers(request, orgPublicServersMatch[1]);

    // Org player search (for ticket submission)
    const orgPlayerSearchMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/players\/search$/,
    );
    if (orgPlayerSearchMatch && request.method === "GET")
      return handleSearchOrgPlayers(request, orgPlayerSearchMatch[1]);

    // Org player list
    const orgPlayerListMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/player-list$/,
    );
    if (orgPlayerListMatch && request.method === "GET")
      return handleGetOrgPlayerList(request, orgPlayerListMatch[1]);

    // Player lookup
    const playerMatch = pathname.match(/^\/api\/players\/(\d+)$/);
    if (playerMatch && request.method === "GET")
      return handleGetPlayer(request, playerMatch[1]);

    const playerRefreshMatch = pathname.match(
      /^\/api\/players\/(\d+)\/refresh$/,
    );
    if (playerRefreshMatch && request.method === "POST")
      return handleRefreshPlayer(request, playerRefreshMatch[1]);

    // Sysadmin: clear all player cache
    if (pathname === "/api/admin/player-cache" && request.method === "DELETE")
      return handleClearAllPlayerCache(request);

    // Player reports
    const playerReportsMatch = pathname.match(
      /^\/api\/players\/(\d+)\/reports$/,
    );
    if (playerReportsMatch && request.method === "GET")
      return handleGetPlayerReports(request, playerReportsMatch[1]);

    return json({ error: "Not found" }, 404);
  });
}

// ── Discord moderation helpers ────────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";

function discordBotHeaders(hasBody = false) {
  const headers = {
    Authorization: `Bot ${env.discordBotToken}`,
  };

  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

async function discordFetch(path, opts = {}) {
  return fetch(`${DISCORD_API}${path}`, {
    ...opts,
    headers: {
      ...discordBotHeaders(!!opts.body),
      ...(opts.headers ?? {}),
    },
  });
}

async function getGuildRoles(guildId) {
  if (!env.discordBotToken || !guildId) return [];

  const cacheKey = `discord:roles:${guildId}`;
  try {
    const cached = await redis?.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {}

  try {
    const res = await discordFetch(`/guilds/${guildId}/roles`);
    if (!res.ok) return [];
    const roles = await res.json();
    const result = Array.isArray(roles) ? roles : [];
    try { await redis?.set(cacheKey, JSON.stringify(result), "EX", 300); } catch {}
    return result;
  } catch {
    return [];
  }
}

async function addDiscordRoleToMember(guildId, discordUserId, discordRoleId) {
  if (!env.discordBotToken || !guildId || !discordUserId || !discordRoleId)
    return;
  try {
    await discordFetch(
      `/guilds/${guildId}/members/${discordUserId}/roles/${discordRoleId}`,
      { method: "PUT" },
    );
  } catch {
    // Best-effort — don't fail the operation if Discord is unreachable
  }
}

async function removeDiscordRoleFromMember(
  guildId,
  discordUserId,
  discordRoleId,
) {
  if (!env.discordBotToken || !guildId || !discordUserId || !discordRoleId)
    return;
  try {
    await discordFetch(
      `/guilds/${guildId}/members/${discordUserId}/roles/${discordRoleId}`,
      { method: "DELETE" },
    );
  } catch {
    // Best-effort
  }
}

async function getDiscordRoleIdsForRole(roleId) {
  const { rows } = await pool.query(
    `SELECT discord_role_id FROM role_discord_roles WHERE role_id = $1`,
    [roleId],
  );
  return rows.map((r) => r.discord_role_id);
}

async function syncDiscordRolesOnRoleChange(
  guildId,
  discordUserId,
  oldRoleId,
  newRoleId,
) {
  if (!guildId || !discordUserId) return;
  const [oldIds, newIds] = await Promise.all([
    getDiscordRoleIdsForRole(oldRoleId),
    getDiscordRoleIdsForRole(newRoleId),
  ]);
  const toRemove = oldIds.filter((id) => !newIds.includes(id));
  const toAdd = newIds.filter((id) => !oldIds.includes(id));
  await Promise.all([
    ...toRemove.map((id) =>
      removeDiscordRoleFromMember(guildId, discordUserId, id),
    ),
    ...toAdd.map((id) => addDiscordRoleToMember(guildId, discordUserId, id)),
  ]);
}

async function removeAllDiscordRolesForRole(guildId, discordUserId, roleId) {
  if (!guildId || !discordUserId) return;
  const ids = await getDiscordRoleIdsForRole(roleId);
  await Promise.all(
    ids.map((id) => removeDiscordRoleFromMember(guildId, discordUserId, id)),
  );
}

async function handleGetOrgDiscordRoles(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  // Used both by Discord moderation and by the role editor (to link Discord
  // roles to custom roles), so either permission grants read access.
  if (
    !orgHasPermission(session, orgId, "discord_mod") &&
    !orgHasPermission(session, orgId, "role_create")
  ) {
    return json(
      { error: "Forbidden: discord_mod or role_create permission required" },
      403,
    );
  }

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org) return json({ error: "Organization not found" }, 404);

  const roles = await getGuildRoles(org.guild_id);
  return json({
    discordRoles: roles
      .filter((r) => !r.managed && r.name !== "@everyone")
      .map((r) => ({ id: r.id, name: r.name, color: r.color }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

async function getGuildTextChannels(guildId) {
  if (!env.discordBotToken || !guildId) return [];

  const cacheKey = `discord:channels:${guildId}`;
  try {
    const cached = await redis?.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {}

  try {
    const res = await discordFetch(`/guilds/${guildId}/channels`);
    if (!res.ok) return [];
    const channels = await res.json();
    // type 0 = GUILD_TEXT, type 5 = GUILD_ANNOUNCEMENT
    const result = channels
      .filter((c) => c.type === 0 || c.type === 5)
      .map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position ?? 0,
        permission_overwrites: c.permission_overwrites ?? [],
      }))
      .sort((a, b) => a.position - b.position);
    try { await redis?.set(cacheKey, JSON.stringify(result), "EX", 300); } catch {}
    return result;
  } catch {
    return [];
  }
}

const VIEW_CHANNEL_BIT = BigInt(1024);

function channelVisibleToRoles(channel, userRoleIds, guildId) {
  const overwrites = channel.permission_overwrites ?? [];
  let everyoneDeny = false;
  let everyoneAllow = false;
  let roleDeny = false;
  let roleAllow = false;
  for (const ow of overwrites) {
    if (ow.type !== 0) continue; // only role overwrites
    const allow = BigInt(ow.allow ?? "0");
    const deny = BigInt(ow.deny ?? "0");
    if (ow.id === guildId) {
      if (deny & VIEW_CHANNEL_BIT) everyoneDeny = true;
      if (allow & VIEW_CHANNEL_BIT) everyoneAllow = true;
    } else if (userRoleIds.has(ow.id)) {
      if (deny & VIEW_CHANNEL_BIT) roleDeny = true;
      if (allow & VIEW_CHANNEL_BIT) roleAllow = true;
    }
  }
  if (roleDeny) return false;
  if (roleAllow) return true;
  if (everyoneAllow) return true;
  if (everyoneDeny) return false;
  return true;
}

async function syncChannelMessages(orgId, guildId, channelId, channelName) {
  const syncRes = await pool.query(
    `SELECT last_message_id FROM discord_channel_sync WHERE org_id = $1 AND channel_id = $2`,
    [orgId, channelId],
  );
  const lastMessageId = syncRes.rows[0]?.last_message_id ?? null;

  const params = new URLSearchParams({ limit: "100" });
  if (lastMessageId) params.set("after", lastMessageId);

  const res = await discordFetch(`/channels/${channelId}/messages?${params}`);
  if (!res.ok) return 0;

  const messages = await res.json();
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const toInsert = messages.filter((msg) => msg.author && !msg.author.bot);
  if (toInsert.length > 0) {
    const cols = 10;
    const valuePlaceholders = toInsert
      .map((_, i) => `(${Array.from({ length: cols }, (__, c) => `$${i * cols + c + 1}`).join(",")})`)
      .join(",");
    const flatParams = toInsert.flatMap((msg) => [
      msg.id,
      orgId,
      guildId,
      channelId,
      channelName,
      msg.author.id,
      msg.author.global_name ?? msg.author.username,
      msg.content ?? "",
      JSON.stringify(msg.attachments ?? []),
      Math.floor(new Date(msg.timestamp).getTime() / 1000),
    ]);
    await pool.query(
      `INSERT INTO discord_messages
         (message_id, org_id, guild_id, channel_id, channel_name,
          author_discord_id, author_username, content, attachments, discord_created_at)
       VALUES ${valuePlaceholders}
       ON CONFLICT (org_id, message_id) DO NOTHING`,
      flatParams,
    );
  }

  // Keep the highest snowflake as last_message_id
  const newestId = messages.reduce(
    (max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max),
    lastMessageId ?? "0",
  );

  await pool.query(
    `INSERT INTO discord_channel_sync
       (org_id, channel_id, guild_id, channel_name, last_message_id, synced_at)
     VALUES ($1,$2,$3,$4,$5,unix_now())
     ON CONFLICT (org_id, channel_id) DO UPDATE SET
       last_message_id = EXCLUDED.last_message_id,
       channel_name = EXCLUDED.channel_name,
       synced_at = unix_now()`,
    [orgId, channelId, guildId, channelName, newestId],
  );

  return messages.length;
}

async function pruneOldDiscordMessages() {
  await pool.query(
    `DELETE FROM discord_messages WHERE indexed_at < unix_now() - 2592000`,
  );
}

// ── Discord API route handlers ────────────────────────────────────────────────

async function handleDiscordSync(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "discord_mod")) {
    return json({ error: "Forbidden: discord_mod permission required" }, 403);
  }

  if (!env.discordBotToken) {
    return json({ error: "DISCORD_BOT_TOKEN is not configured" }, 503);
  }

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) {
    return json({ error: "Organization has no guild_id configured" }, 400);
  }

  await pruneOldDiscordMessages();

  const channels = await getGuildTextChannels(org.guild_id);
  let totalSynced = 0;
  const results = [];
  for (const ch of channels) {
    const count = await syncChannelMessages(orgId, org.guild_id, ch.id, ch.name);
    totalSynced += count;
    results.push({ channelId: ch.id, channelName: ch.name, synced: count });
  }

  return json({ ok: true, totalSynced, channels: results });
}

async function handleGetDiscordChannels(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "discord_mod")) {
    return json({ error: "Forbidden: discord_mod permission required" }, 403);
  }

  if (!env.discordBotToken) {
    return json({ error: "DISCORD_BOT_TOKEN is not configured" }, 503);
  }

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) return json({ channels: [] });

  const allChannels = await getGuildTextChannels(org.guild_id);

  // Fetch the session user's guild roles to filter channel visibility
  const userRoleIds = new Set([org.guild_id]); // @everyone = guildId
  if (session.discordId) {
    try {
      const memberRes = await discordFetch(
        `/guilds/${org.guild_id}/members/${session.discordId}`,
      );
      if (memberRes.ok) {
        const member = await memberRes.json();
        (member.roles ?? []).forEach((r) => userRoleIds.add(r));
      }
    } catch {}
  }

  const visibleApiChannels = allChannels.filter((c) =>
    channelVisibleToRoles(c, userRoleIds, org.guild_id),
  );

  // Include channels the bot has already ingested messages for, even if the
  // Discord REST API call failed or hasn't been synced yet.
  const dbChannelRes = await pool.query(
    `SELECT DISTINCT ON (channel_id) channel_id, channel_name
     FROM discord_messages WHERE org_id = $1`,
    [orgId],
  );
  const apiChannelIds = new Set(visibleApiChannels.map((c) => c.id));
  const dbOnlyChannels = dbChannelRes.rows
    .filter((r) => !apiChannelIds.has(r.channel_id))
    .map((r) => ({ id: r.channel_id, name: r.channel_name }));

  const channels = [...visibleApiChannels, ...dbOnlyChannels];

  const syncRes = await pool.query(
    `SELECT channel_id, channel_name, synced_at FROM discord_channel_sync WHERE org_id = $1`,
    [orgId],
  );
  const syncMap = Object.fromEntries(syncRes.rows.map((r) => [r.channel_id, r]));

  return json({
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      syncedAt: syncMap[c.id]?.synced_at ?? null,
    })),
  });
}

async function handleIngestDiscordMessage(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  if (
    !env.discordBotToken ||
    authHeader !== `Bot ${env.discordBotToken}`
  ) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { messageId, guildId, channelId, channelName, authorId, authorUsername, content, attachments, timestamp } = body ?? {};
  if (!messageId || !guildId || !channelId || !authorId) {
    return json({ error: "Missing required fields" }, 400);
  }

  const orgRes = await pool.query(
    `SELECT org_id FROM organizations WHERE guild_id = $1 LIMIT 1`,
    [String(guildId)],
  );
  if (!orgRes.rows[0]) return json({ ok: false, reason: "no org" });
  const orgId = orgRes.rows[0].org_id;

  const createdAt = timestamp
    ? Math.floor(new Date(timestamp).getTime() / 1000)
    : nowUnix();

  await pool.query(
    `INSERT INTO discord_messages
       (message_id, org_id, guild_id, channel_id, channel_name,
        author_discord_id, author_username, content, attachments, discord_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (org_id, message_id) DO NOTHING`,
    [
      String(messageId),
      orgId,
      String(guildId),
      String(channelId),
      String(channelName ?? ""),
      String(authorId),
      String(authorUsername ?? ""),
      String(content ?? ""),
      JSON.stringify(Array.isArray(attachments) ? attachments : []),
      createdAt,
    ],
  );

  return json({ ok: true });
}

async function handleGetDiscordMessages(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "discord_mod")) {
    return json({ error: "Forbidden: discord_mod permission required" }, 403);
  }

  await pruneOldDiscordMessages();

  const url = new URL(request.url);
  const channelId = url.searchParams.get("channel_id") ?? null;
  const authorId = url.searchParams.get("author_id") ?? null;
  const before = url.searchParams.get("before") ?? null;
  const after = url.searchParams.get("after") ?? null;
  const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));

  const conditions = ["org_id = $1"];
  const params = [orgId];
  let idx = 2;

  if (channelId) {
    conditions.push(`channel_id = $${idx++}`);
    params.push(channelId);
  }
  if (authorId) {
    conditions.push(`author_discord_id = $${idx++}`);
    params.push(authorId);
  }
  if (before) {
    conditions.push(`discord_created_at < $${idx++}`);
    params.push(before);
  }
  if (after) {
    conditions.push(`discord_created_at > $${idx++}`);
    params.push(after);
  }

  const { rows } = await pool.query(
    `SELECT message_id, channel_id, channel_name, author_discord_id, author_username,
            content, attachments, discord_created_at
     FROM discord_messages
     WHERE ${conditions.join(" AND ")}
     ORDER BY discord_created_at DESC
     LIMIT $${idx}`,
    [...params, limit],
  );

  return json({
    messages: rows.map((r) => ({
      id: r.message_id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      authorDiscordId: r.author_discord_id,
      authorUsername: r.author_username,
      content: r.content,
      attachments: r.attachments,
      createdAt: r.discord_created_at,
    })),
  });
}

async function handleDiscordModAction(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "discord_mod")) {
    return json({ error: "Forbidden: discord_mod permission required" }, 403);
  }

  if (!env.discordBotToken) {
    return json({ error: "DISCORD_BOT_TOKEN is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body?.action ?? "").trim().toLowerCase();
  const targetDiscordId = String(body?.targetDiscordId ?? "").trim();
  const targetUsername = String(body?.targetUsername ?? "").trim();
  const reason = body?.reason ? String(body.reason).trim() : null;
  const durationSeconds = body?.durationSeconds ? parseInt(body.durationSeconds, 10) : null;

  const VALID_ACTIONS = ["timeout", "untimeout", "mute", "unmute", "kick", "ban", "unban"];
  if (!VALID_ACTIONS.includes(action)) {
    return json({ error: `action must be one of: ${VALID_ACTIONS.join(", ")}` }, 400);
  }
  if (!targetDiscordId) {
    return json({ error: "targetDiscordId is required" }, 400);
  }
  if (action === "timeout" && (!durationSeconds || durationSeconds <= 0)) {
    return json({ error: "durationSeconds required for timeout" }, 400);
  }

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) {
    return json({ error: "Organization has no guild_id configured" }, 400);
  }

  const guildId = org.guild_id;
  let discordRes;

  switch (action) {
    case "timeout": {
      const until = new Date(Date.now() + durationSeconds * 1000).toISOString();
      discordRes = await discordFetch(`/guilds/${guildId}/members/${targetDiscordId}`, {
        method: "PATCH",
        body: JSON.stringify({ communication_disabled_until: until }),
      });
      break;
    }
    case "untimeout": {
      discordRes = await discordFetch(`/guilds/${guildId}/members/${targetDiscordId}`, {
        method: "PATCH",
        body: JSON.stringify({ communication_disabled_until: null }),
      });
      break;
    }
    case "mute": {
      discordRes = await discordFetch(`/guilds/${guildId}/members/${targetDiscordId}`, {
        method: "PATCH",
        body: JSON.stringify({ mute: true }),
      });
      break;
    }
    case "unmute": {
      discordRes = await discordFetch(`/guilds/${guildId}/members/${targetDiscordId}`, {
        method: "PATCH",
        body: JSON.stringify({ mute: false }),
      });
      break;
    }
    case "kick": {
      discordRes = await discordFetch(`/guilds/${guildId}/members/${targetDiscordId}`, {
        method: "DELETE",
      });
      break;
    }
    case "ban": {
      discordRes = await discordFetch(`/guilds/${guildId}/bans/${targetDiscordId}`, {
        method: "PUT",
        body: JSON.stringify({ delete_message_seconds: 0 }),
      });
      if (discordRes.ok || discordRes.status === 204) {
        // Delete messages from Discord (visible to others) but keep them in our DB
        deleteUserDiscordMessagesFromGuild(guildId, orgId, targetDiscordId).catch(
          () => {},
        );
      }
      break;
    }
    case "unban": {
  discordRes = await discordFetch(
    `/guilds/${guildId}/bans/${targetDiscordId}`,
    {
      method: "DELETE",
    }
  );

  console.log("UNBAN STATUS:", discordRes.status);

  try {
    console.log("UNBAN BODY:", await discordRes.clone().text());
  } catch (e) {
    console.log("UNBAN BODY ERROR:", e);
  }

  break;
}
  }

  if (discordRes && !discordRes.ok && discordRes.status !== 204) {
    // Unbanning someone not currently banned is a no-op success
    if (action === "unban" && discordRes.status === 404) {
      // fall through to log and return ok
    } else {
      let discordError = null;
      try {
        discordError = await discordRes.json();
      } catch { /* empty */ }
      return json(
        { error: "Discord API error", details: discordError, status: discordRes.status },
        502,
      );
    }
  }

  const expiresAt =
    action === "timeout" && durationSeconds
      ? Math.floor(Date.now() / 1000) + durationSeconds
      : null;

  await pool.query(
    `INSERT INTO discord_mod_log
       (org_id, guild_id, target_discord_id, target_username,
        action_type, reason, duration_seconds, expires_at, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      orgId,
      guildId,
      targetDiscordId,
      targetUsername,
      action.toUpperCase(),
      reason,
      durationSeconds,
      expiresAt,
      session.userId,
    ],
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "discord_member",
    resourceId: targetDiscordId,
    actionType: `DISCORD_${action.toUpperCase()}`,
    actionCategory: "discord_moderation",
    severity: action === "ban" || action === "kick" ? 3 : 2,
    metadata: { targetDiscordId, targetUsername, reason, durationSeconds },
  });

  return json({ ok: true, action, targetDiscordId });
}

async function deleteUserDiscordMessagesFromGuild(guildId, orgId, discordUserId) {
  if (!env.discordBotToken || !guildId || !discordUserId) return;

  const { rows } = await pool.query(
    `SELECT message_id, channel_id, discord_created_at
     FROM discord_messages
     WHERE org_id = $1 AND guild_id = $2 AND author_discord_id = $3
     ORDER BY channel_id, discord_created_at ASC`,
    [orgId, guildId, discordUserId],
  );

  if (rows.length === 0) return;

  const cutoff = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;

  // Group by channel
  const byChannel = new Map();
  for (const row of rows) {
    if (!byChannel.has(row.channel_id)) byChannel.set(row.channel_id, []);
    byChannel.get(row.channel_id).push(row);
  }

  for (const [channelId, messages] of byChannel) {
    const recent = messages
      .filter((m) => Number(m.discord_created_at) >= cutoff)
      .map((m) => m.message_id);
    const old = messages
      .filter((m) => Number(m.discord_created_at) < cutoff)
      .map((m) => m.message_id);

    // Bulk delete in batches of 100 (Discord minimum is 2)
    for (let i = 0; i < recent.length; i += 100) {
      const batch = recent.slice(i, i + 100);
      if (batch.length === 1) {
        // Bulk-delete requires >= 2; fall back to single delete
        await discordFetch(`/channels/${channelId}/messages/${batch[0]}`, {
          method: "DELETE",
        }).catch(() => {});
      } else {
        await discordFetch(`/channels/${channelId}/messages/bulk-delete`, {
          method: "POST",
          body: JSON.stringify({ messages: batch }),
        }).catch(() => {});
      }
    }

    // Older messages must be deleted individually (Discord restriction)
    for (const messageId of old) {
      await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }
}

async function fetchAllDiscordBans(guildId) {
  const allBans = [];
  let after = undefined;
  while (true) {
    const params = new URLSearchParams({ limit: "1000" });
    if (after) params.set("after", after);
    const res = await discordFetch(`/guilds/${guildId}/bans?${params}`);
    if (!res.ok) break;
    const bans = await res.json();
    if (!Array.isArray(bans) || bans.length === 0) break;
    allBans.push(...bans);
    if (bans.length < 1000) break;
    after = bans[bans.length - 1].user.id;
  }
  return allBans;
}

async function handleGetDiscordBans(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "discord_mod"))
    return json({ error: "Forbidden: discord_mod permission required" }, 403);
  if (!env.discordBotToken) return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) return json({ error: "Organization has no guild_id configured" }, 400);

  const allBans = await fetchAllDiscordBans(org.guild_id);

  // Determine which bans are already in our log and whether they were panel-issued or external
  const { rows: logged } = await pool.query(
    `SELECT DISTINCT ON (target_discord_id)
            target_discord_id, actor_user_id
     FROM discord_mod_log
     WHERE org_id = $1 AND action_type = 'BAN'
     ORDER BY target_discord_id, created_at DESC`,
    [orgId],
  );
  const logMap = new Map(logged.map((r) => [r.target_discord_id, r]));

  return json({
    bans: allBans.map((b) => {
      const log = logMap.get(b.user.id);
      return {
        discordUserId: b.user.id,
        username: b.user.global_name ?? b.user.username,
        reason: b.reason ?? null,
        source: log ? (log.actor_user_id ? "panel" : "external") : "external",
      };
    }),
  });
}

async function handleSyncDiscordBans(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "discord_mod"))
    return json({ error: "Forbidden: discord_mod permission required" }, 403);
  if (!env.discordBotToken) return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) return json({ error: "Organization has no guild_id configured" }, 400);

  const allBans = await fetchAllDiscordBans(org.guild_id);

  // Latest known action per discord user (to detect unbanned-then-rebanned externally)
  const { rows: latest } = await pool.query(
    `SELECT DISTINCT ON (target_discord_id)
            target_discord_id, action_type
     FROM discord_mod_log
     WHERE org_id = $1
     ORDER BY target_discord_id, created_at DESC`,
    [orgId],
  );
  const latestAction = new Map(latest.map((r) => [r.target_discord_id, r.action_type]));

  let synced = 0;
  for (const ban of allBans) {
    const discordId = ban.user.id;
    const last = latestAction.get(discordId);
    if (!last || last !== "BAN") {
      await pool.query(
        `INSERT INTO discord_mod_log
           (org_id, guild_id, target_discord_id, target_username, action_type, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, 'BAN', $5, NULL)`,
        [
          orgId,
          org.guild_id,
          discordId,
          ban.user.global_name ?? ban.user.username,
          ban.reason ?? null,
        ],
      );
      synced++;
    }
  }

  return json({ ok: true, synced });
}

async function handleSearchDiscordMembers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "discord_mod"))
    return json({ error: "Forbidden: discord_mod permission required" }, 403);
  if (!env.discordBotToken) return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) return json({ error: "Organization has no guild_id configured" }, 400);

  const url = new URL(request.url);
  const query = (url.searchParams.get("query") ?? "").trim();
  if (!query) return json({ members: [] });

  const params = new URLSearchParams({ query, limit: "25" });
  const res = await discordFetch(
    `/guilds/${org.guild_id}/members/search?${params}`,
  );
  if (!res.ok) return json({ members: [] });

  const members = await res.json();
  return json({
    members: Array.isArray(members)
      ? members.map((m) => ({
          discordId: m.user.id,
          username: m.user.global_name ?? m.user.username,
          nickname: m.nick ?? null,
          avatar: m.user.avatar
            ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64`
            : null,
        }))
      : [],
  });
}

async function handleGetDiscordModLog(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "discord_mod")) {
    return json({ error: "Forbidden: discord_mod permission required" }, 403);
  }

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 50));
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset"))) || 0);
  const targetId = url.searchParams.get("target_discord_id") ?? null;

  const conditions = ["ml.org_id = $1"];
  const params = [orgId];
  let idx = 2;

  if (targetId) {
    conditions.push(`ml.target_discord_id = $${idx++}`);
    params.push(targetId);
  }

  const { rows } = await pool.query(
    `SELECT ml.id, ml.target_discord_id, ml.target_username, ml.action_type,
            ml.reason, ml.duration_seconds, ml.expires_at, ml.created_at,
            u.username AS actor_username
     FROM discord_mod_log ml
     LEFT JOIN users u ON u.user_id = ml.actor_user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ml.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset],
  );

  return json({
    entries: rows.map((r) => ({
      id: r.id,
      targetDiscordId: r.target_discord_id,
      targetUsername: r.target_username,
      actionType: r.action_type,
      reason: r.reason,
      durationSeconds: r.duration_seconds,
      expiresAt: r.expires_at,
      actorUsername: r.actor_username,
      createdAt: r.created_at,
    })),
  });
}

export async function handleApiRequest(request) {
  const t0 = Date.now();
  const { method } = request;
  const { pathname } = new URL(request.url);
  let response;
  try {
    response = await _handleApiRequest(request);
  } catch (error) {
    // Safety net: any uncaught handler error returns JSON (not the SSR HTML
    // error page) so API clients — the frontend's `res.json()` and game-server
    // plugins — always receive a parseable body.
    console.error(`[api] ${method} ${pathname} — unhandled error:`, error);
    response = json({ error: "Internal server error" }, 500);
  }
  console.log(
    `[api] ${method} ${pathname} → ${response.status} (${Date.now() - t0}ms)`,
  );
  return response;
}

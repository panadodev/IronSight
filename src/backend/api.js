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
  discordId: "476047124694433822",
  steamId: "76561198825911004",
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

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getPterodactylEncryptionKey() {
  if (pterodactylEncryptionKey) return pterodactylEncryptionKey;

  const secret = String(env.pterodactylEncryptionSecret ?? "").trim();
  if (!secret) return null;

  pterodactylEncryptionKey = crypto
    .createHash("sha256")
    .update(secret)
    .digest();
  return pterodactylEncryptionKey;
}

function encryptPterodactylApiKey(apiKey) {
  const key = getPterodactylEncryptionKey();
  if (!key) throw new Error("pterodactyl_encryption_unconfigured");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(apiKey), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(":");
}

function decryptPterodactylApiKey(payload) {
  const key = getPterodactylEncryptionKey();
  if (!key) throw new Error("pterodactyl_encryption_unconfigured");

  const [version, ivB64, ciphertextB64, authTagB64] = String(
    payload ?? "",
  ).split(":");
  if (version !== "v1" || !ivB64 || !ciphertextB64 || !authTagB64) {
    throw new Error("pterodactyl_encryption_invalid_payload");
  }

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
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
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
    CREATE TABLE IF NOT EXISTS users (
      user_id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      discord_id TEXT UNIQUE,
      steam_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_users_identity_present CHECK (discord_id IS NOT NULL OR steam_id IS NOT NULL)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_audit_log (
      audit_id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  // ── Public identity links (Discord + Steam for portal ticket submitters) ──

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_identity_links (
      link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      discord_id TEXT NOT NULL UNIQUE,
      discord_username TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      added_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_servers_owner_org_id ON servers(owner_org_id)`,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  // -- Pterodactyl integration -----------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ptero_api_keys (
      org_id TEXT PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
      panel_url TEXT NOT NULL,
      api_key TEXT,
      api_key_encrypted TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
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
    `ALTER TABLE ptero_api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`,
  );
  await pool.query(
    `ALTER TABLE ptero_api_keys ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL`,
  );
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
           updated_at = NOW()
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
           updated_at = NOW()
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
      ('org_owner', 'Owner')
     ON CONFLICT (role_id) DO UPDATE SET role_name = EXCLUDED.role_name`,
  );

  await pool.query(
    `INSERT INTO permissions (permission_id, permission_name)
     VALUES
      ('todo_write', 'Can create and update todos'),
      ('org_manage', 'Can manage organization members'),
      ('role_create', 'Can create and manage custom roles')
     ON CONFLICT (permission_id) DO UPDATE SET permission_name = EXCLUDED.permission_name`,
  );

  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     VALUES
      ('org_member', 'todo_write'),
      ('org_admin', 'todo_write'),
      ('org_admin', 'org_manage'),
      ('org_owner', 'todo_write'),
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
        ? new Date(Number(row.created_unix) * 1000).toISOString()
        : new Date().toISOString();
      const completedAt = Number.isFinite(Number(row.completed_unix))
        ? new Date(Number(row.completed_unix) * 1000).toISOString()
        : null;

      await pool.query(
        `INSERT INTO todos (todo_id, org_id, title, description, status, created_by, assigned_to, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
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

  const existingRes = await pool.query(
    `SELECT user_id
     FROM users
     WHERE discord_id = $1 OR steam_id = $2
     LIMIT 1`,
    [SYSADMIN.discordId, SYSADMIN.steamId],
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
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, SYSADMIN.username, SYSADMIN.discordId, SYSADMIN.steamId],
    );
  } else {
    userId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (user_id, username, discord_id, steam_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, SYSADMIN.username, SYSADMIN.discordId, SYSADMIN.steamId],
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

  for (const row of rows) {
    const orgId = String(row.org_id);
    const roleId = String(row.role_id);
    const permissionId =
      row.permission_id == null ? null : String(row.permission_id);

    if (permissionId) permissions.add(permissionId);

    if (
      orgId !== SYSADMIN.globalOrgId &&
      (roleId === "org_admin" || roleId === "org_owner")
    ) {
      orgAdminOrgIds.add(orgId);
    }
  }

  const canWrite = permissions.has("todo_write");
  const groups = [
    {
      groupId: "member",
      admin: false,
      editUsers: permissions.has("org_manage"),
      editGroups: permissions.has("role_create"),
    },
  ];

  return {
    groups,
    globalAdmin: false,
    canWrite,
    orgAdminOrgIds: Array.from(orgAdminOrgIds),
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
    await migratePterodactylApiKeys();
    await ensureRolePermissionSeed();
    await migrateLegacyData();
    await pingDependencies();

    initialized = true;
    initError = null;
    console.info("[startup] PostgreSQL, Redis, and BullMQ are reachable.");
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
  const expiresAt = new Date(Date.now() + env.sessionTtlSeconds * 1000);

  const session = {
    userId: String(user.userId),
    username: String(user.username),
    discordId: String(user.discordId),
    steamId: user.steamId == null ? null : String(user.steamId),
    groups: access.groups,
    orgAdminOrgIds: access.orgAdminOrgIds,
    globalAdmin: access.globalAdmin,
    canWrite: access.canWrite,
  };

  await redis.set(
    `session:${sid}`,
    JSON.stringify(session),
    "EX",
    env.sessionTtlSeconds,
  );
  await pool.query(
    `INSERT INTO sessions (session_id, user_id, token_hash, created_at, expires_at, ip_address, user_agent, revoked)
     VALUES ($1, $2, $3, NOW(), $4, $5, $6, FALSE)`,
    [
      sid,
      session.userId,
      tokenHash,
      expiresAt.toISOString(),
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
         AND expires_at > NOW()
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

async function getTodoRowsForOrgs(orgIds) {
  if (!orgIds.length) return [];

  const { rows } = await pool.query(
    `SELECT t.todo_id,
            t.title,
            t.description,
            t.status,
            assignee.discord_id AS assignee_discord_id,
            t.org_id,
            EXTRACT(EPOCH FROM t.created_at)::BIGINT AS created_unix,
            CASE WHEN t.completed_at IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM t.completed_at)::BIGINT END AS completed_unix,
            creator.discord_id AS created_by_discord_id
     FROM todos t
     LEFT JOIN users assignee ON assignee.user_id = t.assigned_to
     LEFT JOIN users creator ON creator.user_id = t.created_by
     WHERE t.org_id = ANY($1::text[])
     ORDER BY t.created_at DESC`,
    [orgIds],
  );

  return rows.map((row) => ({
    id: String(row.todo_id),
    title: String(row.title),
    details: row.description == null ? "" : String(row.description),
    status: row.status == null ? "todo" : String(row.status),
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

async function rateLimitLogin(request) {
  if (!redis) return null;

  const ip = getClientIp(request);
  const limiterKey = `rl:login:${ip}`;
  try {
    const attempts = await redis.incr(limiterKey);
    if (attempts === 1) {
      await redis.expire(limiterKey, 60);
    }
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
      return createSessionForUser(
        {
          userId: String(existing.user_id),
          username: String(existing.username),
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
      username: existing ? String(existing.username) : discordUser.username,
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
  const nonceExists = await redis.get(nonceKey);
  await redis.del(nonceKey);
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
             updated_at = NOW()
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
    await pool.query(
      `INSERT INTO users (user_id, username, discord_id, steam_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, pending.username, pending.discordId, steamId],
    );

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

  return json({
    user: {
      userId: session.userId,
      username: session.username,
      discordId: session.discordId,
      steamId: session.steamId,
      groups: session.groups,
      orgAdminOrgIds: session.orgAdminOrgIds,
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
         updated_at = NOW()
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
          await redis.set(
            `session:${sid}`,
            JSON.stringify(cached),
            "EX",
            env.sessionTtlSeconds,
          );
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

  await pool.query(
    `INSERT INTO organizations (org_id, guild_id, name)
     VALUES ($1, $2, $3)`,
    [derivedOrgId, guildId || null, name],
  );

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
          await redis.set(
            `session:${sid}`,
            JSON.stringify(cached),
            "EX",
            env.sessionTtlSeconds,
          );
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

  const todos = await getTodoRowsForOrgs(orgIds);

  return json({
    user: {
      userId: session.userId,
      username: session.username,
      discordId: session.discordId,
      steamId: session.steamId,
      groups: session.groups,
      orgAdminOrgIds: session.orgAdminOrgIds,
    },
    orgs: userOrgs,
    members,
    todos,
    canWrite: canWriteTodos(session),
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
    `INSERT INTO todos (todo_id, title, description, status, assigned_to, org_id, created_by)
     VALUES ($1, $2, $3, 'todo', $4, $5, $6)`,
    [todoId, title, details, assignee.userId, orgId, session.userId],
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

  const existingRes = await pool.query(
    "SELECT todo_id, org_id, status FROM todos WHERE todo_id = $1 LIMIT 1",
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

  const nextStatus = status || String(existing.status);
  const completedAt =
    nextStatus === "completed" ? new Date().toISOString() : null;

  await pool.query(
    `UPDATE todos
     SET title = COALESCE($2, title),
         description = COALESCE($3, description),
         status = COALESCE($4, status),
         assigned_to = COALESCE($5, assigned_to),
         completed_at = $6,
         updated_at = NOW()
     WHERE todo_id = $1`,
    [todoId, title, details, status, assigneeUserId, completedAt],
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

  if (!canWriteTodos(session, String(existing.org_id))) {
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
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
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
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
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
    const fallbackName = username || `user_${discordId.slice(-6)}`;
    await pool.query(
      `INSERT INTO users (user_id, username, discord_id)
       VALUES ($1, $2, $3)`,
      [userId, fallbackName, discordId],
    );
    member = {
      userId,
      username: fallbackName,
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

  const cacheKeys = await redis.keys("cache:members:*");
  if (cacheKeys.length > 0) {
    await redis.del(...cacheKeys);
  }

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
  if (!canManageOrg(session, orgId)) {
    return json(
      { error: "Forbidden: org admin/owner role required to create roles" },
      403,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const roleName = String(body?.roleName ?? "").trim();
  const permissions = Array.isArray(body?.permissions) ? body.permissions : [];

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
  await pool.query(
    `INSERT INTO roles (role_id, role_name)
     VALUES ($1, $2)`,
    [roleId, roleName],
  );

  // Add permissions to the role
  if (permissions.length > 0) {
    const validPermissions = ["todo_write", "org_manage", "role_create"];
    const filteredPermissions = permissions.filter((p) =>
      validPermissions.includes(String(p).trim()),
    );

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
      },
    },
    201,
  );
}

async function handleRemoveOrgMember(request, orgId, userId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
  }

  if (!userId) {
    return json({ error: "userId is required" }, 400);
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) {
    return json({ error: "Organization not found" }, 404);
  }

  const memberRes = await pool.query(
    `SELECT om.role_id, u.username FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId],
  );
  if (!memberRes.rows[0]) {
    return json({ error: "Member not found in organization" }, 404);
  }

  const beforeState = memberRes.rows[0];

  await pool.query(
    `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );

  const cacheKeys = await redis.keys("cache:members:*");
  if (cacheKeys.length > 0) {
    await redis.del(...cacheKeys);
  }

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
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
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

  // Validate team is a valid role
  const validTeams = ["org_member", "org_admin"];
  // Accept both direct role IDs and legacy friendly names
  let mappedTeam;
  if (newTeam === "org_admin" || newTeam === "management") {
    mappedTeam = "org_admin";
  } else {
    mappedTeam = "org_member";
  }
  if (!validTeams.includes(mappedTeam)) {
    return json({ error: "Invalid team value" }, 400);
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) {
    return json({ error: "Organization not found" }, 404);
  }

  const memberRes = await pool.query(
    `SELECT om.role_id, u.username FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId],
  );
  if (!memberRes.rows[0]) {
    return json({ error: "Member not found in organization" }, 404);
  }

  const beforeState = memberRes.rows[0];
  if (beforeState.role_id === mappedTeam) {
    return json({ ok: true, orgId, userId, message: "Team unchanged" });
  }

  await pool.query(
    `UPDATE organization_members SET role_id = $1 WHERE org_id = $2 AND user_id = $3`,
    [mappedTeam, orgId, userId],
  );

  const cacheKeys = await redis.keys("cache:members:*");
  if (cacheKeys.length > 0) {
    await redis.del(...cacheKeys);
  }

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
      newTeam: mappedTeam,
    },
    beforeState: {
      orgId,
      userId,
      roleId: beforeState.role_id,
    },
    afterState: {
      orgId,
      userId,
      roleId: mappedTeam,
    },
  });

  return json({ ok: true, orgId, userId });
}

async function handleGetOrgMembers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
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
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
  }

  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId");
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 50));
  const offset = Number(url.searchParams.get("offset") ?? 0);

  if (!staffId) {
    return json({ error: "staffId query parameter is required" }, 400);
  }

  const logsRes = await pool.query(
    `SELECT
       id, actor_user_id, target_user_id, resource_type, resource_id,
       action_type, action_category, severity, metadata, before_state, after_state,
       created_at
     FROM audit_logs
     WHERE org_id = $1 AND target_user_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [orgId, staffId, limit, offset],
  );

  const countRes = await pool.query(
    `SELECT COUNT(*) as total FROM audit_logs WHERE org_id = $1 AND target_user_id = $2`,
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
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
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
      orgAdminOrgIds: targetAccess.orgAdminOrgIds,
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
    viewedAt: new Date().toISOString(),
  });
}

async function handleGetOrgDetails(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
  }

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
        org.created_at == null ? null : new Date(org.created_at).toISOString(),
    },
  });
}

async function handleUpdateOrgDetails(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const name = body?.name == null ? null : String(body.name).trim();
  const guildId = body?.guildId == null ? null : String(body.guildId).trim();

  if (name !== null && !name) {
    return json({ error: "name cannot be empty" }, 400);
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
         guild_id = $3
     WHERE org_id = $1
     RETURNING org_id, guild_id, name, created_at`,
    [orgId, name, guildId || null],
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
          : new Date(updated.created_at).toISOString(),
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

  await pool.query(`BEGIN`);

  try {
    await pool.query(`DELETE FROM role_permissions WHERE role_id = $1`, [
      roleId,
    ]);

    for (const permId of permissionIds) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleId, permId],
      );
    }

    await pool.query(`COMMIT`);

    return json({
      ok: true,
      roleId,
      permissionIds,
    });
  } catch (err) {
    await pool.query(`ROLLBACK`);
    throw err;
  }
}

// ── Default ticket types ─────────────────────────────────────────────────────

const DEFAULT_TICKET_TYPES = [
  {
    name: "Player Report",
    description:
      "Report a player for cheating, teaming, or other rule violations.",
  },
  { name: "Ban Appeal", description: "Appeal a ban or mute on this server." },
  {
    name: "VIP Issue",
    description: "Issues related to VIP memberships or perks.",
  },
  {
    name: "General Support",
    description: "General questions and support requests.",
  },
];

async function ensureDefaultTicketTypes(orgId) {
  const existing = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ticket_types WHERE org_id = $1`,
    [orgId],
  );
  if (Number(existing.rows[0].cnt) > 0) return;
  for (const t of DEFAULT_TICKET_TYPES) {
    await pool.query(
      `INSERT INTO ticket_types (org_id, ticket_type_name, ticket_type_description) VALUES ($1, $2, $3)`,
      [orgId, t.name, t.description],
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
            EXTRACT(EPOCH FROM t.created_at)::BIGINT AS created_at,
            EXTRACT(EPOCH FROM t.updated_at)::BIGINT AS updated_at,
            CASE WHEN t.closed_at IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM t.closed_at)::BIGINT END AS closed_at,
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
  };
}

async function loadTicketMessages(ticketId) {
  const { rows } = await pool.query(
    `SELECT tm.message_id, tm.ticket_id, tm.user_id, tm.message,
            EXTRACT(EPOCH FROM tm.created_at)::BIGINT AS created_at,
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
  const raw = await redis.get(nonceKey);
  await redis.del(nonceKey);
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
         SET username = $2, discord_id = $3, steam_id = $4, updated_at = NOW()
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
                     updated_at = NOW()`,
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
  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  // Seed defaults on-demand for this org instead of blocking startup for all orgs.
  await ensureDefaultTicketTypes(orgId);

  const { rows } = await pool.query(
    `SELECT ticket_type_id, ticket_type_name, ticket_type_description
     FROM ticket_types WHERE org_id = $1 ORDER BY ticket_type_id ASC`,
    [orgId],
  );
  return json({
    ticketTypes: rows.map((row) => ({
      ticketTypeId: Number(row.ticket_type_id),
      name: String(row.ticket_type_name),
      description: String(row.ticket_type_description),
    })),
  });
}

// ── Ticket CRUD ───────────────────────────────────────────────────────────────

async function handleCreateTicket(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

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

  const result = await pool.query(
    `INSERT INTO tickets (org_id, ticket_type_id, created_by, title)
     VALUES ($1, $2, $3, $4)
     RETURNING ticket_id`,
    [orgId, ticketTypeId, session.userId, title],
  );
  const ticketId = Number(result.rows[0].ticket_id);

  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES ($1, $2, $3)`,
    [ticketId, session.userId, message],
  );
  await pool.query(
    `INSERT INTO ticket_audit_log (ticket_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [
      ticketId,
      session.userId,
      "created",
      JSON.stringify({ title, orgId, ticketTypeId }),
    ],
  );

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
    const isMember = await pool.query(
      "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1",
      [ticket.org_id, session.userId],
    );
    if (!isMember.rows[0] && !isGlobalAdmin(session)) {
      return json({ error: "Forbidden" }, 403);
    }
  }

  const messages = await loadTicketMessages(id);
  return json({ ticket, messages });
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

  const ticket = await loadTicketFromDb(id);
  if (!ticket) return json({ error: "Ticket not found" }, 404);
  if (ticket.status === "closed")
    return json({ error: "Cannot add messages to a closed ticket" }, 400);

  const isCreator = ticket.created_by === session.userId;
  if (!isCreator) {
    const isMember = await pool.query(
      "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1",
      [ticket.org_id, session.userId],
    );
    if (!isMember.rows[0] && !isGlobalAdmin(session))
      return json({ error: "Forbidden" }, 403);
  }

  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES ($1, $2, $3)`,
    [id, session.userId, message],
  );

  if (isCreator && ticket.status === "waiting_response") {
    await pool.query(
      `UPDATE tickets SET status = 'open', updated_at = NOW() WHERE ticket_id = $1`,
      [id],
    );
  } else {
    await pool.query(
      `UPDATE tickets SET updated_at = NOW() WHERE ticket_id = $1`,
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

  const isMember = await pool.query(
    "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1",
    [ticket.org_id, session.userId],
  );
  if (!isMember.rows[0] && !isGlobalAdmin(session)) {
    return json({ error: "Forbidden: org membership required" }, 403);
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

  const setClauses = ["updated_at = NOW()"];
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
    setClauses.push("closed_at = NOW()");
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

  const isMember = await pool.query(
    "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1",
    [orgId, session.userId],
  );
  if (!isMember.rows[0] && !isGlobalAdmin(session))
    return json({ error: "Forbidden" }, 403);

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const conditions = ["t.org_id = $1"];
  const values = [orgId];
  let idx = 2;

  if (statusFilter) {
    conditions.push(`t.status = $${idx++}`);
    values.push(statusFilter);
  }
  values.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT t.ticket_id, t.org_id, t.ticket_type_id, t.created_by, t.assigned_to,
            t.status, t.priority, t.title,
            EXTRACT(EPOCH FROM t.created_at)::BIGINT AS created_at,
            EXTRACT(EPOCH FROM t.updated_at)::BIGINT AS updated_at,
            CASE WHEN t.closed_at IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM t.closed_at)::BIGINT END AS closed_at,
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
            EXTRACT(EPOCH FROM t.created_at)::BIGINT AS created_at,
            EXTRACT(EPOCH FROM t.updated_at)::BIGINT AS updated_at,
            CASE WHEN t.closed_at IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM t.closed_at)::BIGINT END AS closed_at,
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
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
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
     VALUES ($1, $2, NULL, $3, NOW(), $4, NULL)
     ON CONFLICT (org_id)
     DO UPDATE SET panel_url = EXCLUDED.panel_url,
                   api_key = NULL,
                   api_key_encrypted = EXCLUDED.api_key_encrypted,
                   created_by_user_id = EXCLUDED.created_by_user_id,
                   updated_at = NOW()`,
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
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
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
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  });
}

async function handleDeletePteroKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
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
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
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
      });
    }

    const pagination = data?.meta?.pagination;
    if (!pagination || page >= pagination.total_pages) break;
    page++;
  }

  await pool.query(
    `UPDATE ptero_api_keys
     SET last_used_at = NOW()
     WHERE org_id = $1`,
    [orgId],
  );

  return json({ servers });
}

async function handleImportPteroServer(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const serverName = String(body?.serverName ?? "").trim();
  if (!serverName) return json({ error: "serverName is required" }, 400);
  if (serverName.length > 128) {
    return json({ error: "serverName too long" }, 400);
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
     VALUES ($1, $2, $3, $4, $5)`,
    [serverId, serverName, orgId, apiKeyHash, session.userId],
  );

  return json(
    {
      ok: true,
      server: { serverId, serverName, ownerOrgId: orgId },
      apiKey: plainApiKey,
    },
    201,
  );
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

  if (!canManageOrg(session, orgId)) {
    return json({ error: "Forbidden: org admin role required" }, 403);
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
     VALUES ($1, $2, $3, $4, $5)`,
    [serverId, serverName, orgId, apiKeyHash, session.userId],
  );

  return json(
    {
      ok: true,
      server: { serverId, serverName, ownerOrgId: orgId },
      apiKey: plainApiKey,
    },
    201,
  );
}

async function handleListServers(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const userOrgs = await listUserOrganizations(session.userId);
  if (!userOrgs.length) return json({ servers: [] });

  const orgIds = userOrgs.map((o) => o.orgId);

  const { rows } = await pool.query(
    `SELECT server_id, server_name, owner_org_id
     FROM servers
     WHERE owner_org_id = ANY($1::text[])
     ORDER BY server_name ASC`,
    [orgIds],
  );

  return json({
    servers: rows.map((row) => ({
      serverId: String(row.server_id),
      serverName: String(row.server_name),
      ownerOrgId: String(row.owner_org_id),
    })),
  });
}

const CHAT_INGEST_RATE_LIMIT_PER_MINUTE = 120;

async function handleIngestChatMessage(request) {
  const apiKeyRaw = (request.headers.get("x-api-key") ?? "").trim();
  if (!apiKeyRaw) return json({ error: "Missing x-api-key header" }, 401);

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

  // Per-server rate limit
  const rlKey = `rl:chat:${server.server_id}`;
  try {
    const attempts = await redis.incr(rlKey);
    if (attempts === 1) await redis.expire(rlKey, 60);
    if (attempts > CHAT_INGEST_RATE_LIMIT_PER_MINUTE) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
  } catch {
    // fail-open on Redis errors
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const message = String(body?.message ?? "").trim();
  const steamId = String(body?.steam_id ?? "").trim();
  const teamMessage = body?.team_message === true || body?.team_message === 1;
  const playerName =
    body?.player_name == null ? null : String(body.player_name).trim();

  if (!message || !steamId) {
    return json({ error: "message and steam_id are required" }, 400);
  }
  if (message.length > 1000)
    return json({ error: "message must be 1000 characters or fewer" }, 400);
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
  const createdUnix = Math.floor(new Date(row.created_at).getTime() / 1000);

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
  const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200));

  if (!serverId) return json({ error: "serverId is required" }, 400);

  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE server_id = $1 LIMIT 1",
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const server = serverRes.rows[0];

  // Verify user is a member of the org that owns this server
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
  const cacheKey = `chat:server:${serverId}`;

  // Serve from Redis cache if the entire window falls within the last 7 days
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
    } catch {
      // fall through to Postgres on Redis error
    }
  }

  const startDate = new Date(startUnix * 1000).toISOString();
  const endDate = new Date(endUnix * 1000).toISOString();

  const { rows } = await pool.query(
    `SELECT id, message, steam_id, player_name, team_message,
            EXTRACT(EPOCH FROM created_at)::BIGINT AS ts
     FROM text_chat_log
     WHERE server_id = $1
       AND created_at >= $2
       AND created_at <= $3
     ORDER BY created_at ASC
     LIMIT $4`,
    [serverId, startDate, endDate, limit],
  );

  const lines = rows.map((row) => ({
    id: String(row.id),
    message: String(row.message),
    steamId: String(row.steam_id),
    playerName: row.player_name == null ? null : String(row.player_name),
    teamMessage: Boolean(row.team_message),
    ts: Number(row.ts),
  }));

  return json({ lines });
}

export async function initializeInfra() {
  try {
    await init();
  } catch {
    // startup failures are exposed via API startup guard responses
  }
}

export async function handleApiRequest(request) {
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

    const orgAdminsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/admins$/,
    );
    if (orgAdminsMatch && request.method === "POST") {
      return handleGrantOrgAdmin(request, orgAdminsMatch[1]);
    }

    const orgRolesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/roles$/,
    );
    if (orgRolesMatch && request.method === "POST") {
      return handleCreateOrgRole(request, orgRolesMatch[1]);
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

    const orgTicketTypesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-types$/,
    );
    if (orgTicketTypesMatch && request.method === "GET") {
      return handleListOrgTicketTypes(request, orgTicketTypesMatch[1]);
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

    if (pathname === "/api/servers" && request.method === "GET") {
      return handleListServers(request);
    }
    if (pathname === "/api/servers" && request.method === "POST") {
      return handleRegisterServer(request);
    }

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

    const orgPteroImportMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ptero\/servers\/import$/,
    );
    if (orgPteroImportMatch && request.method === "POST") {
      return handleImportPteroServer(request, orgPteroImportMatch[1]);
    }

    if (pathname === "/api/ingest/chat" && request.method === "POST") {
      return handleIngestChatMessage(request);
    }

    if (pathname === "/api/chat/logs" && request.method === "GET") {
      return handleGetChatLogs(request);
    }

    return json({ error: "Not found" }, 404);
  });
}

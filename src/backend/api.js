import { Queue, Worker } from "bullmq";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import "dotenv/config";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { Pool } from "pg";
import {
  AI_MODERATION_CATEGORIES,
  getOrgModerationRateInfo,
  getOrgOpenAIKey,
} from "./ai-moderation.js";
import {
  env,
  PENDING_LINK_COOKIE,
  SESSION_COOKIE,
  SYSADMIN,
} from "./config.js";
import {
  auditLog,
  authenticateServerKey,
  canManageOrg,
  canWriteTodos,
  checkRateLimit,
  isConfiguredSysAdmin,
  isGlobalAdmin,
  orgActorPosition,
  orgHasPermission,
  redirect,
  requireConfiguredSysAdmin,
  requireSession,
  sessionRankForOrg,
} from "./core.js";
import {
  decryptExternalApiKey,
  decryptIp,
  decryptPterodactylApiKey,
  encryptExternalApiKey,
  encryptIp,
  encryptPterodactylApiKey,
  getPterodactylEncryptionKey,
  ipHmac,
} from "./crypto-keys.js";
import {
  diagErrors,
  diagIncoming,
  diagOutgoing,
  diagRecordIncoming,
  diagRecordOutgoing,
} from "./diagnostics.js";
import { bmFetch, proxycheckApiFetch } from "./external-fetch.js";
import {
  handleGetBlacklistedWordsForServer,
  handleIngestChatMessage,
  handleIngestMuteSync,
  handleIngestPvp,
  handleIngestReport,
  handleIngestServerLog,
  handleIngestTeamEvent,
  handleMuteCheck,
  handleServerHealthCheck,
} from "./handlers/ingest.js";
import {
  handleGetChatLogs,
  handleGetOrgRecentReports,
  handleGetPvpLogs,
  handleGetReports,
  handleGetServerLogs,
  handleGetTeamEvents,
} from "./handlers/logs.js";
import { getClientIp, json, parseLimit } from "./http.js";
import {
  ensurePlayerCacheRow,
  getPlayerCacheData,
  getPlayerDataFromRedis,
  playerRedisKey,
  refreshPlayerData,
  seedFlaggedSteamGroups,
} from "./player-store.js";
import {
  abortMultipartUpload,
  buildObjectKey,
  completeMultipartUpload,
  DEFAULT_PUBLIC_FILE_LIMIT,
  DEFAULT_PUBLIC_MAX_FILES,
  deleteMediaObject,
  generatePresignedMultipart,
  generatePresignedPut,
  getPublicUrl,
  MAX_FILE_SIZE,
  MULTIPART_THRESHOLD,
  PUBLIC_ALLOWED_MIME,
  r2Configured,
  STAFF_ALLOWED_MIME,
  testR2BucketWriteDelete,
} from "./r2.js";
import {
  pool,
  queue,
  redis,
  setPool,
  setQueue,
  setRedis,
  setRedisSub,
} from "./runtime.js";
import {
  ensureRolePermissionSeed,
  ensureSchema,
  migrateTimestampsToUnix,
} from "./schema.js";
import {
  evaluateThreatTriggers,
  getThreatTriggerConfigOrDefault,
  saveThreatTriggerConfig,
  TRIGGER_FACTS,
} from "./threat-triggers.js";
import {
  cacheTicket,
  getCachedTicket,
  invalidateTicketCache,
  loadTicketFromDb,
  loadTicketMedia,
  loadTicketMessages,
} from "./ticket-store.js";
import {
  isValidSteamId,
  sanitizeNext,
  sanitizeReportedPlayers,
} from "./validation.js";

const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_ME_URL = "https://discord.com/api/users/@me";
const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";

// ticketId → Set<{ controller: ReadableStreamDefaultController, isStaff: boolean }>
const ticketStreams = new Map();
// orgId → Set<{ controller: ReadableStreamDefaultController }>
const flaggedStreams = new Map();
const sseEncoder = new TextEncoder();

let initError = null;
let initialized = false;
let initializationPromise = null;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

// Private/reserved IPv4+IPv6 ranges — block to prevent SSRF
const PRIVATE_HOST_RE =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.|::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
]);

function normalizePterodactylPanelUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) throw new Error("panel_url_required");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("panel_url_invalid");
  }

  if (parsed.protocol !== "https:") throw new Error("panel_url_invalid");
  if (parsed.username || parsed.password) throw new Error("panel_url_invalid");

  const hostname = parsed.hostname.toLowerCase();
  if (
    PRIVATE_HOST_RE.test(hostname) ||
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error("panel_url_invalid");
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";

  return parsed.toString().replace(/\/+$/, "");
}

function getPterodactylSecurityConfigError() {
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

// Parse a user-supplied pagination limit safely: a missing, non-numeric, or
// non-positive value falls back to `fallback` rather than producing NaN, which
// would otherwise blow up the Redis/SQL query with `LIMIT NaN`.

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
  "media_upload",
  "tickets_view",
  "tickets_manage",
  "tickets_player_intel",
  "ban_configs_manage",
  "toxicity_manage",
  "predefines_manage",
  "bans_delete",
  "bans_purge",
  "players_view",
  "ip_read",
  "bans_manage",
  "bans_create",
  "bans_modify",
  "bans_ip",
  "triggers_manage",
  "server_admin",
  "discord_mod",
  "discord_warn",
  "discord_timeout",
  "discord_kick",
  "discord_ban",
  "discord_delete_messages",
  "discord_bans_view",
  "discord_modlog_view",
  "staff_online_view",
  "chat_view",
  "flagged_messages_resolve",
  "flagged_messages_confirm",
  "flagged_messages_clear",
  "docs_view",
  "docs_edit",
  "player_kick",
];

// Ban permissions were split from the legacy umbrella `bans_manage` into granular
// create / modify / delete / ip permissions. `bans_manage` is retained as a
// backwards-compatible alias that still implies create + modify so existing role
// grants keep working. Owners/admins pass automatically via orgHasPermission.
function canCreateBans(session, orgId) {
  return (
    orgHasPermission(session, orgId, "bans_create") ||
    orgHasPermission(session, orgId, "bans_manage")
  );
}
function canModifyBans(session, orgId) {
  return (
    orgHasPermission(session, orgId, "bans_modify") ||
    orgHasPermission(session, orgId, "bans_manage")
  );
}
function canIssueIpBans(session, orgId) {
  return orgHasPermission(session, orgId, "bans_ip");
}
function canAccessBans(session, orgId) {
  return (
    canCreateBans(session, orgId) ||
    canModifyBans(session, orgId) ||
    orgHasPermission(session, orgId, "bans_delete")
  );
}

const IP_ADDRESS_RE = /^(\d{1,3}\.){3}\d{1,3}$|^(?=.*:)[\da-fA-F:]+$/;

function isVpnOrProxyProxycheckMeta(meta) {
  if (!meta || typeof meta !== "object") return false;
  const t = String(meta.type ?? "").toLowerCase();
  return (
    meta.proxy === "yes" ||
    t.includes("vpn") ||
    t.includes("proxy") ||
    t === "tor"
  );
}

function normalizeConnectionType(value) {
  const t = String(value ?? "")
    .trim()
    .toLowerCase();
  if (t.includes("vpn") || t.includes("proxy") || t === "tor") {
    return "proxy_vpn";
  }
  if (t.includes("residential")) return "residential";
  if (t.includes("business")) return "business";
  if (t.includes("mobile")) return "mobile";
  if (
    t.includes("hosting") ||
    t.includes("datacenter") ||
    t.includes("server")
  ) {
    return "hosting";
  }
  return t || "unknown";
}

function isAllowedIpBanConnectionType(connType) {
  return connType === "residential" || connType === "business";
}

function ipBanPolicyReason(connType, isProxyVpn) {
  if (isProxyVpn) {
    return "IP bans are only allowed for residential/business IPs. This IP is classified as VPN/proxy.";
  }
  if (connType === "mobile") {
    return "IP bans are only allowed for residential/business IPs. This IP is classified as mobile.";
  }
  if (connType === "hosting") {
    return "IP bans are only allowed for residential/business IPs. This IP is classified as hosting/datacenter.";
  }
  return "IP bans are only allowed for residential/business IPs.";
}

async function evaluateIpBanEligibility(orgId, ip) {
  const normalizedIp = String(ip ?? "").trim();
  if (!IP_ADDRESS_RE.test(normalizedIp)) {
    return {
      eligible: false,
      reason: "identifier must be a valid IPv4 or IPv6 address",
      connectionType: "unknown",
      isProxyVpn: false,
    };
  }

  const hash = ipHmac(normalizedIp);
  try {
    const cached = await pool.query(
      `SELECT is_proxy, is_vpn, conn_type
       FROM ip_metadata
       WHERE ip_hash = $1 AND cache_expires_at > unix_now()
       LIMIT 1`,
      [hash],
    );
    const row = cached.rows[0];
    if (row) {
      const connType = normalizeConnectionType(row.conn_type);
      const isProxyVpn =
        Boolean(row.is_proxy) ||
        Boolean(row.is_vpn) ||
        connType === "proxy_vpn";
      if (isProxyVpn || !isAllowedIpBanConnectionType(connType)) {
        return {
          eligible: false,
          reason: ipBanPolicyReason(connType, isProxyVpn),
          connectionType: connType,
          isProxyVpn,
        };
      }
      return {
        eligible: true,
        connectionType: connType,
        isProxyVpn: false,
      };
    }
  } catch {}

  const resp = await proxycheckApiFetch(orgId, [normalizedIp]);
  if (!resp || !resp.ok) {
    return {
      eligible: false,
      reason: "Unable to verify IP classification with Proxycheck right now.",
      connectionType: "unknown",
      isProxyVpn: false,
    };
  }

  const data = await resp.json().catch(() => null);
  if (!data || typeof data !== "object") {
    return {
      eligible: false,
      reason: "Unable to verify IP classification with Proxycheck right now.",
      connectionType: "unknown",
      isProxyVpn: false,
    };
  }
  if (data.status && data.status !== "ok") {
    return {
      eligible: false,
      reason: "Unable to verify IP classification with Proxycheck right now.",
      connectionType: "unknown",
      isProxyVpn: false,
    };
  }

  const meta = data[normalizedIp];
  if (!meta || typeof meta !== "object") {
    return {
      eligible: false,
      reason: "Unable to verify IP classification with Proxycheck right now.",
      connectionType: "unknown",
      isProxyVpn: false,
    };
  }

  const connType = normalizeConnectionType(meta.type);
  const isProxyVpn = isVpnOrProxyProxycheckMeta(meta);

  if (isProxyVpn || !isAllowedIpBanConnectionType(connType)) {
    return {
      eligible: false,
      reason: ipBanPolicyReason(connType, isProxyVpn),
      connectionType: isProxyVpn ? "proxy_vpn" : connType,
      isProxyVpn,
    };
  }

  return {
    eligible: true,
    connectionType: connType,
    isProxyVpn: false,
  };
}

function hasDiscordModLegacy(session, orgId) {
  return orgHasPermission(session, orgId, "discord_mod");
}

function canDiscordWarn(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_warn")
  );
}

function canDiscordTimeout(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_timeout")
  );
}

function canDiscordKick(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_kick")
  );
}

function canDiscordBan(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_ban")
  );
}

function canDiscordDeleteMessages(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_delete_messages")
  );
}

function canDiscordViewBans(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_bans_view")
  );
}

function canDiscordViewModLog(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_modlog_view")
  );
}

function canDiscordViewMessages(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    canDiscordTimeout(session, orgId) ||
    canDiscordKick(session, orgId) ||
    canDiscordBan(session, orgId) ||
    canDiscordDeleteMessages(session, orgId)
  );
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
    Object.entries(orgPermissionsMap).map(([orgId, set]) => [
      orgId,
      Array.from(set),
    ]),
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

    setPool(
      new Pool({
        connectionString: env.databaseUrl,
        max: Number(process.env.PG_POOL_MAX ?? 20),
        idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
        connectionTimeoutMillis: Number(
          process.env.PG_CONNECT_TIMEOUT_MS ?? 5000,
        ),
      }),
    );

    setRedis(
      new Redis(env.redisUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
      }),
    );

    const bullRedis = new Redis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    const redisSubClient = new Redis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    setRedisSub(redisSubClient);
    redisSubClient
      .psubscribe("ticket-stream:*", "flagged-stream:*")
      .catch((err) => {
        console.error("[sse] redisSub psubscribe error:", err.message);
      });
    redisSubClient.on("pmessage", (_pattern, channel, raw) => {
      if (channel.startsWith("ticket-stream:")) {
        const ticketId = parseInt(channel.slice("ticket-stream:".length), 10);
        if (!Number.isFinite(ticketId)) return;
        const set = ticketStreams.get(ticketId);
        if (!set?.size) return;
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          return;
        }
        const chunk = sseEncoder.encode(`data: ${raw}\n\n`);
        for (const entry of set) {
          if (
            event.type === "new_message" &&
            event.message?.isInternal &&
            !entry.isStaff
          )
            continue;
          try {
            entry.controller.enqueue(chunk);
          } catch {
            set.delete(entry);
          }
        }
        return;
      }

      if (channel.startsWith("flagged-stream:")) {
        const orgId = channel.slice("flagged-stream:".length);
        if (!orgId) return;
        const set = flaggedStreams.get(orgId);
        if (!set?.size) return;
        const chunk = sseEncoder.encode(`data: ${raw}\n\n`);
        for (const entry of set) {
          try {
            entry.controller.enqueue(chunk);
          } catch {
            set.delete(entry);
          }
        }
      }
    });

    setQueue(
      new Queue("panel-jobs", {
        connection: bullRedis,
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: 100,
        },
      }),
    );

    const banExpireWorker = new Worker(
      "panel-jobs",
      async (job) => {
        if (job.name === "ban-expire") await processBanExpireJob(job);
      },
      {
        connection: new Redis(env.redisUrl, {
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
        }),
      },
    );
    banExpireWorker.on("failed", (job, err) => {
      console.error(
        `[worker] job ${job?.name} ${job?.id} failed:`,
        err.message,
      );
    });

    await ensureSchema(pool);
    await migrateTimestampsToUnix(pool);
    await migratePterodactylApiKeys();
    await ensureRolePermissionSeed(pool);
    await pingDependencies();

    // Schedule expiry jobs for all active timed bans. Catches existing bans
    // from before this feature and any that expired while the server was down
    // (BullMQ fires delay:0 jobs immediately, so past-due ones run on startup).
    const timedBans = await pool.query(
      `SELECT ban_id, expires_at FROM player_bans
       WHERE revoked = FALSE AND expires_at IS NOT NULL`,
    );
    for (const row of timedBans.rows) {
      await scheduleBanExpiry(String(row.ban_id), Number(row.expires_at)).catch(
        (e) =>
          console.error("[startup] ban-expire schedule failed:", e.message),
      );
    }

    initialized = true;
    initError = null;
    console.info("[startup] PostgreSQL, Redis, and BullMQ are reachable.");

    seedFlaggedSteamGroups().catch((e) =>
      console.warn("[flagged-groups] seed failed:", e.message),
    );

    setInterval(
      () => {
        triggerGlobalpingMeasurements().catch((e) =>
          console.error("[globalping] measure job:", e.message),
        );
      },
      5 * 60 * 1000,
    );
    setInterval(() => {
      fetchPendingGlobalpingResults().catch((e) =>
        console.error("[globalping] results job:", e.message),
      );
    }, 60 * 1000);
    setInterval(
      () => {
        purgeExpiredMedia().catch((e) =>
          console.error("[media-expiry] purge job:", e.message),
        );
      },
      6 * 60 * 60 * 1000, // every 6 hours
    );
    // Discord messages must be purged on a schedule, not only on sync calls.
    // Retention < 30 days for non-banned users (GDPR/compliance).
    setInterval(
      () => {
        pruneOldDiscordMessages().catch((e) =>
          console.error("[discord-prune] purge job:", e.message),
        );
      },
      24 * 60 * 60 * 1000, // every 24 hours
    );
    setInterval(
      () => {
        pruneOldChatMessages().catch((e) =>
          console.error("[chat-prune] purge job:", e.message),
        );
      },
      24 * 60 * 60 * 1000, // every 24 hours
    );
    setInterval(
      () => {
        checkServerHealthAlerts().catch((e) =>
          console.error("[health-alerts] job:", e.message),
        );
      },
      60 * 1000, // every minute
    );
  })().catch((error) => {
    initError = error;
    console.error("[startup] dependency ping failed", error);
    throw error;
  });

  return initializationPromise;
}

async function revokeUserSessions(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT session_id FROM sessions WHERE user_id = $1 AND revoked = FALSE AND expires_at > unix_now()`,
      [userId],
    );
    if (rows.length > 0) {
      const pipeline = redis.pipeline();
      for (const row of rows) pipeline.del(`session:${row.session_id}`);
      await pipeline.exec();
      await pool.query(
        `UPDATE sessions SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE`,
        [userId],
      );
    }
  } catch (err) {
    console.error(
      `[session] revokeUserSessions failed for ${userId}:`,
      err.message,
    );
  }
}

async function createSessionForUser(user, options = {}) {
  const access = await loadUserAccess(user.userId);

  // Block login for users who are disabled in all their orgs (unless sysadmin)
  const sysAdminDiscordId = String(env.sysAdminDiscordId ?? "").trim();
  const isSysAdmin =
    sysAdminDiscordId && String(user.discordId) === sysAdminDiscordId;
  if (!isSysAdmin) {
    const memberRes = await pool.query(
      `SELECT
         (SELECT 1 FROM organization_members WHERE user_id = $1 AND org_id != $2 AND role_id != 'org_disabled' LIMIT 1) AS has_active,
         (SELECT 1 FROM organization_members WHERE user_id = $1 AND org_id != $2 LIMIT 1) AS has_any`,
      [user.userId, SYSADMIN.globalOrgId],
    );
    const { has_active, has_any } = memberRes.rows[0] ?? {};
    if (has_any && !has_active) {
      if (options.redirectTo) return redirect("/login?error=account_disabled");
      return json({ error: "Your account has been disabled." }, 403);
    }
  }

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
    [sid, session.userId, tokenHash, expiresAt, ipAddress, userAgent],
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
    `SELECT u.user_id, u.username, u.discord_id, u.steam_id,
            array_agg(DISTINCT om.org_id) AS org_ids,
            json_object_agg(om.org_id, COALESCE(r.role_name, om.role_id)) AS org_roles
     FROM users u
     JOIN organization_members om ON om.user_id = u.user_id
     LEFT JOIN roles r ON r.role_id = om.role_id
     WHERE om.org_id = ANY($1::text[])
       AND om.org_id <> $2
     GROUP BY u.user_id, u.username, u.discord_id, u.steam_id`,
    [orgIds, SYSADMIN.globalOrgId],
  );

  return rows.map((row) => ({
    userId: String(row.user_id),
    username: String(row.username),
    discordId: row.discord_id == null ? null : String(row.discord_id),
    steamId: row.steam_id == null ? null : String(row.steam_id),
    orgIds: row.org_ids ?? [],
    orgRoles: row.org_roles ?? {},
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
            t.is_personal,
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
         t.assigned_to = $2
         OR (
           NOT COALESCE(t.is_personal, false)
           AND (
             t.is_public = true
             OR t.created_by = $2
             OR t.org_id = ANY($3::text[])
           )
         )
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
    isPersonal: Boolean(row.is_personal),
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
      1,
      limiterKey,
      "60",
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

async function exchangeDiscordCode(request, code, fetchGuilds = true) {
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

  let guilds = null;
  if (fetchGuilds) {
    try {
      const guildsRes = await fetch(
        "https://discord.com/api/users/@me/guilds",
        {
          headers: { authorization: `Bearer ${tokenBody.access_token}` },
        },
      );
      if (guildsRes.ok) {
        const raw = await guildsRes.json();
        if (Array.isArray(raw)) {
          guilds = raw.map((g) => ({
            id: String(g.id),
            name: String(g.name ?? ""),
            icon: g.icon ?? null,
          }));
        }
      }
    } catch {}
  }

  return {
    discordId: String(me.id),
    username: String(
      me.global_name || me.username || `user_${String(me.id).slice(-6)}`,
    ),
    avatarHash: me.avatar ?? null,
    guilds,
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
    scope: "identify guilds",
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
    const discordUser = await exchangeDiscordCode(
      request,
      code,
      stateData.flow !== "public",
    );

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
      await pool.query(
        `UPDATE users
         SET username = $1,
             discord_guilds = COALESCE($2, discord_guilds),
             discord_avatar_hash = $3,
             updated_at = unix_now()
         WHERE user_id = $4`,
        [
          discordUser.username,
          discordUser.guilds ? JSON.stringify(discordUser.guilds) : null,
          discordUser.avatarHash,
          String(existing.user_id),
        ],
      );
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

    // New user: cache guilds in Redis until Steam linking completes (15 min TTL).
    if (discordUser.guilds && redis) {
      await redis.set(
        `discord:guilds:${discordUser.discordId}`,
        JSON.stringify(discordUser.guilds),
        "EX",
        60 * 15,
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

    // Retrieve guild data cached during Discord OAuth step.
    let cachedGuildsJson = null;
    try {
      if (redis) {
        cachedGuildsJson = await redis.get(
          `discord:guilds:${pending.discordId}`,
        );
        if (cachedGuildsJson)
          await redis.del(`discord:guilds:${pending.discordId}`);
      }
    } catch {}

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
             discord_guilds = COALESCE($4, discord_guilds),
             updated_at = unix_now()
         WHERE user_id = $1`,
        [
          String(existingUser.user_id),
          pending.username,
          steamId,
          cachedGuildsJson,
        ],
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
      // Fetch Discord avatar for new user
      let avatarHash = null;
      try {
        if (env.discordBotToken) {
          const userRes = await fetch(
            `https://discord.com/api/v10/users/${pending.discordId}`,
            {
              headers: { authorization: `Bot ${env.discordBotToken}` },
            },
          );
          if (userRes.ok) {
            const discordUser = await userRes.json();
            avatarHash = discordUser.avatar ?? null;
          }
        }
      } catch {}

      await pool.query(
        `INSERT INTO users (user_id, username, discord_id, steam_id, discord_guilds, discord_avatar_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          pending.username,
          pending.discordId,
          steamId,
          cachedGuildsJson,
          avatarHash,
        ],
      );
    } catch (err) {
      if (err.code === "23505")
        return redirect(
          "/login?error=steam_already_linked",
          clearPendingLinkHeaders(new Headers()),
        );
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

  const userRow = await pool.query(
    `SELECT profile_private FROM users WHERE user_id = $1 LIMIT 1`,
    [session.userId],
  );
  const profilePrivate = Boolean(userRow.rows[0]?.profile_private);

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
      profilePrivate,
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
  const profilePrivate =
    body?.profilePrivate === true || body?.profilePrivate === false
      ? Boolean(body.profilePrivate)
      : null;

  await pool.query(
    `UPDATE users
     SET username = $2,
         profile_private = COALESCE($3, profile_private),
         updated_at = unix_now()
     WHERE user_id = $1`,
    [session.userId, username, profilePrivate],
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

  const updatedRow = await pool.query(
    `SELECT profile_private FROM users WHERE user_id = $1 LIMIT 1`,
    [session.userId],
  );
  const resolvedProfilePrivate = Boolean(updatedRow.rows[0]?.profile_private);

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
      profilePrivate: resolvedProfilePrivate,
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
    if (err.code === "23505")
      return json({ error: "Organization ID already exists" }, 409);
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

  const bootstrapUserRow = await pool.query(
    `SELECT profile_private FROM users WHERE user_id = $1 LIMIT 1`,
    [session.userId],
  );
  const profilePrivate = Boolean(bootstrapUserRow.rows[0]?.profile_private);

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
      profilePrivate,
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
  const VALID_STATUSES = ["todo", "in_progress", "completed", "blocked"];
  const status = VALID_STATUSES.includes(body?.status) ? body.status : "todo";
  const isPublic = Boolean(body?.isPublic);
  const isPersonal = Boolean(body?.isPersonal);

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
    `INSERT INTO todos (todo_id, title, description, status, priority, is_public, is_personal, assigned_to, org_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      todoId,
      title,
      details,
      status,
      priority,
      isPublic,
      isPersonal,
      assignee.userId,
      orgId,
      session.userId,
    ],
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
        status,
        priority,
        isPublic,
        isPersonal,
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
  const isPersonal = body?.isPersonal == null ? null : Boolean(body.isPersonal);

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
         is_personal = COALESCE($8, is_personal),
         assigned_to = COALESCE($5, assigned_to),
         completed_at = CASE
           WHEN $4 = 'completed' AND completed_at IS NULL THEN unix_now()
           WHEN $4 IS NOT NULL AND $4 != 'completed' THEN NULL
           ELSE completed_at
         END,
         updated_at = unix_now()
     WHERE todo_id = $1`,
    [
      todoId,
      title,
      details,
      status,
      assigneeUserId,
      priority,
      isPublic,
      isPersonal,
    ],
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
    const guildUsername = await fetchDiscordGuildMember(
      org.guild_id,
      discordId,
    );
    const resolvedName =
      username || guildUsername || `user_${discordId.slice(-6)}`;
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

  // Sync in-game admin via RCON: org_admin covers all servers.
  const grantUserRes = await pool.query(
    `SELECT username, steam_id FROM users WHERE user_id = $1 LIMIT 1`,
    [member.userId],
  );
  await syncMemberServerAdminForRoleChange(
    orgId,
    {
      steam_id: grantUserRes.rows[0]?.steam_id,
      username: grantUserRes.rows[0]?.username ?? member.username,
    },
    beforeState.role_id,
    "org_admin",
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

// Hierarchy position of a role by id, mapping the built-in roles onto the
// custom-role scale: Owner/Admin sit above everything (Infinity), member /
// disabled at the bottom (0), custom roles use their stored position.
async function roleHierarchyPosition(roleId) {
  if (roleId === "org_owner" || roleId === "org_admin") return Infinity;
  if (roleId === "org_member" || roleId === "org_disabled") return 0;
  const res = await pool.query(
    `SELECT position FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  return res.rows[0] ? Number(res.rows[0].position) : 0;
}

async function handleCreateOrgRole(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "role_create")) {
    return json(
      { error: "Forbidden: role management permission required" },
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

  // Create the role at the BOTTOM of the hierarchy (Discord convention): bump
  // every existing custom role up one and insert the new one at position 1.
  // A role created at the bottom is always below its creator, so no position
  // ceiling check is needed here — the permission ceiling below is what matters.
  const client = await pool.connect();
  try {
    await client.query(`BEGIN`);
    await client.query(
      `UPDATE roles SET position = position + 1
       WHERE role_id LIKE ($1 || '_%')
         AND role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')`,
      [orgId],
    );
    await client.query(
      `INSERT INTO roles (role_id, role_name, position)
       VALUES ($1, $2, 1)`,
      [roleId, roleName],
    );
    await client.query(`COMMIT`);
  } catch (err) {
    await client.query(`ROLLBACK`).catch(() => {});
    client.release();
    if (err.code === "23505") {
      return json({ error: "A role with this name already exists" }, 409);
    }
    throw err;
  }
  client.release();

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
  if (
    !orgHasPermission(session, orgId, "role_create") &&
    !orgHasPermission(session, orgId, "org_manage") &&
    !orgHasPermission(session, orgId, "scripts_manage") &&
    !orgHasPermission(session, orgId, "scripts_view") &&
    !orgHasPermission(session, orgId, "rcon_access")
  ) {
    return json(
      {
        error:
          "Forbidden: role_create, org_manage, or scripts permission required",
      },
      403,
    );
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  const { rows } = await pool.query(
    `SELECT r.role_id, r.role_name, r.server_admin_all, r.position,
            COALESCE(array_agg(DISTINCT rp.permission_id ORDER BY rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '{}') AS permissions,
            COALESCE(array_agg(DISTINCT ttr.ticket_type_id ORDER BY ttr.ticket_type_id) FILTER (WHERE ttr.ticket_type_id IS NOT NULL), '{}') AS ticket_type_ids,
            COALESCE(array_agg(DISTINCT rdr.discord_role_id ORDER BY rdr.discord_role_id) FILTER (WHERE rdr.discord_role_id IS NOT NULL), '{}') AS discord_role_ids,
            COALESCE(array_agg(DISTINCT rsa.server_id::text) FILTER (WHERE rsa.server_id IS NOT NULL), '{}') AS server_admin_server_ids
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
     LEFT JOIN ticket_type_roles ttr ON ttr.role_id = r.role_id
     LEFT JOIN role_discord_roles rdr ON rdr.role_id = r.role_id
     LEFT JOIN role_server_admin rsa ON rsa.role_id = r.role_id
     WHERE r.role_id LIKE ($1 || '_%')
       AND r.role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
     GROUP BY r.role_id, r.role_name, r.server_admin_all, r.position
     ORDER BY r.position DESC, r.role_name ASC`,
    [orgId],
  );

  // Caller's own hierarchy position drives what the UI lets them edit/assign.
  // null means "top of hierarchy" (owner/admin/global) — above every role.
  const actorPos = await orgActorPosition(session, orgId);

  return json({
    callerPosition: Number.isFinite(actorPos) ? actorPos : null,
    roles: rows.map((row) => ({
      roleId: String(row.role_id),
      roleName: String(row.role_name),
      position: Number(row.position),
      permissions: Array.isArray(row.permissions) ? row.permissions : [],
      ticketTypeIds: Array.isArray(row.ticket_type_ids)
        ? row.ticket_type_ids.map(Number)
        : [],
      discordRoleIds: Array.isArray(row.discord_role_ids)
        ? row.discord_role_ids
        : [],
      serverAdminAll: row.server_admin_all === true,
      serverAdminServerIds: Array.isArray(row.server_admin_server_ids)
        ? row.server_admin_server_ids
        : [],
    })),
  });
}

async function handleUpdateOrgRole(request, orgId, roleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "role_create")) {
    return json(
      { error: "Forbidden: role management permission required" },
      403,
    );
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
    `SELECT role_id, position FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  if (!roleExists.rows[0]) return json({ error: "Role not found" }, 404);

  // Hierarchy: you cannot edit a role at or above your own position.
  const actorPos = await orgActorPosition(session, orgId);
  if (
    actorPos !== Infinity &&
    Number(roleExists.rows[0].position) >= actorPos
  ) {
    return json(
      { error: "Cannot edit a role at or above your own in the hierarchy" },
      403,
    );
  }

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
  const hasServerAdminAll = typeof body?.serverAdminAll === "boolean";
  const hasServerAdminServers = Array.isArray(body?.serverAdminServerIds);

  // Capture the server-admin scope BEFORE mutating so we can reconcile members'
  // in-game admin against the new scope (covers the permission being removed).
  const oldServerAdminIds = await resolveRoleServerAdminServerIds(
    orgId,
    roleId,
  );

  if (
    hasPermissions ||
    hasTicketTypes ||
    hasDiscordRoles ||
    hasServerAdminAll ||
    hasServerAdminServers
  ) {
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
          return json(
            { error: "Cannot grant permissions you do not hold" },
            403,
          );
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

    // Validate server-admin server ids belong to this org.
    let validServerAdminIds = [];
    if (hasServerAdminServers) {
      const rawIds = body.serverAdminServerIds
        .map((id) => String(id).trim())
        .filter(Boolean);
      if (rawIds.length > 0) {
        const srvRes = await pool.query(
          `SELECT server_id::text AS server_id FROM servers
           WHERE owner_org_id = $1 AND server_id = ANY($2::uuid[])`,
          [orgId, rawIds],
        );
        validServerAdminIds = srvRes.rows.map((r) => r.server_id);
      }
    }

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
        await client.query(
          `DELETE FROM role_discord_roles WHERE role_id = $1`,
          [roleId],
        );
        for (const discordRoleId of filteredDiscordRoleIds) {
          await client.query(
            `INSERT INTO role_discord_roles (role_id, discord_role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [roleId, discordRoleId],
          );
        }
      }
      if (hasServerAdminAll) {
        await client.query(
          `UPDATE roles SET server_admin_all = $1 WHERE role_id = $2`,
          [body.serverAdminAll, roleId],
        );
      }
      if (hasServerAdminServers) {
        await client.query(`DELETE FROM role_server_admin WHERE role_id = $1`, [
          roleId,
        ]);
        for (const sid of validServerAdminIds) {
          await client.query(
            `INSERT INTO role_server_admin (role_id, server_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [roleId, sid],
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

    // Reconcile in-game admin for every member currently holding this role:
    // grant on newly-covered servers, revoke on removed ones. Best-effort.
    try {
      const newServerAdminIds = await resolveRoleServerAdminServerIds(
        orgId,
        roleId,
      );
      const sameScope =
        oldServerAdminIds.length === newServerAdminIds.length &&
        new Set([...oldServerAdminIds, ...newServerAdminIds]).size ===
          oldServerAdminIds.length;
      if (!sameScope) {
        const membersRes = await pool.query(
          `SELECT u.steam_id, u.username FROM organization_members om
           JOIN users u ON u.user_id = om.user_id
           WHERE om.org_id = $1 AND om.role_id = $2 AND u.steam_id IS NOT NULL`,
          [orgId, roleId],
        );
        for (const m of membersRes.rows) {
          await applyMemberServerAdmin(
            orgId,
            m,
            oldServerAdminIds,
            newServerAdminIds,
          );
        }
      }
    } catch (err) {
      console.error("server_admin role reconcile failed:", err);
    }
  }

  const { rows } = await pool.query(
    `SELECT r.role_id, r.role_name, r.server_admin_all,
            COALESCE(array_agg(DISTINCT rp.permission_id ORDER BY rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '{}') AS permissions,
            COALESCE(array_agg(DISTINCT ttr.ticket_type_id ORDER BY ttr.ticket_type_id) FILTER (WHERE ttr.ticket_type_id IS NOT NULL), '{}') AS ticket_type_ids,
            COALESCE(array_agg(DISTINCT rdr.discord_role_id ORDER BY rdr.discord_role_id) FILTER (WHERE rdr.discord_role_id IS NOT NULL), '{}') AS discord_role_ids,
            COALESCE(array_agg(DISTINCT rsa.server_id::text) FILTER (WHERE rsa.server_id IS NOT NULL), '{}') AS server_admin_server_ids
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
     LEFT JOIN ticket_type_roles ttr ON ttr.role_id = r.role_id
     LEFT JOIN role_discord_roles rdr ON rdr.role_id = r.role_id
     LEFT JOIN role_server_admin rsa ON rsa.role_id = r.role_id
     WHERE r.role_id = $1
     GROUP BY r.role_id, r.role_name, r.server_admin_all`,
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
      serverAdminAll: role.server_admin_all === true,
      serverAdminServerIds: Array.isArray(role.server_admin_server_ids)
        ? role.server_admin_server_ids
        : [],
    },
  });
}

async function handleDeleteOrgRole(request, orgId, roleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "role_create")) {
    return json(
      { error: "Forbidden: role management permission required" },
      403,
    );
  }

  if (!roleId.startsWith(`${orgId}_`)) {
    return json({ error: "Role does not belong to this organization" }, 403);
  }

  const roleExists = await pool.query(
    `SELECT role_id, position FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  if (!roleExists.rows[0]) return json({ error: "Role not found" }, 404);

  // Hierarchy: you cannot delete a role at or above your own position.
  const actorPos = await orgActorPosition(session, orgId);
  if (
    actorPos !== Infinity &&
    Number(roleExists.rows[0].position) >= actorPos
  ) {
    return json(
      { error: "Cannot delete a role at or above your own in the hierarchy" },
      403,
    );
  }

  // Revoke in-game admin for members on this role before they drop to
  // org_member (which has no server_admin). Best-effort.
  try {
    const oldIds = await resolveRoleServerAdminServerIds(orgId, roleId);
    if (oldIds.length > 0) {
      const membersRes = await pool.query(
        `SELECT u.steam_id, u.username FROM organization_members om
         JOIN users u ON u.user_id = om.user_id
         WHERE om.org_id = $1 AND om.role_id = $2 AND u.steam_id IS NOT NULL`,
        [orgId, roleId],
      );
      for (const m of membersRes.rows) {
        await applyMemberServerAdmin(orgId, m, oldIds, []);
      }
    }
  } catch (err) {
    console.error("server_admin revoke on role delete failed:", err);
  }

  // Reassign members on this custom role to org_disabled and revoke their sessions
  const affectedRes = await pool.query(
    `SELECT user_id FROM organization_members WHERE org_id = $1 AND role_id = $2`,
    [orgId, roleId],
  );
  await pool.query(
    `UPDATE organization_members SET role_id = 'org_disabled'
     WHERE org_id = $1 AND role_id = $2`,
    [orgId, roleId],
  );
  for (const { user_id } of affectedRes.rows) {
    await revokeUserSessions(user_id);
  }

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

// Move a custom role one step up or down the hierarchy by swapping positions
// with its neighbour. Callers can only move roles below their own position, and
// can never push a role to or above their own level.
async function handleReorderOrgRole(request, orgId, roleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "role_create")) {
    return json(
      { error: "Forbidden: role management permission required" },
      403,
    );
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
  const direction = String(body?.direction ?? "");
  if (direction !== "up" && direction !== "down") {
    return json({ error: "direction must be 'up' or 'down'" }, 400);
  }

  const cur = await pool.query(
    `SELECT position FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  if (!cur.rows[0]) return json({ error: "Role not found" }, 404);
  const curPos = Number(cur.rows[0].position);

  const actorPos = await orgActorPosition(session, orgId);
  if (actorPos !== Infinity && curPos >= actorPos) {
    return json(
      { error: "Cannot move a role at or above your own in the hierarchy" },
      403,
    );
  }

  // "up" = next-higher position, "down" = next-lower position.
  const neighbor = await pool.query(
    direction === "up"
      ? `SELECT role_id, position FROM roles
          WHERE role_id LIKE ($1 || '_%')
            AND role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
            AND position > $2
          ORDER BY position ASC LIMIT 1`
      : `SELECT role_id, position FROM roles
          WHERE role_id LIKE ($1 || '_%')
            AND role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
            AND position < $2
          ORDER BY position DESC LIMIT 1`,
    [orgId, curPos],
  );
  if (!neighbor.rows[0]) return json({ ok: true }); // already at the edge

  const nbId = String(neighbor.rows[0].role_id);
  const nbPos = Number(neighbor.rows[0].position);
  if (actorPos !== Infinity && direction === "up" && nbPos >= actorPos) {
    return json(
      { error: "Cannot move a role above your own in the hierarchy" },
      403,
    );
  }

  const client = await pool.connect();
  try {
    await client.query(`BEGIN`);
    await client.query(`UPDATE roles SET position = $1 WHERE role_id = $2`, [
      nbPos,
      roleId,
    ]);
    await client.query(`UPDATE roles SET position = $1 WHERE role_id = $2`, [
      curPos,
      nbId,
    ]);
    await client.query(`COMMIT`);
  } catch (err) {
    await client.query(`ROLLBACK`).catch(() => {});
    throw err;
  } finally {
    client.release();
  }

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
    `SELECT om.role_id, u.username, u.discord_id, u.steam_id FROM organization_members om
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

  // Hierarchy: you cannot remove a member whose role sits at or above your own.
  if (!actorIsOwner) {
    const actorPos = await orgActorPosition(session, orgId);
    if (actorPos !== Infinity) {
      const targetPos = await roleHierarchyPosition(beforeState.role_id);
      if (targetPos >= actorPos) {
        return json(
          {
            error:
              "Cannot remove a member at or above your own in the hierarchy",
          },
          403,
        );
      }
    }
  }

  // Revoke in-game admin via RCON before dropping the membership.
  await syncMemberServerAdminForRoleChange(
    orgId,
    { steam_id: beforeState.steam_id, username: beforeState.username },
    beforeState.role_id,
    null,
  );

  await pool.query(
    `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );

  // Remove Discord roles associated with their staff role (best-effort)
  const discordWarning = await removeAllDiscordRolesForRole(
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

  return json({
    ok: true,
    orgId,
    userId,
    warnings: discordWarning ? [discordWarning] : [],
  });
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

  // Caller's hierarchy position gates which roles they can hand out and which
  // members they can act on. Owner/admin/global are Infinity (top).
  const actorPos = await orgActorPosition(session, orgId);

  if (!builtInRoles.includes(resolvedTeam)) {
    // Must be a valid custom role belonging to this org
    if (!resolvedTeam.startsWith(`${orgId}_`)) {
      return json({ error: "Invalid role" }, 400);
    }
    const customRoleRes = await pool.query(
      `SELECT role_id, position FROM roles WHERE role_id = $1 LIMIT 1`,
      [resolvedTeam],
    );
    if (!customRoleRes.rows[0]) {
      return json({ error: "Invalid role" }, 400);
    }

    // Hierarchy: you cannot assign a role at or above your own position
    // (Discord rule — you can only hand out roles below you).
    if (
      actorPos !== Infinity &&
      Number(customRoleRes.rows[0].position) >= actorPos
    ) {
      return json(
        { error: "Cannot assign a role at or above your own in the hierarchy" },
        403,
      );
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
          {
            error: "Cannot assign a role granting permissions you do not hold",
          },
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
    `SELECT om.role_id, u.username, u.discord_id, u.steam_id FROM organization_members om
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

  // Hierarchy: you cannot change the role of a member at or above your own
  // position (can't demote a peer or someone above you).
  if (actorPos !== Infinity) {
    const targetCurrentPos = await roleHierarchyPosition(beforeState.role_id);
    if (targetCurrentPos >= actorPos) {
      return json(
        {
          error:
            "Cannot change the role of a member at or above your own in the hierarchy",
        },
        403,
      );
    }
  }

  if (beforeState.role_id === resolvedTeam) {
    return json({ ok: true, orgId, userId, message: "Team unchanged" });
  }

  await pool.query(
    `UPDATE organization_members SET role_id = $1 WHERE org_id = $2 AND user_id = $3`,
    [resolvedTeam, orgId, userId],
  );

  // Revoke sessions immediately when a member is disabled
  if (resolvedTeam === "org_disabled") {
    await revokeUserSessions(userId);
  }

  // Sync Discord roles: remove old role's Discord roles, add new role's (best-effort)
  const discordWarning = await syncDiscordRolesOnRoleChange(
    orgRes.rows[0].guild_id,
    beforeState.discord_id,
    beforeState.role_id,
    resolvedTeam,
  );

  // Sync in-game admin (server_admin permission) via RCON for the role change.
  await syncMemberServerAdminForRoleChange(
    orgId,
    { steam_id: beforeState.steam_id, username: beforeState.username },
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

  return json({
    ok: true,
    orgId,
    userId,
    warnings: discordWarning ? [discordWarning] : [],
  });
}

async function handleRevokeUserSession(request, orgId, userId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!session.globalAdmin && !(session.orgOwnerOrgIds ?? []).includes(orgId)) {
    return json({ error: "Forbidden: owner only" }, 403);
  }

  if (userId === session.userId) {
    return json({ error: "Cannot revoke your own session" }, 400);
  }

  const memberCheck = await pool.query(
    `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
    [orgId, userId],
  );
  if (!memberCheck.rows[0]) {
    return json({ error: "Member not found in this organization" }, 404);
  }

  const sessionsRes = await pool.query(
    `SELECT session_id FROM sessions
     WHERE user_id = $1 AND revoked = FALSE AND expires_at > unix_now()`,
    [userId],
  );

  if (sessionsRes.rows.length > 0) {
    const pipeline = redis.pipeline();
    for (const row of sessionsRes.rows) {
      pipeline.del(`session:${row.session_id}`);
    }
    await pipeline.exec();

    await pool.query(
      `UPDATE sessions SET revoked = TRUE
       WHERE user_id = $1 AND revoked = FALSE`,
      [userId],
    );
  }

  return json({ ok: true, revokedCount: sessionsRes.rows.length });
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
    `SELECT u.user_id, u.username, u.discord_id, u.steam_id, u.discord_guilds, u.discord_avatar_hash, om.role_id
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
      discordGuilds: row.discord_guilds ?? null,
      discordAvatar:
        row.discord_avatar_hash && row.discord_id
          ? `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.discord_avatar_hash}.png?size=64`
          : null,
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
  const offset = Math.max(
    0,
    Math.trunc(Number(url.searchParams.get("offset"))) || 0,
  );

  if (!staffId) {
    return json({ error: "staffId query parameter is required" }, 400);
  }

  const memberCheck = await pool.query(
    `SELECT u.discord_id FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND om.user_id = $2 LIMIT 1`,
    [orgId, staffId],
  );
  if (!memberCheck.rows[0]) {
    return json({ error: "Staff member not found in this organization" }, 404);
  }
  if (memberCheck.rows[0].discord_id === env.sysAdminDiscordId) {
    return json({ error: "Not found" }, 404);
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

async function handleGetNotificationPrefs(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) return json({ error: "Forbidden" }, 403);

  const res = await pool.query(
    `SELECT enabled FROM staff_notification_prefs WHERE user_id = $1 AND org_id = $2`,
    [session.userId, orgId],
  );
  return json({ enabled: res.rows[0]?.enabled ?? false });
}

async function handlePutNotificationPrefs(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) return json({ error: "Forbidden" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const enabled = !!body?.enabled;

  await pool.query(
    `INSERT INTO staff_notification_prefs (user_id, org_id, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, org_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [session.userId, orgId, enabled],
  );
  return json({ enabled });
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
      orgOwnerOrgIds: targetAccess.orgOwnerOrgIds.filter((id) => id === orgId),
      canWrite: targetAccess.canWrite,
      groups: targetAccess.groups,
      // The member's real granular permission set for this org — mirrors the
      // shape the session uses so the UI reflects exactly what they can see.
      permissions: targetAccess.orgPermissions[orgId] ?? [],
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
    `SELECT org_id, guild_id, name, bm_org_id, bm_auto_sync, bm_ban_list_id, sync_perms_on_join,
            media_expiry_months, media_storage_limit_bytes, media_user_limit_bytes,
            media_public_file_limit_bytes, media_public_max_files, created_at
     FROM organizations WHERE org_id = $1 LIMIT 1`,
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
      bmOrgId: org.bm_org_id == null ? null : String(org.bm_org_id),
      bmAutoSync: org.bm_auto_sync === true,
      bmBanListId:
        org.bm_ban_list_id == null ? null : String(org.bm_ban_list_id),
      syncPermsOnJoin: org.sync_perms_on_join === true,
      mediaExpiryMonths: org.media_expiry_months ?? null,
      mediaStorageLimitBytes:
        org.media_storage_limit_bytes != null
          ? Number(org.media_storage_limit_bytes)
          : null,
      mediaUserLimitBytes:
        org.media_user_limit_bytes != null
          ? Number(org.media_user_limit_bytes)
          : null,
      mediaPublicFileLimitBytes:
        org.media_public_file_limit_bytes != null
          ? Number(org.media_public_file_limit_bytes)
          : null,
      mediaPublicMaxFiles:
        org.media_public_max_files != null
          ? Number(org.media_public_max_files)
          : null,
      name: String(org.name),
      createdAt: org.created_at == null ? null : Number(org.created_at),
    },
  });
}

async function handleUpdateOrgDetails(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const isOwner = (session.orgOwnerOrgIds ?? []).includes(orgId);
  if (!isOwner && !session.globalAdmin) {
    return json({ error: "Forbidden: org owner access required" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const name = body?.name == null ? null : String(body.name).trim();
  // guildId / bmOrgId: omitted (undefined) → don't touch; null → unlink; string → set/change
  const guildIdRaw = body?.guildId;
  const guildId =
    guildIdRaw === undefined
      ? undefined
      : guildIdRaw === null
        ? null
        : String(guildIdRaw).trim() || null;

  const bmOrgIdRaw = body?.bmOrgId;
  const bmOrgId =
    bmOrgIdRaw === undefined
      ? undefined
      : bmOrgIdRaw === null
        ? null
        : String(bmOrgIdRaw).trim() || null;

  const bmAutoSync =
    body?.bmAutoSync === undefined ? undefined : body.bmAutoSync === true;

  const bmBanListIdRaw = body?.bmBanListId;
  const bmBanListId =
    bmBanListIdRaw === undefined
      ? undefined
      : bmBanListIdRaw === null
        ? null
        : String(bmBanListIdRaw).trim() || null;

  // syncPermsOnJoin: omitted (undefined) → don't touch; otherwise coerce to boolean.
  const syncPermsOnJoin =
    body?.syncPermsOnJoin === undefined
      ? undefined
      : body.syncPermsOnJoin === true;

  const mediaExpiryMonthsRaw = body?.mediaExpiryMonths;
  const mediaExpiryMonths =
    mediaExpiryMonthsRaw === undefined
      ? undefined
      : mediaExpiryMonthsRaw === null
        ? null
        : Math.max(1, Math.min(120, parseInt(mediaExpiryMonthsRaw, 10))) ||
          null;

  // Storage quota fields: bytes; null = unlimited.
  function parseByteLimit(raw) {
    if (raw === undefined) return undefined;
    if (raw === null || raw === "" || raw === 0) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  function parseIntLimit(raw) {
    if (raw === undefined) return undefined;
    if (raw === null || raw === "" || raw === 0) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const mediaStorageLimitBytes = parseByteLimit(body?.mediaStorageLimitBytes);
  const mediaUserLimitBytes = parseByteLimit(body?.mediaUserLimitBytes);
  const mediaPublicFileLimitBytes = parseByteLimit(
    body?.mediaPublicFileLimitBytes,
  );
  const mediaPublicMaxFiles = parseIntLimit(body?.mediaPublicMaxFiles);

  if (name !== null && !name) {
    return json({ error: "name cannot be empty" }, 400);
  }
  if (
    guildId !== undefined &&
    guildId !== null &&
    !/^\d{17,20}$/.test(guildId)
  ) {
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
         guild_id = CASE WHEN $3 THEN $4::text ELSE guild_id END,
         bm_org_id = CASE WHEN $5 THEN $6::text ELSE bm_org_id END,
         bm_auto_sync = CASE WHEN $7 THEN $8::boolean ELSE bm_auto_sync END,
         bm_ban_list_id = CASE WHEN $9 THEN $10::text ELSE bm_ban_list_id END,
         sync_perms_on_join = CASE WHEN $11 THEN $12::boolean ELSE sync_perms_on_join END,
         media_expiry_months = CASE WHEN $13 THEN $14::integer ELSE media_expiry_months END,
         media_storage_limit_bytes = CASE WHEN $15 THEN $16::bigint ELSE media_storage_limit_bytes END,
         media_user_limit_bytes = CASE WHEN $17 THEN $18::bigint ELSE media_user_limit_bytes END,
         media_public_file_limit_bytes = CASE WHEN $19 THEN $20::bigint ELSE media_public_file_limit_bytes END,
         media_public_max_files = CASE WHEN $21 THEN $22::integer ELSE media_public_max_files END
     WHERE org_id = $1
     RETURNING org_id, guild_id, bm_org_id, bm_auto_sync, bm_ban_list_id, sync_perms_on_join,
               media_expiry_months, media_storage_limit_bytes, media_user_limit_bytes,
               media_public_file_limit_bytes, media_public_max_files, name, created_at`,
    [
      orgId,
      name,
      guildId !== undefined,
      guildId ?? null,
      bmOrgId !== undefined,
      bmOrgId ?? null,
      bmAutoSync !== undefined,
      bmAutoSync ?? false,
      bmBanListId !== undefined,
      bmBanListId ?? null,
      syncPermsOnJoin !== undefined,
      syncPermsOnJoin ?? false,
      mediaExpiryMonths !== undefined,
      mediaExpiryMonths ?? null,
      mediaStorageLimitBytes !== undefined,
      mediaStorageLimitBytes ?? null,
      mediaUserLimitBytes !== undefined,
      mediaUserLimitBytes ?? null,
      mediaPublicFileLimitBytes !== undefined,
      mediaPublicFileLimitBytes ?? null,
      mediaPublicMaxFiles !== undefined,
      mediaPublicMaxFiles ?? null,
    ],
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
      bmOrgId: updated.bm_org_id == null ? null : String(updated.bm_org_id),
      bmAutoSync: updated.bm_auto_sync === true,
      bmBanListId:
        updated.bm_ban_list_id == null ? null : String(updated.bm_ban_list_id),
      syncPermsOnJoin: updated.sync_perms_on_join === true,
      mediaExpiryMonths: updated.media_expiry_months ?? null,
      mediaStorageLimitBytes:
        updated.media_storage_limit_bytes != null
          ? Number(updated.media_storage_limit_bytes)
          : null,
      mediaUserLimitBytes:
        updated.media_user_limit_bytes != null
          ? Number(updated.media_user_limit_bytes)
          : null,
      mediaPublicFileLimitBytes:
        updated.media_public_file_limit_bytes != null
          ? Number(updated.media_public_file_limit_bytes)
          : null,
      mediaPublicMaxFiles:
        updated.media_public_max_files != null
          ? Number(updated.media_public_max_files)
          : null,
      name: String(updated.name),
      createdAt: updated.created_at == null ? null : Number(updated.created_at),
    },
  });
}

async function handleGetBmOrgs(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) return json({ error: "Forbidden" }, 403);

  let data;
  try {
    const res = await bmFetch(
      orgId,
      `https://api.battlemetrics.com/organizations?page[size]=100`,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return json(
        {
          error: `BattleMetrics API error ${res.status}: ${text.slice(0, 200)}`,
        },
        502,
      );
    }
    data = await res.json();
  } catch (err) {
    return json(
      { error: `Failed to reach BattleMetrics: ${err.message}` },
      502,
    );
  }

  const orgs = (data?.data ?? []).map((item) => ({
    id: String(item.id),
    name: String(item.attributes?.name ?? item.id),
  }));

  return json({ orgs });
}

async function handleGetBmBanLists(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) return json({ error: "Forbidden" }, 403);

  const url = new URL(request.url);
  const bmOrgIdParam = url.searchParams.get("bmOrgId")?.trim();

  let bmOrgId = bmOrgIdParam;
  if (!bmOrgId) {
    const orgRes = await pool.query(
      "SELECT bm_org_id FROM organizations WHERE org_id = $1 LIMIT 1",
      [orgId],
    );
    const org = orgRes.rows[0];
    if (!org) return json({ error: "Organization not found" }, 404);
    bmOrgId = org.bm_org_id;
  }
  if (!bmOrgId) return json({ banLists: [] });

  let data;
  try {
    const res = await bmFetch(
      orgId,
      `https://api.battlemetrics.com/organizations/${encodeURIComponent(bmOrgId)}/relationships/banLists?page[size]=100`,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return json(
        {
          error: `BattleMetrics API error ${res.status}: ${text.slice(0, 200)}`,
        },
        502,
      );
    }
    data = await res.json();
  } catch (err) {
    return json(
      { error: `Failed to reach BattleMetrics: ${err.message}` },
      502,
    );
  }

  const banLists = (data?.data ?? []).map((item) => ({
    id: String(item.id),
    name: String(item.attributes?.name ?? item.id),
  }));

  return json({ banLists });
}

async function syncBanRecordToBattlemetrics(orgId, banId) {
  const orgRes = await pool.query(
    "SELECT bm_org_id, bm_ban_list_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.bm_org_id) return;

  const banRes = await pool.query(
    "SELECT ban_id, bm_ban_id, identifier, identifier_type, reason, note, expires_at, player_steam_id FROM player_bans WHERE ban_id = $1 LIMIT 1",
    [banId],
  );
  const ban = banRes.rows[0];
  if (!ban) return;

  const bmIdentifierType =
    ban.identifier_type === "steam_id" ? "steamID" : ban.identifier_type;
  // IP identifiers are stored encrypted; decrypt before sending to BattleMetrics.
  const rawBmIdentifier =
    ban.identifier_type === "ip" ? decryptIp(ban.identifier) : ban.identifier;

  // Look up the BM player ID to link the ban to the player's BM profile.
  // For IP bans with a known player_steam_id, use that to find the BM player.
  let bmPlayerId = null;
  const lookupSteamId =
    ban.identifier_type === "steam_id"
      ? ban.identifier
      : (ban.player_steam_id ?? null);
  if (lookupSteamId) {
    const pcRes = await pool.query(
      `SELECT bm_id FROM player_cache WHERE steam_id = $1 LIMIT 1`,
      [lookupSteamId],
    );
    bmPlayerId = pcRes.rows[0]?.bm_id ?? null;
  }

  const payload = {
    data: {
      type: "ban",
      attributes: {
        autoAddEnabled: false,
        nativeEnabled: false,
        reason: ban.reason || "No reason provided",
        note: ban.note || "",
        ...(ban.expires_at
          ? { expires: new Date(ban.expires_at * 1000).toISOString() }
          : {}),
        identifiers: rawBmIdentifier
          ? [
              {
                type: bmIdentifierType,
                identifier: String(rawBmIdentifier),
                manual: true,
              },
            ]
          : [],
      },
      relationships: {
        organization: {
          data: { type: "organization", id: String(org.bm_org_id) },
        },
        ...(org.bm_ban_list_id
          ? {
              banList: {
                data: { type: "banList", id: String(org.bm_ban_list_id) },
              },
            }
          : {}),
        ...(bmPlayerId
          ? { player: { data: { type: "player", id: String(bmPlayerId) } } }
          : {}),
      },
    },
  };

  try {
    if (ban.bm_ban_id) {
      await bmFetch(
        orgId,
        `https://api.battlemetrics.com/bans/${encodeURIComponent(ban.bm_ban_id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    } else {
      const res = await bmFetch(orgId, "https://api.battlemetrics.com/bans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const responseData = await res.json().catch(() => null);
        const bmBanId = responseData?.data?.id;
        if (bmBanId) {
          await pool.query(
            "UPDATE player_bans SET bm_ban_id = $2 WHERE ban_id = $1",
            [banId, String(bmBanId)],
          );
        }
      } else {
        const text = await res.text().catch(() => "");
        console.error(
          `[bm-sync] POST /bans failed ${res.status}: ${text.slice(0, 200)}`,
        );
      }
    }
  } catch (err) {
    console.error(
      "[bm-sync] Failed to sync ban to BattleMetrics:",
      err.message,
    );
  }
}

async function createBmNoteForMute(orgId, banId) {
  const orgRes = await pool.query(
    "SELECT bm_org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.bm_org_id) return;

  const muteRes = await pool.query(
    `SELECT ban_id, player_steam_id, reason, note, expires_at, issued_at,
            issued_by_name
     FROM player_bans WHERE ban_id = $1 LIMIT 1`,
    [banId],
  );
  const mute = muteRes.rows[0];
  if (!mute) return;

  const steamId = mute.player_steam_id ?? mute.identifier;
  if (!steamId) return;

  const pcRes = await pool.query(
    `SELECT bm_id FROM player_cache WHERE steam_id = $1 LIMIT 1`,
    [steamId],
  );
  const bmPlayerId = pcRes.rows[0]?.bm_id;
  if (!bmPlayerId) return;

  const expiresAt = mute.expires_at ? Number(mute.expires_at) : null;
  let durationStr;
  if (!expiresAt) {
    durationStr = "Permanent";
  } else {
    const secs = expiresAt - Math.floor(Date.now() / 1000);
    if (secs <= 0) {
      durationStr = "Expired";
    } else {
      const mins = Math.round(secs / 60);
      if (mins < 60) durationStr = `${mins}m`;
      else if (mins < 1440) durationStr = `${Math.round(mins / 60)}h`;
      else durationStr = `${Math.round(mins / 1440)}d`;
    }
  }

  const noteLines = [
    `[MUTE] ${mute.reason || "No reason"}`,
    `Duration: ${durationStr}`,
  ];
  if (mute.note?.trim()) noteLines.push(`Note: ${mute.note.trim()}`);
  if (mute.issued_by_name) noteLines.push(`Staff: ${mute.issued_by_name}`);

  const payload = {
    data: {
      type: "playerNote",
      attributes: {
        note: noteLines.join("\n"),
        shared: false,
      },
      relationships: {
        organization: {
          data: { type: "organization", id: String(org.bm_org_id) },
        },
        player: {
          data: { type: "player", id: String(bmPlayerId) },
        },
      },
    },
  };

  try {
    const res = await bmFetch(
      orgId,
      `https://api.battlemetrics.com/players/${encodeURIComponent(bmPlayerId)}/relationships/notes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[bm-mute-note] POST failed ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error("[bm-mute-note] Failed to create BM note:", err.message);
  }
}

async function handleGetOnlineStaff(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "staff_online_view"))
    return json(
      { error: "Forbidden: staff_online_view permission required" },
      403,
    );

  // Pull all non-admin/owner/disabled members, then check Redis presence.
  // Privacy ("private profile") now blocks player lookups, NOT presence — staff
  // still appear here as online so the team can see who's around.
  const { rows } = await pool.query(
    `SELECT u.user_id, u.username
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1
       AND om.role_id NOT IN ('org_admin', 'org_owner', 'org_disabled')`,
    [orgId],
  );

  const online = [];
  await Promise.all(
    rows.map(async (r) => {
      const ts = await redis.get(`online:${r.user_id}`).catch(() => null);
      if (ts) {
        online.push({
          userId: String(r.user_id),
          username: String(r.username),
          lastSeenAt: Number(ts),
        });
      }
    }),
  );

  online.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return json({ staff: online });
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

  // Reachable unauthenticated (public ticket portal) and can trigger a default
  // seed write — cap per-IP to protect the DB pool from enumeration floods.
  if (!session) {
    const rl = await checkRateLimit(
      `rl:ticket-types:${getClientIp(request)}`,
      PUBLIC_READ_RATE_LIMIT_PER_MINUTE,
      60,
    );
    if (rl) return rl;
  }

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
  const reportedPlayers = sanitizeReportedPlayers(body?.reportedPlayers);

  // Validate pending media IDs (uploaded via /api/public/ticket-media).
  const rawMediaIds = Array.isArray(body?.mediaIds)
    ? body.mediaIds.slice(0, 10)
    : [];
  const safeMediaIds = rawMediaIds
    .map((id) => String(id).trim())
    .filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      ),
    );

  if (!orgId || !title || !message) {
    return json({ error: "orgId, title, and message are required" }, 400);
  }
  if (title.length > 255)
    return json({ error: "title must be 255 characters or fewer" }, 400);
  if (message.length > 10000)
    return json({ error: "message is too long" }, 400);

  const orgRes = await pool.query(
    "SELECT org_id, media_public_max_files FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);
  const maxFiles = Number(
    orgRes.rows[0].media_public_max_files ?? DEFAULT_PUBLIC_MAX_FILES,
  );

  if (safeMediaIds.length > maxFiles)
    return json(
      { error: `Maximum ${maxFiles} file(s) allowed per ticket` },
      400,
    );

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

  // Verify all media IDs belong to this session user and are confirmed pending uploads for this org.
  let validMediaIds = [];
  if (safeMediaIds.length > 0) {
    const { rows: mediaRows } = await pool.query(
      `SELECT media_id FROM org_media
       WHERE media_id = ANY($1::uuid[]) AND org_id = $2 AND uploaded_by = $3
         AND source = 'pending' AND confirmed = TRUE AND deleted = FALSE`,
      [safeMediaIds, orgId, session.userId],
    );
    validMediaIds = mediaRows.map((r) => String(r.media_id));
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
      [
        ticketId,
        session.userId,
        "created",
        JSON.stringify({ title, orgId, ticketTypeId }),
      ],
    );
    // Link confirmed media to the ticket and promote from 'pending' to 'ticket'.
    for (const mediaId of validMediaIds) {
      await txClient.query(
        `UPDATE org_media SET source = 'ticket' WHERE media_id = $1`,
        [mediaId],
      );
      await txClient.query(
        `INSERT INTO ticket_media_links (ticket_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [ticketId, mediaId],
      );
    }
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

async function handleStreamTicket(request, ticketIdStr) {
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
      // ok
    } else if (canManageOrg(session, ticket.org_id)) {
      // ok
    } else {
      const perms = session.orgPermissions?.[ticket.org_id] ?? [];
      const hasPermission =
        perms.includes("tickets_view") || perms.includes("tickets_manage");
      if (!hasPermission) return json({ error: "Forbidden" }, 403);

      if (ticket.ticket_type_id !== null) {
        const typeRes = await pool.query(
          `SELECT 1 FROM organization_members om
           JOIN ticket_type_roles ttr ON ttr.role_id = om.role_id
           WHERE om.org_id = $1 AND om.user_id = $2
           LIMIT 1`,
          [ticket.org_id, session.userId],
        );
        if (typeRes.rows.length > 0) {
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

  const isStaff =
    isGlobalAdmin(session) ||
    canManageOrg(session, ticket.org_id) ||
    orgHasPermission(session, ticket.org_id, "tickets_view") ||
    orgHasPermission(session, ticket.org_id, "tickets_manage");

  let entry;
  let heartbeat;
  const stream = new ReadableStream({
    start(controller) {
      entry = { controller, isStaff };
      if (!ticketStreams.has(id)) ticketStreams.set(id, new Set());
      ticketStreams.get(id).add(entry);
      controller.enqueue(sseEncoder.encode(": connected\n\n"));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(sseEncoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25000);
    },
    cancel() {
      clearInterval(heartbeat);
      const set = ticketStreams.get(id);
      if (set) {
        set.delete(entry);
        if (set.size === 0) ticketStreams.delete(id);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
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
      const hasPermission =
        perms.includes("tickets_view") || perms.includes("tickets_manage");
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
  const media = await loadTicketMedia(id);

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

  return json({ ticket, messages: returnedMessages, media });
}

// Redact/shape IP history entries depending on caller entitlement. Panel APIs
// never return plaintext IPs; they expose only short hash tokens + proxycheck
// metadata for investigation workflows.
function filterPlayerIpData(playerData, canSeeIp) {
  if (!playerData) return playerData;
  const toShortIpHash = (value) =>
    String(value ?? "")
      .replace(/[^a-f0-9]/gi, "")
      .slice(0, 8)
      .toUpperCase();
  const result = { ...playerData };
  if (Array.isArray(result.ipHistory)) {
    result.ipHistory = result.ipHistory.map((entry) => {
      const { ipEncrypted, ipAddress, ...rest } = entry;
      if (canSeeIp) {
        void ipEncrypted;
        void ipAddress;
        return {
          ...rest,
          ipHashShort: toShortIpHash(rest.ipHashShort || rest.ipHash),
        };
      }
      return {
        ...rest,
        ipHash: null,
        ipHashShort: null,
        country: null,
        isoCode: null,
        isp: null,
        asn: null,
        connType: null,
      };
    });
  }
  if (Array.isArray(result.relatedAccounts)) {
    result.relatedAccounts = result.relatedAccounts.map((account) => ({
      ...account,
      sharedIps: Array.isArray(account.sharedIps)
        ? account.sharedIps.map((s) => {
            const source = s ?? {};
            const { ip, ...rest } = source;
            void ip;
            return {
              ...rest,
              ipHash: canSeeIp ? source.ipHash : null,
              ipHashShort: canSeeIp
                ? toShortIpHash(source.ipHashShort || source.ipHash)
                : null,
              isp: canSeeIp ? source.isp : null,
              country: canSeeIp ? source.country : null,
              asn: canSeeIp ? source.asn : null,
              connType: canSeeIp ? source.connType : null,
            };
          })
        : account.sharedIps,
    }));
  }
  return result;
}

// Member orgs where the caller holds `permissionId` (admins/owners pass).
function orgsWithPermission(session, permissionId) {
  const out = new Set();
  for (const orgId of sessionCandidateOrgIds(session, null)) {
    if (orgHasPermission(session, orgId, permissionId)) out.add(orgId);
  }
  return out;
}

// Source orgs whose player IPs the caller may see:
//   "ALL"  → sysadmin, no source filtering
//   null   → caller has no ip_read anywhere → redact all IPs
//   Set    → own ip_read orgs ∪ orgs that shared 'ips' to one of them
async function entitledIpSourceOrgs(session) {
  if (isConfiguredSysAdmin(session)) return "ALL";
  const ipReadOrgs = [...orgsWithPermission(session, "ip_read")];
  if (!ipReadOrgs.length) return null;
  const result = new Set(ipReadOrgs);
  const { rows } = await pool.query(
    `SELECT DISTINCT owner_org_id FROM org_share_grants
     WHERE status = 'active' AND 'ips' = ANY(categories)
       AND grantee_org_id = ANY($1)`,
    [ipReadOrgs],
  );
  for (const r of rows) result.add(String(r.owner_org_id));
  return result;
}

// Drop IP-history entries whose source orgs are all outside `entitledOrgs`.
// Untagged (legacy) entries have no source and stay visible to any IP reader.
// The caller already established the player has IP access (entitlement !== null).
function filterIpHistoryBySource(playerData, entitledOrgs) {
  if (!playerData || !Array.isArray(playerData.ipHistory)) return playerData;
  const result = { ...playerData };
  result.ipHistory = playerData.ipHistory.filter((e) => {
    const src = Array.isArray(e.sourceOrgIds) ? e.sourceOrgIds : [];
    if (src.length === 0) return true;
    return src.some((o) => entitledOrgs.has(o));
  });
  return result;
}

// One-shot IP visibility resolution for the player bundle: full redact when the
// caller has no IP access, source-filter otherwise. Always passes through
// filterPlayerIpData so hash tokens + metadata are kept (or redacted) by role.
function applyIpEntitlement(playerData, entitlement) {
  if (entitlement === null) return filterPlayerIpData(playerData, false);
  if (entitlement === "ALL") return filterPlayerIpData(playerData, true);
  return filterPlayerIpData(
    filterIpHistoryBySource(playerData, entitlement),
    true,
  );
}

// External (BattleMetrics) bans are unioned across the caller's orgs: each is
// tagged with the orgs whose BM key observed it. Show a ban when any observing
// org is entitled (member org with players_view, or a 'bm_bans' share). Untagged
// (legacy, pre-observation) bans stay visible. `entitledOrgs` null = sysadmin.
function filterBmBansBySource(playerData, entitledOrgs) {
  if (!playerData || !Array.isArray(playerData.bmBans)) return playerData;
  if (entitledOrgs === null) return playerData;
  const result = { ...playerData };
  result.bmBans = playerData.bmBans.filter((b) => {
    const src = Array.isArray(b.sourceOrgIds) ? b.sourceOrgIds : [];
    if (src.length === 0) return true;
    return src.some((o) => entitledOrgs.has(o));
  });
  return result;
}

// Apply both source-scoped slices (IPs + external bans) to the shared bundle for
// this caller. Computed at read so the cached bundle stays org-agnostic.
function applyShareEntitlement(playerData, ipEntitlement, bmEntitlement) {
  return filterBmBansBySource(
    applyIpEntitlement(playerData, ipEntitlement),
    bmEntitlement,
  );
}

async function handleGetTicketPlayerIntel(request, ticketIdStr) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const id = Number(ticketIdStr);
  if (!Number.isInteger(id) || id <= 0)
    return json({ error: "Invalid ticket ID" }, 400);

  let ticket = await getCachedTicket(id);
  if (!ticket) {
    ticket = await loadTicketFromDb(id);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
  }

  const hasIntelPerm = orgHasPermission(
    session,
    ticket.org_id,
    "tickets_player_intel",
  );
  if (
    !isGlobalAdmin(session) &&
    !canManageOrg(session, ticket.org_id) &&
    !hasIntelPerm
  ) {
    return json(
      { error: "Forbidden: tickets_player_intel permission required" },
      403,
    );
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

  const {
    rows: [insertedRow],
  } = await pool.query(
    `INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal) VALUES ($1, $2, $3, $4) RETURNING message_id, created_at`,
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

  redis
    .publish(
      `ticket-stream:${id}`,
      JSON.stringify({
        type: "new_message",
        message: {
          messageId: Number(insertedRow.message_id),
          ticketId: id,
          userId: session.userId,
          username: session.username ?? null,
          steamId: session.steamId ?? null,
          message,
          isInternal,
          createdAt: Number(insertedRow.created_at),
        },
      }),
    )
    .catch(() => {});

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
      return json(
        { error: "Forbidden: tickets_manage permission required" },
        403,
      );
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

  if (updated) {
    redis
      .publish(
        `ticket-stream:${id}`,
        JSON.stringify({
          type: "ticket_updated",
          ticket: {
            status: updated.status,
            priority: updated.priority,
            assigned_to: updated.assigned_to,
            assigned_to_username: updated.assigned_to_username,
          },
        }),
      )
      .catch(() => {});
  }

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
    const hasPermission =
      perms.includes("tickets_view") || perms.includes("tickets_manage");
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
  const offset = Math.max(
    0,
    Math.trunc(Number(url.searchParams.get("offset"))) || 0,
  );

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
            tt.ticket_type_category,
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
      ticket_type_category: row.ticket_type_category ?? null,
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

async function handleGetOrgTicketAssignees(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const canView =
    isGlobalAdmin(session) ||
    canManageOrg(session, orgId) ||
    orgHasPermission(session, orgId, "tickets_view") ||
    orgHasPermission(session, orgId, "tickets_manage");

  if (!canView) return json({ error: "Forbidden" }, 403);

  const { rows } = await pool.query(
    `SELECT u.user_id, u.username
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1
     ORDER BY u.username ASC`,
    [orgId],
  );

  return json({
    members: rows.map((row) => ({
      userId: String(row.user_id),
      username: String(row.username),
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
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
  } catch {
    return json({ error: "panelUrl must be a valid public https URL" }, 400);
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
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

  // Best-effort: pull RCON config from Pterodactyl Client API and pre-configure
  // the server. Failures are silently ignored so the import always succeeds.
  let rconInfo = null;
  if (pteroIdentifier && !getPterodactylSecurityConfigError()) {
    try {
      const credentials = await loadPterodactylCredentials(orgId);
      if (credentials) {
        const config = await fetchPteroRconConfig(
          credentials.panelUrl,
          credentials.apiKey,
          pteroIdentifier,
        );
        if (config) {
          const encryptedPass = encryptPterodactylApiKey(config.rconPassword);
          const params = [config.ip, config.rconPort, encryptedPass, serverId];
          let sql = `UPDATE servers SET rcon_host = $1, rcon_port = $2, rcon_password_enc = $3`;
          if (config.gamePort) {
            params.splice(3, 0, config.gamePort);
            sql += `, game_port = $4 WHERE server_id = $5`;
          } else {
            sql += ` WHERE server_id = $4`;
          }
          await pool.query(sql, params);
          rconInfo = {
            rconHost: config.ip,
            rconPort: config.rconPort,
            gamePort: config.gamePort ?? null,
          };
        }
      }
    } catch {
      // ignore
    }
  }

  return json(
    {
      ok: true,
      server: {
        serverId,
        serverName,
        ownerOrgId: orgId,
        pteroIdentifier,
        rconConfigured: Boolean(rconInfo),
        rconHost: rconInfo?.rconHost ?? null,
        rconPort: rconInfo?.rconPort ?? null,
        gamePort: rconInfo?.gamePort ?? null,
      },
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

// Fetch RCON config for a specific server via the Pterodactyl Client API.
// Uses the startup variables endpoint for RCON_PORT / RCON_PASSWORD, and the
// server details endpoint for the primary allocation IP and game port.
// Returns null on any failure (Application-only keys will 403 the client endpoints).
async function fetchPteroRconConfig(panelUrl, apiKey, identifier) {
  const enc = encodeURIComponent(identifier);
  const [serverRes, startupRes] = await Promise.allSettled([
    fetch(`${panelUrl}/api/client/servers/${enc}?include=allocations`, {
      headers: PTERO_HEADERS(apiKey),
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`${panelUrl}/api/client/servers/${enc}/startup`, {
      headers: PTERO_HEADERS(apiKey),
      signal: AbortSignal.timeout(8000),
    }),
  ]);

  if (
    serverRes.status !== "fulfilled" ||
    !serverRes.value.ok ||
    startupRes.status !== "fulfilled" ||
    !startupRes.value.ok
  )
    return null;

  let serverData, startupData;
  try {
    [serverData, startupData] = await Promise.all([
      serverRes.value.json(),
      startupRes.value.json(),
    ]);
  } catch {
    return null;
  }

  const allocs = serverData?.attributes?.relationships?.allocations?.data ?? [];
  const defaultAlloc =
    allocs.find((a) => a?.attributes?.is_default) ?? allocs[0] ?? null;
  const rawIp =
    defaultAlloc?.attributes?.ip_alias || defaultAlloc?.attributes?.ip || null;
  // Skip obviously-unroutable bindings
  const ip = rawIp && rawIp !== "0.0.0.0" ? rawIp : null;
  const gamePort = defaultAlloc?.attributes?.port
    ? Number(defaultAlloc.attributes.port)
    : null;

  const vars = startupData?.attributes?.variables?.data ?? [];
  const varMap = Object.fromEntries(
    vars
      .filter((v) => v?.attributes?.env_variable)
      .map((v) => [
        v.attributes.env_variable,
        v.attributes.server_value ?? v.attributes.default_value ?? "",
      ]),
  );

  const rconPort = varMap.RCON_PORT ? Number(varMap.RCON_PORT) : null;
  const rconPassword = varMap.RCON_PASSWORD || null;

  if (!ip || !rconPort || !rconPassword) return null;
  return { ip, gamePort, rconPort, rconPassword };
}

// Combined status payload: node inventory + servers + best-effort live stats.
async function handleGetPteroStatus(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "status_view") &&
    !orgHasPermission(session, orgId, "servers_manage")
  ) {
    return json(
      { error: "Forbidden: status_view or servers_manage permission required" },
      403,
    );
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

  // When live data is supported, infer node connectivity from registered server
  // live-data. A stopped server still returns {state:"offline"}; null means the
  // Client API couldn't reach Wings at all — so null unambiguously means down.
  const nodeOnlineMap = {};
  if (liveSupported) {
    const serversByNode = {};
    for (const s of mergedServers) {
      if (s.nodeId == null) continue;
      if (!serversByNode[s.nodeId]) serversByNode[s.nodeId] = [];
      serversByNode[s.nodeId].push(s);
    }
    for (const [nodeId, nodeServers] of Object.entries(serversByNode)) {
      nodeOnlineMap[Number(nodeId)] = nodeServers.some((s) => s.live !== null);
    }
  }

  const annotatedNodes = nodes.map((n) => ({
    ...n,
    online: Object.prototype.hasOwnProperty.call(nodeOnlineMap, n.id)
      ? nodeOnlineMap[n.id]
      : null,
  }));

  await pool.query(
    `UPDATE ptero_api_keys SET last_used_at = unix_now() WHERE org_id = $1`,
    [orgId],
  );

  return json({
    connected: true,
    liveSupported,
    nodes: annotatedNodes,
    servers: mergedServers,
  });
}

// Mint a short-lived Wings websocket token + socket URL for a server so the
// browser can stream live stats. Requires a client-capable API key.
async function handleGetPteroServerWebsocket(request, orgId, identifier) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "rcon_access") &&
    !orgHasPermission(session, orgId, "servers_manage")
  ) {
    return json(
      { error: "Forbidden: rcon_access or servers_manage permission required" },
      403,
    );
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
  }

  await pool.query(`DELETE FROM servers WHERE server_id = $1`, [serverId]);

  try {
    const userOrgs = await listUserOrganizations(session.userId);
    if (userOrgs.length)
      await invalidateServerListCache(userOrgs.map((o) => o.orgId));
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
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
    if (userOrgs.length)
      await invalidateServerListCache(userOrgs.map((o) => o.orgId));
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

async function handleListOrgServers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isConfiguredSysAdmin(session)) {
    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM organization_members
       WHERE org_id = $1 AND user_id = $2 AND role_id != 'org_disabled'
       LIMIT 1`,
      [orgId, session.userId],
    );
    if (!memberRows[0]) return json({ error: "Forbidden" }, 403);
  }

  const { rows } = await pool.query(
    `SELECT server_id, server_name, owner_org_id, created_at, ptero_identifier,
            rcon_host, rcon_port, game_port, tags, last_health_ping,
            (rcon_password_enc IS NOT NULL AND rcon_host IS NOT NULL AND rcon_port IS NOT NULL) AS rcon_configured
     FROM servers
     WHERE owner_org_id = $1
     ORDER BY server_name ASC`,
    [orgId],
  );

  return json({
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
  });
}

// ── Public org server list (for ticket submission portal) ────────────────────

async function handleListPublicOrgServers(request, orgId) {
  // Unauthenticated and enumerable by orgId — cap per-IP so it can't be used to
  // exhaust the DB pool.
  const rl = await checkRateLimit(
    `rl:public-servers:${getClientIp(request)}`,
    PUBLIC_READ_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (rl) return rl;

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
    return json(
      { error: "Forbidden: scripts_manage permission required" },
      403,
    );
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
  if (!Number.isInteger(minRank) || minRank < 1)
    return json({ error: "minRank must be a positive integer" }, 400);

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
    return json(
      { error: "Forbidden: scripts_manage permission required" },
      403,
    );
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
    if (!Number.isInteger(minRank) || minRank < 1)
      return json({ error: "minRank must be a positive integer" }, 400);
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
    return json(
      { error: "Forbidden: scripts_manage permission required" },
      403,
    );
  }

  const res = await pool.query(
    `DELETE FROM org_scripts WHERE script_id = $1 AND org_id = $2`,
    [scriptId, orgId],
  );
  if (res.rowCount === 0) return json({ error: "Script not found" }, 404);

  return json({ ok: true });
}

async function handleExecScriptRcon(request, orgId, scriptId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "rcon_access"))
    return json({ error: "Forbidden: rcon_access permission required" }, 403);

  const scriptRes = await pool.query(
    `SELECT name, command, min_rank FROM org_scripts WHERE script_id = $1 AND org_id = $2`,
    [scriptId, orgId],
  );
  if (!scriptRes.rows[0]) return json({ error: "Script not found" }, 404);

  const { name: scriptName, command: rawCommand, min_rank } = scriptRes.rows[0];
  const userPosition = await orgActorPosition(session, orgId);
  if (userPosition < Number(min_rank))
    return json(
      { error: "Forbidden: insufficient rank to execute this script" },
      403,
    );

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const serverId = String(body?.serverId ?? "").trim();
  if (!serverId) return json({ error: "serverId is required" }, 400);

  const rawVars = body?.vars && typeof body.vars === "object" ? body.vars : {};
  const vars = {};
  for (const [k, v] of Object.entries(rawVars)) {
    if (/^[a-zA-Z0-9_]+$/.test(k))
      vars[k] = String(v ?? "").replace(/[\r\n\x00-\x1f]/g, "");
  }

  const command = String(rawCommand).replace(
    /\{([a-zA-Z0-9_]+)\}/g,
    (_, k) => vars[k] ?? `{${k}}`,
  );
  const cmds = command
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);

  const serverRes = await pool.query(
    `SELECT owner_org_id, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);

  const { owner_org_id, rcon_host, rcon_port, rcon_password_enc } =
    serverRes.rows[0];
  if (owner_org_id !== orgId) return json({ error: "Server not found" }, 404);

  if (!rcon_host || !rcon_port || !rcon_password_enc)
    return json({ error: "RCON not configured for this server" }, 400);

  let rconPassword;
  try {
    rconPassword = decryptPterodactylApiKey(rcon_password_enc);
  } catch {
    return json({ error: "RCON credentials corrupted" }, 500);
  }

  const rl = await checkRateLimit(
    `rl:rcon:${session.userId}:${serverId}`,
    30,
    60,
  );
  if (rl) return rl;

  const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(rconPassword)}`;
  const outputs = [];
  for (const cmd of cmds) {
    let rconResult = null;
    let rconErr = null;
    try {
      rconResult = await executeRconCommand(rconUrl, cmd);
    } catch (err) {
      rconErr = String(err?.message ?? err);
    }
    outputs.push({
      cmd,
      ok: rconErr === null,
      response: rconResult?.response ?? rconErr ?? "",
    });
  }

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "script",
    resourceId: scriptId,
    actionType: "SCRIPT_EXEC",
    actionCategory: "server_management",
    severity: 2,
    metadata: {
      scriptName,
      serverId,
      success: outputs.every((o) => o.ok),
    },
    ipAddress: getClientIp(request),
  });

  return json({ ok: true, outputs });
}

// ── Manage Org: Pre-defines ─────────────────────────────────────────────────

function serializePredefine(row) {
  return {
    id: String(row.predefine_id),
    keyword: String(row.keyword),
    extraKeywords: Array.isArray(row.extra_keywords) ? row.extra_keywords : [],
    content: String(row.content),
    ticketTypeIds: Array.isArray(row.ticket_type_ids)
      ? row.ticket_type_ids.map(Number)
      : [],
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
    `SELECT predefine_id, keyword, extra_keywords, content, ticket_type_ids
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
    return json(
      { error: "Forbidden: predefines_manage permission required" },
      403,
    );
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
  const rawTicketTypeIds = Array.isArray(body?.ticketTypeIds)
    ? body.ticketTypeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!keyword) return json({ error: "Keyword is required." }, 400);
  if (!content) return json({ error: "Content is required." }, 400);
  if (keyword.length > 128)
    return json({ error: "Keyword must be 128 characters or fewer." }, 400);

  let ticketTypeIds = [];
  if (rawTicketTypeIds.length > 0) {
    const ttRes = await pool.query(
      `SELECT ticket_type_id FROM ticket_types WHERE org_id = $1 AND ticket_type_id = ANY($2)`,
      [orgId, rawTicketTypeIds],
    );
    ticketTypeIds = ttRes.rows.map((r) => Number(r.ticket_type_id));
  }

  const { rows } = await pool.query(
    `INSERT INTO org_predefines (org_id, keyword, extra_keywords, content, ticket_type_ids, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING predefine_id, keyword, extra_keywords, content, ticket_type_ids`,
    [orgId, keyword, extraKeywords, content, ticketTypeIds, session.userId],
  );
  return json({ predefine: serializePredefine(rows[0]) }, 201);
}

async function handleUpdateOrgPredefine(request, orgId, predefineId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "predefines_manage")) {
    return json(
      { error: "Forbidden: predefines_manage permission required" },
      403,
    );
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
  if (body?.ticketTypeIds !== undefined) {
    const rawIds = Array.isArray(body.ticketTypeIds)
      ? body.ticketTypeIds
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
      : [];
    let validIds = [];
    if (rawIds.length > 0) {
      const ttRes = await pool.query(
        `SELECT ticket_type_id FROM ticket_types WHERE org_id = $1 AND ticket_type_id = ANY($2)`,
        [orgId, rawIds],
      );
      validIds = ttRes.rows.map((r) => Number(r.ticket_type_id));
    }
    params.push(validIds);
    setClauses.push(`ticket_type_ids = $${params.length}`);
  }
  if (setClauses.length === 0)
    return json({ error: "No fields to update" }, 400);
  setClauses.push(`updated_at = unix_now()`);

  params.push(predefineId);
  params.push(orgId);
  const { rows } = await pool.query(
    `UPDATE org_predefines SET ${setClauses.join(", ")}
     WHERE predefine_id = $${params.length - 1} AND org_id = $${params.length}
     RETURNING predefine_id, keyword, extra_keywords, content, ticket_type_ids`,
    params,
  );
  return json({ predefine: serializePredefine(rows[0]) });
}

async function handleDeleteOrgPredefine(request, orgId, predefineId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "predefines_manage")) {
    return json(
      { error: "Forbidden: predefines_manage permission required" },
      403,
    );
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
    return json(
      { error: "Forbidden: toxicity_manage permission required" },
      403,
    );
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
  try {
    await redis.del(`org:toxicity:${orgId}`);
  } catch {}
  return json({
    yellow: Array.isArray(row?.yellow) ? row.yellow : [],
    red: Array.isArray(row?.red) ? row.red : [],
  });
}

// ── AI Moderation triggers ───────────────────────────────────────────────────

async function handleListAIModerationTriggers(request, orgId) {
  const { session, error } = await requireOrgMemberOrAdmin(request, orgId);
  if (error) return error;
  void session;

  const { rows } = await pool.query(
    `SELECT trigger_id, category, threshold, action, mute_duration_minutes,
            apply_to_all_servers, enabled, created_at, updated_at
     FROM org_ai_moderation_triggers
     WHERE org_id = $1
     ORDER BY category, threshold DESC`,
    [orgId],
  );

  const [hasKey, rateInfo] = await Promise.all([
    getOrgOpenAIKey(orgId).then((k) => k !== null),
    getOrgModerationRateInfo(orgId),
  ]);

  return json({
    triggers: rows.map((r) => ({
      triggerId: String(r.trigger_id),
      category: r.category,
      threshold: Number(r.threshold),
      action: r.action,
      muteDurationMinutes:
        r.mute_duration_minutes != null
          ? Number(r.mute_duration_minutes)
          : null,
      applyToAllServers: Boolean(r.apply_to_all_servers),
      enabled: Boolean(r.enabled),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    })),
    hasOpenAIKey: hasKey,
    rateInfo,
  });
}

async function handleCreateAIModerationTrigger(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "toxicity_manage"))
    return json(
      { error: "Forbidden: toxicity_manage permission required" },
      403,
    );

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const category = String(body?.category ?? "").trim();
  if (!AI_MODERATION_CATEGORIES.includes(category))
    return json({ error: "Invalid category" }, 400);

  const threshold = Number(body?.threshold ?? 0.8);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    return json({ error: "threshold must be between 0 and 1" }, 400);

  const action = String(body?.action ?? "highlight");
  if (!["highlight", "automute"].includes(action))
    return json({ error: "action must be highlight or automute" }, 400);

  const rawDuration = body?.muteDurationMinutes;
  const muteDurationMinutes =
    rawDuration == null ? null : Math.max(1, Math.floor(Number(rawDuration)));

  const { rows } = await pool.query(
    `INSERT INTO org_ai_moderation_triggers
       (org_id, category, threshold, action, mute_duration_minutes, apply_to_all_servers, created_by)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6)
     RETURNING trigger_id, category, threshold, action, mute_duration_minutes,
               apply_to_all_servers, enabled, created_at, updated_at`,
    [orgId, category, threshold, action, muteDurationMinutes, session.userId],
  );
  const r = rows[0];
  return json(
    {
      triggerId: String(r.trigger_id),
      category: r.category,
      threshold: Number(r.threshold),
      action: r.action,
      muteDurationMinutes:
        r.mute_duration_minutes != null
          ? Number(r.mute_duration_minutes)
          : null,
      applyToAllServers: Boolean(r.apply_to_all_servers),
      enabled: Boolean(r.enabled),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    },
    201,
  );
}

async function handleUpdateAIModerationTrigger(request, orgId, triggerId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "toxicity_manage"))
    return json(
      { error: "Forbidden: toxicity_manage permission required" },
      403,
    );

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const sets = [`updated_at = unix_now()`];
  const params = [triggerId, orgId];
  let idx = 3;

  if ("threshold" in body) {
    const v = Number(body.threshold);
    if (!Number.isFinite(v) || v < 0 || v > 1)
      return json({ error: "threshold must be between 0 and 1" }, 400);
    sets.push(`threshold = $${idx++}`);
    params.push(v);
  }
  if ("action" in body) {
    if (!["highlight", "automute"].includes(body.action))
      return json({ error: "action must be highlight or automute" }, 400);
    sets.push(`action = $${idx++}`);
    params.push(body.action);
  }
  if ("muteDurationMinutes" in body) {
    const v =
      body.muteDurationMinutes == null
        ? null
        : Math.max(1, Math.floor(Number(body.muteDurationMinutes)));
    sets.push(`mute_duration_minutes = $${idx++}`);
    params.push(v);
  }
  if ("enabled" in body) {
    sets.push(`enabled = $${idx++}`);
    params.push(Boolean(body.enabled));
  }

  const { rows } = await pool.query(
    `UPDATE org_ai_moderation_triggers
     SET ${sets.join(", ")}
     WHERE trigger_id = $1 AND org_id = $2
     RETURNING trigger_id, category, threshold, action, mute_duration_minutes,
               apply_to_all_servers, enabled, created_at, updated_at`,
    params,
  );
  if (!rows[0]) return json({ error: "Trigger not found" }, 404);
  const r = rows[0];
  return json({
    triggerId: String(r.trigger_id),
    category: r.category,
    threshold: Number(r.threshold),
    action: r.action,
    muteDurationMinutes:
      r.mute_duration_minutes != null ? Number(r.mute_duration_minutes) : null,
    applyToAllServers: Boolean(r.apply_to_all_servers),
    enabled: Boolean(r.enabled),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

async function handleDeleteAIModerationTrigger(request, orgId, triggerId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "toxicity_manage"))
    return json(
      { error: "Forbidden: toxicity_manage permission required" },
      403,
    );

  const res = await pool.query(
    `DELETE FROM org_ai_moderation_triggers WHERE trigger_id = $1 AND org_id = $2`,
    [triggerId, orgId],
  );
  if (res.rowCount === 0) return json({ error: "Trigger not found" }, 404);
  return json({ ok: true });
}

// ── AI Moderation: flagged messages ─────────────────────────────────────────

async function handleListFlaggedMessages(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "toxicity_manage") &&
    !orgHasPermission(session, orgId, "flagged_messages_resolve") &&
    !orgHasPermission(session, orgId, "flagged_messages_confirm") &&
    !orgHasPermission(session, orgId, "flagged_messages_clear")
  )
    return json(
      {
        error:
          "Forbidden: requires toxicity_manage, flagged_messages_resolve, flagged_messages_confirm, or flagged_messages_clear",
      },
      403,
    );

  const url = new URL(request.url);
  const resolvedParam = url.searchParams.get("resolved");
  const resolved =
    resolvedParam === "true" ? true : resolvedParam === "false" ? false : null;
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
  );
  const rowLimit = Math.min(500, limit * 5);

  const conditions = ["f.org_id = $1"];
  const params = [orgId];
  let idx = 2;

  if (resolved !== null) {
    conditions.push(`f.resolved = $${idx++}`);
    params.push(resolved);
  }

  const [{ rows }, countRes] = await Promise.all([
    pool.query(
      `SELECT f.flag_id, f.chat_log_id, f.server_id, f.steam_id, f.player_name,
              f.message, f.triggered_category, f.score, f.action, f.signals,
              f.resolved, f.resolved_at, f.resolution_type, f.created_at,
              u.username AS resolved_by_name,
              s.server_name
       FROM ai_chat_flags f
       LEFT JOIN users u ON u.user_id = f.resolved_by
       LEFT JOIN servers s ON s.server_id = f.server_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY f.created_at DESC
       LIMIT $${idx}`,
      [...params, rowLimit],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM (
         SELECT COALESCE(chat_log_id::text, flag_id::text) AS grouped_id
         FROM ai_chat_flags
         WHERE org_id = $1 AND resolved = TRUE
         GROUP BY COALESCE(chat_log_id::text, flag_id::text)
       ) grouped`,
      [orgId],
    ),
  ]);

  const grouped = new Map();
  for (const row of rows) {
    const key = row.chat_log_id
      ? `chat:${row.chat_log_id}`
      : `flag:${row.flag_id}`;
    const existing = grouped.get(key);

    let signalEntries = [];
    if (row.signals && typeof row.signals === "object") {
      signalEntries = Object.entries(row.signals).map(([category, score]) => ({
        category,
        score: Number(score),
      }));
    }
    if (!signalEntries.length && row.triggered_category) {
      signalEntries = [
        {
          category: row.triggered_category,
          score: Number(row.score),
        },
      ];
    }

    if (!existing) {
      grouped.set(key, {
        flagId: row.flag_id,
        chatLogId: row.chat_log_id ? String(row.chat_log_id) : null,
        serverId: row.server_id,
        serverName: row.server_name ?? null,
        steamId: row.steam_id,
        playerName: row.player_name,
        message: row.message,
        action: row.action,
        resolved: row.resolved,
        resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
        resolutionType: row.resolution_type ?? null,
        resolvedByName: row.resolved_by_name ?? null,
        createdAt: Number(row.created_at),
        signalScores: new Map(
          signalEntries.map((entry) => [entry.category, Number(entry.score)]),
        ),
      });
      continue;
    }

    if (row.action === "automute") existing.action = "automute";
    if (row.created_at > existing.createdAt) {
      existing.createdAt = Number(row.created_at);
      existing.flagId = row.flag_id;
    }
    if (!existing.serverName && row.server_name)
      existing.serverName = row.server_name;
    for (const entry of signalEntries) {
      const prior = existing.signalScores.get(entry.category);
      const nextScore = Number(entry.score);
      if (prior == null || nextScore > prior) {
        existing.signalScores.set(entry.category, nextScore);
      }
    }
  }

  const flags = Array.from(grouped.values())
    .map((group) => {
      const signals = Array.from(group.signalScores.entries())
        .map(([category, score]) => ({ category, score: Number(score) }))
        .sort((a, b) => b.score - a.score);
      const topSignal = signals[0] ?? { category: null, score: 0 };
      return {
        flagId: group.flagId,
        chatLogId: group.chatLogId,
        serverId: group.serverId,
        serverName: group.serverName,
        steamId: group.steamId,
        playerName: group.playerName,
        message: group.message,
        triggeredCategory: topSignal.category,
        score: Number(topSignal.score ?? 0),
        signals,
        action: group.action,
        resolved: group.resolved,
        resolvedAt: group.resolvedAt,
        resolutionType: group.resolutionType,
        resolvedByName: group.resolvedByName,
        createdAt: group.createdAt,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  return json({
    flags,
    totalReviewed: countRes.rows[0]?.total ?? 0,
  });
}

async function handleStreamFlaggedMessages(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "toxicity_manage") &&
    !orgHasPermission(session, orgId, "flagged_messages_resolve") &&
    !orgHasPermission(session, orgId, "flagged_messages_confirm") &&
    !orgHasPermission(session, orgId, "flagged_messages_clear")
  )
    return json(
      {
        error:
          "Forbidden: requires toxicity_manage, flagged_messages_resolve, flagged_messages_confirm, or flagged_messages_clear",
      },
      403,
    );

  let entry;
  let heartbeat;
  const stream = new ReadableStream({
    start(controller) {
      entry = { controller };
      if (!flaggedStreams.has(orgId)) flaggedStreams.set(orgId, new Set());
      flaggedStreams.get(orgId).add(entry);
      controller.enqueue(sseEncoder.encode(": connected\n\n"));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(sseEncoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25000);
    },
    cancel() {
      clearInterval(heartbeat);
      const set = flaggedStreams.get(orgId);
      if (set) {
        set.delete(entry);
        if (set.size === 0) flaggedStreams.delete(orgId);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function handleResolveFlaggedMessage(request, orgId, flagId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const type = body?.type;
  if (!["confirmed", "cleared"].includes(type))
    return json({ error: "type must be 'confirmed' or 'cleared'" }, 400);

  const hasResolve = orgHasPermission(
    session,
    orgId,
    "flagged_messages_resolve",
  );
  const hasToxicity = orgHasPermission(session, orgId, "toxicity_manage");
  const canConfirm =
    hasResolve ||
    hasToxicity ||
    orgHasPermission(session, orgId, "flagged_messages_confirm");
  const canClear =
    hasResolve ||
    hasToxicity ||
    orgHasPermission(session, orgId, "flagged_messages_clear");

  if (type === "confirmed" && !canConfirm)
    return json(
      {
        error:
          "Forbidden: flagged_messages_confirm (or flagged_messages_resolve) permission required",
      },
      403,
    );
  if (type === "cleared" && !canClear)
    return json(
      {
        error:
          "Forbidden: flagged_messages_clear (or flagged_messages_resolve) permission required",
      },
      403,
    );

  const rl = await checkRateLimit(
    `rl:flag-resolve:${session.userId}`,
    FLAG_RESOLVE_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (rl) return rl;

  const { rows } = await pool.query(
    `WITH target AS (
       SELECT flag_id, chat_log_id
       FROM ai_chat_flags
       WHERE flag_id = $3 AND org_id = $4
       LIMIT 1
     )
     UPDATE ai_chat_flags f
     SET resolved = TRUE,
         resolved_by = $1,
         resolved_at = unix_now(),
         resolution_type = $2
     FROM target t
     WHERE f.org_id = $4
       AND f.resolved = FALSE
       AND (
         f.flag_id = t.flag_id
         OR (t.chat_log_id IS NOT NULL AND f.chat_log_id = t.chat_log_id)
       )
     RETURNING f.flag_id`,
    [session.userId, type, flagId, orgId],
  );
  if (!rows[0]) {
    const { rows: existingRows } = await pool.query(
      `SELECT f.resolved, f.resolution_type, f.resolved_at, u.username AS resolved_by_name
       FROM ai_chat_flags f
       LEFT JOIN users u ON u.user_id = f.resolved_by
       WHERE f.flag_id = $1 AND f.org_id = $2
       LIMIT 1`,
      [flagId, orgId],
    );

    const existing = existingRows[0];
    if (existing?.resolved) {
      return json(
        {
          error: "Flag already resolved by another moderator",
          conflict: true,
          resolutionType: existing.resolution_type ?? null,
          resolvedAt: existing.resolved_at
            ? Number(existing.resolved_at)
            : null,
          resolvedByName: existing.resolved_by_name ?? null,
        },
        409,
      );
    }

    return json({ error: "Flag not found" }, 404);
  }

  redis
    .publish(
      `flagged-stream:${orgId}`,
      JSON.stringify({
        type: "flag_resolved",
        orgId,
        flagId,
        resolutionType: type,
        resolvedBy: session.userId,
        at: nowUnix(),
      }),
    )
    .catch(() => {});

  return json({ ok: true });
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
    return json(
      { error: "Forbidden: ban_configs_manage permission required" },
      403,
    );
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
  try {
    await redis.del(`org:ban-config:${orgId}`);
  } catch {}
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
    return json(
      { error: "Forbidden: ban_configs_manage permission required" },
      403,
    );
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
  try {
    await redis.del(`org:ban-config:${orgId}`);
  } catch {}
  return json({
    reason: { id: String(rows[0].reason_id), label: String(rows[0].label) },
  });
}

async function handleDeleteBanReason(request, orgId, reasonId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "ban_configs_manage")) {
    return json(
      { error: "Forbidden: ban_configs_manage permission required" },
      403,
    );
  }

  const res = await pool.query(
    `DELETE FROM org_ban_reasons WHERE reason_id = $1 AND org_id = $2`,
    [reasonId, orgId],
  );
  if (res.rowCount === 0) return json({ error: "Reason not found" }, 404);
  try {
    await redis.del(`org:ban-config:${orgId}`);
  } catch {}
  return json({ ok: true });
}

async function handleSetBanNoteFormat(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "ban_configs_manage")) {
    return json(
      { error: "Forbidden: ban_configs_manage permission required" },
      403,
    );
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
  try {
    await redis.del(`org:ban-config:${orgId}`);
  } catch {}
  return json({ ok: true, category, noteFormat });
}

// ── Plugin presets ────────────────────────────────────────────────────────────

async function handleListPlugins(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
    return json(
      { error: "Forbidden: presets_manage permission required" },
      403,
    );
  }

  const [{ rows }, serversRes] = await Promise.all([
    pool.query(
      `SELECT plugin_id, name, source, umod_slug, installed_version, latest_version,
              latest_updated_at, assigned_tags, risk, enabled, created_at
       FROM org_plugins WHERE org_id = $1 ORDER BY name ASC`,
      [orgId],
    ),
    pool.query(
      `SELECT server_id::text AS server_id, server_name, tags
       FROM servers WHERE owner_org_id = $1`,
      [orgId],
    ),
  ]);

  // Surface which servers each plugin lands on: a server is a target when any of
  // its group tags is in the plugin's assigned tags (same rule getServersForRcon
  // uses for push/unload). Lets the UI show a "which servers" column.
  const allServers = serversRes.rows.map((s) => ({
    id: s.server_id,
    name: s.server_name,
    tags: Array.isArray(s.tags) ? s.tags : [],
  }));
  const serversForTags = (assigned) => {
    const set = new Set(assigned);
    return allServers
      .filter((s) => s.tags.some((t) => set.has(t)))
      .map((s) => ({ id: s.id, name: s.name }));
  };

  return json({
    plugins: rows.map((r) => {
      const assignedTags = Array.isArray(r.assigned_tags)
        ? r.assigned_tags
        : [];
      return {
        id: r.plugin_id,
        name: r.name,
        source: r.source,
        umodSlug: r.umod_slug ?? null,
        installedVersion: r.installed_version ?? null,
        latestVersion: r.latest_version ?? null,
        latestUpdatedAt: r.latest_updated_at ?? null,
        assignedTags,
        risk: r.risk,
        enabled: r.enabled,
        createdAt: r.created_at,
        servers: serversForTags(assignedTags),
      };
    }),
    // All distinct group tags configured across the org's servers, so the UI can
    // offer them when assigning tags to a plugin.
    availableTags: [...new Set(allServers.flatMap((s) => s.tags))].sort(),
  });
}

async function handleCreatePlugin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
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
    return json(
      { error: "Forbidden: presets_manage permission required" },
      403,
    );
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
    return json(
      { error: "Forbidden: presets_manage permission required" },
      403,
    );
  }

  // action "reload" (default) pushes/updates the plugin; "unload" stops it.
  let action = "reload";
  try {
    const body = await request.json();
    if (body?.action === "unload") action = "unload";
  } catch {
    /* no body → default reload */
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
  const command = action === "unload" ? "oxide.unload" : "oxide.reload";

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
          await executeRconCommand(rconUrl, `${command} ${safeName}`);
          results.pushed.push(s.server_id);
        } catch {
          results.failed.push(s.server_id);
        }
      }),
    );
  }

  // Only a real reload marks the installed version as caught up to latest.
  if (action === "reload" && latest_version) {
    await pool.query(
      `UPDATE org_plugins SET installed_version = latest_version WHERE plugin_id = $1`,
      [pluginId],
    );
  }

  return json({ ok: true, action, ...results });
}

async function handleUnloadRisk(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
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

// Look up a plugin's latest published version from umod.org. uMod exposes a JSON
// document per plugin slug; we read the latest release version + timestamp.
async function fetchUmodLatest(slug) {
  try {
    const res = await fetch(
      `https://umod.org/plugins/${encodeURIComponent(slug)}.json`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    const version =
      data.latest_release_version ?? data.version ?? data.tag ?? null;
    const at = data.latest_release_at ?? data.updated_at ?? null;
    const updatedAt = at ? Math.floor(new Date(at).getTime() / 1000) : null;
    if (!version) return null;
    return {
      version: String(version),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    };
  } catch {
    return null;
  }
}

// Refresh latest-version info for all of an org's umod-sourced plugins by
// scraping their umod plugin pages. Custom-uploaded plugins are skipped (no
// upstream to check). Best-effort: individual lookups that fail are ignored.
async function handleRefreshPluginVersions(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "presets_manage")) {
    return json(
      { error: "Forbidden: presets_manage permission required" },
      403,
    );
  }

  // Outward-facing scrape against umod — cap per-org so it can't be hammered.
  const rl = await checkRateLimit(`rl:plugin-versions:${orgId}`, 6, 60);
  if (rl) return rl;

  const { rows } = await pool.query(
    `SELECT plugin_id, umod_slug FROM org_plugins
     WHERE org_id = $1 AND source = 'umod' AND umod_slug IS NOT NULL`,
    [orgId],
  );

  let updated = 0;
  await Promise.allSettled(
    rows.map(async (p) => {
      const latest = await fetchUmodLatest(p.umod_slug);
      if (!latest) return;
      await pool.query(
        `UPDATE org_plugins
         SET latest_version = $2,
             latest_updated_at = COALESCE($3, latest_updated_at)
         WHERE plugin_id = $1`,
        [p.plugin_id, latest.version, latest.updatedAt],
      );
      updated += 1;
    }),
  );

  return json({ ok: true, checked: rows.length, updated });
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
    const failedMatch = trimmed.match(
      /^\d+\s+(\S+)\s+-\s+Failed to compile:\s*(.*)/,
    );
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
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name) || name.includes("..")) return null;
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
  const {
    owner_org_id,
    ptero_identifier,
    rcon_host,
    rcon_port,
    rcon_password_enc,
  } = serverRes.rows[0];

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
    rconAvailable:
      rcon_host != null && rcon_port != null && rcon_password_enc != null,
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
  const {
    owner_org_id,
    ptero_identifier,
    rcon_host,
    rcon_port,
    rcon_password_enc,
  } = serverRes.rows[0];

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
    ? allServerRows.filter((s) => requestedIds.includes(s.server_id))
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
    ? rawServerIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
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
  if (
    !orgHasPermission(session, owner_org_id, "rcon_access") &&
    !orgHasPermission(session, owner_org_id, "status_view")
  ) {
    return json(
      { error: "Forbidden: rcon_access or status_view permission required" },
      403,
    );
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
          settle(resolve, { response: String(msg.Message ?? ""), consoleLogs });
          try {
            ws.close(1000, "Done");
          } catch {
            /* noop */
          }
        } else if (msg.Identifier === -1 && commandSent) {
          consoleLogs.push(String(msg.Message ?? ""));
        }
      } catch {
        // ignore non-JSON messages
      }
    });

    ws.addEventListener("error", (event) => {
      const detail =
        event?.message || event?.error?.message || event?.error?.code || "";
      settle(
        reject,
        new Error(
          detail
            ? `RCON connection failed: ${detail}`
            : "RCON connection failed",
        ),
      );
    });

    ws.addEventListener("close", ({ code }) => {
      if (code !== 1000 && code !== 1001) {
        settle(reject, new Error(`RCON disconnected (${code})`));
      }
    });
  });
}

// Run several commands over a SINGLE RCON connection, sequentially. Rust's
// WebRcon refuses rapid reconnects, so opening one socket per command (as the
// single-shot helper does) is unreliable when issuing many commands in a burst.
// Admin-provisioning commands (moderatorid / usergroup) don't need their output,
// so we fire each, give the server a brief moment, then close cleanly.
function executeRconCommandSequence(rconUrl, commands) {
  return new Promise((resolve, reject) => {
    let settled = false;
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

    ws.addEventListener("open", () => {
      try {
        commands.forEach((cmd, i) => {
          ws.send(
            JSON.stringify({
              Identifier: 2000 + i,
              Message: cmd,
              Name: "WebRcon",
            }),
          );
        });
      } catch (err) {
        settle(reject, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // Let the server process the queued commands before closing.
      setTimeout(() => {
        try {
          ws.close(1000, "Done");
        } catch {
          /* noop */
        }
        settle(resolve, true);
      }, 750);
    });

    ws.addEventListener("error", (event) => {
      const detail =
        event?.message || event?.error?.message || event?.error?.code || "";
      settle(
        reject,
        new Error(
          detail
            ? `RCON connection failed: ${detail}`
            : "RCON connection failed",
        ),
      );
    });

    ws.addEventListener("close", ({ code }) => {
      if (code !== 1000 && code !== 1001) {
        settle(reject, new Error(`RCON disconnected (${code})`));
      }
    });
  });
}

// ── Server-admin (in-game admin) provisioning via RCON ───────────────────────
//
// A role holding the `server_admin` permission grants its members in-game admin
// on a set of servers. Built-in Owner/Admin cover ALL of the org's servers;
// custom roles either cover all (roles.server_admin_all) or an explicit list
// (role_server_admin). When a member gains access we run, per server:
//   moderatorid <steamId> "<name>"   +   o.usergroup add <steamId> admin
// and when they lose it:
//   removemoderator <steamId>        +   o.usergroup remove <steamId> admin
// All RCON work here is best-effort and never throws into the request path.

const SERVER_ADMIN_BUILTIN_ROLES = new Set(["org_admin", "org_owner"]);

async function roleHasServerAdmin(roleId) {
  if (SERVER_ADMIN_BUILTIN_ROLES.has(roleId)) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM role_permissions
     WHERE role_id = $1 AND permission_id = 'server_admin' LIMIT 1`,
    [roleId],
  );
  return rows.length > 0;
}

async function allOrgServerIds(orgId) {
  const { rows } = await pool.query(
    `SELECT server_id::text AS server_id FROM servers WHERE owner_org_id = $1`,
    [orgId],
  );
  return rows.map((r) => r.server_id);
}

// Concrete list of server_ids (within orgId) a role's server_admin applies to.
// Returns [] when the role does not grant server_admin.
async function resolveRoleServerAdminServerIds(orgId, roleId) {
  if (!roleId) return [];
  if (!(await roleHasServerAdmin(roleId))) return [];
  if (SERVER_ADMIN_BUILTIN_ROLES.has(roleId))
    return await allOrgServerIds(orgId);

  const allRes = await pool.query(
    `SELECT server_admin_all FROM roles WHERE role_id = $1 LIMIT 1`,
    [roleId],
  );
  if (allRes.rows[0]?.server_admin_all) return await allOrgServerIds(orgId);

  const { rows } = await pool.query(
    `SELECT rsa.server_id::text AS server_id
     FROM role_server_admin rsa
     JOIN servers s ON s.server_id = rsa.server_id
     WHERE rsa.role_id = $1 AND s.owner_org_id = $2`,
    [roleId, orgId],
  );
  return rows.map((r) => r.server_id);
}

// Load RCON-capable server rows for an explicit list of ids (within orgId).
async function loadRconServersByIds(orgId, serverIds) {
  if (!Array.isArray(serverIds) || serverIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT server_id::text AS server_id, server_name,
            rcon_host, rcon_port, rcon_password_enc
     FROM servers
     WHERE owner_org_id = $1 AND server_id = ANY($2::uuid[])
       AND rcon_host IS NOT NULL AND rcon_port IS NOT NULL
       AND rcon_password_enc IS NOT NULL`,
    [orgId, serverIds],
  );
  return rows;
}

function sanitizeRconName(name) {
  const cleaned = String(name ?? "")
    .replace(/["\r\n]/g, "")
    .trim()
    .slice(0, 32);
  return cleaned || "staff";
}

function serverAdminGrantCommands(steamId, name) {
  return [
    `moderatorid ${steamId} "${sanitizeRconName(name)}"`,
    `o.usergroup add ${steamId} admin`,
  ];
}

function serverAdminRevokeCommands(steamId) {
  return [`removemoderator ${steamId}`, `o.usergroup remove ${steamId} admin`];
}

async function runRconCommandsOnServer(serverRow, commands) {
  let password;
  try {
    password = decryptPterodactylApiKey(serverRow.rcon_password_enc);
  } catch {
    return {
      serverId: serverRow.server_id,
      serverName: serverRow.server_name,
      ok: false,
      error: "RCON credentials corrupted",
    };
  }
  const rconUrl = `ws://${serverRow.rcon_host}:${serverRow.rcon_port}/${encodeURIComponent(password)}`;
  try {
    // All commands over one connection to avoid rapid-reconnect refusals.
    await executeRconCommandSequence(rconUrl, commands);
    return {
      serverId: serverRow.server_id,
      serverName: serverRow.server_name,
      ok: true,
    };
  } catch (err) {
    return {
      serverId: serverRow.server_id,
      serverName: serverRow.server_name,
      ok: false,
      error: String(err?.message ?? err),
    };
  }
}

// Small pause between RCON connections so a burst of grants doesn't trip Rust's
// reconnect throttling.
function rconPause() {
  return new Promise((r) => setTimeout(r, 200));
}

// Reconcile a single member from one server-admin server set to another.
// `member` must have { steam_id, username }. Grants on (target − current) and
// revokes on (current − target). Never throws.
async function applyMemberServerAdmin(orgId, member, currentIds, targetIds) {
  const steamId = member?.steam_id;
  if (!steamId) return { skipped: "member has no linked Steam account" };

  const curSet = new Set(currentIds ?? []);
  const tgtSet = new Set(targetIds ?? []);
  const toGrant = [...tgtSet].filter((id) => !curSet.has(id));
  const toRevoke = [...curSet].filter((id) => !tgtSet.has(id));

  const results = { granted: [], revoked: [] };
  try {
    if (toGrant.length) {
      const servers = await loadRconServersByIds(orgId, toGrant);
      const cmds = serverAdminGrantCommands(steamId, member.username);
      for (const s of servers) {
        results.granted.push(await runRconCommandsOnServer(s, cmds));
        await rconPause();
      }
    }
    if (toRevoke.length) {
      const servers = await loadRconServersByIds(orgId, toRevoke);
      const cmds = serverAdminRevokeCommands(steamId);
      for (const s of servers) {
        results.revoked.push(await runRconCommandsOnServer(s, cmds));
        await rconPause();
      }
    }
  } catch (err) {
    console.error("applyMemberServerAdmin failed:", err);
  }
  return results;
}

// Convenience used by member role-change / removal paths: resolve old + new
// role scopes for a member and apply the diff. Best-effort.
async function syncMemberServerAdminForRoleChange(
  orgId,
  member,
  oldRoleId,
  newRoleId,
) {
  try {
    const currentIds = await resolveRoleServerAdminServerIds(orgId, oldRoleId);
    const targetIds = await resolveRoleServerAdminServerIds(orgId, newRoleId);
    return await applyMemberServerAdmin(orgId, member, currentIds, targetIds);
  } catch (err) {
    console.error("syncMemberServerAdminForRoleChange failed:", err);
    return null;
  }
}

// POST /api/orgs/:orgId/sync-server-admin
// Re-runs the in-game admin grant for every member whose role currently grants
// the server_admin permission, across each member's scoped servers. Used by the
// "Sync Perms to Servers" button for the built-in Owner/Admin roles.
async function handleSyncServerAdmin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  // RCON-heavy; cap how often a sync can be triggered per org.
  const rl = await checkRateLimit(`rl:sync-server-admin:${orgId}`, 3, 60);
  if (rl) return rl;

  const { rows: members } = await pool.query(
    `SELECT om.role_id, u.steam_id, u.username
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND u.steam_id IS NOT NULL`,
    [orgId],
  );

  // Resolve scope per distinct role once.
  const scopeCache = new Map();
  let memberCount = 0;
  let serverGrantCount = 0;
  let failureCount = 0;
  const sampleErrors = [];

  for (const m of members) {
    if (!scopeCache.has(m.role_id)) {
      scopeCache.set(
        m.role_id,
        await resolveRoleServerAdminServerIds(orgId, m.role_id),
      );
    }
    const targetIds = scopeCache.get(m.role_id);
    if (!targetIds.length) continue;
    memberCount++;
    // Force a full re-grant (current = []), so every command re-runs.
    const res = await applyMemberServerAdmin(orgId, m, [], targetIds);
    for (const r of res?.granted ?? []) {
      serverGrantCount++;
      if (!r.ok) {
        failureCount++;
        if (sampleErrors.length < 3 && r.error) {
          sampleErrors.push(`${r.serverName ?? r.serverId}: ${r.error}`);
        }
      }
    }
  }

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "org",
    resourceId: orgId,
    actionType: "SERVER_ADMIN_SYNCED",
    actionCategory: "staff_management",
    severity: 2,
    metadata: { memberCount, serverGrantCount, failureCount, sampleErrors },
    ipAddress: getClientIp(request),
  });

  return json({
    ok: true,
    membersSynced: memberCount,
    serverGrants: serverGrantCount,
    failures: failureCount,
    sampleErrors,
  });
}

// ── Threat triggers config ───────────────────────────────────────────────────

async function handleGetThreatTriggers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "triggers_manage")) {
    return json(
      { error: "Forbidden: triggers_manage permission required" },
      403,
    );
  }
  const config = await getThreatTriggerConfigOrDefault(orgId);
  return json({ config, facts: TRIGGER_FACTS });
}

async function handleSaveThreatTriggers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "triggers_manage")) {
    return json(
      { error: "Forbidden: triggers_manage permission required" },
      403,
    );
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const config = await saveThreatTriggerConfig(
    orgId,
    body?.config ?? body,
    session.userId,
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "org",
    resourceId: orgId,
    actionType: "THREAT_TRIGGERS_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: {
      signals: config.signals.length,
      blocks: config.blocks.length,
      boughtAccount: config.boughtAccount.enabled,
    },
  });

  return json({ ok: true, config });
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
  return json({
    ok: true,
    response: rconResult.response,
    consoleLogs: rconResult.consoleLogs,
  });
}

// Live console feed (SSE). Opens a passive RCON WebSocket and forwards every
// console message to the browser. Rust's WebRcon broadcasts console output
// (Identifier -1) to ALL connected clients, so commands issued through the exec
// endpoint also surface here — giving staff a constant feed to confirm a command
// actually took effect, not just that the request returned 200.
async function handleRconConsoleStream(request, serverId) {
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

  // Lenient cap — EventSource auto-reconnects, so each (re)connect counts. This
  // only stops a wildly looping client from opening RCON sockets unbounded.
  const rl = await checkRateLimit(
    `rl:rcon-stream:${session.userId}:${serverId}`,
    20,
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

  const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(rconPassword)}`;

  let ws;
  let heartbeat;
  let maxLifetime;
  let closed = false;
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (chunk) => {
        try {
          controller.enqueue(sseEncoder.encode(chunk));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };
      const sendEvent = (obj) => enqueue(`data: ${JSON.stringify(obj)}\n\n`);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(maxLifetime);
        try {
          ws?.close();
        } catch {
          /* noop */
        }
        try {
          controller.close();
        } catch {
          /* noop */
        }
      };

      enqueue(": connected\n\n");

      try {
        ws = new WebSocket(rconUrl);
      } catch {
        sendEvent({ type: "error", message: "Failed to open RCON connection" });
        cleanup();
        return;
      }

      ws.addEventListener("open", () => {
        sendEvent({ type: "status", message: "connected" });
      });

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          sendEvent({
            type: "log",
            message: String(msg.Message ?? ""),
            identifier: msg.Identifier ?? null,
          });
        } catch {
          sendEvent({ type: "log", message: String(event.data ?? "") });
        }
      });

      ws.addEventListener("error", () => {
        sendEvent({ type: "error", message: "RCON connection error" });
      });

      ws.addEventListener("close", ({ code }) => {
        sendEvent({ type: "status", message: `disconnected (${code})` });
        cleanup();
      });

      heartbeat = setInterval(() => {
        enqueue(": ping\n\n");
      }, 25000);

      // Cap one feed session so a forgotten tab can't pin an RCON socket open
      // forever; the browser's EventSource reconnects transparently afterward.
      maxLifetime = setTimeout(cleanup, 30 * 60 * 1000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ── Ban / Mute handlers ──────────────────────────────────────────────────────

async function handleListOrgBans(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canAccessBans(session, orgId))
    return json({ error: "Forbidden: ban permission required" }, 403);

  const url = new URL(request.url);
  const actionType = url.searchParams.get("type") ?? "ban";
  const identifierSearch = url.searchParams.get("identifier") ?? null;
  const canSeeIpInBans =
    canManageOrg(session, orgId) || orgHasPermission(session, orgId, "ip_read");

  // For IP ban searches, compare against identifier_hash (HMAC of the IP).
  // For steam_id searches, use the plaintext identifier column directly.
  const isIpSearch =
    identifierSearch != null &&
    /^(\d{1,3}\.){3}\d{1,3}$|^[\da-fA-F:]{2,}$/.test(identifierSearch.trim());
  const identifierHashSearch = isIpSearch
    ? ipHmac(identifierSearch.trim())
    : null;

  const { rows } = await pool.query(
    `SELECT b.ban_id, b.org_id, b.action_type, b.identifier, b.identifier_type,
            b.category, b.reason, b.note, b.expires_at, b.issued_at,
            b.issued_by, b.revoked, b.revoked_at, b.revoked_by,
            b.source_ip_ban_id, b.player_steam_id,
            u.username AS issued_by_name,
            COALESCE(
              json_agg(bst.server_id::text) FILTER (WHERE bst.server_id IS NOT NULL),
              '[]'::json
            ) AS server_ids,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'steamId', lb.identifier,
                 'name', pc.display_name
               ) ORDER BY lb.issued_at DESC)
               FROM player_bans lb
               LEFT JOIN player_cache pc ON pc.steam_id = lb.identifier
               WHERE lb.source_ip_ban_id = b.ban_id AND lb.identifier_type = 'steam_id'
               LIMIT 10),
              '[]'::json
            ) AS linked_bans
     FROM player_bans b
     LEFT JOIN users u ON u.user_id = b.issued_by
     LEFT JOIN ban_server_targets bst ON bst.ban_id = b.ban_id
     WHERE b.org_id = $1 AND b.action_type = $2
       AND (
         $3::text IS NULL
         OR (b.identifier_type != 'ip' AND b.identifier = $3)
         OR (b.identifier_type = 'ip' AND b.identifier_hash = $4)
       )
     GROUP BY b.ban_id, u.username
     ORDER BY b.issued_at DESC
     LIMIT 500`,
    [orgId, actionType, identifierSearch, identifierHashSearch],
  );

  return json({
    bans: rows.map((r) => ({
      banId: String(r.ban_id),
      orgId: String(r.org_id),
      actionType: String(r.action_type),
      // Decrypt IP bans for callers with ip_read / manage permission; others see null.
      identifier:
        r.identifier_type === "ip"
          ? canSeeIpInBans
            ? (decryptIp(r.identifier) ?? "[encrypted]")
            : null
          : String(r.identifier),
      identifierType: String(r.identifier_type),
      playerSteamId: r.player_steam_id ?? null,
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
      sourceIpBanId: r.source_ip_ban_id ? String(r.source_ip_ban_id) : null,
      linkedBans: Array.isArray(r.linked_bans) ? r.linked_bans : [],
    })),
  });
}

// Source orgs whose `category` records the caller may read, given a base
// permission gate (e.g. ban access): member orgs that pass `permFn`, plus orgs
// that shared `category` with one of them. Returns null for sysadmin (no filter).
async function entitledOrgsForCategory(session, category, permFn) {
  if (isConfiguredSysAdmin(session)) return null;
  const baseOrgs = sessionCandidateOrgIds(session, null).filter((o) =>
    permFn(o),
  );
  const result = new Set(baseOrgs);
  if (baseOrgs.length) {
    const { rows } = await pool.query(
      `SELECT DISTINCT owner_org_id FROM org_share_grants
       WHERE status = 'active' AND $2 = ANY(categories)
         AND grantee_org_id = ANY($1)`,
      [baseOrgs, category],
    );
    for (const r of rows) result.add(String(r.owner_org_id));
  }
  return result;
}

// Combined ban + mute history for a player across every org the caller is
// entitled to — their own orgs (with ban access) plus orgs that shared 'bans' /
// 'mutes' with them. Each row is tagged with its source org so the lookup page
// can show provenance and filter by the active org selection. Read-only across
// the sharing boundary: revoking/editing still goes through the owning org.
async function handleGetPlayerOffenses(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  const banOrgs = await entitledOrgsForCategory(session, "bans", (o) =>
    canAccessBans(session, o),
  );
  const muteOrgs = await entitledOrgsForCategory(session, "mutes", (o) =>
    canAccessBans(session, o),
  );

  const isSys = banOrgs === null; // sysadmin → no org filter
  const banArr = isSys ? [] : [...banOrgs];
  const muteArr = isSys ? [] : [...muteOrgs];
  if (!isSys && banArr.length === 0 && muteArr.length === 0)
    return json({ offenses: [] });

  const { rows } = await pool.query(
    `SELECT b.ban_id, b.org_id, b.action_type, b.category, b.reason, b.note,
            b.expires_at, b.issued_at, b.revoked, b.revoked_at,
            u.username AS issued_by_name, o.name AS org_name
     FROM player_bans b
     LEFT JOIN users u ON u.user_id = b.issued_by
     LEFT JOIN organizations o ON o.org_id = b.org_id
     WHERE b.identifier = $1 AND b.identifier_type = 'steam_id'
       AND (
         (b.action_type = 'ban'  AND ($2::boolean OR b.org_id = ANY($3)))
         OR
         (b.action_type = 'mute' AND ($4::boolean OR b.org_id = ANY($5)))
       )
     ORDER BY b.issued_at DESC
     LIMIT 500`,
    [steamId, isSys, banArr, isSys, muteArr],
  );

  return json({
    offenses: rows.map((r) => ({
      banId: String(r.ban_id),
      orgId: String(r.org_id),
      orgName: r.org_name ?? null,
      actionType: String(r.action_type),
      category: r.category ?? null,
      reason: r.reason ?? "",
      note: r.note ?? "",
      expiresAt: r.expires_at ? Number(r.expires_at) : null,
      issuedAt: Number(r.issued_at),
      issuedByName: r.issued_by_name ?? null,
      revoked: Boolean(r.revoked),
      revokedAt: r.revoked_at ? Number(r.revoked_at) : null,
    })),
  });
}

async function handleCreateBan(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canCreateBans(session, orgId))
    return json({ error: "Forbidden: ban create permission required" }, 403);

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
    mediaIds = [],
    playerSteamId: rawPlayerSteamId,
  } = body;
  const playerSteamId =
    rawPlayerSteamId && /^\d{17}$/.test(String(rawPlayerSteamId).trim())
      ? String(rawPlayerSteamId).trim()
      : null;

  // Cap free-text fields to bound DB writes and RCON command size.
  const reason = String(rawReason).slice(0, 500);
  const userNote = String(rawNote).slice(0, 1000);

  if (!identifier?.trim())
    return json({ error: "identifier is required" }, 400);
  const rawIdentifier = identifier.trim();
  if (!["steam_id", "ip"].includes(identifierType)) {
    return json({ error: "identifierType must be 'steam_id' or 'ip'" }, 400);
  }

  if (identifierType === "steam_id" && !/^\d{17}$/.test(rawIdentifier)) {
    return json({ error: "identifier must be a 17-digit Steam64 ID" }, 400);
  }
  if (identifierType === "ip" && !IP_ADDRESS_RE.test(rawIdentifier)) {
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
  // IP bans are a separate, off-by-default privilege (they also drive automatic
  // ban-evasion enforcement on connect), so they require the dedicated perm.
  if (identifierType === "ip" && !canIssueIpBans(session, orgId)) {
    return json({ error: "Forbidden: IP ban permission required" }, 403);
  }
  if (identifierType === "ip") {
    const eligibility = await evaluateIpBanEligibility(orgId, rawIdentifier);
    if (!eligibility.eligible) {
      return json({ error: eligibility.reason }, 400);
    }
  }

  const banId = crypto.randomUUID();
  let expiresAtUnix = null;
  if (expiresAt != null && expiresAt !== "") {
    const n = Number(expiresAt);
    if (!Number.isFinite(n) || n < 0)
      return json({ error: "expiresAt must be a valid Unix timestamp" }, 400);
    expiresAtUnix = Math.trunc(n);
  }

  // IP bans: store the address encrypted (for display) and its HMAC hash (for
  // fast lookups at connect time). Steam-ID bans keep identifier as plaintext.
  const storedIdentifier =
    identifierType === "ip" ? encryptIp(rawIdentifier) : rawIdentifier;
  const storedIdentifierHash =
    identifierType === "ip" ? ipHmac(rawIdentifier) : null;

  // Fetch teaminfo from all RCON-configured servers in the org before writing
  // the ban so we can attach the player's current team to the internal note.
  // Try all servers in parallel and use the first non-empty response.
  let teamInfoSuffix = "";
  if (identifierType === "steam_id") {
    try {
      const tiSrvRes = await pool.query(
        `SELECT rcon_host, rcon_port, rcon_password_enc
         FROM servers
         WHERE owner_org_id = $1
           AND rcon_host IS NOT NULL AND rcon_port IS NOT NULL AND rcon_password_enc IS NOT NULL`,
        [orgId],
      );
      if (tiSrvRes.rows.length > 0) {
        const tiResults = await Promise.allSettled(
          tiSrvRes.rows.map((srv) => {
            const pwd = decryptPterodactylApiKey(String(srv.rcon_password_enc));
            const rconUrl = `ws://${srv.rcon_host}:${srv.rcon_port}/${encodeURIComponent(pwd)}`;
            return executeRconCommand(rconUrl, `teaminfo ${rawIdentifier}`);
          }),
        );
        for (const r of tiResults) {
          if (r.status === "fulfilled") {
            const raw = (r.value?.response ?? "").trim();
            if (raw && !/no team|not found|invalid/i.test(raw)) {
              teamInfoSuffix = `\n\n[Team at ban time]\n${raw}`;
              break;
            }
          }
        }
      }
    } catch {}
  }
  const note = (userNote + teamInfoSuffix).slice(0, 2000);

  await pool.query(
    `INSERT INTO player_bans (ban_id, org_id, action_type, identifier, identifier_hash, identifier_type, category, reason, note, expires_at, issued_by, player_steam_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      banId,
      orgId,
      actionType,
      storedIdentifier,
      storedIdentifierHash,
      identifierType,
      category ?? null,
      reason,
      note,
      expiresAtUnix,
      session.userId,
      identifierType === "ip" ? (playerSteamId ?? null) : null,
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

  if (Array.isArray(mediaIds) && mediaIds.length > 0) {
    const safeMediaIds = mediaIds
      .filter((id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id))
      .slice(0, 20);
    if (safeMediaIds.length > 0) {
      const validMedia = await pool.query(
        `SELECT media_id FROM org_media WHERE media_id = ANY($1::uuid[]) AND org_id = $2 AND deleted = FALSE`,
        [safeMediaIds, orgId],
      );
      for (const row of validMedia.rows) {
        await pool.query(
          `INSERT INTO ban_media_links (ban_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [banId, String(row.media_id)],
        );
      }
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

    const safeId = identifier.trim();
    const safeReason =
      actionType !== "mute" && identifierType !== "ip"
        ? reason.replace(/[\r\n\x00-\x1f]/g, " ").replace(/"/g, "'")
        : null;
    const rconPromises = serversWithRcon.rows.map(async (srv) => {
      const password = decryptPterodactylApiKey(String(srv.rcon_password_enc));
      const rconUrl = `ws://${srv.rcon_host}:${srv.rcon_port}/${encodeURIComponent(password)}`;
      let command;
      if (actionType === "mute") {
        command = `mute ${safeId}`;
      } else if (identifierType === "ip") {
        command = `banip ${safeId}`;
      } else {
        command = `ban ${safeId} "${safeReason}"`;
      }
      return executeRconCommand(rconUrl, command)
        .then((result) => ({
          srv,
          ok: true,
          response: result.response,
        }))
        .catch((err) => ({
          srv,
          ok: false,
          error: String(err.message),
        }));
    });
    const rconOutcomes = await Promise.all(rconPromises);
    for (const outcome of rconOutcomes) {
      rconResults.push({
        serverId: String(outcome.srv.server_id),
        serverName: String(outcome.srv.server_name),
        ok: outcome.ok,
        ...(outcome.ok
          ? { response: outcome.response }
          : { error: outcome.error }),
      });
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

  if (expiresAtUnix != null) {
    scheduleBanExpiry(banId, expiresAtUnix).catch((e) =>
      console.error("[ban-expire] schedule failed:", e.message),
    );
  }

  const bmSyncCheck = await pool.query(
    "SELECT bm_auto_sync FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (bmSyncCheck.rows[0]?.bm_auto_sync === true) {
    if (actionType === "mute") {
      createBmNoteForMute(orgId, banId).catch((e) =>
        console.error("[bm-mute-note] fire-and-forget failed:", e.message),
      );
    } else {
      syncBanRecordToBattlemetrics(orgId, banId).catch((e) =>
        console.error("[bm-sync] fire-and-forget failed:", e.message),
      );
    }
  }

  return json({ ok: true, banId, rconResults }, 201);
}

async function handleUpdateBan(request, orgId, banId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canModifyBans(session, orgId))
    return json({ error: "Forbidden: ban modify permission required" }, 403);

  const banCheck = await pool.query(
    `SELECT ban_id, action_type, bm_ban_id FROM player_bans WHERE ban_id = $1 AND org_id = $2`,
    [banId, orgId],
  );
  if (!banCheck.rows[0]) return json({ error: "Ban not found" }, 404);
  const existingActionType = String(banCheck.rows[0].action_type);
  const existingBmBanId = banCheck.rows[0].bm_ban_id;

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
    params.push(String(body.note).slice(0, 2000));
    idx++;
  }
  let updatedExpiresAt; // undefined = not changed; null = made permanent
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
    updatedExpiresAt = expiresAtUnix;
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

  if (updatedExpiresAt !== undefined) {
    scheduleBanExpiry(banId, updatedExpiresAt).catch((e) =>
      console.error("[ban-expire] reschedule failed:", e.message),
    );
  }

  if (existingBmBanId && existingActionType !== "mute" && sets.length > 0) {
    syncBanRecordToBattlemetrics(orgId, banId).catch((e) =>
      console.error("[bm-sync] update patch failed:", e.message),
    );
  }

  return json({ ok: true });
}

async function handleRevokeBan(request, orgId, banId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "bans_delete"))
    return json({ error: "Forbidden" }, 403);

  const banCheck = await pool.query(
    `SELECT ban_id, identifier, identifier_type, action_type, bm_ban_id
     FROM player_bans WHERE ban_id = $1 AND org_id = $2 AND revoked = FALSE`,
    [banId, orgId],
  );
  if (!banCheck.rows[0])
    return json({ error: "Ban not found or already revoked" }, 404);

  const { identifier, identifier_type, action_type, bm_ban_id } =
    banCheck.rows[0];

  await pool.query(
    `UPDATE player_bans SET revoked = TRUE, revoked_at = unix_now(), revoked_by = $3
     WHERE ban_id = $1 AND org_id = $2`,
    [banId, orgId, session.userId],
  );

  scheduleBanExpiry(banId, null).catch(() => {});

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: action_type === "mute" ? "mute" : "ban",
    resourceId: banId,
    actionType: action_type === "mute" ? "MUTE_REVOKED" : "BAN_REVOKED",
    actionCategory: "moderation",
    severity: 3,
    metadata: {
      identifier: String(identifier),
      identifierType: String(identifier_type),
    },
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
        const password = decryptPterodactylApiKey(
          String(srv.rcon_password_enc),
        );
        const rconUrl = `ws://${srv.rcon_host}:${srv.rcon_port}/${encodeURIComponent(password)}`;
        let command;
        if (identifier_type === "ip") {
          // identifier is stored encrypted; decrypt to get the raw IP for RCON.
          const rawIp = decryptIp(String(identifier));
          if (!rawIp)
            throw new Error("could not decrypt IP ban identifier for RCON");
          command = `unbanip ${rawIp}`;
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

  let bmDeleteError = null;
  if (bm_ban_id && action_type !== "mute") {
    try {
      const bmRes = await bmFetch(
        orgId,
        `https://api.battlemetrics.com/bans/${encodeURIComponent(String(bm_ban_id))}`,
        { method: "DELETE" },
      );
      if (!bmRes.ok && bmRes.status !== 404) {
        const text = await bmRes.text().catch(() => "");
        bmDeleteError = `BM ${bmRes.status}: ${text.slice(0, 120)}`;
      }
    } catch (err) {
      bmDeleteError = err.message;
    }
  }

  return json({
    ok: true,
    rconResults,
    ...(bmDeleteError ? { bmDeleteError } : {}),
  });
}

async function handlePurgeBan(request, orgId, banId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "bans_purge"))
    return json({ error: "Forbidden" }, 403);

  const banCheck = await pool.query(
    `SELECT ban_id, action_type, bm_ban_id FROM player_bans WHERE ban_id = $1 AND org_id = $2`,
    [banId, orgId],
  );
  if (!banCheck.rows[0]) return json({ error: "Ban not found" }, 404);

  const { action_type, bm_ban_id } = banCheck.rows[0];

  scheduleBanExpiry(banId, null).catch(() => {});

  let bmDeleteError = null;
  if (bm_ban_id && action_type !== "mute") {
    try {
      const bmRes = await bmFetch(
        orgId,
        `https://api.battlemetrics.com/bans/${encodeURIComponent(String(bm_ban_id))}`,
        { method: "DELETE" },
      );
      if (!bmRes.ok && bmRes.status !== 404) {
        const text = await bmRes.text().catch(() => "");
        bmDeleteError = `BM ${bmRes.status}: ${text.slice(0, 120)}`;
      }
    } catch (err) {
      bmDeleteError = err.message;
    }
  }

  await pool.query(
    `DELETE FROM player_bans WHERE ban_id = $1 AND org_id = $2`,
    [banId, orgId],
  );

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: action_type === "mute" ? "mute" : "ban",
    resourceId: banId,
    actionType: action_type === "mute" ? "MUTE_PURGED" : "BAN_PURGED",
    actionCategory: "moderation",
    severity: 4,
    metadata: {},
    ipAddress: getClientIp(request),
  });

  return json({ ok: true, ...(bmDeleteError ? { bmDeleteError } : {}) });
}

// Schedules (or cancels) a BullMQ delayed job to auto-revoke a ban/mute when
// its expires_at elapses. Uses a deterministic jobId so re-scheduling on update
// cleanly replaces the old job. Passing null for expiresAtUnix cancels any
// existing job without scheduling a new one.
async function scheduleBanExpiry(banId, expiresAtUnix) {
  const jobId = `ban-expire-${banId}`;
  try {
    const existing = await queue.getJob(jobId);
    if (existing) await existing.remove().catch(() => {});
  } catch {}
  if (expiresAtUnix == null) return;
  const delayMs = Math.max(0, expiresAtUnix * 1000 - Date.now());
  await queue.add("ban-expire", { banId }, { jobId, delay: delayMs });
}

async function processBanExpireJob(job) {
  const { banId } = job.data;
  const banRes = await pool.query(
    `SELECT ban_id, org_id, identifier, identifier_type, action_type, bm_ban_id
     FROM player_bans WHERE ban_id = $1 AND revoked = FALSE`,
    [banId],
  );
  const ban = banRes.rows[0];
  if (!ban) return; // already revoked or deleted

  await pool.query(
    `UPDATE player_bans SET revoked = TRUE, revoked_at = unix_now()
     WHERE ban_id = $1 AND revoked = FALSE`,
    [banId],
  );

  const { org_id, identifier, identifier_type, action_type, bm_ban_id } = ban;

  auditLog({
    orgId: org_id,
    actorUserId: null,
    resourceType: action_type === "mute" ? "mute" : "ban",
    resourceId: banId,
    actionType: action_type === "mute" ? "MUTE_EXPIRED" : "BAN_EXPIRED",
    actionCategory: "moderation",
    severity: 2,
    metadata: {
      identifier: String(identifier),
      identifierType: String(identifier_type),
    },
  });

  if (action_type !== "mute") {
    const targetServers = await pool.query(
      `SELECT s.server_id, s.rcon_host, s.rcon_port, s.rcon_password_enc
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
        const password = decryptPterodactylApiKey(
          String(srv.rcon_password_enc),
        );
        const rconUrl = `ws://${srv.rcon_host}:${srv.rcon_port}/${encodeURIComponent(password)}`;
        const rconIdentifier =
          identifier_type === "ip" ? decryptIp(String(identifier)) : null;
        if (identifier_type === "ip" && !rconIdentifier) {
          console.error(
            `[ban-expire] Could not decrypt IP identifier for ban ${banId} — skipping RCON unban`,
          );
          continue;
        }
        const command =
          identifier_type === "ip"
            ? `unbanip ${rconIdentifier}`
            : `unban ${String(identifier)}`;
        await executeRconCommand(rconUrl, command);
      } catch (err) {
        console.error(
          `[ban-expire] RCON unban failed for server ${srv.server_id}:`,
          err.message,
        );
      }
    }
  }
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
  if (word.length > 100)
    return json({ error: "word must be 100 characters or fewer" }, 400);

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
    return json(
      { word_id: r.word_id, word: r.word, created_at: Number(r.created_at) },
      200,
    );
  }

  const r = rows[0];
  return json(
    { word_id: r.word_id, word: r.word, created_at: Number(r.created_at) },
    201,
  );
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

export async function initializeInfra() {
  try {
    await init();
  } catch {
    // startup failures are exposed via API startup guard responses
  }
}

// ── Globalping helpers and background jobs ────────────────────────────────────
// https://globalping.io/docs/api.globalping.io — Globalping is a free, globally
// distributed network measurement platform. Requests are rate-limited; an
// optional per-org API token raises the limits but is not required.

const GLOBALPING_BASE = "https://api.globalping.io/v1";

async function globalpingFetch(path, opts = {}, apiToken = null) {
  const t0gp = Date.now();
  const url = `${GLOBALPING_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      ...(opts.headers ?? {}),
    },
    signal: opts.signal ?? AbortSignal.timeout(20000),
  });
  diagRecordOutgoing("globalping", url, res.status, Date.now() - t0gp);
  return res;
}

// Create a single ping measurement covering every requested country. Globalping
// returns one result per probe (tagged with its country), so one measurement
// per server is enough — no need to fan out per country like RIPE Atlas did.
async function globalpingCreateMeasurement(
  targetIp,
  countries,
  probesPerCountry,
  apiToken,
) {
  const body = {
    type: "ping",
    target: targetIp,
    measurementOptions: { packets: 3 },
    locations: countries.map((country) => ({
      country,
      limit: probesPerCountry,
    })),
  };
  const res = await globalpingFetch(
    "/measurements",
    { method: "POST", body: JSON.stringify(body) },
    apiToken,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(
      "[globalping] create measurement error body:",
      JSON.stringify(err),
    );
    const detail =
      err?.error?.message ?? err?.error?.detail ?? `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const data = await res.json();
  const msmId = data.id;
  if (!msmId) throw new Error("No measurement ID returned by Globalping");
  return msmId;
}

async function triggerGlobalpingMeasurements() {
  const { rows: configs } = await pool.query(
    `SELECT c.org_id, c.api_token_enc, c.countries, c.probes_per_country, c.check_interval_minutes,
            MAX(m.created_at) AS last_triggered_at
     FROM org_globalping_config c
     LEFT JOIN org_globalping_measurements m ON m.org_id = c.org_id
     GROUP BY c.org_id, c.api_token_enc, c.countries, c.probes_per_country, c.check_interval_minutes`,
  );
  if (!configs.length) return;

  const nowSec = Math.floor(Date.now() / 1000);
  for (const cfg of configs) {
    const intervalSec = (Number(cfg.check_interval_minutes) || 5) * 60;
    const lastAt = cfg.last_triggered_at ? Number(cfg.last_triggered_at) : 0;
    if (nowSec - lastAt < intervalSec) continue;

    let apiToken = null;
    if (cfg.api_token_enc) {
      try {
        apiToken = decryptExternalApiKey(String(cfg.api_token_enc));
      } catch {
        apiToken = null;
      }
    }

    const { rows: servers } = await pool.query(
      `SELECT server_id, server_name, rcon_host FROM servers WHERE owner_org_id = $1 AND rcon_host IS NOT NULL`,
      [cfg.org_id],
    );
    if (!servers.length) continue;

    const countries = Array.isArray(cfg.countries) ? cfg.countries : [];
    if (!countries.length) continue;
    const probesPerCountry = Number(cfg.probes_per_country) || 3;

    for (const server of servers) {
      try {
        const msmId = await globalpingCreateMeasurement(
          server.rcon_host,
          countries,
          probesPerCountry,
          apiToken,
        );
        await pool.query(
          `INSERT INTO org_globalping_measurements
           (org_id, server_id, gp_measurement_id, target_ip)
           VALUES ($1, $2, $3, $4)`,
          [cfg.org_id, server.server_id, msmId, server.rcon_host],
        );
      } catch (err) {
        console.warn(
          `[globalping] measurement failed org=${cfg.org_id} server=${server.server_name}: ${err.message}`,
        );
      }
    }
  }
}

async function fetchPendingGlobalpingResults() {
  const { rows: pending } = await pool.query(
    `SELECT id, org_id, server_id, gp_measurement_id, created_at
     FROM org_globalping_measurements
     WHERE status = 'pending'
       AND results_fetched_at IS NULL
     ORDER BY created_at ASC
     LIMIT 50`,
  );
  if (!pending.length) return;

  const orgIds = [...new Set(pending.map((m) => m.org_id))];
  const { rows: cfgRows } = await pool.query(
    `SELECT org_id, api_token_enc FROM org_globalping_config WHERE org_id = ANY($1::text[])`,
    [orgIds],
  );
  const tokensByOrg = new Map();
  for (const cfg of cfgRows) {
    if (!cfg.api_token_enc) continue;
    try {
      tokensByOrg.set(
        cfg.org_id,
        decryptExternalApiKey(String(cfg.api_token_enc)),
      );
    } catch {
      continue;
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  for (const msm of pending) {
    // Expire measurements older than 5 minutes — Globalping probes typically
    // finish within seconds; anything older is stale or permanently stuck.
    if (nowSec - Number(msm.created_at) > 300) {
      await pool.query(
        `UPDATE org_globalping_measurements
         SET status = 'completed', results_fetched_at = unix_now()
         WHERE id = $1`,
        [msm.id],
      );
      continue;
    }

    const apiToken = tokensByOrg.get(msm.org_id) ?? null;

    try {
      const res = await globalpingFetch(
        `/measurements/${msm.gp_measurement_id}`,
        {},
        apiToken,
      );
      if (!res.ok) {
        // 404/expired — stop tracking this measurement.
        await pool.query(
          `UPDATE org_globalping_measurements
           SET status = 'completed', results_fetched_at = unix_now()
           WHERE id = $1`,
          [msm.id],
        );
        continue;
      }

      const data = await res.json().catch(() => null);
      // Still running — leave it pending and re-check next cycle.
      if (!data || data.status === "in-progress") continue;

      await pool.query(
        `UPDATE org_globalping_measurements
         SET status = 'completed', results_fetched_at = unix_now()
         WHERE id = $1`,
        [msm.id],
      );

      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) continue;

      // Globalping returns one entry per probe; aggregate them per country.
      const byCountry = new Map();
      for (const item of results) {
        const country = item?.probe?.country;
        if (!country) continue;
        let agg = byCountry.get(country);
        if (!agg) {
          agg = {
            totalAvg: 0,
            minRtt: Infinity,
            maxRtt: -Infinity,
            reachableCount: 0,
            probeCount: 0,
          };
          byCountry.set(country, agg);
        }
        agg.probeCount++;
        const stats = item?.result?.stats ?? {};
        const avg = stats.avg;
        const loss = stats.loss;
        const reachable =
          avg != null &&
          Number(avg) > 0 &&
          (loss == null || Number(loss) < 100);
        if (reachable) {
          agg.reachableCount++;
          agg.totalAvg += Number(avg);
          if (stats.min != null && Number(stats.min) < agg.minRtt)
            agg.minRtt = Number(stats.min);
          if (stats.max != null && Number(stats.max) > agg.maxRtt)
            agg.maxRtt = Number(stats.max);
        }
      }

      for (const [country, agg] of byCountry) {
        const reachable = agg.reachableCount > 0;
        const avgRtt = reachable ? agg.totalAvg / agg.reachableCount : null;
        await pool.query(
          `INSERT INTO org_globalping_results
           (org_id, server_id, country, reachable, avg_rtt, min_rtt, max_rtt, probe_count, reachable_count, measured_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            msm.org_id,
            msm.server_id,
            country,
            reachable,
            avgRtt != null ? avgRtt.toFixed(2) : null,
            agg.minRtt !== Infinity ? agg.minRtt : null,
            agg.maxRtt !== -Infinity ? agg.maxRtt : null,
            agg.probeCount,
            agg.reachableCount,
            Number(msm.created_at),
          ],
        );
      }
    } catch (err) {
      console.warn(
        `[globalping] results fetch failed msm=${msm.gp_measurement_id}: ${err.message}`,
      );
    }
  }

  await pool.query(
    `DELETE FROM org_globalping_measurements WHERE created_at < unix_now() - 7200`,
  );
  await pool.query(
    `DELETE FROM org_globalping_results WHERE measured_at < unix_now() - 86400`,
  );
}

// ── External API key route handlers ──────────────────────────────────────────

async function handleListExternalKeys(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

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

  if (!["battlemetrics", "steam", "proxycheck", "openai"].includes(service))
    return json(
      { error: "service must be battlemetrics, steam, proxycheck, or openai" },
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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

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
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

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
      minRemaining:
        r.rate_limit_min_remaining != null
          ? Number(r.rate_limit_min_remaining)
          : null,
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

// ── R2 / S3 media integration ─────────────────────────────────────────────────

function mediaFileType(mimeType) {
  if (!mimeType) return "other";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "other";
}

function resolveMediaUrl(r) {
  if (r.r2_key) return getPublicUrl(String(r.r2_key));
  return r.zipline_url ? String(r.zipline_url) : null; // legacy Zipline fallback
}

function serializeMedia(r) {
  return {
    mediaId: String(r.media_id),
    orgId: String(r.org_id),
    uploadedBy: r.uploaded_by ? String(r.uploaded_by) : null,
    uploadedByName: r.uploaded_by_name ?? null,
    url: resolveMediaUrl(r),
    filename: String(r.filename),
    fileType: String(r.file_type),
    mimeType: r.mime_type ?? null,
    fileSize: r.file_size != null ? Number(r.file_size) : null,
    title: r.title ?? "",
    uploadedAt: Number(r.uploaded_at),
    lastAccessedAt:
      r.last_accessed_at != null ? Number(r.last_accessed_at) : null,
    storageBackend: r.storage_backend ?? "zipline",
  };
}

// Returns bytes currently used by confirmed media for an org (staff only).
async function getOrgStorageUsed(orgId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(file_size), 0)::BIGINT AS used
     FROM org_media WHERE org_id = $1 AND deleted = FALSE AND confirmed = TRUE AND source = 'staff'`,
    [orgId],
  );
  return Number(rows[0].used);
}

// Returns bytes used by a specific user within an org.
async function getUserStorageUsed(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(file_size), 0)::BIGINT AS used
     FROM org_media WHERE org_id = $1 AND uploaded_by = $2 AND deleted = FALSE AND confirmed = TRUE AND source = 'staff'`,
    [orgId, userId],
  );
  return Number(rows[0].used);
}

async function handleListAllMedia(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const limitParam = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10),
  );
  const fileType = url.searchParams.get("type") ?? null;
  const sysAdmin = isConfiguredSysAdmin(session);

  const conditions = [
    "m.deleted = FALSE",
    "m.confirmed = TRUE",
    "m.source = 'staff'",
  ];
  const params = [];
  let paramIdx = 1;

  if (!sysAdmin) {
    const userOrgs = await listUserOrganizations(session.userId);
    if (userOrgs.length === 0)
      return json({ media: [], total: 0, isSysAdmin: false });

    const orgIds = userOrgs.map((o) => String(o.orgId));
    const elevatedOrgSet = new Set(
      Array.isArray(session.orgAdminOrgIds)
        ? session.orgAdminOrgIds.map((id) => String(id))
        : [],
    );
    const elevatedOrgIds = orgIds.filter((id) => elevatedOrgSet.has(id));
    const personalOrgIds = orgIds.filter((id) => !elevatedOrgSet.has(id));
    const scopeClauses = [];

    if (elevatedOrgIds.length > 0) {
      scopeClauses.push(`m.org_id = ANY($${paramIdx++}::text[])`);
      params.push(elevatedOrgIds);
    }

    if (personalOrgIds.length > 0) {
      const personalOrgsParam = paramIdx++;
      const userParam = paramIdx++;
      scopeClauses.push(
        `(m.org_id = ANY($${personalOrgsParam}::text[]) AND m.uploaded_by = $${userParam})`,
      );
      params.push(personalOrgIds, session.userId);
    }

    if (scopeClauses.length === 0)
      return json({ media: [], total: 0, isSysAdmin: false });

    conditions.push(`(${scopeClauses.join(" OR ")})`);
  }

  if (fileType && ["image", "video", "other"].includes(fileType)) {
    conditions.push(`m.file_type = $${paramIdx++}`);
    params.push(fileType);
  }

  const where = conditions.join(" AND ");

  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.uploaded_by, m.r2_key, m.storage_backend,
            m.zipline_url, m.filename, m.file_type, m.mime_type, m.file_size, m.title,
            m.uploaded_at, m.last_accessed_at,
            u.username AS uploaded_by_name,
            o.name AS org_name
     FROM org_media m
     LEFT JOIN users u ON u.user_id = m.uploaded_by
     LEFT JOIN organizations o ON o.org_id = m.org_id
     WHERE ${where}
     ORDER BY m.uploaded_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limitParam, offset],
  );

  const countRes = await pool.query(
    `SELECT COUNT(*) AS total FROM org_media m WHERE ${where}`,
    params,
  );

  return json({
    media: rows.map((r) => ({ ...serializeMedia(r), orgName: r.org_name })),
    total: Number(countRes.rows[0].total),
    isSysAdmin: sysAdmin,
  });
}

async function handleListOrgMedia(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const canManage =
    canManageOrg(session, orgId) || isConfiguredSysAdmin(session);
  if (
    !canManage &&
    !orgHasPermission(session, orgId, "players_view") &&
    !orgHasPermission(session, orgId, "bans_create") &&
    !orgHasPermission(session, orgId, "bans_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const url = new URL(request.url);
  const limitParam = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10),
  );
  const fileType = url.searchParams.get("type") ?? null;

  const conditions = [
    "m.org_id = $1",
    "m.deleted = FALSE",
    "m.confirmed = TRUE",
    "m.source = 'staff'",
  ];
  const params = [orgId];
  let paramIdx = 2;

  if (!canManage) {
    conditions.push(`m.uploaded_by = $${paramIdx++}`);
    params.push(session.userId);
  }

  if (fileType && ["image", "video", "other"].includes(fileType)) {
    conditions.push(`m.file_type = $${paramIdx++}`);
    params.push(fileType);
  }

  const where = conditions.join(" AND ");

  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.uploaded_by, m.r2_key, m.storage_backend,
            m.zipline_url, m.filename, m.file_type, m.mime_type, m.file_size, m.title,
            m.uploaded_at, m.last_accessed_at,
            u.username AS uploaded_by_name
     FROM org_media m
     LEFT JOIN users u ON u.user_id = m.uploaded_by
     WHERE ${where}
     ORDER BY m.uploaded_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limitParam, offset],
  );

  const countRes = await pool.query(
    `SELECT COUNT(*) AS total FROM org_media m WHERE ${where}`,
    params,
  );

  const total = Number(countRes.rows[0].total);
  return json({ media: rows.map(serializeMedia), total });
}

// Phase 1: validate, check quotas, generate presigned upload URL.
async function handlePrepareMedia(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId) && !isConfiguredSysAdmin(session)) {
    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND role_id != 'org_disabled' LIMIT 1`,
      [orgId, session.userId],
    );
    if (!memberRows[0]) return json({ error: "Forbidden" }, 403);
    if (!orgHasPermission(session, orgId, "media_upload"))
      return json({ error: "Forbidden" }, 403);
  }

  if (!r2Configured())
    return json(
      {
        error:
          "R2 storage is not configured on this server. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_PUBLIC_URL.",
      },
      503,
    );

  const rl = await checkRateLimit(
    `rl:media-prepare:${session.userId}`,
    env.mediaPrepareRateLimitPerMinute,
    60,
  );
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const filename = String(body?.filename ?? "upload").slice(0, 255);
  const mimeType = String(body?.mimeType ?? "")
    .trim()
    .toLowerCase();
  const fileSize = Number(body?.fileSize ?? 0);
  const title = String(body?.title ?? "")
    .trim()
    .slice(0, 255);

  if (!STAFF_ALLOWED_MIME.has(mimeType))
    return json({ error: `File type not allowed: ${mimeType}` }, 415);
  if (!fileSize || fileSize < 1)
    return json({ error: "fileSize is required" }, 400);
  if (fileSize > MAX_FILE_SIZE)
    return json(
      {
        error: `File too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024 / 1024)} GB)`,
      },
      413,
    );

  // Check org storage quota.
  const orgRes = await pool.query(
    `SELECT media_storage_limit_bytes, media_user_limit_bytes FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const orgRow = orgRes.rows[0];
  if (orgRow?.media_storage_limit_bytes) {
    const used = await getOrgStorageUsed(orgId);
    if (used + fileSize > Number(orgRow.media_storage_limit_bytes))
      return json({ error: "Organization storage quota exceeded." }, 413);
  }
  if (orgRow?.media_user_limit_bytes) {
    const used = await getUserStorageUsed(orgId, session.userId);
    if (used + fileSize > Number(orgRow.media_user_limit_bytes))
      return json(
        { error: "Your personal storage quota for this organization is full." },
        413,
      );
  }

  const r2Key = buildObjectKey(orgId, `user/${session.userId}`, filename);
  const nowSec = Math.floor(Date.now() / 1000);

  let uploadUrl = null;
  let multipart = null;

  if (fileSize >= MULTIPART_THRESHOLD) {
    multipart = await generatePresignedMultipart(r2Key, mimeType, fileSize);
  } else {
    uploadUrl = await generatePresignedPut(r2Key, mimeType, fileSize);
  }

  const { rows } = await pool.query(
    `INSERT INTO org_media
       (org_id, uploaded_by, filename, file_type, mime_type, file_size, title,
        r2_key, storage_backend, source, confirmed, pending_since, multipart_upload_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'r2','staff',FALSE,$9,$10)
     RETURNING media_id`,
    [
      orgId,
      session.userId,
      filename,
      mediaFileType(mimeType),
      mimeType,
      fileSize,
      title,
      r2Key,
      nowSec,
      multipart?.uploadId ?? null,
    ],
  );
  const mediaId = String(rows[0].media_id);

  console.log(
    `[r2] prepare org=${orgId} user=${session.userId} key=${r2Key} size=${fileSize} multipart=${!!multipart}`,
  );
  return json(
    {
      uploadUrl,
      mediaId,
      multipart: multipart ? { ...multipart, key: r2Key } : null,
    },
    200,
  );
}

// Phase 2: confirm the upload completed, mark the record active.
async function handleConfirmMedia(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId) && !isConfiguredSysAdmin(session)) {
    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND role_id != 'org_disabled' LIMIT 1`,
      [orgId, session.userId],
    );
    if (!memberRows[0]) return json({ error: "Forbidden" }, 403);
    if (!orgHasPermission(session, orgId, "media_upload"))
      return json({ error: "Forbidden" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const mediaId = String(body?.mediaId ?? "").trim();
  if (!mediaId) return json({ error: "mediaId is required" }, 400);

  const { rows } = await pool.query(
    `SELECT media_id, uploaded_by, r2_key, storage_backend, multipart_upload_id, file_size
     FROM org_media
     WHERE media_id = $1 AND org_id = $2 AND confirmed = FALSE AND deleted = FALSE`,
    [mediaId, orgId],
  );
  if (!rows[0]) return json({ error: "Pending media not found" }, 404);
  const row = rows[0];

  if (
    String(row.uploaded_by) !== String(session.userId) &&
    !canManageOrg(session, orgId)
  )
    return json({ error: "Forbidden" }, 403);

  // For R2 multipart, the frontend sends the ETags from each part so we can complete.
  if (row.multipart_upload_id && Array.isArray(body?.parts)) {
    const parts = body.parts.map((p) => ({
      partNumber: Number(p.partNumber),
      etag: String(p.etag),
    }));
    if (parts.length === 0 || parts.some((p) => !p.partNumber || !p.etag))
      return json(
        { error: "Invalid parts array for multipart completion" },
        400,
      );
    try {
      await completeMultipartUpload(
        String(row.r2_key),
        String(row.multipart_upload_id),
        parts,
      );
    } catch (err) {
      console.error(
        `[r2] complete multipart failed mediaId=${mediaId}:`,
        err?.message,
      );
      return json({ error: "Failed to complete multipart upload" }, 502);
    }
  }

  const actualSize = body?.fileSize ? Number(body.fileSize) : null;
  const { rows: updated } = await pool.query(
    `UPDATE org_media
     SET confirmed = TRUE, pending_since = NULL,
         file_size = COALESCE($2, file_size)
     WHERE media_id = $1
     RETURNING media_id, org_id, uploaded_by, r2_key, storage_backend, zipline_url,
               filename, file_type, mime_type, file_size, title, uploaded_at, last_accessed_at`,
    [mediaId, actualSize],
  );

  console.log(
    `[r2] confirmed mediaId=${mediaId} backend=${row.storage_backend}`,
  );
  return json(
    { media: serializeMedia({ ...updated[0], uploaded_by_name: null }) },
    200,
  );
}

async function handleDeleteMedia(request, orgId, mediaId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId) && !isConfiguredSysAdmin(session)) {
    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND role_id != 'org_disabled' LIMIT 1`,
      [orgId, session.userId],
    );
    if (!memberRows[0]) return json({ error: "Forbidden" }, 403);
  }

  const { rows } = await pool.query(
    `SELECT media_id, uploaded_by, r2_key, storage_backend, multipart_upload_id FROM org_media
     WHERE media_id = $1 AND org_id = $2 AND deleted = FALSE`,
    [mediaId, orgId],
  );
  if (!rows[0]) return json({ error: "Media not found" }, 404);

  const row = rows[0];
  const isOwner = String(row.uploaded_by) === String(session.userId);
  if (
    !isOwner &&
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "bans_manage")
  )
    return json(
      { error: "Forbidden: you can only delete your own uploads" },
      403,
    );

  if (row.r2_key) {
    await deleteMediaObject(String(row.r2_key));
  }
  if (row.multipart_upload_id) {
    await abortMultipartUpload(
      String(row.r2_key),
      String(row.multipart_upload_id),
    );
  }

  await pool.query(`UPDATE org_media SET deleted = TRUE WHERE media_id = $1`, [
    mediaId,
  ]);
  return json({ ok: true });
}

async function handleGetMediaItem(request, orgId, mediaId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "players_view") &&
    !orgHasPermission(session, orgId, "bans_create") &&
    !orgHasPermission(session, orgId, "bans_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.uploaded_by, m.r2_key, m.storage_backend, m.zipline_url,
            m.filename, m.file_type, m.mime_type, m.file_size, m.title,
            m.uploaded_at, m.last_accessed_at,
            u.username AS uploaded_by_name
     FROM org_media m
     LEFT JOIN users u ON u.user_id = m.uploaded_by
     WHERE m.media_id = $1 AND m.org_id = $2 AND m.deleted = FALSE AND m.confirmed = TRUE`,
    [mediaId, orgId],
  );
  if (!rows[0]) return json({ error: "Media not found" }, 404);

  await pool.query(
    `UPDATE org_media SET last_accessed_at = unix_now() WHERE media_id = $1`,
    [mediaId],
  );
  return json({ media: serializeMedia(rows[0]) });
}

async function handleGetBanMedia(request, orgId, banId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "players_view") &&
    !orgHasPermission(session, orgId, "bans_create") &&
    !orgHasPermission(session, orgId, "bans_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const banCheck = await pool.query(
    `SELECT ban_id FROM player_bans WHERE ban_id = $1 AND org_id = $2 LIMIT 1`,
    [banId, orgId],
  );
  if (!banCheck.rows[0]) return json({ error: "Ban not found" }, 404);

  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.uploaded_by, m.r2_key, m.storage_backend, m.zipline_url,
            m.filename, m.file_type, m.mime_type, m.file_size, m.title,
            m.uploaded_at, m.last_accessed_at,
            u.username AS uploaded_by_name
     FROM ban_media_links bml
     JOIN org_media m ON m.media_id = bml.media_id
     LEFT JOIN users u ON u.user_id = m.uploaded_by
     WHERE bml.ban_id = $1 AND m.deleted = FALSE AND m.confirmed = TRUE`,
    [banId],
  );
  return json({ media: rows.map(serializeMedia) });
}

// Public ticket media: prepare presigned upload URL (session with steamId required).
async function handlePublicMediaPrepare(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!session.steamId)
    return json({ error: "Steam account required to upload files." }, 403);

  if (!r2Configured())
    return json({ error: "R2 storage not configured." }, 503);

  const rl = await checkRateLimit(
    `rl:pub-media:${session.userId}`,
    env.publicMediaPrepareRateLimitPerMinute,
    60,
  );
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const orgId = String(body?.orgId ?? "").trim();
  if (!orgId) return json({ error: "orgId is required" }, 400);

  const orgRes = await pool.query(
    `SELECT org_id, media_public_file_limit_bytes, media_public_max_files FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);
  const org = orgRes.rows[0];

  const fileLimitBytes = Number(
    org.media_public_file_limit_bytes ?? DEFAULT_PUBLIC_FILE_LIMIT,
  );
  const maxFiles = Number(
    org.media_public_max_files ?? DEFAULT_PUBLIC_MAX_FILES,
  );

  const filename = String(body?.filename ?? "upload").slice(0, 255);
  const mimeType = String(body?.mimeType ?? "")
    .trim()
    .toLowerCase();
  const fileSize = Number(body?.fileSize ?? 0);

  if (!PUBLIC_ALLOWED_MIME.has(mimeType))
    return json(
      {
        error: `File type not allowed: ${mimeType}. Allowed: images (jpeg/png/gif/webp) and video (mp4/webm/mov).`,
      },
      415,
    );
  if (!fileSize || fileSize < 1)
    return json({ error: "fileSize is required" }, 400);
  if (fileSize > fileLimitBytes)
    return json(
      {
        error: `File too large (max ${Math.round(fileLimitBytes / 1024 / 1024)} MB for this organization)`,
      },
      413,
    );

  // Count existing pending/confirmed media for this session to enforce per-submission cap.
  const countRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM org_media
     WHERE org_id = $1 AND uploaded_by = $2 AND source IN ('pending','ticket')
       AND deleted = FALSE AND pending_since > $3`,
    [orgId, session.userId, Math.floor(Date.now() / 1000) - 3600],
  );
  if (Number(countRes.rows[0].cnt) >= maxFiles)
    return json(
      { error: `Maximum ${maxFiles} file(s) allowed per submission.` },
      429,
    );

  const r2Key = buildObjectKey(orgId, `pending/${session.userId}`, filename);
  const nowSec = Math.floor(Date.now() / 1000);
  const uploadUrl = await generatePresignedPut(r2Key, mimeType, fileSize);

  const { rows } = await pool.query(
    `INSERT INTO org_media
       (org_id, uploaded_by, filename, file_type, mime_type, file_size,
        r2_key, storage_backend, source, confirmed, pending_since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'r2','pending',FALSE,$8)
     RETURNING media_id`,
    [
      orgId,
      session.userId,
      filename,
      mediaFileType(mimeType),
      mimeType,
      fileSize,
      r2Key,
      nowSec,
    ],
  );
  const mediaId = String(rows[0].media_id);

  return json({ uploadUrl, mediaId });
}

// Public ticket media confirm: mark upload complete so it can be attached to a ticket.
async function handlePublicMediaConfirm(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!session.steamId) return json({ error: "Steam account required." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const mediaId = String(body?.mediaId ?? "").trim();
  if (!mediaId) return json({ error: "mediaId is required" }, 400);

  const { rows } = await pool.query(
    `SELECT media_id, uploaded_by FROM org_media
     WHERE media_id = $1 AND source = 'pending' AND confirmed = FALSE AND deleted = FALSE`,
    [mediaId],
  );
  if (!rows[0]) return json({ error: "Pending media not found" }, 404);
  if (String(rows[0].uploaded_by) !== String(session.userId))
    return json({ error: "Forbidden" }, 403);

  await pool.query(
    `UPDATE org_media SET confirmed = TRUE WHERE media_id = $1`,
    [mediaId],
  );
  return json({ ok: true, mediaId });
}

async function purgeExpiredMedia() {
  // Soft-delete unconfirmed uploads older than 1 hour (abandoned presigned flows).
  const staleThreshold = Math.floor(Date.now() / 1000) - 3600;
  const { rows: stale } = await pool.query(
    `SELECT media_id, r2_key, multipart_upload_id
     FROM org_media WHERE confirmed = FALSE AND deleted = FALSE AND pending_since < $1`,
    [staleThreshold],
  );
  for (const row of stale) {
    if (row.r2_key) {
      if (row.multipart_upload_id)
        await abortMultipartUpload(
          String(row.r2_key),
          String(row.multipart_upload_id),
        );
      await deleteMediaObject(String(row.r2_key));
    }
    await pool.query(
      `UPDATE org_media SET deleted = TRUE WHERE media_id = $1`,
      [row.media_id],
    );
  }
  if (stale.length)
    console.log(`[media-expiry] removed ${stale.length} abandoned upload(s)`);

  // Soft-delete confirmed media older than the org's configured expiry window.
  // R2 does not support bucket lifecycle rules, so this BullMQ job is the sole expiry mechanism.
  const { rows: orgs } = await pool.query(
    `SELECT org_id, media_expiry_months FROM organizations WHERE media_expiry_months IS NOT NULL`,
  );
  for (const org of orgs) {
    const thresholdSeconds =
      Math.floor(Date.now() / 1000) - org.media_expiry_months * 30 * 86400;
    const { rows: expired } = await pool.query(
      `SELECT media_id, r2_key FROM org_media
       WHERE org_id = $1 AND deleted = FALSE AND confirmed = TRUE
         AND COALESCE(last_accessed_at, uploaded_at) < $2`,
      [org.org_id, thresholdSeconds],
    );
    for (const row of expired) {
      if (row.r2_key) await deleteMediaObject(String(row.r2_key));
      await pool.query(
        `UPDATE org_media SET deleted = TRUE WHERE media_id = $1`,
        [row.media_id],
      );
    }
    if (expired.length)
      console.log(
        `[media-expiry] purged ${expired.length} item(s) for org ${org.org_id}`,
      );
  }
}

// ── Globalping config and results handlers ────────────────────────────────────

async function handleGetGlobalpingConfig(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

  const { rows } = await pool.query(
    `SELECT api_token_enc, countries, probes_per_country, check_interval_minutes, created_at, updated_at
     FROM org_globalping_config WHERE org_id = $1`,
    [orgId],
  );

  if (!rows[0]) return json({ config: null });

  const row = rows[0];
  let tokenPrefix = null;
  if (row.api_token_enc) {
    try {
      tokenPrefix = decryptExternalApiKey(String(row.api_token_enc)).slice(
        0,
        8,
      );
    } catch {
      // non-critical
    }
  }

  return json({
    config: {
      countries: Array.isArray(row.countries) ? row.countries : [],
      probesPerCountry: Number(row.probes_per_country),
      checkIntervalMinutes: Number(row.check_interval_minutes) || 5,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      hasToken: Boolean(row.api_token_enc),
      tokenPrefix,
    },
  });
}

async function handlePutGlobalpingConfig(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

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

  const probesPerCountry = Math.min(
    Math.max(Number(body?.probesPerCountry ?? 3), 1),
    10,
  );
  const ALLOWED_INTERVALS = [5, 10, 25];
  const checkIntervalMinutes = ALLOWED_INTERVALS.includes(
    Number(body?.checkIntervalMinutes),
  )
    ? Number(body.checkIntervalMinutes)
    : 5;

  // The API token is optional (Globalping works unauthenticated). Encryption is
  // only required when we actually have a token to store.
  const rawToken = String(body?.apiToken ?? "").trim();
  if (rawToken && !getPterodactylEncryptionKey())
    return json(
      {
        error:
          "Encryption not configured (PTERODACTYL_ENCRYPTION_KEY or JWT_SECRET required)",
      },
      503,
    );

  const { rows: existing } = await pool.query(
    `SELECT org_id FROM org_globalping_config WHERE org_id = $1`,
    [orgId],
  );

  if (existing[0]) {
    const setClauses = [
      `countries = $2`,
      `probes_per_country = $3`,
      `check_interval_minutes = $4`,
      `updated_at = unix_now()`,
    ];
    const params = [orgId, countries, probesPerCountry, checkIntervalMinutes];
    if (rawToken) {
      setClauses.push(`api_token_enc = $${params.length + 1}`);
      params.push(encryptExternalApiKey(rawToken));
    } else if (body?.clearToken === true) {
      setClauses.push(`api_token_enc = NULL`);
    }
    await pool.query(
      `UPDATE org_globalping_config SET ${setClauses.join(", ")} WHERE org_id = $1`,
      params,
    );
  } else {
    await pool.query(
      `INSERT INTO org_globalping_config (org_id, api_token_enc, countries, probes_per_country, check_interval_minutes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        orgId,
        rawToken ? encryptExternalApiKey(rawToken) : null,
        countries,
        probesPerCountry,
        checkIntervalMinutes,
      ],
    );
  }

  const { rows: updated } = await pool.query(
    `SELECT api_token_enc, countries, probes_per_country, check_interval_minutes, created_at, updated_at
     FROM org_globalping_config WHERE org_id = $1`,
    [orgId],
  );
  const row = updated[0];
  let tokenPrefix = null;
  if (row.api_token_enc) {
    try {
      tokenPrefix = decryptExternalApiKey(String(row.api_token_enc)).slice(
        0,
        8,
      );
    } catch {
      // non-critical
    }
  }

  return json({
    config: {
      countries: Array.isArray(row.countries) ? row.countries : [],
      probesPerCountry: Number(row.probes_per_country),
      checkIntervalMinutes: Number(row.check_interval_minutes) || 5,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      hasToken: Boolean(row.api_token_enc),
      tokenPrefix,
    },
  });
}

async function handleDeleteGlobalpingConfig(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

  await pool.query(`DELETE FROM org_globalping_config WHERE org_id = $1`, [
    orgId,
  ]);
  await pool.query(
    `DELETE FROM org_globalping_measurements WHERE org_id = $1`,
    [orgId],
  );
  await pool.query(`DELETE FROM org_globalping_results WHERE org_id = $1`, [
    orgId,
  ]);

  return json({ ok: true });
}

async function handleGetGlobalpingResults(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "status_view") &&
    !orgHasPermission(session, orgId, "servers_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const { rows: cfgRows } = await pool.query(
    `SELECT countries, probes_per_country FROM org_globalping_config WHERE org_id = $1`,
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
     FROM org_globalping_results
     WHERE org_id = $1 AND measured_at > unix_now() - 3600
     ORDER BY server_id, country, measured_at DESC`,
    [orgId],
  );

  const { rows: pendingRows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM org_globalping_measurements
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

async function handleGetGlobalpingHistory(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "status_view") &&
    !orgHasPermission(session, orgId, "servers_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const url = new URL(request.url);
  const serverId = url.searchParams.get("serverId");
  if (!serverId) return json({ error: "serverId is required" }, 400);

  // Verify the server belongs to this org (derive ownership from the row → no IDOR).
  const srvRes = await pool.query(
    `SELECT server_id FROM servers WHERE server_id = $1 AND owner_org_id = $2`,
    [serverId, orgId],
  );
  if (!srvRes.rows[0]) return json({ error: "Server not found" }, 404);

  const cfgRes = await pool.query(
    `SELECT countries FROM org_globalping_config WHERE org_id = $1`,
    [orgId],
  );
  const countries = Array.isArray(cfgRes.rows[0]?.countries)
    ? cfgRes.rows[0].countries
    : [];

  const { rows } = await pool.query(
    `SELECT country, reachable, avg_rtt, min_rtt, max_rtt,
            probe_count, reachable_count, measured_at
     FROM org_globalping_results
     WHERE org_id = $1 AND server_id = $2 AND measured_at > unix_now() - 86400
     ORDER BY measured_at DESC, country ASC
     LIMIT 3000`,
    [orgId, serverId],
  );

  // Each measurement cycle inserts all countries with the same measured_at, so
  // group rows into per-timestamp snapshots. Cap to the 50 most recent cycles.
  const byTime = new Map();
  const order = [];
  for (const r of rows) {
    const t = Number(r.measured_at);
    let snap = byTime.get(t);
    if (!snap) {
      if (order.length >= 50) continue;
      snap = {};
      byTime.set(t, snap);
      order.push(t);
    }
    snap[r.country] = {
      reachable: r.reachable,
      avgRtt: r.avg_rtt != null ? Number(r.avg_rtt) : null,
      minRtt: r.min_rtt != null ? Number(r.min_rtt) : null,
      maxRtt: r.max_rtt != null ? Number(r.max_rtt) : null,
      probeCount: Number(r.probe_count),
      reachableCount: Number(r.reachable_count),
    };
  }

  return json({
    serverId: String(serverId),
    countries,
    snapshots: order.map((t) => ({ measuredAt: t, cells: byTime.get(t) })),
  });
}

async function handleTriggerGlobalpingMeasurements(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) return json({ error: "Forbidden" }, 403);

  const { rows: cfgRows } = await pool.query(
    `SELECT api_token_enc, countries, probes_per_country FROM org_globalping_config WHERE org_id = $1`,
    [orgId],
  );
  if (!cfgRows[0]) return json({ error: "Globalping not configured" }, 404);

  let apiToken = null;
  if (cfgRows[0].api_token_enc) {
    try {
      apiToken = decryptExternalApiKey(String(cfgRows[0].api_token_enc));
    } catch {
      apiToken = null;
    }
  }

  const { rows: servers } = await pool.query(
    `SELECT server_id, server_name, rcon_host FROM servers WHERE owner_org_id = $1 AND rcon_host IS NOT NULL`,
    [orgId],
  );
  if (!servers.length)
    return json({ error: "No servers with RCON configured" }, 400);

  const countries = Array.isArray(cfgRows[0].countries)
    ? cfgRows[0].countries
    : [];
  if (!countries.length) return json({ error: "No countries configured" }, 400);
  const probesPerCountry = Number(cfgRows[0].probes_per_country) || 3;
  let triggered = 0;

  for (const server of servers) {
    try {
      const msmId = await globalpingCreateMeasurement(
        server.rcon_host,
        countries,
        probesPerCountry,
        apiToken,
      );
      await pool.query(
        `INSERT INTO org_globalping_measurements (org_id, server_id, gp_measurement_id, target_ip) VALUES ($1, $2, $3, $4)`,
        [orgId, server.server_id, msmId, server.rcon_host],
      );
      triggered++;
    } catch (err) {
      console.warn(
        `[globalping] manual trigger failed org=${orgId} server=${server.server_name}: ${err.message}`,
      );
    }
  }

  return json({ triggered });
}

async function handleGetGlobalpingLimits(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

  const { rows } = await pool.query(
    `SELECT api_token_enc FROM org_globalping_config WHERE org_id = $1`,
    [orgId],
  );

  let apiToken = null;
  if (rows[0]?.api_token_enc) {
    try {
      apiToken = decryptExternalApiKey(String(rows[0].api_token_enc));
    } catch {
      // proceed unauthenticated
    }
  }

  try {
    const res = await globalpingFetch("/limits", {}, apiToken);
    if (!res.ok) return json({ error: "Globalping API error" }, 502);
    const data = await res.json();
    return json({ limits: data });
  } catch {
    return json({ error: "Failed to reach Globalping" }, 502);
  }
}

// ── Player connect ingest ─────────────────────────────────────────────────────

const CONNECT_INGEST_RATE_LIMIT_PER_MINUTE = 300;
const SESSION_DISCONNECT_FALLBACK_AFTER_SECONDS = 24 * 60 * 60;

async function closeStaleServerSessions({
  orgId = null,
  serverId = null,
  steamId = null,
}) {
  await pool.query(
    `UPDATE server_player_sessions
     SET disconnected_at = connected_at + $1
     WHERE disconnected_at IS NULL
       AND connected_at <= unix_now() - $1
       AND ($2::text IS NULL OR org_id = $2::text)
       AND ($3::uuid IS NULL OR server_id = $3::uuid)
       AND ($4::text IS NULL OR steam_id = $4::text)`,
    [SESSION_DISCONNECT_FALLBACK_AFTER_SECONDS, orgId, serverId, steamId],
  );
}

// Background IP-ban evasion enforcement. When a player connects from an IP that
// has an active IP ban in the org, auto-create a regular (Steam-ID) ban record
// linked back to that IP ban, mirror its server targets, and push the ban over
// RCON to the connecting server so the evader is removed immediately. Fully
// best-effort and idempotent — it must never break the connect ingest path.
async function enforceIpBanEvasion(server, steamId, ip, ipHash, playerName) {
  try {
    const orgId = server.owner_org_id;

    // Lookup uses identifier_hash (HMAC) so we never need to decrypt every row.
    const ipBanRes = await pool.query(
      `SELECT ban_id, category, reason, expires_at
       FROM player_bans
       WHERE org_id = $1 AND identifier_hash = $2 AND identifier_type = 'ip'
         AND action_type = 'ban' AND revoked = FALSE
         AND (expires_at IS NULL OR expires_at > unix_now())
       ORDER BY issued_at DESC
       LIMIT 1`,
      [orgId, ipHash],
    );
    const ipBan = ipBanRes.rows[0];
    if (!ipBan) return;

    // Idempotent: don't stack a second auto-ban for the same IP ban + player.
    const existing = await pool.query(
      `SELECT 1 FROM player_bans
       WHERE org_id = $1 AND identifier = $2 AND identifier_type = 'steam_id'
         AND action_type = 'ban' AND revoked = FALSE AND source_ip_ban_id = $3
       LIMIT 1`,
      [orgId, steamId, ipBan.ban_id],
    );
    if (existing.rows[0]) return;

    const reason = `Ban evasion — connected from banned IP (${ip})`.slice(
      0,
      500,
    );
    const note =
      `Auto-created: ${playerName ?? steamId} joined ${server.server_name} from IP ${ip}, which has an active IP ban. Linked to IP ban ${ipBan.ban_id}.${ipBan.reason ? ` Original reason: ${ipBan.reason}` : ""}`.slice(
        0,
        1000,
      );
    const newBanId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO player_bans
         (ban_id, org_id, action_type, identifier, identifier_type, category,
          reason, note, expires_at, issued_by, source_ip_ban_id)
       VALUES ($1, $2, 'ban', $3, 'steam_id', $4, $5, $6, $7, NULL, $8)`,
      [
        newBanId,
        orgId,
        steamId,
        ipBan.category ?? "ban_evasion",
        reason,
        note,
        ipBan.expires_at ?? null,
        ipBan.ban_id,
      ],
    );

    // Mirror the IP ban's server targets, plus the server being joined now.
    await pool.query(
      `INSERT INTO ban_server_targets (ban_id, server_id)
       SELECT $1, server_id FROM ban_server_targets WHERE ban_id = $2
       ON CONFLICT DO NOTHING`,
      [newBanId, ipBan.ban_id],
    );
    await pool.query(
      `INSERT INTO ban_server_targets (ban_id, server_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [newBanId, server.server_id],
    );

    // Push the ban to the connecting server over RCON so the evader is removed.
    const rconRes = await pool.query(
      `SELECT rcon_host, rcon_port, rcon_password_enc
       FROM servers WHERE server_id = $1`,
      [server.server_id],
    );
    const srv = rconRes.rows[0];
    if (srv?.rcon_host && srv?.rcon_port && srv?.rcon_password_enc) {
      try {
        const password = decryptPterodactylApiKey(
          String(srv.rcon_password_enc),
        );
        const rconUrl = `ws://${srv.rcon_host}:${srv.rcon_port}/${encodeURIComponent(password)}`;
        const safeReason = reason
          .replace(/[\r\n\x00-\x1f]/g, " ")
          .replace(/"/g, "'");
        await executeRconCommand(rconUrl, `ban ${steamId} "${safeReason}"`);
      } catch (err) {
        console.error(
          `[ip-ban-evasion] RCON ban failed for ${steamId}:`,
          err.message,
        );
      }
    }

    auditLog({
      orgId,
      actorUserId: null,
      resourceType: "ban",
      resourceId: newBanId,
      actionType: "BAN_CREATED",
      actionCategory: "moderation",
      severity: 3,
      metadata: {
        auto: true,
        sourceIpBanId: String(ipBan.ban_id),
        identifier: steamId,
        identifierType: "steam_id",
        matchedIp: ip,
        serverId: String(server.server_id),
      },
      ipAddress: null,
    });

    console.log(
      `[ip-ban-evasion] auto-banned ${steamId} on ${server.server_name} (IP ${ip} matched ban ${ipBan.ban_id})`,
    );
  } catch (err) {
    console.error("[ip-ban-evasion] error:", err.message);
  }
}

async function handleIngestPlayerConnect(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:connect:${server.server_id}`,
    CONNECT_INGEST_RATE_LIMIT_PER_MINUTE,
    60,
    "Rate limit exceeded",
  );
  if (rl) return rl;

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

  // Record the IP immediately with server context. IPs are stored encrypted at
  // rest; the HMAC hash is the lookup/unique key used for ban-evasion checks.
  if (ip) {
    const ipHash = ipHmac(ip);
    const ipEnc = encryptIp(ip);
    await pool.query(
      `INSERT INTO player_ip_history (steam_id, ip_hash, ip_encrypted, server_id, server_name, last_seen)
       VALUES ($1, $2, $3, $4, $5, unix_now())
       ON CONFLICT (steam_id, ip_hash) DO UPDATE SET
         last_seen   = unix_now(),
         server_id   = EXCLUDED.server_id,
         server_name = EXCLUDED.server_name`,
      [steamId, ipHash, ipEnc, server.server_id, server.server_name],
    );

    await pool.query(
      `INSERT INTO player_ip_observations (steam_id, ip_hash, org_id, server_id, last_seen)
       SELECT $1, $2, s.owner_org_id, $3, unix_now()
       FROM servers s WHERE s.server_id = $3
       ON CONFLICT (steam_id, ip_hash, org_id) DO UPDATE SET
         last_seen = unix_now(), server_id = EXCLUDED.server_id`,
      [steamId, ipHash, server.server_id],
    );

    await pool.query(
      `INSERT INTO player_ip_connection_events (steam_id, ip_hash, seen_at, server_id, server_name)
       VALUES ($1, $2, unix_now(), $3, $4)`,
      [steamId, ipHash, server.server_id, server.server_name ?? null],
    );

    // IP-ban evasion enforcement (fire-and-forget so connect stays fast).
    enforceIpBanEvasion(server, steamId, ip, ipHash, playerName).catch((err) =>
      console.error("[ip-ban-evasion] unhandled:", err.message),
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
  // If a disconnect event was missed, automatically close stale sessions.
  await closeStaleServerSessions({
    serverId: server.server_id,
    steamId,
  });
  // Close any dangling open session (handles reconnects after a crash)
  await pool.query(
    `UPDATE server_player_sessions
     SET disconnected_at = unix_now()
     WHERE server_id = $1 AND steam_id = $2 AND disconnected_at IS NULL`,
    [server.server_id, steamId],
  );
  await pool.query(
    `INSERT INTO server_player_sessions (org_id, server_id, steam_id, player_name, connected_at)
     VALUES ($1, $2, $3, $4, unix_now())`,
    [server.owner_org_id, server.server_id, steamId, playerName],
  );
  await pool.query(
    `INSERT INTO org_player_sightings (org_id, steam_id, last_seen_at)
     VALUES ($1, $2, unix_now())
     ON CONFLICT (org_id, steam_id) DO UPDATE SET last_seen_at = unix_now()`,
    [server.owner_org_id, steamId],
  );

  console.log(
    `[ingest:connect] player=${playerName ?? steamId} server=${server.server_name} refresh=${needsRefresh}(${refreshReason})`,
  );

  // If the org has "Sync Perms on Join" enabled, check whether this player is a
  // staff member whose role grants server_admin on this server, and if so re-issue
  // the in-game admin grant. Fire-and-forget — must never block or throw here.
  syncPermsOnJoinForPlayer(server, steamId, playerName).catch((err) =>
    console.error("[sync-perms-on-join] unhandled:", err.message),
  );

  return json({ ok: true });
}

// Best-effort: grant server_admin via RCON when the joining player is staff and
// the org has sync_perms_on_join enabled. Idempotent (moderatorid + usergroup are
// safe to re-apply). Runs fire-and-forget from handleIngestPlayerConnect.
async function syncPermsOnJoinForPlayer(server, steamId, playerName) {
  const orgId = server.owner_org_id;

  // Check the org setting first — skip everything if the toggle is off.
  const orgRes = await pool.query(
    `SELECT sync_perms_on_join FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (!orgRes.rows[0]?.sync_perms_on_join) return;

  // Find the member's role for this org.
  const memberRes = await pool.query(
    `SELECT om.role_id, u.username
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND u.steam_id = $2
     LIMIT 1`,
    [orgId, steamId],
  );
  const member = memberRes.rows[0];
  if (!member) return; // not a staff member

  // Check whether the role grants server_admin on this specific server.
  const targetIds = await resolveRoleServerAdminServerIds(
    orgId,
    member.role_id,
  );
  if (!targetIds.includes(String(server.server_id))) return;

  // Grant (from empty current set so the command always fires).
  const rconRows = await loadRconServersByIds(orgId, [
    String(server.server_id),
  ]);
  if (!rconRows.length) return;

  const cmds = serverAdminGrantCommands(steamId, member.username ?? playerName);
  const result = await runRconCommandsOnServer(rconRows[0], cmds);
  console.log(
    `[sync-perms-on-join] player=${playerName ?? steamId} server=${server.server_name} ok=${result.ok}${result.error ? ` err=${result.error}` : ""}`,
  );
}

async function handleIngestPlayerDisconnect(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:disconnect:${server.server_id}`,
    CONNECT_INGEST_RATE_LIMIT_PER_MINUTE,
    60,
    "Rate limit exceeded",
  );
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const steamId = String(body?.steam_id ?? "").trim();
  const playerName = body?.player_name ? String(body.player_name).trim() : null;

  if (!steamId) return json({ error: "steam_id is required" }, 400);
  if (!/^765611\d{11}$/.test(steamId))
    return json({ error: "Invalid Steam ID" }, 400);

  // Update last_seen_at in org sightings
  try {
    await pool.query(
      `UPDATE org_player_sightings
       SET last_seen_at = unix_now()
       WHERE org_id = $1 AND steam_id = $2`,
      [server.owner_org_id, steamId],
    );
  } catch {}

  // Close the active session
  try {
    await closeStaleServerSessions({
      serverId: server.server_id,
      steamId,
    });
    await pool.query(
      `UPDATE server_player_sessions
       SET disconnected_at = unix_now()
       WHERE server_id = $1 AND steam_id = $2 AND disconnected_at IS NULL`,
      [server.server_id, steamId],
    );
  } catch {}

  console.log(
    `[ingest:disconnect] player=${playerName ?? steamId} server=${server.server_name}`,
  );

  return json({ ok: true });
}

// ── Player lookup route handlers ──────────────────────────────────────────────

// Per-user caps for the player endpoints. Generous enough for normal staff
// browsing (50 concurrent users), tight enough to blunt scripted abuse.
const PLAYER_VIEW_RATE_LIMIT_PER_MINUTE = 120;
const PLAYER_REFRESH_RATE_LIMIT_PER_MINUTE = 20;
const PLAYER_NOTE_WRITE_RATE_LIMIT_PER_MINUTE = 30;
const PUBLIC_READ_RATE_LIMIT_PER_MINUTE = 60;
const FLAG_RESOLVE_RATE_LIMIT_PER_MINUTE = 60;

// Every org the session belongs to, selected org first. Used to let a player
// refresh borrow API keys from a sibling org when the selected org has none.
function sessionCandidateOrgIds(session, preferredOrgId) {
  const set = new Set();
  if (preferredOrgId) set.add(String(preferredOrgId));
  for (const id of Object.keys(session.orgPermissions ?? {}))
    set.add(String(id));
  for (const id of session.orgAdminOrgIds ?? []) set.add(String(id));
  for (const id of session.orgOwnerOrgIds ?? []) set.add(String(id));
  set.delete(SYSADMIN.globalOrgId);
  return Array.from(set);
}

// ── Cross-org data sharing ─────────────────────────────────────────────────────

// Data categories an org can grant another org read access to. Each org-relative
// datum belongs to one category; a grant carries a subset of these.
const SHARE_CATEGORIES = [
  "bans",
  "mutes",
  "ips",
  "notes",
  "reports",
  "sessions",
  "bm_bans",
  "alts",
];

async function getShareVersion() {
  try {
    return (await redis.get("share:ver")) ?? "0";
  } catch {
    return "0";
  }
}

// Any grant create/accept/revoke bumps this so the short-TTL resolution cache
// (keyed by version) is busted immediately rather than waiting for the TTL.
async function bumpShareVersion() {
  try {
    await redis.incr("share:ver");
  } catch {
    /* fail-open: stale reads self-heal within the cache TTL */
  }
}

// The set of *source* org ids whose `category` data the session may read: the
// caller's own member orgs, plus any org with an ACTIVE grant of that category to
// one of them. Briefly cached — the grant graph changes rarely and a version
// bump busts the cache on any change.
async function resolveEntitledOrgs(session, category) {
  const memberOrgs = sessionCandidateOrgIds(session, null);
  const base = new Set(memberOrgs);
  if (!memberOrgs.length) return base;

  const ver = await getShareVersion();
  const cacheKey = `share:resolve:${ver}:${category}:${[...memberOrgs]
    .sort()
    .join(",")}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return new Set(JSON.parse(cached));
  } catch {
    /* fall through to DB */
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT owner_org_id FROM org_share_grants
     WHERE status = 'active'
       AND grantee_org_id = ANY($1)
       AND $2 = ANY(categories)`,
    [memberOrgs, category],
  );
  for (const r of rows) base.add(String(r.owner_org_id));

  const arr = [...base];
  try {
    await redis.set(cacheKey, JSON.stringify(arr), "EX", 30);
  } catch {
    /* non-critical */
  }
  return new Set(arr);
}

function serializeShareGrant(r, selfOrgId) {
  return {
    id: r.grant_id,
    ownerOrgId: r.owner_org_id,
    ownerOrgName: r.owner_org_name ?? null,
    granteeOrgId: r.grantee_org_id,
    granteeOrgName: r.grantee_org_name ?? null,
    categories: Array.isArray(r.categories) ? r.categories : [],
    notesShareLevel: r.notes_share_level ?? 1,
    status: r.status,
    // Direction relative to the org viewing the list, so the UI can label it.
    direction: r.owner_org_id === selfOrgId ? "outgoing" : "incoming",
    createdAt: r.created_at,
    acceptedAt: r.accepted_at ?? null,
  };
}

async function handleListShareGrants(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId))
    return json({ error: "Forbidden: org admin/owner required" }, 403);

  const { rows } = await pool.query(
    `SELECT g.*, ow.name AS owner_org_name, gr.name AS grantee_org_name
     FROM org_share_grants g
     LEFT JOIN organizations ow ON ow.org_id = g.owner_org_id
     LEFT JOIN organizations gr ON gr.org_id = g.grantee_org_id
     WHERE (g.owner_org_id = $1 OR g.grantee_org_id = $1)
       AND g.status <> 'revoked'
     ORDER BY g.created_at DESC`,
    [orgId],
  );
  return json({
    grants: rows.map((r) => serializeShareGrant(r, orgId)),
    categories: SHARE_CATEGORIES,
  });
}

async function handleCreateShareGrant(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId))
    return json({ error: "Forbidden: org admin/owner required" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const granteeOrgId = String(body?.granteeOrgId ?? "").trim();
  if (!granteeOrgId) return json({ error: "granteeOrgId is required" }, 400);
  if (granteeOrgId === orgId)
    return json({ error: "Cannot share with the same org" }, 400);

  const categories = Array.isArray(body?.categories)
    ? [...new Set(body.categories.map(String))].filter((c) =>
        SHARE_CATEGORIES.includes(c),
      )
    : [];
  if (!categories.length)
    return json({ error: "At least one valid category is required" }, 400);

  // Note share ceiling (only meaningful when 'notes' is shared): clamp to the
  // valid min_rank range 1–4.
  const notesShareLevel = Math.min(
    4,
    Math.max(1, Number.parseInt(body?.notesShareLevel ?? 1, 10) || 1),
  );

  const granteeRes = await pool.query(
    `SELECT 1 FROM organizations WHERE org_id = $1 LIMIT 1`,
    [granteeOrgId],
  );
  if (!granteeRes.rows[0])
    return json({ error: "Grantee organization not found" }, 404);

  // Re-offering an existing grant updates its categories and resets it to
  // pending so the grantee re-confirms what they're now receiving.
  const { rows } = await pool.query(
    `INSERT INTO org_share_grants
       (owner_org_id, grantee_org_id, categories, notes_share_level, status, created_by)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT (owner_org_id, grantee_org_id) DO UPDATE SET
       categories = EXCLUDED.categories,
       notes_share_level = EXCLUDED.notes_share_level,
       status = 'pending',
       created_by = EXCLUDED.created_by,
       created_at = unix_now(),
       accepted_at = NULL,
       revoked_at = NULL
     RETURNING grant_id`,
    [orgId, granteeOrgId, categories, notesShareLevel, session.userId],
  );
  await bumpShareVersion();
  return json({ ok: true, grantId: rows[0].grant_id });
}

async function handleAcceptShareGrant(request, orgId, grantId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId))
    return json({ error: "Forbidden: org admin/owner required" }, 403);

  // Only the grantee can accept, and only a pending grant.
  const { rows } = await pool.query(
    `UPDATE org_share_grants
     SET status = 'active', accepted_at = unix_now()
     WHERE grant_id = $1 AND grantee_org_id = $2 AND status = 'pending'
     RETURNING grant_id`,
    [grantId, orgId],
  );
  if (!rows[0]) return json({ error: "No pending grant to accept" }, 404);
  await bumpShareVersion();
  return json({ ok: true });
}

async function handleRevokeShareGrant(request, orgId, grantId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId))
    return json({ error: "Forbidden: org admin/owner required" }, 403);

  // Either side can tear down the arrangement.
  const { rows } = await pool.query(
    `DELETE FROM org_share_grants
     WHERE grant_id = $1 AND (owner_org_id = $2 OR grantee_org_id = $2)
     RETURNING grant_id`,
    [grantId, orgId],
  );
  if (!rows[0]) return json({ error: "Grant not found" }, 404);
  await bumpShareVersion();
  return json({ ok: true });
}

// Privacy: when a staffer enables "private profile", other staff must not be
// able to pull their player intel — only the person themselves and the platform
// sysadmin can. Their online presence stays visible (returned in the protected
// payload). Returns the matching staff identity for a steamId, or null.
async function getStaffIdentityForSteamId(steamId) {
  const { rows } = await pool.query(
    `SELECT user_id, username, profile_private
     FROM users WHERE steam_id = $1 LIMIT 1`,
    [steamId],
  );
  if (!rows[0]) return null;
  return {
    userId: String(rows[0].user_id),
    username: rows[0].username ?? null,
    profilePrivate: Boolean(rows[0].profile_private),
  };
}

// True when `session` is allowed to bypass another staffer's privacy (it's their
// own profile, or the caller is the configured sysadmin).
function canBypassStaffPrivacy(session, staff) {
  return (
    staff.userId === String(session.userId) || isConfiguredSysAdmin(session)
  );
}

// Short-circuit payload for a protected lookup: no profile intel, just identity
// and live online presence (5-min presence key set on every authed request).
async function buildProtectedPlayerPayload(steamId, staff) {
  let lastSeenAt = null;
  try {
    const ts = await redis.get(`online:${staff.userId}`);
    if (ts) lastSeenAt = Number(ts);
  } catch {
    /* presence unknown → treat as offline */
  }
  return json({
    protected: true,
    steamId,
    displayName: staff.username,
    online: lastSeenAt != null,
    lastSeenAt,
  });
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

  // Privacy gate — a private staffer can't be looked up by their peers.
  const staffIdentity = await getStaffIdentityForSteamId(steamId);
  if (
    staffIdentity?.profilePrivate &&
    !canBypassStaffPrivacy(session, staffIdentity)
  ) {
    return buildProtectedPlayerPayload(steamId, staffIdentity);
  }

  // Every view writes an audit row; cap per-user so the endpoint can't be used
  // to flood the audit log or the read pool.
  const rl = await checkRateLimit(
    `rl:player-view:${session.userId}`,
    PLAYER_VIEW_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (rl) return rl;

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

  // IP + external-ban visibility is resolved across all the caller's orgs (+
  // shares), not a single org — each datum is tagged with its source org(s) so
  // the client can filter by the active org selection.
  const ipEntitlement = await entitledIpSourceOrgs(session);
  const bmEntitlement = await entitledOrgsForCategory(session, "bm_bans", (o) =>
    orgHasPermission(session, o, "players_view"),
  );
  const candidateOrgIds = sessionCandidateOrgIds(session, orgId);
  const needsRichIpMetadataBackfill = (payload) =>
    (payload?.ipHistory ?? []).some((ip) => {
      if (!ip || typeof ip !== "object") return false;
      const hasRich =
        ip.proxycheckData ||
        ip.rawType ||
        ip.riskScore != null ||
        ip.riskConfidence ||
        ip.estimate ||
        ip.lastUpdate ||
        ip.hostname ||
        ip.company ||
        ip.organization ||
        ip.addressRange ||
        ip.city ||
        ip.region ||
        ip.continent ||
        ip.timezone ||
        ip.postalCode ||
        ip.currency ||
        ip.latitude != null ||
        ip.longitude != null;
      return !hasRich;
    });

  // Redis first — avoids 6 PostgreSQL queries on the hot path
  const fromRedis = await getPlayerDataFromRedis(steamId);
  if (fromRedis) {
    if (fromRedis.isStale || needsRichIpMetadataBackfill(fromRedis)) {
      refreshPlayerData(steamId, orgId, candidateOrgIds).catch((err) =>
        console.error(`[player] bg refresh error for ${steamId}:`, err.message),
      );
    }
    return json(applyShareEntitlement(fromRedis, ipEntitlement, bmEntitlement));
  }

  // Redis miss — fall back to PostgreSQL
  const cached = await getPlayerCacheData(steamId);

  if (!cached) {
    // No cache at all — kick off background refresh and tell the client to poll
    refreshPlayerData(steamId, orgId, candidateOrgIds).catch((err) =>
      console.error(`[player] bg refresh error for ${steamId}:`, err.message),
    );
    return json({ fetching: true });
  }

  if (cached.isStale || needsRichIpMetadataBackfill(cached)) {
    // Return stale data immediately; refresh in the background
    refreshPlayerData(steamId, orgId, candidateOrgIds).catch((err) =>
      console.error(`[player] bg refresh error for ${steamId}:`, err.message),
    );
  }

  return json(applyShareEntitlement(cached, ipEntitlement, bmEntitlement));
}

async function handleGetPlayerIpBanEligibility(request, orgId, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canCreateBans(session, orgId)) {
    return json({ error: "Forbidden: ban create permission required" }, 403);
  }
  if (!canIssueIpBans(session, orgId)) {
    return json({ allowed: false, reason: "IP ban permission required" });
  }
  if (!/^\d{17}$/.test(String(steamId ?? ""))) {
    return json({ error: "Invalid Steam ID" }, 400);
  }

  const latestIpRow = await pool.query(
    `SELECT pih.ip_encrypted
     FROM player_ip_history pih
     WHERE pih.steam_id = $1
       AND (
         pih.server_id IS NULL
         OR pih.server_id IN (
           SELECT s.server_id FROM servers s WHERE s.owner_org_id = $2
         )
       )
     ORDER BY pih.last_seen DESC
     LIMIT 1`,
    [steamId, orgId],
  );

  if (latestIpRow.rows.length === 0 || !latestIpRow.rows[0].ip_encrypted) {
    return json({
      allowed: false,
      reason: "No known recent IP for this player in this org.",
      latestIp: null,
      connectionType: "unknown",
      isProxyVpn: false,
    });
  }

  let latestIp = null;
  try {
    latestIp = decryptIp(String(latestIpRow.rows[0].ip_encrypted));
  } catch {
    return json({
      allowed: false,
      reason: "Could not read the player's latest IP for verification.",
      latestIp: null,
      connectionType: "unknown",
      isProxyVpn: false,
    });
  }

  const eligibility = await evaluateIpBanEligibility(orgId, latestIp);
  return json({
    allowed: eligibility.eligible,
    reason: eligibility.reason ?? null,
    latestIp,
    connectionType: eligibility.connectionType ?? "unknown",
    isProxyVpn: eligibility.isProxyVpn === true,
  });
}

async function handleGetOrgPlayerOnlineStatus(request, orgId, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!/^\d{17}$/.test(String(steamId ?? ""))) {
    return json({ error: "Invalid Steam ID" }, 400);
  }

  // Player lookup is cross-org in practice; resolve live presence across every
  // org this caller can view so we don't incorrectly show "offline" when the
  // player is online in another entitled org's server.
  const candidateOrgs = sessionCandidateOrgIds(session, orgId).filter((o) =>
    orgHasPermission(session, o, "players_view"),
  );
  if (candidateOrgs.length === 0) {
    return json({ error: "Forbidden: players_view permission required" }, 403);
  }

  // Keep online status accurate even if a plugin missed a disconnect event.
  await closeStaleServerSessions({ steamId });

  const activeRes = await pool.query(
    `SELECT sps.org_id, sps.server_id::text AS server_id, s.server_name, sps.connected_at
     FROM server_player_sessions sps
     JOIN servers s ON s.server_id = sps.server_id
     WHERE sps.steam_id = $1
       AND sps.org_id = ANY($2::text[])
       AND sps.disconnected_at IS NULL
     ORDER BY sps.connected_at DESC
     LIMIT 1`,
    [steamId, candidateOrgs],
  );

  const row = activeRes.rows[0] ?? null;
  return json({
    isOnline: Boolean(row),
    orgId: row?.org_id ?? null,
    serverId: row?.server_id ?? null,
    serverName: row?.server_name ?? null,
    connectedAt: row?.connected_at != null ? Number(row.connected_at) : null,
  });
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

  // Privacy gate — never spend external API calls refreshing a peer's private
  // profile; return the same protected payload as the read path.
  const staffIdentity = await getStaffIdentityForSteamId(steamId);
  if (
    staffIdentity?.profilePrivate &&
    !canBypassStaffPrivacy(session, staffIdentity)
  ) {
    return buildProtectedPlayerPayload(steamId, staffIdentity);
  }

  // Force-refresh triggers external BattleMetrics/Steam/Proxycheck calls against
  // the org's rotating keys. Cap per-user to prevent cost amplification / hammering
  // those upstream APIs (and our own pool) by spamming distinct Steam IDs.
  const rl = await checkRateLimit(
    `rl:player-refresh:${session.userId}`,
    PLAYER_REFRESH_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (rl) return rl;

  // Check BM rate limit usage for this org — warn if >90% consumed this hour
  let bmRateLimitWarning = false;
  try {
    const bucketHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const statsRes = await pool.query(
      `SELECT rate_limit_max, rate_limit_min_remaining
       FROM org_external_api_key_stats
       WHERE org_id = $1 AND service = 'battlemetrics' AND bucket_hour = $2
       ORDER BY rate_limit_min_remaining ASC NULLS LAST
       LIMIT 1`,
      [orgId, bucketHour],
    );
    const stat = statsRes.rows[0];
    if (stat?.rate_limit_max && stat.rate_limit_min_remaining != null) {
      const used = stat.rate_limit_max - stat.rate_limit_min_remaining;
      if (used / stat.rate_limit_max >= 0.9) bmRateLimitWarning = true;
    }
  } catch {
    // non-critical
  }

  const ipEntitlement = await entitledIpSourceOrgs(session);
  const bmEntitlement = await entitledOrgsForCategory(session, "bm_bans", (o) =>
    orgHasPermission(session, o, "players_view"),
  );
  const candidateOrgIds = sessionCandidateOrgIds(session, orgId);

  // Clear Redis so the background refresh can acquire the lock and write fresh data
  try {
    await redis.del(playerRedisKey(steamId));
  } catch {}

  // Fire the refresh in the background; poll Redis for core data (written mid-refresh,
  // after BM/Steam calls complete) rather than awaiting the full ~4s pipeline.
  // Once the refresh completes, evaluate threat triggers against the fresh data.
  refreshPlayerData(steamId, orgId, candidateOrgIds, {
    forceProxycheckRefresh: true,
  })
    .then(() => evaluateThreatTriggers(orgId, steamId, "refresh"))
    .catch((err) =>
      console.error(`[player:refresh] bg error for ${steamId}:`, err.message),
    );

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const fresh = await getPlayerDataFromRedis(steamId);
    if (fresh) {
      const payload = applyShareEntitlement(
        fresh,
        ipEntitlement,
        bmEntitlement,
      );
      if (bmRateLimitWarning) payload.bmRateLimitWarning = true;
      return json(payload);
    }
  }

  // Core data not yet in Redis — tell the client to poll (same as a first-time fetch)
  return json({ fetching: true, bmRateLimitWarning });
}

// ── Player kick via RCON ──────────────────────────────────────────────────────

async function handleKickPlayer(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId");
  const serverId = url.searchParams.get("serverId");
  if (!orgId) return json({ error: "orgId query parameter required" }, 400);
  if (!serverId)
    return json({ error: "serverId query parameter required" }, 400);

  if (!orgHasPermission(session, orgId, "player_kick"))
    return json({ error: "Forbidden: player_kick permission required" }, 403);

  const serverRes = await pool.query(
    `SELECT server_id, server_name, owner_org_id, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1 LIMIT 1`,
    [serverId],
  );
  const server = serverRes.rows[0];
  if (!server) return json({ error: "Server not found" }, 404);
  if (server.owner_org_id !== orgId) return json({ error: "Forbidden" }, 403);

  if (!server.rcon_host || !server.rcon_port || !server.rcon_password_enc)
    return json({ error: "RCON is not configured for this server" }, 400);

  try {
    const password = decryptPterodactylApiKey(String(server.rcon_password_enc));
    const rconUrl = `ws://${server.rcon_host}:${server.rcon_port}/${encodeURIComponent(password)}`;
    const result = await executeRconCommand(rconUrl, `kick ${steamId}`);
    await auditLog({
      orgId,
      actorUserId: session.userId,
      resourceType: "player",
      resourceId: steamId,
      actionType: "PLAYER_KICKED",
      actionCategory: "moderation",
      severity: 2,
      metadata: { steamId, serverId, serverName: server.server_name },
    });
    return json({ ok: true, result: result?.response ?? null });
  } catch (err) {
    return json({ error: `RCON logout failed: ${err.message}` }, 502);
  }
}

// ── Player chat history ───────────────────────────────────────────────────────

async function handleGetPlayerChat(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId");
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "100", 10),
    200,
  );
  const before = url.searchParams.get("before")
    ? Math.floor(Number(url.searchParams.get("before")))
    : null;

  const candidateOrgIds = sessionCandidateOrgIds(session, null).filter(
    (o) =>
      orgHasPermission(session, o, "chat_view") ||
      orgHasPermission(session, o, "players_view") ||
      orgHasPermission(session, o, "org_manage"),
  );

  let scopedOrgIds;
  if (orgId) {
    if (!candidateOrgIds.includes(String(orgId)))
      return json(
        {
          error:
            "Forbidden: chat_view, players_view, or org_manage permission required",
        },
        403,
      );
    scopedOrgIds = [String(orgId)];
  } else {
    scopedOrgIds = candidateOrgIds;
  }

  if (scopedOrgIds.length === 0) return json({ lines: [], hasMore: false });

  const params = [steamId, scopedOrgIds, limit + 1];
  let idx = 4;
  let beforeClause = "";
  if (before != null) {
    beforeClause = ` AND tcl.created_at < $${idx++}`;
    params.push(before);
  }

  const { rows } = await pool.query(
    `SELECT tcl.id, tcl.message, tcl.steam_id, tcl.player_name, tcl.team_message,
            tcl.created_at AS ts, s.server_name, s.server_id
     FROM text_chat_log tcl
     JOIN servers s ON s.server_id = tcl.server_id
     WHERE tcl.steam_id = $1
       AND s.owner_org_id = ANY($2)${beforeClause}
     ORDER BY tcl.created_at DESC
     LIMIT $3`,
    params,
  );

  const hasMore = rows.length > limit;
  const lines = rows.slice(0, limit).map((r) => ({
    id: String(r.id),
    message: String(r.message),
    steamId: String(r.steam_id),
    playerName: r.player_name ?? null,
    teamMessage: Boolean(r.team_message),
    ts: Number(r.ts),
    serverName: r.server_name ?? null,
    serverId: String(r.server_id),
  }));

  return json({ lines, hasMore });
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

// Sysadmin: clear bogus rate-limit timers on external API keys. The old
// rotation disabled a Steam key for 1h whenever a looked-up profile was private
// (401 misread as a bad key), leaving orgs with "no available keys". This
// re-enables any key that is only rate-limited; keys disabled in the UI
// (enabled=FALSE) are left untouched.
async function handleResetExternalKeyLimits(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isConfiguredSysAdmin(session))
    return json({ error: "Forbidden: sysadmin only" }, 403);

  const { rowCount } = await pool.query(
    `UPDATE org_external_api_keys
     SET rate_limited_until = NULL
     WHERE rate_limited_until IS NOT NULL`,
  );
  return json({ ok: true, cleared: rowCount ?? 0 });
}

async function handleTestMediaBucket(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isConfiguredSysAdmin(session))
    return json({ error: "Forbidden: sysadmin only" }, 403);

  if (!r2Configured()) {
    return json(
      {
        ok: false,
        error:
          "R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME.",
      },
      503,
    );
  }

  try {
    const { key } = await testR2BucketWriteDelete();
    return json({ ok: true, message: "Bucket write/delete test passed.", key });
  } catch (err) {
    const details =
      err?.name && err?.message
        ? `${err.name}: ${err.message}`
        : err?.message || "Bucket test failed";
    console.error("[r2] sysadmin bucket test failed:", details);
    return json(
      {
        ok: false,
        error: "Bucket write/delete test failed.",
        details,
      },
      502,
    );
  }
}

// ── Sysadmin: diagnostic metrics ─────────────────────────────────────────────

async function handleGetSysMetrics(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isConfiguredSysAdmin(session))
    return json({ error: "Forbidden: sysadmin only" }, 403);

  // Compute per-route aggregates from the incoming buffer
  const routeStats = new Map();
  for (const e of diagIncoming) {
    const key = `${e.method} ${e.route}`;
    const s = routeStats.get(key) ?? {
      method: e.method,
      route: e.route,
      count: 0,
      totalMs: 0,
      errors: 0,
      latencies: [],
    };
    s.count++;
    s.totalMs += e.ms;
    s.latencies.push(e.ms);
    if (e.status < 200 || e.status >= 300) s.errors++;
    routeStats.set(key, s);
  }
  const routes = [...routeStats.values()]
    .map((s) => {
      const sorted = [...s.latencies].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      const avg = s.count ? Math.round(s.totalMs / s.count) : 0;
      return {
        method: s.method,
        route: s.route,
        count: s.count,
        avg,
        p50,
        p95,
        errors: s.errors,
      };
    })
    .sort((a, b) => b.count - a.count);

  return json({
    incoming: [...diagIncoming].reverse().slice(0, 500),
    outgoing: [...diagOutgoing].reverse().slice(0, 500),
    errors: [...diagErrors].reverse().slice(0, 500),
    routes,
  });
}

// ── Database usage / storage summary (sysadmin) ──────────────────────────────

async function handleGetDbUsage(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isConfiguredSysAdmin(session))
    return json({ error: "Forbidden: sysadmin only" }, 403);

  // Per-table sizes + row estimates from the system catalogs. Row counts use
  // the planner's live-tuple estimate (n_live_tup, falling back to reltuples)
  // rather than COUNT(*) so the query stays cheap on large tables.
  const tablesRes = await pool.query(`
    SELECT
      c.relname AS name,
      GREATEST(
        COALESCE(s.n_live_tup, 0),
        CASE WHEN c.reltuples < 0 THEN 0 ELSE c.reltuples::bigint END
      ) AS row_estimate,
      COALESCE(s.n_dead_tup, 0) AS dead_tuples,
      pg_total_relation_size(c.oid) AS total_bytes,
      pg_table_size(c.oid) AS table_bytes,
      pg_indexes_size(c.oid) AS index_bytes,
      EXTRACT(EPOCH FROM GREATEST(s.last_vacuum, s.last_autovacuum))::bigint AS last_vacuum_unix,
      EXTRACT(EPOCH FROM GREATEST(s.last_analyze, s.last_autoanalyze))::bigint AS last_analyze_unix
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relkind = 'r' AND n.nspname = 'public'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `);

  const tables = tablesRes.rows.map((r) => ({
    name: String(r.name),
    rowEstimate: Number(r.row_estimate) || 0,
    deadTuples: Number(r.dead_tuples) || 0,
    totalBytes: Number(r.total_bytes) || 0,
    tableBytes: Number(r.table_bytes) || 0,
    indexBytes: Number(r.index_bytes) || 0,
    lastVacuumUnix:
      r.last_vacuum_unix == null ? null : Number(r.last_vacuum_unix),
    lastAnalyzeUnix:
      r.last_analyze_unix == null ? null : Number(r.last_analyze_unix),
  }));

  let dbName = null;
  let dbBytes = 0;
  try {
    const dbRes = await pool.query(
      `SELECT current_database() AS name, pg_database_size(current_database()) AS bytes`,
    );
    dbName = dbRes.rows[0]?.name ?? null;
    dbBytes = Number(dbRes.rows[0]?.bytes) || 0;
  } catch {
    // best-effort; per-table data is the important part
  }

  const poolStats = {
    max: pool?.options?.max ?? null,
    total: pool?.totalCount ?? null,
    idle: pool?.idleCount ?? null,
    waiting: pool?.waitingCount ?? null,
  };

  let redisStats = { available: false };
  try {
    const memInfo = await redis.info("memory");
    const keyspaceInfo = await redis.info("keyspace");
    const usedMemory = Number(/used_memory:(\d+)/.exec(memInfo)?.[1] ?? 0);
    const usedMemoryHuman =
      /used_memory_human:([^\r\n]+)/.exec(memInfo)?.[1]?.trim() ?? null;
    const maxMemory = Number(/maxmemory:(\d+)/.exec(memInfo)?.[1] ?? 0);
    let keys = 0;
    for (const m of keyspaceInfo.matchAll(/keys=(\d+)/g)) keys += Number(m[1]);
    redisStats = {
      available: true,
      usedMemory,
      usedMemoryHuman,
      maxMemory,
      keys,
    };
  } catch {
    redisStats = { available: false };
  }

  return json({
    database: { name: dbName, totalBytes: dbBytes, tableCount: tables.length },
    tables,
    pool: poolStats,
    redis: redisStats,
    generatedAt: Math.floor(Date.now() / 1000),
  });
}

// ── Player reports by Steam ID ────────────────────────────────────────────────

async function handleGetPlayerReports(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  // Privacy gate — a private staffer's reports are part of their hidden profile.
  const staffIdentity = await getStaffIdentityForSteamId(steamId);
  if (
    staffIdentity?.profilePrivate &&
    !canBypassStaffPrivacy(session, staffIdentity)
  ) {
    return json({ reports: [], protected: true });
  }

  // Reports are resolved across every org the caller may view (own orgs with
  // players_view + 'reports' shares), each tagged with its source org so the
  // client can filter by the active org selection.
  const reportOrgs = await entitledOrgsForCategory(session, "reports", (o) =>
    orgHasPermission(session, o, "players_view"),
  );
  const isSys = reportOrgs === null;
  const orgArr = isSys ? [] : [...reportOrgs];
  if (!isSys && orgArr.length === 0) return json({ reports: [] });

  const { rows } = await pool.query(
    `SELECT pr.id, pr.report_type, pr.report_reason, pr.report_description,
            pr.reporter_name, pr.reporter_steam_id, pr.server_name, pr.created_at,
            s.owner_org_id, o.name AS org_name
     FROM player_reports pr
     JOIN servers s ON s.server_id = pr.server_id
     LEFT JOIN organizations o ON o.org_id = s.owner_org_id
     WHERE pr.reported_steam_id = $1
       AND ($2::boolean OR s.owner_org_id = ANY($3))
     ORDER BY pr.created_at DESC
     LIMIT 200`,
    [steamId, isSys, orgArr],
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
    orgId: row.owner_org_id ? String(row.owner_org_id) : null,
    orgName: row.org_name ?? null,
    sourceOrgIds: row.owner_org_id ? [String(row.owner_org_id)] : [],
  }));

  return json({ reports });
}

// ── Player notes ──────────────────────────────────────────────────────────────

const PLAYER_NOTE_MAX_LEN = 4000;

function serializePlayerNote(row) {
  return {
    id: String(row.id),
    subjectId: String(row.subject_steam_id),
    body: String(row.body),
    authorId: row.author_user_id ?? null,
    authorName: row.author_name ?? null,
    minRank: Number(row.min_rank),
    requiredRoleId: row.required_role_id ?? null,
    pinned: Boolean(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function handleListPlayerNotes(request, orgId, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);
  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const rank = sessionRankForOrg(session, orgId);
  const { rows } = await pool.query(
    `SELECT id, subject_steam_id, body, author_user_id, author_name,
            min_rank, required_role_id, pinned, created_at, updated_at
     FROM player_notes
     WHERE org_id = $1 AND subject_steam_id = $2 AND (
       $3 >= 4
       OR (required_role_id IS NULL AND min_rank <= $3)
       OR EXISTS (
         SELECT 1 FROM organization_members
         WHERE user_id = $4 AND org_id = $1 AND role_id = required_role_id
       )
     )
     ORDER BY pinned DESC, created_at DESC`,
    [orgId, steamId, rank, session.userId],
  );

  return json({ notes: rows.map(serializePlayerNote) });
}

// Combined notes across every org the caller may view: their own orgs (rank-gated
// as usual) plus notes shared in by other orgs. A sharing org chooses a ceiling
// (notes_share_level) — only its notes at/below that min_rank and NOT gated to a
// specific role are shared, since roles don't translate across orgs. Shared notes
// are read-only to the grantee and tagged with their source org.
async function handleListPlayerNotesCombined(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  // Privacy gate — a private staffer's notes are part of their hidden profile.
  const staffIdentity = await getStaffIdentityForSteamId(steamId);
  if (
    staffIdentity?.profilePrivate &&
    !canBypassStaffPrivacy(session, staffIdentity)
  ) {
    return json({ notes: [], protected: true });
  }

  const memberOrgs = [...orgsWithPermission(session, "players_view")];
  if (!memberOrgs.length) return json({ notes: [] });

  const byId = new Map();

  // Own-org notes, rank-gated by the caller's rank in each org (same rule as the
  // single-org endpoint).
  for (const org of memberOrgs) {
    const rank = sessionRankForOrg(session, org);
    const { rows } = await pool.query(
      `SELECT n.id, n.org_id, n.subject_steam_id, n.body, n.author_user_id,
              n.author_name, n.min_rank, n.required_role_id, n.pinned,
              n.created_at, n.updated_at, o.name AS org_name
       FROM player_notes n
       LEFT JOIN organizations o ON o.org_id = n.org_id
       WHERE n.org_id = $1 AND n.subject_steam_id = $2 AND (
         $3 >= 4
         OR (n.required_role_id IS NULL AND n.min_rank <= $3)
         OR EXISTS (
           SELECT 1 FROM organization_members
           WHERE user_id = $4 AND org_id = $1 AND role_id = n.required_role_id
         )
       )`,
      [org, steamId, rank, session.userId],
    );
    for (const r of rows) byId.set(String(r.id), { row: r, shared: false });
  }

  // Shared-in notes: orgs that granted 'notes' to one of the caller's orgs, only
  // up to that grant's level and excluding role-gated notes.
  const { rows: sharedRows } = await pool.query(
    `SELECT DISTINCT ON (n.id)
            n.id, n.org_id, n.subject_steam_id, n.body, n.author_user_id,
            n.author_name, n.min_rank, n.required_role_id, n.pinned,
            n.created_at, n.updated_at, o.name AS org_name
     FROM org_share_grants g
     JOIN player_notes n ON n.org_id = g.owner_org_id
     LEFT JOIN organizations o ON o.org_id = g.owner_org_id
     WHERE g.status = 'active' AND 'notes' = ANY(g.categories)
       AND g.grantee_org_id = ANY($1)
       AND n.subject_steam_id = $2
       AND n.required_role_id IS NULL
       AND n.min_rank <= g.notes_share_level
     ORDER BY n.id`,
    [memberOrgs, steamId],
  );
  for (const r of sharedRows) {
    const id = String(r.id);
    if (!byId.has(id)) byId.set(id, { row: r, shared: true });
  }

  const notes = [...byId.values()].map(({ row, shared }) => ({
    ...serializePlayerNote(row),
    orgId: String(row.org_id),
    orgName: row.org_name ?? null,
    shared,
    sourceOrgIds: [String(row.org_id)],
  }));
  notes.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt,
  );

  return json({ notes });
}

async function handleGetOrgNoteRoles(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const { rows } = await pool.query(
    `SELECT role_id, role_name, position FROM roles
     WHERE role_id LIKE ($1 || '_%')
       AND role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
     ORDER BY position DESC, role_name ASC`,
    [orgId],
  );

  return json({
    roles: rows.map((r) => ({
      roleId: String(r.role_id),
      roleName: String(r.role_name),
    })),
  });
}

async function handleCreatePlayerNote(request, orgId, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);
  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const rl = await checkRateLimit(
    `rl:player-note:${session.userId}`,
    PLAYER_NOTE_WRITE_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const text = String(body?.body ?? "").trim();
  if (!text) return json({ error: "body is required" }, 400);
  if (text.length > PLAYER_NOTE_MAX_LEN)
    return json(
      { error: `body must be ${PLAYER_NOTE_MAX_LEN} characters or fewer` },
      400,
    );

  let requiredRoleId = null;
  if (body?.requiredRoleId != null) {
    const roleId = String(body.requiredRoleId).trim();
    if (roleId) {
      const roleCheck = await pool.query(
        `SELECT role_id FROM roles WHERE role_id = $1 AND starts_with(role_id, $2 || '_') LIMIT 1`,
        [roleId, orgId],
      );
      if (!roleCheck.rows[0])
        return json({ error: "Role not found in this org" }, 400);
      requiredRoleId = roleId;
    }
  }

  // Sensitivity level (min_rank 1–4: all-staff → management-only), which also
  // determines whether the note is eligible for cross-org sharing. A role-gated
  // note is visible only to that role, so its level is moot — pin it at 1.
  const minRank = requiredRoleId
    ? 1
    : Math.min(4, Math.max(1, Number.parseInt(body?.minRank ?? 1, 10) || 1));

  const { rows } = await pool.query(
    `INSERT INTO player_notes
       (org_id, subject_steam_id, body, author_user_id, author_name, min_rank, required_role_id, pinned)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, subject_steam_id, body, author_user_id, author_name,
               min_rank, required_role_id, pinned, created_at, updated_at`,
    [
      orgId,
      steamId,
      text,
      session.userId,
      session.username ?? null,
      minRank,
      requiredRoleId,
      Boolean(body?.pinned),
    ],
  );

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "player_note",
    resourceId: steamId,
    actionType: "PLAYER_NOTE_CREATED",
    actionCategory: "player_management",
    severity: 1,
    metadata: { noteId: String(rows[0].id) },
    ipAddress: getClientIp(request),
  });

  return json({ note: serializePlayerNote(rows[0]) }, 201);
}

async function handleUpdatePlayerNote(request, orgId, steamId, noteId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);
  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const existing = await pool.query(
    `SELECT author_user_id FROM player_notes
     WHERE id = $1 AND org_id = $2 AND subject_steam_id = $3`,
    [noteId, orgId, steamId],
  );
  if (!existing.rows[0]) return json({ error: "Note not found" }, 404);

  // Author or management (rank ≥ 4) may edit/pin — matches the prior client rule.
  const isAuthor = existing.rows[0].author_user_id === session.userId;
  if (!isAuthor && sessionRankForOrg(session, orgId) < 4)
    return json({ error: "Forbidden: not your note" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const setClauses = [];
  const params = [];
  if (body?.body !== undefined) {
    const text = String(body.body).trim();
    if (!text) return json({ error: "body is required" }, 400);
    if (text.length > PLAYER_NOTE_MAX_LEN)
      return json(
        { error: `body must be ${PLAYER_NOTE_MAX_LEN} characters or fewer` },
        400,
      );
    params.push(text);
    setClauses.push(`body = $${params.length}`);
  }
  if (body?.pinned !== undefined) {
    params.push(Boolean(body.pinned));
    setClauses.push(`pinned = $${params.length}`);
  }
  if (body?.requiredRoleId !== undefined) {
    if (body.requiredRoleId === null || body.requiredRoleId === "") {
      params.push(null);
      setClauses.push(`required_role_id = $${params.length}`);
    } else {
      const roleId = String(body.requiredRoleId).trim();
      const roleCheck = await pool.query(
        `SELECT role_id FROM roles WHERE role_id = $1 AND starts_with(role_id, $2 || '_') LIMIT 1`,
        [roleId, orgId],
      );
      if (!roleCheck.rows[0])
        return json({ error: "Role not found in this org" }, 400);
      params.push(roleId);
      setClauses.push(`required_role_id = $${params.length}`);
    }
  }

  if (setClauses.length === 0)
    return json({ error: "No fields to update" }, 400);
  setClauses.push(`updated_at = unix_now()`);

  params.push(noteId);
  const { rows } = await pool.query(
    `UPDATE player_notes SET ${setClauses.join(", ")}
     WHERE id = $${params.length}
     RETURNING id, subject_steam_id, body, author_user_id, author_name,
               min_rank, required_role_id, pinned, created_at, updated_at`,
    params,
  );

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "player_note",
    resourceId: steamId,
    actionType: "PLAYER_NOTE_UPDATED",
    actionCategory: "player_management",
    severity: 1,
    metadata: {
      noteId: String(noteId),
      fields: Object.keys(body).filter((k) =>
        ["body", "pinned", "requiredRoleId"].includes(k),
      ),
    },
    ipAddress: getClientIp(request),
  });

  return json({ note: serializePlayerNote(rows[0]) });
}

async function handleDeletePlayerNote(request, orgId, steamId, noteId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);
  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const existing = await pool.query(
    `SELECT author_user_id FROM player_notes
     WHERE id = $1 AND org_id = $2 AND subject_steam_id = $3`,
    [noteId, orgId, steamId],
  );
  if (!existing.rows[0]) return json({ error: "Note not found" }, 404);

  const isAuthor = existing.rows[0].author_user_id === session.userId;
  if (!isAuthor && sessionRankForOrg(session, orgId) < 4)
    return json({ error: "Forbidden: not your note" }, 403);

  await pool.query(`DELETE FROM player_notes WHERE id = $1`, [noteId]);

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "player_note",
    resourceId: steamId,
    actionType: "PLAYER_NOTE_DELETED",
    actionCategory: "player_management",
    severity: 1,
    metadata: { noteId: String(noteId) },
    ipAddress: getClientIp(request),
  });

  return json({ ok: true });
}

// ── Org player search (ticket submission) ────────────────────────────────────

async function handleSearchOrgPlayers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return json({ players: [] });

  const { rows } = await pool.query(
    `SELECT pc.steam_id,
            COALESCE(pc.display_name, pc.steam_id) AS name,
            ops.last_seen_at,
            CASE
              WHEN pc.display_name ILIKE $2 THEN 'display_name'
              WHEN EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(pc.bm_name_aliases, '[]'::jsonb)) alias(name)
                WHERE alias.name ILIKE $2
              ) THEN 'previous_name'
              ELSE 'steam_id'
            END AS match_type,
            (
              SELECT alias.name
              FROM jsonb_array_elements_text(COALESCE(pc.bm_name_aliases, '[]'::jsonb)) alias(name)
              WHERE alias.name ILIKE $2
              ORDER BY LENGTH(alias.name) ASC
              LIMIT 1
            ) AS matched_alias
     FROM org_player_sightings ops
     JOIN player_cache pc ON pc.steam_id = ops.steam_id
     WHERE ops.org_id = $1
       AND (
         pc.display_name ILIKE $2
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(COALESCE(pc.bm_name_aliases, '[]'::jsonb)) alias(name)
           WHERE alias.name ILIKE $2
         )
         OR pc.steam_id LIKE $3
       )
     ORDER BY
       CASE
         WHEN pc.display_name ILIKE $2 THEN 0
         WHEN EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(COALESCE(pc.bm_name_aliases, '[]'::jsonb)) alias(name)
           WHERE alias.name ILIKE $2
         ) THEN 1
         ELSE 2
       END,
       ops.last_seen_at DESC
     LIMIT 20`,
    [orgId, `%${q}%`, `${q}%`],
  );

  return json({
    players: rows.map((r) => ({
      steamId: String(r.steam_id),
      name: String(r.name),
      lastSeenAt: Number(r.last_seen_at),
      matchType: String(r.match_type ?? "display_name"),
      matchedAlias: r.matched_alias ? String(r.matched_alias) : null,
    })),
  });
}

function normalizePlayerIpLookupQuery(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (IP_ADDRESS_RE.test(raw)) return raw;

  const normalizedHash = raw.toLowerCase().replace(/[^a-f0-9]/g, "");
  if (!/^[a-f0-9]{6,64}$/.test(normalizedHash)) return "";
  return normalizedHash;
}

async function handleResolveBmId(request, bmId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  // Must have players_view in at least one org.
  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId") ?? null;
  if (
    orgId
      ? !orgHasPermission(session, orgId, "players_view")
      : !session.orgPermissions ||
        !Object.keys(session.orgPermissions).some((id) =>
          orgHasPermission(session, id, "players_view"),
        )
  ) {
    return json({ error: "Forbidden: players_view permission required" }, 403);
  }

  // 1. Fast path: already in our cache.
  const cacheRes = await pool.query(
    `SELECT steam_id FROM player_cache WHERE bm_id = $1 LIMIT 1`,
    [bmId],
  );
  if (cacheRes.rows[0]) {
    return json({ steamId: String(cacheRes.rows[0].steam_id) });
  }

  // 2. Ask BattleMetrics.
  const lookupOrgId =
    orgId ??
    Object.keys(session.orgPermissions ?? {}).find((id) =>
      orgHasPermission(session, id, "players_view"),
    ) ??
    null;

  if (!lookupOrgId) {
    return json(
      { error: "No suitable org found to resolve BattleMetrics ID" },
      400,
    );
  }

  try {
    const bmRes = await bmFetch(
      lookupOrgId,
      `https://api.battlemetrics.com/players/${encodeURIComponent(bmId)}?include=identifier`,
    );
    if (!bmRes?.ok) {
      return json({ error: "BattleMetrics player not found" }, 404);
    }
    const bmData = await bmRes.json();
    const steamInc = (bmData.included ?? []).find(
      (inc) => inc.type === "identifier" && inc.attributes?.type === "steamID",
    );
    if (!steamInc?.attributes?.identifier) {
      return json(
        { error: "No Steam ID linked to this BattleMetrics player" },
        404,
      );
    }
    const steamId = String(steamInc.attributes.identifier);
    return json({ steamId });
  } catch {
    return json({ error: "Failed to resolve BattleMetrics ID" }, 502);
  }
}

async function handleSearchPlayersByIpHash(request, hashQuery) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const orgId = String(url.searchParams.get("orgId") ?? "").trim();
  if (!orgId) return json({ error: "orgId query parameter required" }, 400);

  if (!orgHasPermission(session, orgId, "players_view")) {
    return json({ error: "Forbidden: players_view permission required" }, 403);
  }
  if (!orgHasPermission(session, orgId, "ip_read")) {
    return json({ error: "Forbidden: ip_read permission required" }, 403);
  }

  const rawQuery = String(hashQuery ?? "");
  let decodedQuery = rawQuery;
  try {
    decodedQuery = decodeURIComponent(rawQuery);
  } catch {
    // Leave the raw segment as-is; validation below will reject it if needed.
  }
  const normalized = normalizePlayerIpLookupQuery(decodedQuery);
  if (!normalized) {
    return json(
      { error: "IP lookup must be a valid raw IP address or hash token" },
      400,
    );
  }

  const isRawIpSearch = IP_ADDRESS_RE.test(normalized);
  const hashLookup = isRawIpSearch ? ipHmac(normalized) : normalized;

  const entitlement = await entitledIpSourceOrgs(session);
  if (entitlement === null) {
    return json({ error: "Forbidden: ip_read permission required" }, 403);
  }

  const params = [hashLookup + "%"];
  let scopeClause = "";
  if (entitlement !== "ALL") {
    params.push([...entitlement]);
    scopeClause = `
      AND (
        NOT EXISTS (
          SELECT 1 FROM player_ip_observations o
          WHERE o.steam_id = pih.steam_id
            AND o.ip_hash = pih.ip_hash
        )
        OR EXISTS (
          SELECT 1 FROM player_ip_observations o
          WHERE o.steam_id = pih.steam_id
            AND o.ip_hash = pih.ip_hash
            AND o.org_id = ANY($2::text[])
        )
      )`;
  }

  const { rows } = await pool.query(
    `SELECT pih.steam_id,
            COALESCE(pc.display_name, pih.steam_id) AS display_name,
            MAX(pih.last_seen) AS last_seen,
            COUNT(*)::INT AS match_count
     FROM player_ip_history pih
     LEFT JOIN player_cache pc ON pc.steam_id = pih.steam_id
     WHERE pih.ip_hash LIKE $1
       ${scopeClause}
     GROUP BY pih.steam_id, pc.display_name
     ORDER BY MAX(pih.last_seen) DESC
     LIMIT 100`,
    params,
  );

  return json({
    queryHash: isRawIpSearch ? hashLookup : normalized,
    queryInput: normalized,
    queryType: isRawIpSearch ? "ip" : "hash",
    matches: rows.map((r) => ({
      steamId: String(r.steam_id),
      displayName: String(r.display_name),
      lastSeen: r.last_seen ? Number(r.last_seen) : null,
      matches: Number(r.match_count ?? 0),
    })),
  });
}

// ── Org player list (cached players + live RCON online status) ────────────────

async function handleGetOrgPlayerList(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const url = new URL(request.url);
  const includeBannedParam = String(
    url.searchParams.get("includeBanned") ?? "1",
  ).toLowerCase();
  const includeBanned = !["0", "false", "no", "off"].includes(
    includeBannedParam,
  );

  const cacheKey = `player-list:${orgId}:${includeBanned ? "with-banned" : "without-banned"}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch {}

  // Reconcile missed disconnect events so online status stays accurate.
  await closeStaleServerSessions({ orgId });

  const [sessionsRes, allServersRes] = await Promise.all([
    pool.query(
      `SELECT sps.steam_id, sps.server_id::text AS server_id, s.server_name
       FROM server_player_sessions sps
       JOIN servers s ON s.server_id = sps.server_id
       WHERE sps.org_id = $1 AND sps.disconnected_at IS NULL`,
      [orgId],
    ),
    pool.query(
      `SELECT server_id::text AS server_id, server_name
       FROM servers WHERE owner_org_id = $1`,
      [orgId],
    ),
  ]);

  const onlineMap = new Map(); // steamId -> { serverId, serverName }
  const playerCountByServer = new Map();
  for (const row of sessionsRes.rows) {
    onlineMap.set(row.steam_id, {
      serverId: row.server_id,
      serverName: row.server_name,
    });
    playerCountByServer.set(
      row.server_id,
      (playerCountByServer.get(row.server_id) ?? 0) + 1,
    );
  }

  const servers = allServersRes.rows.map((s) => ({
    serverId: s.server_id,
    serverName: s.server_name,
    rconError: null,
    playerCount: playerCountByServer.get(s.server_id) ?? 0,
  }));

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

  const bannedExclusionClause = includeBanned
    ? ""
    : `
       AND NOT EXISTS (
         SELECT 1 FROM player_bans pb
         WHERE pb.identifier = pc.steam_id
           AND pb.identifier_type = 'steam_id'
           AND pb.org_id = $1
           AND pb.revoked = FALSE
           AND pb.action_type = 'ban'
           AND (pb.expires_at IS NULL OR pb.expires_at > unix_now())
       )`;

  // All sighted players for this org with cache data.
  const sightingsRes = await pool.query(
    `SELECT pc.steam_id, pc.display_name, pc.avatar_url,
            pc.steam_rust_hours, pc.steam_profile_created_at,
            pc.bm_rust_hours, pc.bm_kills, pc.bm_deaths,
            pc.bm_cheating_reports, pc.bm_teaming_reports, pc.bm_other_reports,
            pc.bm_rust_bans_count
     FROM org_player_sightings ops
     JOIN player_cache pc ON pc.steam_id = ops.steam_id
     WHERE ops.org_id = $1
     ${bannedExclusionClause}
     ORDER BY ops.last_seen_at DESC`,
    [orgId],
  );

  const allSteamIds = sightingsRes.rows.map((r) => r.steam_id);
  let ipMap = {};
  if (allSteamIds.length > 0) {
    const ipRes = await pool.query(
      `SELECT DISTINCT ON (pih.steam_id)
              pih.steam_id, im.is_proxy, im.country, im.latitude, im.longitude
       FROM player_ip_history pih
       LEFT JOIN ip_metadata im ON im.ip_hash = pih.ip_hash
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
      ? Math.floor(
          (Date.now() / 1000 - Number(cache.steam_profile_created_at)) / 86400,
        )
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
      susScore,
      rustHours: totalHours,
      bmHours: cache.bm_rust_hours != null ? Number(cache.bm_rust_hours) : 0,
      kills,
      deaths,
      kd: Math.round(kd * 100) / 100,
      reportCount,
      isProxy: ip?.is_proxy ?? false,
      country: ip?.country ?? null,
      lat: ip?.latitude != null ? Number(ip.latitude) : null,
      lng: ip?.longitude != null ? Number(ip.longitude) : null,
      avatarUrl: cache.avatar_url ?? null,
      bmBans: Number(cache.bm_rust_bans_count ?? 0),
      accountAgeDays,
    };
  });

  const result = { players: enriched, servers };

  try {
    await redis.set(cacheKey, JSON.stringify(result), "EX", 15);
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

    if (
      pathname === "/api/internal/discord/message" &&
      request.method === "POST"
    ) {
      return handleIngestDiscordMessage(request);
    }

    if (
      pathname === "/api/internal/discord/message/delete" &&
      request.method === "POST"
    ) {
      return handleDeleteDiscordMessage(request);
    }

    if (
      pathname === "/api/internal/bot/staff-list" &&
      request.method === "GET"
    ) {
      return handleBotGetStaffList(request);
    }

    if (
      pathname === "/api/internal/bot/deactivate" &&
      request.method === "POST"
    ) {
      return handleBotDeactivateMember(request);
    }

    if (
      pathname === "/api/internal/discord-guilds" &&
      request.method === "GET"
    ) {
      return handleGetDiscordBotGuilds(request);
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

    const ticketStreamMatch = pathname.match(/^\/api\/tickets\/(\d+)\/stream$/);
    if (ticketStreamMatch && request.method === "GET") {
      return handleStreamTicket(request, ticketStreamMatch[1]);
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

    const orgTicketAssigneesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-assignees$/,
    );
    if (orgTicketAssigneesMatch && request.method === "GET") {
      return handleGetOrgTicketAssignees(request, orgTicketAssigneesMatch[1]);
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

    const orgRoleReorderMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/roles\/([a-zA-Z0-9_-]+)\/reorder$/,
    );
    if (orgRoleReorderMatch && request.method === "POST") {
      return handleReorderOrgRole(
        request,
        orgRoleReorderMatch[1],
        orgRoleReorderMatch[2],
      );
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

    const orgSyncServerAdminMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/sync-server-admin$/,
    );
    if (orgSyncServerAdminMatch && request.method === "POST") {
      return handleSyncServerAdmin(request, orgSyncServerAdminMatch[1]);
    }

    const orgThreatTriggersMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/threat-triggers$/,
    );
    if (orgThreatTriggersMatch && request.method === "GET") {
      return handleGetThreatTriggers(request, orgThreatTriggersMatch[1]);
    }
    if (orgThreatTriggersMatch && request.method === "PUT") {
      return handleSaveThreatTriggers(request, orgThreatTriggersMatch[1]);
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

    const orgMemberRevokeSessionMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/members\/([a-zA-Z0-9_-]+)\/revoke-session$/,
    );
    if (orgMemberRevokeSessionMatch && request.method === "POST") {
      return handleRevokeUserSession(
        request,
        orgMemberRevokeSessionMatch[1],
        orgMemberRevokeSessionMatch[2],
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

    const orgServerLogsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/server-logs$/,
    );
    if (orgServerLogsMatch && request.method === "GET") {
      return handleGetServerLogs(request, orgServerLogsMatch[1]);
    }

    const orgServersMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/servers$/,
    );
    if (orgServersMatch && request.method === "GET") {
      return handleListOrgServers(request, orgServersMatch[1]);
    }

    const orgNotificationPrefsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/notification-prefs$/,
    );
    if (orgNotificationPrefsMatch && request.method === "GET") {
      return handleGetNotificationPrefs(request, orgNotificationPrefsMatch[1]);
    }
    if (orgNotificationPrefsMatch && request.method === "PUT") {
      return handlePutNotificationPrefs(request, orgNotificationPrefsMatch[1]);
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

    const discordWarnMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/discord\/warn$/,
    );
    if (discordWarnMatch && request.method === "POST") {
      return handleDiscordWarn(request, discordWarnMatch[1]);
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

    // ── Docs routes ───────────────────────────────────────────────────────────
    const docsMatch = pathname.match(/^\/api\/orgs\/([^/]+)\/docs$/);
    if (docsMatch) {
      if (request.method === "GET")
        return handleListOrgDocs(request, docsMatch[1]);
    }

    const docsCatsMatch = pathname.match(
      /^\/api\/orgs\/([^/]+)\/docs\/categories$/,
    );
    if (docsCatsMatch) {
      if (request.method === "POST")
        return handleCreateDocCategory(request, docsCatsMatch[1]);
    }

    const docsCatMatch = pathname.match(
      /^\/api\/orgs\/([^/]+)\/docs\/categories\/([^/]+)$/,
    );
    if (docsCatMatch) {
      if (request.method === "PATCH")
        return handleUpdateDocCategory(
          request,
          docsCatMatch[1],
          docsCatMatch[2],
        );
      if (request.method === "DELETE")
        return handleDeleteDocCategory(
          request,
          docsCatMatch[1],
          docsCatMatch[2],
        );
    }

    const docsArticlesMatch = pathname.match(
      /^\/api\/orgs\/([^/]+)\/docs\/articles$/,
    );
    if (docsArticlesMatch) {
      if (request.method === "POST")
        return handleCreateDocArticle(request, docsArticlesMatch[1]);
    }

    const docsArticleVersionsMatch = pathname.match(
      /^\/api\/orgs\/([^/]+)\/docs\/articles\/([^/]+)\/versions\/([^/]+)$/,
    );
    if (docsArticleVersionsMatch) {
      if (request.method === "DELETE")
        return handleDeleteDocVersion(
          request,
          docsArticleVersionsMatch[1],
          docsArticleVersionsMatch[2],
          docsArticleVersionsMatch[3],
        );
    }

    const docsArticleRestoreMatch = pathname.match(
      /^\/api\/orgs\/([^/]+)\/docs\/articles\/([^/]+)\/restore\/([^/]+)$/,
    );
    if (docsArticleRestoreMatch) {
      if (request.method === "POST")
        return handleRestoreDocVersion(
          request,
          docsArticleRestoreMatch[1],
          docsArticleRestoreMatch[2],
          docsArticleRestoreMatch[3],
        );
    }

    const docsArticleMatch = pathname.match(
      /^\/api\/orgs\/([^/]+)\/docs\/articles\/([^/]+)$/,
    );
    if (docsArticleMatch) {
      if (request.method === "PATCH")
        return handleUpdateDocArticle(
          request,
          docsArticleMatch[1],
          docsArticleMatch[2],
        );
      if (request.method === "DELETE")
        return handleDeleteDocArticle(
          request,
          docsArticleMatch[1],
          docsArticleMatch[2],
        );
    }

    const orgTicketsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/tickets$/,
    );
    if (orgTicketsMatch && request.method === "GET") {
      return handleListOrgTickets(request, orgTicketsMatch[1]);
    }

    const orgOnlineStaffMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/online-staff$/,
    );
    if (orgOnlineStaffMatch && request.method === "GET")
      return handleGetOnlineStaff(request, orgOnlineStaffMatch[1]);

    const orgDetailsMatch = pathname.match(/^\/api\/orgs\/([a-zA-Z0-9_-]+)$/);
    if (orgDetailsMatch && request.method === "GET") {
      return handleGetOrgDetails(request, orgDetailsMatch[1]);
    }
    if (orgDetailsMatch && request.method === "PATCH") {
      return handleUpdateOrgDetails(request, orgDetailsMatch[1]);
    }

    const orgBmOrgsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bm-orgs$/,
    );
    if (orgBmOrgsMatch && request.method === "GET") {
      return handleGetBmOrgs(request, orgBmOrgsMatch[1]);
    }

    const orgBmBanListsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bm-ban-lists$/,
    );
    if (orgBmBanListsMatch && request.method === "GET") {
      return handleGetBmBanLists(request, orgBmBanListsMatch[1]);
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

    // AI Moderation triggers
    const aiTriggersMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ai-moderation\/triggers$/,
    );
    if (aiTriggersMatch && request.method === "GET")
      return handleListAIModerationTriggers(request, aiTriggersMatch[1]);
    if (aiTriggersMatch && request.method === "POST")
      return handleCreateAIModerationTrigger(request, aiTriggersMatch[1]);

    const aiTriggerItemMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ai-moderation\/triggers\/([a-f0-9-]+)$/,
    );
    if (aiTriggerItemMatch && request.method === "PATCH")
      return handleUpdateAIModerationTrigger(
        request,
        aiTriggerItemMatch[1],
        aiTriggerItemMatch[2],
      );
    if (aiTriggerItemMatch && request.method === "DELETE")
      return handleDeleteAIModerationTrigger(
        request,
        aiTriggerItemMatch[1],
        aiTriggerItemMatch[2],
      );

    // AI Moderation: flagged messages
    const aiFlaggedStreamMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ai-moderation\/flagged\/stream$/,
    );
    if (aiFlaggedStreamMatch && request.method === "GET")
      return handleStreamFlaggedMessages(request, aiFlaggedStreamMatch[1]);

    const aiFlaggedMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ai-moderation\/flagged$/,
    );
    if (aiFlaggedMatch && request.method === "GET")
      return handleListFlaggedMessages(request, aiFlaggedMatch[1]);

    const aiFlagResolveMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ai-moderation\/flagged\/([a-f0-9-]+)\/resolve$/,
    );
    if (aiFlagResolveMatch && request.method === "POST")
      return handleResolveFlaggedMessage(
        request,
        aiFlagResolveMatch[1],
        aiFlagResolveMatch[2],
      );

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

    const orgBanPurgeMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bans\/([a-f0-9-]+)\/purge$/,
    );
    if (orgBanPurgeMatch && request.method === "DELETE")
      return handlePurgeBan(request, orgBanPurgeMatch[1], orgBanPurgeMatch[2]);

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

    const orgScriptExecMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/scripts\/([a-f0-9-]+)\/exec$/,
    );
    if (orgScriptExecMatch && request.method === "POST")
      return handleExecScriptRcon(
        request,
        orgScriptExecMatch[1],
        orgScriptExecMatch[2],
      );

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

    const orgPluginRefreshMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/plugins\/refresh-versions$/,
    );
    if (orgPluginRefreshMatch && request.method === "POST")
      return handleRefreshPluginVersions(request, orgPluginRefreshMatch[1]);

    // Cross-org data sharing arrangements
    const orgSharesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/shares$/,
    );
    if (orgSharesMatch && request.method === "GET")
      return handleListShareGrants(request, orgSharesMatch[1]);
    if (orgSharesMatch && request.method === "POST")
      return handleCreateShareGrant(request, orgSharesMatch[1]);

    const orgShareAcceptMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/shares\/([a-f0-9-]+)\/accept$/,
    );
    if (orgShareAcceptMatch && request.method === "POST")
      return handleAcceptShareGrant(
        request,
        orgShareAcceptMatch[1],
        orgShareAcceptMatch[2],
      );

    const orgShareMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/shares\/([a-f0-9-]+)$/,
    );
    if (orgShareMatch && request.method === "DELETE")
      return handleRevokeShareGrant(
        request,
        orgShareMatch[1],
        orgShareMatch[2],
      );

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

    const serverRconStreamMatch = pathname.match(
      /^\/api\/servers\/([a-f0-9-]+)\/rcon\/console\/stream$/,
    );
    if (serverRconStreamMatch && request.method === "GET")
      return handleRconConsoleStream(request, serverRconStreamMatch[1]);

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

    if (pathname === "/api/ingest/disconnect" && request.method === "POST")
      return handleIngestPlayerDisconnect(request);

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

    if (pathname === "/api/ingest/server-log" && request.method === "POST")
      return handleIngestServerLog(request);

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

    // Globalping network monitoring
    const orgGlobalpingConfigMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/globalping\/config$/,
    );
    if (orgGlobalpingConfigMatch) {
      if (request.method === "GET")
        return handleGetGlobalpingConfig(request, orgGlobalpingConfigMatch[1]);
      if (request.method === "PUT")
        return handlePutGlobalpingConfig(request, orgGlobalpingConfigMatch[1]);
      if (request.method === "DELETE")
        return handleDeleteGlobalpingConfig(
          request,
          orgGlobalpingConfigMatch[1],
        );
    }

    const orgGlobalpingResultsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/globalping\/results$/,
    );
    if (orgGlobalpingResultsMatch && request.method === "GET")
      return handleGetGlobalpingResults(request, orgGlobalpingResultsMatch[1]);

    const orgGlobalpingHistoryMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/globalping\/history$/,
    );
    if (orgGlobalpingHistoryMatch && request.method === "GET")
      return handleGetGlobalpingHistory(request, orgGlobalpingHistoryMatch[1]);

    const orgGlobalpingTriggerMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/globalping\/trigger$/,
    );
    if (orgGlobalpingTriggerMatch && request.method === "POST")
      return handleTriggerGlobalpingMeasurements(
        request,
        orgGlobalpingTriggerMatch[1],
      );

    const orgGlobalpingLimitsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/globalping\/limits$/,
    );
    if (orgGlobalpingLimitsMatch && request.method === "GET")
      return handleGetGlobalpingLimits(request, orgGlobalpingLimitsMatch[1]);

    // Cross-org media list:
    // - sysadmin sees all media
    // - org owners/admins see all media in orgs they manage
    // - everyone else only sees their own uploads within their orgs
    if (pathname === "/api/media" && request.method === "GET")
      return handleListAllMedia(request);

    // Org media gallery (R2/S3 direct-upload)
    const orgMediaMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/media$/,
    );
    if (orgMediaMatch && request.method === "GET")
      return handleListOrgMedia(request, orgMediaMatch[1]);

    const orgMediaPrepareMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/media\/prepare$/,
    );
    if (orgMediaPrepareMatch && request.method === "POST")
      return handlePrepareMedia(request, orgMediaPrepareMatch[1]);

    const orgMediaConfirmMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/media\/confirm$/,
    );
    if (orgMediaConfirmMatch && request.method === "POST")
      return handleConfirmMedia(request, orgMediaConfirmMatch[1]);

    const orgMediaItemMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/media\/([a-f0-9-]+)$/,
    );
    if (orgMediaItemMatch && request.method === "GET")
      return handleGetMediaItem(
        request,
        orgMediaItemMatch[1],
        orgMediaItemMatch[2],
      );
    if (orgMediaItemMatch && request.method === "DELETE")
      return handleDeleteMedia(
        request,
        orgMediaItemMatch[1],
        orgMediaItemMatch[2],
      );

    const banMediaMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bans\/([a-f0-9-]+)\/media$/,
    );
    if (banMediaMatch && request.method === "GET")
      return handleGetBanMedia(request, banMediaMatch[1], banMediaMatch[2]);

    // Public ticket media (presigned upload for public submitters)
    if (
      pathname === "/api/public/ticket-media/prepare" &&
      request.method === "POST"
    )
      return handlePublicMediaPrepare(request);
    if (
      pathname === "/api/public/ticket-media/confirm" &&
      request.method === "POST"
    )
      return handlePublicMediaConfirm(request);

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

    const orgPlayerIpBanEligibilityMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/players\/(\d+)\/ip-ban-eligibility$/,
    );
    if (orgPlayerIpBanEligibilityMatch && request.method === "GET")
      return handleGetPlayerIpBanEligibility(
        request,
        orgPlayerIpBanEligibilityMatch[1],
        orgPlayerIpBanEligibilityMatch[2],
      );

    const orgPlayerOnlineStatusMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/players\/(\d+)\/online-status$/,
    );
    if (orgPlayerOnlineStatusMatch && request.method === "GET")
      return handleGetOrgPlayerOnlineStatus(
        request,
        orgPlayerOnlineStatusMatch[1],
        orgPlayerOnlineStatusMatch[2],
      );

    // Org player list
    const orgPlayerListMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/player-list$/,
    );
    if (orgPlayerListMatch && request.method === "GET")
      return handleGetOrgPlayerList(request, orgPlayerListMatch[1]);

    // Org recent F7 reports (sidebar)
    const orgRecentReportsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/recent-reports$/,
    );
    if (orgRecentReportsMatch && request.method === "GET")
      return handleGetOrgRecentReports(request, orgRecentReportsMatch[1]);

    // Player lookup
    const playerByHashMatch = pathname.match(
      /^\/api\/players\/by-ip-hash\/([^/]+)$/,
    );
    if (playerByHashMatch && request.method === "GET")
      return handleSearchPlayersByIpHash(request, playerByHashMatch[1]);

    const playerByBmMatch = pathname.match(/^\/api\/players\/by-bm\/(\d+)$/);
    if (playerByBmMatch && request.method === "GET")
      return handleResolveBmId(request, playerByBmMatch[1]);

    const playerMatch = pathname.match(/^\/api\/players\/(\d+)$/);
    if (playerMatch && request.method === "GET")
      return handleGetPlayer(request, playerMatch[1]);

    const playerRefreshMatch = pathname.match(
      /^\/api\/players\/(\d+)\/refresh$/,
    );
    if (playerRefreshMatch && request.method === "POST")
      return handleRefreshPlayer(request, playerRefreshMatch[1]);

    const playerKickMatch = pathname.match(/^\/api\/players\/(\d+)\/kick$/);
    if (playerKickMatch && request.method === "POST")
      return handleKickPlayer(request, playerKickMatch[1]);

    const playerChatMatch = pathname.match(/^\/api\/players\/(\d+)\/chat$/);
    if (playerChatMatch && request.method === "GET")
      return handleGetPlayerChat(request, playerChatMatch[1]);

    // Sysadmin: clear all player cache
    if (pathname === "/api/admin/player-cache" && request.method === "DELETE")
      return handleClearAllPlayerCache(request);

    // Sysadmin: reset bogus external API key rate-limit timers
    if (pathname === "/api/admin/reset-key-limits" && request.method === "POST")
      return handleResetExternalKeyLimits(request);

    // Sysadmin: diagnostic metrics
    if (pathname === "/api/sys/metrics" && request.method === "GET")
      return handleGetSysMetrics(request);

    // Sysadmin: database storage / usage summary
    if (pathname === "/api/sys/db-usage" && request.method === "GET")
      return handleGetDbUsage(request);

    // Sysadmin: test R2 bucket write/delete capability
    if (pathname === "/api/sys/media/test-bucket" && request.method === "POST")
      return handleTestMediaBucket(request);

    // Player reports
    const playerReportsMatch = pathname.match(
      /^\/api\/players\/(\d+)\/reports$/,
    );
    if (playerReportsMatch && request.method === "GET")
      return handleGetPlayerReports(request, playerReportsMatch[1]);

    // Combined ban/mute history across the caller's orgs + shared-in orgs
    const playerOffensesMatch = pathname.match(
      /^\/api\/players\/(\d+)\/offenses$/,
    );
    if (playerOffensesMatch && request.method === "GET")
      return handleGetPlayerOffenses(request, playerOffensesMatch[1]);

    // Server-specific EAC bans for a related account (for linked accounts view)
    const serverEacBansMatch = pathname.match(
      /^\/api\/server\/([^/]+)\/eac-bans$/,
    );
    if (serverEacBansMatch && request.method === "GET") {
      const serverId = serverEacBansMatch[1];
      const url = new URL(request.url);
      const bmId = url.searchParams.get("bmId");
      if (!bmId) return json({ error: "bmId query parameter required" }, 400);
      return handleGetServerEacBans(request, serverId, bmId);
    }

    // Server-specific BattleMetrics bans for a related account (for linked accounts view)
    const serverBmBansMatch = pathname.match(
      /^\/api\/server\/([^/]+)\/bm-bans$/,
    );
    if (serverBmBansMatch && request.method === "GET") {
      const serverId = serverBmBansMatch[1];
      const url = new URL(request.url);
      const bmId = url.searchParams.get("bmId");
      if (!bmId) return json({ error: "bmId query parameter required" }, 400);
      return handleGetServerBmBans(request, serverId, bmId);
    }

    // Combined notes across the caller's orgs + shared-in (level-filtered)
    const playerNotesCombinedMatch = pathname.match(
      /^\/api\/players\/(\d+)\/notes$/,
    );
    if (playerNotesCombinedMatch && request.method === "GET")
      return handleListPlayerNotesCombined(
        request,
        playerNotesCombinedMatch[1],
      );

    const orgNoteRolesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/note-roles$/,
    );
    if (orgNoteRolesMatch && request.method === "GET")
      return handleGetOrgNoteRoles(request, orgNoteRolesMatch[1]);

    // Player notes (org-scoped, role-gated)
    const playerNotesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/players\/(\d+)\/notes$/,
    );
    if (playerNotesMatch && request.method === "GET")
      return handleListPlayerNotes(
        request,
        playerNotesMatch[1],
        playerNotesMatch[2],
      );
    if (playerNotesMatch && request.method === "POST")
      return handleCreatePlayerNote(
        request,
        playerNotesMatch[1],
        playerNotesMatch[2],
      );

    const playerNoteDetailMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/players\/(\d+)\/notes\/(\d+)$/,
    );
    if (playerNoteDetailMatch && request.method === "PATCH")
      return handleUpdatePlayerNote(
        request,
        playerNoteDetailMatch[1],
        playerNoteDetailMatch[2],
        playerNoteDetailMatch[3],
      );
    if (playerNoteDetailMatch && request.method === "DELETE")
      return handleDeletePlayerNote(
        request,
        playerNoteDetailMatch[1],
        playerNoteDetailMatch[2],
        playerNoteDetailMatch[3],
      );

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

async function sendDiscordDm(discordUserId, content) {
  if (!env.discordBotToken) return;
  try {
    const dmRes = await discordFetch("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!dmRes.ok) return;
    const { id: channelId } = await dmRes.json();
    await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  } catch {
    // DMs can fail silently (user has DMs disabled, etc.)
  }
}

const STALE_PING_SECONDS = 10 * 60;
const ALERT_COOLDOWN_SECONDS = 15 * 60;

async function checkServerHealthAlerts() {
  if (!pool || !redis) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const staleThreshold = nowSec - STALE_PING_SECONDS;

  const staleRes = await pool.query(
    `SELECT server_id, owner_org_id, server_name, last_health_ping
     FROM servers
     WHERE last_health_ping IS NOT NULL
       AND last_health_ping < $1`,
    [staleThreshold],
  );
  if (staleRes.rows.length === 0) return;

  for (const server of staleRes.rows) {
    const { server_id, owner_org_id, server_name, last_health_ping } = server;

    // Check / update alert state for cooldown
    const stateRes = await pool.query(
      `INSERT INTO server_alert_state (org_id, server_id, alert_type, first_detected_at, last_notified_at)
       VALUES ($1, $2, 'stale_ping', $3, NULL)
       ON CONFLICT (org_id, server_id, alert_type) DO UPDATE
         SET first_detected_at = LEAST(server_alert_state.first_detected_at, EXCLUDED.first_detected_at)
       RETURNING last_notified_at`,
      [owner_org_id, server_id, nowSec],
    );
    const lastNotified = stateRes.rows[0]?.last_notified_at;
    if (lastNotified && nowSec - Number(lastNotified) < ALERT_COOLDOWN_SECONDS)
      continue;

    // Get subscribed staff Discord IDs
    const subsRes = await pool.query(
      `SELECT u.discord_id
       FROM staff_notification_prefs snp
       JOIN users u ON u.user_id = snp.user_id
       WHERE snp.org_id = $1 AND snp.enabled = TRUE AND u.discord_id IS NOT NULL`,
      [owner_org_id],
    );
    if (subsRes.rows.length === 0) continue;

    // Mark notified
    await pool.query(
      `UPDATE server_alert_state SET last_notified_at = $1
       WHERE org_id = $2 AND server_id = $3 AND alert_type = 'stale_ping'`,
      [nowSec, owner_org_id, server_id],
    );

    const lastPingUnix = Number(last_health_ping);
    const msg = `⚠️ **IronSight Alert** — Server **${server_name}** has not sent a health ping since <t:${lastPingUnix}:R> (last seen <t:${lastPingUnix}:t>). Check the Status page for details.`;
    for (const { discord_id } of subsRes.rows) {
      await sendDiscordDm(discord_id, msg);
    }
  }

  // Clear resolved alerts (server pinged recently again)
  await pool.query(
    `DELETE FROM server_alert_state
     WHERE alert_type = 'stale_ping'
       AND (org_id, server_id) IN (
         SELECT owner_org_id, server_id FROM servers WHERE last_health_ping >= $1
       )`,
    [staleThreshold],
  );
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
    try {
      await redis?.set(cacheKey, JSON.stringify(result), "EX", 300);
    } catch {}
    return result;
  } catch {
    return [];
  }
}

async function addDiscordRoleToMember(guildId, discordUserId, discordRoleId) {
  if (!env.discordBotToken || !guildId || !discordUserId || !discordRoleId)
    return true;
  try {
    const res = await discordFetch(
      `/guilds/${guildId}/members/${discordUserId}/roles/${discordRoleId}`,
      { method: "PUT" },
    );
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

async function removeDiscordRoleFromMember(
  guildId,
  discordUserId,
  discordRoleId,
) {
  if (!env.discordBotToken || !guildId || !discordUserId || !discordRoleId)
    return true;
  try {
    const res = await discordFetch(
      `/guilds/${guildId}/members/${discordUserId}/roles/${discordRoleId}`,
      { method: "DELETE" },
    );
    return res.ok || res.status === 204;
  } catch {
    return false;
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
  if (!guildId || !discordUserId) return null;
  const [oldIds, newIds] = await Promise.all([
    getDiscordRoleIdsForRole(oldRoleId),
    getDiscordRoleIdsForRole(newRoleId),
  ]);
  const toRemove = oldIds.filter((id) => !newIds.includes(id));
  const toAdd = newIds.filter((id) => !oldIds.includes(id));
  const results = await Promise.all([
    ...toRemove.map((id) =>
      removeDiscordRoleFromMember(guildId, discordUserId, id),
    ),
    ...toAdd.map((id) => addDiscordRoleToMember(guildId, discordUserId, id)),
  ]);
  return results.some((ok) => ok === false)
    ? "Discord role sync failed — check bot permissions."
    : null;
}

async function removeAllDiscordRolesForRole(guildId, discordUserId, roleId) {
  if (!guildId || !discordUserId) return null;
  const ids = await getDiscordRoleIdsForRole(roleId);
  if (!ids.length) return null;
  const results = await Promise.all(
    ids.map((id) => removeDiscordRoleFromMember(guildId, discordUserId, id)),
  );
  return results.some((ok) => ok === false)
    ? "Discord role removal failed — check bot permissions."
    : null;
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

  const allRoles = await getGuildRoles(org.guild_id);

  // Build role id → position map for fast lookup
  const rolePositionMap = {};
  for (const r of allRoles) rolePositionMap[r.id] = r.position ?? 0;

  // Determine the caller's highest Discord role position in the guild.
  // null = no restriction (guild owner, or bot/guild not configured).
  let callerDiscordPosition = null;
  if (env.discordBotToken && org.guild_id && session.discordId) {
    try {
      // Check if the caller is the Discord guild owner (unrestricted)
      const guildRes = await discordFetch(`/guilds/${org.guild_id}`);
      let isGuildOwner = false;
      if (guildRes.ok) {
        const guild = await guildRes.json();
        isGuildOwner = String(guild.owner_id) === String(session.discordId);
      }
      if (!isGuildOwner) {
        const memberRes = await discordFetch(
          `/guilds/${org.guild_id}/members/${session.discordId}`,
        );
        if (memberRes.ok) {
          const member = await memberRes.json();
          const memberRoles = Array.isArray(member.roles) ? member.roles : [];
          callerDiscordPosition = memberRoles.reduce(
            (max, rid) => Math.max(max, rolePositionMap[rid] ?? 0),
            0,
          );
        }
      }
      // isGuildOwner → callerDiscordPosition stays null (no restriction)
    } catch {}
  }

  return json({
    discordRoles: allRoles
      .filter((r) => !r.managed && r.name !== "@everyone")
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        position: r.position ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    callerDiscordPosition,
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
    try {
      await redis?.set(cacheKey, JSON.stringify(result), "EX", 300);
    } catch {}
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
      .map(
        (_, i) =>
          `(${Array.from({ length: cols }, (__, c) => `$${i * cols + c + 1}`).join(",")})`,
      )
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

// Retention window < 30 days to stay within GDPR/Discord ToS obligations for
// users who have not received a moderation action. 25 days (2160000 s) gives a
// 5-day buffer below the 30-day hard limit.
const DISCORD_MSG_RETENTION_SECONDS = 25 * 24 * 3600; // 2160000
const CHAT_LOG_RETENTION_SECONDS = 90 * 24 * 3600; // 3 months

async function pruneOldDiscordMessages() {
  const result = await pool.query(
    `DELETE FROM discord_messages WHERE indexed_at < unix_now() - $1`,
    [DISCORD_MSG_RETENTION_SECONDS],
  );
  if (result.rowCount > 0) {
    console.log(
      `[discord-prune] deleted ${result.rowCount} expired message(s)`,
    );
  }
}

async function pruneOldChatMessages() {
  const result = await pool.query(
    `DELETE FROM text_chat_log WHERE created_at < unix_now() - $1`,
    [CHAT_LOG_RETENTION_SECONDS],
  );
  if (result.rowCount > 0) {
    console.log(`[chat-prune] deleted ${result.rowCount} expired message(s)`);
  }
}

// ── Discord API route handlers ────────────────────────────────────────────────

async function handleDiscordSync(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewMessages(session, orgId)) {
    return json(
      {
        error:
          "Forbidden: requires discord_timeout, discord_kick, discord_ban, or discord_delete_messages permission",
      },
      403,
    );
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
    const count = await syncChannelMessages(
      orgId,
      org.guild_id,
      ch.id,
      ch.name,
    );
    totalSynced += count;
    results.push({ channelId: ch.id, channelName: ch.name, synced: count });
  }

  return json({ ok: true, totalSynced, channels: results });
}

async function handleGetDiscordChannels(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewMessages(session, orgId)) {
    return json(
      {
        error:
          "Forbidden: requires discord_timeout, discord_kick, discord_ban, or discord_delete_messages permission",
      },
      403,
    );
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
  const syncMap = Object.fromEntries(
    syncRes.rows.map((r) => [r.channel_id, r]),
  );

  return json({
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      syncedAt: syncMap[c.id]?.synced_at ?? null,
    })),
  });
}

function requireBotAuth(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  if (!env.discordBotToken || authHeader !== `Bot ${env.discordBotToken}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

async function handleBotGetStaffList(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const ownerDiscordId = (url.searchParams.get("ownerDiscordId") ?? "").trim();
  if (!ownerDiscordId) return json({ error: "ownerDiscordId required" }, 400);

  // Find the org where this Discord user is an owner
  const ownerRes = await pool.query(
    `SELECT om.org_id, o.name AS org_name
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     JOIN organizations o ON o.org_id = om.org_id
     WHERE u.discord_id = $1 AND om.role_id = 'org_owner'
     LIMIT 1`,
    [ownerDiscordId],
  );
  if (!ownerRes.rows[0])
    return json({ error: "No owner org found for this Discord ID" }, 404);
  const { org_id: orgId, org_name: orgName } = ownerRes.rows[0];

  const staffRes = await pool.query(
    `SELECT u.discord_id, u.username, om.role_id
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1
       AND om.role_id NOT IN ('org_owner', 'org_disabled')
     ORDER BY u.username`,
    [orgId],
  );

  return json({
    orgId,
    orgName,
    staff: staffRes.rows.map((r) => ({
      discordId: r.discord_id,
      username: r.username,
      roleId: r.role_id,
    })),
  });
}

async function handleBotDeactivateMember(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { ownerDiscordId, targetDiscordId } = body ?? {};
  if (!ownerDiscordId || !targetDiscordId)
    return json(
      { error: "ownerDiscordId and targetDiscordId are required" },
      400,
    );

  // Verify the caller is an owner in some org
  const ownerRes = await pool.query(
    `SELECT om.org_id, om.user_id
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE u.discord_id = $1 AND om.role_id = 'org_owner'
     LIMIT 1`,
    [ownerDiscordId],
  );
  if (!ownerRes.rows[0])
    return json({ error: "Caller is not an org owner" }, 403);
  const { org_id: orgId } = ownerRes.rows[0];

  // Find the target member in the same org
  const targetRes = await pool.query(
    `SELECT om.user_id, u.username, om.role_id
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND u.discord_id = $2
     LIMIT 1`,
    [orgId, targetDiscordId],
  );
  if (!targetRes.rows[0])
    return json({ error: "Target member not found in your org" }, 404);
  const target = targetRes.rows[0];
  if (target.role_id === "org_owner")
    return json({ error: "Cannot disable another owner" }, 403);
  if (target.role_id === "org_disabled")
    return json({ ok: true, message: "Already disabled" });

  await pool.query(
    `UPDATE organization_members SET role_id = 'org_disabled' WHERE org_id = $1 AND user_id = $2`,
    [orgId, target.user_id],
  );
  await revokeUserSessions(target.user_id);

  return json({ ok: true, username: target.username, orgId });
}

async function handleIngestDiscordMessage(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const {
    messageId,
    guildId,
    channelId,
    channelName,
    authorId,
    authorUsername,
    content,
    attachments,
    timestamp,
  } = body ?? {};
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

async function handleDeleteDiscordMessage(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { messageId, guildId } = body ?? {};
  if (!messageId || !guildId) {
    return json({ error: "Missing required fields" }, 400);
  }

  const orgRes = await pool.query(
    `SELECT org_id FROM organizations WHERE guild_id = $1 LIMIT 1`,
    [String(guildId)],
  );
  if (!orgRes.rows[0]) return json({ ok: false, reason: "no org" });
  const orgId = orgRes.rows[0].org_id;

  await pool.query(
    `UPDATE discord_messages SET deleted = TRUE
     WHERE org_id = $1 AND message_id = $2`,
    [orgId, String(messageId)],
  );

  return json({ ok: true });
}

async function handleGetDiscordBotGuilds(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const isOwner = (session.orgOwnerOrgIds ?? []).length > 0;
  if (!isOwner && !session.globalAdmin) {
    return json({ error: "Forbidden: org owner required" }, 403);
  }

  if (!env.discordBotToken) {
    return json({ guilds: [] });
  }

  const ADMINISTRATOR = 0x8n;
  const MANAGE_GUILD = 0x20n;
  const userId = session.discordId;

  try {
    const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${env.discordBotToken}` },
    });
    if (!res.ok) {
      return json({ guilds: [] });
    }
    const allGuilds = await res.json();

    const results = await Promise.all(
      allGuilds.map(async (g) => {
        try {
          const [guildRes, memberRes] = await Promise.all([
            fetch(
              `https://discord.com/api/v10/guilds/${g.id}?with_counts=false`,
              { headers: { Authorization: `Bot ${env.discordBotToken}` } },
            ),
            fetch(
              `https://discord.com/api/v10/guilds/${g.id}/members/${userId}`,
              { headers: { Authorization: `Bot ${env.discordBotToken}` } },
            ),
          ]);
          if (!guildRes.ok) return null;
          const guild = await guildRes.json();

          if (guild.owner_id === userId) {
            return {
              id: String(g.id),
              name: String(g.name),
              icon: g.icon ?? null,
            };
          }

          if (!memberRes.ok) return null;
          const member = await memberRes.json();

          const memberRoleIds = new Set(member.roles ?? []);
          const rolePerms = Object.fromEntries(
            (guild.roles ?? []).map((r) => [r.id, BigInt(r.permissions)]),
          );
          let perms = rolePerms[guild.id] ?? 0n;
          for (const roleId of memberRoleIds) {
            perms |= rolePerms[roleId] ?? 0n;
          }

          if ((perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n) {
            return {
              id: String(g.id),
              name: String(g.name),
              icon: g.icon ?? null,
            };
          }
          return null;
        } catch {
          return null;
        }
      }),
    );

    return json({ guilds: results.filter(Boolean) });
  } catch {
    return json({ guilds: [] });
  }
}

async function handleGetDiscordMessages(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewMessages(session, orgId)) {
    return json(
      {
        error:
          "Forbidden: requires discord_timeout, discord_kick, discord_ban, or discord_delete_messages permission",
      },
      403,
    );
  }

  await pruneOldDiscordMessages();

  const url = new URL(request.url);
  const channelId = url.searchParams.get("channel_id") ?? null;
  const authorId = url.searchParams.get("author_id") ?? null;
  const before = url.searchParams.get("before") ?? null;
  const after = url.searchParams.get("after") ?? null;
  const limit = Math.min(
    100,
    parseInt(url.searchParams.get("limit") ?? "50", 10),
  );

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
            content, attachments, discord_created_at, deleted
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
      deleted: r.deleted,
    })),
  });
}

async function handleDiscordModAction(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!env.discordBotToken) {
    return json({ error: "DISCORD_BOT_TOKEN is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body?.action ?? "")
    .trim()
    .toLowerCase();
  const targetDiscordId = String(body?.targetDiscordId ?? "").trim();
  const targetUsername = String(body?.targetUsername ?? "").trim();
  const reason = body?.reason ? String(body.reason).trim() : null;
  const durationSeconds = body?.durationSeconds
    ? parseInt(body.durationSeconds, 10)
    : null;

  const VALID_ACTIONS = [
    "timeout",
    "untimeout",
    "mute",
    "unmute",
    "kick",
    "ban",
    "unban",
  ];
  if (!VALID_ACTIONS.includes(action)) {
    return json(
      { error: `action must be one of: ${VALID_ACTIONS.join(", ")}` },
      400,
    );
  }
  if (!targetDiscordId) {
    return json({ error: "targetDiscordId is required" }, 400);
  }
  if (action === "timeout" && (!durationSeconds || durationSeconds <= 0)) {
    return json({ error: "durationSeconds required for timeout" }, 400);
  }

  if (["timeout", "untimeout", "mute", "unmute"].includes(action)) {
    if (!canDiscordTimeout(session, orgId)) {
      return json(
        { error: "Forbidden: discord_timeout permission required" },
        403,
      );
    }
  }
  if (action === "kick" && !canDiscordKick(session, orgId)) {
    return json({ error: "Forbidden: discord_kick permission required" }, 403);
  }
  if (["ban", "unban"].includes(action) && !canDiscordBan(session, orgId)) {
    return json({ error: "Forbidden: discord_ban permission required" }, 403);
  }
  if (
    action === "ban" &&
    body.deleteMessages &&
    !canDiscordDeleteMessages(session, orgId)
  ) {
    return json(
      { error: "Forbidden: discord_delete_messages permission required" },
      403,
    );
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

  // Prevent punitive actions against active staff members of this org.
  const PUNITIVE_ACTIONS = ["timeout", "mute", "kick", "ban"];
  if (PUNITIVE_ACTIONS.includes(action) && targetDiscordId) {
    const staffCheck = await pool.query(
      `SELECT 1 FROM organization_members om
       JOIN users u ON u.user_id = om.user_id
       WHERE om.org_id = $1 AND u.discord_id = $2 LIMIT 1`,
      [orgId, targetDiscordId],
    );
    if (staffCheck.rows.length > 0) {
      return json(
        { error: "Cannot perform this action on an active staff member." },
        403,
      );
    }
  }

  let discordRes;

  switch (action) {
    case "timeout": {
      const until = new Date(Date.now() + durationSeconds * 1000).toISOString();
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ communication_disabled_until: until }),
        },
      );
      break;
    }
    case "untimeout": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ communication_disabled_until: null }),
        },
      );
      break;
    }
    case "mute": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ mute: true }),
        },
      );
      break;
    }
    case "unmute": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ mute: false }),
        },
      );
      break;
    }
    case "kick": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "DELETE",
        },
      );
      break;
    }
    case "ban": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/bans/${targetDiscordId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            delete_message_seconds: body.deleteMessages ? 604800 : 0,
          }),
        },
      );
      if ((discordRes.ok || discordRes.status === 204) && body.deleteMessages) {
        // Delete messages from Discord (visible to others) but keep them in our DB
        deleteUserDiscordMessagesFromGuild(
          guildId,
          orgId,
          targetDiscordId,
        ).catch(() => {});
      }
      break;
    }
    case "unban": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/bans/${targetDiscordId}`,
        {
          method: "DELETE",
        },
      );

      console.log("[discord] unban HTTP status:", discordRes.status);

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
      } catch {
        /* empty */
      }
      return json(
        {
          error: "Discord API error",
          details: discordError,
          status: discordRes.status,
        },
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

// Open a DM channel with the user and send `content`. Returns a delivery status:
//   "delivered"    — message accepted by Discord
//   "dms_disabled" — user blocks DMs / shares no guild with the bot (code 50007)
//   "error"        — anything else (bad token, rate limit, network)
async function deliverDiscordDm(discordUserId, content) {
  try {
    const dmRes = await discordFetch("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!dmRes.ok) {
      let detail = null;
      try {
        detail = await dmRes.json();
      } catch {
        /* empty */
      }
      if (detail?.code === 50007) return { status: "dms_disabled", detail };
      return { status: "error", detail };
    }
    const channel = await dmRes.json();
    const msgRes = await discordFetch(`/channels/${channel.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    if (msgRes.ok) return { status: "delivered" };
    let detail = null;
    try {
      detail = await msgRes.json();
    } catch {
      /* empty */
    }
    // 50007 = "Cannot send messages to this user" → DMs closed to the bot.
    if (detail?.code === 50007) return { status: "dms_disabled", detail };
    return { status: "error", detail };
  } catch (err) {
    return { status: "error", detail: String(err?.message ?? err) };
  }
}

// Warn a player via Discord DM. Gated by its own lower-privilege permission so a
// warner can nudge a member without the power to timeout/kick/ban. We attempt the
// DM and report whether it actually reached the user (DMs may be disabled).
async function handleDiscordWarn(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordWarn(session, orgId)) {
    return json({ error: "Forbidden: discord_warn permission required" }, 403);
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

  const targetDiscordId = String(body?.targetDiscordId ?? "").trim();
  const targetUsername = String(body?.targetUsername ?? "").trim();
  const message = String(body?.message ?? "").trim();
  if (!/^\d{5,25}$/.test(targetDiscordId)) {
    return json({ error: "Valid targetDiscordId is required" }, 400);
  }
  if (!message) return json({ error: "message is required" }, 400);
  if (message.length > 1800) {
    return json({ error: "message must be 1800 characters or fewer" }, 400);
  }

  // Per-user cap — warning is an outward-facing action that hits Discord.
  const rl = await checkRateLimit(`rl:discord-warn:${session.userId}`, 20, 60);
  if (rl) return rl;

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const guildId = orgRes.rows[0]?.guild_id;
  if (!guildId) {
    return json({ error: "Organization has no guild_id configured" }, 400);
  }

  const result = await deliverDiscordDm(targetDiscordId, message);
  if (result.status === "error") {
    return json({ error: "Discord API error", details: result.detail }, 502);
  }
  const delivered = result.status === "delivered";

  await pool.query(
    `INSERT INTO discord_mod_log
       (org_id, guild_id, target_discord_id, target_username,
        action_type, reason, duration_seconds, expires_at, actor_user_id)
     VALUES ($1,$2,$3,$4,'WARN',$5,NULL,NULL,$6)`,
    [orgId, guildId, targetDiscordId, targetUsername, message, session.userId],
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "discord_member",
    resourceId: targetDiscordId,
    actionType: "DISCORD_WARN",
    actionCategory: "discord_moderation",
    severity: 2,
    metadata: { targetDiscordId, targetUsername, message, delivered },
  });

  return json({ ok: true, action: "warn", targetDiscordId, delivered });
}

async function deleteUserDiscordMessagesFromGuild(
  guildId,
  orgId,
  discordUserId,
) {
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
  if (!canDiscordViewBans(session, orgId))
    return json(
      { error: "Forbidden: discord_bans_view permission required" },
      403,
    );
  if (!env.discordBotToken)
    return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id)
    return json({ error: "Organization has no guild_id configured" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10), 1),
    500,
  );
  const offset = Math.max(
    parseInt(url.searchParams.get("offset") ?? "0", 10),
    0,
  );
  const query = (url.searchParams.get("query") ?? "").toLowerCase().trim();

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

  let mapped = allBans.map((b) => {
    const log = logMap.get(b.user.id);
    return {
      discordUserId: b.user.id,
      username: b.user.global_name ?? b.user.username,
      reason: b.reason ?? null,
      source: log ? (log.actor_user_id ? "panel" : "external") : "external",
    };
  });

  if (query) {
    mapped = mapped.filter(
      (b) =>
        b.username?.toLowerCase().includes(query) ||
        b.discordUserId?.includes(query) ||
        b.reason?.toLowerCase().includes(query),
    );
  }

  const total = mapped.length;
  return json({
    bans: mapped.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total,
  });
}

async function handleSyncDiscordBans(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewBans(session, orgId))
    return json(
      { error: "Forbidden: discord_bans_view permission required" },
      403,
    );
  if (!env.discordBotToken)
    return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id)
    return json({ error: "Organization has no guild_id configured" }, 400);

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
  const latestAction = new Map(
    latest.map((r) => [r.target_discord_id, r.action_type]),
  );

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
  // Warners and staff who can take direct member actions need lookup access.
  if (
    !canDiscordWarn(session, orgId) &&
    !canDiscordTimeout(session, orgId) &&
    !canDiscordKick(session, orgId) &&
    !canDiscordBan(session, orgId)
  )
    return json(
      {
        error:
          "Forbidden: requires discord_warn, discord_timeout, discord_kick, or discord_ban permission",
      },
      403,
    );
  if (!env.discordBotToken)
    return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id)
    return json({ error: "Organization has no guild_id configured" }, 400);

  const url = new URL(request.url);
  const query = (url.searchParams.get("query") ?? "").trim();
  if (!query) return json({ members: [] });

  const params = new URLSearchParams({ query, limit: "25" });
  const res = await discordFetch(
    `/guilds/${org.guild_id}/members/search?${params}`,
  );
  if (!res.ok) return json({ members: [] });

  const members = await res.json();
  if (!Array.isArray(members) || members.length === 0)
    return json({ members: [] });

  // Cross-reference with panel staff so the UI can block punitive actions.
  const discordIds = members.map((m) => m.user.id);
  const staffCheckRes = await pool.query(
    `SELECT u.discord_id FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND u.discord_id = ANY($2::text[])`,
    [orgId, discordIds],
  );
  const staffDiscordIds = new Set(staffCheckRes.rows.map((r) => r.discord_id));

  return json({
    members: members.map((m) => ({
      discordId: m.user.id,
      username: m.user.global_name ?? m.user.username,
      nickname: m.nick ?? null,
      avatar: m.user.avatar
        ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64`
        : null,
      isStaff: staffDiscordIds.has(m.user.id),
    })),
  });
}

async function handleGetDiscordModLog(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewModLog(session, orgId)) {
    return json(
      { error: "Forbidden: discord_modlog_view permission required" },
      403,
    );
  }

  const url = new URL(request.url);
  const limit = Math.min(
    100,
    Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 50),
  );
  const offset = Math.max(
    0,
    Math.trunc(Number(url.searchParams.get("offset"))) || 0,
  );
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

// ── Documentation / wiki ─────────────────────────────────────────────────────

function docArticleRow(a, versions) {
  return {
    id: String(a.article_id),
    orgId: String(a.org_id),
    categoryId: a.category_id ? String(a.category_id) : null,
    title: String(a.title),
    body: String(a.body),
    minRank: Number(a.min_rank),
    minPosition: a.min_position != null ? Number(a.min_position) : 0,
    updatedAt: Number(a.updated_at),
    updatedByName: a.updated_by_name ?? null,
    versions: (versions ?? []).map((v) => ({
      id: String(v.version_id),
      title: String(v.title),
      body: String(v.body),
      savedAt: Number(v.saved_at),
      savedByName: v.saved_by_name ?? null,
    })),
  };
}

async function handleListOrgDocs(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "docs_view") &&
    !orgHasPermission(session, orgId, "docs_edit") &&
    !canManageOrg(session, orgId)
  )
    return json({ error: "Forbidden" }, 403);

  const isFullAccess =
    orgHasPermission(session, orgId, "docs_edit") ||
    canManageOrg(session, orgId);

  const catsPromise = pool.query(
    `SELECT category_id, org_id, name, parent_id, sort_order, created_at
     FROM doc_categories WHERE org_id = $1 ORDER BY sort_order, created_at`,
    [orgId],
  );
  const rolesPromise = pool.query(
    `SELECT role_id, role_name, position
     FROM roles
     WHERE role_id LIKE ($1 || '_%')
       AND role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
     ORDER BY position ASC, role_name ASC`,
    [orgId],
  );

  let articlesPromise;
  if (isFullAccess) {
    articlesPromise = pool.query(
      `SELECT a.article_id, a.org_id, a.category_id, a.title, a.body,
              a.min_rank, a.min_position, a.updated_at, a.updated_by_name
       FROM doc_articles a
       WHERE a.org_id = $1
       ORDER BY a.updated_at DESC`,
      [orgId],
    );
  } else {
    const callerPos = await orgActorPosition(session, orgId);
    const posFilter = Number.isFinite(callerPos) ? callerPos : 0;
    articlesPromise = pool.query(
      `SELECT a.article_id, a.org_id, a.category_id, a.title, a.body,
              a.min_rank, a.min_position, a.updated_at, a.updated_by_name
       FROM doc_articles a
       WHERE a.org_id = $1 AND a.min_position <= $2
       ORDER BY a.updated_at DESC`,
      [orgId, posFilter],
    );
  }

  const [catsRes, articlesRes, rolesRes] = await Promise.all([
    catsPromise,
    articlesPromise,
    rolesPromise,
  ]);

  const articleIds = articlesRes.rows.map((r) => r.article_id);
  let versionsRows = [];
  if (articleIds.length > 0) {
    const vr = await pool.query(
      `SELECT version_id, article_id, title, body, saved_at, saved_by_name
       FROM doc_article_versions
       WHERE article_id = ANY($1)
       ORDER BY saved_at DESC`,
      [articleIds],
    );
    versionsRows = vr.rows;
  }

  const versionsByArticle = {};
  for (const v of versionsRows) {
    (versionsByArticle[v.article_id] ??= []).push(v);
  }

  return json({
    categories: catsRes.rows.map((c) => ({
      id: String(c.category_id),
      orgId: String(c.org_id),
      name: String(c.name),
      parentId: c.parent_id ? String(c.parent_id) : null,
      sortOrder: Number(c.sort_order),
    })),
    articles: articlesRes.rows.map((a) =>
      docArticleRow(a, versionsByArticle[a.article_id] ?? []),
    ),
    roles: rolesRes.rows.map((r) => ({
      roleId: String(r.role_id),
      roleName: String(r.role_name),
      position: Number(r.position),
    })),
  });
}

async function handleCreateDocCategory(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const name = String(body?.name ?? "").trim();
  if (!name) return json({ error: "name is required" }, 400);
  const parentId = body?.parentId ? String(body.parentId) : null;

  if (parentId) {
    const check = await pool.query(
      `SELECT 1 FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
      [parentId, orgId],
    );
    if (!check.rows[0])
      return json({ error: "Parent category not found" }, 404);
  }

  const categoryId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO doc_categories (category_id, org_id, name, parent_id) VALUES ($1, $2, $3, $4)`,
    [categoryId, orgId, name, parentId],
  );
  return json(
    {
      category: {
        id: categoryId,
        orgId,
        name,
        parentId: parentId ?? null,
        sortOrder: 0,
      },
    },
    201,
  );
}

async function handleUpdateDocCategory(request, orgId, categoryId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  const check = await pool.query(
    `SELECT 1 FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
    [categoryId, orgId],
  );
  if (!check.rows[0]) return json({ error: "Category not found" }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const name = String(body?.name ?? "").trim();
  if (!name) return json({ error: "name is required" }, 400);

  await pool.query(
    `UPDATE doc_categories SET name = $1 WHERE category_id = $2 AND org_id = $3`,
    [name, categoryId, orgId],
  );
  return json({ ok: true });
}

async function handleDeleteDocCategory(request, orgId, categoryId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  const check = await pool.query(
    `SELECT 1 FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
    [categoryId, orgId],
  );
  if (!check.rows[0]) return json({ error: "Category not found" }, 404);

  await pool.query(
    `UPDATE doc_categories SET parent_id = NULL WHERE parent_id = $1`,
    [categoryId],
  );
  await pool.query(
    `UPDATE doc_articles SET category_id = NULL WHERE category_id = $1 AND org_id = $2`,
    [categoryId, orgId],
  );
  await pool.query(
    `DELETE FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
    [categoryId, orgId],
  );
  return json({ ok: true });
}

async function handleCreateDocArticle(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const title = String(body?.title ?? "").trim() || "Untitled";
  const articleBody = String(body?.body ?? "");
  if (articleBody.length > 512 * 1024)
    return json({ error: "Article body too large (max 512 KB)" }, 413);
  const minPosition = Math.max(0, Number(body?.minPosition ?? 0) || 0);
  const categoryId = body?.categoryId ? String(body.categoryId) : null;

  if (categoryId) {
    const check = await pool.query(
      `SELECT 1 FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
      [categoryId, orgId],
    );
    if (!check.rows[0]) return json({ error: "Category not found" }, 404);
  }

  const articleId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO doc_articles (article_id, org_id, category_id, title, body, min_rank, min_position, updated_at, updated_by_user_id, updated_by_name)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)`,
    [
      articleId,
      orgId,
      categoryId,
      title,
      articleBody,
      minPosition,
      now,
      session.userId,
      session.username ?? null,
    ],
  );
  return json(
    {
      article: docArticleRow(
        {
          article_id: articleId,
          org_id: orgId,
          category_id: categoryId,
          title,
          body: articleBody,
          min_rank: 1,
          min_position: minPosition,
          updated_at: now,
          updated_by_name: session.username ?? null,
        },
        [],
      ),
    },
    201,
  );
}

async function handleUpdateDocArticle(request, orgId, articleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  const existing = await pool.query(
    `SELECT * FROM doc_articles WHERE article_id = $1 AND org_id = $2`,
    [articleId, orgId],
  );
  if (!existing.rows[0]) return json({ error: "Article not found" }, 404);
  const prev = existing.rows[0];

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const title =
    body?.title != null ? String(body.title).trim() || prev.title : prev.title;
  const articleBody = body?.body != null ? String(body.body) : prev.body;
  if (articleBody.length > 512 * 1024)
    return json({ error: "Article body too large (max 512 KB)" }, 413);
  const minPosition =
    body?.minPosition != null
      ? Math.max(0, Number(body.minPosition) || 0)
      : Number(prev.min_position ?? 0);
  const categoryId =
    "categoryId" in body
      ? body.categoryId
        ? String(body.categoryId)
        : null
      : prev.category_id;

  const versionId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await pool.query(
    `INSERT INTO doc_article_versions (version_id, article_id, title, body, saved_at, saved_by_user_id, saved_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      versionId,
      articleId,
      prev.title,
      prev.body,
      now,
      session.userId,
      session.username ?? null,
    ],
  );
  await pool.query(
    `UPDATE doc_articles
     SET title = $1, body = $2, min_rank = $3, min_position = $4, category_id = $5,
         updated_at = $6, updated_by_user_id = $7, updated_by_name = $8
     WHERE article_id = $9 AND org_id = $10`,
    [
      title,
      articleBody,
      Number(prev.min_rank),
      minPosition,
      categoryId,
      now,
      session.userId,
      session.username ?? null,
      articleId,
      orgId,
    ],
  );

  const versionsRes = await pool.query(
    `SELECT version_id, article_id, title, body, saved_at, saved_by_name
     FROM doc_article_versions WHERE article_id = $1 ORDER BY saved_at DESC`,
    [articleId],
  );
  return json({
    article: docArticleRow(
      {
        article_id: articleId,
        org_id: orgId,
        category_id: categoryId,
        title,
        body: articleBody,
        min_rank: Number(prev.min_rank),
        min_position: minPosition,
        updated_at: now,
        updated_by_name: session.username ?? null,
      },
      versionsRes.rows,
    ),
  });
}

async function handleDeleteDocArticle(request, orgId, articleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId))
    return json(
      { error: "Forbidden: org admin required to delete articles" },
      403,
    );

  const check = await pool.query(
    `SELECT 1 FROM doc_articles WHERE article_id = $1 AND org_id = $2`,
    [articleId, orgId],
  );
  if (!check.rows[0]) return json({ error: "Article not found" }, 404);

  await pool.query(`DELETE FROM doc_article_versions WHERE article_id = $1`, [
    articleId,
  ]);
  await pool.query(
    `DELETE FROM doc_articles WHERE article_id = $1 AND org_id = $2`,
    [articleId, orgId],
  );
  return json({ ok: true });
}

async function handleRestoreDocVersion(request, orgId, articleId, versionId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  const existing = await pool.query(
    `SELECT a.*, v.title AS v_title, v.body AS v_body
     FROM doc_articles a
     JOIN doc_article_versions v ON v.version_id = $2 AND v.article_id = a.article_id
     WHERE a.article_id = $1 AND a.org_id = $3`,
    [articleId, versionId, orgId],
  );
  if (!existing.rows[0])
    return json({ error: "Article or version not found" }, 404);
  const row = existing.rows[0];

  const now = Math.floor(Date.now() / 1000);
  const newVersionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO doc_article_versions (version_id, article_id, title, body, saved_at, saved_by_user_id, saved_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newVersionId,
      articleId,
      row.title,
      row.body,
      now,
      session.userId,
      session.username ?? null,
    ],
  );
  await pool.query(
    `UPDATE doc_articles
     SET title = $1, body = $2, updated_at = $3, updated_by_user_id = $4, updated_by_name = $5
     WHERE article_id = $6 AND org_id = $7`,
    [
      row.v_title,
      row.v_body,
      now,
      session.userId,
      session.username ?? null,
      articleId,
      orgId,
    ],
  );

  const versionsRes = await pool.query(
    `SELECT version_id, article_id, title, body, saved_at, saved_by_name
     FROM doc_article_versions WHERE article_id = $1 ORDER BY saved_at DESC`,
    [articleId],
  );
  return json({
    article: docArticleRow(
      {
        article_id: articleId,
        org_id: orgId,
        category_id: row.category_id,
        title: row.v_title,
        body: row.v_body,
        min_rank: row.min_rank,
        updated_at: now,
        updated_by_name: session.username ?? null,
      },
      versionsRes.rows,
    ),
  });
}

async function handleDeleteDocVersion(request, orgId, articleId, versionId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId))
    return json(
      { error: "Forbidden: org admin required to delete versions" },
      403,
    );

  const check = await pool.query(
    `SELECT 1 FROM doc_article_versions v
     JOIN doc_articles a ON a.article_id = v.article_id
     WHERE v.version_id = $1 AND a.org_id = $2`,
    [versionId, orgId],
  );
  if (!check.rows[0]) return json({ error: "Version not found" }, 404);

  await pool.query(`DELETE FROM doc_article_versions WHERE version_id = $1`, [
    versionId,
  ]);
  return json({ ok: true });
}

// Fetch EAC bans issued on a specific server for a related player account
async function handleGetServerEacBans(request, serverId, bmId) {
  // This endpoint is called from the client when viewing linked accounts.
  // It fetches EAC (Easy Anti-Cheat) bans issued on the specified server
  // for the specified BattleMetrics player ID.

  // Minimal auth: just verify user has a session (no specific org required
  // since EAC data is global).
  const { session, error } = await requireSession(request);
  if (error) return error;

  // Query player_bm_bans_cache to find all bans for this BM ID,
  // then filter by the server if we have server-specific ban records.
  // For now, return all bans for the BM ID (EAC is not server-specific).
  const { rows } = await pool.query(
    `SELECT bm_ban_id, reason, note, banned_at, expires_at, permanent, bm_org_name
     FROM player_bm_bans_cache
     WHERE bm_ban_id LIKE $1 OR bm_ban_id = $2
     ORDER BY banned_at DESC
     LIMIT 50`,
    [`${bmId}-%`, bmId],
  );

  // Filter for EAC-related bans (check reason/note for EAC keywords)
  const eacBans = rows.filter((r) => {
    const text = `${r.reason ?? ""} ${r.note ?? ""}`.toLowerCase();
    return (
      text.includes("eac") ||
      text.includes("easy anti-cheat") ||
      text.includes("anticheat")
    );
  });

  return json({
    bans: eacBans.map((r) => ({
      bmBanId: String(r.bm_ban_id),
      reason: r.reason ?? null,
      note: r.note ?? null,
      bannedAt: r.banned_at ?? null,
      expiresAt: r.expires_at ?? null,
      permanent: Boolean(r.permanent),
      orgName: r.bm_org_name ?? null,
    })),
    count: eacBans.length,
  });
}

// Fetch BattleMetrics bans issued on a specific server for a related player account
async function handleGetServerBmBans(request, serverId, bmId) {
  // This endpoint is called from the client when viewing linked accounts.
  // It fetches BattleMetrics (BM) bans issued on the specified server
  // for the specified BattleMetrics player ID.

  const { session, error } = await requireSession(request);
  if (error) return error;

  // Query player_bm_bans_cache for all bans for this BM ID
  const { rows } = await pool.query(
    `SELECT bm_ban_id, reason, note, banned_at, expires_at, permanent, bm_org_name
     FROM player_bm_bans_cache
     WHERE bm_ban_id LIKE $1 OR bm_ban_id = $2
     ORDER BY banned_at DESC
     LIMIT 50`,
    [`${bmId}-%`, bmId],
  );

  // Filter out EAC-specific bans and return BM bans
  const bmBans = rows.filter((r) => {
    const text = `${r.reason ?? ""} ${r.note ?? ""}`.toLowerCase();
    return !(
      text.includes("eac") ||
      text.includes("easy anti-cheat") ||
      text.includes("anticheat")
    );
  });

  return json({
    bans: bmBans.map((r) => ({
      bmBanId: String(r.bm_ban_id),
      reason: r.reason ?? null,
      note: r.note ?? null,
      bannedAt: r.banned_at ?? null,
      expiresAt: r.expires_at ?? null,
      permanent: Boolean(r.permanent),
      orgName: r.bm_org_name ?? null,
    })),
    count: bmBans.length,
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
  const ms = Date.now() - t0;
  console.log(`[api] ${method} ${pathname} → ${response.status} (${ms}ms)`);
  diagRecordIncoming(method, pathname, response.status, ms);
  return response;
}

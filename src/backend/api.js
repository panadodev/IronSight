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
  IMPERSONATE_COOKIE,
  IMPERSONATE_TTL,
  PENDING_LINK_COOKIE,
  SESSION_COOKIE,
  SYSADMIN,
} from "./config.js";
import {
  auditLog,
  authenticateServerKey,
  canBypassStaffPrivacy,
  canManageOrg,
  canWriteTodos,
  checkRateLimit,
  getStaffIdentityForSteamId,
  invalidateServerListCache,
  isConfiguredSysAdmin,
  isGlobalAdmin,
  listUserOrganizations,
  orgActorPosition,
  orgHasPermission,
  orgsWithPermission,
  redirect,
  requireConfiguredSysAdmin,
  requireSession,
  revokeUserSessions,
  scanDel,
  sessionCandidateOrgIds,
} from "./core.js";
import { executeRconCommand, executeRconCommandSequence } from "./rcon.js";
import {
  decryptIp,
  decryptPterodactylApiKey,
  encryptIp,
  encryptPterodactylApiKey,
  getPterodactylEncryptionKey,
  ipHmac,
} from "./crypto-keys.js";
import { diagRecordIncoming } from "./diagnostics.js";
import {
  bmFetch,
  proxycheckApiFetch,
  proxycheckGlobalFetch,
} from "./external-fetch.js";
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
  handleGetPlayerTeamHistory,
  handleGetPvpLogs,
  handleGetReports,
  handleGetServerLogs,
  handleGetTeamEvents,
} from "./handlers/logs.js";
import {
  fetchPteroFileContents,
  fetchPteroFileList,
  getPterodactylSecurityConfigError,
  handleBulkDeletePteroPlugin,
  handleBulkUploadPteroPlugin,
  handleDeletePteroKey,
  handleGetPteroKey,
  handleGetPteroPluginConfig,
  handleGetPteroServerWebsocket,
  handleGetPteroStatus,
  handleImportPteroServer,
  handleListPteroPlugins,
  handleListPteroServers,
  handlePteroPluginCmd,
  handleSavePteroKey,
  handleSavePteroPluginConfig,
  loadPterodactylCredentials,
  migratePterodactylApiKeys,
  parseOxidePluginMeta,
  safePluginName,
} from "./handlers/pterodactyl.js";
import {
  checkGuildMembership,
  checkServerHealthAlerts,
  createGuildInvite,
  handleBotDeactivateMember,
  handleBotGetPlayerCount,
  handleBotGetStaffList,
  handleBulkDeleteDiscordMessages,
  handleDeleteDiscordMessage,
  handleDiscordModAction,
  handleDiscordSync,
  handleDiscordWarn,
  handleGetDiscordBans,
  handleGetDiscordBotGuilds,
  handleGetDiscordChannels,
  handleGetDiscordMessages,
  handleGetDiscordModLog,
  handleGetOrgDiscordRoles,
  handleIngestDiscordMessage,
  handleSearchDiscordMembers,
  handleSyncDiscordBans,
  handleUpdateDiscordMessage,
  pruneOldChatMessages,
  pruneOldDiscordMessages,
  removeAllDiscordRolesForRole,
  sendDiscordDm,
  sendDiscordDmWithResult,
  syncDiscordRolesOnRoleChange,
} from "./handlers/discord.js";
import {
  handleCreateDocArticle,
  handleCreateDocCategory,
  handleDeleteDocArticle,
  handleDeleteDocCategory,
  handleDeleteDocVersion,
  handleListOrgDocs,
  handleRestoreDocVersion,
  handleUpdateDocArticle,
  handleUpdateDocCategory,
} from "./handlers/docs.js";
import {
  fetchPendingGlobalpingResults,
  handleDeleteGlobalpingConfig,
  handleGetGlobalpingConfig,
  handleGetGlobalpingHistory,
  handleGetGlobalpingLimits,
  handleGetGlobalpingResults,
  handlePutGlobalpingConfig,
  handleTriggerGlobalpingMeasurements,
  triggerGlobalpingMeasurements,
} from "./handlers/globalping.js";
import {
  handleAddExternalKey,
  handleDeleteExternalKey,
  handleGetExternalKeyStats,
  handleListExternalKeys,
  handleUpdateExternalKey,
} from "./handlers/external-keys.js";
import {
  handleConfirmMedia,
  handleDeleteMedia,
  handleGetBanMedia,
  handleGetMediaFile,
  handleGetMediaItem,
  handleGetMediaThumb,
  handleListAllMedia,
  handleListOrgMedia,
  handlePrepareMedia,
  handlePublicMediaConfirm,
  handlePublicMediaPrepare,
  purgeExpiredMedia,
} from "./handlers/media.js";
import {
  handleClearAllPlayerCache,
  handleCreateRelay,
  handleDeleteRelay,
  handleGetDbUsage,
  handleGetSysMetrics,
  handleListRelays,
  handleRelayHealthCheck,
  handleResetExternalKeyLimits,
  handleRotateRelayKey,
  handleTestMediaBucket,
  handleUpdateRelay,
} from "./handlers/sysadmin.js";
import {
  handleCreatePlayerNote,
  handleDeletePlayerNote,
  handleGetOrgNoteRoles,
  handleListPlayerNotes,
  handleListPlayerNotesCombined,
  handleUpdatePlayerNote,
} from "./handlers/player-notes.js";
import { getClientIp, json, nowUnix, parseLimit } from "./http.js";
import {
  ensurePlayerCacheRow,
  getPlayerCacheData,
  getPlayerDataFromRedis,
  playerCoreRefreshedKey,
  playerFetchLockKey,
  playerRedisKey,
  playerRefreshedKey,
  refreshPlayerData,
  resolveSteamGroupInfo,
  seedFlaggedSteamGroups,
} from "./player-store.js";
import { DEFAULT_PUBLIC_MAX_FILES } from "./r2.js";
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
  evaluateBoughtAccount,
  evaluateConfig,
  evaluateThreatTriggers,
  getThreatTriggerConfigOrDefault,
  namesFromAliases,
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
  sanitizeTicketFields,
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
  "tickets_blacklist",
  "ticket_types_manage",
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
  "player_list",
  "player_session_history",
  "player_steam_friends",
  "player_notes",
  "staff_discord_lookup",
  "cases_create",
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
  // proxycheck v3 nests detection under `detections`/`network`; v2 exposed
  // `proxy`/`type` at the top level. Read both so a v3 response isn't silently
  // treated as clean.
  const truthy = (v) =>
    v === true || v === "yes" || v === "true" || v === 1 || v === "1";
  const detections =
    meta.detections && typeof meta.detections === "object"
      ? meta.detections
      : {};
  if (truthy(detections.proxy) || truthy(detections.vpn)) return true;
  const network =
    meta.network && typeof meta.network === "object" ? meta.network : {};
  const t = String(network.type ?? meta.type ?? "").toLowerCase();
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

  // v3 nests the connection type under `network.type`; `meta.type` is the v2
  // fallback. Reading only `meta.type` would resolve every v3 IP to "unknown".
  const connType = normalizeConnectionType(meta?.network?.type ?? meta.type);
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

// VPN/proxy check used at login time. Uses the global PROXYCHECK_API_KEY env
// var — no per-org key needed. Fails CLOSED: returns true (restrict to 24 h)
// whenever the result is uncertain (key not set, API error, parse failure).
// Only returns false when proxycheck explicitly confirms the IP is clean.
async function checkLoginIpIsVpn(ip) {
  const normalizedIp = String(ip ?? "").trim();
  // Unparseable IP (e.g. getClientIp's "unknown" fallback when no edge/XFF
  // header is present) can't be cleared → fail closed as an unconfirmed VPN.
  if (!IP_ADDRESS_RE.test(normalizedIp)) return true;
  const hash = ipHmac(normalizedIp);
  // Cache hit → confirmed result either way, no live call needed
  try {
    const cached = await pool.query(
      `SELECT is_proxy, is_vpn, conn_type FROM ip_metadata WHERE ip_hash = $1 AND cache_expires_at > unix_now() LIMIT 1`,
      [hash],
    );
    const row = cached.rows[0];
    if (row) {
      const connType = normalizeConnectionType(row.conn_type);
      return (
        Boolean(row.is_proxy) || Boolean(row.is_vpn) || connType === "proxy_vpn"
      );
    }
  } catch {}
  // No cache hit — call proxycheck with the global key; fail closed on any issue
  try {
    const resp = await proxycheckGlobalFetch(normalizedIp);
    if (!resp || !resp.ok) return true; // key missing or API error → restrict
    const data = await resp.json().catch(() => null);
    if (!data || typeof data !== "object") return true;
    if (data.status && data.status !== "ok") return true;
    const meta = data[normalizedIp];
    if (!meta || typeof meta !== "object") return true;
    return isVpnOrProxyProxycheckMeta(meta);
  } catch {
    return true; // network error → restrict
  }
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

function impersonateCookie(value, maxAgeSeconds) {
  return serializeCookie(IMPERSONATE_COOKIE, value, {
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
      avatarHash: payload.avatarHash ?? null,
      next: sanitizeNext(payload.next),
      flow: String(payload.flow ?? "staff"),
    };
  } catch {
    return null;
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
        // Mirror handleGetTicket's redaction: non-staff viewers never see
        // other participants' username/steamId on public messages.
        let redactedChunk = null;
        for (const entry of set) {
          if (
            event.type === "new_message" &&
            event.message?.isInternal &&
            !entry.isStaff
          )
            continue;
          let out = chunk;
          if (
            event.type === "new_message" &&
            !entry.isStaff &&
            event.message?.userId !== entry.userId
          ) {
            if (!redactedChunk) {
              const redacted = {
                ...event,
                message: { ...event.message, username: null, steamId: null },
              };
              redactedChunk = sseEncoder.encode(
                `data: ${JSON.stringify(redacted)}\n\n`,
              );
            }
            out = redactedChunk;
          }
          try {
            entry.controller.enqueue(out);
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
    const { rows: allOrgs } = await pool.query(
      `SELECT org_id FROM organizations`,
    );
    for (const { org_id } of allOrgs) await ensureDefaultTicketTypes(org_id);
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
      24 * 60 * 60 * 1000, // every 24 hours
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

async function createSessionForUser(user, options = {}) {
  const access = await loadUserAccess(user.userId);

  const ipAddress = options.ipAddress ?? null;
  const userAgent = options.userAgent ?? null;

  // VPN check — cap TTL to 24 h for confirmed or unconfirmed VPN/proxy logins
  let isVpnLogin = false;
  let sessionTtlSeconds = env.sessionTtlSeconds;
  if (ipAddress) {
    try {
      isVpnLogin = await checkLoginIpIsVpn(ipAddress);
      if (isVpnLogin)
        sessionTtlSeconds = Math.min(sessionTtlSeconds, 24 * 60 * 60);
    } catch {}
  }

  const sid = crypto.randomUUID();
  const token = jwt.sign({ sid }, env.jwtSecret, {
    expiresIn: sessionTtlSeconds,
  });
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds;

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
    loginIp: ipAddress,
  };

  await redis.set(
    `session:${sid}`,
    JSON.stringify(session),
    "EX",
    sessionTtlSeconds,
  );
  await pool.query(
    `INSERT INTO sessions (session_id, user_id, token_hash, created_at, expires_at, ip_address, user_agent, is_vpn_login, revoked)
     VALUES ($1, $2, $3, unix_now(), $4, $5, $6, $7, FALSE)`,
    [
      sid,
      session.userId,
      tokenHash,
      expiresAt,
      ipAddress,
      userAgent,
      isVpnLogin,
    ],
  );

  if (options.redirectTo) {
    const headers = clearPendingLinkHeaders(new Headers());
    headers.append("set-cookie", sessionCookie(token, sessionTtlSeconds));
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
    sessionCookie(token, sessionTtlSeconds),
  );
  return response;
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
            t.visibility_role_id,
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
             OR (
               t.visibility_role_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM organization_members vis_om
                 WHERE vis_om.user_id = $2
                   AND vis_om.org_id = t.org_id
                   AND vis_om.role_id = t.visibility_role_id
               )
             )
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
    visibilityRoleId:
      row.visibility_role_id == null ? null : String(row.visibility_role_id),
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

// ── Steam-link helpers (shared by staff + public login callbacks) ────────────

// A user counts as staff if they hold an active (non-disabled) membership in any
// real organization, or they are the configured sysadmin. Staff are held to the
// Steam account assigned to them on the staff management page; public visitors
// are not.
async function userIsStaff(userId, discordId) {
  const sysAdminDiscordId = String(env.sysAdminDiscordId ?? "").trim();
  if (sysAdminDiscordId && String(discordId) === sysAdminDiscordId) return true;
  const res = await pool.query(
    `SELECT 1 FROM organization_members
     WHERE user_id = $1 AND org_id != $2 LIMIT 1`,
    [userId, SYSADMIN.globalOrgId],
  );
  return res.rows.length > 0;
}

// True when the given Steam ID is already linked to a *different* user (checked
// against both the multi-link table and the canonical users.steam_id column).
// Passing a null/undefined userId treats any existing owner as a conflict.
async function steamOwnedByOtherUser(steamId, userId) {
  const owner = String(userId ?? "");
  const linkRes = await pool.query(
    `SELECT user_id FROM user_steam_accounts WHERE steam_id = $1 LIMIT 1`,
    [steamId],
  );
  if (linkRes.rows[0] && String(linkRes.rows[0].user_id) !== owner) return true;
  const userRes = await pool.query(
    `SELECT user_id FROM users WHERE steam_id = $1 LIMIT 1`,
    [steamId],
  );
  if (userRes.rows[0] && String(userRes.rows[0].user_id) !== owner) return true;
  return false;
}

// Records a Steam account against a user in user_steam_accounts. When makePrimary
// is set it also becomes the canonical users.steam_id (used for RCON syncing) and
// the sole primary link. Caller must have already ruled out cross-user conflicts.
async function linkSteamAccount(userId, steamId, { makePrimary = false } = {}) {
  const cached = await pool
    .query(
      `SELECT display_name FROM player_cache WHERE steam_id = $1 LIMIT 1`,
      [steamId],
    )
    .catch(() => ({ rows: [] }));
  const steamName = cached.rows[0]?.display_name ?? null;

  if (makePrimary) {
    await pool.query(
      `UPDATE user_steam_accounts SET is_primary = false WHERE user_id = $1`,
      [userId],
    );
  }
  await pool.query(
    `INSERT INTO user_steam_accounts (user_id, steam_id, steam_name, is_primary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (steam_id) DO UPDATE SET
       steam_name = COALESCE(EXCLUDED.steam_name, user_steam_accounts.steam_name),
       is_primary = user_steam_accounts.is_primary OR EXCLUDED.is_primary`,
    [userId, steamId, steamName, makePrimary],
  );
  if (makePrimary) {
    await pool.query(
      `UPDATE users SET steam_id = $1, updated_at = unix_now() WHERE user_id = $2`,
      [steamId, userId],
    );
  }
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

    // Every OAuth login — including returning users — must re-verify Steam so a
    // staff member is confirmed to still control their assigned Steam account and
    // a public visitor's linked accounts stay in sync. We therefore always route
    // through the Steam step instead of short-circuiting known users to a session.

    // Cache guilds in Redis until the Steam step completes (15 min TTL) so the
    // Steam callback can persist them (guilds are only fetched in the staff flow).
    if (discordUser.guilds && redis) {
      await redis.set(
        `discord:guilds:${discordUser.discordId}`,
        JSON.stringify(discordUser.guilds),
        "EX",
        60 * 15,
      );
    }

    // Also persist the guild list (and avatar) right now for users that
    // already have a row, instead of waiting for the Steam step: this is what
    // lets org owners see a staff member's Discord servers from their very
    // first Discord OAuth — including staff whose user row was created via
    // the public /support flow (which never requests the guilds scope) — and
    // it survives an abandoned Steam step. New users are still covered by the
    // INSERT at Steam completion. Best-effort: a failure here must not block
    // the login.
    if (discordUser.guilds) {
      try {
        await pool.query(
          `UPDATE users
           SET discord_guilds = $2,
               discord_avatar_hash = COALESCE($3, discord_avatar_hash),
               updated_at = unix_now()
           WHERE discord_id = $1`,
          [
            discordUser.discordId,
            JSON.stringify(discordUser.guilds),
            discordUser.avatarHash,
          ],
        );
      } catch (err) {
        console.error(
          "[auth:discord] failed to persist guilds at callback",
          err?.message,
        );
      }
    }

    const pendingToken = signPendingLink({
      discordId: discordUser.discordId,
      username: discordUser.username,
      avatarHash: discordUser.avatarHash,
      next: sanitizeNext(stateData.next),
      flow: stateData.flow,
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
    const existingUserId = existingUser ? String(existingUser.user_id) : null;

    // Reject if this Steam account already belongs to a different user.
    if (await steamOwnedByOtherUser(steamId, existingUserId)) {
      return redirect(
        "/login?error=steam_already_linked",
        clearPendingLinkHeaders(new Headers()),
      );
    }

    if (existingUser) {
      const staff = await userIsStaff(existingUserId, pending.discordId);
      const assigned =
        existingUser.steam_id == null ? null : String(existingUser.steam_id);

      // Staff must authenticate with the Steam account assigned to them on the
      // staff management page. Any mismatch is rejected — we never silently swap
      // a staff member's Steam identity.
      if (staff && assigned && assigned !== steamId) {
        return redirect(
          "/login?error=steam_mismatch",
          clearPendingLinkHeaders(new Headers()),
        );
      }

      await pool.query(
        `UPDATE users
         SET username = $2,
             discord_guilds = COALESCE($3, discord_guilds),
             discord_avatar_hash = COALESCE($4, discord_avatar_hash),
             updated_at = unix_now()
         WHERE user_id = $1`,
        [
          existingUserId,
          pending.username,
          cachedGuildsJson,
          pending.avatarHash,
        ],
      );

      // Adopt this Steam as the primary only when the user has none yet (first
      // login) or it already is their assigned staff account; otherwise (a
      // non-staff user signing in with a new Steam) just record it as an
      // additional linked account without disturbing their primary.
      const makePrimary = assigned == null || (staff && assigned === steamId);
      await linkSteamAccount(existingUserId, steamId, { makePrimary });

      return createSessionForUser(
        {
          userId: existingUserId,
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
      // Avatar hash was captured during the Discord OAuth step and carried
      // through the pending-link token, so it is available for both public and
      // staff flows without depending on a configured bot token.
      await pool.query(
        `INSERT INTO users (user_id, username, discord_id, steam_id, discord_guilds, discord_avatar_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          pending.username,
          pending.discordId,
          steamId,
          cachedGuildsJson,
          pending.avatarHash,
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
    await linkSteamAccount(userId, steamId, { makePrimary: true });

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

// ── Add another Steam account to an existing session ─────────────────────────

async function handleSteamAddStart(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const next = sanitizeNext(url.searchParams.get("next") ?? "/");

  const nonce = crypto.randomUUID();
  await redis.set(
    `openid:steam:add:${nonce}`,
    JSON.stringify({ userId: session.userId, next }),
    "EX",
    60 * 10,
  );

  const returnUrl = `${getBaseUrl(request)}/api/auth/steam/add-callback`;
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

async function handleSteamAddCallback(request) {
  const url = new URL(request.url);
  const nonce = String(url.searchParams.get("nonce") ?? "").trim();
  if (!nonce) return redirect("/?steam_add_error=invalid_state");

  const nonceKey = `openid:steam:add:${nonce}`;
  const nonceDataJson = await redis.getdel(nonceKey).catch(() => null);
  if (!nonceDataJson) return redirect("/?steam_add_error=state_expired");

  let nonceData;
  try {
    nonceData = JSON.parse(nonceDataJson);
  } catch {
    return redirect("/?steam_add_error=invalid_state");
  }

  const { userId, next } = nonceData;
  const safeNext = sanitizeNext(next ?? "/");

  try {
    await verifySteamResponse(url.searchParams);
    const claimedId = url.searchParams.get("openid.claimed_id") ?? "";
    const match = claimedId.match(/\/id\/(\d+)$/);
    if (!match) throw new Error("Steam claimed ID missing.");

    const steamId = match[1];

    // Check if this steam ID is already linked to a different user
    const conflict = await pool.query(
      `SELECT user_id FROM user_steam_accounts WHERE steam_id = $1 LIMIT 1`,
      [steamId],
    );
    if (conflict.rows[0] && String(conflict.rows[0].user_id) !== userId) {
      return redirect(`${safeNext}?steam_add_error=already_linked`);
    }

    // Already linked to this user — no-op, treat as success
    if (conflict.rows[0]) {
      return redirect(`${safeNext}?steam_linked=1`);
    }

    // Try to get steam name from player_cache
    const cachedPlayer = await pool
      .query(
        `SELECT display_name FROM player_cache WHERE steam_id = $1 LIMIT 1`,
        [steamId],
      )
      .catch(() => ({ rows: [] }));
    const steamName = cachedPlayer.rows[0]?.display_name ?? null;

    await pool.query(
      `INSERT INTO user_steam_accounts (user_id, steam_id, steam_name, is_primary)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (steam_id) DO NOTHING`,
      [userId, steamId, steamName],
    );

    return redirect(`${safeNext}?steam_linked=1`);
  } catch {
    return redirect(`${safeNext}?steam_add_error=verification_failed`);
  }
}

// ── Profile: list / delete / set-primary steam accounts ──────────────────────

async function handleGetProfileSteamAccounts(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const res = await pool.query(
    `SELECT usa.link_id, usa.steam_id, usa.steam_name, usa.is_primary, usa.created_at,
            pc.display_name AS cached_name, pc.avatar_url AS cached_avatar
     FROM user_steam_accounts usa
     LEFT JOIN player_cache pc ON pc.steam_id = usa.steam_id
     WHERE usa.user_id = $1
     ORDER BY usa.is_primary DESC, usa.created_at ASC`,
    [session.userId],
  );

  const accounts = res.rows.map((r) => ({
    linkId: String(r.link_id),
    steamId: r.steam_id,
    steamName: r.cached_name ?? r.steam_name ?? null,
    avatarUrl: r.cached_avatar ?? null,
    isPrimary: Boolean(r.is_primary),
    createdAt: Number(r.created_at),
  }));

  return json({ accounts });
}

async function handleDeleteProfileSteamAccount(request, linkId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const linkRes = await pool.query(
    `SELECT link_id, steam_id, is_primary FROM user_steam_accounts
     WHERE link_id = $1 AND user_id = $2 LIMIT 1`,
    [linkId, session.userId],
  );
  const link = linkRes.rows[0];
  if (!link) return json({ error: "Steam account link not found" }, 404);

  const countRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM user_steam_accounts WHERE user_id = $1`,
    [session.userId],
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  if (link.is_primary && total > 1) {
    return json(
      {
        error: "Set a different primary Steam account before removing this one",
      },
      400,
    );
  }

  await pool.query(
    `DELETE FROM user_steam_accounts WHERE link_id = $1 AND user_id = $2`,
    [linkId, session.userId],
  );

  // If we deleted the primary, promote the next oldest account
  if (link.is_primary) {
    const nextRes = await pool.query(
      `SELECT link_id, steam_id FROM user_steam_accounts
       WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [session.userId],
    );
    if (nextRes.rows[0]) {
      await pool.query(
        `UPDATE user_steam_accounts SET is_primary = true WHERE link_id = $1`,
        [nextRes.rows[0].link_id],
      );
      await pool.query(
        `UPDATE users SET steam_id = $1, updated_at = unix_now() WHERE user_id = $2`,
        [nextRes.rows[0].steam_id, session.userId],
      );
    } else {
      await pool.query(
        `UPDATE users SET steam_id = NULL, updated_at = unix_now() WHERE user_id = $1`,
        [session.userId],
      );
    }
  }

  return json({ ok: true });
}

async function handleSetProfilePrimarySteam(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const linkId = String(body?.linkId ?? "").trim();
  if (!linkId) return json({ error: "linkId is required" }, 400);

  const linkRes = await pool.query(
    `SELECT link_id, steam_id FROM user_steam_accounts
     WHERE link_id = $1 AND user_id = $2 LIMIT 1`,
    [linkId, session.userId],
  );
  const link = linkRes.rows[0];
  if (!link) return json({ error: "Steam account link not found" }, 404);

  await pool.query(
    `UPDATE user_steam_accounts SET is_primary = false WHERE user_id = $1`,
    [session.userId],
  );
  await pool.query(
    `UPDATE user_steam_accounts SET is_primary = true WHERE link_id = $1`,
    [linkId],
  );
  await pool.query(
    `UPDATE users SET steam_id = $1, updated_at = unix_now() WHERE user_id = $2`,
    [link.steam_id, session.userId],
  );

  return json({ ok: true, steamId: link.steam_id });
}

// ── Org admin: force-select primary steam for a member ───────────────────────

async function handleSetOrgMemberPrimarySteam(request, orgId, userId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "org_manage")) {
    return json({ error: "Forbidden: org_manage permission required" }, 403);
  }

  const memberRes = await pool.query(
    `SELECT user_id FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
    [orgId, userId],
  );
  if (!memberRes.rows[0])
    return json({ error: "User is not a member of this org" }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const steamId = String(body?.steamId ?? "").trim();
  if (!steamId) return json({ error: "steamId is required" }, 400);

  const linkRes = await pool.query(
    `SELECT link_id FROM user_steam_accounts
     WHERE steam_id = $1 AND user_id = $2 LIMIT 1`,
    [steamId, userId],
  );
  if (!linkRes.rows[0])
    return json({ error: "Steam account not linked to this user" }, 404);

  await pool.query(
    `UPDATE user_steam_accounts SET is_primary = false WHERE user_id = $1`,
    [userId],
  );
  await pool.query(
    `UPDATE user_steam_accounts SET is_primary = true WHERE link_id = $1`,
    [linkRes.rows[0].link_id],
  );
  await pool.query(
    `UPDATE users SET steam_id = $1, updated_at = unix_now() WHERE user_id = $2`,
    [steamId, userId],
  );

  await scanDel("cache:members:*");

  return json({ ok: true, steamId });
}

// ── Sysadmin: list all linked steam accounts ──────────────────────────────────

async function handleSysListLinkedAccounts(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isConfiguredSysAdmin(session))
    return json({ error: "Forbidden: sysadmin only" }, 403);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = 50;
  const offset = (page - 1) * limit;
  const q = (url.searchParams.get("q") ?? "").trim();

  let usersRes, countRes;
  if (q) {
    usersRes = await pool.query(
      `SELECT u.user_id, u.username, u.discord_id, u.steam_id,
              COUNT(usa.link_id) AS account_count
       FROM users u
       JOIN user_steam_accounts usa ON usa.user_id = u.user_id
       WHERE u.username ILIKE $1 OR u.discord_id LIKE $2 OR u.steam_id LIKE $2
       GROUP BY u.user_id
       ORDER BY account_count DESC, u.username ASC
       LIMIT $3 OFFSET $4`,
      [`%${q}%`, `%${q}%`, limit, offset],
    );
    countRes = await pool.query(
      `SELECT COUNT(DISTINCT u.user_id) AS total
       FROM users u
       JOIN user_steam_accounts usa ON usa.user_id = u.user_id
       WHERE u.username ILIKE $1 OR u.discord_id LIKE $2 OR u.steam_id LIKE $2`,
      [`%${q}%`, `%${q}%`],
    );
  } else {
    usersRes = await pool.query(
      `SELECT u.user_id, u.username, u.discord_id, u.steam_id,
              COUNT(usa.link_id) AS account_count
       FROM users u
       JOIN user_steam_accounts usa ON usa.user_id = u.user_id
       GROUP BY u.user_id
       ORDER BY account_count DESC, u.username ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    countRes = await pool.query(
      `SELECT COUNT(DISTINCT u.user_id) AS total
       FROM users u JOIN user_steam_accounts usa ON usa.user_id = u.user_id`,
    );
  }

  const userIds = usersRes.rows.map((r) => r.user_id);
  let accountRows = { rows: [] };
  if (userIds.length > 0) {
    accountRows = await pool.query(
      `SELECT usa.link_id, usa.user_id, usa.steam_id, usa.steam_name,
              usa.is_primary, usa.created_at,
              pc.display_name AS cached_name, pc.avatar_url AS cached_avatar
       FROM user_steam_accounts usa
       LEFT JOIN player_cache pc ON pc.steam_id = usa.steam_id
       WHERE usa.user_id = ANY($1)
       ORDER BY usa.user_id, usa.is_primary DESC, usa.created_at ASC`,
      [userIds],
    );
  }

  const accountsByUser = {};
  for (const row of accountRows.rows) {
    const uid = String(row.user_id);
    if (!accountsByUser[uid]) accountsByUser[uid] = [];
    accountsByUser[uid].push({
      linkId: String(row.link_id),
      steamId: row.steam_id,
      steamName: row.cached_name ?? row.steam_name ?? null,
      avatarUrl: row.cached_avatar ?? null,
      isPrimary: Boolean(row.is_primary),
      createdAt: Number(row.created_at),
    });
  }

  const users = usersRes.rows.map((r) => ({
    userId: String(r.user_id),
    username: r.username,
    discordId: r.discord_id ?? null,
    steamId: r.steam_id ?? null,
    accountCount: Number(r.account_count),
    steamAccounts: accountsByUser[String(r.user_id)] ?? [],
  }));

  return json({
    users,
    total: Number(countRes.rows[0]?.total ?? 0),
    page,
    limit,
  });
}

async function handleSysDeleteLinkedAccount(request, linkId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isConfiguredSysAdmin(session))
    return json({ error: "Forbidden: sysadmin only" }, 403);

  const linkRes = await pool.query(
    `SELECT link_id, user_id, steam_id, is_primary FROM user_steam_accounts
     WHERE link_id = $1 LIMIT 1`,
    [linkId],
  );
  const link = linkRes.rows[0];
  if (!link) return json({ error: "Link not found" }, 404);

  await pool.query(`DELETE FROM user_steam_accounts WHERE link_id = $1`, [
    linkId,
  ]);

  if (link.is_primary) {
    const nextRes = await pool.query(
      `SELECT link_id, steam_id FROM user_steam_accounts
       WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [link.user_id],
    );
    if (nextRes.rows[0]) {
      await pool.query(
        `UPDATE user_steam_accounts SET is_primary = true WHERE link_id = $1`,
        [nextRes.rows[0].link_id],
      );
      await pool.query(
        `UPDATE users SET steam_id = $1, updated_at = unix_now() WHERE user_id = $2`,
        [nextRes.rows[0].steam_id, link.user_id],
      );
    } else {
      await pool.query(
        `UPDATE users SET steam_id = NULL, updated_at = unix_now() WHERE user_id = $1`,
        [link.user_id],
      );
    }
  }

  return json({ ok: true });
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

  if (!derivedOrgId || !/^[a-z0-9_-]+$/.test(derivedOrgId)) {
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

  // Skip the session-refresh step when running under an impersonation cookie —
  // that token is stored under a different Redis key and has a fixed short TTL.
  if (!session.impersonating) {
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
            await redis.set(
              `session:${sid}`,
              JSON.stringify(cached),
              "KEEPTTL",
            );
          }
        }
      }
    } catch {
      // Non-fatal: user can re-login to pick up the change if this fails.
    }
  }

  const orgRoles = {};
  if (orgIds.length) {
    const rolesRes = await pool.query(
      `SELECT r.role_id, r.role_name, r.position, orgs.org_id
       FROM unnest($1::text[]) AS orgs(org_id)
       JOIN roles r ON r.role_id LIKE (orgs.org_id || '_%')
       WHERE r.role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
       ORDER BY orgs.org_id, r.position DESC, r.role_name ASC`,
      [orgIds],
    );
    for (const row of rolesRes.rows) {
      const oid = String(row.org_id);
      if (!orgRoles[oid]) orgRoles[oid] = [];
      orgRoles[oid].push({
        roleId: String(row.role_id),
        roleName: String(row.role_name),
        position: Number(row.position),
      });
    }
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
    orgRoles,
    impersonatingAs: session.impersonating
      ? {
          userId: session.userId,
          username: session.username,
          orgId: session.impersonatedOrgId,
        }
      : null,
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
  const visibilityRoleId =
    body?.visibilityRoleId == null
      ? null
      : String(body.visibilityRoleId).trim() || null;

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

  if (visibilityRoleId) {
    const roleCheck = await pool.query(
      `SELECT 1 FROM roles WHERE role_id = $1 AND role_id LIKE ($2 || '_%') LIMIT 1`,
      [visibilityRoleId, orgId],
    );
    if (!roleCheck.rows[0]) {
      return json(
        { error: "Invalid visibility role for this organization" },
        400,
      );
    }
  }

  const todoId = crypto.randomUUID();
  const createdUnix = nowUnix();
  await pool.query(
    `INSERT INTO todos (todo_id, title, description, status, priority, is_public, is_personal, visibility_role_id, assigned_to, org_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      todoId,
      title,
      details,
      status,
      priority,
      isPublic,
      isPersonal,
      visibilityRoleId,
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
        visibilityRoleId,
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
  const visibilityRoleId =
    body?.visibilityRoleId === undefined
      ? undefined
      : body.visibilityRoleId === null
        ? null
        : String(body.visibilityRoleId).trim() || null;

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

  const updateVisibilityRole = visibilityRoleId !== undefined;
  if (updateVisibilityRole && visibilityRoleId !== null) {
    const orgId = String(existing.org_id);
    const roleCheck = await pool.query(
      `SELECT 1 FROM roles WHERE role_id = $1 AND role_id LIKE ($2 || '_%') LIMIT 1`,
      [visibilityRoleId, orgId],
    );
    if (!roleCheck.rows[0]) {
      return json(
        { error: "Invalid visibility role for this organization" },
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
         visibility_role_id = CASE WHEN $9::boolean THEN $10::text ELSE visibility_role_id END,
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
      updateVisibilityRole,
      visibilityRoleId ?? null,
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

  // Warn if the member has multiple steam accounts (staff must use one for RCON syncing)
  const steamAcctRes = await pool.query(
    `SELECT link_id, steam_id, steam_name, is_primary
     FROM user_steam_accounts WHERE user_id = $1
     ORDER BY is_primary DESC, created_at ASC`,
    [member.userId],
  );
  const steamWarning =
    steamAcctRes.rows.length > 1
      ? {
          count: steamAcctRes.rows.length,
          accounts: steamAcctRes.rows.map((r) => ({
            linkId: String(r.link_id),
            steamId: r.steam_id,
            steamName: r.steam_name ?? null,
            isPrimary: Boolean(r.is_primary),
          })),
        }
      : null;

  return json({
    ok: true,
    orgId,
    discordId,
    userId: member.userId,
    username: member.username,
    steamWarning,
  });
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

  // Resolve and authorize the requested permissions BEFORE creating the role so a
  // rejected request never leaves an orphan empty role behind. Keep only
  // assignable permissions, and prevent privilege escalation: a non-admin/owner
  // creator cannot grant a permission they do not personally hold.
  const filteredPermissions = permissions.filter((p) =>
    ASSIGNABLE_PERMISSIONS.includes(String(p).trim()),
  );
  if (!isGlobalAdmin(session) && !canManageOrg(session, orgId)) {
    const userPerms = new Set(session.orgPermissions?.[orgId] ?? []);
    const escalated = filteredPermissions.filter((p) => !userPerms.has(p));
    if (escalated.length > 0) {
      return json({ error: "Cannot grant permissions you do not hold" }, 403);
    }
  }

  // Create the role at the BOTTOM of the hierarchy (Discord convention): bump
  // every existing custom role up one and insert the new one at position 1.
  // A role created at the bottom is always below its creator, so no position
  // ceiling check is needed here — the permission ceiling above is what matters.
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

  // Add the (already-authorized) permissions to the role.
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

  const newTeam = body?.team != null ? String(body.team).trim() : null;
  const hasStorageLimit = "mediaUserLimitBytes" in body;
  if (!newTeam && !hasStorageLimit) {
    return json(
      { error: "team or mediaUserLimitBytes is required in request body" },
      400,
    );
  }

  // Handle per-user storage limit update (can be combined with or independent of role change).
  if (hasStorageLimit) {
    const rawLimit = body.mediaUserLimitBytes;
    if (
      rawLimit !== null &&
      (typeof rawLimit !== "number" ||
        !Number.isFinite(rawLimit) ||
        rawLimit < 0)
    ) {
      return json(
        { error: "mediaUserLimitBytes must be a non-negative number or null" },
        400,
      );
    }
    const memberCheck = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
      [orgId, userId],
    );
    if (!memberCheck.rows[0]) {
      return json({ error: "Member not found in this organization" }, 404);
    }
    await pool.query(
      `UPDATE organization_members SET media_user_limit_bytes = $1 WHERE org_id = $2 AND user_id = $3`,
      [rawLimit != null ? Math.round(rawLimit) : null, orgId, userId],
    );
    if (!newTeam) {
      return json({ ok: true, orgId, userId, warnings: [] });
    }
  }

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
    `SELECT u.user_id, u.username, u.discord_id, u.steam_id, u.discord_guilds, u.discord_avatar_hash,
            om.role_id, om.media_user_limit_bytes,
            COALESCE((
              SELECT SUM(file_size) FROM org_media m
              WHERE m.org_id = om.org_id AND m.uploaded_by = om.user_id
                AND m.deleted = FALSE AND m.confirmed = TRUE AND m.source = 'staff'
            ), 0)::BIGINT AS media_used_bytes
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
      mediaUserLimitBytes:
        row.media_user_limit_bytes != null
          ? Number(row.media_user_limit_bytes)
          : null,
      mediaUsedBytes: Number(row.media_used_bytes),
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

function serializeNotificationPrefs(row) {
  return {
    enabled: row?.enabled ?? false,
    entityKilled: row?.notify_entity_killed ?? false,
    entitySpawned: row?.notify_entity_spawned ?? false,
    playerKilledByAdmin: row?.notify_player_killed_by_admin ?? false,
    nonStaffAdmin: row?.notify_nonstaff_admin ?? false,
  };
}

async function handleGetNotificationPrefs(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId)) return json({ error: "Forbidden" }, 403);

  const res = await pool.query(
    `SELECT enabled, notify_entity_killed, notify_entity_spawned,
            notify_player_killed_by_admin, notify_nonstaff_admin
     FROM staff_notification_prefs WHERE user_id = $1 AND org_id = $2`,
    [session.userId, orgId],
  );
  return json(serializeNotificationPrefs(res.rows[0]));
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

  // Partial update: only the boolean fields present in the body change; a
  // NULL param keeps the existing value (and inserts FALSE for a new row). This
  // lets the health-alert toggle and the per-event toggles co-exist safely.
  const tri = (v) => (v === undefined ? null : !!v);
  const params = [
    session.userId,
    orgId,
    tri(body?.enabled),
    tri(body?.entityKilled),
    tri(body?.entitySpawned),
    tri(body?.playerKilledByAdmin),
    tri(body?.nonStaffAdmin),
  ];

  const res = await pool.query(
    `INSERT INTO staff_notification_prefs
       (user_id, org_id, enabled, notify_entity_killed, notify_entity_spawned,
        notify_player_killed_by_admin, notify_nonstaff_admin)
     VALUES ($1, $2, COALESCE($3, FALSE), COALESCE($4, FALSE), COALESCE($5, FALSE),
             COALESCE($6, FALSE), COALESCE($7, FALSE))
     ON CONFLICT (user_id, org_id) DO UPDATE SET
       enabled = COALESCE($3, staff_notification_prefs.enabled),
       notify_entity_killed = COALESCE($4, staff_notification_prefs.notify_entity_killed),
       notify_entity_spawned = COALESCE($5, staff_notification_prefs.notify_entity_spawned),
       notify_player_killed_by_admin = COALESCE($6, staff_notification_prefs.notify_player_killed_by_admin),
       notify_nonstaff_admin = COALESCE($7, staff_notification_prefs.notify_nonstaff_admin)
     RETURNING enabled, notify_entity_killed, notify_entity_spawned,
               notify_player_killed_by_admin, notify_nonstaff_admin`,
    params,
  );
  return json(serializeNotificationPrefs(res.rows[0]));
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
      viewType: "impersonate",
    },
  });

  // Build a temporary impersonation session scoped to this org only.
  // getSession() checks this cookie first, so all subsequent API calls are
  // authorized with the target member's real permissions — not the admin's.
  const sid = crypto.randomUUID();
  const impersonateToken = jwt.sign({ sid }, env.jwtSecret, {
    expiresIn: IMPERSONATE_TTL,
  });
  const impersonateSession = {
    impersonating: true,
    userId: String(targetMember.user_id),
    username: String(targetMember.username),
    discordId:
      targetMember.discord_id == null ? null : String(targetMember.discord_id),
    steamId:
      targetMember.steam_id == null ? null : String(targetMember.steam_id),
    realUserId: String(session.userId),
    impersonatedOrgId: orgId,
    orgAdminOrgIds: targetAccess.orgAdminOrgIds.filter((id) => id === orgId),
    orgOwnerOrgIds: targetAccess.orgOwnerOrgIds.filter((id) => id === orgId),
    orgPermissions: {
      [orgId]: targetAccess.orgPermissions[orgId] ?? [],
    },
    globalAdmin: false,
    canWrite: targetAccess.canWrite,
    canDeleteBans: targetAccess.canDeleteBans,
    groups: targetAccess.groups,
  };
  await redis.set(
    `impersonate_session:${sid}`,
    JSON.stringify(impersonateSession),
    "EX",
    IMPERSONATE_TTL,
  );

  const member = {
    userId: String(targetMember.user_id),
    username: String(targetMember.username),
    discordId:
      targetMember.discord_id == null ? null : String(targetMember.discord_id),
    steamId:
      targetMember.steam_id == null ? null : String(targetMember.steam_id),
    roleId: String(targetMember.role_id),
  };
  const access = {
    orgAdminOrgIds: impersonateSession.orgAdminOrgIds,
    orgOwnerOrgIds: impersonateSession.orgOwnerOrgIds,
    canWrite: targetAccess.canWrite,
    groups: targetAccess.groups,
    permissions: targetAccess.orgPermissions[orgId] ?? [],
  };

  const response = json({
    ok: true,
    member,
    access,
    viewOnly: true,
    viewedAt: Math.floor(Date.now() / 1000),
  });
  response.headers.append(
    "set-cookie",
    impersonateCookie(impersonateToken, IMPERSONATE_TTL),
  );
  return response;
}

async function handleStopImpersonating(request) {
  const cookies = parseCookie(request.headers.get("cookie") ?? "");
  const impersonateToken = cookies[IMPERSONATE_COOKIE];
  if (impersonateToken) {
    try {
      const decoded = jwt.verify(impersonateToken, env.jwtSecret);
      const sid = decoded?.sid;
      if (sid && typeof sid === "string") {
        await redis.del(`impersonate_session:${sid}`);
      }
    } catch {
      // Invalid token — just clear the cookie anyway.
    }
  }
  const response = json({ ok: true });
  response.headers.append("set-cookie", impersonateCookie("", 0));
  return response;
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

  // Storage settings are sysadmin-only — org owners cannot alter quotas or expiry.
  if (!isConfiguredSysAdmin(session)) {
    const storageFieldsPresent = [
      body?.mediaExpiryMonths,
      body?.mediaStorageLimitBytes,
      body?.mediaUserLimitBytes,
      body?.mediaPublicFileLimitBytes,
      body?.mediaPublicMaxFiles,
    ].some((v) => v !== undefined);
    if (storageFieldsPresent) {
      return json(
        { error: "Forbidden: only sysadmin can change storage settings" },
        403,
      );
    }
  }

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
  } catch (err) {
    await client.query(`ROLLBACK`);
    throw err;
  } finally {
    client.release();
  }

  await auditLog({
    orgId: null,
    actorUserId: session.userId,
    resourceType: "role",
    resourceId: String(roleId),
    actionType: "ROLE_PERMISSIONS_UPDATED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { roleId, permissionIds },
  });

  return json({ ok: true, roleId, permissionIds });
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
    name: "Bug Report",
    description: "Report a bug or technical issue on the server.",
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
  {
    name: "Staff Application",
    description: "Apply to join the staff team.",
    category: "staff_application",
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

    // Find existing user by Discord identity (the public flow always links
    // Discord first, so a returning visitor is matched on discord_id).
    const existingRes = await pool.query(
      `SELECT user_id, username, discord_id, steam_id FROM users
       WHERE discord_id = $1 LIMIT 1`,
      [pending.discordId],
    );
    const existingUser = existingRes.rows[0];
    const existingUserId = existingUser ? String(existingUser.user_id) : null;

    // Reject if this Steam account already belongs to a different user.
    if (await steamOwnedByOtherUser(steamId, existingUserId)) {
      return redirect(
        "/support?error=steam_already_linked",
        clearPendingLinkHeaders(new Headers()),
      );
    }

    let userId;
    if (existingUser) {
      userId = existingUserId;
      const staff = await userIsStaff(userId, pending.discordId);
      const assigned =
        existingUser.steam_id == null ? null : String(existingUser.steam_id);

      // A staff member is held to their assigned Steam account even when they
      // come through the public portal — reject a mismatch rather than link it.
      if (staff && assigned && assigned !== steamId) {
        return redirect(
          "/support?error=steam_mismatch",
          clearPendingLinkHeaders(new Headers()),
        );
      }

      await pool.query(
        `UPDATE users
         SET username = $2, discord_id = $3, updated_at = unix_now()
         WHERE user_id = $1`,
        [userId, pending.username, pending.discordId],
      );

      // Public visitors can hold multiple Steam accounts on one Discord: keep
      // their existing primary and just add any new Steam as another linked
      // account. Only adopt it as primary when they had none yet.
      const makePrimary = assigned == null || (staff && assigned === steamId);
      await linkSteamAccount(userId, steamId, { makePrimary });
    } else {
      userId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (user_id, username, discord_id, steam_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, pending.username, pending.discordId, steamId],
      );
      await linkSteamAccount(userId, steamId, { makePrimary: true });
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

function sanitizeQuestionConfig(questionType, config) {
  if (questionType === "text") {
    const minLength =
      config.minLength != null ? Number(config.minLength) : null;
    const maxLength =
      config.maxLength != null ? Number(config.maxLength) : null;
    if (minLength !== null && (!Number.isInteger(minLength) || minLength < 0))
      return null;
    if (maxLength !== null && (!Number.isInteger(maxLength) || maxLength < 1))
      return null;
    if (minLength !== null && maxLength !== null && minLength > maxLength)
      return null;
    return {
      ...(minLength !== null ? { minLength } : {}),
      ...(maxLength !== null ? { maxLength } : {}),
    };
  }
  if (questionType === "number") {
    const min = config.min != null ? Number(config.min) : null;
    const max = config.max != null ? Number(config.max) : null;
    if (min !== null && !Number.isFinite(min)) return null;
    if (max !== null && !Number.isFinite(max)) return null;
    if (min !== null && max !== null && min > max) return null;
    return {
      ...(min !== null ? { min } : {}),
      ...(max !== null ? { max } : {}),
    };
  }
  if (questionType === "multiple_choice") {
    const options = Array.isArray(config.options) ? config.options : [];
    const cleanOptions = options
      .map((o) => String(o).trim())
      .filter((o) => o.length > 0)
      .slice(0, 20);
    return { options: cleanOptions };
  }
  return null;
}

async function handleListTicketTypeQuestions(request, orgId, ticketTypeId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "ticket_types_manage")
  ) {
    return json({ error: "Not authorized" }, 403);
  }

  const ttRes = await pool.query(
    `SELECT ticket_type_id FROM ticket_types WHERE ticket_type_id = $1 AND org_id = $2 LIMIT 1`,
    [ticketTypeId, orgId],
  );
  if (!ttRes.rows[0]) return json({ error: "Ticket type not found" }, 404);

  const { rows } = await pool.query(
    `SELECT question_id, question_text, question_type, is_required, position, config
     FROM ticket_type_questions
     WHERE ticket_type_id = $1
     ORDER BY position ASC, question_id ASC`,
    [ticketTypeId],
  );

  return json({
    questions: rows.map((r) => ({
      questionId: Number(r.question_id),
      questionText: String(r.question_text),
      questionType: String(r.question_type),
      isRequired: Boolean(r.is_required),
      position: Number(r.position),
      config: r.config ?? {},
    })),
  });
}

async function handleListPublicTicketTypeQuestions(
  request,
  orgId,
  ticketTypeId,
) {
  const rl = await checkRateLimit(
    `rl:public-questions:${getClientIp(request)}`,
    PUBLIC_READ_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (rl) return rl;

  const ttRes = await pool.query(
    `SELECT ticket_type_id FROM ticket_types WHERE ticket_type_id = $1 AND org_id = $2 AND is_enabled = true LIMIT 1`,
    [ticketTypeId, orgId],
  );
  if (!ttRes.rows[0]) return json({ error: "Ticket type not found" }, 404);

  const { rows } = await pool.query(
    `SELECT question_id, question_text, question_type, is_required, position, config
     FROM ticket_type_questions
     WHERE ticket_type_id = $1
     ORDER BY position ASC, question_id ASC`,
    [ticketTypeId],
  );

  return json({
    questions: rows.map((r) => ({
      questionId: Number(r.question_id),
      questionText: String(r.question_text),
      questionType: String(r.question_type),
      isRequired: Boolean(r.is_required),
      config: r.config ?? {},
    })),
  });
}

async function handleCreateTicketTypeQuestion(request, orgId, ticketTypeId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "ticket_types_manage")
  ) {
    return json({ error: "Not authorized" }, 403);
  }

  const ttRes = await pool.query(
    `SELECT ticket_type_id FROM ticket_types WHERE ticket_type_id = $1 AND org_id = $2 LIMIT 1`,
    [ticketTypeId, orgId],
  );
  if (!ttRes.rows[0]) return json({ error: "Ticket type not found" }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const questionText = String(body?.questionText ?? "").trim();
  const questionType = String(body?.questionType ?? "text");
  const isRequired =
    typeof body?.isRequired === "boolean" ? body.isRequired : true;
  const rawConfig =
    body?.config &&
    typeof body.config === "object" &&
    !Array.isArray(body.config)
      ? body.config
      : {};

  if (!questionText) return json({ error: "questionText is required" }, 400);
  if (questionText.length > 500)
    return json({ error: "questionText must be 500 characters or fewer" }, 400);
  if (!["text", "number", "multiple_choice"].includes(questionType))
    return json({ error: "Invalid question type" }, 400);

  const sanitizedConfig = sanitizeQuestionConfig(questionType, rawConfig);
  if (sanitizedConfig === null)
    return json({ error: "Invalid config for question type" }, 400);

  const posRes = await pool.query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM ticket_type_questions WHERE ticket_type_id = $1`,
    [ticketTypeId],
  );
  const position = Number(posRes.rows[0].next_pos);

  const { rows } = await pool.query(
    `INSERT INTO ticket_type_questions
       (ticket_type_id, org_id, question_text, question_type, is_required, position, config)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING question_id, question_text, question_type, is_required, position, config`,
    [
      ticketTypeId,
      orgId,
      questionText,
      questionType,
      isRequired,
      position,
      JSON.stringify(sanitizedConfig),
    ],
  );

  const r = rows[0];

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ticket_type_question",
    resourceId: String(r.question_id),
    actionType: "TICKET_QUESTION_CREATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { ticketTypeId, questionText, questionType },
  });

  return json(
    {
      question: {
        questionId: Number(r.question_id),
        questionText: String(r.question_text),
        questionType: String(r.question_type),
        isRequired: Boolean(r.is_required),
        position: Number(r.position),
        config: r.config ?? {},
      },
    },
    201,
  );
}

async function handleUpdateTicketTypeQuestion(
  request,
  orgId,
  ticketTypeId,
  questionId,
) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "ticket_types_manage")
  ) {
    return json({ error: "Not authorized" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const qRes = await pool.query(
    `SELECT q.question_id, q.question_type
     FROM ticket_type_questions q
     JOIN ticket_types tt ON tt.ticket_type_id = q.ticket_type_id
     WHERE q.question_id = $1 AND q.ticket_type_id = $2 AND tt.org_id = $3
     LIMIT 1`,
    [questionId, ticketTypeId, orgId],
  );
  if (!qRes.rows[0]) return json({ error: "Question not found" }, 404);

  const effectiveType =
    typeof body?.questionType === "string"
      ? body.questionType
      : String(qRes.rows[0].question_type);

  if (!["text", "number", "multiple_choice"].includes(effectiveType))
    return json({ error: "Invalid question type" }, 400);

  const sets = [];
  const params = [];

  if (typeof body?.questionText === "string") {
    const t = body.questionText.trim();
    if (!t) return json({ error: "questionText cannot be empty" }, 400);
    if (t.length > 500)
      return json(
        { error: "questionText must be 500 characters or fewer" },
        400,
      );
    params.push(t);
    sets.push(`question_text = $${params.length}`);
  }
  if (typeof body?.questionType === "string") {
    params.push(effectiveType);
    sets.push(`question_type = $${params.length}`);
  }
  if (typeof body?.isRequired === "boolean") {
    params.push(body.isRequired);
    sets.push(`is_required = $${params.length}`);
  }
  if (body?.config !== undefined) {
    const raw =
      body.config &&
      typeof body.config === "object" &&
      !Array.isArray(body.config)
        ? body.config
        : {};
    const sanitized = sanitizeQuestionConfig(effectiveType, raw);
    if (sanitized === null) return json({ error: "Invalid config" }, 400);
    params.push(JSON.stringify(sanitized));
    sets.push(`config = $${params.length}`);
  }

  if (sets.length === 0) return json({ ok: true });

  params.push(questionId);
  await pool.query(
    `UPDATE ticket_type_questions SET ${sets.join(", ")} WHERE question_id = $${params.length}`,
    params,
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ticket_type_question",
    resourceId: String(questionId),
    actionType: "TICKET_QUESTION_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { ticketTypeId, questionId },
  });

  return json({ ok: true });
}

async function handleDeleteTicketTypeQuestion(
  request,
  orgId,
  ticketTypeId,
  questionId,
) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "ticket_types_manage")
  ) {
    return json({ error: "Not authorized" }, 403);
  }

  const res = await pool.query(
    `DELETE FROM ticket_type_questions
     WHERE question_id = $1 AND ticket_type_id = $2 AND org_id = $3`,
    [questionId, ticketTypeId, orgId],
  );

  if (res.rowCount === 0) return json({ error: "Question not found" }, 404);

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ticket_type_question",
    resourceId: String(questionId),
    actionType: "TICKET_QUESTION_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { ticketTypeId, questionId },
  });

  return json({ ok: true });
}

async function handleReorderTicketTypeQuestion(
  request,
  orgId,
  ticketTypeId,
  questionId,
) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "ticket_types_manage")
  ) {
    return json({ error: "Not authorized" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const direction = String(body?.direction ?? "");
  if (!["up", "down"].includes(direction))
    return json({ error: "direction must be 'up' or 'down'" }, 400);

  const listRes = await pool.query(
    `SELECT q.question_id, q.position
     FROM ticket_type_questions q
     JOIN ticket_types tt ON tt.ticket_type_id = q.ticket_type_id
     WHERE q.ticket_type_id = $1 AND tt.org_id = $2
     ORDER BY q.position ASC, q.question_id ASC`,
    [ticketTypeId, orgId],
  );

  const qs = listRes.rows;
  const idx = qs.findIndex((q) => Number(q.question_id) === questionId);
  if (idx === -1) return json({ error: "Question not found" }, 404);

  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= qs.length) return json({ ok: true });

  const a = qs[idx];
  const b = qs[swapIdx];

  await pool.query(
    `UPDATE ticket_type_questions SET position = $1 WHERE question_id = $2`,
    [Number(b.position), Number(a.question_id)],
  );
  await pool.query(
    `UPDATE ticket_type_questions SET position = $1 WHERE question_id = $2`,
    [Number(a.position), Number(b.question_id)],
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ticket_type_question",
    resourceId: String(questionId),
    actionType: "TICKET_QUESTION_REORDERED",
    actionCategory: "org_management",
    severity: 1,
    metadata: { ticketTypeId, questionId, direction },
  });

  return json({ ok: true });
}

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

  let query = `SELECT ticket_type_id, ticket_type_name, ticket_type_description, ticket_type_category, is_enabled, allow_media, max_open_per_user
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
      allowMedia: row.allow_media !== false,
      maxOpenPerUser:
        row.max_open_per_user != null ? Number(row.max_open_per_user) : null,
    })),
  });
}

async function handleUpdateOrgTicketType(request, orgId, ticketTypeId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "ticket_types_manage")
  ) {
    return json({ error: "Not authorized to manage this org" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { isEnabled, allowMedia, maxOpenPerUser } = body;
  if (isEnabled !== undefined && typeof isEnabled !== "boolean") {
    return json({ error: "isEnabled must be a boolean" }, 400);
  }
  if (allowMedia !== undefined && typeof allowMedia !== "boolean") {
    return json({ error: "allowMedia must be a boolean" }, 400);
  }
  if (
    maxOpenPerUser !== undefined &&
    maxOpenPerUser !== null &&
    (!Number.isInteger(maxOpenPerUser) ||
      maxOpenPerUser < 1 ||
      maxOpenPerUser > 100)
  ) {
    return json(
      { error: "maxOpenPerUser must be null or an integer between 1 and 100" },
      400,
    );
  }
  if (
    isEnabled === undefined &&
    allowMedia === undefined &&
    maxOpenPerUser === undefined
  ) {
    return json({ error: "No fields to update" }, 400);
  }

  const setClauses = [];
  const params = [];
  if (isEnabled !== undefined) {
    params.push(isEnabled);
    setClauses.push(`is_enabled = $${params.length}`);
  }
  if (allowMedia !== undefined) {
    params.push(allowMedia);
    setClauses.push(`allow_media = $${params.length}`);
  }
  if (maxOpenPerUser !== undefined) {
    params.push(maxOpenPerUser);
    setClauses.push(`max_open_per_user = $${params.length}`);
  }
  params.push(ticketTypeId, orgId);

  const res = await pool.query(
    `UPDATE ticket_types SET ${setClauses.join(", ")} WHERE ticket_type_id = $${params.length - 1} AND org_id = $${params.length}`,
    params,
  );

  if (res.rowCount === 0) {
    return json({ error: "Ticket type not found" }, 404);
  }

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ticket_type",
    resourceId: String(ticketTypeId),
    actionType: "TICKET_TYPE_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: {
      ticketTypeId,
      updatedFields: setClauses.map((c) => c.split(" = ")[0]),
    },
  });

  return json({ ok: true });
}

// ── Ticket blacklist ──────────────────────────────────────────────────────────

function canManageTicketBlacklist(session, orgId) {
  return (
    canManageOrg(session, orgId) ||
    orgHasPermission(session, orgId, "tickets_blacklist")
  );
}

async function handleListTicketBlacklist(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!canManageTicketBlacklist(session, orgId))
    return json({ error: "Forbidden" }, 403);

  const { rows } = await pool.query(
    `SELECT b.blacklist_id, b.steam_id, b.ticket_type_id, b.reason, b.created_at,
            tt.ticket_type_name,
            creator.username AS created_by_username
     FROM ticket_blacklist b
     LEFT JOIN ticket_types tt ON tt.ticket_type_id = b.ticket_type_id
     LEFT JOIN users creator ON creator.user_id = b.created_by
     WHERE b.org_id = $1
     ORDER BY b.created_at DESC`,
    [orgId],
  );

  return json({
    entries: rows.map((row) => ({
      blacklistId: Number(row.blacklist_id),
      steamId: String(row.steam_id),
      ticketTypeId:
        row.ticket_type_id != null ? Number(row.ticket_type_id) : null,
      ticketTypeName: row.ticket_type_name ?? null,
      reason: row.reason ?? "",
      createdBy: row.created_by_username ?? null,
      createdAt: Number(row.created_at),
    })),
  });
}

async function handleCreateTicketBlacklist(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!canManageTicketBlacklist(session, orgId))
    return json({ error: "Forbidden" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const steamId = String(body?.steamId ?? "").trim();
  const reason = String(body?.reason ?? "").trim();
  const ticketTypeId =
    body?.ticketTypeId == null ? null : Number(body.ticketTypeId);

  if (!/^\d{17}$/.test(steamId))
    return json({ error: "A valid SteamID64 is required" }, 400);
  if (reason.length > 500)
    return json({ error: "reason must be 500 characters or fewer" }, 400);
  if (ticketTypeId !== null && !Number.isInteger(ticketTypeId))
    return json({ error: "Invalid ticketTypeId" }, 400);

  const orgRes = await pool.query(
    `SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  // A per-type entry must reference a ticket type in this org (prevents
  // blacklisting against another tenant's type id).
  if (ticketTypeId !== null) {
    const typeRes = await pool.query(
      `SELECT 1 FROM ticket_types WHERE ticket_type_id = $1 AND org_id = $2 LIMIT 1`,
      [ticketTypeId, orgId],
    );
    if (!typeRes.rows[0])
      return json(
        { error: "Ticket type not found for this organization" },
        400,
      );
  }

  const { rows } = await pool.query(
    `INSERT INTO ticket_blacklist (org_id, steam_id, ticket_type_id, reason, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, steam_id, COALESCE(ticket_type_id, 0))
     DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = unix_now()
     RETURNING blacklist_id`,
    [orgId, steamId, ticketTypeId, reason, session.userId],
  );

  return json({ ok: true, blacklistId: Number(rows[0].blacklist_id) }, 201);
}

async function handleDeleteTicketBlacklist(request, orgId, blacklistId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!canManageTicketBlacklist(session, orgId))
    return json({ error: "Forbidden" }, 403);

  const res = await pool.query(
    `DELETE FROM ticket_blacklist WHERE blacklist_id = $1 AND org_id = $2`,
    [blacklistId, orgId],
  );
  if (res.rowCount === 0)
    return json({ error: "Blacklist entry not found" }, 404);

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

  // Structured submission sections ({ label, value } pairs) rendered as
  // separate sections in the staff view. Replaces the old single-message blob.
  const fields = sanitizeTicketFields(body?.fields);
  if (fields === null) return json({ error: "Invalid fields payload" }, 400);

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

  if (!orgId || !title || (!message && fields.length === 0)) {
    return json(
      { error: "orgId, title, and message or fields are required" },
      400,
    );
  }
  if (title.length > 255)
    return json({ error: "title must be 255 characters or fewer" }, 400);
  if (message.length > 10000)
    return json({ error: "message is too long" }, 400);
  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  if (ipRe.test(message) || fields.some((f) => ipRe.test(f.value)))
    return json({ error: "Messages cannot contain raw IP addresses." }, 400);

  const orgRes = await pool.query(
    "SELECT org_id, media_public_max_files FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  // Blacklist gate: a NULL ticket_type_id entry blocks every type; a matching
  // ticket_type_id blocks just that one. Keyed on the submitter's Steam id.
  const blacklistRes = await pool.query(
    `SELECT 1 FROM ticket_blacklist
     WHERE org_id = $1 AND steam_id = $2
       AND (ticket_type_id IS NULL OR ticket_type_id = $3)
     LIMIT 1`,
    [orgId, session.steamId, ticketTypeId],
  );
  if (blacklistRes.rows[0])
    return json(
      { error: "You have been blocked from submitting this type of ticket." },
      403,
    );

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
      "SELECT ticket_type_id, ticket_type_name, max_open_per_user FROM ticket_types WHERE ticket_type_id = $1 AND org_id = $2 LIMIT 1",
      [ticketTypeId, orgId],
    );
    if (!typeRes.rows[0])
      return json(
        { error: "Ticket type not found for this organization" },
        400,
      );

    // Per-user cap on simultaneously open tickets of this type.
    const maxOpen =
      typeRes.rows[0].max_open_per_user != null
        ? Number(typeRes.rows[0].max_open_per_user)
        : null;
    if (maxOpen !== null) {
      const openRes = await pool.query(
        `SELECT COUNT(*) AS n FROM tickets
         WHERE org_id = $1 AND ticket_type_id = $2 AND created_by = $3
           AND status != 'closed'`,
        [orgId, ticketTypeId, session.userId],
      );
      if (Number(openRes.rows[0].n) >= maxOpen) {
        const typeName = String(typeRes.rows[0].ticket_type_name);
        return json(
          {
            error:
              maxOpen === 1
                ? `You already have an open "${typeName}" ticket. Please wait for it to be resolved before opening another.`
                : `You already have ${maxOpen} open "${typeName}" tickets. Please wait for one to be resolved before opening another.`,
          },
          409,
        );
      }
    }
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
      `INSERT INTO tickets (org_id, ticket_type_id, created_by, title, reported_players, form_data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ticket_id`,
      [
        orgId,
        ticketTypeId,
        session.userId,
        title,
        reportedPlayers,
        JSON.stringify(fields),
      ],
    );
    ticketId = Number(result.rows[0].ticket_id);
    if (message) {
      await txClient.query(
        `INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES ($1, $2, $3)`,
        [ticketId, session.userId, message],
      );
    }
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

// Role-based ticket-type restriction: when the caller's role is explicitly
// assigned ticket types, tickets of other types are off limits. Callers that
// pass the admin/owner/global gates never reach this check.
async function ticketTypeRestricted(session, ticket) {
  if (ticket.ticket_type_id === null) return false;
  const typeRes = await pool.query(
    `SELECT 1 FROM organization_members om
     JOIN ticket_type_roles ttr ON ttr.role_id = om.role_id
     WHERE om.org_id = $1 AND om.user_id = $2
     LIMIT 1`,
    [ticket.org_id, session.userId],
  );
  if (typeRes.rows.length === 0) return false;
  const allowed = await pool.query(
    `SELECT 1 FROM organization_members om
     JOIN ticket_type_roles ttr ON ttr.role_id = om.role_id
     WHERE om.org_id = $1 AND om.user_id = $2 AND ttr.ticket_type_id = $3
     LIMIT 1`,
    [ticket.org_id, session.userId, ticket.ticket_type_id],
  );
  return !allowed.rows[0];
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

      if (await ticketTypeRestricted(session, ticket))
        return json({ error: "Forbidden" }, 403);
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
      entry = { controller, isStaff, userId: session.userId };
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

      if (await ticketTypeRestricted(session, ticket))
        return json({ error: "Forbidden" }, 403);
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
            ? { ...m, username: null, steamId: null, discordAvatarUrl: null }
            : m,
        );

  // Include all linked steam accounts for the submitter so staff can see them
  let submitterSteamAccounts = [];
  if (ticket.created_by && isViewerStaff) {
    const acctRes = await pool
      .query(
        `SELECT usa.steam_id, usa.steam_name, usa.is_primary,
              pc.display_name AS cached_name, pc.avatar_url AS cached_avatar
       FROM user_steam_accounts usa
       LEFT JOIN player_cache pc ON pc.steam_id = usa.steam_id
       WHERE usa.user_id = $1
       ORDER BY usa.is_primary DESC, usa.created_at ASC`,
        [ticket.created_by],
      )
      .catch(() => ({ rows: [] }));
    submitterSteamAccounts = acctRes.rows.map((r) => ({
      steamId: r.steam_id,
      steamName: r.cached_name ?? r.steam_name ?? null,
      avatarUrl: r.cached_avatar ?? null,
      isPrimary: Boolean(r.is_primary),
    }));
  }

  return json({
    ticket,
    messages: returnedMessages,
    media,
    submitterSteamAccounts,
  });
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
      const [playerData, orgBansRes, f7ReportsRes] = await Promise.all([
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
        pool.query(
          `SELECT pr.id, pr.report_type, pr.report_reason, pr.report_description,
                  pr.reporter_name, pr.reporter_steam_id, pr.server_name, pr.created_at
           FROM player_reports pr
           JOIN servers s ON s.server_id = pr.server_id
           WHERE s.owner_org_id = $1 AND pr.reported_steam_id = $2
           ORDER BY pr.created_at DESC
           LIMIT 50`,
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

      const f7Reports = f7ReportsRes.rows.map((r) => ({
        id: String(r.id),
        reportType: String(r.report_type),
        reportReason: String(r.report_reason),
        reportDescription: String(r.report_description),
        reporterName: String(r.reporter_name),
        reporterSteamId: String(r.reporter_steam_id),
        serverName: String(r.server_name),
        createdAt: Number(r.created_at),
      }));

      if (!playerData) {
        return { steamId, fetching: true, orgBans, f7Reports };
      }
      return {
        ...filterPlayerIpData(playerData, canSeeIp),
        orgBans,
        f7Reports,
      };
    }),
  );

  return json({ players });
}

// Pairwise relationship intel between a ticket's reported players: Steam
// friendship, overlapping play sessions on the org's servers, and kills
// between the pair. Powers the "Relationships" panel for teaming-style
// multi-player reports. Same gate as the player-intel panel.
async function handleGetTicketRelationships(request, ticketIdStr) {
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

  if (
    !isGlobalAdmin(session) &&
    !canManageOrg(session, ticket.org_id) &&
    !orgHasPermission(session, ticket.org_id, "tickets_player_intel")
  ) {
    return json(
      { error: "Forbidden: tickets_player_intel permission required" },
      403,
    );
  }

  const rl = await checkRateLimit(`rl:ticket-rel:${session.userId}`, 60, 60);
  if (rl) return rl;

  // Cap the pairwise fan-out: 6 players = 15 pairs.
  const steamIds = [...new Set(ticket.reported_players ?? [])].slice(0, 6);
  if (steamIds.length < 2) return json({ players: [], pairs: [] });

  const nowUnix = Math.floor(Date.now() / 1000);

  const [cacheRes, aliasRes, friendsRes, metaRes] = await Promise.all([
    pool.query(
      `SELECT steam_id, display_name, avatar_url FROM player_cache WHERE steam_id = ANY($1)`,
      [steamIds],
    ),
    // Known in-game names, used to match pvp_log rows that predate the
    // victim_steam_id column (older plugins only report victim_name).
    pool.query(
      `SELECT DISTINCT steam_id, player_name FROM server_player_sessions
       WHERE org_id = $1 AND steam_id = ANY($2) AND player_name IS NOT NULL`,
      [ticket.org_id, steamIds],
    ),
    pool.query(
      `SELECT steam_id, friend_steam_id, first_seen FROM player_friends
       WHERE steam_id = ANY($1) AND friend_steam_id = ANY($1)`,
      [steamIds],
    ),
    pool.query(
      `SELECT steam_id, friends_public FROM player_friends_meta WHERE steam_id = ANY($1)`,
      [steamIds],
    ),
  ]);

  const names = new Map(steamIds.map((sid) => [sid, new Set()]));
  const playerInfo = new Map();
  for (const row of cacheRes.rows) {
    const sid = String(row.steam_id);
    playerInfo.set(sid, {
      displayName: row.display_name ?? null,
      avatarUrl: row.avatar_url ?? null,
    });
    if (row.display_name) names.get(sid)?.add(String(row.display_name));
  }
  for (const row of aliasRes.rows) {
    names.get(String(row.steam_id))?.add(String(row.player_name));
  }

  const friendPairs = new Map();
  for (const row of friendsRes.rows) {
    const key = [String(row.steam_id), String(row.friend_steam_id)]
      .sort()
      .join("|");
    const firstSeen = Number(row.first_seen) || null;
    const existing = friendPairs.get(key);
    if (existing == null || (firstSeen && firstSeen < existing))
      friendPairs.set(key, firstSeen);
  }
  // friends_public tells us whether a "no friendship found" is meaningful:
  // absent row = never fetched, false = private profile — both are "unknown".
  const friendsKnown = new Map(
    metaRes.rows.map((r) => [String(r.steam_id), Boolean(r.friends_public)]),
  );

  const pairs = [];
  for (let i = 0; i < steamIds.length; i++) {
    for (let j = i + 1; j < steamIds.length; j++) {
      pairs.push([steamIds[i], steamIds[j]]);
    }
  }

  const results = await Promise.all(
    pairs.map(async ([a, b]) => {
      const aNames = [...(names.get(a) ?? [])].slice(0, 25);
      const bNames = [...(names.get(b) ?? [])].slice(0, 25);

      const [sessionsRes, killsRes] = await Promise.all([
        // Only count shared sessions on external servers (player_session_windows
        // is populated from BM API data, so it never includes the org's own
        // plugin-tracked servers). Own-server co-presence is expected for any
        // report filed on those servers and is not meaningful teaming evidence.
        pool.query(
          `SELECT w1.bm_server_id AS server_id,
                  COALESCE(bs.server_name, w1.bm_server_id) AS server_name,
                  COUNT(*)::int AS overlap_count,
                  COALESCE(SUM(
                    LEAST(COALESCE(w1.stopped_at, $3), COALESCE(w2.stopped_at, $3)) -
                    GREATEST(w1.started_at, w2.started_at)
                  ), 0)::bigint AS overlap_seconds,
                  MAX(LEAST(COALESCE(w1.stopped_at, $3), COALESCE(w2.stopped_at, $3))) AS last_together
           FROM player_session_windows w1
           JOIN player_session_windows w2
             ON w2.bm_server_id = w1.bm_server_id
            AND w2.steam_id = $2
            AND w1.started_at < COALESCE(w2.stopped_at, $3)
            AND w2.started_at < COALESCE(w1.stopped_at, $3)
           LEFT JOIN player_bm_sessions bs
             ON bs.steam_id = $1 AND bs.bm_server_id = w1.bm_server_id
           WHERE w1.steam_id = $1
           GROUP BY w1.bm_server_id, bs.server_name
           ORDER BY overlap_seconds DESC`,
          [a, b, nowUnix],
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE p.killer_steam_id = $2)::int AS a_to_b,
             COUNT(*) FILTER (WHERE p.killer_steam_id = $3)::int AS b_to_a,
             MAX(p.created_at) AS last_kill
           FROM pvp_log p
           JOIN servers s ON s.server_id = p.server_id
           WHERE s.owner_org_id = $1
             AND (
               (p.killer_steam_id = $2 AND (p.victim_steam_id = $3
                  OR (p.victim_steam_id IS NULL AND p.victim_name = ANY($5::text[]))))
               OR
               (p.killer_steam_id = $3 AND (p.victim_steam_id = $2
                  OR (p.victim_steam_id IS NULL AND p.victim_name = ANY($4::text[]))))
             )`,
          [ticket.org_id, a, b, aNames, bNames],
        ),
      ]);

      const servers = sessionsRes.rows.map((r) => ({
        serverId: String(r.server_id),
        serverName: String(r.server_name),
        count: Number(r.overlap_count),
        seconds: Number(r.overlap_seconds),
      }));
      const sharedSessions = {
        count: servers.reduce((n, s) => n + s.count, 0),
        totalSeconds: servers.reduce((n, s) => n + s.seconds, 0),
        lastTogether: sessionsRes.rows.length
          ? Math.max(...sessionsRes.rows.map((r) => Number(r.last_together)))
          : null,
        servers,
      };

      const pairKey = [a, b].sort().join("|");
      const areFriends = friendPairs.has(pairKey);
      const friendsUnknown =
        !areFriends && (!friendsKnown.get(a) || !friendsKnown.get(b));

      const killRow = killsRes.rows[0] ?? {};
      return {
        steamIds: [a, b],
        friends: areFriends ? true : friendsUnknown ? null : false,
        friendsSince: areFriends ? (friendPairs.get(pairKey) ?? null) : null,
        sharedSessions,
        kills: {
          aToB: Number(killRow.a_to_b ?? 0),
          bToA: Number(killRow.b_to_a ?? 0),
          lastKillAt: killRow.last_kill ? Number(killRow.last_kill) : null,
        },
      };
    }),
  );

  return json({
    players: steamIds.map((sid) => ({
      steamId: sid,
      displayName: playerInfo.get(sid)?.displayName ?? null,
      avatarUrl: playerInfo.get(sid)?.avatarUrl ?? null,
    })),
    pairs: results,
  });
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

  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(message))
    return json({ error: "Messages cannot contain raw IP addresses." }, 400);

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

  // Type-restricted staff can only post to tickets of their assigned types
  // (same restriction handleGetTicket applies to viewing).
  if (
    !isCreator &&
    !isGlobalAdmin(session) &&
    !canManageOrg(session, ticket.org_id) &&
    (await ticketTypeRestricted(session, ticket))
  ) {
    return json({ error: "Forbidden" }, 403);
  }

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

  // DM the ticket creator when staff reply (non-internal) and they opted in
  if (
    isStaff &&
    !isCreator &&
    !isInternal &&
    ticket.dm_notifications_enabled &&
    ticket.created_by_discord_id
  ) {
    const cooldownKey = `ticket:dm:cd:${id}`;
    const onCooldown = await redis.get(cooldownKey).catch(() => null);
    if (!onCooldown) {
      const ticketUrl = `${env.appUrl}/my-reports?ticket=${id}`;
      const dmMsg = `💬 **New reply on your ticket** — ${ticket.title}\n${ticketUrl}`;
      sendDiscordDm(ticket.created_by_discord_id, dmMsg).catch(() => {});
      redis.set(cooldownKey, "1", "EX", 900).catch(() => {});
    }
  }

  return json({ ok: true });
}

async function handleToggleTicketDmNotifications(request, ticketIdStr) {
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

  const enabled = Boolean(body?.enabled);

  const ticket = await loadTicketFromDb(id);
  if (!ticket) return json({ error: "Ticket not found" }, 404);

  if (ticket.created_by !== session.userId)
    return json({ error: "Forbidden" }, 403);

  await pool.query(
    `UPDATE tickets SET dm_notifications_enabled = $1 WHERE ticket_id = $2`,
    [enabled, id],
  );
  await invalidateTicketCache(id);

  if (!enabled) return json({ ok: true });

  const discordId = session.discordId;
  if (!discordId) return json({ ok: true, dmStatus: "no_discord" });

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [ticket.org_id],
  );
  const guildId = orgRes.rows[0]?.guild_id ?? null;

  const [inGuild, dmResult] = await Promise.all([
    guildId
      ? checkGuildMembership(guildId, discordId)
      : Promise.resolve(false),
    sendDiscordDmWithResult(
      discordId,
      `✅ **IronSight ticket notifications enabled** — You'll receive a DM when staff reply to your ticket: **${ticket.title}**`,
    ),
  ]);

  let inviteUrl = null;
  if (!inGuild && guildId) {
    inviteUrl = await createGuildInvite(guildId);
  }

  return json({ ok: true, dmStatus: dmResult.reason, inGuild, inviteUrl });
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
    if (
      !canManageOrg(session, ticket.org_id) &&
      (await ticketTypeRestricted(session, ticket))
    ) {
      return json({ error: "Forbidden" }, 403);
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const status = body?.status == null ? null : String(body.status).trim();
  const hasAssigned = Object.prototype.hasOwnProperty.call(
    body ?? {},
    "assignedTo",
  );
  const assignedTo = hasAssigned
    ? body.assignedTo == null
      ? null
      : String(body.assignedTo)
    : undefined;

  if (
    status !== null &&
    !["open", "waiting_response", "closed"].includes(status)
  ) {
    return json({ error: "Invalid status" }, 400);
  }

  // An assignee must belong to the ticket's org. Global admins may still
  // self-claim tickets in orgs they are not a member of.
  if (assignedTo != null && assignedTo !== session.userId) {
    const memberRes = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
      [ticket.org_id, assignedTo],
    );
    if (!memberRes.rows[0]) {
      return json(
        { error: "assignedTo must be a member of this organization" },
        400,
      );
    }
  }

  const setClauses = ["updated_at = unix_now()"];
  const values = [];
  let idx = 1;

  if (status !== null) {
    setClauses.push(`status = $${idx++}`);
    values.push(status);
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
    [id, session.userId, "updated", JSON.stringify({ status, assignedTo })],
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
            assigned_to: updated.assigned_to,
            assigned_to_username: updated.assigned_to_username,
          },
        }),
      )
      .catch(() => {});
  }

  return json({ ok: true });
}

async function handleDeleteTicket(request, ticketIdStr) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isConfiguredSysAdmin(session)) return json({ error: "Forbidden" }, 403);

  const id = Number(ticketIdStr);
  if (!Number.isInteger(id) || id <= 0)
    return json({ error: "Invalid ticket ID" }, 400);

  const ticket = await loadTicketFromDb(id);
  if (!ticket) return json({ error: "Ticket not found" }, 404);

  // Soft-delete any evidence linked to this ticket so it gets purged. Media is
  // associated via the ticket_media_links join table, not a column on org_media.
  await pool.query(
    `UPDATE org_media SET deleted = TRUE
     WHERE deleted = FALSE
       AND media_id IN (SELECT media_id FROM ticket_media_links WHERE ticket_id = $1)`,
    [id],
  );
  // Cascades remove ticket_media_links, ticket_messages and ticket_audit_log rows.
  await pool.query(`DELETE FROM tickets WHERE ticket_id = $1`, [id]);

  await invalidateTicketCache(id);

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
            t.status, t.category, t.title,
            t.created_at,
            t.updated_at,
            t.closed_at,
            tt.ticket_type_name,
            tt.ticket_type_category,
            creator.username AS created_by_username, creator.steam_id AS created_by_steam_id,
            creator.discord_id AS created_by_discord_id,
            assignee.username AS assigned_to_username,
            (SELECT tm.created_at FROM ticket_messages tm
             WHERE tm.ticket_id = t.ticket_id AND tm.user_id IS NOT NULL
             ORDER BY tm.created_at DESC LIMIT 1) AS last_staff_reply_at,
            (SELECT u.username FROM ticket_messages tm
             JOIN users u ON u.user_id = tm.user_id
             WHERE tm.ticket_id = t.ticket_id AND tm.user_id IS NOT NULL
             ORDER BY tm.created_at DESC LIMIT 1) AS last_staff_reply_username
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
      category: row.category ?? null,
      created_by: row.created_by ? String(row.created_by) : null,
      created_by_username: row.created_by_username ?? null,
      created_by_steam_id: row.created_by_steam_id ?? null,
      created_by_discord_id:
        row.created_by_discord_id == null
          ? null
          : String(row.created_by_discord_id),
      assigned_to: row.assigned_to ? String(row.assigned_to) : null,
      assigned_to_username: row.assigned_to_username ?? null,
      status: String(row.status),
      title: String(row.title),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      closed_at: row.closed_at ? Number(row.closed_at) : null,
      last_staff_reply_at: row.last_staff_reply_at
        ? Number(row.last_staff_reply_at)
        : null,
      last_staff_reply_username: row.last_staff_reply_username ?? null,
    })),
  });
}

async function handleCreateCase(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !isGlobalAdmin(session) &&
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "cases_create")
  )
    return json({ error: "Forbidden" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const steamId = String(body?.steamId ?? "").trim();
  const title = String(body?.title ?? "").trim();
  const note = String(body?.note ?? "").trim();

  if (!steamId || !title)
    return json({ error: "steamId and title are required" }, 400);
  if (!/^\d{17}$/.test(steamId))
    return json({ error: "Invalid Steam ID" }, 400);
  if (title.length > 255)
    return json({ error: "title must be 255 characters or fewer" }, 400);
  if (note.length > 10000) return json({ error: "note is too long" }, 400);

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  // Check for an existing open ticket with this player in this org
  const openRes = await pool.query(
    `SELECT ticket_id FROM tickets WHERE org_id = $1 AND $2 = ANY(reported_players) AND status != 'closed' LIMIT 1`,
    [orgId, steamId],
  );
  if (openRes.rows[0])
    return json(
      { error: "An open ticket already exists for this player in this org." },
      409,
    );

  // Pick the best player-report ticket type for this org
  const typeRes = await pool.query(
    `SELECT ticket_type_id FROM ticket_types
     WHERE org_id = $1 AND is_enabled IS NOT FALSE
     ORDER BY
       (LOWER(ticket_type_name) LIKE '%report%') DESC,
       (LOWER(ticket_type_name) = 'cheating') DESC,
       (ticket_type_category = 'player_single') DESC,
       (ticket_type_category = 'player_multi') DESC,
       ticket_type_id ASC
     LIMIT 1`,
    [orgId],
  );
  const ticketTypeId = typeRes.rows[0]?.ticket_type_id ?? null;

  const txClient = await pool.connect();
  let ticketId;
  try {
    await txClient.query("BEGIN");
    const ins = await txClient.query(
      `INSERT INTO tickets (org_id, ticket_type_id, created_by, status, category, title, reported_players)
       VALUES ($1, $2, $3, 'open', 'staff_case', $4, $5) RETURNING ticket_id`,
      [orgId, ticketTypeId, session.userId, title, [steamId]],
    );
    ticketId = Number(ins.rows[0].ticket_id);

    if (note) {
      await txClient.query(
        `INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal) VALUES ($1, $2, $3, TRUE)`,
        [ticketId, session.userId, note],
      );
    }

    await txClient.query(
      `INSERT INTO ticket_audit_log (ticket_id, user_id, action, details) VALUES ($1, $2, 'created', $3)`,
      [
        ticketId,
        session.userId,
        JSON.stringify({ category: "staff_case", steamId, orgId }),
      ],
    );
    await txClient.query("COMMIT");
  } catch (err) {
    await txClient.query("ROLLBACK");
    throw err;
  } finally {
    txClient.release();
  }

  const ticket = await loadTicketFromDb(ticketId);
  if (ticket) await cacheTicket(ticket);

  return json({ ok: true, ticketId }, 201);
}

async function handleCheckPlayerOpenTicket(request, orgId, steamIdParam) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !isGlobalAdmin(session) &&
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "cases_create") &&
    !orgHasPermission(session, orgId, "tickets_view") &&
    !orgHasPermission(session, orgId, "tickets_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const steamId = decodeURIComponent(String(steamIdParam ?? "")).trim();
  if (!/^\d{17}$/.test(steamId))
    return json({ error: "Invalid Steam ID" }, 400);

  const { rows } = await pool.query(
    `SELECT ticket_id FROM tickets WHERE org_id = $1 AND $2 = ANY(reported_players) AND status != 'closed' LIMIT 1`,
    [orgId, steamId],
  );

  return json({ hasOpenTicket: rows.length > 0 });
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
            t.status, t.title,
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
      title: String(row.title),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      closed_at: row.closed_at ? Number(row.closed_at) : null,
    })),
  });
}

async function handleSubmitTicketFeedback(request, ticketIdStr) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const ticketId = parseInt(ticketIdStr, 10);
  if (!ticketId) return json({ error: "Invalid ticket ID" }, 400);

  const body = await request.json().catch(() => null);
  const rating = body?.rating;
  const comment =
    typeof body?.comment === "string"
      ? body.comment.trim().slice(0, 2000)
      : null;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5)
    return json({ error: "rating must be an integer 1–5" }, 400);

  // Verify the ticket belongs to this session user.
  const { rows: ticketRows } = await pool.query(
    `SELECT ticket_id, org_id FROM tickets WHERE ticket_id = $1 AND created_by = $2`,
    [ticketId, session.userId],
  );
  if (ticketRows.length === 0)
    return json({ error: "Ticket not found or not yours" }, 404);

  const orgId = ticketRows[0].org_id;

  try {
    await pool.query(
      `INSERT INTO ticket_feedback (ticket_id, org_id, steam_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)`,
      [ticketId, orgId, session.steamId ?? null, rating, comment || null],
    );
  } catch (err) {
    if (err.code === "23505")
      return json({ error: "Feedback already submitted for this ticket" }, 409);
    throw err;
  }

  return json({ ok: true });
}

async function handleSysListFeedback(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isConfiguredSysAdmin(session))
    return json({ error: "Forbidden: sysadmin only" }, 403);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = 50;
  const offset = (page - 1) * limit;

  const { rows } = await pool.query(
    `SELECT f.feedback_id, f.ticket_id, f.org_id, f.steam_id, f.rating, f.comment, f.created_at,
            o.name AS org_name
     FROM ticket_feedback f
     LEFT JOIN organizations o ON o.org_id = f.org_id
     ORDER BY f.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS total FROM ticket_feedback`,
  );

  return json({
    feedback: rows.map((r) => ({
      feedbackId: Number(r.feedback_id),
      ticketId: Number(r.ticket_id),
      orgId: String(r.org_id),
      orgName: r.org_name ?? r.org_id,
      steamId: r.steam_id ?? null,
      rating: Number(r.rating),
      comment: r.comment ?? null,
      createdAt: Number(r.created_at),
    })),
    total: Number(countRows[0].total),
    page,
    limit,
  });
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

  // scripts_manage implies scripts_view — the panel UI surfaces the Scripts tab
  // (and its script picker) to holders of either permission, so listing must too.
  if (
    !orgHasPermission(session, orgId, "scripts_view") &&
    !orgHasPermission(session, orgId, "scripts_manage")
  ) {
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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "script",
    resourceId: String(row.script_id),
    actionType: "SCRIPT_CREATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { name, command, description, minRank },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "script",
    resourceId: String(scriptId),
    actionType: "SCRIPT_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: {
      updatedFields: Object.keys(body).filter((k) =>
        ["name", "command", "description", "minRank"].includes(k),
      ),
    },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "script",
    resourceId: String(scriptId),
    actionType: "SCRIPT_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { scriptId },
  });

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
  let connectionErr = null;
  for (const cmd of cmds) {
    if (connectionErr) {
      outputs.push({ cmd, ok: false, response: connectionErr });
      continue;
    }
    let rconResult = null;
    let rconErr = null;
    try {
      rconResult = await executeRconCommand(rconUrl, cmd);
    } catch (err) {
      rconErr = String(err?.message ?? err);
      if (/connection failed|timed out|network error/i.test(rconErr)) {
        connectionErr = rconErr;
      }
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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "predefine",
    resourceId: String(rows[0].predefine_id),
    actionType: "PREDEFINE_CREATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { keyword },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "predefine",
    resourceId: String(predefineId),
    actionType: "PREDEFINE_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { predefineId },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "predefine",
    resourceId: String(predefineId),
    actionType: "PREDEFINE_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { predefineId },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "toxicity_config",
    actionType: "TOXICITY_CONFIG_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { updatedKind: column ?? "full" },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ai_moderation_trigger",
    resourceId: String(r.trigger_id),
    actionType: "AI_TRIGGER_CREATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { category, threshold, action },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ai_moderation_trigger",
    resourceId: String(triggerId),
    actionType: "AI_TRIGGER_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: {
      triggerId,
      updatedFields: Object.keys(body).filter((k) =>
        ["threshold", "action", "muteDurationMinutes", "enabled"].includes(k),
      ),
    },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ai_moderation_trigger",
    resourceId: String(triggerId),
    actionType: "AI_TRIGGER_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { triggerId },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ban_reason",
    resourceId: String(rows[0].reason_id),
    actionType: "BAN_REASON_CREATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { category, label },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ban_reason",
    resourceId: String(reasonId),
    actionType: "BAN_REASON_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { label },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ban_reason",
    resourceId: String(reasonId),
    actionType: "BAN_REASON_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { reasonId },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "ban_note_format",
    actionType: "BAN_NOTE_FORMAT_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { category },
  });

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
      `SELECT plugin_id, name, file_name, source, umod_slug, installed_version, latest_version,
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
        fileName: r.file_name ?? null,
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

  // Optional explicit .cs file name (without extension). Must be a safe plugin
  // file name so it can be interpolated into RCON commands / Pterodactyl paths.
  let fileName = null;
  if (body?.fileName != null && String(body.fileName).trim() !== "") {
    fileName = safePluginName(String(body.fileName).replace(/\.cs$/i, ""));
    if (!fileName) return json({ error: "Invalid fileName" }, 400);
  }

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
       (org_id, name, file_name, source, umod_slug, installed_version, latest_version,
        latest_updated_at, assigned_tags, risk, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
     ON CONFLICT (org_id, name) DO NOTHING
     RETURNING plugin_id`,
    [
      orgId,
      name,
      fileName,
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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "plugin",
    resourceId: String(rows[0].plugin_id),
    actionType: "PLUGIN_CREATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { name, source },
  });

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
  if (body?.fileName !== undefined) {
    // Empty string clears the override (fall back to display name); otherwise
    // it must be a safe plugin file name.
    const raw = String(body.fileName ?? "").trim();
    let fileName = null;
    if (raw !== "") {
      fileName = safePluginName(raw.replace(/\.cs$/i, ""));
      if (!fileName) return json({ error: "Invalid fileName" }, 400);
    }
    params.push(fileName);
    setClauses.push(`file_name = $${params.length}`);
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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "plugin",
    resourceId: String(pluginId),
    actionType: "PLUGIN_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { updatedFields: setClauses.map((c) => c.split(" = ")[0]) },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "plugin",
    resourceId: String(pluginId),
    actionType: "PLUGIN_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { pluginId },
  });

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
    `SELECT name, file_name, assigned_tags, latest_version FROM org_plugins
     WHERE plugin_id = $1 AND org_id = $2`,
    [pluginId, orgId],
  );
  if (!pluginRes.rows[0]) return json({ error: "Plugin not found" }, 404);

  const { name, file_name, assigned_tags, latest_version } = pluginRes.rows[0];
  // oxide.reload/unload target the plugin's file name; fall back to the display
  // name when no explicit file name is set. Strip control chars before
  // interpolating into the RCON console command.
  const safeName = String(file_name || name).replace(/[\r\n\x00-\x1f]/g, "");
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
    `SELECT plugin_id, name, file_name, assigned_tags FROM org_plugins
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
              `oxide.unload ${String(p.file_name || p.name).replace(/[\r\n\x00-\x1f]/g, "")}`,
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

// Reconcile each registry plugin's installed_version with the REAL version of
// its matching .cs file on the org's Pterodactyl servers, so the registry
// reflects what's actually deployed rather than a manually-entered guess.
// Matching is by file name (the same key `oxide.reload`/upload use), normalized
// to be case/punctuation-insensitive. When servers disagree on a version, every
// distinct value is recorded ("2.1.3 / 2.1.0") so the mismatch surfaces as
// outdated. Only plugins actually found on a server are touched — custom or
// not-yet-deployed rows keep their existing value. Returns the number of
// registry rows whose installed_version changed. Best-effort: unreachable
// servers/files are skipped.
async function syncInstalledPluginVersions(orgId) {
  if (getPterodactylSecurityConfigError()) return 0;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch {
    return 0;
  }
  if (!credentials) return 0;
  const { panelUrl, apiKey } = credentials;

  const { rows: plugins } = await pool.query(
    `SELECT plugin_id, name, file_name FROM org_plugins WHERE org_id = $1`,
    [orgId],
  );
  if (plugins.length === 0) return 0;

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  // Key each plugin by its explicit file name when set (the authoritative match),
  // otherwise fall back to its display name. An explicit file_name wins if both a
  // named-only and a file-named plugin would collide on the same normalized key.
  const byNorm = new Map(); // normalized file/display name -> plugin_id
  for (const p of plugins) {
    if (!p.file_name) byNorm.set(norm(p.name), p.plugin_id);
  }
  for (const p of plugins) {
    if (p.file_name) byNorm.set(norm(p.file_name), p.plugin_id);
  }

  const { rows: servers } = await pool.query(
    `SELECT ptero_identifier FROM servers
     WHERE owner_org_id = $1 AND ptero_identifier IS NOT NULL`,
    [orgId],
  );
  if (servers.length === 0) return 0;

  const detected = new Map(); // plugin_id -> Set<version string>

  await Promise.allSettled(
    servers.map(async (s) => {
      let files;
      try {
        files = await fetchPteroFileList(
          panelUrl,
          apiKey,
          s.ptero_identifier,
          "/oxide/plugins",
        );
      } catch {
        return;
      }
      const csFiles = files.filter(
        (f) => f.is_file && f.name.toLowerCase().endsWith(".cs"),
      );
      await Promise.allSettled(
        csFiles.map(async (f) => {
          // Match on file name first so we only read .cs files that map to a
          // registry entry, keeping the number of file reads bounded.
          const fileName = f.name.replace(/\.cs$/i, "");
          const pluginId = byNorm.get(norm(fileName));
          if (!pluginId) return;
          let meta;
          try {
            const src = await fetchPteroFileContents(
              panelUrl,
              apiKey,
              s.ptero_identifier,
              `/oxide/plugins/${f.name}`,
            );
            meta = parseOxidePluginMeta(src);
          } catch {
            return;
          }
          if (!meta?.version) return;
          if (!detected.has(pluginId)) detected.set(pluginId, new Set());
          detected.get(pluginId).add(String(meta.version));
        }),
      );
    }),
  );

  let synced = 0;
  await Promise.allSettled(
    [...detected.entries()].map(async ([pluginId, versions]) => {
      const value = [...versions].sort().join(" / ");
      const res = await pool.query(
        `UPDATE org_plugins SET installed_version = $2
         WHERE plugin_id = $1 AND org_id = $3
           AND installed_version IS DISTINCT FROM $2`,
        [pluginId, value, orgId],
      );
      if (res.rowCount > 0) synced += 1;
    }),
  );
  return synced;
}

// Refresh version state for an org's plugins: pull the latest published version
// for umod-sourced plugins (scraping their umod pages), then reconcile every
// plugin's installed version against the real .cs files on the org's servers.
// Custom-uploaded plugins have no upstream latest to check but are still synced
// for installed version. Best-effort: individual failures are ignored.
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

  // Reconcile installed versions with what's actually running on the servers.
  let installedSynced = 0;
  try {
    installedSynced = await syncInstalledPluginVersions(orgId);
  } catch {
    // Pterodactyl may be unconfigured/unreachable — latest-version refresh
    // still succeeds on its own.
  }

  return json({ ok: true, checked: rows.length, updated, installedSynced });
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

// Resolve a Steam group vanity/URL/GID into { gid, label, vanity } so the
// bought-account group rule can store the stable GID. Gated on triggers_manage.
async function handleResolveSteamGroup(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "triggers_manage")) {
    return json(
      { error: "Forbidden: triggers_manage permission required" },
      403,
    );
  }

  const rl = await checkRateLimit(`rl:group-resolve:${session.userId}`, 30, 60);
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const input = String(body?.input ?? "").trim();
  if (!input) return json({ error: "input required" }, 400);
  if (input.length > 200) return json({ error: "input too long" }, 400);

  const info = await resolveSteamGroupInfo(input);
  if (!info) return json({ error: "Could not resolve Steam group" }, 404);
  return json(info);
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

// ── BM ban feed ───────────────────────────────────────────────────────────────

async function handleGetBmBanFeed(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canAccessBans(session, orgId))
    return json({ error: "Forbidden: ban permission required" }, 403);

  const orgRes = await pool.query(
    "SELECT bm_org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  const bmOrgId = orgRes.rows[0]?.bm_org_id;
  if (!bmOrgId) return json({ bans: [], noBmOrg: true });

  let data;
  try {
    const url = new URL(request.url);
    const pageSize = Math.min(
      50,
      Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10)),
    );
    const res = await bmFetch(
      orgId,
      `https://api.battlemetrics.com/bans?filter[organization]=${encodeURIComponent(bmOrgId)}&sort=-timestamp&include=player&page[size]=${pageSize}`,
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

  const playerNames = {};
  const playerSteamIds = {};
  for (const item of data?.included ?? []) {
    if (item.type === "player") {
      playerNames[item.id] = item.attributes?.name ?? null;
      const uid = item.attributes?.uid ?? null;
      if (uid && /^\d{17}$/.test(uid)) playerSteamIds[item.id] = uid;
    }
  }

  const bans = (data?.data ?? []).map((ban) => {
    const attrs = ban.attributes ?? {};
    const playerId = ban.relationships?.player?.data?.id ?? null;
    const rawReason = String(attrs.reason ?? "");
    const reason = rawReason.split("|")[0].trim();
    const note = String(attrs.note ?? "")
      .replace(/<[^>]+>/g, "")
      .trim();
    return {
      bmBanId: String(ban.id),
      playerId: playerId ? String(playerId) : null,
      playerName: playerId ? (playerNames[playerId] ?? null) : null,
      steamId: playerId ? (playerSteamIds[playerId] ?? null) : null,
      uid: attrs.uid ?? null,
      reason,
      note: note || null,
      bannedAt: attrs.timestamp
        ? Math.floor(new Date(attrs.timestamp).getTime() / 1000)
        : null,
      expiresAt: attrs.expires
        ? Math.floor(new Date(attrs.expires).getTime() / 1000)
        : null,
      permanent: !attrs.expires,
    };
  });

  return json({ bans });
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

  // Per-target 30-second cooldown to prevent duplicate ban/mutes when multiple
  // staff members act on the same player at the same time.
  const targetCd = await checkRateLimit(
    `rl:ban-cd:${orgId}:${actionType}:${rawIdentifier}`,
    1,
    30,
  );
  if (targetCd)
    return json(
      {
        error:
          "A recent ban/mute for this target is still processing. Please wait 30 seconds before issuing another.",
      },
      429,
    );

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
      // Org-scoped and confirmed only. Source is intentionally unrestricted so
      // both staff-gallery items and user-submitted ticket evidence can be
      // attached; unconfirmed/abandoned uploads are excluded.
      const validMedia = await pool.query(
        `SELECT media_id FROM org_media WHERE media_id = ANY($1::uuid[]) AND org_id = $2 AND deleted = FALSE AND confirmed = TRUE`,
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
        command = `ban ${safeId} "${safeReason} | Appeal: help.archipel.gg"`;
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

  // Auto-close open tickets that reported this player when a ban is issued.
  if (identifierType === "steam_id" && actionType !== "mute") {
    const openTickets = await pool.query(
      `UPDATE tickets SET status = 'closed', closed_at = unix_now(), updated_at = unix_now()
       WHERE org_id = $1 AND $2 = ANY(reported_players) AND status != 'closed'
       RETURNING ticket_id`,
      [orgId, rawIdentifier],
    );
    for (const row of openTickets.rows) {
      await pool.query(
        `INSERT INTO ticket_audit_log (ticket_id, user_id, action, details) VALUES ($1, $2, 'updated', $3)`,
        [
          row.ticket_id,
          session.userId,
          JSON.stringify({ status: "closed", reason: "ban_issued", banId }),
        ],
      );
    }
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

async function handleGetBanAuditLog(request, orgId, banId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canAccessBans(session, orgId)) return json({ error: "Forbidden" }, 403);

  const banCheck = await pool.query(
    `SELECT ban_id FROM player_bans WHERE ban_id = $1 AND org_id = $2`,
    [banId, orgId],
  );
  if (!banCheck.rows[0]) return json({ error: "Ban not found" }, 404);

  const { rows } = await pool.query(
    `SELECT al.id, al.action_type, al.metadata, al.created_at,
            u.username AS actor_name
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.actor_user_id
     WHERE al.org_id = $1 AND al.resource_id = $2
     ORDER BY al.created_at ASC
     LIMIT 200`,
    [orgId, banId],
  );

  return json({
    logs: rows.map((r) => ({
      id: String(r.id),
      actionType: r.action_type,
      actorName: r.actor_name ?? "Unknown",
      metadata: r.metadata ?? {},
      createdAt: r.created_at ? Number(r.created_at) : null,
    })),
  });
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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "blacklisted_word",
    resourceId: String(r.word_id),
    actionType: "BLACKLISTED_WORD_ADDED",
    actionCategory: "org_management",
    severity: 2,
    metadata: { word },
  });

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

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "blacklisted_word",
    resourceId: String(wordId),
    actionType: "BLACKLISTED_WORD_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { wordId },
  });

  return json({ ok: true });
}

export async function initializeInfra() {
  try {
    await init();
  } catch {
    // startup failures are exposed via API startup guard responses
  }
}

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
        await executeRconCommand(
          rconUrl,
          `ban ${steamId} "${safeReason} | Appeal: help.archipel.gg"`,
        );
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
const PUBLIC_READ_RATE_LIMIT_PER_MINUTE = 60;
const FLAG_RESOLVE_RATE_LIMIT_PER_MINUTE = 60;

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
    // Seed with a millisecond timestamp when the key is missing (fresh Redis,
    // restart, or LRU eviction) before incrementing. A bare INCR would restart
    // the counter at 1, which could collide with a version number that live
    // `share:resolve:<ver>:*` entries were keyed under — serving a stale grant
    // graph for up to the 30s cache TTL. A time-seeded counter can never
    // regress to a previously-used version.
    await redis.set("share:ver", String(Date.now()), "NX");
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

// Display-only bought/botted-account flag for the player-lookup page. Evaluates
// the org's hours, name, and Steam-group rules against the cached player payload.
// Never opens a ticket — that path was removed from evaluateConfig.
async function evalBoughtAccountFlag(orgId, d) {
  try {
    const cfg = await getThreatTriggerConfigOrDefault(orgId);
    const ba = cfg?.boughtAccount;
    if (!ba?.enabled) return false;
    const names = [
      ...(d?.displayName ? [String(d.displayName)] : []),
      ...namesFromAliases(d?.nameAliases),
    ];
    const reasons = evaluateBoughtAccount(ba, {
      steamRustHours: d?.steam?.rustHours ?? null,
      bmRustHours: d?.bm?.rustHours ?? null,
      names,
      steamGroups: Array.isArray(d?.steamGroups) ? d.steamGroups : [],
      steamLevel: d?.steam?.level ?? null,
    });
    return Boolean(reasons);
  } catch {
    return false;
  }
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
    const d = applyShareEntitlement(fromRedis, ipEntitlement, bmEntitlement);
    d.boughtAccountTriggered = await evalBoughtAccountFlag(orgId, d);
    // A refresh pipeline is still running for this player — tell the client so
    // it keeps silently re-polling until the enrichment lands.
    try {
      if ((await redis.exists(playerFetchLockKey(steamId))) === 1)
        d.enriching = true;
    } catch {}
    return json(d);
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

  const d = applyShareEntitlement(cached, ipEntitlement, bmEntitlement);
  d.boughtAccountTriggered = await evalBoughtAccountFlag(orgId, d);
  try {
    if ((await redis.exists(playerFetchLockKey(steamId))) === 1)
      d.enriching = true;
  } catch {}
  return json(d);
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

  // Per-user rate limit: prevent a single staffer from hammering the upstream APIs.
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

  const refreshedKey = playerRefreshedKey(steamId);
  const lockKey = playerFetchLockKey(steamId);

  // Per-player 30-second cooldown: if a full refresh (including proxycheck) was
  // recently completed by any staffer, skip re-fetching and return the fresh
  // cached data. This prevents the panel from hammering upstream APIs when multiple
  // staff members view the same player shortly after a refresh.
  try {
    const recentlyRefreshed = await redis.exists(refreshedKey);
    if (recentlyRefreshed) {
      const cached = await getPlayerDataFromRedis(steamId);
      if (cached) {
        const payload = applyShareEntitlement(
          cached,
          ipEntitlement,
          bmEntitlement,
        );
        payload.boughtAccountTriggered = await evalBoughtAccountFlag(
          orgId,
          payload,
        );
        if (bmRateLimitWarning) payload.bmRateLimitWarning = true;
        return json(payload);
      }
    }
  } catch {
    // Redis unavailable — fall through and attempt a normal refresh
  }

  // If a refresh is already running (lock held by another request), don't delete
  // the existing Redis data — just wait for the in-progress refresh to finish.
  let refreshAlreadyRunning = false;
  try {
    refreshAlreadyRunning = (await redis.exists(lockKey)) === 1;
  } catch {}

  if (!refreshAlreadyRunning) {
    // Clear Redis so the background refresh writes fresh data unconditionally.
    try {
      await redis.del(playerRedisKey(steamId));
    } catch {}

    // Fire the full refresh pipeline (Steam + BM + proxycheck) in the background.
    // Once complete, evaluate threat triggers against the fresh data.
    refreshPlayerData(steamId, orgId, candidateOrgIds, {
      forceProxycheckRefresh: true,
    })
      .then(() => evaluateThreatTriggers(orgId, steamId, "refresh"))
      .catch((err) =>
        console.error(`[player:refresh] bg error for ${steamId}:`, err.message),
      );
  }

  // Poll for pipeline progress. The full refreshedKey (proxycheck / friends /
  // alt-scoring all done) is preferred, but the pipeline writes its CORE data
  // (Steam + BM profile/sessions/bans/IPs) to Redis early and marks it with
  // playerCoreRefreshedKey — return that as soon as it lands (typically 1-3 s)
  // instead of blocking the request on the slow enrichment, which routinely
  // exceeds the 12 s budget (full BM session history alone can be dozens of
  // paginated calls). The response is flagged `enriching: true` so the client
  // silently re-polls via GET to pick up the enrichment once it completes.
  const coreKey = playerCoreRefreshedKey(steamId);
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const done = await redis.exists(refreshedKey);
      const coreDone = done ? 1 : await redis.exists(coreKey);
      if (done || coreDone) {
        const fresh = await getPlayerDataFromRedis(steamId);
        if (fresh) {
          const payload = applyShareEntitlement(
            fresh,
            ipEntitlement,
            bmEntitlement,
          );
          if (!done) payload.enriching = true;
          payload.boughtAccountTriggered = await evalBoughtAccountFlag(
            orgId,
            payload,
          );
          if (bmRateLimitWarning) payload.bmRateLimitWarning = true;
          return json(payload);
        }
      }
    } catch {}
  }

  // Full pipeline not done within 12 s — tell the client to poll via GET.
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

  // Optional free-text search over message bodies. Escape LIKE wildcards so the
  // query stays a literal substring match (still parameterized — this only
  // prevents `%`/`_` in the input from acting as wildcards).
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  // filter=confirmed restricts to messages that have a flag confirmed as toxic
  // (used to pin confirmed-toxic messages above the rest of the history).
  const confirmedOnly = url.searchParams.get("filter") === "confirmed";

  const params = [steamId, scopedOrgIds, limit + 1];
  let idx = 4;
  let extraClauses = "";
  if (before != null) {
    extraClauses += ` AND tcl.created_at < $${idx++}`;
    params.push(before);
  }
  if (q) {
    extraClauses += ` AND tcl.message ILIKE $${idx++} ESCAPE '\\'`;
    params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (confirmedOnly) {
    extraClauses += ` AND EXISTS (
      SELECT 1 FROM ai_chat_flags acf2
      WHERE acf2.chat_log_id = tcl.id
        AND acf2.resolved = TRUE
        AND acf2.resolution_type = 'confirmed'
    )`;
  }

  const { rows } = await pool.query(
    `SELECT tcl.id, tcl.message, tcl.steam_id, tcl.player_name, tcl.team_message,
            tcl.created_at AS ts, s.server_name, s.server_id, tcl.ai_flags,
            (SELECT json_agg(json_build_object(
               'category', acf.triggered_category,
               'score', acf.score,
               'action', acf.action,
               'resolved', acf.resolved,
               'resolutionType', acf.resolution_type
             ))
             FROM ai_chat_flags acf
             WHERE acf.chat_log_id = tcl.id) AS ai_chat_flags
     FROM text_chat_log tcl
     JOIN servers s ON s.server_id = tcl.server_id
     WHERE tcl.steam_id = $1
       AND s.owner_org_id = ANY($2)${extraClauses}
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
    aiFlags: Array.isArray(r.ai_chat_flags) ? r.ai_chat_flags : [],
  }));

  return json({ lines, hasMore });
}

// ── Player PVP feed ───────────────────────────────────────────────────────────

// Kill/death feed + body-part hit stats for a player across the caller's
// players_view orgs. pvp_log stores only the victim's display name (no steam
// id), so deaths are matched against the player's known names from
// player_cache (current display name + BM aliases) — best-effort by design.
async function handleGetPlayerPvp(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "25", 10) || 25, 1),
    100,
  );

  const scopedOrgIds = sessionCandidateOrgIds(session, null).filter((o) =>
    orgHasPermission(session, o, "players_view"),
  );

  const emptyStats = {
    kills: { total: 0, bodyparts: {} },
    deaths: { total: 0, bodyparts: {} },
  };
  if (scopedOrgIds.length === 0) return json({ lines: [], stats: emptyStats });

  const nameRes = await pool.query(
    `SELECT display_name, bm_name_aliases FROM player_cache WHERE steam_id = $1`,
    [steamId],
  );
  const names = new Set();
  const cacheRow = nameRes.rows[0];
  if (cacheRow?.display_name) names.add(String(cacheRow.display_name));
  if (Array.isArray(cacheRow?.bm_name_aliases)) {
    for (const n of cacheRow.bm_name_aliases) {
      if (typeof n === "string" && n) names.add(n);
    }
  }
  const nameArr = [...names];

  const [feedRes, statsRes] = await Promise.all([
    pool.query(
      `SELECT p.id, p.killer_steam_id, p.victim_name, p.combatlog_cache,
              p.server_name, p.created_at AS ts,
              kpc.display_name AS killer_name
       FROM pvp_log p
       JOIN servers s ON s.server_id = p.server_id
       LEFT JOIN player_cache kpc ON kpc.steam_id = p.killer_steam_id
       WHERE s.owner_org_id = ANY($2)
         AND (p.killer_steam_id = $1 OR p.victim_name = ANY($3))
       ORDER BY p.created_at DESC
       LIMIT $4`,
      [steamId, scopedOrgIds, nameArr, limit],
    ),
    pool.query(
      `SELECT (p.killer_steam_id = $1) AS is_kill,
              LOWER(COALESCE(NULLIF(TRIM(p.combatlog_cache->>'bodypart'), ''), 'unknown')) AS bodypart,
              COUNT(*)::int AS count
       FROM pvp_log p
       JOIN servers s ON s.server_id = p.server_id
       WHERE s.owner_org_id = ANY($2)
         AND (p.killer_steam_id = $1 OR p.victim_name = ANY($3))
       GROUP BY 1, 2`,
      [steamId, scopedOrgIds, nameArr],
    ),
  ]);

  const stats = emptyStats;
  for (const r of statsRes.rows) {
    const bucket = r.is_kill ? stats.kills : stats.deaths;
    bucket.total += r.count;
    bucket.bodyparts[r.bodypart] =
      (bucket.bodyparts[r.bodypart] ?? 0) + r.count;
  }

  const lines = feedRes.rows.map((r) => {
    const log = r.combatlog_cache ?? {};
    const distance = log.distance != null ? Number(log.distance) : null;
    const hpBefore = log.hp_before != null ? Number(log.hp_before) : null;
    const hpAfter = log.hp_after != null ? Number(log.hp_after) : null;
    return {
      id: String(r.id),
      role: String(r.killer_steam_id) === steamId ? "kill" : "death",
      killerSteamId: String(r.killer_steam_id),
      killerName: r.killer_name ?? null,
      victimName: String(r.victim_name),
      serverName: r.server_name ?? null,
      weapon: typeof log.weapon === "string" ? log.weapon : null,
      bodypart: typeof log.bodypart === "string" ? log.bodypart : null,
      distance: Number.isFinite(distance) ? distance : null,
      hpBefore: Number.isFinite(hpBefore) ? hpBefore : null,
      hpAfter: Number.isFinite(hpAfter) ? hpAfter : null,
      ts: Number(r.ts),
    };
  });

  return json({ lines, stats });
}

// ── BM server co-players ──────────────────────────────────────────────────────

async function handleGetBmServerCoPlayers(request, orgId, bmServerId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const { rows } = await pool.query(
    `SELECT DISTINCT pc.steam_id, pc.display_name, pc.avatar_url,
            pc.bm_rust_bans_banned, pc.steam_vac_banned, pc.steam_vac_count,
            pc.steam_game_ban_count
     FROM player_session_windows psw
     JOIN player_cache pc ON pc.steam_id = psw.steam_id
     WHERE psw.bm_server_id = $1
     ORDER BY pc.display_name
     LIMIT 50`,
    [String(bmServerId)],
  );

  return json({
    players: rows.map((r) => ({
      steamId: String(r.steam_id),
      displayName: r.display_name ?? null,
      avatarUrl: r.avatar_url ?? null,
      bmBanned: Boolean(r.bm_rust_bans_banned),
      vacBanned: Boolean(r.steam_vac_banned),
      vacCount: Number(r.steam_vac_count ?? 0),
      gameBanCount: Number(r.steam_game_ban_count ?? 0),
    })),
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

// ── Staff Discord username search ─────────────────────────────────────────────

async function handleSearchStaffByDiscord(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "staff_discord_lookup"))
    return json(
      { error: "Forbidden: staff_discord_lookup permission required" },
      403,
    );

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return json({ members: [] });

  const { rows } = await pool.query(
    `SELECT u.user_id, u.username, u.discord_id,
            usa.steam_id, usa.is_primary,
            pc.display_name AS steam_display_name,
            pc.avatar_url
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     JOIN user_steam_accounts usa ON usa.user_id = u.user_id
     LEFT JOIN player_cache pc ON pc.steam_id = usa.steam_id
     WHERE om.org_id = $1
       AND u.discord_id::text LIKE $2
     ORDER BY u.username ASC, usa.is_primary DESC
     LIMIT 30`,
    [orgId, `%${q}%`],
  );

  const byUser = new Map();
  for (const row of rows) {
    const uid = String(row.user_id);
    if (!byUser.has(uid)) {
      byUser.set(uid, {
        userId: uid,
        username: row.username,
        discordId: row.discord_id ? String(row.discord_id) : null,
        steamAccounts: [],
      });
    }
    byUser.get(uid).steamAccounts.push({
      steamId: String(row.steam_id),
      isPrimary: Boolean(row.is_primary),
      displayName: row.steam_display_name ?? null,
      avatarUrl: row.avatar_url ?? null,
    });
  }

  return json({ members: [...byUser.values()] });
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

// ── Player origin heatmap (90-day country aggregate from session + IP data) ───

async function handleGetPlayerOriginHeatmap(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "players_view") &&
    !canManageOrg(session, orgId) &&
    !isGlobalAdmin(session)
  )
    return json({ error: "Forbidden" }, 403);

  const since = Math.floor(Date.now() / 1000) - 90 * 86400;
  try {
    // The frontend heatmap keys COUNTRY_CENTROIDS by ISO alpha-2 codes, so we
    // group by im.iso_code (e.g. "US") rather than im.country (the full name,
    // e.g. "United States") which would never match a centroid.
    const { rows } = await pool.query(
      `SELECT im.iso_code AS country, COUNT(DISTINCT sps.steam_id)::int AS count
       FROM server_player_sessions sps
       JOIN player_ip_history pih ON pih.steam_id = sps.steam_id
       JOIN ip_metadata im ON im.ip_hash = pih.ip_hash
       WHERE sps.org_id = $1
         AND sps.connected_at > $2
         AND im.iso_code IS NOT NULL
       GROUP BY im.iso_code
       ORDER BY count DESC
       LIMIT 100`,
      [orgId, since],
    );
    return json({
      countries: rows.map((r) => ({
        country: String(r.country),
        count: Number(r.count),
      })),
    });
  } catch {
    return json({ countries: [] });
  }
}

// ── Org player list (cached players + live RCON online status) ────────────────

async function handleGetOrgPlayerList(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !orgHasPermission(session, orgId, "player_list") &&
    !orgHasPermission(session, orgId, "players_view")
  )
    return json({ error: "Forbidden: player_list permission required" }, 403);

  const cacheKey = `player-list:${orgId}`;
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

  // All sighted players for this org with cache data. The trigger config drives
  // the sus score (its configured signal weights), so load it alongside.
  const [sightingsRes, activeBansRes, triggerConfig] = await Promise.all([
    pool.query(
      `SELECT pc.steam_id, pc.display_name, pc.avatar_url,
              pc.steam_rust_hours, pc.steam_profile_created_at,
              pc.steam_vac_count, pc.steam_game_ban_count,
              pc.steam_days_since_last_ban, pc.steam_community_banned,
              pc.bm_rust_hours, pc.bm_kills, pc.bm_deaths,
              pc.bm_cheating_reports, pc.bm_teaming_reports, pc.bm_other_reports,
              pc.bm_rust_bans_count
       FROM org_player_sightings ops
       JOIN player_cache pc ON pc.steam_id = ops.steam_id
       WHERE ops.org_id = $1
       ORDER BY ops.last_seen_at DESC`,
      [orgId],
    ),
    pool.query(
      `SELECT DISTINCT identifier FROM player_bans
       WHERE org_id = $1 AND identifier_type = 'steam_id'
         AND revoked = FALSE AND action_type = 'ban'
         AND (expires_at IS NULL OR expires_at > unix_now())`,
      [orgId],
    ),
    getThreatTriggerConfigOrDefault(orgId),
  ]);
  const bannedSteamIds = new Set(activeBansRes.rows.map((r) => r.identifier));
  const triggerThreshold = Number(triggerConfig?.threshold) || 1.0;

  const allSteamIds = sightingsRes.rows.map((r) => r.steam_id);
  let ipMap = {};
  let f7Map = {};
  if (allSteamIds.length > 0) {
    const [ipRes, f7Res] = await Promise.all([
      pool.query(
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
      ),
      pool.query(
        `SELECT pr.reported_steam_id,
                COUNT(*) FILTER (WHERE pr.created_at > unix_now() - 3600)  AS last1h,
                COUNT(*) FILTER (WHERE pr.created_at > unix_now() - 86400) AS last24h,
                COUNT(*) AS total
         FROM player_reports pr
         JOIN servers s ON s.server_id = pr.server_id
         WHERE pr.reported_steam_id = ANY($1) AND s.owner_org_id = $2
         GROUP BY pr.reported_steam_id`,
        [allSteamIds, orgId],
      ),
    ]);
    ipMap = Object.fromEntries(ipRes.rows.map((r) => [r.steam_id, r]));
    f7Map = Object.fromEntries(f7Res.rows.map((r) => [r.reported_steam_id, r]));
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const enriched = sightingsRes.rows.map((cache) => {
    const online = onlineMap.get(cache.steam_id);
    const ip = ipMap[cache.steam_id] ?? null;

    const totalHours =
      cache.steam_rust_hours != null ? Number(cache.steam_rust_hours) : null;
    const kills = Number(cache.bm_kills ?? 0);
    const deaths = Number(cache.bm_deaths ?? 0);
    const kd = deaths > 0 ? kills / deaths : kills > 0 ? kills : 0;
    const reportCount =
      Number(cache.bm_cheating_reports ?? 0) +
      Number(cache.bm_teaming_reports ?? 0) +
      Number(cache.bm_other_reports ?? 0);
    const accountAgeDays = cache.steam_profile_created_at
      ? Math.floor((nowSec - Number(cache.steam_profile_created_at)) / 86400)
      : 0;

    // Sus score = sum of the org's configured threat-trigger signal weights
    // that match this player. Uses the same fact set + evaluator as the trigger
    // engine, so the score stays in lockstep with the Threat Triggers page.
    // No longer normalised to 0–100; it's the raw weighted total.
    const f7 = f7Map[cache.steam_id] ?? null;
    const facts = {
      proxy: ip?.is_proxy ?? false,
      vacBans: Number(cache.steam_vac_count ?? 0),
      gameBans: Number(cache.steam_game_ban_count ?? 0),
      daysSinceBan:
        cache.steam_days_since_last_ban != null
          ? Number(cache.steam_days_since_last_ban)
          : Number.POSITIVE_INFINITY,
      accountAge:
        cache.steam_profile_created_at != null
          ? (nowSec - Number(cache.steam_profile_created_at)) / (365.25 * 86400)
          : null,
      playtimeHours:
        cache.steam_rust_hours != null ? Number(cache.steam_rust_hours) : null,
      bmRustHours:
        cache.bm_rust_hours != null ? Number(cache.bm_rust_hours) : null,
      bmActiveBans: Number(cache.bm_rust_bans_count ?? 0),
      bmCheatingReports: Number(cache.bm_cheating_reports ?? 0),
      f7Last1h: Number(f7?.last1h ?? 0),
      f7Last24h: Number(f7?.last24h ?? 0),
      f7Total: Number(f7?.total ?? 0),
      bmKills: kills,
      bmDeaths: deaths,
      bmKdr: deaths > 0 ? kills / deaths : null,
      bmTeamingReports: Number(cache.bm_teaming_reports ?? 0),
      steamCommunityBanned: Boolean(cache.steam_community_banned),
    };
    const susScore =
      Math.round(evaluateConfig(triggerConfig, { facts }).score * 100) / 100;

    return {
      steamId: cache.steam_id,
      name: cache.display_name ?? "",
      isOnline: !!online,
      serverId: online?.serverId ?? null,
      serverName: online?.serverName ?? null,
      isBanned: bannedSteamIds.has(cache.steam_id),
      susScore,
      susThreshold: triggerThreshold,
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

    if (
      pathname === "/api/auth/stop-impersonating" &&
      request.method === "POST"
    ) {
      return handleStopImpersonating(request);
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
      pathname === "/api/internal/discord/message/delete-bulk" &&
      request.method === "POST"
    ) {
      return handleBulkDeleteDiscordMessages(request);
    }

    if (
      pathname === "/api/internal/discord/message/update" &&
      request.method === "POST"
    ) {
      return handleUpdateDiscordMessage(request);
    }

    if (
      pathname === "/api/internal/bot/staff-list" &&
      request.method === "GET"
    ) {
      return handleBotGetStaffList(request);
    }

    if (
      pathname === "/api/internal/bot/player-count" &&
      request.method === "GET"
    ) {
      return handleBotGetPlayerCount(request);
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

    const ticketFeedbackMatch = pathname.match(
      /^\/api\/tickets\/(\d+)\/feedback$/,
    );
    if (ticketFeedbackMatch && request.method === "POST")
      return handleSubmitTicketFeedback(request, ticketFeedbackMatch[1]);

    const ticketMatch = pathname.match(/^\/api\/tickets\/(\d+)$/);
    if (ticketMatch && request.method === "GET") {
      return handleGetTicket(request, ticketMatch[1]);
    }
    if (ticketMatch && request.method === "PATCH") {
      return handleUpdateTicket(request, ticketMatch[1]);
    }
    if (ticketMatch && request.method === "DELETE") {
      return handleDeleteTicket(request, ticketMatch[1]);
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

    const ticketRelationshipsMatch = pathname.match(
      /^\/api\/tickets\/(\d+)\/relationships$/,
    );
    if (ticketRelationshipsMatch && request.method === "GET") {
      return handleGetTicketRelationships(request, ticketRelationshipsMatch[1]);
    }

    const ticketMessagesMatch = pathname.match(
      /^\/api\/tickets\/(\d+)\/messages$/,
    );
    if (ticketMessagesMatch && request.method === "POST") {
      return handleAddTicketMessage(request, ticketMessagesMatch[1]);
    }

    const ticketDmMatch = pathname.match(
      /^\/api\/tickets\/(\d+)\/dm-notifications$/,
    );
    if (ticketDmMatch && request.method === "POST") {
      return handleToggleTicketDmNotifications(request, ticketDmMatch[1]);
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

    const orgResolveGroupMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/threat-triggers\/resolve-group$/,
    );
    if (orgResolveGroupMatch && request.method === "POST") {
      return handleResolveSteamGroup(request, orgResolveGroupMatch[1]);
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

    const orgTicketBlacklistMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-blacklist$/,
    );
    if (orgTicketBlacklistMatch) {
      if (request.method === "GET")
        return handleListTicketBlacklist(request, orgTicketBlacklistMatch[1]);
      if (request.method === "POST")
        return handleCreateTicketBlacklist(request, orgTicketBlacklistMatch[1]);
    }

    const orgTicketBlacklistEntryMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-blacklist\/(\d+)$/,
    );
    if (orgTicketBlacklistEntryMatch && request.method === "DELETE") {
      return handleDeleteTicketBlacklist(
        request,
        orgTicketBlacklistEntryMatch[1],
        parseInt(orgTicketBlacklistEntryMatch[2]),
      );
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

    const orgTicketTypePublicQuestionsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-types\/(\d+)\/public-questions$/,
    );
    if (orgTicketTypePublicQuestionsMatch && request.method === "GET") {
      const [, pqOrgId, pqTypeId] = orgTicketTypePublicQuestionsMatch;
      return handleListPublicTicketTypeQuestions(
        request,
        pqOrgId,
        parseInt(pqTypeId),
      );
    }

    const orgTicketTypeQuestionsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-types\/(\d+)\/questions$/,
    );
    if (orgTicketTypeQuestionsMatch) {
      const [, qOrgId, qTypeId] = orgTicketTypeQuestionsMatch;
      if (request.method === "GET")
        return handleListTicketTypeQuestions(
          request,
          qOrgId,
          parseInt(qTypeId),
        );
      if (request.method === "POST")
        return handleCreateTicketTypeQuestion(
          request,
          qOrgId,
          parseInt(qTypeId),
        );
    }

    const orgTicketTypeQuestionReorderMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-types\/(\d+)\/questions\/(\d+)\/reorder$/,
    );
    if (orgTicketTypeQuestionReorderMatch && request.method === "POST") {
      const [, qOrgId, qTypeId, qId] = orgTicketTypeQuestionReorderMatch;
      return handleReorderTicketTypeQuestion(
        request,
        qOrgId,
        parseInt(qTypeId),
        parseInt(qId),
      );
    }

    const orgTicketTypeQuestionMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/ticket-types\/(\d+)\/questions\/(\d+)$/,
    );
    if (orgTicketTypeQuestionMatch) {
      const [, qOrgId, qTypeId, qId] = orgTicketTypeQuestionMatch;
      if (request.method === "PATCH")
        return handleUpdateTicketTypeQuestion(
          request,
          qOrgId,
          parseInt(qTypeId),
          parseInt(qId),
        );
      if (request.method === "DELETE")
        return handleDeleteTicketTypeQuestion(
          request,
          qOrgId,
          parseInt(qTypeId),
          parseInt(qId),
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

    const orgCasesMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/cases$/,
    );
    if (orgCasesMatch && request.method === "POST") {
      return handleCreateCase(request, orgCasesMatch[1]);
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

    // BM ban feed
    const orgBmBanFeedMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bm-ban-feed$/,
    );
    if (orgBmBanFeedMatch && request.method === "GET")
      return handleGetBmBanFeed(request, orgBmBanFeedMatch[1]);

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

    const orgBanAuditMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bans\/([a-f0-9-]+)\/audit$/,
    );
    if (orgBanAuditMatch && request.method === "GET")
      return handleGetBanAuditLog(
        request,
        orgBanAuditMatch[1],
        orgBanAuditMatch[2],
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

    // The panel reader uses /api/teaminfo; the game-server plugin posts to
    // /api/ingest/teaminfo (its Enqueue paths are all /ingest/*). Accept both so
    // deployed plugins don't 404 (a 404 here jams the plugin's shared send queue).
    if (pathname === "/api/teaminfo" || pathname === "/api/ingest/teaminfo") {
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

    // Player team history (DB-backed, no RCON required)
    const playerTeamsMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/player-teams$/,
    );
    if (playerTeamsMatch && request.method === "GET")
      return handleGetPlayerTeamHistory(request, playerTeamsMatch[1]);

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

    // Signed media file streaming (HMAC in query string + session — see handler)
    const mediaFileMatch = pathname.match(/^\/api\/media\/([a-f0-9-]+)\/file$/);
    if (mediaFileMatch && request.method === "GET")
      return handleGetMediaFile(request, mediaFileMatch[1]);

    // Signed gallery thumbnail streaming (same auth as /file, ~15 KB webp)
    const mediaThumbMatch = pathname.match(
      /^\/api\/media\/([a-f0-9-]+)\/thumb$/,
    );
    if (mediaThumbMatch && request.method === "GET")
      return handleGetMediaThumb(request, mediaThumbMatch[1]);

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

    // Staff Discord username search
    const staffDiscordSearchMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/staff\/discord-search$/,
    );
    if (staffDiscordSearchMatch && request.method === "GET")
      return handleSearchStaffByDiscord(request, staffDiscordSearchMatch[1]);

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

    const orgPlayerOpenTicketMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/players\/([^/]+)\/open-ticket$/,
    );
    if (orgPlayerOpenTicketMatch && request.method === "GET")
      return handleCheckPlayerOpenTicket(
        request,
        orgPlayerOpenTicketMatch[1],
        orgPlayerOpenTicketMatch[2],
      );

    // BM server co-players
    const bmServerCoPlayersMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/bm-server\/([^/]+)\/co-players$/,
    );
    if (bmServerCoPlayersMatch && request.method === "GET")
      return handleGetBmServerCoPlayers(
        request,
        bmServerCoPlayersMatch[1],
        bmServerCoPlayersMatch[2],
      );

    // Org player list
    const orgPlayerListMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/player-list$/,
    );
    if (orgPlayerListMatch && request.method === "GET")
      return handleGetOrgPlayerList(request, orgPlayerListMatch[1]);

    // Org player origin heatmap (90-day country aggregate)
    const playerOriginHeatmapMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/player-origin-heatmap$/,
    );
    if (playerOriginHeatmapMatch && request.method === "GET")
      return handleGetPlayerOriginHeatmap(request, playerOriginHeatmapMatch[1]);

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

    // Kill/death feed + body-part stats from server combat logs
    const playerPvpMatch = pathname.match(/^\/api\/players\/(\d+)\/pvp$/);
    if (playerPvpMatch && request.method === "GET")
      return handleGetPlayerPvp(request, playerPvpMatch[1]);

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

    // Sysadmin: BattleMetrics API relays
    if (pathname === "/api/sys/relays") {
      if (request.method === "GET") return handleListRelays(request);
      if (request.method === "POST") return handleCreateRelay(request);
    }
    const relayIdMatch = pathname.match(
      /^\/api\/sys\/relays\/([0-9a-fA-F-]{36})$/,
    );
    if (relayIdMatch) {
      if (request.method === "PATCH")
        return handleUpdateRelay(request, relayIdMatch[1]);
      if (request.method === "DELETE")
        return handleDeleteRelay(request, relayIdMatch[1]);
    }
    const relayRotateMatch = pathname.match(
      /^\/api\/sys\/relays\/([0-9a-fA-F-]{36})\/rotate-key$/,
    );
    if (relayRotateMatch && request.method === "POST")
      return handleRotateRelayKey(request, relayRotateMatch[1]);
    const relayHealthMatch = pathname.match(
      /^\/api\/sys\/relays\/([0-9a-fA-F-]{36})\/health$/,
    );
    if (relayHealthMatch && request.method === "POST")
      return handleRelayHealthCheck(request, relayHealthMatch[1]);

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

    // ── Multi-steam account linking ──────────────────────────────────────────

    if (pathname === "/api/auth/steam/add-start" && request.method === "GET")
      return handleSteamAddStart(request);

    if (pathname === "/api/auth/steam/add-callback" && request.method === "GET")
      return handleSteamAddCallback(request);

    if (pathname === "/api/profile/steam-accounts" && request.method === "GET")
      return handleGetProfileSteamAccounts(request);

    if (pathname === "/api/profile/primary-steam" && request.method === "PATCH")
      return handleSetProfilePrimarySteam(request);

    const profileSteamAccountMatch = pathname.match(
      /^\/api\/profile\/steam-accounts\/([a-f0-9-]+)$/,
    );
    if (profileSteamAccountMatch && request.method === "DELETE")
      return handleDeleteProfileSteamAccount(
        request,
        profileSteamAccountMatch[1],
      );

    if (pathname === "/api/sys/linked-accounts" && request.method === "GET")
      return handleSysListLinkedAccounts(request);

    if (pathname === "/api/sys/feedback" && request.method === "GET")
      return handleSysListFeedback(request);

    const sysLinkedAccountMatch = pathname.match(
      /^\/api\/sys\/linked-accounts\/([a-f0-9-]+)$/,
    );
    if (sysLinkedAccountMatch && request.method === "DELETE")
      return handleSysDeleteLinkedAccount(request, sysLinkedAccountMatch[1]);

    const orgMemberPrimarySteamMatch = pathname.match(
      /^\/api\/orgs\/([a-zA-Z0-9_-]+)\/members\/([a-zA-Z0-9_-]+)\/primary-steam$/,
    );
    if (orgMemberPrimarySteamMatch && request.method === "PATCH")
      return handleSetOrgMemberPrimarySteam(
        request,
        orgMemberPrimarySteamMatch[1],
        orgMemberPrimarySteamMatch[2],
      );

    return json({ error: "Not found" }, 404);
  });
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

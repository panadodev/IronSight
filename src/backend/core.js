// Shared request-handling core: session/authorization helpers, server-key
// authentication, audit logging, and Redis rate limiting. Imports only from
// config, runtime, and the pure http helpers (no cycle back to api.js).

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { parse as parseCookie } from "cookie";
import { pool, redis } from "./runtime.js";
import { json } from "./http.js";
import { env, SESSION_COOKIE } from "./config.js";

// Generic Redis sliding-window-ish limiter. Returns a 429 response when the
// caller exceeds `limit` actions within `windowSeconds`, otherwise null.
// Fails open (returns null) if Redis is unavailable, matching rateLimitLogin.
export async function checkRateLimit(
  key,
  limit,
  windowSeconds = 60,
  message = "Too many requests. Slow down.",
) {
  if (!redis) return null;
  try {
    const n = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1,
      key,
      String(windowSeconds),
    );
    if (n > limit) {
      return json({ error: message }, 429);
    }
  } catch {
    return null;
  }
  return null;
}

// Authenticates a game-server plugin request by its API key (Authorization:
// Bearer <key> or x-api-key header). Returns { server } on success, or
// { error } (a ready-to-return Response) on failure. `server` always contains
// server_id, server_name and owner_org_id. `logTag`, when given, logs rejected
// attempts (e.g. "ingest:chat") matching the previous per-handler logging.
export async function authenticateServerKey(request, logTag) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) {
    if (logTag) console.log(`[${logTag}] rejected — missing API key`);
    return {
      error: json(
        {
          error:
            "Missing API key (x-api-key header or Authorization: Bearer <key>)",
        },
        401,
      ),
    };
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
    if (logTag) console.log(`[${logTag}] rejected — invalid API key`);
    return { error: json({ error: "Invalid API key" }, 401) };
  }
  return { server: serverRes.rows[0] };
}

export async function auditLog({
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

export function redirect(location, headers = new Headers()) {
  headers.set("location", location);
  return new Response(null, { status: 302, headers });
}

export function canWriteTodos(session) {
  if (session?.canWrite) return true;
  if (session?.orgOwnerOrgIds?.length) return true;
  if (session?.orgAdminOrgIds?.length) return true;
  if (!session?.groups?.length) return false;
  return session.groups.some((g) => g.admin || g.editUsers);
}

export function isGlobalAdmin(session) {
  if (session?.globalAdmin) return true;
  return Boolean(session?.groups?.some((g) => g.admin));
}

export function isConfiguredSysAdmin(session) {
  const configuredDiscordId = String(env.sysAdminDiscordId ?? "").trim();
  if (!configuredDiscordId) return false;
  return String(session?.discordId ?? "") === configuredDiscordId;
}

export function requireConfiguredSysAdmin(session) {
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

export function canManageOrg(session, orgId) {
  return session.orgAdminOrgIds.includes(orgId);
}

export function canViewOrgAsOwner(session, orgId) {
  // Check if user is org owner
  return session.orgAdminOrgIds.includes(orgId);
}

export function orgHasPermission(session, orgId, permissionId) {
  return (
    canManageOrg(session, orgId) ||
    (session.orgPermissions?.[orgId] ?? []).includes(permissionId)
  );
}

export function sessionRankForOrg(session, orgId) {
  if (session.globalAdmin) return 4;
  if ((session.orgOwnerOrgIds ?? []).includes(orgId)) return 4;
  if ((session.orgAdminOrgIds ?? []).includes(orgId)) return 4;
  const perms = (session.orgPermissions ?? {})[orgId] ?? [];
  if (perms.length > 0) return 3;
  return 1;
}

export async function getSession(request) {
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

export async function requireSession(request) {
  const session = await getSession(request);
  if (!session) {
    return { error: json({ error: "Unauthorized" }, 401) };
  }
  // Track presence for the Online Staff popup — fire-and-forget, 5-min TTL.
  if (session.userId && redis) {
    redis
      .set(
        `online:${session.userId}`,
        String(Math.floor(Date.now() / 1000)),
        "EX",
        300,
      )
      .catch(() => {});
  }
  return { session };
}

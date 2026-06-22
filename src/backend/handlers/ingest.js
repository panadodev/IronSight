// Game-server plugin ingest handlers (authenticated by per-server API key).
// Pure relocation from api.js — depends only on the shared backend modules.

import { pool, redis } from "../runtime.js";
import { json } from "../http.js";
import { authenticateServerKey, checkRateLimit } from "../core.js";

const HEALTH_CHECK_RATE_LIMIT_PER_MINUTE = 60;
const SERVER_LOG_RATE_LIMIT_PER_MINUTE = 120;
const CHAT_INGEST_RATE_LIMIT_PER_MINUTE = 120;
const PVP_INGEST_RATE_LIMIT_PER_MINUTE = 120;
const REPORTS_INGEST_RATE_LIMIT_PER_MINUTE = 60;
const TEAM_INGEST_RATE_LIMIT_PER_MINUTE = 120;
const MUTE_CHECK_RATE_LIMIT_PER_MINUTE = 60;
const MUTE_SYNC_RATE_LIMIT_PER_MINUTE = 120;

export async function handleServerHealthCheck(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:health:${server.server_id}`,
    HEALTH_CHECK_RATE_LIMIT_PER_MINUTE,
    60,
    "Rate limit exceeded",
  );
  if (rl) return rl;

  await pool.query(
    `UPDATE servers SET last_health_ping = unix_now() WHERE server_id = $1`,
    [server.server_id],
  );

  console.log(
    `[health-check] ping from server=${server.server_name} (${server.server_id})`,
  );
  return json({ ok: true });
}

export async function handleIngestChatMessage(request) {
  const { server, error } = await authenticateServerKey(request, "ingest:chat");
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:chat:${server.server_id}`,
    CHAT_INGEST_RATE_LIMIT_PER_MINUTE,
    60,
    "Rate limit exceeded",
  );
  if (rl) return rl;

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
    `[ingest:chat] stored — id=${row.id} server=${server.server_name} player=${playerName ?? steamId} team=${teamMessage} len=${message.length}`,
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

export async function handleIngestPvp(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:pvp:${server.server_id}`,
    PVP_INGEST_RATE_LIMIT_PER_MINUTE,
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

export async function handleIngestReport(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:reports:${server.server_id}`,
    REPORTS_INGEST_RATE_LIMIT_PER_MINUTE,
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

export async function handleIngestTeamEvent(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:team:${server.server_id}`,
    TEAM_INGEST_RATE_LIMIT_PER_MINUTE,
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

  const eventType = String(body?.event_type ?? "").trim();
  const teamLeader = String(body?.team_leader ?? "").trim();
  const teamMembers = body?.team_members;
  const targetPlayerRaw = body?.target_player;
  const eventTimeRaw = body?.event_time;

  if (!eventType || !teamLeader) {
    return json({ error: "event_type and team_leader are required" }, 400);
  }
  if (!["created", "joined", "left", "invited"].includes(eventType)) {
    return json(
      { error: "event_type must be one of: created, joined, left, invited" },
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

  // 'invited' events record who was invited (the invitee). For every other
  // event type target_player is optional and ignored.
  let targetPlayer = null;
  if (targetPlayerRaw != null) {
    targetPlayer = String(targetPlayerRaw).trim().slice(0, 128);
  }
  if (eventType === "invited" && !targetPlayer) {
    return json(
      { error: "target_player is required for 'invited' events" },
      400,
    );
  }

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
    `INSERT INTO team_events (server_id, server_name, event_type, team_members, team_leader, target_player, event_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      server.server_id,
      server.server_name,
      eventType,
      JSON.stringify(safeMembers),
      teamLeader,
      targetPlayer,
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
    targetPlayer,
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

export async function handleMuteCheck(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:mute-check:${server.server_id}`,
    MUTE_CHECK_RATE_LIMIT_PER_MINUTE,
    60,
    "Rate limit exceeded",
  );
  if (rl) return rl;

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

export async function handleIngestMuteSync(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:mute-sync:${server.server_id}`,
    MUTE_SYNC_RATE_LIMIT_PER_MINUTE,
    60,
    "Rate limit exceeded",
  );
  if (rl) return rl;

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
    active_mutes[row.identifier] = row.expires_at
      ? Number(row.expires_at)
      : null;
  }

  return json({ active_mutes });
}

export async function handleGetBlacklistedWordsForServer(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const { rows } = await pool.query(
    `SELECT word FROM org_blacklisted_words WHERE org_id = $1 ORDER BY created_at ASC`,
    [server.owner_org_id],
  );

  return new Response(rows.map((r) => r.word).join(";"), {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

const VALID_SERVER_LOG_EVENT_TYPES = new Set([
  "ADMIN_COMMAND",
  "KICK",
  "BAN",
  "UNBAN",
  "MUTE",
  "UNMUTE",
  "RCON_COMMAND",
  "NOCLIP_TOGGLE",
  "GODMODE_TOGGLE",
]);

export async function handleIngestServerLog(request) {
  const { server, error } = await authenticateServerKey(request);
  if (error) return error;

  const rl = await checkRateLimit(
    `rl:serverlog:${server.server_id}`,
    SERVER_LOG_RATE_LIMIT_PER_MINUTE,
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

  const eventType = String(body?.event_type ?? "")
    .trim()
    .toUpperCase();
  if (!VALID_SERVER_LOG_EVENT_TYPES.has(eventType)) {
    return json(
      {
        error: `event_type must be one of: ${[...VALID_SERVER_LOG_EVENT_TYPES].join(", ")}`,
      },
      400,
    );
  }

  const adminSteamId =
    body?.admin_steam_id != null
      ? String(body.admin_steam_id).trim().slice(0, 64) || null
      : null;
  const adminName =
    body?.admin_name != null
      ? String(body.admin_name).trim().slice(0, 128) || null
      : null;
  const targetSteamId =
    body?.target_steam_id != null
      ? String(body.target_steam_id).trim().slice(0, 64) || null
      : null;
  const targetName =
    body?.target_name != null
      ? String(body.target_name).trim().slice(0, 128) || null
      : null;
  const command =
    body?.command != null
      ? String(body.command).trim().slice(0, 1000) || null
      : null;

  let details = {};
  if (body?.details != null) {
    if (typeof body.details !== "object" || Array.isArray(body.details)) {
      return json({ error: "details must be a JSON object" }, 400);
    }
    if (JSON.stringify(body.details).length > 4096) {
      return json({ error: "details must be 4 KB or less" }, 400);
    }
    details = body.details;
  }

  const insertRes = await pool.query(
    `INSERT INTO server_logs
       (org_id, server_id, server_name, event_type, admin_steam_id, admin_name,
        target_steam_id, target_name, command, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, created_at`,
    [
      server.owner_org_id,
      server.server_id,
      server.server_name,
      eventType,
      adminSteamId,
      adminName,
      targetSteamId,
      targetName,
      command,
      JSON.stringify(details),
    ],
  );
  const row = insertRes.rows[0];

  console.log(
    `[ingest:server-log] event=${eventType} admin=${adminSteamId ?? "?"} server=${server.server_name}`,
  );

  return json({ ok: true, id: String(row.id) }, 201);
}

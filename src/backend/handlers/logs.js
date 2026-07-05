// Server log readers (chat / pvp / reports / team events). Session-authed
// GET endpoints; pure relocation from api.js.

import { pool, redis } from "../runtime.js";
import { json, parseLimit } from "../http.js";
import {
  requireSession,
  orgHasPermission,
  canManageOrg,
  isConfiguredSysAdmin,
} from "../core.js";

async function annotatePanelLinked(lines) {
  if (lines.length === 0) return lines;
  const steamIds = [...new Set(lines.map((l) => l.steamId))];
  try {
    const { rows } = await pool.query(
      "SELECT steam_id FROM users WHERE steam_id = ANY($1)",
      [steamIds],
    );
    const linked = new Set(rows.map((r) => String(r.steam_id)));
    return lines.map((l) => ({ ...l, panelLinked: linked.has(l.steamId) }));
  } catch {
    return lines;
  }
}

export async function handleGetChatLogs(request) {
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

  if (
    !orgHasPermission(session, server.owner_org_id, "chat_view") &&
    !isConfiguredSysAdmin(session)
  ) {
    return json({ error: "Forbidden: chat_view permission required" }, 403);
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
            cacheKey,
            `(${after}`,
            endUnix,
            "LIMIT",
            0,
            fetch_limit,
          );
        } else {
          // Initial load or "before" cursor: descending newest-first
          const scoreMax = before != null ? `(${before}` : endUnix;
          rawEntries = await redis.zrevrangebyscore(
            cacheKey,
            scoreMax,
            startUnix,
            "LIMIT",
            0,
            fetch_limit,
          );
        }
        if (rawEntries.length > 0) {
          const hasMore = rawEntries.length > limit;
          const lines = rawEntries
            .slice(0, limit)
            .map((raw) => {
              try {
                return JSON.parse(raw);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          // after-poll returns ASC; normalize to DESC for consistency
          if (after != null) lines.reverse();
          return json({ lines: await annotatePanelLinked(lines), hasMore });
        }
      }
    } catch {
      // fall through to Postgres on Redis error
    }
  }

  // PostgreSQL fallback
  const conditions = ["server_id = $1", "created_at >= $2", "created_at <= $3"];
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

  return json({ lines: await annotatePanelLinked(lines), hasMore });
}

export async function handleGetPvpLogs(request) {
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

export async function handleGetReports(request) {
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

export async function handleGetOrgRecentReports(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"), 50, 100);
  const sinceParam = url.searchParams.get("since");
  const nowUnix = Math.floor(Date.now() / 1000);
  const sinceUnix = sinceParam
    ? Math.floor(Number(sinceParam))
    : nowUnix - 24 * 3600;

  if (!Number.isFinite(sinceUnix))
    return json({ error: "Invalid since parameter" }, 400);

  const { rows } = await pool.query(
    `SELECT pr.id, pr.report_type, pr.report_reason, pr.report_description,
            pr.reporter_name, pr.reporter_steam_id, pr.reported_steam_id,
            pr.server_name, pr.created_at
     FROM player_reports pr
     JOIN servers s ON s.server_id = pr.server_id
     WHERE s.owner_org_id = $1
       AND pr.created_at >= $2
     ORDER BY pr.created_at DESC
     LIMIT $3`,
    [orgId, sinceUnix, limit],
  );

  const reports = rows.map((row) => ({
    id: String(row.id),
    reportType: String(row.report_type),
    reportReason: String(row.report_reason),
    reportDescription: String(row.report_description),
    reporterName: String(row.reporter_name),
    reporterSteamId: String(row.reporter_steam_id),
    reportedSteamId: String(row.reported_steam_id),
    serverName: String(row.server_name),
    createdAt: Number(row.created_at),
  }));

  return json({ reports });
}

export async function handleGetTeamEvents(request) {
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
    `SELECT id, event_type, team_members, team_leader, target_player,
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
    targetPlayer: row.target_player != null ? String(row.target_player) : null,
    eventTimeUnix: Number(row.event_time_unix),
    ts: Number(row.ts),
  }));

  return json({ lines });
}

export async function handleGetPlayerTeamHistory(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const allowed =
    canManageOrg(session, orgId) ||
    isConfiguredSysAdmin(session) ||
    orgHasPermission(session, orgId, "tickets_player_intel");
  if (!allowed) return json({ error: "Forbidden" }, 403);

  const url = new URL(request.url);
  const steamId = (url.searchParams.get("steamId") ?? "").trim();
  if (!steamId) return json({ error: "steamId is required" }, 400);

  const limit = parseLimit(url.searchParams.get("limit"), 30, 100);

  const { rows } = await pool.query(
    `SELECT te.id, te.server_id, te.server_name, te.event_type,
            te.team_members, te.team_leader, te.target_player,
            te.event_time AS event_time_unix,
            te.created_at
     FROM team_events te
     JOIN servers s ON s.server_id = te.server_id
     WHERE s.owner_org_id = $1
       AND (te.team_leader = $2 OR te.team_members @> jsonb_build_array($2::text))
     ORDER BY te.created_at DESC
     LIMIT $3`,
    [orgId, steamId, limit],
  );

  const events = rows.map((row) => ({
    id: String(row.id),
    serverId: String(row.server_id),
    serverName: String(row.server_name),
    eventType: String(row.event_type),
    teamMembers: Array.isArray(row.team_members) ? row.team_members : [],
    teamLeader: String(row.team_leader),
    targetPlayer: row.target_player != null ? String(row.target_player) : null,
    eventTimeUnix: Number(row.event_time_unix),
    createdAt: Number(row.created_at),
  }));

  return json({ events });
}

export async function handleGetServerLogs(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId) && !isConfiguredSysAdmin(session))
    return json({ error: "Forbidden" }, 403);

  const url = new URL(request.url);
  const serverId = url.searchParams.get("serverId") ?? null;
  const eventType = url.searchParams.get("eventType") ?? null;
  const adminSteamId = url.searchParams.get("adminSteamId") ?? null;
  const limit = Math.min(
    500,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100),
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
  );

  const conditions = ["sl.org_id = $1"];
  const params = [orgId];

  if (serverId) {
    params.push(serverId);
    conditions.push(`sl.server_id = $${params.length}`);
  }
  if (eventType) {
    params.push(eventType.toUpperCase());
    conditions.push(`sl.event_type = $${params.length}`);
  }
  if (adminSteamId) {
    params.push(adminSteamId);
    conditions.push(`sl.admin_steam_id = $${params.length}`);
  }

  const where = conditions.join(" AND ");

  const [logsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT id, server_id, server_name, event_type,
              admin_steam_id, admin_name, target_steam_id, target_name,
              command, details, coordinates, created_at
       FROM server_logs sl
       WHERE ${where}
       ORDER BY sl.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*) as total FROM server_logs sl WHERE ${where}`,
      params,
    ),
  ]);

  return json({
    logs: logsRes.rows.map((r) => ({
      id: String(r.id),
      serverId: r.server_id,
      serverName: r.server_name,
      eventType: r.event_type,
      adminSteamId: r.admin_steam_id,
      adminName: r.admin_name,
      targetSteamId: r.target_steam_id,
      targetName: r.target_name,
      command: r.command,
      details: r.details ?? {},
      coordinates: r.coordinates ?? null,
      createdAt: Number(r.created_at),
    })),
    total: parseInt(countRes.rows[0].total, 10),
  });
}

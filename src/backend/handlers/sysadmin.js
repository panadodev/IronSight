// Sysadmin-only endpoints: player cache reset, external key limits, BattleMetrics relays, media bucket test, metrics and DB usage. Pure relocation from api.js.

import {
  isConfiguredSysAdmin,
  requireSession,
  requireSysAdminSession,
} from "../core.js";
import { json } from "../http.js";
import { pool, redis } from "../runtime.js";
import {
  getPterodactylEncryptionKey,
  encryptExternalApiKey,
  decryptExternalApiKey,
} from "../crypto-keys.js";
import { r2Configured, testR2BucketWriteDelete } from "../r2.js";
import {
  generateRelayKey,
  normalizeRelayBaseUrl,
  healthCheckRelay,
} from "../relay.js";
import { diagIncoming, diagOutgoing, diagErrors } from "../diagnostics.js";
import { env } from "../config.js";

// ── Sysadmin: clear all player cache ─────────────────────────────────────────

export async function handleClearAllPlayerCache(request) {
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
export async function handleResetExternalKeyLimits(request) {
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

// ── Sysadmin: BattleMetrics API relays ───────────────────────────────────────

// Serialise a relay row for the sysadmin page — never exposes the key.
export function serializeRelay(r) {
  const requests = Number(r.request_count) || 0;
  const totalLatency = Number(r.total_latency_ms) || 0;
  return {
    relayId: String(r.relay_id),
    label: r.label ?? "",
    baseUrl: r.base_url,
    enabled: r.enabled,
    online: r.online,
    rateLimitedUntil: r.rate_limited_until
      ? Number(r.rate_limited_until)
      : null,
    lastHealthAt: r.last_health_at ? Number(r.last_health_at) : null,
    lastLatencyMs: r.last_latency_ms != null ? Number(r.last_latency_ms) : null,
    lastUsedAt: r.last_used_at ? Number(r.last_used_at) : null,
    createdAt: Number(r.created_at) || null,
    stats: {
      requests,
      errors: Number(r.error_count) || 0,
      rateLimited: Number(r.rate_limited_count) || 0,
      avgLatencyMs: requests > 0 ? Math.round(totalLatency / requests) : null,
    },
  };
}

export async function handleListRelays(request) {
  const { session, error } = await requireSysAdminSession(request);
  if (error) return error;
  void session;

  const { rows } = await pool.query(
    `SELECT r.relay_id, r.label, r.base_url, r.enabled, r.online,
            r.rate_limited_until, r.last_health_at, r.last_latency_ms,
            r.last_used_at, r.created_at,
            COALESCE(s.request_count, 0)      AS request_count,
            COALESCE(s.error_count, 0)        AS error_count,
            COALESCE(s.rate_limited_count, 0) AS rate_limited_count,
            COALESCE(s.total_latency_ms, 0)   AS total_latency_ms
     FROM api_relays r
     LEFT JOIN (
       SELECT relay_id,
              SUM(request_count)      AS request_count,
              SUM(error_count)        AS error_count,
              SUM(rate_limited_count) AS rate_limited_count,
              SUM(total_latency_ms)   AS total_latency_ms
       FROM api_relay_stats
       WHERE bucket_hour >= unix_now() - 86400
       GROUP BY relay_id
     ) s ON s.relay_id = r.relay_id
     ORDER BY r.created_at ASC`,
  );
  return json({ relays: rows.map(serializeRelay) });
}

export async function handleCreateRelay(request) {
  const { session, error } = await requireSysAdminSession(request);
  if (error) return error;

  if (!getPterodactylEncryptionKey())
    return json(
      { error: "Server misconfigured: no encryption key available" },
      503,
    );

  const body = await request.json().catch(() => ({}));
  const label = String(body?.label ?? "")
    .trim()
    .slice(0, 100);

  let baseUrl;
  try {
    baseUrl = normalizeRelayBaseUrl(body?.baseUrl);
  } catch {
    return json(
      { error: "Invalid relay URL — must be a public https:// host." },
      400,
    );
  }

  const plaintextKey = generateRelayKey();
  const encKey = encryptExternalApiKey(plaintextKey);
  const { rows } = await pool.query(
    `INSERT INTO api_relays (label, base_url, enc_key_encrypted, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING relay_id`,
    [label, baseUrl, encKey, session.userId],
  );
  const relayId = String(rows[0].relay_id);

  // The plaintext key is returned exactly once — the sysadmin sets it as
  // API_ENCRYPTION_KEY on the relay container. It's never retrievable again.
  return json({
    ok: true,
    relayId,
    baseUrl,
    apiEncryptionKey: plaintextKey,
  });
}

export async function handleUpdateRelay(request, relayId) {
  const { error } = await requireSysAdminSession(request);
  if (error) return error;

  const { rows: existing } = await pool.query(
    `SELECT relay_id FROM api_relays WHERE relay_id = $1`,
    [relayId],
  );
  if (!existing.length) return json({ error: "Relay not found" }, 404);

  const body = await request.json().catch(() => ({}));
  const sets = [];
  const params = [];
  let i = 1;

  if (body?.label !== undefined) {
    sets.push(`label = $${i++}`);
    params.push(String(body.label).trim().slice(0, 100));
  }
  if (body?.enabled !== undefined) {
    sets.push(`enabled = $${i++}`);
    params.push(Boolean(body.enabled));
  }
  if (body?.baseUrl !== undefined) {
    try {
      sets.push(`base_url = $${i++}`);
      params.push(normalizeRelayBaseUrl(body.baseUrl));
      // A URL change invalidates the online status until re-checked.
      sets.push(`online = FALSE`);
    } catch {
      return json(
        { error: "Invalid relay URL — must be a public https:// host." },
        400,
      );
    }
  }
  if (!sets.length) return json({ error: "No fields to update" }, 400);

  params.push(relayId);
  await pool.query(
    `UPDATE api_relays SET ${sets.join(", ")} WHERE relay_id = $${i}`,
    params,
  );
  return json({ ok: true });
}

export async function handleRotateRelayKey(request, relayId) {
  const { error } = await requireSysAdminSession(request);
  if (error) return error;

  if (!getPterodactylEncryptionKey())
    return json(
      { error: "Server misconfigured: no encryption key available" },
      503,
    );

  const plaintextKey = generateRelayKey();
  const encKey = encryptExternalApiKey(plaintextKey);
  const { rowCount } = await pool.query(
    `UPDATE api_relays
     SET enc_key_encrypted = $1, online = FALSE
     WHERE relay_id = $2`,
    [encKey, relayId],
  );
  if (!rowCount) return json({ error: "Relay not found" }, 404);
  return json({ ok: true, apiEncryptionKey: plaintextKey });
}

export async function handleRelayHealthCheck(request, relayId) {
  const { error } = await requireSysAdminSession(request);
  if (error) return error;

  const { rows } = await pool.query(
    `SELECT relay_id, base_url, enc_key_encrypted FROM api_relays WHERE relay_id = $1`,
    [relayId],
  );
  if (!rows.length) return json({ error: "Relay not found" }, 404);

  let keyB64;
  try {
    keyB64 = decryptExternalApiKey(String(rows[0].enc_key_encrypted));
  } catch {
    return json({ error: "Relay key could not be decrypted" }, 500);
  }

  const result = await healthCheckRelay({
    relayId: String(rows[0].relay_id),
    baseUrl: String(rows[0].base_url),
    keyB64,
  });
  return json({ ok: true, ...result });
}

export async function handleDeleteRelay(request, relayId) {
  const { error } = await requireSysAdminSession(request);
  if (error) return error;

  const { rowCount } = await pool.query(
    `DELETE FROM api_relays WHERE relay_id = $1`,
    [relayId],
  );
  if (!rowCount) return json({ error: "Relay not found" }, 404);
  return json({ ok: true });
}

export async function handleTestMediaBucket(request) {
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

export async function handleGetSysMetrics(request) {
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

  let proxycheckQuota = null;
  const pcApiKey = env.proxycheckApiKey?.trim();
  if (pcApiKey) {
    try {
      const pcRes = await fetch(
        `https://proxycheck.io/dashboard/export/usage/?key=${encodeURIComponent(pcApiKey)}`,
      );
      if (pcRes.ok) {
        const pcData = await pcRes.json();
        const queriesDay = Number(pcData["Queries Today"] ?? 0);
        const dailyLimit = Number(pcData["Daily Limit"] ?? 0);
        proxycheckQuota = { queriesDay, dailyLimit };
      }
    } catch {
      // non-critical
    }
  }

  return json({
    incoming: [...diagIncoming].reverse().slice(0, 500),
    outgoing: [...diagOutgoing].reverse().slice(0, 500),
    errors: [...diagErrors].reverse().slice(0, 500),
    routes,
    proxycheckQuota,
  });
}

// ── Database usage / storage summary (sysadmin) ──────────────────────────────

export async function handleGetDbUsage(request) {
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

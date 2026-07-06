// Globalping network measurement integration: API client, background measurement jobs, per-org config/results handlers. Pure relocation from api.js.

import { canManageOrg, orgHasPermission, requireSession } from "../core.js";
import { json } from "../http.js";
import { pool } from "../runtime.js";
import {
  getPterodactylEncryptionKey,
  encryptExternalApiKey,
  decryptExternalApiKey,
} from "../crypto-keys.js";
import { diagRecordOutgoing } from "../diagnostics.js";

// ── Globalping helpers and background jobs ────────────────────────────────────
// https://globalping.io/docs/api.globalping.io — Globalping is a free, globally
// distributed network measurement platform. Requests are rate-limited; an
// optional per-org API token raises the limits but is not required.

export const GLOBALPING_BASE = "https://api.globalping.io/v1";

export async function globalpingFetch(path, opts = {}, apiToken = null) {
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
export async function globalpingCreateMeasurement(
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

export async function triggerGlobalpingMeasurements() {
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

export async function fetchPendingGlobalpingResults() {
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

// ── Globalping config and results handlers ────────────────────────────────────

export async function handleGetGlobalpingConfig(request, orgId) {
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

export async function handlePutGlobalpingConfig(request, orgId) {
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

export async function handleDeleteGlobalpingConfig(request, orgId) {
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

export async function handleGetGlobalpingResults(request, orgId) {
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

export async function handleGetGlobalpingHistory(request, orgId) {
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

export async function handleTriggerGlobalpingMeasurements(request, orgId) {
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

export async function handleGetGlobalpingLimits(request, orgId) {
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

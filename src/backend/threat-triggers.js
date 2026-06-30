// Threat-trigger evaluation engine.
//
// Per-org config (stored in threat_trigger_config.config JSONB) defines weighted
// signals, AND-joined trigger blocks, and bought-account rules. The engine is
// evaluated on player refresh and on F7 report ingest; when something fires it
// auto-opens (or reactivates) a ticket on the player with an internal note.
//
// Shared between api.js (config endpoints + refresh hook) and handlers/ingest.js
// (F7 hook), so it depends only on runtime.js and ticket-store.js.

import { pool } from "./runtime.js";
import { cacheTicket, loadTicketFromDb } from "./ticket-store.js";

// Canonical fact catalogue. The frontend mirrors these ids/labels; the engine is
// the source of truth for how each is computed. Only facts we can actually
// derive from cached data are listed (no mock-only signals).
export const TRIGGER_FACTS = [
  { id: "proxy", label: "Proxy / VPN detected", type: "bool" },
  { id: "vacBans", label: "VAC bans", type: "number", unit: "bans" },
  { id: "gameBans", label: "Game bans", type: "number", unit: "bans" },
  {
    id: "daysSinceBan",
    label: "Days since last Steam ban",
    type: "number",
    unit: "days",
  },
  { id: "accountAge", label: "Steam account age", type: "number", unit: "yrs" },
  {
    id: "playtimeHours",
    label: "Steam Rust hours",
    type: "number",
    unit: "hrs",
  },
  {
    id: "bmRustHours",
    label: "BattleMetrics hours",
    type: "number",
    unit: "hrs",
  },
  {
    id: "bmActiveBans",
    label: "BattleMetrics Rust bans",
    type: "number",
    unit: "bans",
  },
  {
    id: "bmCheatingReports",
    label: "BattleMetrics cheating reports",
    type: "number",
    unit: "reports",
  },
  { id: "f7Last1h", label: "F7 reports (1h)", type: "number", unit: "reports" },
  {
    id: "f7Last24h",
    label: "F7 reports (24h)",
    type: "number",
    unit: "reports",
  },
  {
    id: "f7Total",
    label: "F7 reports (all-time)",
    type: "number",
    unit: "reports",
  },
  {
    id: "bmKills",
    label: "BattleMetrics kills",
    type: "number",
    unit: "kills",
  },
  {
    id: "bmDeaths",
    label: "BattleMetrics deaths",
    type: "number",
    unit: "deaths",
  },
  {
    id: "bmKdr",
    label: "BattleMetrics K/D ratio",
    type: "number",
    unit: "KDR",
  },
  {
    id: "bmTeamingReports",
    label: "BattleMetrics teaming reports",
    type: "number",
    unit: "reports",
  },
  { id: "steamCommunityBanned", label: "Steam community banned", type: "bool" },
];

const FACT_TYPE = new Map(TRIGGER_FACTS.map((f) => [f.id, f.type]));

export const DEFAULT_TRIGGER_CONFIG = {
  threshold: 1.0,
  signals: [
    { factId: "proxy", op: "eq", value: true, weight: 0.4 },
    { factId: "vacBans", op: "gt", value: 0, weight: 0.4 },
    { factId: "accountAge", op: "lt", value: 1, weight: 0.3 },
    { factId: "playtimeHours", op: "lt", value: 100, weight: 0.3 },
    { factId: "bmActiveBans", op: "gt", value: 0, weight: 0.5 },
    { factId: "f7Last24h", op: "gte", value: 3, weight: 0.3 },
  ],
  blocks: [
    {
      name: "Fresh account + reports",
      conditions: [
        { factId: "accountAge", op: "lt", value: 1 },
        { factId: "f7Last1h", op: "gte", value: 3 },
      ],
    },
  ],
  boughtAccount: {
    enabled: false,
    hoursRule: {
      enabled: true,
      ratio: 10,
    },
    nameRule: { enabled: false, terms: [] },
  },
};

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── Config persistence ───────────────────────────────────────────────────────

export async function getThreatTriggerConfig(orgId) {
  const { rows } = await pool.query(
    `SELECT config FROM threat_trigger_config WHERE org_id = $1`,
    [orgId],
  );
  if (!rows[0]) return null;
  return rows[0].config ?? null;
}

export async function getThreatTriggerConfigOrDefault(orgId) {
  return (await getThreatTriggerConfig(orgId)) ?? DEFAULT_TRIGGER_CONFIG;
}

// Strip the config down to a known, safe shape before persisting.
export function sanitizeTriggerConfig(raw) {
  const out = {
    threshold: num(raw?.threshold) ?? 1.0,
    signals: [],
    blocks: [],
    boughtAccount: {
      enabled: Boolean(raw?.boughtAccount?.enabled),
      hoursRule: {
        enabled: raw?.boughtAccount?.hoursRule?.enabled !== false,
        ratio: num(raw?.boughtAccount?.hoursRule?.ratio) ?? 10,
      },
      nameRule: {
        enabled: Boolean(raw?.boughtAccount?.nameRule?.enabled),
        terms: Array.isArray(raw?.boughtAccount?.nameRule?.terms)
          ? raw.boughtAccount.nameRule.terms
              .map((t) => String(t).trim())
              .filter(Boolean)
              .slice(0, 50)
          : [],
      },
    },
  };
  if (out.threshold <= 0) out.threshold = 1.0;

  const validOp = new Set(["eq", "gt", "gte", "lt", "lte"]);
  const cleanCond = (c) => {
    if (!FACT_TYPE.has(c?.factId)) return null;
    const type = FACT_TYPE.get(c.factId);
    const op = validOp.has(c?.op) ? c.op : type === "bool" ? "eq" : "gt";
    const value =
      type === "bool" ? Boolean(c?.value) : (num(Number(c?.value)) ?? 0);
    return { factId: c.factId, op, value };
  };

  if (Array.isArray(raw?.signals)) {
    out.signals = raw.signals
      .map((s) => {
        const cond = cleanCond(s);
        if (!cond) return null;
        let weight = num(Number(s?.weight)) ?? 0;
        weight = Math.max(0, Math.min(1, weight));
        return { ...cond, weight };
      })
      .filter(Boolean)
      .slice(0, 40);
  }

  if (Array.isArray(raw?.blocks)) {
    out.blocks = raw.blocks
      .map((b) => {
        const conditions = Array.isArray(b?.conditions)
          ? b.conditions.map(cleanCond).filter(Boolean).slice(0, 20)
          : [];
        return {
          name: String(b?.name ?? "Trigger block").slice(0, 100),
          conditions,
        };
      })
      .filter((b) => b.conditions.length > 0)
      .slice(0, 30);
  }

  return out;
}

export async function saveThreatTriggerConfig(orgId, rawConfig, userId) {
  const config = sanitizeTriggerConfig(rawConfig);
  await pool.query(
    `INSERT INTO threat_trigger_config (org_id, config, updated_at, updated_by)
     VALUES ($1, $2::jsonb, unix_now(), $3)
     ON CONFLICT (org_id)
     DO UPDATE SET config = EXCLUDED.config, updated_at = unix_now(),
                   updated_by = EXCLUDED.updated_by`,
    [orgId, JSON.stringify(config), userId ?? null],
  );
  return config;
}

// ── Fact computation ─────────────────────────────────────────────────────────

function namesFromAliases(aliases) {
  if (!Array.isArray(aliases)) return [];
  return aliases
    .map((a) => {
      if (typeof a === "string") return a;
      if (a && typeof a === "object") {
        return a.name ?? a.attributes?.name ?? a.value ?? null;
      }
      return null;
    })
    .filter(Boolean)
    .map((s) => String(s));
}

// Computes the fact set for a player within an org. Returns null when the player
// has no cached profile AND no reports (nothing to evaluate).
export async function computePlayerFacts(orgId, steamId) {
  const [profileRes, proxyRes, reportRes] = await Promise.all([
    pool.query(
      `SELECT display_name, steam_profile_created_at, steam_rust_hours,
              steam_vac_count, steam_game_ban_count, steam_days_since_last_ban,
              steam_community_banned,
              bm_rust_hours, bm_rust_bans_count, bm_cheating_reports,
              bm_kills, bm_deaths, bm_teaming_reports,
              bm_name_aliases
       FROM player_cache WHERE steam_id = $1`,
      [steamId],
    ),
    pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM player_ip_history pih
         LEFT JOIN ip_metadata im ON im.ip_hash = pih.ip_hash
         WHERE pih.steam_id = $1
           AND (pih.is_vpn IS TRUE OR im.is_proxy IS TRUE OR im.is_vpn IS TRUE)
       ) AS proxy`,
      [steamId],
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE pr.created_at > unix_now() - 3600)  AS last1h,
         COUNT(*) FILTER (WHERE pr.created_at > unix_now() - 86400) AS last24h,
         COUNT(*) AS total
       FROM player_reports pr
       JOIN servers s ON s.server_id = pr.server_id
       WHERE pr.reported_steam_id = $1 AND s.owner_org_id = $2`,
      [steamId, orgId],
    ),
  ]);

  const p = profileRes.rows[0] ?? null;
  const reports = reportRes.rows[0] ?? { last1h: 0, last24h: 0, total: 0 };
  const hasReports = Number(reports.total) > 0;
  if (!p && !hasReports) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const accountAge =
    p?.steam_profile_created_at != null
      ? (nowSec - Number(p.steam_profile_created_at)) / (365.25 * 86400)
      : null;

  const names = [
    ...(p?.display_name ? [String(p.display_name)] : []),
    ...namesFromAliases(p?.bm_name_aliases),
  ];

  return {
    displayName: p?.display_name ?? null,
    names,
    steamRustHours:
      p?.steam_rust_hours != null ? Number(p.steam_rust_hours) : null,
    bmRustHours: p?.bm_rust_hours != null ? Number(p.bm_rust_hours) : null,
    facts: {
      proxy: proxyRes.rows[0]?.proxy === true,
      vacBans: p?.steam_vac_count != null ? Number(p.steam_vac_count) : 0,
      gameBans:
        p?.steam_game_ban_count != null ? Number(p.steam_game_ban_count) : 0,
      // No recorded ban → effectively infinite days since ban, so "lt X" won't fire.
      daysSinceBan:
        p?.steam_days_since_last_ban != null
          ? Number(p.steam_days_since_last_ban)
          : Number.POSITIVE_INFINITY,
      accountAge,
      playtimeHours:
        p?.steam_rust_hours != null ? Number(p.steam_rust_hours) : null,
      bmRustHours: p?.bm_rust_hours != null ? Number(p.bm_rust_hours) : null,
      bmActiveBans:
        p?.bm_rust_bans_count != null ? Number(p.bm_rust_bans_count) : 0,
      bmCheatingReports:
        p?.bm_cheating_reports != null ? Number(p.bm_cheating_reports) : 0,
      f7Last1h: Number(reports.last1h) || 0,
      f7Last24h: Number(reports.last24h) || 0,
      f7Total: Number(reports.total) || 0,
      bmKills: p?.bm_kills != null ? Number(p.bm_kills) : 0,
      bmDeaths: p?.bm_deaths != null ? Number(p.bm_deaths) : 0,
      bmKdr: (() => {
        const k = p?.bm_kills != null ? Number(p.bm_kills) : null;
        const d = p?.bm_deaths != null ? Number(p.bm_deaths) : null;
        if (k === null || d === null) return null;
        return d > 0 ? k / d : null;
      })(),
      bmTeamingReports:
        p?.bm_teaming_reports != null ? Number(p.bm_teaming_reports) : 0,
      steamCommunityBanned: Boolean(p?.steam_community_banned),
    },
  };
}

function matchCondition(facts, cond) {
  const actual = facts[cond.factId];
  if (actual === null || actual === undefined) return false;
  const type = FACT_TYPE.get(cond.factId);
  if (type === "bool") {
    return Boolean(actual) === Boolean(cond.value);
  }
  const a = Number(actual);
  const b = Number(cond.value);
  if (!Number.isFinite(a) && cond.op !== "lt" && cond.op !== "lte") {
    // Infinity only meaningfully fails "less-than" checks.
  }
  switch (cond.op) {
    case "eq":
      return a === b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

function evaluateBoughtAccount(ba, data) {
  if (!ba?.enabled) return null;
  const reasons = [];
  const steam = num(data.steamRustHours);
  const bm = num(data.bmRustHours);

  if (ba.hoursRule?.enabled && steam != null && bm != null && bm > 0) {
    const ratio = steam / bm;
    if (ratio >= (ba.hoursRule.ratio ?? 10)) {
      reasons.push(
        `bought-account hours ratio (${steam}h Steam vs ${bm}h BM, ${ratio.toFixed(1)}×)`,
      );
    }
  }

  if (ba.nameRule?.enabled && Array.isArray(ba.nameRule.terms)) {
    const lowered = data.names.map((n) => n.toLowerCase());
    for (const term of ba.nameRule.terms) {
      const t = term.toLowerCase();
      const hit = lowered.find((n) => n.includes(t));
      if (hit) {
        reasons.push(`name match "${term}"`);
        break;
      }
    }
  }

  return reasons.length ? reasons : null;
}

// Evaluate config against a player's facts. Returns { fired, reasons[], score }.
export function evaluateConfig(config, data) {
  const facts = data.facts;
  const reasons = [];

  // Weighted signals
  let score = 0;
  for (const s of config.signals ?? []) {
    if (matchCondition(facts, s)) score += Number(s.weight) || 0;
  }
  const threshold = num(config.threshold) ?? 1.0;
  if (score >= threshold) {
    reasons.push(`signal score ${score.toFixed(2)} ≥ ${threshold.toFixed(2)}`);
  }

  // Trigger blocks (all conditions must match)
  for (const b of config.blocks ?? []) {
    if (
      b.conditions.length > 0 &&
      b.conditions.every((c) => matchCondition(facts, c))
    ) {
      reasons.push(`block "${b.name}"`);
    }
  }

  // Bought-account rules
  const ba = evaluateBoughtAccount(config.boughtAccount, data);
  if (ba) reasons.push(...ba);

  return { fired: reasons.length > 0, reasons, score };
}

// ── Ticket creation / reactivation ───────────────────────────────────────────

// Pick the org's player-report ticket type so auto-tickets land under "reports"
// rather than as a typeless ticket. Prefers a type named like a report, then a
// single-player report category, then a multi-player one. Returns null if the
// org has no suitable enabled type.
async function resolveReportTicketTypeId(orgId) {
  const { rows } = await pool.query(
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
  return rows[0] ? Number(rows[0].ticket_type_id) : null;
}

async function openOrReactivateTicket(orgId, steamId, displayName, reasons) {
  const note =
    `🚩 Threat trigger matched: ${reasons.join("; ")}.\n` +
    `Auto-generated from cached player intel.`;

  const existing = await pool.query(
    `SELECT ticket_id, status FROM tickets
     WHERE org_id = $1 AND category = 'threat_auto' AND $2 = ANY(reported_players)
     ORDER BY created_at DESC LIMIT 1`,
    [orgId, steamId],
  );

  let ticketId;
  let reactivated = false;
  if (existing.rows[0]) {
    ticketId = Number(existing.rows[0].ticket_id);
    if (existing.rows[0].status === "closed") {
      reactivated = true;
      await pool.query(
        `UPDATE tickets SET status = 'open', updated_at = unix_now(), closed_at = NULL
         WHERE ticket_id = $1`,
        [ticketId],
      );
    } else {
      await pool.query(
        `UPDATE tickets SET updated_at = unix_now() WHERE ticket_id = $1`,
        [ticketId],
      );
    }
    await pool.query(
      `INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal)
       VALUES ($1, NULL, $2, TRUE)`,
      [ticketId, note],
    );
    await pool.query(
      `INSERT INTO ticket_audit_log (ticket_id, user_id, action, details)
       VALUES ($1, NULL, 'threat_trigger', $2)`,
      [ticketId, JSON.stringify({ reasons, reactivated })],
    );
  } else {
    const title = `Auto: suspicious player ${displayName ?? steamId}`.slice(
      0,
      255,
    );
    const ticketTypeId = await resolveReportTicketTypeId(orgId);
    const ins = await pool.query(
      `INSERT INTO tickets (org_id, ticket_type_id, created_by, status, priority, category, title, reported_players)
       VALUES ($1, $2, NULL, 'open', 'high', 'threat_auto', $3, $4)
       RETURNING ticket_id`,
      [orgId, ticketTypeId, title, [steamId]],
    );
    ticketId = Number(ins.rows[0].ticket_id);
    await pool.query(
      `INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal)
       VALUES ($1, NULL, $2, TRUE)`,
      [ticketId, note],
    );
    await pool.query(
      `INSERT INTO ticket_audit_log (ticket_id, user_id, action, details)
       VALUES ($1, NULL, 'threat_trigger_created', $2)`,
      [ticketId, JSON.stringify({ reasons })],
    );
  }

  try {
    const ticket = await loadTicketFromDb(ticketId);
    if (ticket) await cacheTicket(ticket);
  } catch {
    /* cache refresh best-effort */
  }

  return { ticketId, reactivated };
}

// Main entry point. Best-effort: logs and swallows errors so it never breaks the
// calling request (player refresh / F7 ingest). `source` is for logging only.
export async function evaluateThreatTriggers(
  orgId,
  steamId,
  source = "unknown",
) {
  try {
    if (!orgId || !steamId) return null;
    const config = await getThreatTriggerConfig(orgId);
    // No saved config → feature is effectively off for this org.
    if (!config) return null;

    const data = await computePlayerFacts(orgId, steamId);
    if (!data) return null;

    const result = evaluateConfig(config, data);
    if (!result.fired) return null;

    const ticket = await openOrReactivateTicket(
      orgId,
      steamId,
      data.displayName,
      result.reasons,
    );
    console.log(
      `[threat-trigger] ${source}: org=${orgId} steam=${steamId} → ticket #${ticket.ticketId} (${result.reasons.join("; ")})`,
    );
    return { ...ticket, reasons: result.reasons };
  } catch (err) {
    console.error(
      `[threat-trigger] evaluation failed (${source}) for ${steamId}:`,
      err?.message ?? err,
    );
    return null;
  }
}

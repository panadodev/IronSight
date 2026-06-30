// Player data layer: BattleMetrics + Steam + Proxycheck fetchers, alt-detection
// scoring, the Postgres/Redis player cache, and the refreshPlayerData
// orchestrator. Depends on the external-fetch and runtime modules.

import { decryptIp, encryptIp, ipHmac } from "./crypto-keys.js";
import {
  availableKeyOrgsByService,
  bmFetch,
  getAvailableExternalKeys,
  proxycheckApiFetch,
  steamApiFetch,
} from "./external-fetch.js";
import { pool, redis } from "./runtime.js";

// Convert an external (ISO 8601) date string to Unix seconds, or null when the
// value is missing or unparseable. Guards against `NaN` from a malformed
// timestamp flowing into BIGINT columns (which would error the whole upsert).
export function toUnixOrNull(value) {
  if (value == null || value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// ── Player data fetchers ──────────────────────────────────────────────────────

const RUST_APP_ID = 252490;
// Safety cap on BattleMetrics activity pagination. A high-activity player can
// otherwise loop indefinitely on links.next, burning the org's rotating API
// quota and memory. 15 pages × 1000 events is far more than any moderation use
// of the report/PVP counts needs.
const BM_ACTIVITY_MAX_PAGES = 15;
const AIM_SERVER_KEYWORDS = ["ukn", "aim"];
const RELATED_PROFILE_WARM_LIMIT = (() => {
  const parsed = Number.parseInt(
    process.env.RELATED_PROFILE_WARM_LIMIT ?? "8",
    10,
  );
  if (!Number.isFinite(parsed)) return 8;
  return Math.min(50, Math.max(0, parsed));
})();

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

  let json;
  try {
    json = await resp.json();
  } catch {
    console.warn(`[player:bm] JSON parse error resolving steamId=${steamId}`);
    return null;
  }
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
  const [summaryResp, playtimeResp, bansResp] = await Promise.all([
    steamApiFetch(orgId, "/ISteamUser/GetPlayerSummaries/v0002/", {
      steamids: steamId,
    }),
    steamApiFetch(orgId, "/IPlayerService/GetOwnedGames/v0001/", {
      steamid: steamId,
      include_appinfo: "0",
      include_played_free_games: "0",
    }),
    steamApiFetch(orgId, "/ISteamUser/GetPlayerBans/v1/", {
      steamids: steamId,
    }),
  ]);

  let displayName = null,
    avatarUrl = null,
    profileVisibility = null,
    profileCreatedAt = null,
    summaryOk = false;

  if (summaryResp?.ok) {
    try {
      const json = await summaryResp.json();
      const p = json.response?.players?.[0];
      if (p) {
        summaryOk = true;
        displayName = p.personaname ?? null;
        avatarUrl = p.avatarmedium ?? null;
        // profilestate is absent (undefined) for unconfigured accounts, not 0.
        // Treat any falsy value as "not configured" so we don't fall through
        // to communityvisibilitystate=3 (which Steam still returns) and show "Public".
        const visState = p.profilestate ? (p.communityvisibilitystate ?? 1) : 0;
        profileVisibility =
          {
            0: "Not Configured",
            1: "Private",
            2: "Friends Only",
            3: "Public",
          }[visState] ?? "Private";
        profileCreatedAt = p.timecreated ?? null;
      }
    } catch {
      console.warn(`[player:steam] summary JSON parse error for ${steamId}`);
    }
  }

  let rustHours = null,
    hoursPublic = false;
  if (playtimeResp?.ok) {
    try {
      const json = await playtimeResp.json();
      const games = json.response?.games;
      if (games?.length) {
        hoursPublic = true;
        const rust = games.find((g) => g.appid === RUST_APP_ID);
        if (rust)
          rustHours = Math.round((rust.playtime_forever / 60) * 10) / 10;
      }
    } catch {
      console.warn(`[player:steam] playtime JSON parse error for ${steamId}`);
    }
  }

  // Steam GetPlayerBans — VAC/game/community/economy bans across all of Steam.
  // Always present for a valid SteamID64 (does not depend on profile privacy).
  let bans = null;
  if (bansResp?.ok) {
    try {
      const json = await bansResp.json();
      const b = json.players?.[0];
      if (b) {
        bans = {
          vacBanned: Boolean(b.VACBanned),
          vacCount: Number(b.NumberOfVACBans ?? 0),
          gameBanCount: Number(b.NumberOfGameBans ?? 0),
          daysSinceLastBan: Number(b.DaysSinceLastBan ?? 0),
          communityBanned: Boolean(b.CommunityBanned),
          economyBan: b.EconomyBan ?? null,
        };
      }
    } catch {
      console.warn(`[player:steam] bans JSON parse error for ${steamId}`);
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
    bans,
  };
}

async function fetchBMPlayerData(bmId, orgId) {
  const url =
    `https://api.battlemetrics.com/players/${encodeURIComponent(bmId)}` +
    `?include=server,identifier&fields[server]=name,ip,port`;
  const resp = await bmFetch(orgId, url);
  if (!resp?.ok) return null;

  let json;
  try {
    json = await resp.json();
  } catch {
    console.warn(
      `[player:bm] JSON parse error fetching player data bmId=${bmId}`,
    );
    return null;
  }
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
      lastSeen: toUnixOrNull(entry.meta?.lastSeen),
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
    bmProfileCreatedAt: toUnixOrNull(json.data?.attributes?.createdAt),
    bmPrivate: json.data?.attributes?.private ?? false,
    bmRustHours: Math.round(bmRustHours * 10) / 10,
    bmAimtrainHours: Math.round(bmAimtrainHours * 10) / 10,
    bmServerCount: serverCount,
    bmRustBansCount: rustBans?.count ?? 0,
    bmRustBansLastBan: toUnixOrNull(rustBans?.lastBan),
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

  let data;
  try {
    data = await resp.json();
  } catch {
    console.warn(
      `[player:bm] JSON parse error fetching related identifiers bmId=${bmId}`,
    );
    return { ips: [], relatedPlayers: [] };
  }
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

  let data;
  try {
    data = await resp.json();
  } catch {
    console.warn(`[player:bm] JSON parse error fetching bans bmId=${bmId}`);
    return [];
  }
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
      expiresAt: toUnixOrNull(ban.attributes?.expires),
      bannedAt: toUnixOrNull(ban.attributes?.timestamp),
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
  let pages = 0;
  const activities = [];
  while (nextUrl && pages < BM_ACTIVITY_MAX_PAGES) {
    const resp = await bmFetch(orgId, nextUrl);
    if (!resp?.ok) break;
    let json;
    try {
      json = await resp.json();
    } catch {
      console.warn(
        `[player:bm] JSON parse error fetching activity bmId=${bmId}`,
      );
      break;
    }
    activities.push(...(json.data ?? []));
    nextUrl = json.links?.next ?? null;
    pages++;
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
  const resp = await steamApiFetch(
    orgId,
    "/ISteamUser/GetFriendList/v0001/",
    { steamid: steamId, relationship: "friend" },
    { privacyAware: true },
  );

  if (!resp || resp.status === 401 || resp.status === 403) {
    return { isPublic: false, friends: null };
  }
  if (!resp.ok) return { isPublic: false, friends: null };

  let json;
  try {
    json = await resp.json();
  } catch {
    return { isPublic: false, friends: null };
  }
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
  const resp = await steamApiFetch(
    orgId,
    "/ISteamUser/GetUserGroupList/v1/",
    { steamid: steamId },
    { privacyAware: true },
  );
  if (!resp?.ok) return null;
  const json = await resp.json().catch(() => null);
  if (!json?.response?.success) return null;
  return (json.response.groups ?? []).map((g) => String(g.gid));
}

// Returns recent BM session windows [{bmServerId, startedAt, stoppedAt}] for a
// player, used to compute temporal co-presence with the subject. Capped to avoid
// pulling a player's entire history.
async function fetchBMSessions(
  bmId,
  orgId,
  { maxPages = 5, sinceUnix = null } = {},
) {
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
      const start = toUnixOrNull(s.attributes?.start);
      const stop = toUnixOrNull(s.attributes?.stop);
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
        eacLastBan: toUnixOrNull(rustBans?.lastBan),
      };
    }),
  );

  return settled
    .filter((r) => {
      if (r.status === "rejected") {
        console.warn(
          `[player] related account fetch error: ${r.reason?.message}`,
        );
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
    return {
      verdict: "inconclusive",
      sharedServers: 0,
      altSessions: 0,
      overlapping: 0,
      ratio: 0,
    };

  let altSessions = 0;
  let overlapping = 0;
  for (const srv of sharedServers) {
    const sw = subjByServer.get(srv);
    for (const a of altByServer.get(srv)) {
      altSessions++;
      const aStart = a.startedAt;
      const aStop = a.stoppedAt ?? a.startedAt;
      if (
        sw.some(
          (s) => s.startedAt <= aStop && aStart <= (s.stoppedAt ?? s.startedAt),
        )
      )
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

  const shortIpHash = (ipHash) =>
    String(ipHash ?? "")
      .replace(/[^a-f0-9]/gi, "")
      .slice(0, 8)
      .toUpperCase();

  const sharedIps = (alt.sharedIps ?? []).map((ip) => {
    const m = ipMetaByIp[ip] ?? {};
    const ipHash = ipHmac(ip);
    return {
      ipHash,
      ipHashShort: shortIpHash(ipHash),
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
  if (
    meta.proxy === "yes" ||
    t.includes("vpn") ||
    t.includes("proxy") ||
    t === "tor"
  )
    return "proxy_vpn";
  if (
    t.includes("hosting") ||
    t.includes("data center") ||
    t.includes("server")
  )
    return "hosting";
  if (t.includes("business")) return "business";
  if (t.includes("wireless") || t.includes("mobile") || t.includes("cellular"))
    return "mobile";
  if (t.includes("residential")) return "residential";
  return null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function normalizeCurrency(meta) {
  const cur = meta?.currency;
  if (typeof cur === "string") {
    const t = cur.trim();
    return t || null;
  }
  if (!cur || typeof cur !== "object") return null;
  const parts = [cur.name, cur.code, cur.symbol]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

function toBooleanOrNull(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return null;
    if (v === "yes" || v === "true" || v === "1") return true;
    if (v === "no" || v === "false" || v === "0") return false;
  }
  return null;
}

function classifyConnTypeFromRaw(typeRaw, detections) {
  const t = String(typeRaw ?? "").toLowerCase();
  if (
    detections?.proxy ||
    detections?.vpn ||
    t.includes("vpn") ||
    t.includes("proxy") ||
    t === "tor"
  )
    return "proxy_vpn";
  if (
    detections?.hosting ||
    t.includes("hosting") ||
    t.includes("data center") ||
    t.includes("server")
  )
    return "hosting";
  if (t.includes("business")) return "business";
  if (t.includes("wireless") || t.includes("mobile") || t.includes("cellular"))
    return "mobile";
  if (t.includes("residential")) return "residential";
  return null;
}

function normalizeProxycheckRecord(meta) {
  if (!meta || typeof meta !== "object") return null;

  const network =
    meta.network && typeof meta.network === "object" ? meta.network : {};
  const location =
    meta.location && typeof meta.location === "object" ? meta.location : {};
  const detections =
    meta.detections && typeof meta.detections === "object"
      ? meta.detections
      : {};
  const deviceEstimate =
    meta.device_estimate && typeof meta.device_estimate === "object"
      ? meta.device_estimate
      : {};
  const detectionHistory =
    meta.detection_history && typeof meta.detection_history === "object"
      ? meta.detection_history
      : {};
  const operator =
    meta.operator && typeof meta.operator === "object" ? meta.operator : {};

  const proxyFlag = toBooleanOrNull(detections.proxy);
  const vpnFlag = toBooleanOrNull(detections.vpn);
  const typeRaw = firstNonEmptyString(network.type, meta.type);
  const connType =
    classifyConnTypeFromRaw(typeRaw, {
      proxy: proxyFlag,
      vpn: vpnFlag,
      hosting: toBooleanOrNull(detections.hosting),
    }) ?? classifyConnType(meta);

  const lat = Number(location.latitude ?? meta.latitude);
  const lng = Number(location.longitude ?? meta.longitude);
  const confidenceNum = toInteger(detections.confidence ?? meta.confidence);

  return {
    isProxy: proxyFlag ?? meta.proxy === "yes",
    isVpn: vpnFlag ?? String(typeRaw ?? "").toLowerCase() === "vpn",
    connType,
    isp:
      firstNonEmptyString(
        network.provider,
        meta.isp,
        meta.provider,
        meta.organisation,
      ) ?? null,
    country: firstNonEmptyString(location.country_name, meta.country),
    isoCode: firstNonEmptyString(location.country_code, meta.isocode),
    asn: firstNonEmptyString(network.asn, meta.asn),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    rawType: typeRaw,
    riskScore: toInteger(detections.risk ?? meta.risk_score ?? meta.risk),
    riskConfidence:
      confidenceNum != null
        ? `Absolute, ${confidenceNum}%`
        : firstNonEmptyString(meta.risk_confidence, meta.confidence),
    estimate:
      toInteger(deviceEstimate.address) != null
        ? `${toInteger(deviceEstimate.address)} devices`
        : firstNonEmptyString(meta.estimate),
    lastUpdate: firstNonEmptyString(
      meta.last_updated,
      detections.last_seen,
      meta.last_update,
      meta.lastseen,
    ),
    hostname: firstNonEmptyString(network.hostname, meta.hostname),
    company: firstNonEmptyString(network.provider, meta.company),
    organization: firstNonEmptyString(
      network.organisation,
      meta.organisation,
      meta.organization,
      meta.org,
    ),
    addressRange: firstNonEmptyString(
      network.range,
      meta.range,
      meta.address_range,
      meta.cidr,
    ),
    city: firstNonEmptyString(location.city_name, meta.city),
    region: firstNonEmptyString(location.region_name, meta.region, meta.state),
    continent: firstNonEmptyString(location.continent_name, meta.continent),
    timezone: firstNonEmptyString(location.timezone, meta.timezone),
    postalCode: firstNonEmptyString(
      location.postal_code,
      meta.postal_code,
      meta.postcode,
      meta.zip,
    ),
    currency:
      normalizeCurrency({ currency: location.currency }) ??
      normalizeCurrency(meta),
    proxycheckData: {
      detections: {
        proxy: toBooleanOrNull(detections.proxy),
        vpn: toBooleanOrNull(detections.vpn),
        hosting: toBooleanOrNull(detections.hosting),
        anonymous: toBooleanOrNull(detections.anonymous),
        compromised: toBooleanOrNull(detections.compromised),
        scraper: toBooleanOrNull(detections.scraper),
        tor: toBooleanOrNull(detections.tor),
        firstSeen: firstNonEmptyString(detections.first_seen),
        lastSeen: firstNonEmptyString(detections.last_seen),
      },
      deviceEstimate: {
        address: toInteger(deviceEstimate.address),
        subnet: toInteger(deviceEstimate.subnet),
      },
      delist: {
        delisted: toBooleanOrNull(detectionHistory.delisted),
        delistDatetime: firstNonEmptyString(detectionHistory.delist_datetime),
      },
      operator: {
        name: firstNonEmptyString(operator.name),
        url: firstNonEmptyString(operator.url),
        anonymity: firstNonEmptyString(operator.anonymity),
        popularity: firstNonEmptyString(operator.popularity),
        services: Array.isArray(operator.services) ? operator.services : [],
        protocols: Array.isArray(operator.protocols) ? operator.protocols : [],
      },
    },
  };
}

function toInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function hasRichProxycheckDetails(row) {
  if (!row || typeof row !== "object") return false;
  return Boolean(
    row.proxycheck_json ||
    row.raw_type ||
    row.risk_score != null ||
    row.risk_confidence ||
    row.estimate ||
    row.last_update ||
    row.hostname ||
    row.company ||
    row.organization ||
    row.address_range ||
    row.city ||
    row.region ||
    row.continent ||
    row.timezone ||
    row.postal_code ||
    row.currency,
  );
}

async function runProxycheckForIps(ipList, orgId, options = {}) {
  if (!ipList.length) return {};
  const forceFetch = options?.forceFetch === true;

  // Hash the IPs for the cache query (ip_metadata is keyed by HMAC hash).
  // The in-memory results map stays keyed by plaintext IP so callers can
  // correlate results back to their BM/connect-event data without decrypting.
  const ipHashMap = Object.fromEntries(ipList.map((ip) => [ip, ipHmac(ip)]));
  const hashToIp = Object.fromEntries(ipList.map((ip) => [ipHmac(ip), ip]));

  const { rows: cachedRows } = await pool.query(
    `SELECT ip_hash, is_proxy, is_vpn, conn_type, isp, country, iso_code, asn,
            latitude, longitude, raw_type, risk_score, risk_confidence,
            estimate, last_update, hostname, company, organization,
            address_range, city, region, continent, timezone, postal_code,
            currency, proxycheck_json
     FROM ip_metadata
     WHERE ip_hash = ANY($1) AND cache_expires_at > unix_now()`,
    [Object.values(ipHashMap)],
  );

  const results = {};
  const staleRichDetailIps = new Set();
  for (const r of cachedRows) {
    const ip = hashToIp[r.ip_hash];
    if (!ip) continue;
    if (!hasRichProxycheckDetails(r)) staleRichDetailIps.add(ip);
    results[ip] = {
      isProxy: r.is_proxy,
      isVpn: r.is_vpn,
      connType: r.conn_type,
      isp: r.isp,
      country: r.country,
      isoCode: r.iso_code ?? null,
      asn: r.asn,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      rawType: r.raw_type ?? null,
      riskScore: r.risk_score != null ? Number(r.risk_score) : null,
      riskConfidence: r.risk_confidence ?? null,
      estimate: r.estimate ?? null,
      lastUpdate: r.last_update ?? null,
      hostname: r.hostname ?? null,
      company: r.company ?? null,
      organization: r.organization ?? null,
      addressRange: r.address_range ?? null,
      city: r.city ?? null,
      region: r.region ?? null,
      continent: r.continent ?? null,
      timezone: r.timezone ?? null,
      postalCode: r.postal_code ?? null,
      currency: r.currency ?? null,
      proxycheckData: r.proxycheck_json ?? null,
    };
  }

  const cachedIps = new Set(Object.keys(results));
  const uncachedIps = forceFetch
    ? ipList
    : ipList.filter((ip) => !cachedIps.has(ip) || staleRichDetailIps.has(ip));

  if (!uncachedIps.length) {
    console.log(
      `[proxycheck] org=${orgId} — all ${ipList.length} IP(s) served from cache`,
    );
    return results;
  }

  let classified = 0;
  let unknown = 0;
  for (let i = 0; i < uncachedIps.length; i += 100) {
    const chunk = uncachedIps.slice(i, i + 100);
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
      const normalized = normalizeProxycheckRecord(meta);
      if (!normalized) continue;
      const connType = normalized.connType;
      if (connType) classified++;
      else unknown++;
      results[ip] = normalized;
    }
  }
  console.log(
    `[proxycheck] org=${orgId} — ${cachedRows.length} cached + ${uncachedIps.length} fetched (${classified} classified, ${unknown} unknown type)`,
  );
  return results;
}

// ── Player Redis cache helpers ────────────────────────────────────────────────

export const playerRedisKey = (steamId) => `player:data:${steamId}`;
const playerFetchLock = (steamId) => `player:fetching:${steamId}`;
// Redis is a hot cache layer; PostgreSQL is the permanent store. 14-day TTL
// ensures Redis doesn't grow unboundedly while still serving most active players
// from cache. PostgreSQL cache_expires_at stays at 30 days (2592000 seconds).
const PLAYER_REDIS_TTL = 14 * 24 * 3600; // 14 days

export async function getPlayerDataFromRedis(steamId) {
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

export async function ensurePlayerCacheRow(steamId) {
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
       steam_profile_visibility = COALESCE($4, steam_profile_visibility),
       steam_profile_created_at = COALESCE($5, steam_profile_created_at),
       steam_rust_hours         = CASE WHEN $6 THEN $7::NUMERIC ELSE NULL END,
       steam_data_public        = $6,
       steam_vac_banned          = COALESCE($8, steam_vac_banned),
       steam_vac_count           = COALESCE($9, steam_vac_count),
       steam_game_ban_count      = COALESCE($10, steam_game_ban_count),
       steam_days_since_last_ban = COALESCE($11, steam_days_since_last_ban),
       steam_community_banned    = COALESCE($12, steam_community_banned),
       steam_economy_ban         = COALESCE($13, steam_economy_ban),
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
      data.bans?.vacBanned ?? null,
      data.bans?.vacCount ?? null,
      data.bans?.gameBanCount ?? null,
      data.bans?.daysSinceLastBan ?? null,
      data.bans?.communityBanned ?? null,
      data.bans?.economyBan ?? null,
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

async function writeGroupsToCache(steamId, groups) {
  await pool.query(
    `UPDATE player_cache SET steam_groups = $2 WHERE steam_id = $1`,
    [steamId, JSON.stringify(groups)],
  );
}

// Keep one row per conflict key so a bulk INSERT ... ON CONFLICT DO UPDATE never
// receives the same target row twice ("cannot affect row a second time"). Later
// occurrences win, matching EXCLUDED-overwrite semantics.
function dedupBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) m.set(keyFn(item), item);
  return [...m.values()];
}

async function writeBMSessionsToCache(steamId, sessions) {
  const rows = dedupBy(sessions, (s) => s.bmServerId);
  if (!rows.length) return;
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
      rows.map((s) => s.bmServerId),
      rows.map((s) => s.serverName),
      rows.map((s) => s.hoursPlayed),
      rows.map((s) => s.lastSeen),
    ],
  );
}

async function writeBMBansToCache(steamId, bansInput, observedByOrg = null) {
  const bans = dedupBy(bansInput, (b) => b.bmBanId);
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

  // Record which of our orgs' BM keys saw these bans. Unlike the old global
  // cache (which clobbered on every refresh), this unions visibility per org so
  // an org with a wider ban-network view never overwrites another's.
  if (observedByOrg) {
    await pool.query(
      `INSERT INTO player_bm_ban_observations (bm_ban_id, org_id, steam_id, observed_at)
       SELECT unnest($1::text[]), $2, $3, unix_now()
       ON CONFLICT (bm_ban_id, org_id) DO UPDATE SET observed_at = unix_now()`,
      [bans.map((b) => b.bmBanId), observedByOrg, steamId],
    );
  }
}

async function writeIpsToHistory(steamId, ipsInput, sourceOrgId = null) {
  const ips = dedupBy(ipsInput, (x) => x.ip);
  if (!ips.length) return;
  const hashes = ips.map((x) => ipHmac(x.ip));
  const encrypted = ips.map((x) => encryptIp(x.ip));
  await pool.query(
    `INSERT INTO player_ip_history (steam_id, ip_hash, ip_encrypted, is_vpn, last_seen)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), unnest($4::boolean[]), unix_now()
     ON CONFLICT (steam_id, ip_hash) DO UPDATE SET
       last_seen = unix_now(),
       is_vpn    = COALESCE(EXCLUDED.is_vpn, player_ip_history.is_vpn)`,
    [ips.map(() => steamId), hashes, encrypted, ips.map((x) => x.isProxy)],
  );

  if (sourceOrgId) {
    await pool.query(
      `INSERT INTO player_ip_observations (steam_id, ip_hash, org_id, last_seen)
       SELECT unnest($1::text[]), unnest($2::text[]), $3, unix_now()
       ON CONFLICT (steam_id, ip_hash, org_id) DO UPDATE SET
         last_seen = unix_now()`,
      [ips.map(() => steamId), hashes, sourceOrgId],
    );
  }
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

async function warmRelatedProfilesCache(
  accounts,
  altDetails,
  steamOrg,
  sourceOrgId,
) {
  const NON_PROXY_CONN_TYPES = new Set(["residential", "business", "mobile"]);
  const detailsByKey = new Map();
  for (const detail of altDetails ?? []) {
    if (detail?.relatedSteamId) {
      detailsByKey.set(`steam:${String(detail.relatedSteamId)}`, detail);
    }
    if (detail?.relatedBmId) {
      detailsByKey.set(`bm:${String(detail.relatedBmId)}`, detail);
    }
  }

  const warmTargets = dedupBy(
    (accounts ?? [])
      .filter((a) => a?.nonProxyLinked && a?.relatedSteamId)
      .map((a) => ({
        steamId: String(a.relatedSteamId),
        bmId: a.relatedBmId ? String(a.relatedBmId) : null,
        relatedName: a.relatedName ?? null,
        sharedIps: (
          detailsByKey.get(`steam:${String(a.relatedSteamId)}`) ??
          detailsByKey.get(`bm:${String(a.relatedBmId ?? "")}`) ?? {
            sharedIps: [],
          }
        ).sharedIps,
        sharedIpMetaByHash: new Map(
          (a.sharedIps ?? [])
            .filter((row) => row?.ipHash)
            .map((row) => [String(row.ipHash), row]),
        ),
      })),
    (x) => x.steamId,
  ).slice(0, RELATED_PROFILE_WARM_LIMIT);

  if (!warmTargets.length) return;

  const settled = await Promise.allSettled(
    warmTargets.map(async (target) => {
      const nonProxySharedIpRows = (target.sharedIps ?? [])
        .map((ip) => {
          const hash = ipHmac(String(ip));
          const meta = target.sharedIpMetaByHash.get(hash);
          if (!NON_PROXY_CONN_TYPES.has(meta?.connType)) return null;
          return { ip: String(ip), isProxy: false };
        })
        .filter(Boolean);

      if (nonProxySharedIpRows.length) {
        await writeIpsToHistory(
          target.steamId,
          nonProxySharedIpRows,
          sourceOrgId,
        );
      }

      await ensurePlayerCacheRow(target.steamId);
      await pool.query(
        `UPDATE player_cache
         SET bm_id = COALESCE($2, bm_id),
             display_name = COALESCE($3, display_name),
             cache_expires_at = GREATEST(COALESCE(cache_expires_at, 0), unix_now() + 2592000)
         WHERE steam_id = $1`,
        [target.steamId, target.bmId, target.relatedName],
      );

      const steamData = await fetchSteamPlayerData(target.steamId, steamOrg);
      if (steamData.success) {
        await writeSteamDataToCache(target.steamId, steamData);
      }
    }),
  );

  const warmed = settled.filter((r) => r.status === "fulfilled").length;
  console.log(
    `[player:refresh] warmed ${warmed}/${warmTargets.length} non-proxy shared related profile cache row(s)`,
  );
}

async function writeSessionWindowsToCache(steamId, windows) {
  await pool.query(`DELETE FROM player_session_windows WHERE steam_id = $1`, [
    steamId,
  ]);
  const rows = dedupBy(windows, (w) => `${w.bmServerId}:${w.startedAt}`);
  if (!rows.length) return;
  await pool.query(
    `INSERT INTO player_session_windows (steam_id, bm_server_id, started_at, stopped_at)
     SELECT $1, unnest($2::text[]), unnest($3::bigint[]), unnest($4::bigint[])
     ON CONFLICT (steam_id, bm_server_id, started_at) DO NOTHING`,
    [
      steamId,
      rows.map((w) => w.bmServerId),
      rows.map((w) => w.startedAt),
      rows.map((w) => w.stoppedAt),
    ],
  );
}

async function writeFriendsToCache(steamId, result, orgId) {
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

  if (!result.isPublic) {
    // Account went private — purge stale friend rows so we don't serve
    // outdated relationship data from before privacy was enabled.
    await pool.query(`DELETE FROM player_friends WHERE steam_id = $1`, [
      steamId,
    ]);
    return;
  }
  if (!result.friends?.length) return;

  const friends = [...new Set(result.friends)];
  const nowUnix = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO player_friends (steam_id, friend_steam_id, last_confirmed)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::bigint[])
     ON CONFLICT (steam_id, friend_steam_id) DO UPDATE SET
       last_confirmed = EXCLUDED.last_confirmed`,
    [friends.map(() => steamId), friends, friends.map(() => nowUnix)],
  );

  // Batch-fetch Steam summaries for friends not yet cached so their display
  // names are available when enrichFriendsWithBans renders the friends list.
  if (!orgId) return;
  const { rows: cachedRows } = await pool.query(
    `SELECT steam_id FROM player_cache WHERE steam_id = ANY($1) AND display_name IS NOT NULL`,
    [friends],
  );
  const cachedSet = new Set(cachedRows.map((r) => String(r.steam_id)));
  const uncached = friends.filter((f) => !cachedSet.has(f));
  if (!uncached.length) return;

  // GetPlayerSummaries accepts up to 100 IDs per call.
  for (let i = 0; i < uncached.length; i += 100) {
    const batch = uncached.slice(i, i + 100);
    try {
      const resp = await steamApiFetch(
        orgId,
        "/ISteamUser/GetPlayerSummaries/v0002/",
        { steamids: batch.join(",") },
      );
      if (!resp?.ok) continue;
      const data = await resp.json();
      const players = data.response?.players ?? [];
      if (!players.length) continue;
      const ids = players.map((p) => String(p.steamid));
      const names = players.map((p) => p.personaname ?? null);
      const avatars = players.map((p) => p.avatarmedium ?? null);
      await pool.query(
        `INSERT INTO player_cache (steam_id, display_name, avatar_url)
         SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[])
         ON CONFLICT (steam_id) DO UPDATE SET
           display_name = COALESCE(EXCLUDED.display_name, player_cache.display_name),
           avatar_url   = COALESCE(EXCLUDED.avatar_url, player_cache.avatar_url)`,
        [ids, names, avatars],
      );
    } catch (err) {
      console.warn(
        `[player:friends-enrich] summary batch failed for ${steamId}: ${err.message}`,
      );
    }
  }
}

async function writeProxycheckToCache(ipResults) {
  for (const [ip, meta] of Object.entries(ipResults)) {
    const hash = ipHmac(ip);
    const enc = encryptIp(ip);
    await pool.query(
      `INSERT INTO ip_metadata (
         ip_hash, ip_encrypted, is_proxy, is_vpn, conn_type, isp, country,
         iso_code, asn, latitude, longitude, raw_type, risk_score,
         risk_confidence, estimate, last_update, hostname, company,
         organization, address_range, city, region, continent, timezone,
         postal_code, currency, proxycheck_json
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
         $20,$21,$22,$23,$24,$25,$26,$27
       )
       ON CONFLICT (ip_hash) DO UPDATE SET
         is_proxy  = $3, is_vpn = $4, conn_type = $5, isp = $6,
         country   = $7, iso_code = COALESCE($8, ip_metadata.iso_code), asn = $9,
         latitude  = COALESCE($10, ip_metadata.latitude),
         longitude = COALESCE($11, ip_metadata.longitude),
         raw_type = COALESCE($12, ip_metadata.raw_type),
         risk_score = COALESCE($13, ip_metadata.risk_score),
         risk_confidence = COALESCE($14, ip_metadata.risk_confidence),
         estimate = COALESCE($15, ip_metadata.estimate),
         last_update = COALESCE($16, ip_metadata.last_update),
         hostname = COALESCE($17, ip_metadata.hostname),
         company = COALESCE($18, ip_metadata.company),
         organization = COALESCE($19, ip_metadata.organization),
         address_range = COALESCE($20, ip_metadata.address_range),
         city = COALESCE($21, ip_metadata.city),
         region = COALESCE($22, ip_metadata.region),
         continent = COALESCE($23, ip_metadata.continent),
         timezone = COALESCE($24, ip_metadata.timezone),
         postal_code = COALESCE($25, ip_metadata.postal_code),
         currency = COALESCE($26, ip_metadata.currency),
         proxycheck_json = COALESCE($27, ip_metadata.proxycheck_json),
         cached_at = unix_now(),
         cache_expires_at = unix_now() + 15552000`,
      [
        hash,
        enc,
        meta.isProxy,
        meta.isVpn,
        meta.connType,
        meta.isp,
        meta.country,
        meta.isoCode ?? null,
        meta.asn,
        meta.latitude ?? null,
        meta.longitude ?? null,
        firstNonEmptyString(meta.rawType),
        toInteger(meta.riskScore),
        firstNonEmptyString(meta.riskConfidence),
        firstNonEmptyString(meta.estimate),
        firstNonEmptyString(meta.lastUpdate),
        firstNonEmptyString(meta.hostname),
        firstNonEmptyString(meta.company),
        firstNonEmptyString(meta.organization),
        firstNonEmptyString(meta.addressRange),
        firstNonEmptyString(meta.city),
        firstNonEmptyString(meta.region),
        firstNonEmptyString(meta.continent),
        firstNonEmptyString(meta.timezone),
        firstNonEmptyString(meta.postalCode),
        firstNonEmptyString(meta.currency),
        meta.proxycheckData ? JSON.stringify(meta.proxycheckData) : null,
      ],
    );
    await pool.query(
      `UPDATE player_ip_history SET is_vpn = $2 WHERE ip_hash = $1`,
      [hash, meta.isVpn],
    );
  }
}

// ── Main player refresh orchestrator ─────────────────────────────────────────

export async function refreshPlayerData(
  steamId,
  orgId,
  candidateOrgIds = null,
  options = {},
) {
  const forceProxycheckRefresh = options?.forceProxycheckRefresh === true;
  const locked = await acquirePlayerFetchLock(steamId);
  if (!locked) {
    console.log(`[player:refresh] ${steamId} — already in progress, skipping`);
    return;
  }

  // When the acting user belongs to several orgs, the selected org may have no
  // keys for a given service while a sibling org does. Resolve, per service, the
  // first candidate org (selected org preferred) that actually has an available
  // key — so a lookup from a key-less org still pulls intel from one that has
  // tokens. Falls back to the selected org when nothing has keys.
  const candidates = [
    ...new Set([orgId, ...(candidateOrgIds ?? [])].filter(Boolean).map(String)),
  ];
  const keyOrgs = await availableKeyOrgsByService(candidates);
  const pickOrg = (service) =>
    candidates.find((o) => keyOrgs[service]?.has(o)) ?? orgId;
  const steamOrg = pickOrg("steam");
  const bmOrg = pickOrg("battlemetrics");
  const proxyOrg = pickOrg("proxycheck");

  console.log(
    `[player:refresh] ${steamId} org=${orgId} — starting (steam=${steamOrg} bm=${bmOrg} proxy=${proxyOrg})`,
  );

  try {
    const [steamData, bmIdResult] = await Promise.all([
      fetchSteamPlayerData(steamId, steamOrg),
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
        `[player:refresh] ${steamId} — steam fetch failed (no steam key for org ${steamOrg}?)`,
      );
      await ensurePlayerCacheRow(steamId);
    }

    if (!bmId) {
      bmId = await findBMIdBySteamId(steamId, bmOrg);
      if (bmId) {
        console.log(`[player:refresh] ${steamId} — resolved bmId=${bmId}`);
      } else {
        console.warn(
          `[player:refresh] ${steamId} — BM ID not found (no BM key for org ${bmOrg}? player not in BM?)`,
        );
      }
    }

    let bmData = null;
    let relIdentifiers = { ips: [], relatedPlayers: [] };

    if (bmId) {
      // Profile + related identifiers are intrinsic to the player (same whatever
      // token asks), so fetch them once with the primary BM org.
      const [bmDataResult, relResult] = await Promise.allSettled([
        fetchBMPlayerData(bmId, bmOrg),
        fetchBMRelatedIdentifiers(bmId, bmOrg),
      ]);

      if (bmDataResult.status === "rejected")
        console.warn(
          `[player:refresh] ${steamId} — BM player data failed: ${bmDataResult.reason?.message}`,
        );
      if (relResult.status === "rejected")
        console.warn(
          `[player:refresh] ${steamId} — BM related identifiers failed: ${relResult.reason?.message}`,
        );

      bmData = bmDataResult.status === "fulfilled" ? bmDataResult.value : null;
      relIdentifiers =
        relResult.status === "fulfilled"
          ? (relResult.value ?? { ips: [], relatedPlayers: [] })
          : { ips: [], relatedPlayers: [] };

      if (bmData) {
        await writeBMDataToCache(steamId, bmId, bmData);
        await writeBMSessionsToCache(steamId, bmData.sessions);
      }
      await writeIpsToHistory(steamId, relIdentifiers.ips, orgId);

      // Pool external-ban visibility across every candidate org that has a BM
      // key. Different tokens subscribe to different ban networks, so we query
      // each and write its result tagged with that org (the observations table),
      // unioning coverage instead of letting one key clobber another's view.
      // Fetch in parallel, persist sequentially to avoid concurrent upserts onto
      // the same ban rows.
      const bmKeyOrgs = [...(keyOrgs.battlemetrics ?? new Set())];
      const poolOrgs = bmKeyOrgs.length ? bmKeyOrgs : [bmOrg].filter(Boolean);
      const fetched = await Promise.allSettled(
        poolOrgs.map((po) =>
          fetchBMPlayerBans(bmId, po).then((bans) => ({
            po,
            bans: bans ?? [],
          })),
        ),
      );
      let totalBans = 0;
      for (const r of fetched) {
        if (r.status !== "fulfilled") {
          console.warn(
            `[player:refresh] ${steamId} — pooled BM bans failed: ${r.reason?.message}`,
          );
          continue;
        }
        await writeBMBansToCache(steamId, r.value.bans, r.value.po);
        totalBans += r.value.bans.length;
      }

      console.log(
        `[player:refresh] ${steamId} bmId=${bmId} — bmData ok=${!!bmData} ips=${relIdentifiers.ips.length} relatedPlayers=${relIdentifiers.relatedPlayers.length} bans=${totalBans} across ${poolOrgs.length} org(s)`,
      );
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

    // Pull ALL IPs from our own records so they feed proxycheck and alt-scoring
    // context — BM may not have returned them (e.g. no BM ID, or BM hasn't seen
    // the connection). runProxycheckForIps serves cached entries from ip_metadata
    // without hitting the API, so including already-cached IPs here is safe.
    const ownIpRows = await pool.query(
      `SELECT ip_encrypted FROM player_ip_history WHERE steam_id = $1`,
      [steamId],
    );
    const bmIpSet = new Set(ipsOnly);
    for (const row of ownIpRows.rows) {
      const plain = decryptIp(row.ip_encrypted);
      if (plain && !bmIpSet.has(plain)) ipsOnly.push(plain);
    }

    const sinceUnix = Math.floor(Date.now() / 1000) - 90 * 86400;
    try {
      // Phase A: subject-side enrichment. Proxycheck (IP classification),
      // friends, groups and session windows are all inputs to the alt scoring
      // that follows, so they must complete first.
      const [subjectFriends, , ipResults, subjectGroups, subjectWindows] =
        await Promise.all([
          fetchSteamFriends(steamId, steamOrg),
          bmId
            ? fetchBMActivity(bmId, bmOrg).then((r) =>
                writeActivityToCache(steamId, r),
              )
            : Promise.resolve(null),
          ipsOnly.length
            ? runProxycheckForIps(ipsOnly, proxyOrg, {
                forceFetch: forceProxycheckRefresh,
              })
            : Promise.resolve({}),
          fetchSteamGroups(steamId, steamOrg),
          // Grab the subject's COMPLETE session history (not just the recent
          // co-presence window) and cache all of it. refreshPlayerData is
          // fire-and-forget, so the extra BattleMetrics pages don't block the
          // request. maxPages is a generous safety cap (100 pages × 100 =
          // 10k sessions) — more than any realistic player has.
          bmId
            ? fetchBMSessions(bmId, bmOrg, { maxPages: 100, sinceUnix: null })
            : Promise.resolve([]),
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

      // Also persist clean shared-IP links when Proxycheck has no usable row.
      // This preserves non-proxy shared-IP evidence in ip_metadata/player_ip_history
      // on refresh instead of only caching proxy-marked links.
      const bmProxyByIp = new Map(
        relIdentifiers.ips
          .filter((x) => x?.ip)
          .map((x) => [x.ip, x.isProxy === true]),
      );
      const relatedSharedIps = new Set(
        (relIdentifiers.relatedPlayers ?? []).flatMap((rel) =>
          Array.isArray(rel?.sharedIps) ? rel.sharedIps : [],
        ),
      );
      for (const ip of relatedSharedIps) {
        if (!ip || bmProxyByIp.get(ip) === true) continue;
        const existing = ipResults[ip];
        if (!existing) {
          ipResults[ip] = {
            isProxy: false,
            isVpn: false,
            connType: null,
            isp: null,
            country: null,
            asn: null,
          };
        } else {
          if (existing.isProxy == null) existing.isProxy = false;
          if (existing.isVpn == null) existing.isVpn = false;
        }
      }

      await Promise.all([
        writeFriendsToCache(steamId, subjectFriends, steamOrg),
        writeProxycheckToCache(ipResults),
        writeSessionWindowsToCache(steamId, subjectWindows),
        subjectGroups
          ? writeGroupsToCache(steamId, subjectGroups)
          : Promise.resolve(),
      ]);

      // Phase B: per-alt enrichment + evidence scoring against the subject.
      if (bmId && relIdentifiers.relatedPlayers.length) {
        const altDetails = await fetchRelatedAccountDetails(
          relIdentifiers.relatedPlayers,
          bmOrg,
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
        await warmRelatedProfilesCache(scored, altDetails, steamOrg, orgId);
      }
    } catch (err) {
      console.error(
        `[player:refresh] ${steamId} — background task error: ${err.message}`,
      );
    }

    // BM data missing this run (player not in BattleMetrics yet, or a transient
    // BM/key outage). The Steam write above pushed cache_expires_at out 30 days,
    // which would suppress any BM re-attempt for a month even though `is_stale`
    // is what gates the background refresh. Shorten the window so the next view
    // re-refreshes within a few days and can pick up BM data once it appears.
    if (!bmData) {
      await pool.query(
        `UPDATE player_cache
           SET cache_expires_at = LEAST(cache_expires_at, unix_now() + 3 * 86400)
         WHERE steam_id = $1`,
        [steamId],
      );
    }

    await writePlayerDataToRedis(steamId);
    console.log(
      `[player:refresh] ${steamId} — background tasks done, Redis updated`,
    );
  } catch (err) {
    console.error(
      `[player:refresh] ${steamId} — refresh failed: ${err.message}`,
    );
  } finally {
    await releasePlayerFetchLock(steamId);
  }
}

// Attach ban status to a player's friends list using only data we already cache
// locally (no external fetches). Surfaces "this player is friends with known
// cheaters" — a strong teaming/alt signal. Banned friends are sorted first.
async function enrichFriendsWithBans(friendIds) {
  if (!friendIds?.length) return [];
  const { rows } = await pool.query(
    `SELECT steam_id, display_name, avatar_url,
            bm_rust_bans_banned, steam_vac_banned, steam_vac_count,
            steam_game_ban_count
     FROM player_cache WHERE steam_id = ANY($1)`,
    [friendIds],
  );
  const byId = new Map(rows.map((r) => [String(r.steam_id), r]));
  const enriched = friendIds.map((fid) => {
    const r = byId.get(fid);
    const banSources = [];
    if (r) {
      if (r.bm_rust_bans_banned) banSources.push("eac");
      if (r.steam_vac_banned && (r.steam_vac_count ?? 0) > 0)
        banSources.push("vac");
      if ((r.steam_game_ban_count ?? 0) > 0) banSources.push("game");
    }
    return {
      steamId: fid,
      displayName: r?.display_name ?? null,
      avatarUrl: r?.avatar_url ?? null,
      banned: banSources.length > 0,
      banSources,
      cached: Boolean(r),
    };
  });
  // Banned first, then friends we have any cached data for, then the rest.
  enriched.sort((a, b) => {
    if (a.banned !== b.banned) return a.banned ? -1 : 1;
    if (a.cached !== b.cached) return a.cached ? -1 : 1;
    return 0;
  });
  return enriched;
}

export async function getPlayerCacheData(steamId) {
  const [
    profile,
    sessions,
    bans,
    friendsMeta,
    ips,
    ipConnectionEvents,
    related,
    sessionWindows,
  ] = await Promise.all([
    pool.query(
      `SELECT *, cache_expires_at < unix_now() AS is_stale
         FROM player_cache WHERE steam_id = $1`,
      [steamId],
    ),
    pool.query(
      `SELECT bm_server_id, server_name, hours_played, last_seen
         FROM player_bm_sessions WHERE steam_id = $1
         ORDER BY last_seen DESC NULLS LAST`,
      [steamId],
    ),
    pool.query(
      `SELECT b.bm_ban_id, b.bm_org_id, b.bm_org_name, b.reason, b.note,
                b.expires_at, b.banned_at, b.permanent, b.cached_at,
                COALESCE(
                  (SELECT array_agg(DISTINCT o.org_id)
                   FROM player_bm_ban_observations o
                   WHERE o.bm_ban_id = b.bm_ban_id),
                  '{}'
                ) AS source_org_ids
         FROM player_bm_bans_cache b WHERE b.steam_id = $1
         ORDER BY b.banned_at DESC NULLS LAST`,
      [steamId],
    ),
    pool.query(
      `SELECT friends_public, friend_count, cached_at, cache_expires_at
         FROM player_friends_meta WHERE steam_id = $1`,
      [steamId],
    ),
    pool.query(
      `SELECT pih.ip_hash, pih.is_vpn, pih.server_name, pih.first_seen, pih.last_seen,
                im.is_proxy, im.conn_type, im.isp, im.country, im.iso_code, im.asn,
                im.latitude, im.longitude,
                im.raw_type, im.risk_score, im.risk_confidence, im.estimate,
                im.last_update, im.hostname, im.company, im.organization,
                im.address_range, im.city, im.region, im.continent, im.timezone,
                im.postal_code, im.currency, im.proxycheck_json,
                COALESCE(
                  (SELECT array_agg(DISTINCT o.org_id)
                   FROM player_ip_observations o
                   WHERE o.steam_id = pih.steam_id
                     AND o.ip_hash = pih.ip_hash),
                  '{}'
                ) AS source_org_ids
         FROM player_ip_history pih
         LEFT JOIN ip_metadata im ON im.ip_hash = pih.ip_hash
         WHERE pih.steam_id = $1
         ORDER BY pih.last_seen DESC`,
      [steamId],
    ),
    pool.query(
      `SELECT ip_hash, seen_at, server_name
         FROM player_ip_connection_events
         WHERE steam_id = $1
         ORDER BY seen_at DESC
         LIMIT 2000`,
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
    // Raw session windows for the activity timeline — the 500 most recent
    // across the player's full cached history (no time cap). server_name is
    // joined from the per-server totals table for display.
    pool.query(
      `SELECT psw.bm_server_id, psw.started_at, psw.stopped_at, pbs.server_name
         FROM player_session_windows psw
         LEFT JOIN player_bm_sessions pbs
           ON pbs.steam_id = psw.steam_id AND pbs.bm_server_id = psw.bm_server_id
         WHERE psw.steam_id = $1
         ORDER BY psw.started_at DESC
         LIMIT 500`,
      [steamId],
    ),
  ]);

  const p = profile.rows[0] ?? null;
  if (!p) return null;

  const friendsMetaRow = friendsMeta.rows[0] ?? null;
  let friendsList = null;
  let friendsEnriched = null;
  if (friendsMetaRow?.friends_public) {
    const fr = await pool.query(
      `SELECT friend_steam_id FROM player_friends WHERE steam_id = $1`,
      [steamId],
    );
    friendsList = fr.rows.map((r) => String(r.friend_steam_id));
    friendsEnriched = await enrichFriendsWithBans(friendsList);
  }

  const ipConnectionEventsByHash = new Map();
  for (const row of ipConnectionEvents.rows) {
    const hash = String(row.ip_hash ?? "");
    if (!hash) continue;
    if (!ipConnectionEventsByHash.has(hash)) {
      ipConnectionEventsByHash.set(hash, []);
    }
    ipConnectionEventsByHash.get(hash).push({
      seenAt: row.seen_at != null ? Number(row.seen_at) : null,
      serverName: row.server_name ?? null,
    });
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
      vacBanned:
        p.steam_vac_banned != null ? Boolean(p.steam_vac_banned) : null,
      vacCount: p.steam_vac_count != null ? Number(p.steam_vac_count) : null,
      gameBanCount:
        p.steam_game_ban_count != null ? Number(p.steam_game_ban_count) : null,
      daysSinceLastBan:
        p.steam_days_since_last_ban != null
          ? Number(p.steam_days_since_last_ban)
          : null,
      communityBanned:
        p.steam_community_banned != null
          ? Boolean(p.steam_community_banned)
          : null,
      economyBan: p.steam_economy_ban ?? null,
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
      sourceOrgIds: Array.isArray(r.source_org_ids)
        ? r.source_org_ids.map(String)
        : [],
      connectionHistory: ipConnectionEventsByHash.get(String(r.ip_hash)) ?? [],
    })),
    friends: {
      public: friendsMetaRow?.friends_public ?? null,
      friendCount: friendsMetaRow?.friend_count ?? null,
      friends: friendsList,
      enriched: friendsEnriched,
      wasPublic: friendsMetaRow
        ? !friendsMetaRow.friends_public && friendsList !== null
        : false,
      cachedAt: friendsMetaRow?.cached_at ?? null,
    },
    // Panel payloads only expose short, non-reversible IP hashes. Raw IPs stay
    // encrypted at rest and never leave the backend APIs.
    ipHistory: ips.rows.map((r) => ({
      ipHash: r.ip_hash,
      ipHashShort: String(r.ip_hash).slice(0, 8).toUpperCase(),
      isVpn: r.is_vpn ?? null,
      isProxy: r.is_proxy ?? null,
      connType: r.conn_type ?? null,
      isp: r.isp ?? null,
      country: r.country ?? null,
      isoCode: r.iso_code ?? null,
      asn: r.asn ?? null,
      latitude: r.latitude != null ? Number(r.latitude) : null,
      longitude: r.longitude != null ? Number(r.longitude) : null,
      rawType: r.raw_type ?? null,
      riskScore: r.risk_score != null ? Number(r.risk_score) : null,
      riskConfidence: r.risk_confidence ?? null,
      estimate: r.estimate ?? null,
      lastUpdate: r.last_update ?? null,
      hostname: r.hostname ?? null,
      company: r.company ?? null,
      organization: r.organization ?? null,
      addressRange: r.address_range ?? null,
      city: r.city ?? null,
      region: r.region ?? null,
      continent: r.continent ?? null,
      timezone: r.timezone ?? null,
      postalCode: r.postal_code ?? null,
      currency: r.currency ?? null,
      proxycheckData: r.proxycheck_json ?? null,
      serverName: r.server_name ?? null,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      sourceOrgIds: Array.isArray(r.source_org_ids)
        ? r.source_org_ids.map(String)
        : [],
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
      sharedIps: Array.isArray(r.shared_ips)
        ? r.shared_ips
            .map((s) => {
              if (!s || typeof s !== "object") return null;
              const ipHashFromRow =
                typeof s.ipHash === "string" && s.ipHash
                  ? s.ipHash
                  : typeof s.ip === "string" && s.ip
                    ? ipHmac(s.ip)
                    : null;
              if (!ipHashFromRow) return null;
              return {
                ipHash: ipHashFromRow,
                ipHashShort:
                  typeof s.ipHashShort === "string" && s.ipHashShort
                    ? String(s.ipHashShort)
                        .replace(/[^a-f0-9]/gi, "")
                        .slice(0, 8)
                        .toUpperCase()
                    : String(ipHashFromRow).slice(0, 8).toUpperCase(),
                connType: typeof s.connType === "string" ? s.connType : null,
                isp: typeof s.isp === "string" ? s.isp : null,
                asn: typeof s.asn === "string" ? s.asn : null,
                country: typeof s.country === "string" ? s.country : null,
              };
            })
            .filter(Boolean)
        : [],
      nonProxyLinked: r.non_proxy_linked ?? null,
      mutualFriends: r.mutual_friends ?? [],
      sharedGroups: r.shared_groups ?? [],
      serverOverlap: r.server_overlap ?? [],
      coPresence: r.co_presence ?? null,
      altConfidence: r.alt_confidence ?? null,
      cachedAt: r.cached_at,
    })),
    sessionWindows: sessionWindows.rows.map((r) => ({
      bmServerId: String(r.bm_server_id),
      serverName: r.server_name ?? null,
      startedAt: Number(r.started_at),
      stoppedAt: r.stopped_at != null ? Number(r.stopped_at) : null,
    })),
    isStale: Boolean(p.is_stale),
    cacheExpiresAt: p.cache_expires_at,
    steamGroups: Array.isArray(p.steam_groups)
      ? p.steam_groups.map(String)
      : [],
    flaggedGroups: await (async () => {
      const gids = Array.isArray(p.steam_groups)
        ? p.steam_groups.map(String)
        : [];
      if (!gids.length) return [];
      const { rows } = await pool.query(
        `SELECT gid, label, vanity FROM flagged_steam_groups WHERE gid = ANY($1)`,
        [gids],
      );
      return rows.map((r) => ({
        gid: String(r.gid),
        label: String(r.label),
        vanity: r.vanity ?? null,
      }));
    })(),
  };
}

// Resolve a Steam group vanity name to a 64-bit GID via the Steam XML API.
async function resolveGroupVanityToGid(vanity) {
  try {
    const res = await fetch(
      `https://steamcommunity.com/groups/${encodeURIComponent(vanity)}/memberslistxml/?xml=1`,
    );
    if (!res.ok) return null;
    const xml = await res.text();
    const m = xml.match(/<groupID64>(\d+)<\/groupID64>/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function seedFlaggedSteamGroups() {
  const toSeed = [
    {
      vanity: "archiasf",
      label: "Possible botted account (Archias Farming group)",
    },
  ];
  for (const { vanity, label } of toSeed) {
    try {
      const existing = await pool.query(
        `SELECT gid FROM flagged_steam_groups WHERE vanity = $1 LIMIT 1`,
        [vanity],
      );
      if (existing.rows.length > 0) continue;
      const gid = await resolveGroupVanityToGid(vanity);
      if (!gid) {
        console.warn(`[flagged-groups] Could not resolve GID for ${vanity}`);
        continue;
      }
      await pool.query(
        `INSERT INTO flagged_steam_groups (gid, label, vanity) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [gid, label, vanity],
      );
      console.log(`[flagged-groups] Seeded ${vanity} → gid ${gid}`);
    } catch (err) {
      console.warn(`[flagged-groups] Failed to seed ${vanity}: ${err.message}`);
    }
  }
}

// Player data layer: BattleMetrics + Steam + Proxycheck fetchers, alt-detection
// scoring, the Postgres/Redis player cache, and the refreshPlayerData
// orchestrator. Depends on the external-fetch and runtime modules.

import { pool, redis } from "./runtime.js";
import {
  bmFetch,
  steamApiFetch,
  proxycheckApiFetch,
  getAvailableExternalKeys,
} from "./external-fetch.js";

// ── Player data fetchers ──────────────────────────────────────────────────────

const RUST_APP_ID = 252490;
const AIM_SERVER_KEYWORDS = ["ukn", "aim"];

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

  const json = await resp.json();
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
    const json = await summaryResp.json();
    const p = json.response?.players?.[0];
    if (p) {
      summaryOk = true;
      displayName = p.personaname ?? null;
      avatarUrl = p.avatarmedium ?? null;
      const visState =
        p.profilestate === 0 ? 0 : (p.communityvisibilitystate ?? 1);
      profileVisibility =
        { 0: "Not Configured", 1: "Private", 2: "Private", 3: "Public" }[
          visState
        ] ?? "Private";
      profileCreatedAt = p.timecreated ?? null;
    }
  }

  let rustHours = null,
    hoursPublic = false;
  if (playtimeResp?.ok) {
    const json = await playtimeResp.json();
    const games = json.response?.games;
    if (games?.length) {
      hoursPublic = true;
      const rust = games.find((g) => g.appid === RUST_APP_ID);
      if (rust) rustHours = Math.round((rust.playtime_forever / 60) * 10) / 10;
    }
  }

  // Steam GetPlayerBans — VAC/game/community/economy bans across all of Steam.
  // Always present for a valid SteamID64 (does not depend on profile privacy).
  let bans = null;
  if (bansResp?.ok) {
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

  const json = await resp.json();
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
      lastSeen: entry.meta?.lastSeen
        ? Math.floor(new Date(entry.meta.lastSeen).getTime() / 1000)
        : null,
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
    bmProfileCreatedAt: json.data?.attributes?.createdAt
      ? Math.floor(new Date(json.data.attributes.createdAt).getTime() / 1000)
      : null,
    bmPrivate: json.data?.attributes?.private ?? false,
    bmRustHours: Math.round(bmRustHours * 10) / 10,
    bmAimtrainHours: Math.round(bmAimtrainHours * 10) / 10,
    bmServerCount: serverCount,
    bmRustBansCount: rustBans?.count ?? 0,
    bmRustBansLastBan: rustBans?.lastBan
      ? Math.floor(new Date(rustBans.lastBan).getTime() / 1000)
      : null,
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

  const data = await resp.json();
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
  const orgRes = await pool.query(
    "SELECT bm_ban_list_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  const bmBanListId = orgRes.rows[0]?.bm_ban_list_id ?? null;

  let url =
    `https://api.battlemetrics.com/bans` +
    `?version=%5E0.1.0&filter[player]=${encodeURIComponent(bmId)}` +
    `&include=organization&page[size]=100`;
  if (bmBanListId) {
    url += `&filter[banList]=${encodeURIComponent(bmBanListId)}`;
  }
  const resp = await bmFetch(orgId, url);
  if (!resp?.ok) return [];

  const data = await resp.json();
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
      expiresAt: ban.attributes?.expires
        ? Math.floor(new Date(ban.attributes.expires).getTime() / 1000)
        : null,
      bannedAt: ban.attributes?.timestamp
        ? Math.floor(new Date(ban.attributes.timestamp).getTime() / 1000)
        : null,
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
  const activities = [];
  while (nextUrl) {
    const resp = await bmFetch(orgId, nextUrl);
    if (!resp?.ok) break;
    const json = await resp.json();
    activities.push(...(json.data ?? []));
    nextUrl = json.links?.next ?? null;
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

  const json = await resp.json();
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
      const start = s.attributes?.start
        ? Math.floor(new Date(s.attributes.start).getTime() / 1000)
        : null;
      const stop = s.attributes?.stop
        ? Math.floor(new Date(s.attributes.stop).getTime() / 1000)
        : null;
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
        eacLastBan: rustBans?.lastBan
          ? Math.floor(new Date(rustBans.lastBan).getTime() / 1000)
          : null,
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

  const sharedIps = (alt.sharedIps ?? []).map((ip) => {
    const m = ipMetaByIp[ip] ?? {};
    return {
      ip,
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

async function runProxycheckForIps(ipList, orgId) {
  if (!ipList.length) return {};

  // Serve already-cached, non-expired entries from ip_metadata so we only
  // hit the Proxycheck API for IPs we haven't seen within the 30-day TTL.
  const { rows: cachedRows } = await pool.query(
    `SELECT ip_address, is_proxy, is_vpn, conn_type, isp, country, asn
     FROM ip_metadata
     WHERE ip_address = ANY($1) AND cache_expires_at > unix_now()`,
    [ipList],
  );

  const results = {};
  for (const r of cachedRows) {
    results[r.ip_address] = {
      isProxy: r.is_proxy,
      isVpn: r.is_vpn,
      connType: r.conn_type,
      isp: r.isp,
      country: r.country,
      asn: r.asn,
    };
  }

  const cachedIps = new Set(Object.keys(results));
  const uncachedIps = ipList.filter((ip) => !cachedIps.has(ip));

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
      const connType = classifyConnType(meta);
      if (connType) classified++;
      else unknown++;
      results[ip] = {
        isProxy: meta.proxy === "yes",
        isVpn: (meta.type ?? "") === "VPN",
        connType,
        // proxycheck's v2 ASN response uses `provider`/`organisation`, not `isp`.
        isp: meta.isp ?? meta.provider ?? meta.organisation ?? null,
        country: meta.country ?? null,
        asn: meta.asn ?? null,
      };
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
const PLAYER_REDIS_TTL = 30 * 24 * 3600; // 30 days — matches PostgreSQL cache_expires_at

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
       steam_rust_hours         = CASE WHEN $6 THEN $7 ELSE steam_rust_hours END,
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

async function writeBMBansToCache(steamId, bansInput) {
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
}

async function writeIpsToHistory(steamId, ipsInput) {
  const ips = dedupBy(ipsInput, (x) => x.ip);
  if (!ips.length) return;
  await pool.query(
    `INSERT INTO player_ip_history (steam_id, ip_address, is_vpn, last_seen)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::boolean[]), unix_now()
     ON CONFLICT (steam_id, ip_address) DO UPDATE SET
       last_seen = unix_now(),
       is_vpn    = COALESCE(EXCLUDED.is_vpn, player_ip_history.is_vpn)`,
    [ips.map(() => steamId), ips.map((x) => x.ip), ips.map((x) => x.isProxy)],
  );
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

async function writeSessionWindowsToCache(steamId, windows) {
  await pool.query(`DELETE FROM player_session_windows WHERE steam_id = $1`, [
    steamId,
  ]);
  if (!windows.length) return;
  await pool.query(
    `INSERT INTO player_session_windows (steam_id, bm_server_id, started_at, stopped_at)
     SELECT $1, unnest($2::text[]), unnest($3::bigint[]), unnest($4::bigint[])
     ON CONFLICT (steam_id, bm_server_id, started_at) DO NOTHING`,
    [
      steamId,
      windows.map((w) => w.bmServerId),
      windows.map((w) => w.startedAt),
      windows.map((w) => w.stoppedAt),
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

  if (!result.isPublic || !result.friends?.length) return;

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
    await pool.query(
      `INSERT INTO ip_metadata (ip_address, is_proxy, is_vpn, conn_type, isp, country, asn)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ip_address) DO UPDATE SET
         is_proxy  = $2, is_vpn = $3, conn_type = $4, isp = $5,
         country   = $6, asn = $7,
         cached_at = unix_now(),
         cache_expires_at = unix_now() + 2592000`,
      [
        ip,
        meta.isProxy,
        meta.isVpn,
        meta.connType,
        meta.isp,
        meta.country,
        meta.asn,
      ],
    );
    await pool.query(
      `UPDATE player_ip_history SET is_vpn = $2 WHERE ip_address = $1`,
      [ip, meta.isVpn],
    );
  }
}

// ── Main player refresh orchestrator ─────────────────────────────────────────

export async function refreshPlayerData(steamId, orgId) {
  const locked = await acquirePlayerFetchLock(steamId);
  if (!locked) {
    console.log(`[player:refresh] ${steamId} — already in progress, skipping`);
    return;
  }

  console.log(`[player:refresh] ${steamId} org=${orgId} — starting`);

  try {
    const [steamData, bmIdResult] = await Promise.all([
      fetchSteamPlayerData(steamId, orgId),
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
        `[player:refresh] ${steamId} — steam fetch failed (no steam key for org ${orgId}?)`,
      );
      await ensurePlayerCacheRow(steamId);
    }

    if (!bmId) {
      bmId = await findBMIdBySteamId(steamId, orgId);
      if (bmId) {
        console.log(`[player:refresh] ${steamId} — resolved bmId=${bmId}`);
      } else {
        console.warn(
          `[player:refresh] ${steamId} — BM ID not found (no BM key for org ${orgId}? player not in BM?)`,
        );
      }
    }

    let bmData = null;
    let relIdentifiers = { ips: [], relatedPlayers: [] };
    let bmBans = [];

    if (bmId) {
      [bmData, relIdentifiers, bmBans] = await Promise.all([
        fetchBMPlayerData(bmId, orgId),
        fetchBMRelatedIdentifiers(bmId, orgId),
        fetchBMPlayerBans(bmId, orgId),
      ]);

      console.log(
        `[player:refresh] ${steamId} bmId=${bmId} — bmData ok=${!!bmData} ips=${relIdentifiers.ips.length} relatedPlayers=${relIdentifiers.relatedPlayers.length} bans=${bmBans.length}`,
      );

      if (bmData) {
        await writeBMDataToCache(steamId, bmId, bmData);
        await writeBMSessionsToCache(steamId, bmData.sessions);
      }
      await writeIpsToHistory(steamId, relIdentifiers.ips);
      await writeBMBansToCache(steamId, bmBans);
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
    const sinceUnix = Math.floor(Date.now() / 1000) - 90 * 86400;
    try {
      // Phase A: subject-side enrichment. Proxycheck (IP classification),
      // friends, groups and session windows are all inputs to the alt scoring
      // that follows, so they must complete first.
      const [subjectFriends, , ipResults, subjectGroups, subjectWindows] =
        await Promise.all([
          fetchSteamFriends(steamId, orgId),
          bmId
            ? fetchBMActivity(bmId, orgId).then((r) =>
                writeActivityToCache(steamId, r),
              )
            : Promise.resolve(null),
          ipsOnly.length
            ? runProxycheckForIps(ipsOnly, orgId)
            : Promise.resolve({}),
          fetchSteamGroups(steamId, orgId),
          // Grab the subject's COMPLETE session history (not just the recent
          // co-presence window) and cache all of it. refreshPlayerData is
          // fire-and-forget, so the extra BattleMetrics pages don't block the
          // request. maxPages is a generous safety cap (100 pages × 100 =
          // 10k sessions) — more than any realistic player has.
          bmId
            ? fetchBMSessions(bmId, orgId, { maxPages: 100, sinceUnix: null })
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

      await Promise.all([
        writeFriendsToCache(steamId, subjectFriends, orgId),
        writeProxycheckToCache(ipResults),
        writeSessionWindowsToCache(steamId, subjectWindows),
      ]);

      // Phase B: per-alt enrichment + evidence scoring against the subject.
      if (bmId && relIdentifiers.relatedPlayers.length) {
        const altDetails = await fetchRelatedAccountDetails(
          relIdentifiers.relatedPlayers,
          orgId,
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
      }
    } catch (err) {
      console.error(
        `[player:refresh] ${steamId} — background task error: ${err.message}`,
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
  const [profile, sessions, bans, friendsMeta, ips, related, sessionWindows] =
    await Promise.all([
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
        `SELECT bm_ban_id, bm_org_id, bm_org_name, reason, note,
                expires_at, banned_at, permanent, cached_at
         FROM player_bm_bans_cache WHERE steam_id = $1
         ORDER BY banned_at DESC NULLS LAST`,
        [steamId],
      ),
      pool.query(
        `SELECT friends_public, friend_count, cached_at, cache_expires_at
         FROM player_friends_meta WHERE steam_id = $1`,
        [steamId],
      ),
      pool.query(
        `SELECT pih.ip_address, pih.is_vpn, pih.server_name, pih.first_seen, pih.last_seen,
                im.is_proxy, im.conn_type, im.isp, im.country, im.asn
         FROM player_ip_history pih
         LEFT JOIN ip_metadata im ON im.ip_address = pih.ip_address
         WHERE pih.steam_id = $1
         ORDER BY pih.last_seen DESC`,
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
    ipHistory: ips.rows.map((r) => ({
      ipAddress: String(r.ip_address),
      isVpn: r.is_vpn ?? null,
      isProxy: r.is_proxy ?? null,
      connType: r.conn_type ?? null,
      isp: r.isp ?? null,
      country: r.country ?? null,
      asn: r.asn ?? null,
      serverName: r.server_name ?? null,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
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
      sharedIps: r.shared_ips ?? [],
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
      startedAt: r.started_at,
      stoppedAt: r.stopped_at ?? null,
    })),
    isStale: Boolean(p.is_stale),
    cacheExpiresAt: p.cache_expires_at,
  };
}

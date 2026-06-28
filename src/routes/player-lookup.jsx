import { LENGTH_OPTIONS } from "@/components/ban-dialog";
import { ExternalBansSection } from "@/components/external-bans";
import { HINTS } from "@/components/hint";
import { LinkedAccountsSection } from "@/components/linked-accounts";
import { NewBanDialog } from "@/components/new-ban-dialog";
import { PlayerFriendsSection } from "@/components/player-friends";
import { PlayerLinks } from "@/components/player-links";
import { PlayerNotesSection } from "@/components/player-notes";
import {
    Field,
    OffensesTable,
    ServerHistorySection,
} from "@/components/player-sidebar";
import { SessionTimeline } from "@/components/session-timeline";
import { SiteNav } from "@/components/site-nav";
import { SteamRequiredGate } from "@/components/steam-required-gate";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth-context";
import { useTimezone } from "@/lib/timezone-store";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Ban, MessageSquare, MicOff, RefreshCw, Search, UserX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const LENGTH_MINUTES = {
  "1h": 60,
  "3h": 180,
  "6h": 360,
  "12h": 720,
  "24h": 1440,
  "2d": 2880,
  "3d": 4320,
  "4d": 5760,
  "5d": 7200,
  "6d": 8640,
  next_wipe: 10080,
  "7d": 10080,
  "14d": 20160,
  "30d": 43200,
};

function lengthToExpiresAt(length) {
  if (length === "permanent" || !LENGTH_MINUTES[length]) return null;
  return Math.floor(Date.now() / 1000) + LENGTH_MINUTES[length] * 60;
}

function fmtNum(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US");
}

function relativeTime(unix) {
  if (!unix) return "—";
  const days = Math.floor((Date.now() / 1000 - unix) / 86400);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatBanAge(days) {
  if (days == null) return null;
  if (days === 0) return "recent";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `~${Math.round(days / 30)}mo ago`;
  return `~${(days / 365).toFixed(1)}yr ago`;
}

function accountAge(unix) {
  if (!unix) return "—";
  const days = Math.floor((Date.now() / 1000 - unix) / 86400);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}yr`;
}

function lastBanDisplay(steam) {
  if (!steam) return "—";
  const total = (steam.vacCount ?? 0) + (steam.gameBanCount ?? 0);
  if (total === 0) return "Never";
  const d = steam.daysSinceLastBan;
  if (d == null) return "—";
  if (d === 0) return "Today";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `~${Math.round(d / 30)}mo ago`;
  return `~${(d / 365).toFixed(1)}yr ago`;
}

function steamIdColor(steamId) {
  let h = 0;
  for (let i = 0; i < steamId.length; i++)
    h = (h * 31 + steamId.charCodeAt(i)) | 0;
  return `oklch(0.5 0.14 ${Math.abs(h) % 360})`;
}

function banRecordStatus(r) {
  if (r.revoked) return { label: "Revoked", tone: "muted" };
  if (!r.expiresAt) return { label: "Permanent", tone: "danger" };
  const sec = r.expiresAt - Math.floor(Date.now() / 1000);
  if (sec <= 0) return { label: "Expired", tone: "muted" };
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  return {
    label: days > 0 ? `${days}d left` : `${hours}h left`,
    tone: "warning",
  };
}

const BAN_STATUS_TONE = {
  danger: "text-danger bg-danger/10 ring-danger/30",
  warning: "text-warning bg-warning/10 ring-warning/30",
  muted: "text-muted-foreground bg-surface ring-border",
  success: "text-success bg-success/10 ring-success/30",
};


const Route = createFileRoute("/player-lookup")({
  head: () => ({
    meta: [{ title: "Player Lookup — IronSight" }],
  }),
  validateSearch: (s) => ({
    steam:
      typeof s.steam === "string" && /^\d{17}$/.test(s.steam)
        ? s.steam
        : void 0,
    ipHash:
      typeof s.ipHash === "string" && /^[a-fA-F0-9]{6,64}$/.test(s.ipHash)
        ? s.ipHash.toUpperCase()
        : void 0,
  }),
  component: PlayerLookupPage,
});

function normalizeIpHashToken(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "")
    .slice(0, 64);
  return normalized.length >= 6 ? normalized.toUpperCase() : "";
}

function Avatar({ steamId, displayName, avatarUrl, size = 64 }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={displayName ?? steamId}
        className="rounded ring-1 ring-black/40 shrink-0 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0"
      style={{
        width: size,
        height: size,
        background: steamIdColor(steamId),
        fontSize: size / 2.6,
      }}
    >
      {(displayName ?? steamId)
        .replace(/[\[\]]/g, "")
        .slice(0, 2)
        .toUpperCase()}
    </div>
  );
}

function cacheAge(unix) {
  if (!unix) return null;
  const m = Math.floor((Date.now() / 1000 - unix) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function CacheStamp({ playerData, refreshing }) {
  const tz = useTimezone();
  const steamAt = playerData?.steam?.cachedAt;
  const bmAt = playerData?.bm?.cachedAt;
  const stale = playerData?.isStale;

  const newest = [steamAt, bmAt].filter(Boolean).sort().at(-1);

  if (refreshing) {
    return (
      <span className="text-[10px] text-muted-foreground/70 font-mono">
        refreshing…
      </span>
    );
  }

  if (!newest) {
    return (
      <span className="text-[10px] text-warning/80 font-mono">not cached</span>
    );
  }

  return (
    <span
      className={`text-[10px] font-mono ${stale ? "text-warning/80" : "text-muted-foreground/60"}`}
      title={`Steam: ${steamAt ? new Date(steamAt * 1000).toLocaleString(undefined, tz ? { timeZone: tz } : {}) : "—"}\nBM: ${bmAt ? new Date(bmAt * 1000).toLocaleString(undefined, tz ? { timeZone: tz } : {}) : "—"}`}
    >
      cached {cacheAge(newest)}
      {stale ? " · stale" : ""}
    </span>
  );
}

function PlayerLookupPage() {
  const {
    selectedOrgIds,
    orgs,
    hasOrgPermission,
    orgsLoaded,
    adminableOrgIds,
  } = useAuth();
  const tz = useTimezone();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [input, setInput] = useState(search.steam ?? search.ipHash ?? "");
  const [steamId, setSteamId] = useState(search.steam ?? null);
  const [ipHashQuery, setIpHashQuery] = useState(search.ipHash ?? null);
  const [ipHashMatches, setIpHashMatches] = useState([]);
  const [ipHashLoading, setIpHashLoading] = useState(false);
  const [ipHashError, setIpHashError] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [nameMatches, setNameMatches] = useState([]);
  const [nameSearchLoading, setNameSearchLoading] = useState(false);
  const [nameSearchError, setNameSearchError] = useState("");

  const [playerData, setPlayerData] = useState(null);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState(null);
  const [firstFetch, setFirstFetch] = useState(false);
  const pollRef = useRef(null);
  const pollAttemptsRef = useRef(0);
  // Remembers the last (steamId, org) we fetched so the fetch effect can tell an
  // org switch (→ force a fresh pull from the new org's keys) apart from a new
  // player or first load (→ a normal cache-first GET).
  const lastFetchRef = useRef({ steamId: null, orgId: null });

  const [offenses, setOffenses] = useState([]);
  const [offensesLoading, setOffensesLoading] = useState(false);

  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);

  const [issueBanOpen, setIssueBanOpen] = useState(false);
  const [issueBanActionType, setIssueBanActionType] = useState("ban");
  const [manageBansOpen, setManageBansOpen] = useState(false);
  const [manageMutesOpen, setManageMutesOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(false);
  const refreshCooldownRef = useRef(null);
  const [bmRateLimitWarning, setBmRateLimitWarning] = useState(false);

  const [kickOpen, setKickOpen] = useState(false);
  const [kickServerId, setKickServerId] = useState("");
  const [kickLoading, setKickLoading] = useState(false);
  const [kickError, setKickError] = useState("");
  const [kickResult, setKickResult] = useState("");
  const [orgServers, setOrgServers] = useState(null);

  const [chatLines, setChatLines] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);

  // URL search params are the source of truth. We support either `steam` or
  // `ipHash` mode; this effect mirrors the active mode into local state.
  useEffect(() => {
    const nextSteam = search.steam ?? null;
    const nextHash = search.ipHash ?? null;
    if (nextSteam !== steamId) {
      setSteamId(nextSteam);
    }
    if (nextHash !== ipHashQuery) {
      setIpHashQuery(nextHash);
    }
    const nextInput = nextSteam ?? nextHash ?? "";
    if (nextInput !== input) {
      setInput(nextInput);
    }
  }, [search.steam, search.ipHash]);

  // Player lookup needs players_view; issuing bans needs the ban-create perm
  // (legacy bans_manage still implies it). Prefer a selected org the user has
  // the relevant permission in, falling back to any such org so the page still
  // works regardless of org selection.
  const canCreateBansInOrg = (id) =>
    hasOrgPermission(id, "bans_create") || hasOrgPermission(id, "bans_manage");

  // Orgs the staffer may look players up from. The player cache + the returned
  // data are shared across orgs (the server resolves visibility per the caller's
  // orgs and any 'ips' shares), so we no longer make the staffer pick a key —
  // the fetch org is just whichever org's keys back a refresh. Keep it *stable*
  // (not tied to the org selection) so toggling orgs filters client-side instead
  // of refetching.
  const lookupOrgs = orgs.filter((o) => hasOrgPermission(o.id, "players_view"));
  const fetchOrgId = lookupOrgs[0]?.id ?? null;

  const banOrgId =
    selectedOrgIds.find(canCreateBansInOrg) ??
    orgs.find((o) => canCreateBansInOrg(o.id))?.id ??
    "";

  const offenseOrgIds = selectedOrgIds.filter(canCreateBansInOrg);

  // No ban permission anywhere → view-only (hide ban/mute actions).
  const isSupportOnly = !banOrgId;

  const canKick = fetchOrgId
    ? hasOrgPermission(fetchOrgId, "player_kick")
    : false;

  const canViewChatInOrg = (id) =>
    hasOrgPermission(id, "chat_view") || hasOrgPermission(id, "players_view");
  const chatOrgId =
    selectedOrgIds.find(canViewChatInOrg) ??
    lookupOrgs.find((o) => canViewChatInOrg(o.id))?.id ??
    null;

  // IP access spans all the caller's orgs (matches the server, which shows IPs
  // when the caller has ip_read anywhere). Per-IP source filtering happens below.
  const canViewIpConnections = orgs.some((o) =>
    hasOrgPermission(o.id, "ip_read"),
  );

  const fetchPlayer = useCallback(
    async (forceRefresh = false) => {
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      if (!steamId || !fetchOrgId) return;
      setPlayerLoading(true);
      setPlayerError(null);
      try {
        const url = forceRefresh
          ? `/api/players/${encodeURIComponent(steamId)}/refresh?orgId=${encodeURIComponent(fetchOrgId)}`
          : `/api/players/${encodeURIComponent(steamId)}?orgId=${encodeURIComponent(fetchOrgId)}`;
        const res = await fetch(url, {
          method: forceRefresh ? "POST" : "GET",
          credentials: "include",
        });
        const body = await res.json();
        if (!res.ok) {
          setPlayerError(body?.error ?? "Failed to fetch player data.");
          setPlayerData(null);
        } else if (body.fetching) {
          // Backend is still fetching — poll until data is ready
          if (pollAttemptsRef.current >= 10) {
            pollAttemptsRef.current = 0;
            setPlayerError(
              "Player data is taking too long to load. Try refreshing.",
            );
            setFirstFetch(false);
            return;
          }
          pollAttemptsRef.current += 1;
          setFirstFetch(true);
          setPlayerData(null);
          setPlayerLoading(false);
          pollRef.current = setTimeout(() => fetchPlayer(false), 3000);
          return;
        } else {
          pollAttemptsRef.current = 0;
          setFirstFetch(false);
          setPlayerData(body);
          if (body.bmRateLimitWarning) setBmRateLimitWarning(true);
          else setBmRateLimitWarning(false);
        }
      } catch {
        setPlayerError("Failed to fetch player data.");
        setPlayerData(null);
      } finally {
        setPlayerLoading(false);
        if (forceRefresh) setRefreshing(false);
      }
    },
    [steamId, fetchOrgId],
  );

  const searchPlayersByName = useCallback(
    async (query) => {
      const q = String(query ?? "").trim();
      if (q.length < 2) {
        setNameQuery("");
        setNameMatches([]);
        setNameSearchError("");
        return;
      }
      if (!fetchOrgId) {
        setNameQuery(q);
        setNameMatches([]);
        setNameSearchError("No organization with player lookup access is available.");
        return;
      }

      setNameSearchLoading(true);
      setNameQuery(q);
      setNameSearchError("");
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(fetchOrgId)}/players/search?q=${encodeURIComponent(q)}`,
          { credentials: "include" },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setNameMatches([]);
          setNameSearchError(body?.error ?? "Failed to search players by name.");
          return;
        }
        setNameMatches(Array.isArray(body.players) ? body.players : []);
      } catch {
        setNameMatches([]);
        setNameSearchError("Failed to search players by name.");
      } finally {
        setNameSearchLoading(false);
      }
    },
    [fetchOrgId],
  );

  useEffect(() => {
    if (steamId || ipHashQuery) {
      setNameQuery("");
      setNameMatches([]);
      setNameSearchError("");
      setNameSearchLoading(false);
    }
  }, [steamId, ipHashQuery]);

  useEffect(() => {
    if (!orgsLoaded) return;
    if (ipHashQuery) return;
    // Same player but a different org selected → the shared cache would just
    // return the same row, so force a refresh to re-pull from the newly chosen
    // org's API keys. New player / first load → normal cache-first GET.
    const prev = lastFetchRef.current;
    const orgSwitched =
      prev.steamId === steamId && !!prev.orgId && prev.orgId !== fetchOrgId;
    lastFetchRef.current = { steamId, orgId: fetchOrgId };

    setPlayerData(null);
    setFirstFetch(false);
    setOffenses([]);
    setReports([]);
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    pollAttemptsRef.current = 0;
    fetchPlayer(orgSwitched);
  }, [steamId, fetchOrgId, orgsLoaded, ipHashQuery]);

  useEffect(() => {
    if (!ipHashQuery || !fetchOrgId) {
      setIpHashMatches([]);
      setIpHashError("");
      return;
    }
    let cancelled = false;
    setIpHashLoading(true);
    setIpHashError("");
    fetch(
      `/api/players/by-ip-hash/${encodeURIComponent(ipHashQuery)}?orgId=${encodeURIComponent(fetchOrgId)}`,
      { credentials: "include" },
    )
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(body?.error ?? "Failed to search by IP hash.");
        }
        return body;
      })
      .then((b) => {
        if (!cancelled) setIpHashMatches(b.matches ?? []);
      })
      .catch((err) => {
        if (!cancelled) {
          setIpHashMatches([]);
          setIpHashError(err?.message ?? "Failed to search by IP hash.");
        }
      })
      .finally(() => {
        if (!cancelled) setIpHashLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ipHashQuery, fetchOrgId]);

  // One combined fetch resolves bans + mutes across every org the caller is
  // entitled to (their own orgs + 'bans'/'mutes' shares), each tagged with its
  // source org. The active org selection then filters the *view* client-side
  // (below), so toggling orgs doesn't refetch.
  useEffect(() => {
    if (!steamId) {
      setOffenses([]);
      return;
    }
    let cancelled = false;
    setOffensesLoading(true);
    fetch(`/api/players/${encodeURIComponent(steamId)}/offenses`, {
      credentials: "include",
    })
      .then((r) => r.json())
      .then((b) => {
        if (!cancelled)
          setOffenses(
            (b.offenses ?? []).sort((a, b) => b.issuedAt - a.issuedAt),
          );
      })
      .catch(() => {
        if (!cancelled) setOffenses([]);
      })
      .finally(() => {
        if (!cancelled) setOffensesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [steamId]);

  // Reports are entitlement-scoped server-side across all the caller's orgs +
  // 'reports' shares, each tagged with its source org — fetch once per player,
  // then filter the view by the active org selection (below).
  useEffect(() => {
    if (!steamId) {
      setReports([]);
      return;
    }
    let cancelled = false;
    setReportsLoading(true);
    fetch(`/api/players/${encodeURIComponent(steamId)}/reports`, {
      credentials: "include",
    })
      .then((r) => r.json())
      .then((b) => {
        if (!cancelled) setReports(b.reports ?? []);
      })
      .catch(() => {
        if (!cancelled) setReports([]);
      })
      .finally(() => {
        if (!cancelled) setReportsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [steamId]);

  // Chat history for this player across the org's servers
  useEffect(() => {
    if (!steamId || !chatOrgId) {
      setChatLines([]);
      return;
    }
    let cancelled = false;
    setChatLoading(true);
    fetch(
      `/api/players/${encodeURIComponent(steamId)}/chat?orgId=${encodeURIComponent(chatOrgId)}&limit=50`,
      { credentials: "include" },
    )
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(body?.error ?? "Failed to load chat history.");
        }
        return body;
      })
      .then((b) => {
        if (!cancelled) setChatLines(b.lines ?? []);
      })
      .catch(() => {
        if (!cancelled) setChatLines([]);
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [steamId, chatOrgId]);

  const submit = (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    const normalizedHash = normalizeIpHashToken(trimmed);
    const isSteam = /^\d{17}$/.test(trimmed);
    if (!isSteam && !normalizedHash && trimmed.length < 2) return;
    // Update the URL; the sync effect picks it up and drives the fetch. Using
    // navigate keeps the address bar, state, and any shared link consistent.
    if (isSteam && trimmed === search.steam && !search.ipHash) {
      // Same ID re-submitted (URL won't change → effect won't fire): refetch.
      fetchPlayer(false);
    } else if (!isSteam && normalizedHash === search.ipHash && !search.steam) {
      setIpHashQuery(normalizedHash);
    } else if (!isSteam && !normalizedHash) {
      navigate({ search: { steam: undefined, ipHash: undefined } });
      searchPlayersByName(trimmed);
    } else {
      navigate({
        search: isSteam
          ? { steam: trimmed, ipHash: undefined }
          : { steam: undefined, ipHash: normalizedHash },
      });
    }
  };

  const handleRefresh = async () => {
    if (refreshing || refreshCooldown) return;
    setRefreshing(true);
    await fetchPlayer(true);
    setRefreshCooldown(true);
    if (refreshCooldownRef.current) clearTimeout(refreshCooldownRef.current);
    refreshCooldownRef.current = setTimeout(() => setRefreshCooldown(false), 15000);
  };

  const openKickDialog = async () => {
    setKickError("");
    setKickResult("");
    setKickServerId("");
    setKickOpen(true);
    if (!orgServers && fetchOrgId) {
      const res = await fetch("/api/servers", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      const rconServers = (data.servers ?? []).filter(
        (s) => s.rconConfigured && s.ownerOrgId === fetchOrgId,
      );
      setOrgServers(rconServers);
      if (rconServers.length === 1) setKickServerId(rconServers[0].serverId);
      else {
        const sessionServer = playerData?.bmSessions?.[0]?.serverName;
        const match = rconServers.find(
          (s) => s.serverName.toLowerCase().includes((sessionServer ?? "").toLowerCase().slice(0, 8)),
        );
        if (match) setKickServerId(match.serverId);
      }
    }
  };

  const handleKick = async () => {
    if (!steamId || !kickServerId || !fetchOrgId) return;
    setKickLoading(true);
    setKickError("");
    setKickResult("");
    try {
      const res = await fetch(
        `/api/players/${encodeURIComponent(steamId)}/kick?orgId=${encodeURIComponent(fetchOrgId)}&serverId=${encodeURIComponent(kickServerId)}`,
        { method: "POST", credentials: "include" },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setKickResult("Player kicked successfully.");
        setTimeout(() => setKickOpen(false), 1500);
      } else {
        setKickError(data.error ?? "Kick failed.");
      }
    } catch {
      setKickError("Network error.");
    } finally {
      setKickLoading(false);
    }
  };


  const displayName = playerData?.displayName ?? steamId ?? "";

  const kd =
    playerData?.bm && (playerData.bm.deaths > 0 || playerData.bm.kills > 0)
      ? (playerData.bm.kills / Math.max(1, playerData.bm.deaths)).toFixed(2)
      : null;

  const isProxy =
    playerData?.ipHistory?.some((ip) => ip.isProxy || ip.isVpn) ?? false;

  const country = playerData?.ipHistory?.[0]?.country ?? null;

  // Client-side org filter for Connection Points: the server already returns
  // only IPs the caller is entitled to (own ip_read orgs + 'ips' shares), each
  // tagged with its source org(s). The dropdown then scopes the *view*: hide an
  // IP only when all its sources are own-orgs the user has currently unchecked.
  // Untagged (legacy) IPs and IPs sourced from a foreign org via a share stay
  // visible regardless of the toggle.
  const ownOrgIdSet = new Set(orgs.map((o) => o.id));
  const selectedSet = new Set(selectedOrgIds);
  const selectedIpSet = new Set(selectedOrgIds);
  if (fetchOrgId) selectedIpSet.add(fetchOrgId);
  // Shared rule for every source-tagged dataset (IPs, offenses, external bans):
  // hide a row only when all its sources are own-orgs the user has unchecked;
  // shared-in (foreign) and untagged rows stay visible.
  const filterBySource = (rows) =>
    (rows ?? []).filter((e) => {
      const src = Array.isArray(e.sourceOrgIds) ? e.sourceOrgIds : [];
      if (src.length === 0) return true;
      const ownSources = src.filter((o) => ownOrgIdSet.has(o));
      if (ownSources.length === 0) return true;
      return ownSources.some((o) => selectedSet.has(o));
    });

  const visibleIpHistory = (playerData?.ipHistory ?? []).filter((e) => {
    const src = Array.isArray(e.sourceOrgIds) ? e.sourceOrgIds : [];
    if (src.length === 0) return true;
    const ownSources = src.filter((o) => ownOrgIdSet.has(o));
    if (ownSources.length === 0) return true;
    return ownSources.some((o) => selectedIpSet.has(o));
  });
  const visibleBmBans = filterBySource(playerData?.bmBans);
  const visibleReports = filterBySource(reports);

  // Steam VAC / game bans (GetPlayerBans). vacBanned is null until first fetched.
  const vacSummary = (() => {
    const s = playerData?.steam;
    if (!s || s.vacBanned == null) return { value: "—", tone: undefined };
    const vac = s.vacCount ?? 0;
    const game = s.gameBanCount ?? 0;
    const total = vac + game;
    if (total === 0) return { value: "Clean", tone: "success" };
    const parts = [];
    if (vac > 0) parts.push(`${vac} VAC`);
    if (game > 0) parts.push(`${game} game`);
    return { value: parts.join(" · "), tone: "danger" };
  })();

  const lastSeen = (() => {
    const s = playerData?.bmSessions?.[0];
    if (!s?.lastSeen) return null;
    const diffMin = Math.floor((Date.now() / 1000 - s.lastSeen) / 60);
    if (diffMin < 2) return `Now — ${s.serverName ?? "Server"}`;
    if (diffMin < 60) return `${diffMin}m ago — ${s.serverName ?? "Server"}`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago — ${s.serverName ?? "Server"}`;
    return `${Math.floor(diffH / 24)}d ago — ${s.serverName ?? "Server"}`;
  })();

  // Same org-scoping rule as IPs: hide an offense only when its source is one of
  // the caller's own orgs that's currently unchecked. Offenses from a shared-in
  // (foreign) org stay visible regardless of the toggle.
  const visibleOffenses = offenses.filter((o) => {
    if (!o.orgId) return true;
    if (!ownOrgIdSet.has(o.orgId)) return true; // shared-in → always shown
    return selectedSet.has(o.orgId);
  });

  const offenseRows = visibleOffenses.map((ban) => {
    const st = banRecordStatus(ban);
    const foreign = ban.orgId && !ownOrgIdSet.has(ban.orgId);
    return {
      id: ban.banId,
      type: ban.actionType === "ban" ? "Ban" : "Mute",
      status: st.label,
      statusTone: st.tone,
      reason: ban.reason ?? "—",
      when: relativeTime(ban.issuedAt),
      // Surface the source org as provenance; flag shared-in records so staff
      // know they belong to (and are managed by) another org.
      by:
        (ban.issuedByName ?? "unknown") +
        (ban.orgName ? ` · ${ban.orgName}${foreign ? " (shared)" : ""}` : ""),
      note: ban.note ?? "",
    };
  });

  const visibleOffenseRows = isSupportOnly
    ? offenseRows.filter((o) => o.type === "Mute")
    : offenseRows;

  // Consolidated risk flags shown as a banner under the profile header. Built
  // entirely from data already on playerData / offenses — no extra fetches.
  const alerts = (() => {
    if (!playerData) return [];
    const out = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const s = playerData.steam;
    const bm = playerData.bm;

    const banAge = formatBanAge(s?.daysSinceLastBan);
    if (s?.vacBanned && (s.vacCount ?? 0) > 0)
      out.push({
        key: "vac",
        label: `VAC Banned (${s.vacCount})`,
        detail: banAge
          ? `${s.vacCount} VAC ban${s.vacCount !== 1 ? "s" : ""} · last ban ${banAge}`
          : null,
        tone: "danger",
      });
    if ((s?.gameBanCount ?? 0) > 0)
      out.push({
        key: "game",
        label: `Game Banned (${s.gameBanCount})${banAge ? ` · ${banAge}` : ""}`,
        detail: `${s.gameBanCount} Steam game ban${s.gameBanCount !== 1 ? "s" : ""}${banAge ? ` · last ban ${banAge}` : ""}. Steam does not disclose which games.`,
        tone: "danger",
      });
    if (s?.communityBanned)
      out.push({
        key: "community",
        label: "Community Banned",
        tone: "warning",
      });
    if (s?.economyBan && s.economyBan !== "none")
      out.push({ key: "economy", label: "Trade Banned", tone: "warning" });
    if (bm?.rustBansBanned)
      out.push({ key: "eac", label: "EAC Banned", tone: "danger" });
    else if ((bm?.rustBansCount ?? 0) > 0)
      out.push({
        key: "priorbm",
        label: `${bm.rustBansCount} Prior EAC Ban${bm.rustBansCount !== 1 ? "s" : ""}`,
        tone: "warning",
      });
    if (isProxy)
      out.push({ key: "vpn", label: "VPN / Proxy", tone: "warning" });
    if (s?.profileVisibility && s.profileVisibility !== "Public")
      out.push({ key: "steam_private", label: "Private Steam", tone: "warning" });
    if (bm?.private)
      out.push({ key: "bm_private", label: "Private BM", tone: "warning" });
    if (s?.profileCreatedAt && nowSec - s.profileCreatedAt < 30 * 86400)
      out.push({ key: "young", label: "New Steam Account", tone: "warning" });

    const reportSum =
      (bm?.cheatingReports ?? 0) +
      (bm?.teamingReports ?? 0) +
      (bm?.otherReports ?? 0);
    if (reportSum > 10)
      out.push({
        key: "reports",
        label: `${reportSum} BM Reports`,
        tone: "warning",
      });

    const hasActiveBan = visibleOffenses.some(
      (o) =>
        o.actionType === "ban" &&
        !o.revoked &&
        (!o.expiresAt || o.expiresAt > nowSec),
    );
    const hasActiveMute = visibleOffenses.some(
      (o) =>
        o.actionType === "mute" &&
        !o.revoked &&
        (!o.expiresAt || o.expiresAt > nowSec),
    );
    if (hasActiveBan)
      out.push({ key: "orgban", label: "Active Ban", tone: "danger" });
    if (hasActiveMute)
      out.push({ key: "orgmute", label: "Active Mute", tone: "warning" });

    return out;
  })();

  const loaded = !playerLoading && playerData;

  return (
    <SteamRequiredGate>
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        <SiteNav />
        <main className="flex-1 flex flex-col min-h-0">
          <div className="border-b border-border bg-surface/30 px-6 py-5">
            <div className="max-w-3xl mx-auto">
              <h1 className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground mb-2">
                Player Lookup
              </h1>
              <form onSubmit={submit} className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Search by Steam ID, hashed IP token, current name, or previous name"
                    className="w-full pl-9 pr-3 py-2.5 bg-background ring-1 ring-border rounded-md text-sm font-mono focus:outline-none focus:ring-brand"
                  />
                </div>
                <button
                  type="submit"
                  disabled={playerLoading || firstFetch}
                  className="px-4 py-2.5 bg-brand text-brand-foreground rounded-md text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  Lookup
                </button>
              </form>
              {input.trim().length > 0 &&
                !/^\d{17}$/.test(input.trim()) &&
                !normalizeIpHashToken(input.trim()) &&
                input.trim().length < 2 && (
                <p className="mt-2 text-[11px] text-warning">
                  Enter at least 2 characters for name search, or use a Steam ID / IP hash.
                </p>
              )}
            </div>
          </div>

          {!steamId && !ipHashQuery && !nameQuery ? (
            <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
              Enter a Steam ID, hashed IP token, or player name above.
            </div>
          ) : nameQuery ? (
            <NameSearchResults
              query={nameQuery}
              loading={nameSearchLoading}
              error={nameSearchError}
              matches={nameMatches}
              onOpenPlayer={(id) =>
                navigate({ search: { steam: id, ipHash: undefined } })
              }
            />
          ) : ipHashQuery ? (
            <IpHashSearchResults
              hash={ipHashQuery}
              loading={ipHashLoading}
              error={ipHashError}
              matches={ipHashMatches}
              onOpenPlayer={(id) =>
                navigate({ search: { steam: id, ipHash: undefined } })
              }
            />
          ) : playerLoading ? (
            <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
              Loading…
            </div>
          ) : firstFetch ? (
            <div className="flex-1 grid place-items-center text-center space-y-1.5">
              <p className="text-sm text-muted-foreground">
                Fetching player data for the first time…
              </p>
              <p className="text-xs text-muted-foreground/60">
                No cached data found for this player. This may take a moment.
              </p>
            </div>
          ) : playerError ? (
            <div className="flex-1 grid place-items-center">
              <div className="text-center space-y-2">
                <p className="text-sm text-danger">{playerError}</p>
                <button
                  onClick={() => fetchPlayer(false)}
                  className="text-xs text-brand hover:underline"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : !playerData ? null : playerData.protected ? (
            <ProtectedStaffProfile playerData={playerData} steamId={steamId} />
          ) : (
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
                {/* Profile header */}
                <section>
                  <div className="bg-surface/60 ring-1 ring-border rounded-lg p-5">
                    <div className="flex items-center justify-between gap-4 mb-5">
                      <div className="flex items-center gap-4 min-w-0">
                        <Avatar
                          steamId={playerData.steamId}
                          displayName={playerData.displayName}
                          avatarUrl={playerData.avatarUrl}
                          size={64}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold truncate">
                              {playerData.displayName ?? playerData.steamId}
                            </h2>
                            {playerData.bm?.rustBansBanned && (
                              <span className="text-[9px] font-mono uppercase tracking-widest text-danger bg-danger/10 ring-1 ring-danger/30 px-1.5 py-0.5 rounded shrink-0">
                                BM Banned
                              </span>
                            )}
                            {(playerData.bm?.rustBansCount ?? 0) > 0 &&
                              !playerData.bm?.rustBansBanned && (
                                <span className="text-[9px] font-mono uppercase tracking-widest text-warning bg-warning/10 ring-1 ring-warning/30 px-1.5 py-0.5 rounded shrink-0">
                                  {playerData.bm.rustBansCount} prior BM ban
                                  {playerData.bm.rustBansCount !== 1 ? "s" : ""}
                                </span>
                              )}
                          </div>
                          <p className="text-[11px] font-mono text-muted-foreground uppercase truncate flex items-center gap-1.5">
                            {playerData.steamId}
                            <PlayerLinks
                              steamId={playerData.steamId}
                              size="sm"
                            />
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <CacheStamp
                          playerData={playerData}
                          refreshing={refreshing}
                        />
                        <button
                          type="button"
                          onClick={handleRefresh}
                          disabled={refreshing || refreshCooldown}
                          className={`inline-flex items-center gap-1.5 h-8 px-3 text-xs rounded-md ring-1 disabled:opacity-50 ${bmRateLimitWarning ? "bg-warning/10 text-warning ring-warning/40 hover:bg-warning/20" : "bg-surface text-muted-foreground ring-border hover:bg-surface-bright"}`}
                          title={
                            refreshCooldown
                              ? "Wait a moment before refreshing again"
                              : bmRateLimitWarning
                                ? "BattleMetrics token is >90% rate-limited — data may not refresh"
                                : "Refresh data from BattleMetrics / Steam"
                          }
                        >
                          {bmRateLimitWarning && (
                            <AlertTriangle className="size-3.5 shrink-0" />
                          )}
                          <RefreshCw
                            className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
                          />
                        </button>

                        {!isSupportOnly && (
                          <>
                            <button
                              type="button"
                              onClick={() => setManageBansOpen(true)}
                              className="inline-flex items-center gap-1.5 h-8 px-3 bg-surface text-foreground text-xs font-semibold rounded-md ring-1 ring-border hover:bg-surface-bright"
                            >
                              <Ban className="size-3.5" aria-hidden />
                              Manage Bans
                            </button>
                            <button
                              type="button"
                              onClick={() => setManageMutesOpen(true)}
                              className="inline-flex items-center gap-1.5 h-8 px-3 bg-surface text-foreground text-xs font-semibold rounded-md ring-1 ring-border hover:bg-surface-bright"
                            >
                              <MicOff className="size-3.5" aria-hidden />
                              Manage Mutes
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => { setIssueBanActionType("mute"); setIssueBanOpen(true); }}
                          className="flex items-center gap-2 px-3 py-2 bg-warning/15 text-warning ring-1 ring-warning/40 rounded-md text-xs font-semibold uppercase tracking-widest hover:bg-warning/25"
                        >
                          <MicOff className="size-3.5" />
                          Mute
                        </button>
                        {!isSupportOnly && (
                          <button
                            onClick={() => { setIssueBanActionType("ban"); setIssueBanOpen(true); }}
                            className="flex items-center gap-2 px-3 py-2 bg-danger text-danger-foreground rounded-md text-xs font-semibold uppercase tracking-widest hover:opacity-90"
                          >
                            <Ban className="size-3.5" />
                            Ban
                          </button>
                        )}
                        {canKick &&
                          playerData.bmSessions?.[0]?.lastSeen &&
                          Date.now() / 1000 - playerData.bmSessions[0].lastSeen < 300 && (
                          <button
                            onClick={openKickDialog}
                            className="flex items-center gap-2 px-3 py-2 bg-surface text-foreground ring-1 ring-border rounded-md text-xs font-semibold uppercase tracking-widest hover:bg-surface-bright"
                          >
                            <UserX className="size-3.5" />
                            Logout
                          </button>
                        )}
                      </div>
                    </div>

                    {playerData.flaggedGroups?.length > 0 && (
                      <div className="rounded-md ring-1 ring-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning flex items-start gap-2">
                        <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                        <span>
                          <strong>Possible botted account</strong> — member of flagged Steam group{playerData.flaggedGroups.length !== 1 ? "s" : ""}:{" "}
                          {playerData.flaggedGroups.map((g) => g.label).join(", ")}
                        </span>
                      </div>
                    )}

                    {!isSupportOnly && (
                      <div className="space-y-4">
                        {/* Steam */}
                        <div>
                          <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">Steam</p>
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-y-4 gap-x-6">
                            <Field
                              label="Rust Hours"
                              hint={HINTS.steamHours}
                              value={
                                playerData.steam.dataPublic
                                  ? fmtNum(playerData.steam.rustHours)
                                  : "Private"
                              }
                              tone={!playerData.steam.dataPublic ? "warning" : undefined}
                            />
                            <Field
                              label="Acct Age"
                              value={accountAge(playerData.steam.profileCreatedAt)}
                              tone={
                                playerData.steam.profileCreatedAt &&
                                Date.now() / 1000 - playerData.steam.profileCreatedAt < 30 * 86400
                                  ? "warning"
                                  : undefined
                              }
                            />
                            <Field
                              label="Visibility"
                              hint={HINTS.steamVisibility}
                              value={playerData.steam.profileVisibility ?? "—"}
                              tone={
                                playerData.steam.profileVisibility === "Public"
                                  ? "success"
                                  : playerData.steam.profileVisibility === "Friends Only"
                                    ? "warning"
                                    : playerData.steam.profileVisibility === "Private"
                                      ? "danger"
                                      : playerData.steam.profileVisibility === "Not Configured"
                                        ? "warning"
                                        : undefined
                              }
                            />
                            <Field
                              label="VAC / Game"
                              value={vacSummary.value}
                              tone={vacSummary.tone}
                            />
                            <Field
                              label="Last Ban"
                              value={lastBanDisplay(playerData.steam)}
                              tone={
                                (playerData.steam.vacCount ?? 0) + (playerData.steam.gameBanCount ?? 0) > 0
                                  ? "danger"
                                  : undefined
                              }
                            />
                          </div>
                        </div>

                        {/* BattleMetrics */}
                        {playerData.bm && (
                          <div>
                            <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">BattleMetrics</p>
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-y-4 gap-x-6">
                              <Field
                                label="BM Hours"
                                hint={HINTS.bmHours}
                                value={fmtNum(playerData.bm.rustHours)}
                              />
                              <Field
                                label="BM Acct Age"
                                value={accountAge(playerData.bm.profileCreatedAt)}
                              />
                              <Field
                                label="BM Profile"
                                hint={HINTS.bmVisibility}
                                value={playerData.bm.private ? "Private" : "Public"}
                                tone={playerData.bm.private ? "danger" : "success"}
                              />
                              <Field
                                label="Aim Train"
                                hint={HINTS.atHours}
                                value={fmtNum(playerData.bm.aimtrainHours)}
                              />
                              <Field
                                label="Servers"
                                value={fmtNum(playerData.bm.serverCount)}
                              />
                              <Field
                                label="K/D"
                                hint={HINTS.kd}
                                value={kd ?? "—"}
                                tone={
                                  kd != null && Number(kd) >= 3
                                    ? "warning"
                                    : undefined
                                }
                              />
                              <Field
                                label="Kills"
                                value={fmtNum(playerData.bm.kills)}
                              />
                              <Field
                                label="Deaths"
                                value={fmtNum(playerData.bm.deaths)}
                              />
                              <Field
                                label="Cheat Reports"
                                value={fmtNum(playerData.bm.cheatingReports)}
                                tone={
                                  (playerData.bm.cheatingReports ?? 0) > 5
                                    ? "danger"
                                    : (playerData.bm.cheatingReports ?? 0) > 0
                                      ? "warning"
                                      : undefined
                                }
                              />
                              <Field
                                label="Total Reports"
                                value={fmtNum(
                                  (playerData.bm.cheatingReports ?? 0) +
                                    (playerData.bm.teamingReports ?? 0) +
                                    (playerData.bm.otherReports ?? 0),
                                )}
                                tone={
                                  (playerData.bm.cheatingReports ?? 0) +
                                    (playerData.bm.teamingReports ?? 0) +
                                    (playerData.bm.otherReports ?? 0) >
                                  10
                                    ? "danger"
                                    : (playerData.bm.cheatingReports ?? 0) +
                                          (playerData.bm.teamingReports ?? 0) +
                                          (playerData.bm.otherReports ?? 0) >
                                        0
                                      ? "warning"
                                      : undefined
                                }
                              />
                            </div>
                          </div>
                        )}

                        {/* General */}
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-y-4 gap-x-6">
                          <Field
                            label="Proxy"
                            value={isProxy ? "True" : "False"}
                            tone={isProxy ? "danger" : "success"}
                          />
                          <Field label="Location" value={country ?? "—"} />
                          <Field label="Last Seen" value={lastSeen ?? "Never"} />
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                {/* Risk alerts */}
                {!isSupportOnly && <PlayerAlertsBanner alerts={alerts} />}

                {/* Connection Points */}
                {canViewIpConnections && (
                  <ConnectionPointsSection
                    ipHistory={visibleIpHistory}
                    tz={tz}
                    onSearchHash={(hash) =>
                      navigate({ search: { steam: undefined, ipHash: hash } })
                    }
                  />
                )}

                {/* Notes */}
                <PlayerNotesSection
                  subjectId={playerData.steamId}
                  orgId={fetchOrgId}
                />

                {/* Previous Offenses (real bans / mutes from our orgs) */}
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
                    <span>Previous Offenses</span>
                    <span className="font-mono normal-case tracking-normal text-muted-foreground">
                      {offensesLoading ? "…" : visibleOffenseRows.length}
                    </span>
                  </h3>
                  {offensesLoading ? (
                    <p className="text-xs text-muted-foreground italic">
                      Loading…
                    </p>
                  ) : visibleOffenseRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">
                      No prior offenses.
                    </p>
                  ) : (
                    <OffensesTable offenses={visibleOffenseRows} />
                  )}
                </section>

                {/* Previous In-Game Reports */}
                {!isSupportOnly && (
                  <PlayerReportsSection
                    reports={visibleReports}
                    loading={reportsLoading}
                    tz={tz}
                  />
                )}

                {/* Bans on Other Orgs */}
                {!isSupportOnly && (
                  <ExternalBansSection
                    subjectId={playerData.steamId}
                    bans={visibleBmBans}
                  />
                )}

                {/* Linked Accounts */}
                {!isSupportOnly && (
                  <LinkedAccountsSection
                    subjectName={playerData.displayName ?? playerData.steamId}
                    relatedAccounts={playerData.relatedAccounts}
                  />
                )}

                {/* Steam Friends */}
                {!isSupportOnly && (
                  <PlayerFriendsSection friends={playerData.friends} />
                )}

                {/* Server History */}
                {!isSupportOnly && (
                  <ServerHistorySection
                    subjectId={playerData.steamId}
                    isOnline={
                      playerData.bmSessions?.[0]?.lastSeen
                        ? Date.now() / 1000 -
                            playerData.bmSessions[0].lastSeen <
                          300
                        : false
                    }
                    bmSessions={playerData.bmSessions}
                  />
                )}

                {/* Session Timeline */}
                {!isSupportOnly && (
                  <SessionTimeline sessionWindows={playerData.sessionWindows} />
                )}

                {/* Chat History */}
                {!isSupportOnly && (
                  <section>
                    <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
                      <MessageSquare className="size-3" />
                      Chat History
                      <span className="font-mono normal-case tracking-normal text-muted-foreground ml-auto">
                        {chatLines.length}
                      </span>
                    </h2>
                    {chatLoading ? (
                      <p className="text-xs text-muted-foreground italic animate-pulse">
                        Loading…
                      </p>
                    ) : chatLines.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">
                        No chat messages on record.
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {chatLines.map((line) => (
                          <li
                            key={line.id}
                            className="bg-surface/30 ring-1 ring-border rounded px-2 py-1.5"
                          >
                            <div className="flex items-start gap-2">
                              {line.teamMessage && (
                                <span className="text-[8px] font-mono uppercase tracking-widest text-brand shrink-0 mt-0.5">
                                  team
                                </span>
                              )}
                              <p className="text-xs text-foreground leading-relaxed flex-1 break-words">
                                {line.message}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-[9px] font-mono text-muted-foreground">
                              <span>
                                {new Date(line.ts * 1000).toLocaleDateString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })}
                              </span>
                              {line.serverName && (
                                <>
                                  <span>·</span>
                                  <span className="truncate">{line.serverName}</span>
                                </>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}
              </div>
            </div>
          )}

          {/* Logout Dialog */}
          <Dialog open={kickOpen} onOpenChange={setKickOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Logout Player</DialogTitle>
                <DialogDescription>
                  Select the server and confirm the logout.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                {(!orgServers || orgServers.length === 0) ? (
                  <p className="text-xs text-muted-foreground">
                    No RCON-configured servers found for this org.
                  </p>
                ) : orgServers.length === 1 ? (
                  <p className="text-xs text-foreground">
                    Server: <strong>{orgServers[0].serverName}</strong>
                  </p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Select server:</p>
                    <select
                      value={kickServerId}
                      onChange={(e) => setKickServerId(e.target.value)}
                      className="w-full bg-background ring-1 ring-border rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">— pick a server —</option>
                      {orgServers.map((s) => (
                        <option key={s.serverId} value={s.serverId}>
                          {s.serverName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {kickResult && (
                  <p className="text-xs text-success">{kickResult}</p>
                )}
                {kickError && (
                  <p className="text-xs text-danger">{kickError}</p>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setKickOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={kickLoading || !kickServerId}
                  onClick={handleKick}
                >
                  {kickLoading ? "Logging out…" : "Logout"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* Dialogs */}
          {steamId && (
            <NewBanDialog
              open={issueBanOpen}
              onClose={() => setIssueBanOpen(false)}
              onCreated={() => setIssueBanOpen(false)}
              defaultActionType={issueBanActionType}
              defaultIdentifier={steamId}
              playerSteamId={steamId}
              manageableOrgIds={offenseOrgIds.length ? offenseOrgIds : (banOrgId ? [banOrgId] : [])}
              orgs={orgs}
              hasOrgPermission={hasOrgPermission}
            />
          )}
          {steamId && (
            <PlayerManageDialog
              steamId={steamId}
              kind="Ban"
              orgIds={offenseOrgIds}
              open={manageBansOpen}
              onOpenChange={setManageBansOpen}
            />
          )}
          {steamId && (
            <PlayerManageDialog
              steamId={steamId}
              kind="Mute"
              orgIds={offenseOrgIds}
              open={manageMutesOpen}
              onOpenChange={setManageMutesOpen}
            />
          )}
        </main>

      </div>
    </SteamRequiredGate>
  );
}

// Shown when the looked-up Steam ID belongs to a staff member who enabled a
// private profile. Their intel is withheld from peers, but online presence on
// the panel stays visible.
function ProtectedStaffProfile({ playerData, steamId }) {
  const online = Boolean(playerData.online);
  return (
    <div className="flex-1 grid place-items-center px-6">
      <div className="max-w-md w-full text-center space-y-5">
        <Avatar
          steamId={steamId}
          displayName={playerData.displayName}
          size={72}
        />
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {playerData.displayName ?? steamId}
          </h2>
          <p className="text-[11px] font-mono text-muted-foreground uppercase">
            {steamId}
          </p>
        </div>
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full ring-1 ring-border bg-surface/60 text-xs">
          <span
            className={
              "size-2 rounded-full " +
              (online ? "bg-success animate-pulse" : "bg-muted-foreground/40")
            }
          />
          <span className={online ? "text-success" : "text-muted-foreground"}>
            {online ? "Online on the panel" : "Offline"}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          This staff member has a{" "}
          <span className="text-foreground font-medium">private profile</span>.
          Their player intel is hidden from other staff.
        </p>
      </div>
    </div>
  );
}

const ALERT_TONE = {
  danger: "text-danger bg-danger/10 ring-danger/40",
  warning: "text-warning bg-warning/10 ring-warning/40",
};

function PlayerAlertsBanner({ alerts }) {
  if (!alerts?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {alerts.map((a) => (
        <span
          key={a.key}
          title={a.detail ?? undefined}
          className={`inline-flex items-center gap-1 text-[10px] font-mono font-semibold uppercase tracking-wider px-2 py-1 rounded ring-1 ${ALERT_TONE[a.tone] ?? ALERT_TONE.warning}`}
        >
          {a.label}
        </span>
      ))}
    </div>
  );
}

const REPORT_TYPE_TONE = {
  cheating: "text-danger bg-danger/10 ring-danger/30",
  teaming: "text-warning bg-warning/10 ring-warning/30",
  toxicity: "text-warning bg-warning/10 ring-warning/30",
};

function PlayerReportsSection({ reports, loading, tz }) {
  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>In-Game Reports</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {loading ? "…" : reports.length}
        </span>
      </h3>
      {loading ? (
        <p className="text-xs text-muted-foreground italic">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No reports on file.
        </p>
      ) : (
        <div className="rounded-md ring-1 ring-border overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-surface/60">
                <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Type
                </th>
                <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Reason
                </th>
                <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hidden sm:table-cell">
                  Server
                </th>
                <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hidden md:table-cell">
                  Reporter
                </th>
                <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r, i) => (
                <tr
                  key={r.id}
                  className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-surface/30"}`}
                >
                  <td className="px-3 py-2 shrink-0">
                    <span
                      className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${REPORT_TYPE_TONE[r.reportType.toLowerCase()] ?? "text-muted-foreground bg-surface ring-border"}`}
                    >
                      {r.reportType}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-foreground max-w-[200px]">
                    <p className="truncate" title={r.reportReason}>
                      {r.reportReason}
                    </p>
                    {r.reportDescription && (
                      <p
                        className="text-[10px] text-muted-foreground truncate"
                        title={r.reportDescription}
                      >
                        {r.reportDescription}
                      </p>
                    )}
                  </td>
                  <td
                    className="px-3 py-2 text-muted-foreground truncate max-w-[140px] hidden sm:table-cell"
                    title={r.serverName}
                  >
                    {r.serverName}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground hidden md:table-cell">
                    {r.reporterName}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                    {relativeTime(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PlayerManageDialog({ steamId, kind, orgIds, open, onOpenChange }) {
  const tz = useTimezone();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState({});
  const [actionError, setActionError] = useState("");

  const loadRecords = useCallback(async () => {
    if (!orgIds.length || !steamId) {
      setRecords([]);
      return;
    }
    setLoading(true);
    try {
      const type = kind === "Ban" ? "ban" : "mute";
      const groups = await Promise.all(
        orgIds.map((orgId) =>
          fetch(
            `/api/orgs/${encodeURIComponent(orgId)}/bans?type=${type}&identifier=${encodeURIComponent(steamId)}`,
            { credentials: "include" },
          )
            .then((r) => r.json())
            .then((b) => b.bans ?? [])
            .catch(() => []),
        ),
      );
      setRecords(groups.flat().sort((a, b) => b.issuedAt - a.issuedAt));
    } finally {
      setLoading(false);
    }
  }, [steamId, kind, orgIds]);

  useEffect(() => {
    if (open) {
      setDrafts({});
      setActionError("");
      loadRecords();
    }
  }, [open, loadRecords]);

  const revoke = async (r) => {
    setActionError("");
    setBusy((p) => ({ ...p, [r.banId]: true }));
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(r.orgId)}/bans/${r.banId}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(
          body.error ??
            `Failed to ${kind === "Ban" ? "unban" : "unmute"} (${res.status})`,
        );
        return;
      }
    } catch {
      setActionError("Network error — please try again");
      return;
    } finally {
      setBusy((p) => ({ ...p, [r.banId]: false }));
    }
    loadRecords();
  };

  const applyDuration = async (r) => {
    const newLength = drafts[r.banId];
    if (!newLength) return;
    setActionError("");
    setBusy((p) => ({ ...p, [r.banId]: true }));
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(r.orgId)}/bans/${r.banId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expiresAt: lengthToExpiresAt(newLength) }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(
          body.error ?? `Failed to update duration (${res.status})`,
        );
        return;
      }
    } catch {
      setActionError("Network error — please try again");
      return;
    } finally {
      setBusy((p) => ({ ...p, [r.banId]: false }));
    }
    loadRecords();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {kind === "Ban" ? "Manage Bans" : "Manage Mutes"}
          </DialogTitle>
          <DialogDescription>
            Adjust duration or lift {kind.toLowerCase()}s. Records remain in the
            system for audit.
          </DialogDescription>
        </DialogHeader>
        {actionError && (
          <p className="text-xs text-danger bg-danger/10 ring-1 ring-danger/30 rounded px-3 py-2">
            {actionError}
          </p>
        )}
        {loading ? (
          <p className="text-xs text-muted-foreground py-6 text-center">
            Loading…
          </p>
        ) : records.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-6 text-center">
            No {kind.toLowerCase()}s on record.
          </p>
        ) : (
          <ul className="space-y-2 max-h-[60vh] overflow-y-auto">
            {records.map((r) => {
              const st = banRecordStatus(r);
              const isActive =
                !r.revoked &&
                (!r.expiresAt || r.expiresAt > Math.floor(Date.now() / 1000));
              return (
                <li
                  key={r.banId}
                  className="bg-surface/40 ring-1 ring-border rounded p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{r.reason}</p>
                      <p className="text-[10px] font-mono text-muted-foreground">
                        {new Date(r.issuedAt * 1000).toLocaleDateString(
                          undefined,
                          tz ? { timeZone: tz } : {},
                        )}{" "}
                        · by {r.issuedByName ?? "unknown"}
                        {r.category ? ` · ${r.category}` : ""}
                      </p>
                    </div>
                    <span
                      className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 shrink-0 ${BAN_STATUS_TONE[st.tone]}`}
                    >
                      {st.label}
                    </span>
                  </div>
                  {isActive && (
                    <div className="flex items-center gap-2">
                      <select
                        value={drafts[r.banId] ?? ""}
                        onChange={(e) =>
                          setDrafts((p) => ({
                            ...p,
                            [r.banId]: e.target.value,
                          }))
                        }
                        className="flex-1 h-8 text-xs bg-surface border border-border rounded px-2"
                        disabled={busy[r.banId]}
                      >
                        <option value="">New duration…</option>
                        {LENGTH_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-8"
                        onClick={() => applyDuration(r)}
                        disabled={!drafts[r.banId] || !!busy[r.banId]}
                      >
                        Apply
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-8"
                        onClick={() => revoke(r)}
                        disabled={!!busy[r.banId]}
                      >
                        {kind === "Ban" ? "Unban" : "Unmute"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function IpHashSearchResults({ hash, loading, error, matches, onOpenPlayer }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
        <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2">
            Hashed IP Search
          </h2>
          <p className="text-xs text-muted-foreground font-mono">Query: {hash}</p>
        </section>

        {loading ? (
          <p className="text-sm text-muted-foreground">Searching...</p>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No players found for this hash.
          </p>
        ) : (
          <ul className="space-y-2">
            {matches.map((m) => (
              <li
                key={m.steamId}
                className="bg-surface/40 ring-1 ring-border rounded px-3 py-2.5 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {m.displayName ?? m.steamId}
                  </p>
                  <p className="text-[10px] font-mono text-muted-foreground truncate">
                    {m.steamId}
                    {m.lastSeen
                      ? ` · last seen ${new Date(m.lastSeen * 1000).toLocaleDateString()}`
                      : ""}
                    {m.matches
                      ? ` · ${m.matches} connection${m.matches === 1 ? "" : "s"}`
                      : ""}
                  </p>
                </div>
                <Button size="sm" onClick={() => onOpenPlayer(m.steamId)}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NameSearchResults({ query, loading, error, matches, onOpenPlayer }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
        <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2">
            Name Search
          </h2>
          <p className="text-xs text-muted-foreground font-mono">Query: {query}</p>
        </section>

        {loading ? (
          <p className="text-sm text-muted-foreground">Searching...</p>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No players found for this name.
          </p>
        ) : (
          <ul className="space-y-2">
            {matches.map((m) => (
              <li
                key={m.steamId}
                className="bg-surface/40 ring-1 ring-border rounded px-3 py-2.5 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold truncate">
                      {m.name ?? m.steamId}
                    </p>
                    {m.matchType === "previous_name" && (
                      <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 text-warning bg-warning/10 ring-warning/30">
                        Previous Name Match
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] font-mono text-muted-foreground truncate">
                    {m.steamId}
                    {m.matchType === "previous_name" && m.matchedAlias
                      ? ` · matched alias: ${m.matchedAlias}`
                      : ""}
                    {m.lastSeenAt
                      ? ` · last seen ${new Date(m.lastSeenAt * 1000).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>
                <Button size="sm" onClick={() => onOpenPlayer(m.steamId)}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Connection Points ─────────────────────────────────────────────────────────

function flagEmoji(isoCode) {
  if (!isoCode || isoCode.length !== 2) return "🌐";
  const base = 0x1f1e6 - 65;
  return String.fromCodePoint(
    isoCode.toUpperCase().charCodeAt(0) + base,
    isoCode.toUpperCase().charCodeAt(1) + base,
  );
}

const CONN_TYPE_META = {
  residential: { label: "Residential", cls: "text-success bg-success/10 ring-success/30" },
  business:    { label: "Business",    cls: "text-brand bg-brand/10 ring-brand/30" },
  mobile:      { label: "Mobile",      cls: "text-foreground bg-surface ring-border" },
  proxy_vpn:   { label: "VPN / Proxy", cls: "text-danger bg-danger/10 ring-danger/30" },
  hosting:     { label: "Hosting",     cls: "text-warning bg-warning/10 ring-warning/30" },
};

function ConnectionPointsSection({ ipHistory, tz, onSearchHash }) {
  const [expanded, setExpanded] = useState(null);

  const entries = (ipHistory ?? []).filter((e) => e.ipHashShort);
  if (!entries.length) return null;

  const toggle = (hash) => setExpanded((prev) => (prev === hash ? null : hash));

  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>Previous Connection Points</span>
        <span className="font-mono normal-case tracking-normal">{entries.length}</span>
      </h3>
      <div className="rounded-md ring-1 ring-border overflow-hidden divide-y divide-border">
        {entries.map((entry) => {
          const flag = flagEmoji(entry.isoCode);
          const connMeta = CONN_TYPE_META[entry.connType] ?? null;
          const isOpen = expanded === entry.ipHash;
          const summary =
            connMeta?.label ??
            (entry.isProxy || entry.isVpn ? "Proxy/VPN" : "Unknown class");
          const lastSeenDate = entry.lastSeen
            ? new Date(entry.lastSeen * 1000).toLocaleDateString(
                undefined,
                tz ? { timeZone: tz } : {},
              )
            : null;
          const firstSeenDate = entry.firstSeen
            ? new Date(entry.firstSeen * 1000).toLocaleDateString(
                undefined,
                tz ? { timeZone: tz } : {},
              )
            : null;

          return (
            <div key={entry.ipHash}>
              <button
                type="button"
                onClick={() => toggle(entry.ipHash)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface/60 transition-colors"
              >
                <span className="text-base leading-none shrink-0" aria-hidden>
                  {flag}
                </span>
                <span className="font-mono text-xs text-foreground shrink-0 w-36 truncate">
                  {entry.ipHashShort}
                </span>
                <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                  {entry.country ?? "Unknown location"} · {summary}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  {(entry.isProxy || entry.isVpn) && (
                    <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 text-danger bg-danger/10 ring-danger/30">
                      {entry.isVpn ? "VPN" : "Proxy"}
                    </span>
                  )}
                  {connMeta && (
                    <span className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${connMeta.cls}`}>
                      {connMeta.label}
                    </span>
                  )}
                  {lastSeenDate && (
                    <span className="text-[10px] text-muted-foreground font-mono w-20 text-right">
                      {lastSeenDate}
                    </span>
                  )}
                  <svg
                    className={`size-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </button>

              {isOpen && (
                <div className="px-4 pb-3 pt-1 bg-surface/30 border-t border-border">
                  <dl className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                    {entry.asn && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">ASN</dt>
                        <dd className="font-mono text-foreground">{entry.asn}</dd>
                      </div>
                    )}
                    {entry.isp && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">ISP / Provider</dt>
                        <dd className="font-mono text-foreground truncate" title={entry.isp}>{entry.isp}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Type</dt>
                      <dd className="font-mono text-foreground">{summary}</dd>
                    </div>
                    {firstSeenDate && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">First Seen</dt>
                        <dd className="font-mono text-foreground">{firstSeenDate}</dd>
                      </div>
                    )}
                    {lastSeenDate && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Last Seen</dt>
                        <dd className="font-mono text-foreground">{lastSeenDate}</dd>
                      </div>
                    )}
                    {entry.serverName && (
                      <div className="col-span-2">
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Server</dt>
                        <dd className="font-mono text-foreground truncate" title={entry.serverName}>{entry.serverName}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Flagged</dt>
                      <dd className={`font-mono ${(entry.isProxy || entry.isVpn) ? "text-danger" : "text-success"}`}>
                        {entry.isVpn ? "VPN" : entry.isProxy ? "Proxy" : "Clean"}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onSearchHash?.(entry.ipHash)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-brand text-brand-foreground text-[10px] font-mono uppercase tracking-widest hover:opacity-90"
                    >
                      Search This Hash
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export { Route };


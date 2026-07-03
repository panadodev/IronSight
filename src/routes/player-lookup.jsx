import { LENGTH_OPTIONS } from "@/components/ban-dialog";
import { EacBanStatus } from "@/components/eac-ban-status";
import { ExternalBansSection } from "@/components/external-bans";
import { HINTS } from "@/components/hint";
import { LinkedAccountsSection } from "@/components/linked-accounts";
import { NewBanDialog, computeNextWipeTs } from "@/components/new-ban-dialog";
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
import {
  playerSearchHistory,
  usePlayerSearchHistory,
} from "@/lib/player-search-history";
import { useTimezone } from "@/lib/timezone-store";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  Clock,
  Crosshair,
  FolderOpen,
  History,
  MessageSquare,
  MicOff,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  "7d": 10080,
  "14d": 20160,
  "30d": 43200,
};

function lengthToExpiresAt(length, serverName = "") {
  if (length === "permanent") return null;
  if (length === "next_wipe") return computeNextWipeTs([serverName]);
  if (!LENGTH_MINUTES[length]) return null;
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

const IP_ADDRESS_RE = /^(\d{1,3}\.){3}\d{1,3}$|^(?=.*:)[\da-fA-F:]+$/;

function normalizeSteamLookupQuery(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/^['\"]+|['\"]+$/g, "");
  return /^\d{17}$/.test(raw) ? raw : "";
}

const Route = createFileRoute("/player-lookup")({
  head: () => ({
    meta: [{ title: "Player Lookup — IronSight" }],
  }),
  validateSearch: (s) => ({
    steam: normalizeSteamLookupQuery(s.steam) || void 0,
    ipHash:
      typeof s.ipHash === "string" &&
      (IP_ADDRESS_RE.test(s.ipHash.trim()) ||
        /^[a-fA-F0-9]{6,64}$/.test(s.ipHash))
        ? normalizePlayerLookupIpQuery(s.ipHash)
        : void 0,
  }),
  component: PlayerLookupPage,
});

function normalizePlayerLookupIpQuery(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (IP_ADDRESS_RE.test(raw)) return raw;
  if (!/^[a-fA-F0-9]{6,64}$/.test(raw)) return "";
  return raw.toUpperCase();
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
    sessionUser,
  } = useAuth();

  const recentHistory = usePlayerSearchHistory();
  const [recentOpen, setRecentOpen] = useState(false);
  const recentRef = useRef(null);

  // Initialize the history store with the current user's ID
  useEffect(() => {
    if (sessionUser?.userId) playerSearchHistory.init(sessionUser.userId);
  }, [sessionUser?.userId]);

  // Close the recent dropdown when clicking outside
  useEffect(() => {
    if (!recentOpen) return;
    const handler = (e) => {
      if (recentRef.current && !recentRef.current.contains(e.target)) {
        setRecentOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [recentOpen]);
  const tz = useTimezone();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [input, setInput] = useState(search.steam ?? search.ipHash ?? "");
  const [steamId, setSteamId] = useState(search.steam ?? null);
  const [ipHashQuery, setIpHashQuery] = useState(search.ipHash ?? null);
  const [ipHashMatches, setIpHashMatches] = useState([]);
  const [ipHashLoading, setIpHashLoading] = useState(false);
  const [ipHashError, setIpHashError] = useState("");
  const [ipSearchTick, setIpSearchTick] = useState(0);
  const [nameQuery, setNameQuery] = useState("");
  const [nameMatches, setNameMatches] = useState([]);
  const [nameSearchLoading, setNameSearchLoading] = useState(false);
  const [nameSearchError, setNameSearchError] = useState("");
  const [bmResolving, setBmResolving] = useState(false);
  const [bmResolveError, setBmResolveError] = useState("");

  const [playerData, setPlayerData] = useState(null);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState(null);
  const [liveServerStatus, setLiveServerStatus] = useState({
    isOnline: false,
    serverId: null,
    serverName: null,
    connectedAt: null,
  });
  const [firstFetch, setFirstFetch] = useState(false);
  const pollRef = useRef(null);
  const pollAttemptsRef = useRef(0);
  // Silent re-poll timer for when a refresh returns early with `enriching:
  // true` (core data written, deep enrichment still running server-side).
  const enrichPollRef = useRef(null);
  const enrichAttemptsRef = useRef(0);
  // Remembers the last (steamId, org) we fetched so the fetch effect can tell an
  // org switch (→ force a fresh pull from the new org's keys) apart from a new
  // player or first load (→ a normal cache-first GET).
  const lastFetchRef = useRef({ steamId: null, orgId: null });

  const [offenses, setOffenses] = useState([]);
  const [offensesLoading, setOffensesLoading] = useState(false);

  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);

  const [pvpData, setPvpData] = useState(null);
  const [pvpLoading, setPvpLoading] = useState(false);

  const [issueBanOpen, setIssueBanOpen] = useState(false);
  const [issueBanActionType, setIssueBanActionType] = useState("ban");
  const [manageBansOpen, setManageBansOpen] = useState(false);
  const [manageMutesOpen, setManageMutesOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(false);
  const refreshCooldownRef = useRef(null);
  const [bmRateLimitWarning, setBmRateLimitWarning] = useState(false);

  const [chatLines, setChatLines] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatHasMore, setChatHasMore] = useState(false);
  const [chatLoadingMore, setChatLoadingMore] = useState(false);
  const chatSentinelRef = useRef(null);
  const chatScrollRef = useRef(null);
  const chatLoadingMoreRef = useRef(false);
  const [chatSearch, setChatSearch] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [confirmedLines, setConfirmedLines] = useState([]);

  const [caseDialogOpen, setCaseDialogOpen] = useState(false);
  const [hasOpenTicketInCaseOrg, setHasOpenTicketInCaseOrg] = useState(false);

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
  const nameSearchOrgIds =
    selectedOrgIds.filter((id) => hasOrgPermission(id, "players_view")).length >
    0
      ? selectedOrgIds.filter((id) => hasOrgPermission(id, "players_view"))
      : lookupOrgs.map((o) => o.id);

  const banOrgId =
    selectedOrgIds.find(canCreateBansInOrg) ??
    orgs.find((o) => canCreateBansInOrg(o.id))?.id ??
    "";

  const offenseOrgIds = selectedOrgIds.filter(canCreateBansInOrg);

  // No ban permission anywhere → view-only (hide ban/mute actions).
  const isSupportOnly = !banOrgId;

  const isLiveOnServer = liveServerStatus.isOnline === true;
  const liveServerName = liveServerStatus.serverName ?? null;

  const canViewChatInOrg = (id) =>
    hasOrgPermission(id, "chat_view") ||
    hasOrgPermission(id, "players_view") ||
    hasOrgPermission(id, "org_manage");
  const chatOrgId =
    selectedOrgIds.find(canViewChatInOrg) ??
    lookupOrgs.find((o) => canViewChatInOrg(o.id))?.id ??
    null;

  // IP access spans all the caller's orgs (matches the server, which shows IPs
  // when the caller has ip_read anywhere). Per-IP source filtering happens below.
  const canViewIpConnections = orgs.some((o) =>
    hasOrgPermission(o.id, "ip_read"),
  );

  const canViewSessionHistory = orgs.some((o) =>
    hasOrgPermission(o.id, "player_session_history"),
  );
  const canViewSteamFriends = orgs.some((o) =>
    hasOrgPermission(o.id, "player_steam_friends"),
  );
  const canViewNotes = orgs.some((o) => hasOrgPermission(o.id, "player_notes"));

  const caseOrgIds = orgs
    .filter((o) => hasOrgPermission(o.id, "cases_create"))
    .map((o) => o.id);
  const caseOrgId = caseOrgIds[0] ?? null;
  const canCreateCase = caseOrgIds.length > 0;

  const fetchPlayer = useCallback(
    async (forceRefresh = false, silent = false) => {
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      if (enrichPollRef.current) {
        clearTimeout(enrichPollRef.current);
        enrichPollRef.current = null;
      }
      if (!steamId || !fetchOrgId) return;
      if (!silent) setPlayerLoading(true);
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
          // A silent enrichment poll must never wipe the data on screen.
          if (silent) return;
          setPlayerError(body?.error ?? "Failed to fetch player data.");
          setPlayerData(null);
        } else if (body.fetching) {
          if (silent) return;
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
          // Record this player in the per-user search history
          if (body.steamId) {
            playerSearchHistory.push({
              steamId: body.steamId,
              displayName: body.displayName ?? body.steamId,
              avatarUrl: body.avatarUrl ?? null,
            });
          }
          // Core data returned while the deep enrichment (proxycheck, full
          // session history, alt scoring) is still running server-side —
          // silently re-poll to pick it up once it lands.
          if (body.enriching && enrichAttemptsRef.current < 10) {
            enrichAttemptsRef.current += 1;
            enrichPollRef.current = setTimeout(
              () => fetchPlayer(false, true),
              3000,
            );
          } else {
            enrichAttemptsRef.current = 0;
          }
        }
      } catch {
        if (silent) return;
        setPlayerError("Failed to fetch player data.");
        setPlayerData(null);
      } finally {
        if (!silent) setPlayerLoading(false);
        if (forceRefresh) setRefreshing(false);
      }
    },
    [steamId, fetchOrgId],
  );

  const fetchLiveServerStatus = useCallback(async () => {
    if (!steamId || !fetchOrgId) return;
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(fetchOrgId)}/players/${encodeURIComponent(steamId)}/online-status`,
        { credentials: "include" },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) return;
      setLiveServerStatus({
        isOnline: body.isOnline === true,
        serverId: body.serverId ?? null,
        serverName: body.serverName ?? null,
        connectedAt: body.connectedAt ?? null,
      });
    } catch {
      // Keep the previous indicator state on transient network errors.
    }
  }, [steamId, fetchOrgId]);

  const searchPlayersByName = useCallback(
    async (query) => {
      const q = String(query ?? "").trim();
      if (q.length < 2) {
        setNameQuery("");
        setNameMatches([]);
        setNameSearchError("");
        return;
      }
      if (nameSearchOrgIds.length === 0) {
        setNameQuery(q);
        setNameMatches([]);
        setNameSearchError(
          "No organization with player lookup access is available.",
        );
        return;
      }

      setNameSearchLoading(true);
      setNameQuery(q);
      setNameSearchError("");
      try {
        const responses = await Promise.all(
          nameSearchOrgIds.map(async (orgId) => {
            const res = await fetch(
              `/api/orgs/${encodeURIComponent(orgId)}/players/search?q=${encodeURIComponent(q)}`,
              { credentials: "include" },
            );
            const body = await res.json().catch(() => ({}));
            return { ok: res.ok, body };
          }),
        );

        const successful = responses.filter((r) => r.ok);
        if (successful.length === 0) {
          const firstError = responses.find((r) => !r.ok)?.body?.error;
          setNameMatches([]);
          setNameSearchError(firstError ?? "Failed to search players by name.");
          return;
        }

        const priority = {
          display_name: 0,
          previous_name: 1,
          steam_id: 2,
        };
        const merged = new Map();
        for (const { body } of successful) {
          for (const player of Array.isArray(body?.players)
            ? body.players
            : []) {
            const steam = String(player?.steamId ?? "");
            if (!steam) continue;
            const existing = merged.get(steam);
            if (!existing) {
              merged.set(steam, player);
              continue;
            }
            const currentRank =
              priority[String(player?.matchType ?? "steam_id")] ?? 3;
            const existingRank =
              priority[String(existing?.matchType ?? "steam_id")] ?? 3;
            const currentSeen = Number(player?.lastSeenAt ?? 0);
            const existingSeen = Number(existing?.lastSeenAt ?? 0);
            if (
              currentRank < existingRank ||
              (currentRank === existingRank && currentSeen > existingSeen)
            ) {
              merged.set(steam, player);
            }
          }
        }

        const mergedList = [...merged.values()].sort((a, b) => {
          const aRank = priority[String(a?.matchType ?? "steam_id")] ?? 3;
          const bRank = priority[String(b?.matchType ?? "steam_id")] ?? 3;
          if (aRank !== bRank) return aRank - bRank;
          return Number(b?.lastSeenAt ?? 0) - Number(a?.lastSeenAt ?? 0);
        });
        setNameMatches(mergedList.slice(0, 20));
      } catch {
        setNameMatches([]);
        setNameSearchError("Failed to search players by name.");
      } finally {
        setNameSearchLoading(false);
      }
    },
    [nameSearchOrgIds],
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
    setPvpData(null);
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    pollAttemptsRef.current = 0;
    if (enrichPollRef.current) {
      clearTimeout(enrichPollRef.current);
      enrichPollRef.current = null;
    }
    enrichAttemptsRef.current = 0;
    fetchPlayer(orgSwitched);
  }, [steamId, fetchOrgId, orgsLoaded, ipHashQuery]);

  useEffect(() => {
    if (!steamId || !fetchOrgId || !playerData) {
      setLiveServerStatus({
        isOnline: false,
        serverId: null,
        serverName: null,
        connectedAt: null,
      });
      return;
    }

    fetchLiveServerStatus();
    const id = setInterval(() => {
      fetchLiveServerStatus();
    }, 15000);

    return () => clearInterval(id);
  }, [steamId, fetchOrgId, playerData, fetchLiveServerStatus]);

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
  }, [ipHashQuery, fetchOrgId, ipSearchTick]);

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

  // PVP kills/deaths + body-part stats from server combat logs. Entitlement
  // (players_view orgs) is resolved server-side — fetch once per player.
  useEffect(() => {
    if (!steamId) {
      setPvpData(null);
      return;
    }
    let cancelled = false;
    setPvpLoading(true);
    fetch(`/api/players/${encodeURIComponent(steamId)}/pvp?limit=25`, {
      credentials: "include",
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? "Failed to load PVP feed.");
        return body;
      })
      .then((b) => {
        if (!cancelled) setPvpData(b);
      })
      .catch(() => {
        if (!cancelled) setPvpData(null);
      })
      .finally(() => {
        if (!cancelled) setPvpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [steamId]);

  // Debounce the chat search box into the query that drives fetches.
  useEffect(() => {
    const t = setTimeout(() => setChatQuery(chatSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [chatSearch]);

  // Chat history for this player across the org's servers
  useEffect(() => {
    if (!steamId || !chatOrgId) {
      setChatLines([]);
      setChatHasMore(false);
      return;
    }
    let cancelled = false;
    setChatLoading(true);
    setChatHasMore(false);
    const qs = chatQuery ? `&q=${encodeURIComponent(chatQuery)}` : "";
    fetch(`/api/players/${encodeURIComponent(steamId)}/chat?limit=10${qs}`, {
      credentials: "include",
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok)
          throw new Error(body?.error ?? "Failed to load chat history.");
        return body;
      })
      .then((b) => {
        if (!cancelled) {
          setChatLines(b.lines ?? []);
          setChatHasMore(b.hasMore ?? false);
        }
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
  }, [steamId, chatOrgId, chatQuery]);

  // Confirmed-toxic messages pinned above the full history (skipped while
  // searching so search results span the whole history unfiltered).
  useEffect(() => {
    if (!steamId || !chatOrgId || chatQuery) {
      setConfirmedLines([]);
      return;
    }
    let cancelled = false;
    fetch(
      `/api/players/${encodeURIComponent(steamId)}/chat?limit=50&filter=confirmed`,
      { credentials: "include" },
    )
      .then((r) => (r.ok ? r.json() : { lines: [] }))
      .then((b) => {
        if (!cancelled) setConfirmedLines(b.lines ?? []);
      })
      .catch(() => {
        if (!cancelled) setConfirmedLines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [steamId, chatOrgId, chatQuery]);

  const loadMoreChat = useCallback(() => {
    if (!steamId || !chatOrgId || chatLoadingMoreRef.current || !chatHasMore)
      return;
    const oldest = chatLines[chatLines.length - 1]?.ts;
    if (!oldest) return;
    chatLoadingMoreRef.current = true;
    setChatLoadingMore(true);
    const qs = chatQuery ? `&q=${encodeURIComponent(chatQuery)}` : "";
    fetch(
      `/api/players/${encodeURIComponent(steamId)}/chat?limit=20&before=${oldest}${qs}`,
      { credentials: "include" },
    )
      .then((r) => r.json())
      .then((b) => {
        setChatLines((prev) => [...prev, ...(b.lines ?? [])]);
        setChatHasMore(b.hasMore ?? false);
      })
      .catch(() => {})
      .finally(() => {
        chatLoadingMoreRef.current = false;
        setChatLoadingMore(false);
      });
  }, [steamId, chatOrgId, chatHasMore, chatLines, chatQuery]);

  useEffect(() => {
    const sentinel = chatSentinelRef.current;
    const container = chatScrollRef.current;
    if (!sentinel || !container || !chatHasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreChat();
      },
      { root: container, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [chatHasMore, loadMoreChat]);

  const renderChatLine = (line, keyPrefix = "") => {
    const flags = Array.isArray(line.aiFlags) ? line.aiFlags : [];
    const confirmedFlags = flags.filter(
      (f) => f.resolved && f.resolutionType === "confirmed",
    );
    const pendingFlags = flags.filter((f) => !f.resolved);
    const rowClass =
      confirmedFlags.length > 0
        ? "bg-danger/10 ring-danger/40"
        : pendingFlags.length > 0
          ? "bg-warning/5 ring-warning/30"
          : "bg-background/60 ring-border";
    return (
      <li
        key={`${keyPrefix}${line.id}`}
        className={`ring-1 rounded px-2 py-1.5 ${rowClass}`}
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
        <div className="flex items-center gap-2 mt-1 text-[9px] font-mono text-muted-foreground flex-wrap">
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
          {confirmedFlags.map((f) => (
            <span
              key={`c-${f.category}`}
              className="px-1 py-0.5 rounded bg-danger/20 text-danger uppercase tracking-wider text-[8px]"
            >
              {f.category} · toxic
            </span>
          ))}
          {pendingFlags.map((f) => (
            <span
              key={`p-${f.category}`}
              className="px-1 py-0.5 rounded bg-warning/15 text-warning uppercase tracking-wider text-[8px]"
            >
              {f.category}
            </span>
          ))}
        </div>
      </li>
    );
  };

  useEffect(() => {
    if (!steamId || !caseOrgId) {
      setHasOpenTicketInCaseOrg(false);
      return;
    }
    let cancelled = false;
    fetch(
      `/api/orgs/${encodeURIComponent(caseOrgId)}/players/${encodeURIComponent(steamId)}/open-ticket`,
      { credentials: "include" },
    )
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setHasOpenTicketInCaseOrg(data.hasOpenTicket === true);
      })
      .catch(() => {
        if (!cancelled) setHasOpenTicketInCaseOrg(false);
      });
    return () => {
      cancelled = true;
    };
  }, [steamId, caseOrgId]);

  const submit = (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    const normalizedLookup = normalizePlayerLookupIpQuery(trimmed);
    const isSteam = /^\d{17}$/.test(trimmed);

    // BattleMetrics: bare numeric ID (non-Steam) or a battlemetrics.com/players URL.
    const bmUrlMatch = trimmed.match(/battlemetrics\.com\/players\/([0-9]+)/i);
    const isBmNumeric = !isSteam && /^[0-9]{1,15}$/.test(trimmed);
    const bmId = bmUrlMatch ? bmUrlMatch[1] : isBmNumeric ? trimmed : null;

    if (bmId) {
      setBmResolveError("");
      setBmResolving(true);
      const orgId = fetchOrgId;
      const queryParam = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
      fetch(`/api/players/by-bm/${encodeURIComponent(bmId)}${queryParam}`, {
        credentials: "include",
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.steamId) {
            navigate({ search: { steam: data.steamId, ipHash: undefined } });
          } else {
            setBmResolveError(
              data.error ?? "Could not resolve BattleMetrics ID to a Steam ID.",
            );
          }
        })
        .catch(() =>
          setBmResolveError("Network error resolving BattleMetrics ID."),
        )
        .finally(() => setBmResolving(false));
      return;
    }

    if (!isSteam && !normalizedLookup && trimmed.length < 2) return;
    setBmResolveError("");
    // Update the URL; the sync effect picks it up and drives the fetch. Using
    // navigate keeps the address bar, state, and any shared link consistent.
    if (isSteam && trimmed === search.steam && !search.ipHash) {
      // Same ID re-submitted (URL won't change → effect won't fire): refetch.
      fetchPlayer(false);
    } else if (
      !isSteam &&
      normalizedLookup &&
      normalizedLookup === search.ipHash &&
      !search.steam
    ) {
      setIpSearchTick((n) => n + 1);
    } else if (!isSteam && !normalizedLookup) {
      navigate({ search: { steam: undefined, ipHash: undefined } });
      searchPlayersByName(trimmed);
    } else {
      navigate({
        search: isSteam
          ? { steam: trimmed, ipHash: undefined }
          : { steam: undefined, ipHash: normalizedLookup },
      });
    }
  };

  const handleRefresh = async () => {
    if (refreshing || refreshCooldown) return;
    setRefreshing(true);
    await fetchPlayer(true);
    setRefreshCooldown(true);
    if (refreshCooldownRef.current) clearTimeout(refreshCooldownRef.current);
    refreshCooldownRef.current = setTimeout(
      () => setRefreshCooldown(false),
      30000,
    );
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
      out.push({
        key: "steam_private",
        label: "Private Steam",
        tone: "warning",
      });
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
    if (playerData.boughtHoursTriggered)
      out.push({ key: "botted_hours", label: "Botted Hours", tone: "warning" });

    return out;
  })();

  const loaded = !playerLoading && playerData;

  const _nowSec = Math.floor(Date.now() / 1000);
  const activeBan = visibleOffenses.find(
    (o) =>
      o.actionType === "ban" &&
      !o.revoked &&
      (!o.expiresAt || o.expiresAt > _nowSec),
  );
  const activeMute = visibleOffenses.find(
    (o) =>
      o.actionType === "mute" &&
      !o.revoked &&
      (!o.expiresAt || o.expiresAt > _nowSec),
  );
  function formatRemaining(expiresAt) {
    if (!expiresAt) return "permanent";
    const secs = expiresAt - _nowSec;
    if (secs <= 0) return "expires soon";
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h remaining`;
    if (h > 0) return `${h}h ${m}m remaining`;
    return `${m}m remaining`;
  }

  return (
    <SteamRequiredGate>
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        <SiteNav />
        <main className="flex-1 flex flex-col min-h-0">
          <div className="border-b border-border bg-surface/30 px-4 sm:px-6 lg:px-8 xl:px-10 py-5">
            <div className="w-full mx-auto">
              <div className="flex items-center justify-between mb-2">
                <h1 className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground">
                  Player Lookup
                </h1>
                {recentHistory.length > 0 && (
                  <div className="relative" ref={recentRef}>
                    <button
                      type="button"
                      onClick={() => setRecentOpen((o) => !o)}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 text-[11px] font-mono bg-surface text-muted-foreground ring-1 ring-border rounded-md hover:bg-surface-bright hover:text-foreground transition-colors"
                    >
                      <Clock className="size-3 shrink-0" />
                      Recent
                    </button>
                    {recentOpen && (
                      <div className="absolute right-0 top-full mt-1 w-72 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
                        <p className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60 border-b border-border">
                          Recent Searches
                        </p>
                        <ul className="py-1 max-h-80 overflow-y-auto">
                          {recentHistory.map((entry) => (
                            <li key={entry.steamId}>
                              <button
                                type="button"
                                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-surface-bright text-left transition-colors"
                                onClick={() => {
                                  setRecentOpen(false);
                                  navigate({
                                    search: {
                                      steam: entry.steamId,
                                      ipHash: undefined,
                                    },
                                  });
                                }}
                              >
                                {entry.avatarUrl ? (
                                  <img
                                    src={entry.avatarUrl}
                                    alt=""
                                    className="size-7 rounded ring-1 ring-black/30 shrink-0 object-cover"
                                  />
                                ) : (
                                  <div
                                    className="size-7 rounded ring-1 ring-black/30 grid place-items-center font-mono font-bold text-background shrink-0 text-[10px]"
                                    style={{
                                      background: steamIdColor(entry.steamId),
                                    }}
                                  >
                                    {(entry.displayName ?? entry.steamId)
                                      .replace(/[\[\]]/g, "")
                                      .slice(0, 2)
                                      .toUpperCase()}
                                  </div>
                                )}
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-medium text-foreground truncate">
                                    {entry.displayName}
                                  </p>
                                  <p className="text-[10px] font-mono text-muted-foreground truncate">
                                    {entry.steamId}
                                  </p>
                                </div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <form onSubmit={submit} className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Search by Steam ID, BattleMetrics ID or URL, raw IP, IP hash, or player name"
                    className="w-full pl-9 pr-3 py-2.5 bg-background ring-1 ring-border rounded-md text-sm font-mono focus:outline-none focus:ring-brand"
                  />
                </div>
                <button
                  type="submit"
                  disabled={playerLoading || firstFetch || bmResolving}
                  className="px-4 py-2.5 bg-brand text-brand-foreground rounded-md text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  {bmResolving ? "Resolving…" : "Lookup"}
                </button>
              </form>
              {bmResolveError && (
                <p className="mt-2 text-[11px] text-destructive">
                  {bmResolveError}
                </p>
              )}
              {input.trim().length > 0 &&
                !/^\d{17}$/.test(input.trim()) &&
                !normalizePlayerLookupIpQuery(input.trim()) &&
                input.trim().length < 2 && (
                  <p className="mt-2 text-[11px] text-warning">
                    Enter at least 2 characters for name search, or use a Steam
                    ID / IP / IP hash.
                  </p>
                )}
            </div>
          </div>

          {!steamId && !ipHashQuery && !nameQuery ? (
            <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
              Enter a Steam ID, raw IP, hashed IP token, or player name above.
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
              <div className="w-full mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 py-8">
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
                  {/* Left Panel */}
                  <div className="space-y-6 xl:col-span-3">
                    {/* Steam Friends */}
                    {canViewSteamFriends && (
                      <PlayerFriendsSection friends={playerData.friends} />
                    )}

                    {/* Server History */}
                    {canViewSessionHistory && (
                      <div className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
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
                      </div>
                    )}

                    {/* Session Timeline */}
                    {canViewSessionHistory && (
                      <SessionTimeline
                        sessionWindows={playerData.sessionWindows}
                      />
                    )}

                    {/* Chat History */}
                    {chatOrgId && (
                      <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
                        <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
                          <MessageSquare className="size-3 shrink-0" />
                          Chat History
                          <span className="font-mono normal-case tracking-normal text-muted-foreground ml-auto">
                            {chatLines.length}
                            {chatHasMore ? "+" : ""}
                          </span>
                        </h2>
                        <div className="relative mb-3">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                          <input
                            type="text"
                            value={chatSearch}
                            onChange={(e) => setChatSearch(e.target.value)}
                            placeholder="Search chat history…"
                            className="w-full pl-8 pr-7 py-1.5 bg-background ring-1 ring-border rounded-md text-xs focus:outline-none focus:ring-brand"
                          />
                          {chatSearch && (
                            <button
                              type="button"
                              onClick={() => setChatSearch("")}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-sm leading-none"
                              aria-label="Clear search"
                            >
                              ×
                            </button>
                          )}
                        </div>
                        {chatLoading ? (
                          <p className="text-xs text-muted-foreground italic animate-pulse">
                            Loading…
                          </p>
                        ) : chatLines.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">
                            {chatQuery
                              ? "No messages match your search."
                              : "No chat messages on record."}
                          </p>
                        ) : (
                          <div
                            ref={chatScrollRef}
                            className="max-h-[480px] overflow-y-auto"
                          >
                            {!chatQuery && confirmedLines.length > 0 && (
                              <div className="mb-2">
                                <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-danger mb-1">
                                  Confirmed toxic ({confirmedLines.length})
                                </p>
                                <ul className="space-y-1">
                                  {confirmedLines.map((line) =>
                                    renderChatLine(line, "confirmed-"),
                                  )}
                                </ul>
                                <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mt-3 mb-1">
                                  All messages
                                </p>
                              </div>
                            )}
                            <ul className="space-y-1">
                              {chatLines.map((line) => renderChatLine(line))}
                            </ul>
                            <div
                              ref={chatSentinelRef}
                              className="py-2 flex items-center justify-center"
                            >
                              {chatLoadingMore ? (
                                <span className="text-[10px] text-muted-foreground">
                                  Loading…
                                </span>
                              ) : !chatHasMore && chatLines.length > 0 ? (
                                <span className="text-[10px] text-muted-foreground/40">
                                  All messages loaded
                                </span>
                              ) : null}
                            </div>
                          </div>
                        )}
                      </section>
                    )}
                  </div>

                  {/* Middle Panel */}
                  <div className="space-y-8 xl:col-span-6">
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
                                <span
                                  className={
                                    "inline-block size-2 rounded-full ring-1 ring-black/20 shrink-0 " +
                                    (isLiveOnServer
                                      ? "bg-success"
                                      : "bg-muted-foreground/40")
                                  }
                                  title={
                                    isLiveOnServer
                                      ? `Online${liveServerName ? ` on ${liveServerName}` : " on a server"}`
                                      : "Offline"
                                  }
                                  aria-label={
                                    isLiveOnServer
                                      ? `Online${liveServerName ? ` on ${liveServerName}` : " on a server"}`
                                      : "Offline"
                                  }
                                />
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
                                      {playerData.bm.rustBansCount !== 1
                                        ? "s"
                                        : ""}
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

                          <div className="flex items-center gap-1.5 shrink-0">
                            <CacheStamp
                              playerData={playerData}
                              refreshing={refreshing}
                            />
                            <button
                              type="button"
                              onClick={handleRefresh}
                              disabled={refreshing || refreshCooldown}
                              className={`inline-flex items-center justify-center h-8 w-8 rounded-md ring-1 disabled:opacity-50 ${bmRateLimitWarning ? "bg-warning/10 text-warning ring-warning/40 hover:bg-warning/20" : "bg-surface text-muted-foreground ring-border hover:bg-surface-bright"}`}
                              title={
                                refreshCooldown
                                  ? "Wait a moment before refreshing again"
                                  : bmRateLimitWarning
                                    ? "BattleMetrics token is >90% rate-limited — data may not refresh"
                                    : "Refresh data from BattleMetrics / Steam"
                              }
                            >
                              {bmRateLimitWarning ? (
                                <AlertTriangle className="size-3.5 shrink-0" />
                              ) : (
                                <RefreshCw
                                  className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
                                />
                              )}
                            </button>

                            {canCreateCase && (
                              <button
                                type="button"
                                onClick={() => setCaseDialogOpen(true)}
                                disabled={!!activeBan || hasOpenTicketInCaseOrg}
                                title={
                                  activeBan
                                    ? "Player is already banned"
                                    : hasOpenTicketInCaseOrg
                                      ? "An open ticket already exists for this player"
                                      : "Create an internal staff case for this player"
                                }
                                className={`inline-flex items-center gap-1.5 h-8 px-2.5 text-xs font-semibold rounded-md ring-1 transition-colors ${
                                  activeBan || hasOpenTicketInCaseOrg
                                    ? "bg-surface text-muted-foreground ring-border opacity-50 cursor-not-allowed"
                                    : "bg-sky-500/15 text-sky-400 ring-sky-500/30 hover:bg-sky-500/25"
                                }`}
                              >
                                <FolderOpen className="size-3.5" aria-hidden />
                                Case
                              </button>
                            )}
                            {!isSupportOnly && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setManageBansOpen(true)}
                                  title="Manage ban history"
                                  className="inline-flex items-center justify-center h-8 w-8 bg-surface text-muted-foreground rounded-md ring-1 ring-border hover:bg-surface-bright hover:text-foreground"
                                >
                                  <Ban className="size-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setManageMutesOpen(true)}
                                  title="Manage mute history"
                                  className="inline-flex items-center justify-center h-8 w-8 bg-surface text-muted-foreground rounded-md ring-1 ring-border hover:bg-surface-bright hover:text-foreground"
                                >
                                  <MicOff className="size-3.5" />
                                </button>
                              </>
                            )}
                            <button
                              onClick={() => {
                                if (!activeMute) {
                                  setIssueBanActionType("mute");
                                  setIssueBanOpen(true);
                                }
                              }}
                              disabled={!!activeMute}
                              title={
                                activeMute
                                  ? `Already muted — ${formatRemaining(activeMute.expiresAt)}`
                                  : "Issue a mute"
                              }
                              className={`flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs font-semibold uppercase tracking-widest ${activeMute ? "bg-surface text-muted-foreground ring-1 ring-border cursor-not-allowed opacity-60" : "bg-warning/15 text-warning ring-1 ring-warning/40 hover:bg-warning/25"}`}
                            >
                              <MicOff className="size-3.5" />
                              Mute
                            </button>
                            {!isSupportOnly && (
                              <button
                                onClick={() => {
                                  if (!activeBan) {
                                    setIssueBanActionType("ban");
                                    setIssueBanOpen(true);
                                  }
                                }}
                                disabled={!!activeBan}
                                title={
                                  activeBan
                                    ? `Already banned — ${formatRemaining(activeBan.expiresAt)}`
                                    : "Issue a ban"
                                }
                                className={`flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs font-semibold uppercase tracking-widest ${activeBan ? "bg-surface text-muted-foreground ring-1 ring-border cursor-not-allowed opacity-60" : "bg-danger text-danger-foreground hover:opacity-90"}`}
                              >
                                <Ban className="size-3.5" />
                                Ban
                              </button>
                            )}
                          </div>
                        </div>

                        {playerData.flaggedGroups?.length > 0 && (
                          <div className="rounded-md ring-1 ring-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning flex items-start gap-2">
                            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                            <span>
                              <strong>Possible botted account</strong> — member
                              of flagged Steam group
                              {playerData.flaggedGroups.length !== 1 ? "s" : ""}
                              :{" "}
                              {playerData.flaggedGroups
                                .map((g) => g.label)
                                .join(", ")}
                            </span>
                          </div>
                        )}

                        {fetchOrgId && (
                          <div className="space-y-4">
                            {/* Steam */}
                            <div>
                              <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">
                                Steam
                              </p>
                              <div className="grid grid-cols-2 md:grid-cols-5 gap-y-4 gap-x-6">
                                <Field
                                  label="Rust Hours"
                                  hint={HINTS.steamHours}
                                  value={
                                    playerData.steam.dataPublic
                                      ? fmtNum(playerData.steam.rustHours)
                                      : "Private"
                                  }
                                  tone={
                                    !playerData.steam.dataPublic
                                      ? "warning"
                                      : undefined
                                  }
                                />
                                <Field
                                  label="Acct Age"
                                  value={accountAge(
                                    playerData.steam.profileCreatedAt,
                                  )}
                                  tone={
                                    playerData.steam.profileCreatedAt &&
                                    Date.now() / 1000 -
                                      playerData.steam.profileCreatedAt <
                                      30 * 86400
                                      ? "warning"
                                      : undefined
                                  }
                                />
                                <Field
                                  label="Visibility"
                                  hint={HINTS.steamVisibility}
                                  value={
                                    playerData.steam.profileVisibility ?? "—"
                                  }
                                  tone={
                                    playerData.steam.profileVisibility ===
                                    "Public"
                                      ? "success"
                                      : playerData.steam.profileVisibility ===
                                          "Friends Only"
                                        ? "warning"
                                        : playerData.steam.profileVisibility ===
                                            "Private"
                                          ? "danger"
                                          : playerData.steam
                                                .profileVisibility ===
                                              "Not Configured"
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
                                    (playerData.steam.vacCount ?? 0) +
                                      (playerData.steam.gameBanCount ?? 0) >
                                    0
                                      ? "danger"
                                      : undefined
                                  }
                                />
                              </div>
                            </div>

                            {/* BattleMetrics */}
                            {playerData.bm && (
                              <div>
                                <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">
                                  BattleMetrics
                                </p>
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-y-4 gap-x-6">
                                  <Field
                                    label="BM Hours"
                                    hint={HINTS.bmHours}
                                    value={fmtNum(playerData.bm.rustHours)}
                                  />
                                  <Field
                                    label="BM Acct Age"
                                    value={accountAge(
                                      playerData.bm.profileCreatedAt,
                                    )}
                                  />
                                  <Field
                                    label="BM Profile"
                                    hint={HINTS.bmVisibility}
                                    value={
                                      playerData.bm.private
                                        ? "Private"
                                        : "Public"
                                    }
                                    tone={
                                      playerData.bm.private
                                        ? "danger"
                                        : "success"
                                    }
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
                                    value={fmtNum(
                                      playerData.bm.cheatingReports,
                                    )}
                                    tone={
                                      (playerData.bm.cheatingReports ?? 0) > 5
                                        ? "danger"
                                        : (playerData.bm.cheatingReports ?? 0) >
                                            0
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
                                              (playerData.bm.teamingReports ??
                                                0) +
                                              (playerData.bm.otherReports ??
                                                0) >
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
                              <Field
                                label="Last Seen"
                                value={lastSeen ?? "Never"}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </section>

                    {/* Risk alerts */}
                    {fetchOrgId && <PlayerAlertsBanner alerts={alerts} />}

                    {/* EAC Ban Status */}
                    <EacBanStatus bmData={playerData.bm} />

                    {/* Notes */}
                    {canViewNotes && (
                      <PlayerNotesSection
                        subjectId={playerData.steamId}
                        orgId={fetchOrgId}
                      />
                    )}

                    {/* Previous Offenses (real bans / mutes from our orgs) */}
                    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
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

                    {/* PVP Activity (kills / deaths from server combat logs) */}
                    <PlayerPvpSection
                      pvp={pvpData}
                      loading={pvpLoading}
                      subjectSteamId={playerData.steamId}
                    />

                    {/* Previous In-Game Reports */}
                    {!isSupportOnly && (
                      <PlayerReportsSection
                        reports={visibleReports}
                        loading={reportsLoading}
                        tz={tz}
                      />
                    )}

                    {/* All Bans */}
                    {!isSupportOnly && (
                      <ExternalBansSection
                        subjectId={playerData.steamId}
                        bans={visibleBmBans}
                      />
                    )}
                  </div>

                  {/* Right Panel */}
                  <div className="space-y-6 xl:col-span-3">
                    {/* Linked Accounts */}
                    {canViewIpConnections && (
                      <LinkedAccountsSection
                        subjectName={
                          playerData.displayName ?? playerData.steamId
                        }
                        relatedAccounts={playerData.relatedAccounts}
                        sessionRelated={
                          canViewSessionHistory
                            ? (playerData.sessionRelated ?? [])
                            : []
                        }
                        friendSteamIds={
                          new Set(
                            (playerData.friends?.enriched ?? [])
                              .map((f) => f.steamId)
                              .filter(Boolean),
                          )
                        }
                      />
                    )}

                    {/* Previous Connection Points */}
                    {canViewIpConnections && (
                      <ConnectionPointsSection
                        ipHistory={visibleIpHistory}
                        relatedAccounts={playerData.relatedAccounts}
                        currentSteamId={playerData.steamId}
                        tz={tz}
                        onSearchHash={(hash) =>
                          navigate({
                            search: { steam: undefined, ipHash: hash },
                          })
                        }
                      />
                    )}

                    {/* Previous Names */}
                    {playerData.nameAliases?.length > 0 && (
                      <section className="rounded-lg ring-1 ring-border bg-surface p-4 space-y-3">
                        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                          <History className="size-3.5" />
                          Previous Names
                        </h3>
                        <ul className="space-y-1">
                          {playerData.nameAliases.map((name, i) => (
                            <li
                              key={i}
                              className="text-xs text-foreground font-mono truncate"
                            >
                              {name}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Dialogs */}
          {steamId && (
            <NewBanDialog
              open={issueBanOpen}
              onClose={() => setIssueBanOpen(false)}
              onCreated={() => setIssueBanOpen(false)}
              defaultActionType={issueBanActionType}
              defaultIdentifier={steamId}
              playerSteamId={steamId}
              manageableOrgIds={
                offenseOrgIds.length
                  ? offenseOrgIds
                  : banOrgId
                    ? [banOrgId]
                    : []
              }
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
          {steamId && caseOrgId && (
            <CreateCaseDialog
              open={caseDialogOpen}
              onClose={() => setCaseDialogOpen(false)}
              steamId={steamId}
              displayName={displayName}
              caseOrgIds={caseOrgIds}
              orgs={orgs}
              onCreated={(ticketId) => {
                setHasOpenTicketInCaseOrg(true);
                setCaseDialogOpen(false);
              }}
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

// Rust combatlog body parts arrive as e.g. "r_hand" / "l_leg" — fold the
// left/right variants together for display and stats.
function normalizeBodypart(raw) {
  const s = String(raw ?? "")
    .toLowerCase()
    .replace(/^[lr]_/, "")
    .trim();
  return s || "unknown";
}

function bodypartLabel(part) {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

function formatWeapon(weapon) {
  if (!weapon) return null;
  return String(weapon)
    .replace(/\.entity$/, "")
    .replace(/_/g, " ");
}

function mergeBodyparts(bodyparts) {
  const merged = {};
  for (const [part, count] of Object.entries(bodyparts ?? {})) {
    const key = normalizeBodypart(part);
    merged[key] = (merged[key] ?? 0) + Number(count);
  }
  return Object.entries(merged).sort((a, b) => b[1] - a[1]);
}

function BodypartBreakdown({ label, total, bodyparts, barClass }) {
  const entries = mergeBodyparts(bodyparts);
  return (
    <div className="rounded-md ring-1 ring-border bg-background/60 p-3">
      <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2 flex items-center justify-between">
        <span>{label}</span>
        <span>{total}</span>
      </p>
      {entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">No data.</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map(([part, count]) => (
            <li key={part} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[10px] font-mono text-muted-foreground truncate">
                {bodypartLabel(part)}
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-surface overflow-hidden">
                <div
                  className={`h-full rounded-full ${barClass}`}
                  style={{
                    width: `${Math.max(4, Math.round((count / total) * 100))}%`,
                  }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-[10px] font-mono text-muted-foreground">
                {count}
                <span className="text-muted-foreground/50">
                  {" "}
                  {Math.round((count / total) * 100)}%
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlayerPvpSection({ pvp, loading, subjectSteamId }) {
  const lines = pvp?.lines ?? [];
  const stats = pvp?.stats ?? {
    kills: { total: 0, bodyparts: {} },
    deaths: { total: 0, bodyparts: {} },
  };
  const hasAny = stats.kills.total > 0 || stats.deaths.total > 0;

  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Crosshair className="size-3 shrink-0" />
          PVP Activity
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {loading ? "…" : `${stats.kills.total}K / ${stats.deaths.total}D`}
        </span>
      </h3>
      {loading ? (
        <p className="text-xs text-muted-foreground italic">Loading…</p>
      ) : !hasAny ? (
        <p className="text-xs text-muted-foreground italic">
          No PVP events on record.
        </p>
      ) : (
        <div className="space-y-3">
          {/* Body-part hit distribution from the killing-blow combatlog */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <BodypartBreakdown
              label="Hits Dealt (Kills)"
              total={stats.kills.total}
              bodyparts={stats.kills.bodyparts}
              barClass="bg-success/70"
            />
            <BodypartBreakdown
              label="Hits Taken (Deaths)"
              total={stats.deaths.total}
              bodyparts={stats.deaths.bodyparts}
              barClass="bg-danger/70"
            />
          </div>

          {/* Recent kill / death feed */}
          {lines.length > 0 && (
            <div className="rounded-md ring-1 ring-border bg-background/60 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-surface/60">
                    <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      Event
                    </th>
                    <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      Player
                    </th>
                    <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hidden sm:table-cell">
                      Weapon
                    </th>
                    <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      Hit
                    </th>
                    <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hidden md:table-cell">
                      Distance
                    </th>
                    <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const isKill = l.role === "kill";
                    // Kills only carry the victim's display name; deaths carry
                    // the killer's steam id, which we can link to a lookup.
                    const opponentName = isKill
                      ? l.victimName
                      : (l.killerName ?? l.killerSteamId);
                    return (
                      <tr
                        key={l.id}
                        className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-surface/30"}`}
                      >
                        <td className="px-3 py-2 shrink-0">
                          <span
                            className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${isKill ? "text-success bg-success/10 ring-success/30" : "text-danger bg-danger/10 ring-danger/30"}`}
                          >
                            {isKill ? "Kill" : "Death"}
                          </span>
                        </td>
                        <td
                          className="px-3 py-2 text-foreground truncate max-w-[140px]"
                          title={
                            isKill
                              ? opponentName
                              : `${opponentName} (${l.killerSteamId})`
                          }
                        >
                          {!isKill && l.killerSteamId !== subjectSteamId ? (
                            <Link
                              to="/player-lookup"
                              search={{ steam: l.killerSteamId }}
                              className="text-brand hover:underline"
                            >
                              {opponentName}
                            </Link>
                          ) : (
                            opponentName
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground truncate max-w-[120px] hidden sm:table-cell">
                          {formatWeapon(l.weapon) ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                          {l.bodypart
                            ? bodypartLabel(normalizeBodypart(l.bodypart))
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap hidden md:table-cell">
                          {l.distance != null
                            ? `${l.distance.toFixed(1)}m`
                            : "—"}
                        </td>
                        <td
                          className="px-3 py-2 text-muted-foreground whitespace-nowrap"
                          title={l.serverName ?? undefined}
                        >
                          {relativeTime(l.ts)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function PlayerReportsSection({ reports, loading, tz }) {
  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
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
        <div className="rounded-md ring-1 ring-border bg-background/60 overflow-hidden">
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
          body: JSON.stringify({
            expiresAt: lengthToExpiresAt(newLength, r.serverName),
          }),
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
  const isRawIpSearch = IP_ADDRESS_RE.test(hash);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
        <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2">
            {isRawIpSearch ? "Raw IP Search" : "Hashed IP Search"}
          </h2>
          <p className="text-xs text-muted-foreground font-mono">
            Query: {hash}
          </p>
        </section>

        {loading ? (
          <p className="text-sm text-muted-foreground">Searching...</p>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No players found for this {isRawIpSearch ? "IP" : "hash"}.
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
                <Link
                  to="/player-lookup"
                  search={{ steam: m.steamId }}
                  className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-primary text-primary-foreground shadow hover:bg-primary/90 h-8 rounded-md px-3 text-xs"
                >
                  Open
                </Link>
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
          <p className="text-xs text-muted-foreground font-mono">
            Query: {query}
          </p>
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
                <Link
                  to="/player-lookup"
                  search={{ steam: m.steamId }}
                  className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-primary text-primary-foreground shadow hover:bg-primary/90 h-8 rounded-md px-3 text-xs"
                >
                  Open
                </Link>
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
  residential: {
    label: "Residential",
    cls: "text-success bg-success/10 ring-success/30",
  },
  business: { label: "Business", cls: "text-brand bg-brand/10 ring-brand/30" },
  mobile: { label: "Mobile", cls: "text-foreground bg-surface ring-border" },
  proxy_vpn: {
    label: "VPN / Proxy",
    cls: "text-danger bg-danger/10 ring-danger/30",
  },
  hosting: {
    label: "Hosting",
    cls: "text-warning bg-warning/10 ring-warning/30",
  },
};

function ConnectionPointsSection({
  ipHistory,
  relatedAccounts,
  currentSteamId,
  tz,
  onSearchHash,
}) {
  const [expanded, setExpanded] = useState(null);
  const [expandedHistoryByIp, setExpandedHistoryByIp] = useState({});
  const [copiedHash, setCopiedHash] = useState(null);

  const sharedPlayerCountByIp = useMemo(() => {
    const subjectSteamId = String(currentSteamId ?? "");
    const byIp = new Map();
    for (const account of relatedAccounts ?? []) {
      const relatedSteamId = String(account?.relatedSteamId ?? "");
      const accountId = String(
        account?.relatedSteamId ?? account?.relatedBmId ?? "",
      );
      if (!accountId) continue;
      if (
        (subjectSteamId &&
          relatedSteamId &&
          relatedSteamId === subjectSteamId) ||
        (subjectSteamId && accountId === subjectSteamId)
      ) {
        continue;
      }
      const seenHashes = new Set();
      for (const sharedIp of account?.sharedIps ?? []) {
        const hash = String(sharedIp?.ipHash ?? "");
        if (!hash || seenHashes.has(hash)) continue;
        seenHashes.add(hash);
      }
      for (const hash of seenHashes) {
        if (!byIp.has(hash)) byIp.set(hash, new Set());
        byIp.get(hash).add(accountId);
      }
    }

    const counts = new Map();
    for (const [hash, accountIds] of byIp.entries()) {
      counts.set(hash, accountIds.size);
    }
    return counts;
  }, [relatedAccounts, currentSteamId]);

  const entries = useMemo(
    () =>
      (ipHistory ?? [])
        .filter((e) => e.ipHashShort)
        .sort((a, b) => Number(b?.lastSeen ?? 0) - Number(a?.lastSeen ?? 0)),
    [ipHistory],
  );
  if (!entries.length) return null;

  const toggle = (hash) => setExpanded((prev) => (prev === hash ? null : hash));

  const copyHash = async (hash) => {
    if (!hash) return;
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      setTimeout(() => {
        setCopiedHash((prev) => (prev === hash ? null : prev));
      }, 1200);
    } catch {
      // no-op: clipboard may be unavailable in some browser contexts
    }
  };

  const toggleConnectionHistory = (hash) => {
    setExpandedHistoryByIp((prev) => ({
      ...prev,
      [hash]: !prev[hash],
    }));
  };

  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>Previous Connection Points</span>
        <span className="font-mono normal-case tracking-normal">
          {entries.length}
        </span>
      </h3>
      <div className="rounded-md ring-1 ring-border overflow-hidden divide-y divide-border">
        {entries.map((entry) => {
          const flag = flagEmoji(entry.isoCode);
          const connMeta = CONN_TYPE_META[entry.connType] ?? null;
          const isOpen = expanded === entry.ipHash;
          const sharedPlayerCount =
            entry.sharedPlayerCount != null
              ? entry.sharedPlayerCount
              : (sharedPlayerCountByIp.get(entry.ipHash) ?? 0);
          const isSharedWithOthers = sharedPlayerCount > 0;
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
          const rawType = entry.rawType || null;
          const pc = entry.proxycheckData ?? null;
          const det = pc?.detections ?? null;
          const deviceEstimate = pc?.deviceEstimate ?? null;
          const delist = pc?.delist ?? null;
          const operator = pc?.operator ?? null;
          const operatorName =
            typeof operator?.name === "string" ? operator.name.trim() : "";
          const showOperatorInOverview =
            (entry.isProxy || entry.isVpn || entry.connType === "proxy_vpn") &&
            operatorName.length > 0;
          const detectionFirstSeen = det?.firstSeen
            ? new Date(det.firstSeen).toLocaleString(
                undefined,
                tz ? { timeZone: tz } : {},
              )
            : null;
          const detectionLastSeen = det?.lastSeen
            ? new Date(det.lastSeen).toLocaleString(
                undefined,
                tz ? { timeZone: tz } : {},
              )
            : null;
          const delistAt = delist?.delistDatetime
            ? new Date(delist.delistDatetime).toLocaleString(
                undefined,
                tz ? { timeZone: tz } : {},
              )
            : null;
          const localTime = entry.timezone
            ? new Date().toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
                timeZone: entry.timezone,
              })
            : null;
          const connectionHistory = (
            Array.isArray(entry.connectionHistory)
              ? entry.connectionHistory
              : []
          )
            .map((event) => ({
              seenAt: Number(event?.seenAt ?? 0),
              serverName:
                typeof event?.serverName === "string" ? event.serverName : null,
            }))
            .filter(
              (event) => Number.isFinite(event.seenAt) && event.seenAt > 0,
            )
            .sort((a, b) => b.seenAt - a.seenAt);

          if (connectionHistory.length === 0) {
            if (entry.lastSeen) {
              connectionHistory.push({
                seenAt: Number(entry.lastSeen),
                serverName: entry.serverName ?? null,
              });
            }
            if (
              entry.firstSeen &&
              Number(entry.firstSeen) !== Number(entry.lastSeen)
            ) {
              connectionHistory.push({
                seenAt: Number(entry.firstSeen),
                serverName: entry.serverName ?? null,
              });
            }
            connectionHistory.sort((a, b) => b.seenAt - a.seenAt);
          }

          const historyExpanded = Boolean(expandedHistoryByIp[entry.ipHash]);
          const visibleConnectionHistory = historyExpanded
            ? connectionHistory
            : connectionHistory.slice(0, 10);
          const hasHiddenHistory = connectionHistory.length > 10;

          return (
            <div key={entry.ipHash}>
              <button
                type="button"
                onClick={() => toggle(entry.ipHash)}
                className="w-full flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-left hover:bg-surface/60 transition-colors"
              >
                <span className="text-base leading-none shrink-0" aria-hidden>
                  {flag}
                </span>
                <span className="font-mono text-xs text-foreground shrink-0 w-28 sm:w-36 truncate">
                  {entry.ipHashShort}
                </span>
                <span className="text-xs text-muted-foreground truncate flex-1 min-w-0 sm:min-w-[12rem] pr-2 sm:pr-3">
                  {entry.country ?? "Unknown location"} · {summary}
                  {showOperatorInOverview ? ` · Operator: ${operatorName}` : ""}
                </span>
                <div className="flex items-center gap-2 shrink-0 ml-auto pl-1">
                  {(entry.isProxy || entry.isVpn) && (
                    <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 text-danger bg-danger/10 ring-danger/30">
                      {entry.isVpn ? "VPN" : "Proxy"}
                    </span>
                  )}
                  {connMeta && (
                    <span
                      className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${connMeta.cls}`}
                    >
                      {connMeta.label}
                    </span>
                  )}
                  <span
                    className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${
                      isSharedWithOthers
                        ? "text-warning bg-warning/10 ring-warning/30"
                        : "text-muted-foreground bg-surface ring-border"
                    }`}
                  >
                    {isSharedWithOthers
                      ? `Shared (${sharedPlayerCount})`
                      : "Not Shared"}
                  </span>
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
                    <path
                      d="M4 6l4 4 4-4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </button>

              {isOpen && (
                <div className="px-4 pb-3 pt-1 bg-surface/30 border-t border-border">
                  <dl className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                    {connectionHistory.length > 0 && (
                      <div className="col-span-2 sm:col-span-3 md:col-span-4">
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                          Connection Times ({connectionHistory.length})
                        </dt>
                        <dd>
                          <div className="rounded-md ring-1 ring-border bg-surface/40 divide-y divide-border/60 max-h-56 overflow-y-auto">
                            {visibleConnectionHistory.map((event, idx) => (
                              <div
                                key={`${entry.ipHash}-${event.seenAt}-${idx}`}
                                className="px-2.5 py-1.5 flex items-center justify-between gap-2"
                              >
                                <span className="font-mono text-[11px] text-foreground">
                                  {new Date(event.seenAt * 1000).toLocaleString(
                                    undefined,
                                    tz ? { timeZone: tz } : {},
                                  )}
                                </span>
                                {event.serverName && (
                                  <span
                                    className="text-[10px] text-muted-foreground truncate"
                                    title={event.serverName}
                                  >
                                    {event.serverName}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                          {hasHiddenHistory && (
                            <button
                              type="button"
                              onClick={() =>
                                toggleConnectionHistory(entry.ipHash)
                              }
                              className="mt-1.5 text-[10px] font-mono uppercase tracking-wider text-brand hover:underline"
                            >
                              {historyExpanded
                                ? "Show Less"
                                : `Show All (${connectionHistory.length})`}
                            </button>
                          )}
                        </dd>
                      </div>
                    )}
                    {det && (
                      <div className="col-span-2 sm:col-span-3 md:col-span-4">
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                          Specific Detections
                        </dt>
                        <dd className="flex flex-wrap gap-1.5">
                          {[
                            ["Anonymous", det.anonymous],
                            ["VPN", det.vpn],
                            ["Hosting", det.hosting],
                            ["Proxy", det.proxy],
                            ["Compromised", det.compromised],
                            ["Scraper", det.scraper],
                            ["TOR", det.tor],
                          ].map(([label, active]) => (
                            <span
                              key={label}
                              className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${
                                active
                                  ? "text-success bg-success/10 ring-success/30"
                                  : "text-muted-foreground bg-surface ring-border"
                              }`}
                            >
                              {label}
                            </span>
                          ))}
                        </dd>
                      </div>
                    )}
                    {entry.riskScore != null && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Risk Score
                        </dt>
                        <dd className="font-mono text-foreground">
                          {entry.riskScore}%
                        </dd>
                      </div>
                    )}
                    {entry.riskConfidence && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Confidence
                        </dt>
                        <dd className="font-mono text-foreground">
                          {entry.riskConfidence}
                        </dd>
                      </div>
                    )}
                    {entry.estimate && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Device Estimate
                        </dt>
                        <dd className="font-mono text-foreground">
                          {entry.estimate}
                        </dd>
                      </div>
                    )}
                    {detectionFirstSeen && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Detection First Seen
                        </dt>
                        <dd className="font-mono text-foreground">
                          {detectionFirstSeen}
                        </dd>
                      </div>
                    )}
                    {detectionLastSeen && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Detection Last Seen
                        </dt>
                        <dd className="font-mono text-foreground">
                          {detectionLastSeen}
                        </dd>
                      </div>
                    )}
                    {delistAt && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          To Be Delisted
                        </dt>
                        <dd className="font-mono text-foreground">
                          {delistAt}
                        </dd>
                      </div>
                    )}
                    {entry.lastUpdate && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Last Update
                        </dt>
                        <dd className="font-mono text-foreground">
                          {entry.lastUpdate}
                        </dd>
                      </div>
                    )}
                    {entry.asn && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          ASN
                        </dt>
                        <dd className="font-mono text-foreground">
                          {entry.asn}
                        </dd>
                      </div>
                    )}
                    {entry.hostname && (
                      <div className="col-span-2">
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Hostname
                        </dt>
                        <dd
                          className="font-mono text-foreground truncate"
                          title={entry.hostname}
                        >
                          {entry.hostname}
                        </dd>
                      </div>
                    )}
                    {entry.isp && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          ISP / Provider
                        </dt>
                        <dd
                          className="font-mono text-foreground truncate"
                          title={entry.isp}
                        >
                          {entry.isp}
                        </dd>
                      </div>
                    )}
                    {entry.company && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Company
                        </dt>
                        <dd
                          className="font-mono text-foreground truncate"
                          title={entry.company}
                        >
                          {entry.company}
                        </dd>
                      </div>
                    )}
                    {entry.organization && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Organisation
                        </dt>
                        <dd
                          className="font-mono text-foreground truncate"
                          title={entry.organization}
                        >
                          {entry.organization}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                        Type
                      </dt>
                      <dd className="font-mono text-foreground">
                        {rawType ?? summary}
                      </dd>
                    </div>
                    {entry.city && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          City
                        </dt>
                        <dd className="font-mono text-foreground">
                          {entry.city}
                        </dd>
                      </div>
                    )}
                    {entry.region && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Region
                        </dt>
                        <dd className="font-mono text-foreground">
                          {entry.region}
                        </dd>
                      </div>
                    )}
                    {entry.continent && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Continent
                        </dt>
                        <dd className="font-mono text-foreground">
                          {entry.continent}
                        </dd>
                      </div>
                    )}
                    {localTime && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Local Time
                        </dt>
                        <dd className="font-mono text-foreground">
                          {localTime}
                        </dd>
                      </div>
                    )}
                    {operator?.name && (
                      <div className="col-span-2">
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Operator
                        </dt>
                        <dd className="font-mono text-foreground">
                          {operator.url ? (
                            <a
                              href={operator.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-brand hover:underline"
                            >
                              {operator.name}
                            </a>
                          ) : (
                            operator.name
                          )}
                        </dd>
                      </div>
                    )}
                    {operator?.anonymity && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Operator Anonymity
                        </dt>
                        <dd className="font-mono text-foreground">
                          {operator.anonymity}
                        </dd>
                      </div>
                    )}
                    {operator?.popularity && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Operator Popularity
                        </dt>
                        <dd className="font-mono text-foreground">
                          {operator.popularity}
                        </dd>
                      </div>
                    )}
                    {firstSeenDate && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          First Seen
                        </dt>
                        <dd className="font-mono text-foreground">
                          {firstSeenDate}
                        </dd>
                      </div>
                    )}
                    {lastSeenDate && (
                      <div>
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Last Seen
                        </dt>
                        <dd className="font-mono text-foreground">
                          {lastSeenDate}
                        </dd>
                      </div>
                    )}
                    {entry.serverName && (
                      <div className="col-span-2">
                        <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                          Server
                        </dt>
                        <dd
                          className="font-mono text-foreground truncate"
                          title={entry.serverName}
                        >
                          {entry.serverName}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                        Flagged
                      </dt>
                      <dd
                        className={`font-mono ${entry.isProxy || entry.isVpn ? "text-danger" : "text-success"}`}
                      >
                        {entry.isVpn
                          ? "VPN"
                          : entry.isProxy
                            ? "Proxy"
                            : "Clean"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
                        Shared
                      </dt>
                      <dd
                        className={`font-mono ${
                          isSharedWithOthers
                            ? "text-warning"
                            : "text-muted-foreground"
                        }`}
                      >
                        {isSharedWithOthers
                          ? `Yes (${sharedPlayerCount} player${sharedPlayerCount === 1 ? "" : "s"})`
                          : "No"}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => copyHash(entry.ipHash)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded ring-1 ring-border bg-surface/50 text-foreground text-[10px] font-mono uppercase tracking-widest hover:bg-surface"
                    >
                      {copiedHash === entry.ipHash ? "Copied" : "Copy Hash"}
                    </button>
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

function CreateCaseDialog({
  open,
  onClose,
  steamId,
  displayName,
  caseOrgIds,
  orgs,
  onCreated,
}) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setTitle(
        displayName
          ? `Staff Case: ${displayName}`
          : `Staff Case: ${steamId ?? ""}`,
      );
      setNote("");
      setSelectedOrgId(caseOrgIds[0] ?? "");
      setError("");
      setSubmitting(false);
    }
  }, [open, displayName, steamId, caseOrgIds]);

  const handleSubmit = async () => {
    if (!selectedOrgId || !title.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(selectedOrgId)}/cases`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            steamId,
            title: title.trim(),
            note: note.trim(),
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Failed to create case.");
        return;
      }
      onCreated?.(data.ticketId);
    } catch {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Staff Case</DialogTitle>
          <DialogDescription>
            Opens an internal staff case for{" "}
            <strong>{displayName ?? steamId}</strong>. No public submission
            needed — staff manage it through the Ticket Queue.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {caseOrgIds.length > 1 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Organization</p>
              <select
                value={selectedOrgId}
                onChange={(e) => setSelectedOrgId(e.target.value)}
                className="w-full bg-background ring-1 ring-border rounded px-2 py-1.5 text-xs"
              >
                {caseOrgIds.map((orgId) => {
                  const org = orgs.find((o) => o.id === orgId);
                  return (
                    <option key={orgId} value={orgId}>
                      {org?.name ?? orgId}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          <div>
            <p className="text-xs text-muted-foreground mb-1">Title</p>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={255}
              className="w-full bg-background ring-1 ring-border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-brand"
            />
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">
              Initial note{" "}
              <span className="text-muted-foreground/60">
                (optional · internal only)
              </span>
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Context, suspicion reason, evidence notes..."
              className="w-full bg-background ring-1 ring-border rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-brand"
            />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!title.trim() || !selectedOrgId || submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Creating…" : "Create Case"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { Route };

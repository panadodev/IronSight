import { SteamRequiredGate } from "@/components/steam-required-gate";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import {
  Field,
  OffensesTable,
  ServerHistorySection,
} from "@/components/player-sidebar";
import { NewBanDialog } from "@/components/new-ban-dialog";
import { LENGTH_OPTIONS } from "@/components/ban-dialog";
import { HINTS } from "@/components/hint";
import { useAuth } from "@/lib/auth-context";
import { useTimezone } from "@/lib/timezone-store";
import { PlayerLinks } from "@/components/player-links";
import { Ban, MicOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PlayerNotesSection } from "@/components/player-notes";
import { ExternalBansSection } from "@/components/external-bans";
import { LinkedAccountsSection } from "@/components/linked-accounts";
import { PlayerFriendsSection } from "@/components/player-friends";
import { SessionTimeline } from "@/components/session-timeline";

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
  }),
  component: PlayerLookupPage,
});

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

  const [input, setInput] = useState(search.steam ?? "");
  const [steamId, setSteamId] = useState(search.steam ?? null);

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
  // Explicit "look up using this org" override. When the staffer belongs to
  // several orgs, they pick which org's external API keys drive the lookup
  // (the player cache itself is shared across orgs). null → use the default.
  const [lookupOrgId, setLookupOrgId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(false);
  const refreshCooldownRef = useRef(null);

  useEffect(() => {
    if (search.steam && search.steam !== steamId) {
      setSteamId(search.steam);
      setInput(search.steam);
    }
  }, [search.steam, steamId]);

  // Player lookup needs players_view; issuing bans needs the ban-create perm
  // (legacy bans_manage still implies it). Prefer a selected org the user has
  // the relevant permission in, falling back to any such org so the page still
  // works regardless of org selection.
  const canCreateBansInOrg = (id) =>
    hasOrgPermission(id, "bans_create") || hasOrgPermission(id, "bans_manage");

  // Orgs the staffer may look players up from (one shared cache, but the lookup
  // spends *this* org's BattleMetrics/Steam/Proxycheck keys).
  const lookupOrgs = orgs.filter((o) => hasOrgPermission(o.id, "players_view"));

  const defaultLookupOrgId =
    selectedOrgIds.find((id) => hasOrgPermission(id, "players_view")) ??
    lookupOrgs[0]?.id ??
    null;

  // Honour the explicit choice when it's still a valid lookup org; otherwise
  // fall back to the default (selected org, then any org with the permission).
  const fetchOrgId =
    lookupOrgId && lookupOrgs.some((o) => o.id === lookupOrgId)
      ? lookupOrgId
      : defaultLookupOrgId;

  const banOrgId =
    selectedOrgIds.find(canCreateBansInOrg) ??
    orgs.find((o) => canCreateBansInOrg(o.id))?.id ??
    "";

  const offenseOrgIds = selectedOrgIds.filter(canCreateBansInOrg);

  // No ban permission anywhere → view-only (hide ban/mute actions).
  const isSupportOnly = !banOrgId;

  const canSeeRealIp = fetchOrgId
    ? hasOrgPermission(fetchOrgId, "ip_read")
    : false;

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

  useEffect(() => {
    if (!orgsLoaded) return;
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
  }, [steamId, fetchOrgId, orgsLoaded]);

  useEffect(() => {
    if (!steamId || !offenseOrgIds.length) {
      setOffenses([]);
      return;
    }
    let cancelled = false;
    setOffensesLoading(true);
    const fetches = offenseOrgIds.flatMap((orgId) => [
      fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/bans?type=ban&identifier=${encodeURIComponent(steamId)}`,
        { credentials: "include" },
      )
        .then((r) => r.json())
        .then((b) => b.bans ?? [])
        .catch(() => []),
      fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/bans?type=mute&identifier=${encodeURIComponent(steamId)}`,
        { credentials: "include" },
      )
        .then((r) => r.json())
        .then((b) => b.bans ?? [])
        .catch(() => []),
    ]);
    Promise.all(fetches)
      .then((groups) => {
        if (!cancelled) {
          setOffenses(groups.flat().sort((a, b) => b.issuedAt - a.issuedAt));
        }
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
  }, [steamId, JSON.stringify(offenseOrgIds)]);

  useEffect(() => {
    if (!steamId || !fetchOrgId) {
      setReports([]);
      return;
    }
    let cancelled = false;
    setReportsLoading(true);
    fetch(
      `/api/players/${encodeURIComponent(steamId)}/reports?orgId=${encodeURIComponent(fetchOrgId)}`,
      { credentials: "include" },
    )
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
  }, [steamId, fetchOrgId]);

  const submit = (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (/^\d{17}$/.test(trimmed)) setSteamId(trimmed);
  };

  const handleRefresh = async () => {
    if (refreshing || refreshCooldown) return;
    setRefreshing(true);
    await fetchPlayer(true);
    setRefreshCooldown(true);
    if (refreshCooldownRef.current) clearTimeout(refreshCooldownRef.current);
    refreshCooldownRef.current = setTimeout(() => setRefreshCooldown(false), 15000);
  };


  const displayName = playerData?.displayName ?? steamId ?? "";

  const kd =
    playerData?.bm && (playerData.bm.deaths > 0 || playerData.bm.kills > 0)
      ? (playerData.bm.kills / Math.max(1, playerData.bm.deaths)).toFixed(2)
      : null;

  const isProxy =
    playerData?.ipHistory?.some((ip) => ip.isProxy || ip.isVpn) ?? false;

  const country = playerData?.ipHistory?.[0]?.country ?? null;

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

  const offenseRows = offenses.map((ban) => {
    const st = banRecordStatus(ban);
    return {
      id: ban.banId,
      type: ban.actionType === "ban" ? "Ban" : "Mute",
      status: st.label,
      statusTone: st.tone,
      reason: ban.reason ?? "—",
      when: relativeTime(ban.issuedAt),
      by: ban.issuedByName ?? "unknown",
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

    const hasActiveBan = offenses.some(
      (o) =>
        o.actionType === "ban" &&
        !o.revoked &&
        (!o.expiresAt || o.expiresAt > nowSec),
    );
    const hasActiveMute = offenses.some(
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
                    placeholder="Paste a 17-digit Steam ID (e.g. 76561198000000001)"
                    className="w-full pl-9 pr-3 py-2.5 bg-background ring-1 ring-border rounded-md text-sm font-mono focus:outline-none focus:ring-brand"
                  />
                </div>
                {lookupOrgs.length > 1 && (
                  <select
                    value={fetchOrgId ?? ""}
                    onChange={(e) => setLookupOrgId(e.target.value)}
                    title="Look up using this organization's API keys"
                    className="px-3 py-2.5 bg-background ring-1 ring-border rounded-md text-sm focus:outline-none focus:ring-brand max-w-[180px]"
                  >
                    {lookupOrgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="submit"
                  disabled={playerLoading || firstFetch}
                  className="px-4 py-2.5 bg-brand text-brand-foreground rounded-md text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  Lookup
                </button>
              </form>
              {input.trim().length > 0 && !/^\d{17}$/.test(input.trim()) && (
                <p className="mt-2 text-[11px] text-warning">
                  Steam IDs are 17 digits.
                </p>
              )}
            </div>
          </div>

          {!steamId ? (
            <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
              Enter a Steam ID above to see everything we have on a player.
            </div>
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
          ) : !playerData ? null : (
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
                          className="inline-flex items-center gap-1.5 h-8 px-3 bg-surface text-muted-foreground text-xs rounded-md ring-1 ring-border hover:bg-surface-bright disabled:opacity-50"
                          title={refreshCooldown ? "Wait a moment before refreshing again" : "Refresh data from BattleMetrics / Steam"}
                        >
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
                      </div>
                    </div>

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
                {canSeeRealIp && (
                  <ConnectionPointsSection
                    ipHistory={playerData.ipHistory}
                    tz={tz}
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
                    reports={reports}
                    loading={reportsLoading}
                    tz={tz}
                  />
                )}

                {/* Bans on Other Orgs */}
                {!isSupportOnly && (
                  <ExternalBansSection
                    subjectId={playerData.steamId}
                    bans={playerData.bmBans}
                  />
                )}

                {/* Linked Accounts */}
                {!isSupportOnly && (
                  <LinkedAccountsSection
                    subjectName={playerData.displayName ?? playerData.steamId}
                    relatedAccounts={playerData.relatedAccounts}
                    canSeeRealIp={canSeeRealIp}
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

function ConnectionPointsSection({ ipHistory, tz }) {
  const [expanded, setExpanded] = useState(null);

  const entries = (ipHistory ?? []).filter((e) => e.ipAddress);
  if (!entries.length) return null;

  const toggle = (ip) => setExpanded((prev) => (prev === ip ? null : ip));

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
          const isOpen = expanded === entry.ipAddress;
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
            <div key={entry.ipAddress}>
              <button
                type="button"
                onClick={() => toggle(entry.ipAddress)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface/60 transition-colors"
              >
                <span className="text-base leading-none shrink-0" aria-hidden>
                  {flag}
                </span>
                <span className="font-mono text-xs text-foreground shrink-0 w-36 truncate">
                  {entry.ipAddress}
                </span>
                <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                  {entry.country ?? "Unknown location"}
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

import { SteamRequiredGate } from "@/components/steam-required-gate";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import {
  Field,
  OffensesTable,
  ChatLogSection,
  KillFeedSection,
  HitDistanceSection,
  ServerHistorySection,
  TeammatesSection,
  FriendlyRecipientsSection,
  pingTone,
} from "@/components/player-sidebar";
import { BanDialog, LENGTH_OPTIONS } from "@/components/ban-dialog";
import { useAuth } from "@/lib/auth-context";
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
import { LinkedAccountIntelSection } from "@/components/linked-accounts";

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
  return new Date(Date.now() + LENGTH_MINUTES[length] * 60000).toISOString();
}

function fmtNum(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US");
}

function relativeTime(isoString) {
  if (!isoString) return "—";
  const days = Math.floor((Date.now() - Date.parse(isoString)) / 864e5);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
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
  const ms = Date.parse(r.expiresAt) - Date.now();
  if (ms <= 0) return { label: "Expired", tone: "muted" };
  const days = Math.floor(ms / 864e5);
  const hours = Math.floor((ms % 864e5) / 36e5);
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

const REPORT_CATEGORIES = [
  { id: "cheating", label: "Cheating" },
  { id: "teaming", label: "Teaming" },
  { id: "toxicity", label: "Toxicity" },
  { id: "other", label: "Other" },
];

function hashId(steamId) {
  let h = 0;
  for (let i = 0; i < steamId.length; i++)
    h = (h * 31 + steamId.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function AlertsSectionLookup({ steamId }) {
  const [windowDays, setWindowDays] = useState(90);

  const allAlerts = useMemo(() => {
    const h = hashId(steamId);
    const count = h % 5;
    if (count === 0) return [];
    return Array.from({ length: count }).map((_, i) => {
      const k = Math.abs(((h + i * 1103) * 2654435761) | 0);
      return {
        kind: k % 2 === 0 ? "f7" : "thorium",
        title:
          k % 2 === 0
            ? `Reporter: Player${k % 100}`
            : `Aim · ${30 + (k % 50)}%`,
        daysAgo: 1 + (k % 89),
      };
    });
  }, [steamId]);

  const visible = allAlerts.filter((a) => a.daysAgo <= windowDays);
  const f7Count = visible.filter((a) => a.kind === "f7").length;
  const thoriumCount = visible.filter((a) => a.kind === "thorium").length;

  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: "#f59e0b" }}
            />
            <span style={{ color: "#f59e0b" }}>F7</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: "#ec4899" }}
            />
            <span style={{ color: "#ec4899" }}>Thorium</span>
          </span>
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {f7Count + thoriumCount} alerts
          <span className="ml-2 text-muted-foreground">
            · last {windowDays}d
          </span>
        </span>
      </h3>
      <div className="flex items-center gap-3 mb-2 px-1">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground shrink-0">
          Window
        </span>
        <input
          type="range"
          min={1}
          max={90}
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          className="flex-1"
        />
        <span className="text-[10px] font-mono tabular-nums text-foreground w-12 text-right">
          {windowDays}d
        </span>
      </div>
      <div className="relative rounded-lg ring-1 ring-border/50 bg-surface/30 p-2">
        {f7Count + thoriumCount === 0 ? (
          <div className="px-1 py-6 text-xs text-muted-foreground italic text-center">
            No F7 reports or Thorium alerts in the last {windowDays} days.
          </div>
        ) : (
          <ul className="space-y-1">
            {visible.map((a, i) => (
              <li
                key={i}
                className="text-[10px] font-mono flex items-center gap-2 px-2 py-1.5 rounded"
              >
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={{
                    background: a.kind === "f7" ? "#f59e0b" : "#ec4899",
                  }}
                />
                <span
                  className="font-semibold uppercase"
                  style={{ color: a.kind === "f7" ? "#f59e0b" : "#ec4899" }}
                >
                  {a.kind === "f7" ? "F7" : "Thorium"}
                </span>
                <span className="text-foreground">{a.title}</span>
                <span className="ml-auto text-muted-foreground">
                  {a.daysAgo}d ago
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

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

function cacheAge(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60000) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function CacheStamp({ playerData, refreshing }) {
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
      title={`Steam: ${steamAt ? new Date(steamAt).toLocaleString() : "—"}\nBM: ${bmAt ? new Date(bmAt).toLocaleString() : "—"}`}
    >
      cached {cacheAge(newest)}
      {stale ? " · stale" : ""}
    </span>
  );
}

function PlayerLookupPage() {
  const { selectedOrgIds, orgs, maxRankAcross, adminableOrgIds, orgsLoaded } =
    useAuth();
  const isSupportOnly = maxRankAcross(selectedOrgIds) < 2;
  const search = Route.useSearch();

  const [input, setInput] = useState(search.steam ?? "");
  const [steamId, setSteamId] = useState(search.steam ?? null);

  const [playerData, setPlayerData] = useState(null);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState(null);
  const [firstFetch, setFirstFetch] = useState(false);
  const pollRef = useRef(null);

  const [offenses, setOffenses] = useState([]);
  const [offensesLoading, setOffensesLoading] = useState(false);

  const [banPickerOpen, setBanPickerOpen] = useState(false);
  const [banCategory, setBanCategory] = useState(null);
  const [muteOpen, setMuteOpen] = useState(false);
  const [manageBansOpen, setManageBansOpen] = useState(false);
  const [manageMutesOpen, setManageMutesOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (search.steam && search.steam !== steamId) {
      setSteamId(search.steam);
      setInput(search.steam);
    }
  }, [search.steam, steamId]);

  const fetchOrgId =
    adminableOrgIds.find((id) => selectedOrgIds.includes(id)) ??
    selectedOrgIds[0] ??
    orgs[0]?.id ??
    null;

  const banOrgId =
    adminableOrgIds.find((id) => selectedOrgIds.includes(id)) ??
    adminableOrgIds[0] ??
    selectedOrgIds[0] ??
    orgs[0]?.id ??
    "";

  const offenseOrgIds = adminableOrgIds.filter((id) =>
    selectedOrgIds.includes(id),
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
        } else if (!forceRefresh && body.fetching) {
          // Backend is fetching for the first time — poll until data is ready
          setFirstFetch(true);
          setPlayerData(null);
          setPlayerLoading(false);
          pollRef.current = setTimeout(() => fetchPlayer(false), 3000);
          return;
        } else {
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
    setPlayerData(null);
    setFirstFetch(false);
    setOffenses([]);
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    fetchPlayer(false);
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
          setOffenses(
            groups.flat().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)),
          );
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

  const submit = (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (/^\d{17}$/.test(trimmed)) setSteamId(trimmed);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchPlayer(true);
  };

  const submitBan = async (sub) => {
    if (banOrgId && steamId) {
      await fetch(`/api/orgs/${encodeURIComponent(banOrgId)}/bans`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionType: "ban",
          identifier: steamId,
          identifierType: "steam_id",
          category: banCategory || null,
          reason: sub.reason,
          note: sub.note,
          expiresAt: lengthToExpiresAt(sub.length),
          serverIds: [],
        }),
      });
    }
    setBanCategory(null);
  };

  const submitMute = async (sub) => {
    if (banOrgId && steamId) {
      await fetch(`/api/orgs/${encodeURIComponent(banOrgId)}/bans`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionType: "mute",
          identifier: steamId,
          identifierType: "steam_id",
          category: "toxicity",
          reason: sub.reason,
          note: sub.note,
          expiresAt: lengthToExpiresAt(sub.length),
          serverIds: [],
        }),
      });
    }
    setMuteOpen(false);
  };

  const displayName = playerData?.displayName ?? steamId ?? "";

  const kd =
    playerData?.bm && (playerData.bm.deaths > 0 || playerData.bm.kills > 0)
      ? (playerData.bm.kills / Math.max(1, playerData.bm.deaths)).toFixed(2)
      : null;

  const isProxy =
    playerData?.ipHistory?.some((ip) => ip.isProxy || ip.isVpn) ?? false;

  const country = playerData?.ipHistory?.[0]?.country ?? null;

  const lastSeen = (() => {
    const s = playerData?.bmSessions?.[0];
    if (!s?.lastSeen) return null;
    const d = new Date(s.lastSeen);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
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
                <button
                  type="submit"
                  className="px-4 py-2.5 bg-brand text-brand-foreground rounded-md text-sm font-semibold hover:opacity-90"
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
                          disabled={refreshing}
                          className="inline-flex items-center gap-1.5 h-8 px-3 bg-surface text-muted-foreground text-xs rounded-md ring-1 ring-border hover:bg-surface-bright disabled:opacity-50"
                          title="Refresh data from BattleMetrics / Steam"
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
                          onClick={() => setMuteOpen(true)}
                          className="flex items-center gap-2 px-3 py-2 bg-warning/15 text-warning ring-1 ring-warning/40 rounded-md text-xs font-semibold uppercase tracking-widest hover:bg-warning/25"
                        >
                          <MicOff className="size-3.5" />
                          Mute
                        </button>
                        {!isSupportOnly && (
                          <div className="relative">
                            <button
                              onClick={() => setBanPickerOpen((v) => !v)}
                              className="flex items-center gap-2 px-3 py-2 bg-danger text-danger-foreground rounded-md text-xs font-semibold uppercase tracking-widest hover:opacity-90"
                            >
                              <Ban className="size-3.5" />
                              Ban
                            </button>
                            {banPickerOpen && (
                              <>
                                <div
                                  className="fixed inset-0 z-40"
                                  onClick={() => setBanPickerOpen(false)}
                                />
                                <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-background ring-1 ring-border rounded-md shadow-lg p-1">
                                  <p className="px-2 py-1.5 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                                    Ban category
                                  </p>
                                  {REPORT_CATEGORIES.map((c) => (
                                    <button
                                      key={c.id}
                                      onClick={() => {
                                        setBanPickerOpen(false);
                                        setBanCategory(c.id);
                                      }}
                                      className="w-full text-left px-2 py-1.5 text-xs hover:bg-surface rounded"
                                    >
                                      {c.label}
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {!isSupportOnly && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-y-4 gap-x-6">
                        <Field
                          label="S-Hours"
                          value={
                            playerData.steam.dataPublic
                              ? fmtNum(playerData.steam.rustHours)
                              : "Private"
                          }
                        />
                        <Field
                          label="BM-Hours"
                          value={
                            playerData.bm
                              ? fmtNum(playerData.bm.rustHours)
                              : "—"
                          }
                        />
                        <Field
                          label="AT-Hours"
                          value={
                            playerData.bm
                              ? fmtNum(playerData.bm.aimtrainHours)
                              : "—"
                          }
                        />
                        <Field label="K.D" value={kd ?? "—"} />
                        {playerData.bm && (
                          <Field
                            label="BM Reports"
                            value={fmtNum(
                              (playerData.bm.cheatingReports ?? 0) +
                              (playerData.bm.teamingReports ?? 0) +
                              (playerData.bm.otherReports ?? 0)
                            )}
                            tone={
                              ((playerData.bm.cheatingReports ?? 0) + (playerData.bm.teamingReports ?? 0) + (playerData.bm.otherReports ?? 0)) > 10
                                ? "danger"
                                : ((playerData.bm.cheatingReports ?? 0) + (playerData.bm.teamingReports ?? 0) + (playerData.bm.otherReports ?? 0)) > 0
                                  ? "warning"
                                  : undefined
                            }
                          />
                        )}
                        <Field
                          label="Hit %"
                          value={`${(hashId(playerData.steamId) % 55) + 8}%`}
                        />
                        <Field
                          label="Proxy"
                          value={isProxy ? "True" : "False"}
                          tone={isProxy ? "danger" : "success"}
                        />
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase">
                            Location
                          </p>
                          <p className="text-sm font-mono text-foreground flex items-center gap-1.5">
                            {country ?? "??"}
                            {(() => {
                              const ms =
                                18 + (hashId(playerData.steamId) % 220);
                              const t = pingTone(ms);
                              return (
                                <>
                                  <span
                                    className={`inline-block size-1.5 rounded-full ${t.color}`}
                                    title={`${ms}ms ping`}
                                  />
                                  <span className="text-[10px] text-muted-foreground">
                                    {ms}ms
                                  </span>
                                </>
                              );
                            })()}
                          </p>
                        </div>
                        <Field label="Last Seen" value={lastSeen ?? "Never"} />
                      </div>
                    )}
                  </div>
                </section>

                {/* Notes */}
                <PlayerNotesSection
                  subjectId={playerData.steamId}
                  orgId={fetchOrgId}
                />

                {/* Tickets */}
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
                    <span>Tickets</span>
                    <span className="font-mono normal-case tracking-normal text-muted-foreground">
                      0
                    </span>
                  </h3>
                  <p className="text-xs text-muted-foreground italic">
                    No tickets involving this player.
                  </p>
                </section>

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

                {/* Bans on Other Orgs */}
                {!isSupportOnly && (
                  <ExternalBansSection
                    subjectId={playerData.steamId}
                    bans={playerData.bmBans}
                  />
                )}

                {/* F7 / Thorium alerts */}
                {!isSupportOnly && (
                  <AlertsSectionLookup steamId={playerData.steamId} />
                )}

                {/* Linked Accounts */}
                {!isSupportOnly && (
                  <LinkedAccountIntelSection
                    subjectId={playerData.steamId}
                    subjectName={playerData.displayName ?? playerData.steamId}
                    relatedAccounts={playerData.relatedAccounts}
                  />
                )}

                {/* Hit % by Distance */}
                {!isSupportOnly && (
                  <HitDistanceSection subjectId={playerData.steamId} />
                )}

                {/* Current Team / Previous Team / Associated Players */}
                {!isSupportOnly && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <TeammatesSection
                      subjectId={playerData.steamId}
                      category="teaming"
                      only="current"
                    />
                    <TeammatesSection
                      subjectId={playerData.steamId}
                      category="teaming"
                      only="previous"
                    />
                    <FriendlyRecipientsSection
                      subjectId={playerData.steamId}
                      serverId={null}
                    />
                  </div>
                )}

                {/* Server History */}
                {!isSupportOnly && (
                  <ServerHistorySection
                    subjectId={playerData.steamId}
                    isOnline={
                      playerData.bmSessions?.[0]?.lastSeen
                        ? Date.now() -
                            Date.parse(playerData.bmSessions[0].lastSeen) <
                          5 * 60 * 1000
                        : false
                    }
                    bmSessions={playerData.bmSessions}
                  />
                )}

                {/* Chat Log + Kill/Death Feed */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <ChatLogSection subjectId={playerData.steamId} />
                  {!isSupportOnly && (
                    <KillFeedSection subjectId={playerData.steamId} />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Dialogs */}
          {steamId && (
            <BanDialog
              open={muteOpen}
              onOpenChange={setMuteOpen}
              orgId={banOrgId}
              category="toxicity"
              subjectName={displayName}
              onSubmit={submitMute}
              mode="mute"
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

        {steamId && banCategory && (
          <BanDialog
            open={banCategory !== null}
            onOpenChange={(v) => {
              if (!v) setBanCategory(null);
            }}
            orgId={banOrgId}
            category={banCategory}
            subjectName={displayName}
            onSubmit={submitBan}
          />
        )}
      </div>
    </SteamRequiredGate>
  );
}

function PlayerManageDialog({ steamId, kind, orgIds, open, onOpenChange }) {
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
      setRecords(
        groups.flat().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)),
      );
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
        setActionError(body.error ?? `Failed to ${kind === "Ban" ? "unban" : "unmute"} (${res.status})`);
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
        setActionError(body.error ?? `Failed to update duration (${res.status})`);
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
                (!r.expiresAt || Date.parse(r.expiresAt) > Date.now());
              return (
                <li
                  key={r.banId}
                  className="bg-surface/40 ring-1 ring-border rounded p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{r.reason}</p>
                      <p className="text-[10px] font-mono text-muted-foreground">
                        {new Date(r.issuedAt).toLocaleDateString()} · by{" "}
                        {r.issuedByName ?? "unknown"}
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

export { Route };

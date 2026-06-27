import { SteamRequiredGate } from "@/components/steam-required-gate";
import { PlayerLinks } from "@/components/player-links";
import { SiteNav } from "@/components/site-nav";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAuth } from "@/lib/auth-context";
import { usePersistentState } from "@/lib/persistent-prefs";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Flag,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const Route = createFileRoute("/player-list")({
  head: () => ({ meta: [{ title: "Player List — IronSight" }] }),
  component: PlayerListPage,
});

const SORT_LABEL = {
  susScore: "Sus Score",
  kills: "Kills",
  deaths: "Deaths",
  kd: "K/D",
  rustHours: "Steam Hours",
  bmHours: "BM Hours",
  name: "Name",
};

function susColor(s) {
  if (s >= 100) return "bg-danger/15 text-danger ring-danger/40";
  if (s >= 50) return "bg-warning/15 text-warning ring-warning/40";
  return "bg-surface text-muted-foreground ring-border";
}

function steamIdAvatarColor(steamId) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < steamId.length; i++) {
    h ^= steamId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `oklch(${0.4 + (h % 200) / 1000} ${0.08 + (h % 100) / 1000} ${h % 360})`;
}

function PlayerListPage() {
  const { orgs, selectedOrgIds, hasOrgPermission, sessionUser } = useAuth();
  const canAccess = selectedOrgIds.some((id) =>
    hasOrgPermission(id, "players_view"),
  );

  const [realServers, setRealServers] = useState([]);
  const [players, setPlayers] = useState([]);
  const [serverStatuses, setServerStatuses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const [serverIds, setServerIds] = useState(null);
  const [sortKey, setSortKey] = usePersistentState(
    "playerList.sortKey",
    "susScore",
  );
  const [sortDir, setSortDir] = usePersistentState(
    "playerList.sortDir",
    "desc",
  );
  const [query, setQuery] = useState("");
  const [onlineOnly, setOnlineOnly] = usePersistentState(
    "playerList.onlineOnly",
    false,
  );
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState(null);
  const [cacheClearBusy, setCacheClearBusy] = useState(false);
  const [keyResetBusy, setKeyResetBusy] = useState(false);

  const [recentReports, setRecentReports] = useState([]);
  const [recentReportsLoading, setRecentReportsLoading] = useState(false);

  const PAGE_SIZE = 50;
  const intervalRef = useRef(null);
  const fetchingRef = useRef(false);

  const orgIdsKey = selectedOrgIds.slice().sort().join(",");

  const fetchData = useCallback(async () => {
    if (!canAccess || selectedOrgIds.length === 0) return;
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const [serversRes, ...playerListRes] = await Promise.all([
        fetch("/api/servers", { credentials: "include" }),
        ...selectedOrgIds.map((orgId) =>
          fetch(`/api/orgs/${encodeURIComponent(orgId)}/player-list`, {
            credentials: "include",
          }),
        ),
      ]);

      const serversData = await serversRes.json();
      setRealServers(serversData.servers ?? []);

      const allPlayers = [];
      const allStatuses = [];
      for (const res of playerListRes) {
        const data = await res.json();
        allPlayers.push(...(data.players ?? []));
        allStatuses.push(...(data.servers ?? []));
      }
      setPlayers(allPlayers);
      setServerStatuses(allStatuses);
      setLastRefresh(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [canAccess, orgIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(fetchData, 30000);
    return () => clearInterval(intervalRef.current);
  }, [fetchData]);

  const fetchRecentReports = useCallback(async () => {
    if (!canAccess || selectedOrgIds.length === 0) return;
    setRecentReportsLoading(true);
    try {
      const all = await Promise.all(
        selectedOrgIds.map((orgId) =>
          fetch(
            `/api/orgs/${encodeURIComponent(orgId)}/recent-reports?limit=50`,
            { credentials: "include" },
          ).then((r) => (r.ok ? r.json() : { reports: [] })),
        ),
      );
      const merged = all.flatMap((d) => d.reports ?? []);
      merged.sort((a, b) => b.createdAt - a.createdAt);
      setRecentReports(merged.slice(0, 50));
    } catch {
      // best-effort
    } finally {
      setRecentReportsLoading(false);
    }
  }, [canAccess, orgIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchRecentReports();
    const id = setInterval(fetchRecentReports, 30000);
    return () => clearInterval(id);
  }, [fetchRecentReports]);

  const visibleServers = useMemo(
    () => realServers.filter((s) => selectedOrgIds.includes(s.ownerOrgId)),
    [realServers, selectedOrgIds],
  );

  const effectiveServerIds = useMemo(() => {
    const all = visibleServers.map((s) => s.serverId);
    if (serverIds === null) return new Set(all);
    return new Set(serverIds.filter((id) => all.includes(id)));
  }, [serverIds, visibleServers]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = players.filter(
      (p) => !p.isOnline || effectiveServerIds.has(p.serverId),
    );
    if (onlineOnly) {
      list = list.filter((p) => p.isOnline);
    }
    if (q) {
      list = list.filter(
        (p) => p.name.toLowerCase().includes(q) || p.steamId.includes(q),
      );
    }
    list = [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" || typeof bv === "string") {
        return sortDir === "desc"
          ? String(bv ?? "").localeCompare(String(av ?? ""))
          : String(av ?? "").localeCompare(String(bv ?? ""));
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return list;
  }, [players, effectiveServerIds, query, onlineOnly, sortKey, sortDir]);

  useEffect(() => {
    setPage(1);
  }, [serverIds, query, onlineOnly, sortKey, sortDir, selectedOrgIds]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const setSort = (k) => {
    if (k === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(k);
      setSortDir(k === "name" ? "asc" : "desc");
    }
  };

  const toggleServer = (id) => {
    const all = visibleServers.map((s) => s.serverId);
    const current = serverIds === null ? all : serverIds;
    setServerIds(
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  };

  const copySteamId = async (id) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {}
  };

  const visibleServerIds = visibleServers.map((s) => s.serverId);
  const effectiveArr = [...effectiveServerIds];

  const serverLabel =
    effectiveArr.length === visibleServerIds.length
      ? "All servers"
      : effectiveArr.length === 0
        ? "No servers"
        : effectiveArr
            .map((id) =>
              visibleServers
                .find((s) => s.serverId === id)
                ?.serverName.replace(/^\[[^\]]+\]\s*/, ""),
            )
            .filter(Boolean)
            .join(" \xB7 ");

  const rconErrors = serverStatuses.filter((s) => s.rconError);

  const handleClearAllCache = async () => {
    if (
      !window.confirm(
        "Clear the entire player cache? All cached player data will be deleted and re-fetched on next lookup.",
      )
    )
      return;
    setCacheClearBusy(true);
    try {
      const res = await fetch("/api/admin/player-cache", {
        method: "DELETE",
        credentials: "include",
      });
      const body = await res.json();
      if (res.ok) {
        alert(
          `Cache cleared. Redis: ${body.redisCleared} keys, DB: ${body.dbCleared} rows deleted.`,
        );
      } else {
        alert(body.error ?? "Failed to clear cache.");
      }
    } catch {
      alert("Network error.");
    } finally {
      setCacheClearBusy(false);
    }
  };

  const handleResetKeyLimits = async () => {
    if (
      !window.confirm(
        "Reset external API key rate limits? This re-enables any Steam/BattleMetrics/Proxycheck key that was auto-disabled (e.g. by a private-profile lookup). Keys disabled in the UI are not affected.",
      )
    )
      return;
    setKeyResetBusy(true);
    try {
      const res = await fetch("/api/admin/reset-key-limits", {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json();
      if (res.ok) {
        alert(`Reset complete. Cleared rate limits on ${body.cleared} key(s).`);
      } else {
        alert(body.error ?? "Failed to reset key limits.");
      }
    } catch {
      alert("Network error.");
    } finally {
      setKeyResetBusy(false);
    }
  };

  if (!canAccess) {
    return (
      <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 grid place-items-center px-6">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="size-10 text-warning mx-auto" />
            <h1 className="text-lg font-semibold">Admin access required</h1>
            <p className="text-sm text-muted-foreground">
              The player list is restricted to{" "}
              <span className="font-mono text-foreground">Admin</span> and
              above. You don&apos;t have that rank in any of the currently
              selected orgs (
              {selectedOrgIds
                .map((id) => orgs.find((o) => o.id === id)?.short)
                .filter(Boolean)
                .join(", ") || "none"}
              ). Try selecting a different organization from the top-left
              selector.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <SteamRequiredGate>
      <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 overflow-hidden flex">
          <div className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold tracking-tight">
                  Player List
                </h1>
                <p className="text-xs text-muted-foreground mt-1">
                  All players seen on your servers. Sus score is based on Steam
                  hours, K/D ratio, and report count.
                </p>
              </div>
              <div className="flex items-center gap-3">
                {lastRefresh && (
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {players.length} players ·{" "}
                    {players.filter((p) => p.isOnline).length} online
                  </span>
                )}
                <button
                  onClick={fetchData}
                  disabled={loading}
                  className="flex items-center gap-1.5 px-2.5 h-8 rounded ring-1 ring-border bg-surface/40 hover:bg-surface text-xs disabled:opacity-50"
                  title="Refresh player list"
                >
                  <RefreshCw
                    className={`size-3 ${loading ? "animate-spin" : ""}`}
                  />
                  Refresh
                </button>
                {sessionUser?.isSysAdmin && (
                  <button
                    onClick={handleClearAllCache}
                    disabled={cacheClearBusy}
                    className="flex items-center gap-1.5 px-2.5 h-8 rounded ring-1 ring-border bg-surface/40 hover:bg-surface hover:text-danger hover:ring-danger/40 text-xs disabled:opacity-50 transition-colors"
                    title="Clear all player cache (sysadmin)"
                  >
                    <Trash2 className="size-3" />
                    Clear Cache
                  </button>
                )}
                {sessionUser?.isSysAdmin && (
                  <button
                    onClick={handleResetKeyLimits}
                    disabled={keyResetBusy}
                    className="flex items-center gap-1.5 px-2.5 h-8 rounded ring-1 ring-border bg-surface/40 hover:bg-surface hover:text-brand hover:ring-brand/40 text-xs disabled:opacity-50 transition-colors"
                    title="Reset external API key rate limits (sysadmin)"
                  >
                    <KeyRound className="size-3" />
                    Reset Key Limits
                  </button>
                )}
              </div>
            </div>

            {/* RCON errors */}
            {rconErrors.length > 0 && (
              <div className="rounded-md ring-1 ring-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning space-y-0.5">
                {rconErrors.map((s) => (
                  <div key={s.serverId}>
                    <span className="font-medium">{s.serverName}</span>
                    {" — "}
                    {s.rconError}
                  </div>
                ))}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="rounded-md ring-1 ring-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
                Failed to load player list: {error}
              </div>
            )}

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                placeholder="Search name or Steam ID…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-9 max-w-xs"
              />
              <button
                onClick={() => setOnlineOnly((v) => !v)}
                aria-pressed={onlineOnly}
                className={
                  "flex items-center gap-1.5 px-2.5 h-9 rounded ring-1 text-xs transition-colors " +
                  (onlineOnly
                    ? "ring-success/40 bg-success/10 text-success"
                    : "ring-border bg-surface/40 hover:bg-surface text-muted-foreground")
                }
                title="Show only players currently online"
              >
                <span
                  className={
                    "size-1.5 rounded-full " +
                    (onlineOnly ? "bg-success" : "bg-muted-foreground/50")
                  }
                />
                Online only
              </button>
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground ml-auto">
                Sorted by {SORT_LABEL[sortKey]} {sortDir === "desc" ? "↓" : "↑"}{" "}
                {"\xB7"} click a column to change
              </div>
            </div>

            {/* Loading skeleton */}
            {loading && players.length === 0 && (
              <div className="rounded-md ring-1 ring-border bg-surface/40 px-4 py-10 text-center text-xs text-muted-foreground animate-pulse">
                Loading player list…
              </div>
            )}

            {/* Table */}
            {(!loading || players.length > 0) && (
              <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
                <div className="grid grid-cols-[minmax(220px,2fr)_140px_70px_60px_60px_60px_70px_70px_60px] gap-2 px-3 py-2 border-b border-border text-[10px] font-mono uppercase tracking-widest text-muted-foreground sticky top-0 bg-surface/80 backdrop-blur">
                  <HeaderCell
                    label="Player"
                    k="name"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={setSort}
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        className={
                          "px-1 flex items-center gap-1 hover:text-foreground transition-colors text-left " +
                          (effectiveArr.length !== visibleServerIds.length
                            ? "text-brand"
                            : "")
                        }
                        title={serverLabel}
                      >
                        <span>Server</span>
                        <ChevronDown className="size-3" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-72 p-2">
                      <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-border">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                          Filter servers
                        </span>
                        <button
                          onClick={() => {
                            setServerIds(
                              effectiveArr.length === visibleServerIds.length
                                ? []
                                : visibleServerIds,
                            );
                          }}
                          className="text-[10px] font-semibold text-brand hover:underline"
                        >
                          {effectiveArr.length === visibleServerIds.length
                            ? "Clear"
                            : "Select all"}
                        </button>
                      </div>
                      <div className="space-y-0.5">
                        {visibleServers.length === 0 && (
                          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                            No servers in the selected orgs.
                          </div>
                        )}
                        {visibleServers.map((s) => {
                          const checked = effectiveServerIds.has(s.serverId);
                          const org = orgs.find((o) => o.id === s.ownerOrgId);
                          const status = serverStatuses.find(
                            (st) => st.serverId === s.serverId,
                          );
                          return (
                            <button
                              key={s.serverId}
                              onClick={() => toggleServer(s.serverId)}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
                            >
                              <span
                                className={
                                  "size-3.5 rounded-sm ring-1 " +
                                  (checked
                                    ? "bg-brand ring-brand"
                                    : "ring-border")
                                }
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium truncate normal-case tracking-normal">
                                  {s.serverName}
                                </div>
                                <div className="text-[9px] font-mono text-muted-foreground normal-case tracking-normal">
                                  {org?.short}
                                  {status?.rconError ? (
                                    <span className="text-danger ml-1">
                                      · RCON error
                                    </span>
                                  ) : status ? (
                                    <span className="ml-1">
                                      · {status.playerCount} online
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>

                  <HeaderCell
                    label="Sus"
                    k="susScore"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={setSort}
                    align="right"
                  />
                  <HeaderCell
                    label="Kills"
                    k="kills"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={setSort}
                    align="right"
                  />
                  <HeaderCell
                    label="Deaths"
                    k="deaths"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={setSort}
                    align="right"
                  />
                  <HeaderCell
                    label="K/D"
                    k="kd"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={setSort}
                    align="right"
                  />
                  <HeaderCell
                    label="Steam h"
                    k="rustHours"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={setSort}
                    align="right"
                  />
                  <HeaderCell
                    label="BM h"
                    k="bmHours"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={setSort}
                    align="right"
                  />
                  <div className="px-1 text-right">Proxy</div>
                </div>

                <div className="divide-y divide-border/60">
                  {pageRows.map((p) => {
                    const avatarColor = steamIdAvatarColor(p.steamId);
                    return (
                      <div
                        key={p.steamId}
                        className="grid grid-cols-[minmax(220px,2fr)_140px_70px_60px_60px_60px_70px_70px_60px] gap-2 px-3 py-2 items-center text-xs hover:bg-surface/60 transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {p.avatarUrl ? (
                            <img
                              src={p.avatarUrl}
                              alt={p.name}
                              className="size-7 rounded ring-1 ring-black/40 shrink-0 object-cover"
                            />
                          ) : (
                            <div
                              className="size-7 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-[10px] text-background shrink-0"
                              style={{ background: avatarColor }}
                            >
                              {p.name
                                .replace(/\[[^\]]*\]\s*/g, "")
                                .slice(0, 2)
                                .toUpperCase() || "??"}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate flex items-center gap-1.5">
                              <span className="truncate">{p.name}</span>
                              <PlayerLinks steamId={p.steamId} />
                            </div>
                            <div className="text-[10px] font-mono text-muted-foreground truncate flex items-center gap-1">
                              {p.steamId}
                              <button
                                onClick={() => copySteamId(p.steamId)}
                                className="inline-flex items-center justify-center rounded hover:text-foreground transition-colors"
                                title="Copy Steam ID"
                              >
                                {copiedId === p.steamId ? (
                                  <Check className="size-3 text-success" />
                                ) : (
                                  <Copy className="size-3" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                        <div
                          className="text-[10px] font-mono text-muted-foreground truncate flex items-center gap-1"
                          title={p.serverName ?? ""}
                        >
                          {p.isOnline ? (
                            <>
                              <span className="size-1.5 rounded-full bg-success shrink-0" />
                              {p.serverName.replace(/^\[[^\]]+\]\s*/, "")}
                            </>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </div>
                        <div className="text-right">
                          <span
                            className={
                              "px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 " +
                              susColor(p.susScore)
                            }
                          >
                            {Math.min(p.susScore, 100)}
                          </span>
                        </div>
                        <div className="text-right font-mono">{p.kills}</div>
                        <div className="text-right font-mono">{p.deaths}</div>
                        <div className="text-right font-mono">
                          {p.kd.toFixed(2)}
                        </div>
                        <div className="text-right font-mono">
                          {p.rustHours > 0 ? p.rustHours : "—"}
                        </div>
                        <div className="text-right font-mono">
                          {p.bmHours > 0 ? p.bmHours : "—"}
                        </div>
                        <div className="text-right">
                          <span
                            className={
                              "px-1.5 py-0.5 rounded text-[9px] font-mono font-bold ring-1 " +
                              (p.isProxy
                                ? "bg-danger/15 text-danger ring-danger/40"
                                : "bg-surface ring-border text-muted-foreground")
                            }
                          >
                            {p.isProxy ? "YES" : "NO"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {rows.length === 0 && !loading && (
                    <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                      {selectedOrgIds.length === 0
                        ? "No organization selected."
                        : players.length === 0
                          ? "No players have been seen on your servers yet."
                          : "No players match your filters."}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Pagination */}
            {rows.length > PAGE_SIZE && (
              <div className="flex items-center justify-between text-xs">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Showing {(safePage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safePage * PAGE_SIZE, rows.length)} of {rows.length}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    className="px-2.5 h-8 rounded ring-1 ring-border bg-surface/40 hover:bg-surface disabled:opacity-40 disabled:hover:bg-surface/40"
                  >
                    Prev
                  </button>
                  <span className="font-mono px-2">
                    {safePage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    className="px-2.5 h-8 rounded ring-1 ring-border bg-surface/40 hover:bg-surface disabled:opacity-40 disabled:hover:bg-surface/40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
          </div>

          {/* Recent F7 reports sidebar */}
          <RecentReportsSidebar
            reports={recentReports}
            loading={recentReportsLoading}
          />
        </div>
      </div>
    </SteamRequiredGate>
  );
}

function timeAgo(unix) {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function RecentReportsSidebar({ reports, loading }) {
  return (
    <div className="w-72 shrink-0 border-l border-border flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 shrink-0">
        <Flag className="size-3.5 text-warning" />
        <span className="text-xs font-semibold">Recent F7 Reports</span>
        {loading && (
          <span className="ml-auto text-[10px] font-mono text-muted-foreground animate-pulse">
            updating…
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-border/60">
        {reports.length === 0 && !loading && (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No reports in the last 24h
          </div>
        )}
        {reports.map((r) => (
          <div key={r.id} className="px-3 py-2.5 space-y-1 hover:bg-surface/40 transition-colors">
            <div className="flex items-start justify-between gap-1">
              <span className="text-[10px] font-mono text-muted-foreground truncate flex-1">
                {r.serverName.replace(/^\[[^\]]+\]\s*/, "")}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                {timeAgo(r.createdAt)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-mono uppercase tracking-wider px-1 py-0.5 rounded ring-1 bg-warning/10 text-warning ring-warning/30">
                {r.reportReason || r.reportType}
              </span>
            </div>
            <div className="text-[11px] font-medium truncate">
              <Link
                to="/player-lookup"
                search={{ steam: r.reportedSteamId }}
                className="hover:text-brand transition-colors"
              >
                {r.reportedSteamId}
              </Link>
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              by {r.reporterName}
            </div>
            {r.reportDescription && (
              <div className="text-[10px] text-muted-foreground line-clamp-2">
                {r.reportDescription}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HeaderCell({ label, k, sortKey, sortDir, onClick, align = "left" }) {
  const active = sortKey === k;
  return (
    <button
      onClick={() => onClick(k)}
      className={
        "px-1 flex items-center gap-1 hover:text-foreground transition-colors " +
        (align === "right" ? "justify-end" : "justify-start") +
        (active ? " text-foreground" : "")
      }
    >
      <span>{label}</span>
      {active &&
        (sortDir === "desc" ? (
          <ArrowDown className="size-3" />
        ) : (
          <ArrowUp className="size-3" />
        ))}
    </button>
  );
}

export { Route };

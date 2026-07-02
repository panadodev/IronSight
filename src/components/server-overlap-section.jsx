import { useAuth } from "@/lib/auth-context";
import { PlayerLinks } from "@/components/player-links";
import { Ban, ChevronDown, Shield, Wifi } from "lucide-react";
import { useMemo, useState } from "react";

export function ServerOverlapSection({
  serverOverlap,
  subjectName,
  relatedName,
}) {
  const { selectedOrgIds } = useAuth();
  const orgId = selectedOrgIds[0] ?? null;

  const [expandedServers, setExpandedServers] = useState(new Set());
  const [coPlayerCache, setCoPlayerCache] = useState({});
  const [loadingServers, setLoadingServers] = useState(new Set());

  const serverList = useMemo(() => {
    if (!Array.isArray(serverOverlap)) return [];
    return serverOverlap.filter((s) => s && typeof s === "string");
  }, [serverOverlap]);

  if (!serverList.length) return null;

  const toggleExpanded = (serverId) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
        if (!coPlayerCache[serverId]) {
          fetchCoPlayers(serverId);
        }
      }
      return next;
    });
  };

  const fetchCoPlayers = async (serverId) => {
    if (!orgId || coPlayerCache[serverId]) return;
    setLoadingServers((prev) => new Set(prev).add(serverId));
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/bm-server/${encodeURIComponent(serverId)}/co-players`,
        { credentials: "include" },
      );
      const data = res.ok ? await res.json() : null;
      setCoPlayerCache((prev) => ({
        ...prev,
        [serverId]: data?.players ?? [],
      }));
    } catch {
      setCoPlayerCache((prev) => ({ ...prev, [serverId]: [] }));
    } finally {
      setLoadingServers((prev) => {
        const next = new Set(prev);
        next.delete(serverId);
        return next;
      });
    }
  };

  return (
    <div className="border-t border-border pt-4">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
        <Wifi className="size-3" />
        Previous Connection Points
        <span className="text-[9px] font-mono ml-auto">
          {serverList.length}
        </span>
      </h4>
      <div className="space-y-1">
        {serverList.map((serverId) => {
          const isExpanded = expandedServers.has(serverId);
          const isLoading = loadingServers.has(serverId);
          const players = coPlayerCache[serverId];

          const bannedCount = players
            ? players.filter(
                (p) => p.bmBanned || p.vacBanned || p.gameBanCount > 0,
              ).length
            : 0;

          return (
            <div
              key={serverId}
              className="bg-surface/30 rounded border border-border/50"
            >
              <button
                onClick={() => toggleExpanded(serverId)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface/50 transition-colors"
              >
                <ChevronDown
                  className={`size-3 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                />
                <span className="text-[10px] font-mono text-foreground flex-1 text-left">
                  {serverId.slice(0, 16)}
                  {serverId.length > 16 ? "…" : ""}
                </span>
                {isLoading ? (
                  <span className="text-[9px] text-muted-foreground">
                    Loading…
                  </span>
                ) : players ? (
                  <div className="flex items-center gap-1 ml-auto">
                    <span className="text-[9px] text-muted-foreground">
                      {players.length} player{players.length === 1 ? "" : "s"}
                    </span>
                    {bannedCount > 0 && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-danger/15 text-danger text-[9px] font-mono">
                        <Ban className="size-2.5" />
                        {bannedCount} banned
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-[9px] text-brand cursor-pointer hover:underline">
                    Show players
                  </span>
                )}
              </button>

              {isExpanded && (
                <div className="px-3 py-2 bg-surface/50 border-t border-border/50 space-y-1">
                  {!players ? (
                    <p className="text-[9px] text-muted-foreground">Loading…</p>
                  ) : players.length === 0 ? (
                    <p className="text-[9px] text-muted-foreground italic">
                      No known players found for this server.
                    </p>
                  ) : (
                    players.map((p) => (
                      <div
                        key={p.steamId}
                        className="flex items-center gap-2 py-0.5"
                      >
                        <span className="text-[10px] font-mono truncate flex-1 text-foreground">
                          {p.displayName ?? p.steamId}
                        </span>
                        {p.bmBanned && (
                          <span className="text-[8px] font-mono uppercase px-1 py-0.5 rounded bg-danger/15 text-danger ring-1 ring-danger/30">
                            BAN
                          </span>
                        )}
                        {(p.vacBanned || p.vacCount > 0) && (
                          <span className="text-[8px] font-mono uppercase px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/30">
                            EAC
                          </span>
                        )}
                        <PlayerLinks steamId={p.steamId} size="xs" />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

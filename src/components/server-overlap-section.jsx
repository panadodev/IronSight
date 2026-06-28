import { AlertOctagon, Ban, ChevronDown, Wifi } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * ServerOverlapSection displays shared servers (connection points) between
 * a subject player and a related account. Each server can be expanded to show
 * EAC and BM ban information for that specific connection point.
 */
export function ServerOverlapSection({ serverOverlap, relatedBmId, subjectName, relatedName }) {
  const [expandedServers, setExpandedServers] = useState(new Set());
  const [serverBanCache, setServerBanCache] = useState({});
  const [loadingServers, setLoadingServers] = useState(new Set());

  const serverList = useMemo(() => {
    if (!Array.isArray(serverOverlap)) return [];
    return serverOverlap.filter(s => s && typeof s === "string");
  }, [serverOverlap]);

  if (!serverList.length) {
    return null;
  }

  const toggleExpanded = (serverId) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
        // Fetch ban data when expanded
        if (!serverBanCache[serverId]) {
          fetchServerBans(serverId);
        }
      }
      return next;
    });
  };

  const fetchServerBans = async (serverId) => {
    if (serverBanCache[serverId]) return;

    setLoadingServers((prev) => new Set(prev).add(serverId));
    try {
      // Fetch EAC bans for this connection point
      const eacResponse = await fetch(
        `/api/server/${encodeURIComponent(serverId)}/eac-bans?bmId=${encodeURIComponent(relatedBmId)}`
      );

      // Fetch BM (BattleMetrics) bans for this connection point
      const bmResponse = await fetch(
        `/api/server/${encodeURIComponent(serverId)}/bm-bans?bmId=${encodeURIComponent(relatedBmId)}`
      );

      const eacData = eacResponse.ok ? await eacResponse.json() : null;
      const bmData = bmResponse.ok ? await bmResponse.json() : null;

      setServerBanCache((prev) => ({
        ...prev,
        [serverId]: {
          eacBans: eacData?.bans ?? [],
          bmBans: bmData?.bans ?? [],
          eacBanCount: eacData?.count ?? 0,
          bmBanCount: bmData?.count ?? 0,
          fetchedAt: Date.now(),
        },
      }));
    } catch (err) {
      console.error(`Failed to fetch bans for server ${serverId}:`, err);
      setServerBanCache((prev) => ({
        ...prev,
        [serverId]: {
          eacBans: [],
          bmBans: [],
          eacBanCount: 0,
          bmBanCount: 0,
          error: true,
          fetchedAt: Date.now(),
        },
      }));
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
        <span className="text-[9px] font-mono ml-auto">{serverList.length}</span>
      </h4>
      <div className="space-y-1">
        {serverList.map((serverId) => {
          const isExpanded = expandedServers.has(serverId);
          const isLoading = loadingServers.has(serverId);
          const banData = serverBanCache[serverId];
          const hasEacBans = banData?.eacBanCount > 0;
          const hasBmBans = banData?.bmBanCount > 0;

          return (
            <div key={serverId} className="bg-surface/30 rounded border border-border/50">
              <button
                onClick={() => toggleExpanded(serverId)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface/50 transition-colors"
              >
                <ChevronDown
                  className={`size-3 shrink-0 transition-transform ${
                    isExpanded ? "rotate-180" : ""
                  }`}
                />
                <span className="text-[10px] font-mono text-foreground flex-1 text-left">
                  {serverId.slice(0, 16)}
                  {serverId.length > 16 ? "..." : ""}
                </span>
                {isLoading ? (
                  <span className="text-[9px] text-muted-foreground">Loading...</span>
                ) : banData ? (
                  <div className="flex items-center gap-1 ml-auto">
                    {hasEacBans && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-danger/15 text-danger text-[9px] font-mono">
                        <AlertOctagon className="size-2.5" />
                        EAC×{banData.eacBanCount}
                      </span>
                    )}
                    {hasBmBans && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-warning/15 text-warning text-[9px] font-mono">
                        <Ban className="size-2.5" />
                        BM×{banData.bmBanCount}
                      </span>
                    )}
                    {!hasEacBans && !hasBmBans && (
                      <span className="text-[9px] text-muted-foreground">No bans</span>
                    )}
                  </div>
                ) : (
                  <span
                    className="text-[9px] text-brand cursor-pointer hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(serverId);
                    }}
                  >
                    Check bans
                  </span>
                )}
              </button>

              {isExpanded && banData && (
                <div className="px-3 py-2 bg-surface/50 border-t border-border/50 text-[9px] space-y-2">
                  {banData.error ? (
                    <p className="text-muted-foreground">Failed to fetch ban data.</p>
                  ) : (
                    <>
                      {(banData.eacBans ?? []).length > 0 && (
                        <div>
                          <p className="font-semibold text-danger mb-1 flex items-center gap-1">
                            <AlertOctagon className="size-3" />
                            EAC Bans ({banData.eacBans.length})
                          </p>
                          <ul className="space-y-1 ml-4 text-muted-foreground">
                            {banData.eacBans.slice(0, 3).map((ban, i) => (
                              <li key={i} className="text-[8px]">
                                {ban.reason || "No reason provided"}
                              </li>
                            ))}
                            {banData.eacBans.length > 3 && (
                              <li className="text-[8px] italic">
                                + {banData.eacBans.length - 3} more
                              </li>
                            )}
                          </ul>
                        </div>
                      )}
                      {(banData.bmBans ?? []).length > 0 && (
                        <div>
                          <p className="font-semibold text-warning mb-1 flex items-center gap-1">
                            <Ban className="size-3" />
                            BattleMetrics Bans ({banData.bmBans.length})
                          </p>
                          <ul className="space-y-1 ml-4 text-muted-foreground">
                            {banData.bmBans.slice(0, 3).map((ban, i) => (
                              <li key={i} className="text-[8px]">
                                {ban.reason || "No reason provided"}
                              </li>
                            ))}
                            {banData.bmBans.length > 3 && (
                              <li className="text-[8px] italic">
                                + {banData.bmBans.length - 3} more
                              </li>
                            )}
                          </ul>
                        </div>
                      )}
                      {!banData.eacBans?.length && !banData.bmBans?.length && (
                        <p className="text-muted-foreground italic">
                          No EAC or BM bans found for this connection point.
                        </p>
                      )}
                    </>
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

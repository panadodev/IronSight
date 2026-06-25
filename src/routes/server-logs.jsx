import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ScrollText,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
} from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { useTimezone } from "@/lib/timezone-store";

const Route = createFileRoute("/server-logs")({
  head: () => ({ meta: [{ title: "Server Logs — IronSight" }] }),
  validateSearch: (s) => ({
    org: typeof s.org === "string" ? s.org : undefined,
  }),
  component: ServerLogsPage,
});

const EVENT_META = {
  ADMIN_COMMAND: { label: "Admin command", color: "hsl(210 80% 60%)" },
  KICK: { label: "Kick", color: "hsl(30 85% 60%)" },
  BAN: { label: "Ban", color: "hsl(0 80% 55%)" },
  UNBAN: { label: "Unban", color: "hsl(160 70% 55%)" },
  MUTE: { label: "Mute", color: "hsl(45 90% 60%)" },
  UNMUTE: { label: "Unmute", color: "hsl(145 65% 50%)" },
  RCON_COMMAND: { label: "RCON command", color: "hsl(270 65% 60%)" },
  NOCLIP_TOGGLE: { label: "Noclip toggle", color: "hsl(55 85% 55%)" },
  GODMODE_TOGGLE: { label: "Godmode toggle", color: "hsl(300 70% 60%)" },
};

function eventMeta(type) {
  return (
    EVENT_META[type] ?? {
      label: type.replace(/_/g, " ").toLowerCase(),
      color: "hsl(0 0% 60%)",
    }
  );
}

function buildDailyBuckets(logs, tz) {
  const opts = tz ? { timeZone: tz } : undefined;
  const todayStr = new Date().toLocaleDateString("en-CA", opts);
  const days = Array.from({ length: 30 }, () => 0);
  for (const log of logs) {
    const dStr = new Date(log.createdAt * 1000).toLocaleDateString(
      "en-CA",
      opts,
    );
    const diff = Math.round(
      (new Date(todayStr).getTime() - new Date(dStr).getTime()) / 86400000,
    );
    if (diff >= 0 && diff < 30) {
      days[29 - diff]++;
    }
  }
  return days;
}

function ActivityChart({ days }) {
  const w = 800,
    h = 200,
    padL = 36,
    padR = 12,
    padT = 12,
    padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const max = Math.max(1, ...days);
  const stepX = innerW / (days.length - 1);
  const yTicks = 4;

  const pathD = days
    .map((v, i) => {
      const x = padL + stepX * i;
      const y = padT + innerH - (v / max) * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-auto block"
      preserveAspectRatio="none"
    >
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const y = padT + (innerH * i) / yTicks;
        const v = Math.round((max * (yTicks - i)) / yTicks);
        return (
          <g key={i}>
            <line
              x1={padL}
              x2={w - padR}
              y1={y}
              y2={y}
              stroke="hsl(var(--border, 0 0% 30%))"
              strokeOpacity={0.25}
            />
            <text
              x={padL - 6}
              y={y + 3}
              textAnchor="end"
              className="fill-muted-foreground"
              style={{ fontSize: 9, fontFamily: "monospace" }}
            >
              {v}
            </text>
          </g>
        );
      })}
      {days.map((_, i) =>
        i % 5 === 0 || i === days.length - 1 ? (
          <text
            key={i}
            x={padL + stepX * i}
            y={h - 6}
            textAnchor="middle"
            className="fill-muted-foreground"
            style={{ fontSize: 9, fontFamily: "monospace" }}
          >
            {i === days.length - 1 ? "today" : `-${29 - i}d`}
          </text>
        ) : null,
      )}
      <path d={pathD} fill="none" stroke="hsl(210 80% 60%)" strokeWidth={1.5} />
      {days.map((v, i) => {
        const x = padL + stepX * i;
        const y = padT + innerH - (v / max) * innerH;
        return (
          <circle
            key={i}
            cx={x.toFixed(2)}
            cy={y.toFixed(2)}
            r={1.6}
            fill="hsl(210 80% 60%)"
          />
        );
      })}
    </svg>
  );
}

function formatWhen(unix, tz) {
  const opts = tz ? { timeZone: tz } : undefined;
  const d = new Date(unix * 1000);
  const todayStr = new Date().toLocaleDateString("en-CA", opts);
  const dStr = d.toLocaleDateString("en-CA", opts);
  const diff = Math.round(
    (new Date(todayStr).getTime() - new Date(dStr).getTime()) / 86400000,
  );
  const hhmm = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(opts ?? {}),
  });
  if (diff === 0) return `Today · ${hhmm}`;
  if (diff === 1) return `Yesterday · ${hhmm}`;
  return `-${diff}d · ${hhmm}`;
}

function formatAdmin(log) {
  if (log.adminName && log.adminSteamId)
    return `${log.adminName} (${log.adminSteamId})`;
  return log.adminName ?? log.adminSteamId ?? "—";
}

function formatTarget(log) {
  if (log.targetName && log.targetSteamId)
    return `${log.targetName} (${log.targetSteamId})`;
  return log.targetName ?? log.targetSteamId ?? "—";
}

function formatDetail(log) {
  const parts = [];
  if (log.command) parts.push(log.command);
  const extra = Object.entries(log.details ?? {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  if (extra) parts.push(extra);
  return parts.join(" · ").slice(0, 100) || "—";
}

function compareLog(a, b, key) {
  switch (key) {
    case "createdAt":
      return a.createdAt - b.createdAt;
    case "eventType":
      return eventMeta(a.eventType).label.localeCompare(
        eventMeta(b.eventType).label,
      );
    case "serverName":
      return (a.serverName ?? "").localeCompare(b.serverName ?? "");
    case "admin":
      return formatAdmin(a).localeCompare(formatAdmin(b));
    case "target":
      return formatTarget(a).localeCompare(formatTarget(b));
    default:
      return 0;
  }
}

const PAGE_SIZE = 50;

function ServerLogsPage() {
  const { sessionOrgAdminIds } = useAuth();
  const tz = useTimezone();
  const search = Route.useSearch();
  const orgId = search.org ?? sessionOrgAdminIds[0] ?? "";

  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [serverFilter, setServerFilter] = useState("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sortKey, setSortKey] = useState("createdAt");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    setFetchError(null);
    setLogs([]);
    setTotal(0);
    setVisibleCount(PAGE_SIZE);
    setTypeFilter("all");
    setServerFilter("all");

    fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/server-logs?limit=500&offset=0`,
      { credentials: "include" },
    )
      .then((r) => r.json())
      .then((data) => {
        setLogs(data.logs ?? []);
        setTotal(data.total ?? 0);
      })
      .catch((err) => setFetchError(err.message))
      .finally(() => setLoading(false));
  }, [orgId]);

  const dailyBuckets = useMemo(() => buildDailyBuckets(logs, tz), [logs, tz]);

  const servers = useMemo(() => {
    const seen = new Map();
    for (const l of logs) {
      if (!seen.has(l.serverId)) seen.set(l.serverId, l.serverName);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [logs]);

  const eventTypes = useMemo(() => {
    const counts = {};
    for (const l of logs)
      counts[l.eventType] = (counts[l.eventType] ?? 0) + 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
  }, [logs]);

  const filteredLogs = useMemo(() => {
    let result = logs;
    if (typeFilter !== "all")
      result = result.filter((l) => l.eventType === typeFilter);
    if (serverFilter !== "all")
      result = result.filter((l) => l.serverId === serverFilter);
    return result;
  }, [logs, typeFilter, serverFilter]);

  const sortedLogs = useMemo(() => {
    const arr = [...filteredLogs];
    arr.sort((a, b) => {
      const cmp = compareLog(a, b, sortKey);
      return sortDir === "desc" ? -cmp : cmp;
    });
    return arr;
  }, [filteredLogs, sortKey, sortDir]);

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setVisibleCount(PAGE_SIZE);
  }

  function SortIcon({ col }) {
    if (sortKey !== col)
      return <ChevronsUpDown className="size-2.5 opacity-40" />;
    return sortDir === "asc" ? (
      <ChevronUp className="size-2.5" />
    ) : (
      <ChevronDown className="size-2.5" />
    );
  }

  const visibleLogs = sortedLogs.slice(0, visibleCount);
  const isAdmin = sessionOrgAdminIds.includes(orgId);
  const totalInRange = logs.filter((l) => {
    const now = Date.now() / 1000;
    return now - l.createdAt <= 30 * 86400;
  }).length;

  return (
    <div className="h-screen bg-background flex flex-col">
      <SiteNav />
      <main className="flex-1 flex">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto p-6 space-y-6">
            <div className="flex items-center gap-3 min-w-0">
              <Link
                to="/manage/staff"
                search={orgId ? { org: orgId } : undefined}
                className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <ArrowLeft className="size-3" /> Staff
              </Link>
              <span className="text-muted-foreground">/</span>
              <h1 className="text-lg font-semibold inline-flex items-center gap-2">
                <ScrollText className="size-4" />
                Server Logs
              </h1>
            </div>

            {!isAdmin && (
              <p className="text-sm text-muted-foreground italic">
                You need org admin access to view server logs.
              </p>
            )}

            {isAdmin && !orgId && (
              <p className="text-sm text-muted-foreground italic">
                Open this page from the Staff list.
              </p>
            )}

            {isAdmin && orgId && (
              <>
                <section>
                  <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3">
                    Activity · last 30 days
                    {!loading && (
                      <span className="ml-2 normal-case tracking-normal font-mono font-normal">
                        · {totalInRange} event{totalInRange !== 1 ? "s" : ""}
                      </span>
                    )}
                  </h2>
                  <div className="bg-surface/40 ring-1 ring-border rounded-lg p-4">
                    {loading ? (
                      <p className="text-xs text-muted-foreground py-8 text-center">
                        Loading…
                      </p>
                    ) : (
                      <ActivityChart days={dailyBuckets} />
                    )}
                  </div>
                </section>

                <section>
                  <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
                    <span>Full server log</span>
                    {!loading && (
                      <span className="font-mono normal-case tracking-normal text-muted-foreground">
                        {filteredLogs.length}
                        {(typeFilter !== "all" || serverFilter !== "all") &&
                          ` / ${logs.length}`}
                        {total > logs.length && ` of ${total}`}
                      </span>
                    )}
                  </h2>

                  <div className="flex flex-wrap gap-2 mb-2">
                    {[
                      ["all", "All types"],
                      ...eventTypes.map((t) => [t, eventMeta(t).label]),
                    ].map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => {
                          setTypeFilter(k);
                          setVisibleCount(PAGE_SIZE);
                        }}
                        className={`px-2 py-1 rounded text-[10px] font-mono uppercase ring-1 transition-colors ${typeFilter === k ? "text-foreground ring-border bg-surface" : "text-muted-foreground ring-border/50 hover:bg-surface/50"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {servers.length > 1 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                      {[["all", "All servers"], ...servers].map(
                        ([id, name]) => (
                          <button
                            key={id}
                            onClick={() => {
                              setServerFilter(id);
                              setVisibleCount(PAGE_SIZE);
                            }}
                            className={`px-2 py-1 rounded text-[10px] font-mono ring-1 transition-colors ${serverFilter === id ? "text-foreground ring-border bg-surface" : "text-muted-foreground ring-border/50 hover:bg-surface/50"}`}
                          >
                            {name}
                          </button>
                        ),
                      )}
                    </div>
                  )}

                  {fetchError && (
                    <p className="text-sm text-danger mb-3">{fetchError}</p>
                  )}

                  {loading ? (
                    <p className="text-xs text-muted-foreground italic">
                      Loading server logs…
                    </p>
                  ) : filteredLogs.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">
                      No server log entries found.
                    </p>
                  ) : (
                    <>
                      <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
                        <table className="w-full text-[11px] font-mono">
                          <thead>
                            <tr className="text-[9px] uppercase tracking-wider text-muted-foreground bg-surface/60">
                              {[
                                { key: "createdAt", label: "When", cls: "w-28" },
                                { key: "eventType", label: "Event", cls: "w-32" },
                                { key: "serverName", label: "Server", cls: "w-24" },
                                { key: "admin", label: "Admin", cls: "w-36" },
                                { key: "target", label: "Target", cls: "w-36" },
                              ].map(({ key, label, cls }) => (
                                <th
                                  key={key}
                                  className={`px-2 py-1.5 text-left font-medium ${cls} cursor-pointer select-none hover:text-foreground`}
                                  onClick={() => handleSort(key)}
                                >
                                  <span className="inline-flex items-center gap-1">
                                    {label}
                                    <SortIcon col={key} />
                                  </span>
                                </th>
                              ))}
                              <th className="px-2 py-1.5 text-left font-medium w-28">
                                Coords
                              </th>
                              <th className="px-2 py-1.5 text-left font-medium">
                                Detail
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleLogs.map((log) => {
                              const m = eventMeta(log.eventType);
                              return (
                                <tr
                                  key={log.id}
                                  className="border-t border-border"
                                >
                                  <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">
                                    {formatWhen(log.createdAt, tz)}
                                  </td>
                                  <td className="px-2 py-1">
                                    <span
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded ring-1 ring-border bg-surface text-[10px] uppercase"
                                      style={{ color: m.color }}
                                    >
                                      <span
                                        className="inline-block size-1.5 rounded-full"
                                        style={{ background: m.color }}
                                      />
                                      {m.label}
                                    </span>
                                  </td>
                                  <td
                                    className="px-2 py-1 text-muted-foreground truncate max-w-[6rem]"
                                    title={log.serverName}
                                  >
                                    {log.serverName}
                                  </td>
                                  <td
                                    className="px-2 py-1 text-muted-foreground truncate max-w-[9rem]"
                                    title={formatAdmin(log)}
                                  >
                                    {formatAdmin(log)}
                                  </td>
                                  <td
                                    className="px-2 py-1 text-muted-foreground truncate max-w-[9rem]"
                                    title={formatTarget(log)}
                                  >
                                    {formatTarget(log)}
                                  </td>
                                  <td
                                    className="px-2 py-1 text-muted-foreground/70 font-mono whitespace-nowrap text-[10px]"
                                    title={log.coordinates ?? ""}
                                  >
                                    {log.coordinates ?? "—"}
                                  </td>
                                  <td className="px-2 py-1 text-muted-foreground">
                                    {formatDetail(log)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {visibleCount < sortedLogs.length && (
                        <button
                          onClick={() =>
                            setVisibleCount((n) => n + PAGE_SIZE)
                          }
                          className="mt-3 flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground hover:text-foreground"
                        >
                          <ChevronDown className="size-3" />
                          Load more ({sortedLogs.length - visibleCount}{" "}
                          remaining)
                        </button>
                      )}

                      {total > logs.length && (
                        <p className="mt-2 text-[10px] text-muted-foreground font-mono">
                          Showing {logs.length} of {total} total entries
                        </p>
                      )}
                    </>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export { Route };

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Activity, ChevronDown } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { useTimezone } from "@/lib/timezone-store";

const Route = createFileRoute("/staff-audit")({
  head: () => ({ meta: [{ title: "Staff Audit Log — IronSight" }] }),
  validateSearch: (s) => ({
    staff: typeof s.staff === "string" ? s.staff : undefined,
    org: typeof s.org === "string" ? s.org : undefined,
    name: typeof s.name === "string" ? s.name : undefined,
  }),
  component: StaffAuditPage,
});

const ACTION_META = {
  ORG_MEMBER_ADDED: { label: "Member added", color: "hsl(160 70% 55%)" },
  ORG_MEMBER_REMOVED: { label: "Member removed", color: "hsl(0 75% 60%)" },
  ORG_ADMIN_GRANTED: { label: "Admin granted", color: "hsl(45 90% 60%)" },
  ORG_MEMBER_TEAM_CHANGED: { label: "Team changed", color: "hsl(30 80% 60%)" },
  ORG_MEMBER_VIEW_ACCESSED: {
    label: "Member viewed",
    color: "hsl(280 70% 65%)",
  },
  ROLE_CREATED: { label: "Role created", color: "hsl(210 80% 60%)" },
  ROLE_DELETED: { label: "Role deleted", color: "hsl(0 60% 55%)" },
  PTERODACTYL_API_KEY_SET: {
    label: "Ptero key set",
    color: "hsl(170 60% 50%)",
  },
  PTERODACTYL_API_KEY_REMOVED: {
    label: "Ptero key removed",
    color: "hsl(30 60% 50%)",
  },
  PLAYER_VIEWED: { label: "Player viewed", color: "hsl(200 70% 60%)" },
  BAN_CREATED: { label: "Ban created", color: "hsl(0 80% 55%)" },
  MUTE_CREATED: { label: "Mute created", color: "hsl(25 80% 55%)" },
  BAN_UPDATED: { label: "Ban updated", color: "hsl(15 70% 55%)" },
  MUTE_UPDATED: { label: "Mute updated", color: "hsl(35 70% 55%)" },
  BAN_REVOKED: { label: "Ban revoked", color: "hsl(160 65% 50%)" },
  MUTE_REVOKED: { label: "Mute revoked", color: "hsl(145 65% 50%)" },
  RCON_COMMAND: { label: "RCON command", color: "hsl(270 65% 60%)" },
};

function actionMeta(type) {
  return (
    ACTION_META[type] ?? {
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
    const dStr = new Date(log.createdAt * 1000).toLocaleDateString("en-CA", opts);
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

function formatDetail(log) {
  const m = log.metadata ?? {};
  switch (log.actionType) {
    case "ORG_MEMBER_ADDED":
      return [m.username, m.discordId ? `discord:${m.discordId}` : null]
        .filter(Boolean)
        .join(" · ");
    case "ORG_MEMBER_REMOVED":
    case "ORG_ADMIN_GRANTED":
    case "ORG_MEMBER_VIEW_ACCESSED":
      return m.username ?? "";
    case "ORG_MEMBER_TEAM_CHANGED":
      return [m.username, m.newTeam ? `→ ${m.newTeam}` : null]
        .filter(Boolean)
        .join(" ");
    case "ROLE_CREATED":
      return m.roleName ?? m.roleId ?? "";
    case "ROLE_DELETED":
      return m.roleId ?? "";
    case "PTERODACTYL_API_KEY_SET":
      return m.panelHost ?? "";
    case "PLAYER_VIEWED":
      return m.steamId ?? log.resourceId ?? "";
    case "BAN_CREATED":
    case "MUTE_CREATED": {
      const parts = [m.identifier];
      if (m.reason) parts.push(m.reason);
      if (m.expiresAt)
        parts.push(`exp ${new Date(m.expiresAt * 1000).toLocaleDateString()}`);
      return parts.filter(Boolean).join(" · ");
    }
    case "BAN_UPDATED":
    case "MUTE_UPDATED": {
      const changed = Object.keys(m.changes ?? {});
      return changed.length ? `changed: ${changed.join(", ")}` : "—";
    }
    case "BAN_REVOKED":
    case "MUTE_REVOKED":
      return m.identifier ?? log.resourceId ?? "";
    case "RCON_COMMAND":
      return [m.command, m.success === false ? "(failed)" : null]
        .filter(Boolean)
        .join(" ");
    default:
      return Object.entries(m)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ")
        .slice(0, 80);
  }
}

const PAGE_SIZE = 50;

function StaffAuditPage() {
  const { sessionOrgAdminIds } = useAuth();
  const tz = useTimezone();
  const search = Route.useSearch();
  const staffId = search.staff ?? "";
  const orgId = search.org ?? sessionOrgAdminIds[0] ?? "";
  const displayName = search.name ?? staffId.slice(0, 8) + "…";

  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    if (!staffId || !orgId) return;
    setLoading(true);
    setFetchError(null);
    setLogs([]);
    setTotal(0);
    setVisibleCount(PAGE_SIZE);

    fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/audit-logs?staffId=${encodeURIComponent(staffId)}&limit=500&offset=0`,
      { credentials: "include" },
    )
      .then((r) => r.json())
      .then((data) => {
        setLogs(data.logs ?? []);
        setTotal(data.total ?? 0);
      })
      .catch((err) => setFetchError(err.message))
      .finally(() => setLoading(false));
  }, [staffId, orgId]);

  const dailyBuckets = useMemo(() => buildDailyBuckets(logs, tz), [logs, tz]);

  const actionTypes = useMemo(() => {
    const counts = {};
    for (const l of logs)
      counts[l.actionType] = (counts[l.actionType] ?? 0) + 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
  }, [logs]);

  const filteredLogs = useMemo(
    () =>
      typeFilter === "all"
        ? logs
        : logs.filter((l) => l.actionType === typeFilter),
    [logs, typeFilter],
  );

  const visibleLogs = filteredLogs.slice(0, visibleCount);
  const isAdmin = sessionOrgAdminIds.includes(orgId);
  const totalInRange = logs.filter((l) => {
    const d = new Date(l.createdAt);
    const now = new Date();
    return now - d <= 30 * 86400000;
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
                className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <ArrowLeft className="size-3" /> Staff
              </Link>
              <span className="text-muted-foreground">/</span>
              <h1 className="text-lg font-semibold inline-flex items-center gap-2">
                <Activity className="size-4" />
                Audit log · {displayName}
              </h1>
            </div>

            {!isAdmin && (
              <p className="text-sm text-muted-foreground italic">
                You need org admin access to view audit logs.
              </p>
            )}

            {isAdmin && !staffId && (
              <p className="text-sm text-muted-foreground italic">
                Open this page from the Staff list.
              </p>
            )}

            {isAdmin && staffId && (
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
                    <span>Full audit log</span>
                    {!loading && (
                      <span className="font-mono normal-case tracking-normal text-muted-foreground">
                        {filteredLogs.length}
                        {typeFilter !== "all" && ` / ${logs.length}`}
                        {total > logs.length && ` of ${total}`}
                      </span>
                    )}
                  </h2>

                  <div className="flex flex-wrap gap-2 mb-3">
                    {[
                      ["all", "All"],
                      ...actionTypes.map((t) => [t, actionMeta(t).label]),
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

                  {fetchError && (
                    <p className="text-sm text-danger mb-3">{fetchError}</p>
                  )}

                  {loading ? (
                    <p className="text-xs text-muted-foreground italic">
                      Loading audit log…
                    </p>
                  ) : filteredLogs.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">
                      No audit log entries found.
                    </p>
                  ) : (
                    <>
                      <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
                        <table className="w-full text-[11px] font-mono">
                          <thead>
                            <tr className="text-[9px] uppercase tracking-wider text-muted-foreground bg-surface/60">
                              <th className="px-2 py-1.5 text-left font-medium w-28">
                                When
                              </th>
                              <th className="px-2 py-1.5 text-left font-medium w-36">
                                Action
                              </th>
                              <th className="px-2 py-1.5 text-left font-medium w-32">
                                Resource
                              </th>
                              <th className="px-2 py-1.5 text-left font-medium">
                                Detail
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleLogs.map((log) => {
                              const m = actionMeta(log.actionType);
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
                                  <td className="px-2 py-1 text-muted-foreground">
                                    {log.resourceType ?? "—"}
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

                      {visibleCount < filteredLogs.length && (
                        <button
                          onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                          className="mt-3 flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground hover:text-foreground"
                        >
                          <ChevronDown className="size-3" />
                          Load more ({filteredLogs.length - visibleCount}{" "}
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

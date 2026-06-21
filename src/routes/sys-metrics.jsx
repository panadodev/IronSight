import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/sys-metrics")({
  head: () => ({ meta: [{ title: "API Metrics — IronSight Sysadmin" }] }),
  component: SysMetricsPage,
});

function fmtAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusColor(s) {
  if (!s) return "text-muted-foreground";
  if (s >= 500) return "text-danger";
  if (s >= 400) return "text-warning";
  if (s >= 300) return "text-brand";
  if (s >= 200) return "text-success";
  return "text-muted-foreground";
}

function StatusBadge({ status }) {
  const cls = statusColor(status);
  return (
    <span className={`font-mono tabular-nums ${cls}`}>
      {status === 0 ? "ERR" : status}
    </span>
  );
}

function MethodBadge({ method }) {
  const colors = {
    GET: "text-sky-400",
    POST: "text-emerald-400",
    PUT: "text-amber-400",
    PATCH: "text-amber-400",
    DELETE: "text-red-400",
  };
  return (
    <span className={`font-mono text-[10px] uppercase ${colors[method] ?? "text-muted-foreground"}`}>
      {method}
    </span>
  );
}

function DirectionBadge({ direction }) {
  return direction === "incoming" ? (
    <span className="inline-flex items-center gap-0.5 text-[9px] font-mono uppercase tracking-widest text-sky-400">
      <ArrowDown className="size-2.5" /> in
    </span>
  ) : (
    <span className="inline-flex items-center gap-0.5 text-[9px] font-mono uppercase tracking-widest text-amber-400">
      <ArrowUp className="size-2.5" /> out
    </span>
  );
}

function LatencyBar({ value, max }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color =
    value > 2000 ? "bg-danger/60" : value > 500 ? "bg-warning/60" : "bg-success/50";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full bg-border overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono tabular-nums text-[10px] text-muted-foreground w-12 text-right">
        {value}ms
      </span>
    </div>
  );
}

const TABS = ["overview", "latency", "errors"];

function SysMetricsPage() {
  const { sessionUser } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("overview");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [incomingFilter, setIncomingFilter] = useState("all");
  const [errorDirection, setErrorDirection] = useState("all");
  const intervalRef = useRef(null);

  useEffect(() => {
    if (sessionUser && !sessionUser.isSysAdmin) {
      navigate({ to: "/" });
    }
  }, [sessionUser, navigate]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sys/metrics", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(await res.json());
      setLastRefreshed(Date.now());
      setError("");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(load, 10000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, load]);

  if (!sessionUser) return null;
  if (!sessionUser.isSysAdmin) return null;

  const incoming = data?.incoming ?? [];
  const outgoing = data?.outgoing ?? [];
  const errors = data?.errors ?? [];
  const routes = data?.routes ?? [];

  // Overview stats
  const totalIn = incoming.length;
  const totalOut = outgoing.length;
  const errorsIn = errors.filter((e) => e.direction === "incoming").length;
  const errorsOut = errors.filter((e) => e.direction === "outgoing").length;
  const avgLatency = totalIn
    ? Math.round(incoming.reduce((s, e) => s + e.ms, 0) / totalIn)
    : 0;
  const p95Latency = (() => {
    if (!incoming.length) return 0;
    const sorted = [...incoming].map((e) => e.ms).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  })();
  const ingestCount = incoming.filter((e) => e.isIngest).length;
  const maxRouteCount = routes[0]?.count ?? 1;

  // Filtered incoming log
  const filteredIncoming = incomingFilter === "all"
    ? incoming
    : incomingFilter === "ingest"
      ? incoming.filter((e) => e.isIngest)
      : incoming.filter((e) => !e.isIngest);

  // Filtered errors
  const filteredErrors = errorDirection === "all"
    ? errors
    : errors.filter((e) => e.direction === errorDirection);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SiteNav />
      <div className="flex-1 flex flex-col max-w-[1400px] mx-auto w-full px-4 py-6 gap-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-widest text-danger mb-1">
              Sysadmin Only
            </p>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Activity className="size-5 text-brand" />
              API Diagnostics
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              In-memory ring buffer — resets on server restart · max 1 000 entries each
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {lastRefreshed && (
              <span className="text-[10px] font-mono text-muted-foreground">
                updated {fmtAgo(lastRefreshed)}
              </span>
            )}
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className={`text-[10px] font-mono px-2 py-1 rounded ring-1 transition-colors ${
                autoRefresh
                  ? "ring-brand/40 bg-brand/10 text-brand"
                  : "ring-border bg-surface text-muted-foreground"
              }`}
            >
              {autoRefresh ? "auto 10s" : "paused"}
            </button>
            <button
              onClick={load}
              className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded ring-1 ring-border bg-surface hover:bg-surface-bright transition-colors"
            >
              <RefreshCw className="size-3" />
              refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-0.5 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
              {t === "errors" && errors.length > 0 && (
                <span className="ml-1.5 inline-block px-1 py-0.5 text-[9px] font-mono rounded bg-danger/20 text-danger">
                  {errors.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex-1 grid place-items-center">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        ) : (
          <>
            {/* ── OVERVIEW ── */}
            {tab === "overview" && (
              <div className="space-y-6">
                {/* Summary cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: "Incoming (buffered)", value: totalIn, sub: `${ingestCount} ingest` },
                    { label: "Outgoing (buffered)", value: totalOut, sub: "external calls" },
                    { label: "Incoming errors", value: errorsIn, danger: errorsIn > 0 },
                    { label: "Outgoing errors", value: errorsOut, danger: errorsOut > 0 },
                  ].map((c) => (
                    <div key={c.label} className="rounded-lg ring-1 ring-border bg-surface/40 p-3">
                      <p className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                        {c.label}
                      </p>
                      <p className={`text-2xl font-semibold tabular-nums mt-1 ${c.danger ? "text-danger" : ""}`}>
                        {c.value}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{c.sub}</p>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Avg latency (incoming)", value: `${avgLatency}ms` },
                    { label: "p95 latency (incoming)", value: `${p95Latency}ms` },
                  ].map((c) => (
                    <div key={c.label} className="rounded-lg ring-1 ring-border bg-surface/40 p-3">
                      <p className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                        {c.label}
                      </p>
                      <p className="text-2xl font-semibold tabular-nums mt-1 font-mono">{c.value}</p>
                    </div>
                  ))}
                </div>

                {/* Top routes */}
                <div className="space-y-2">
                  <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Top routes by volume
                  </h2>
                  <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
                    <div className="grid grid-cols-[3fr_60px_70px_70px_70px_60px] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                      <div>Route</div>
                      <div className="text-right">Hits</div>
                      <div className="text-right">Avg</div>
                      <div className="text-right">p50</div>
                      <div className="text-right">p95</div>
                      <div className="text-right">Errors</div>
                    </div>
                    {routes.slice(0, 20).map((r) => (
                      <div
                        key={`${r.method}${r.route}`}
                        className="grid grid-cols-[3fr_60px_70px_70px_70px_60px] gap-2 px-3 py-1.5 border-b border-border last:border-0 text-[11px] items-center"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <MethodBadge method={r.method} />
                          <span className="font-mono text-[10px] truncate text-muted-foreground/80">
                            {r.route}
                          </span>
                          <div
                            className="h-1.5 rounded-full bg-brand/30 shrink-0"
                            style={{ width: `${Math.round((r.count / maxRouteCount) * 64)}px`, minWidth: "2px" }}
                          />
                        </div>
                        <div className="text-right font-mono tabular-nums">{r.count}</div>
                        <div className="text-right font-mono tabular-nums text-muted-foreground">{r.avg}ms</div>
                        <div className="text-right font-mono tabular-nums text-muted-foreground">{r.p50}ms</div>
                        <div className="text-right font-mono tabular-nums text-muted-foreground">{r.p95}ms</div>
                        <div className={`text-right font-mono tabular-nums ${r.errors > 0 ? "text-danger" : "text-muted-foreground"}`}>
                          {r.errors}
                        </div>
                      </div>
                    ))}
                    {routes.length === 0 && (
                      <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                        No requests recorded yet.
                      </div>
                    )}
                  </div>
                </div>

                {/* Recent outgoing */}
                <div className="space-y-2">
                  <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Recent outgoing calls
                  </h2>
                  <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
                    <div className="grid grid-cols-[80px_1fr_60px_80px_100px] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                      <div>Service</div>
                      <div>Host</div>
                      <div className="text-right">Status</div>
                      <div className="text-right">Latency</div>
                      <div className="text-right">Time</div>
                    </div>
                    {outgoing.slice(0, 15).map((e, i) => (
                      <div key={i} className="grid grid-cols-[80px_1fr_60px_80px_100px] gap-2 px-3 py-1 border-b border-border last:border-0 text-[11px] items-center">
                        <div className="font-mono text-[10px] text-muted-foreground truncate">{e.service}</div>
                        <div className="font-mono text-[10px] truncate text-foreground/70">{e.host}</div>
                        <div className="text-right"><StatusBadge status={e.status} /></div>
                        <div className="text-right font-mono text-[10px] text-muted-foreground">{e.ms}ms</div>
                        <div className="text-right font-mono text-[10px] text-muted-foreground">{fmtTime(e.ts)}</div>
                      </div>
                    ))}
                    {outgoing.length === 0 && (
                      <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                        No outgoing calls recorded yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── LATENCY ── */}
            {tab === "latency" && (
              <div className="space-y-6">
                {/* Route aggregate table */}
                <div className="space-y-2">
                  <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Route aggregates — incoming
                  </h2>
                  <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
                    <div className="grid grid-cols-[3fr_60px_1fr_1fr_1fr_60px] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                      <div>Route</div>
                      <div className="text-right">Hits</div>
                      <div className="text-right">Avg</div>
                      <div className="text-right">p50</div>
                      <div className="text-right">p95</div>
                      <div className="text-right">Errors</div>
                    </div>
                    {routes.map((r) => (
                      <div
                        key={`${r.method}${r.route}`}
                        className="grid grid-cols-[3fr_60px_1fr_1fr_1fr_60px] gap-2 px-3 py-2 border-b border-border last:border-0 text-[11px] items-center"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <MethodBadge method={r.method} />
                          <span className="font-mono text-[10px] truncate text-foreground/80">{r.route}</span>
                        </div>
                        <div className="text-right font-mono tabular-nums">{r.count}</div>
                        <div className="text-right">
                          <LatencyBar value={r.avg} max={Math.max(...routes.map((x) => x.p95), 1)} />
                        </div>
                        <div className="text-right">
                          <LatencyBar value={r.p50} max={Math.max(...routes.map((x) => x.p95), 1)} />
                        </div>
                        <div className="text-right">
                          <LatencyBar value={r.p95} max={Math.max(...routes.map((x) => x.p95), 1)} />
                        </div>
                        <div className={`text-right font-mono tabular-nums ${r.errors > 0 ? "text-danger" : "text-muted-foreground"}`}>
                          {r.errors}
                        </div>
                      </div>
                    ))}
                    {routes.length === 0 && (
                      <div className="px-3 py-4 text-xs text-muted-foreground text-center">No data yet.</div>
                    )}
                  </div>
                </div>

                {/* Recent incoming log */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      Recent incoming requests
                    </h2>
                    <div className="flex gap-1">
                      {[["all", "All"], ["panel", "Panel"], ["ingest", "Ingest"]].map(([v, l]) => (
                        <button
                          key={v}
                          onClick={() => setIncomingFilter(v)}
                          className={`text-[10px] font-mono px-2 py-0.5 rounded ring-1 transition-colors ${
                            incomingFilter === v
                              ? "ring-brand/50 bg-brand/10 text-brand"
                              : "ring-border bg-transparent text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
                    <div className="grid grid-cols-[50px_3fr_60px_90px_100px] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                      <div>Method</div>
                      <div>Route</div>
                      <div className="text-right">Status</div>
                      <div className="text-right">Latency</div>
                      <div className="text-right">Time</div>
                    </div>
                    <div className="max-h-[480px] overflow-y-auto">
                      {filteredIncoming.slice(0, 200).map((e, i) => (
                        <div
                          key={i}
                          className={`grid grid-cols-[50px_3fr_60px_90px_100px] gap-2 px-3 py-1 border-b border-border last:border-0 text-[11px] items-center ${
                            e.isIngest ? "bg-surface/20" : ""
                          }`}
                        >
                          <div><MethodBadge method={e.method} /></div>
                          <div className="font-mono text-[10px] truncate text-foreground/80">
                            {e.route}
                            {e.isIngest && (
                              <span className="ml-1.5 text-[8px] font-mono text-amber-400/70 uppercase tracking-widest">ingest</span>
                            )}
                          </div>
                          <div className="text-right"><StatusBadge status={e.status} /></div>
                          <div className="text-right font-mono tabular-nums text-[10px]">
                            <span className={e.ms > 2000 ? "text-danger" : e.ms > 500 ? "text-warning" : "text-muted-foreground"}>
                              {e.ms}ms
                            </span>
                          </div>
                          <div className="text-right font-mono text-[10px] text-muted-foreground">{fmtTime(e.ts)}</div>
                        </div>
                      ))}
                      {filteredIncoming.length === 0 && (
                        <div className="px-3 py-4 text-xs text-muted-foreground text-center">No requests yet.</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── ERRORS ── */}
            {tab === "errors" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Non-2xx responses
                  </h2>
                  <div className="flex gap-1">
                    {[["all", "All"], ["incoming", "Incoming"], ["outgoing", "Outgoing"]].map(([v, l]) => (
                      <button
                        key={v}
                        onClick={() => setErrorDirection(v)}
                        className={`text-[10px] font-mono px-2 py-0.5 rounded ring-1 transition-colors ${
                          errorDirection === v
                            ? "ring-brand/50 bg-brand/10 text-brand"
                            : "ring-border bg-transparent text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
                  <div className="grid grid-cols-[60px_60px_3fr_70px_90px_120px] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                    <div>Dir</div>
                    <div>Method</div>
                    <div>Route / Host</div>
                    <div className="text-right">Status</div>
                    <div className="text-right">Latency</div>
                    <div className="text-right">Time</div>
                  </div>
                  <div className="max-h-[600px] overflow-y-auto">
                    {filteredErrors.map((e, i) => {
                      const isIn = e.direction === "incoming";
                      return (
                        <div
                          key={i}
                          className="grid grid-cols-[60px_60px_3fr_70px_90px_120px] gap-2 px-3 py-1.5 border-b border-border last:border-0 text-[11px] items-center"
                        >
                          <div><DirectionBadge direction={e.direction} /></div>
                          <div>
                            {isIn ? (
                              <MethodBadge method={e.method} />
                            ) : (
                              <span className="text-[10px] font-mono text-muted-foreground">{e.service}</span>
                            )}
                          </div>
                          <div className="font-mono text-[10px] truncate text-foreground/80">
                            {isIn ? e.route : e.host}
                            {isIn && e.isIngest && (
                              <span className="ml-1.5 text-[8px] font-mono text-amber-400/70 uppercase tracking-widest">ingest</span>
                            )}
                          </div>
                          <div className="text-right"><StatusBadge status={e.status} /></div>
                          <div className="text-right font-mono tabular-nums text-[10px] text-muted-foreground">
                            {e.ms}ms
                          </div>
                          <div className="text-right font-mono text-[10px] text-muted-foreground">
                            {fmtTime(e.ts)}
                          </div>
                        </div>
                      );
                    })}
                    {filteredErrors.length === 0 && (
                      <div className="px-3 py-8 text-sm text-muted-foreground text-center">
                        No non-2xx responses recorded.
                        <p className="text-[10px] mt-1 text-muted-foreground/70">
                          This buffer resets on server restart.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Error breakdown by status */}
                {filteredErrors.length > 0 && (
                  <div className="space-y-2">
                    <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      Breakdown by status code
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(
                        filteredErrors.reduce((acc, e) => {
                          const k = e.status === 0 ? "ERR" : String(e.status);
                          acc[k] = (acc[k] ?? 0) + 1;
                          return acc;
                        }, {}),
                      )
                        .sort((a, b) => b[1] - a[1])
                        .map(([code, count]) => (
                          <div
                            key={code}
                            className="rounded ring-1 ring-border bg-surface/60 px-3 py-2 text-center"
                          >
                            <p className={`text-lg font-mono font-semibold tabular-nums ${statusColor(Number(code) || 0)}`}>
                              {code}
                            </p>
                            <p className="text-[10px] text-muted-foreground">{count}×</p>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

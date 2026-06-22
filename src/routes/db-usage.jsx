import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Database,
  HardDrive,
  RefreshCw,
  Rows3,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/db-usage")({
  head: () => ({ meta: [{ title: "Database Usage — IronSight Sysadmin" }] }),
  component: DbUsagePage,
});

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtNum(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat().format(Math.round(n));
}

function fmtAgo(unix) {
  if (!unix) return "never";
  const sec = Math.floor(Date.now() / 1000 - unix);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const SORTS = {
  size: (a, b) => b.totalBytes - a.totalBytes,
  rows: (a, b) => b.rowEstimate - a.rowEstimate,
  name: (a, b) => a.name.localeCompare(b.name),
};

function StatCard({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-lg ring-1 ring-border bg-surface/40 p-3">
      <p className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
        {Icon && <Icon className="size-3" />}
        {label}
      </p>
      <p className="text-2xl font-semibold tabular-nums mt-1 font-mono">
        {value}
      </p>
      {sub != null && (
        <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
      )}
    </div>
  );
}

function DbUsagePage() {
  const { sessionUser } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [sort, setSort] = useState("size");
  const [filter, setFilter] = useState("");
  const intervalRef = useRef(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  useEffect(() => {
    if (sessionUser && !sessionUser.isSysAdmin) {
      navigate({ to: "/" });
    }
  }, [sessionUser, navigate]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sys/db-usage", { credentials: "include" });
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
      intervalRef.current = setInterval(load, 15000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, load]);

  const tables = data?.tables ?? [];
  const totalRows = useMemo(
    () => tables.reduce((s, t) => s + t.rowEstimate, 0),
    [tables],
  );
  const totalIndexBytes = useMemo(
    () => tables.reduce((s, t) => s + t.indexBytes, 0),
    [tables],
  );
  const maxTotal = useMemo(
    () => Math.max(...tables.map((t) => t.totalBytes), 1),
    [tables],
  );

  const visibleTables = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? tables.filter((t) => t.name.toLowerCase().includes(q))
      : tables;
    return [...list].sort(SORTS[sort]);
  }, [tables, filter, sort]);

  if (!sessionUser) return null;
  if (!sessionUser.isSysAdmin) return null;

  const db = data?.database;
  const pool = data?.pool;
  const redis = data?.redis;

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
              <Database className="size-5 text-brand" />
              Database Usage
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Storage and row estimates per table · counts are planner estimates
              {db?.name ? ` · ${db.name}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {lastRefreshed && (
              <span className="text-[10px] font-mono text-muted-foreground">
                updated {Math.floor((Date.now() - lastRefreshed) / 1000)}s ago
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
              {autoRefresh ? "auto 15s" : "paused"}
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

        {loading ? (
          <div className="flex-1 grid place-items-center">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard
                icon={HardDrive}
                label="Database size"
                value={fmtBytes(db?.totalBytes ?? 0)}
                sub={`${db?.tableCount ?? tables.length} tables`}
              />
              <StatCard
                icon={Rows3}
                label="Est. total rows"
                value={fmtNum(totalRows)}
                sub="across all tables"
              />
              <StatCard
                icon={Database}
                label="Index size"
                value={fmtBytes(totalIndexBytes)}
                sub="sum of all indexes"
              />
              <StatCard
                icon={Server}
                label="Redis memory"
                value={
                  redis?.available
                    ? (redis.usedMemoryHuman ?? fmtBytes(redis.usedMemory))
                    : "—"
                }
                sub={
                  redis?.available
                    ? `${fmtNum(redis.keys)} keys`
                    : "unavailable"
                }
              />
            </div>

            {/* Connection pool */}
            {pool && (
              <div className="rounded-md ring-1 ring-border bg-surface/40 px-4 py-2.5 flex flex-wrap items-center gap-x-8 gap-y-1">
                <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                  PG Pool
                </span>
                {[
                  ["max", pool.max],
                  ["total", pool.total],
                  ["idle", pool.idle],
                  ["waiting", pool.waiting],
                ].map(([k, v]) => (
                  <span key={k} className="text-xs font-mono">
                    <span className="text-muted-foreground">{k}: </span>
                    <span
                      className={`tabular-nums ${
                        k === "waiting" && v > 0
                          ? "text-warning"
                          : "text-foreground"
                      }`}
                    >
                      {v ?? "—"}
                    </span>
                  </span>
                ))}
              </div>
            )}

            {/* Table list */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Tables ({visibleTables.length})
                </h2>
                <div className="flex items-center gap-2">
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter tables…"
                    className="h-7 px-2 text-xs bg-background ring-1 ring-border rounded-md w-40"
                  />
                  <div className="flex gap-1">
                    {[
                      ["size", "Size"],
                      ["rows", "Rows"],
                      ["name", "Name"],
                    ].map(([v, l]) => (
                      <button
                        key={v}
                        onClick={() => setSort(v)}
                        className={`text-[10px] font-mono px-2 py-0.5 rounded ring-1 transition-colors ${
                          sort === v
                            ? "ring-brand/50 bg-brand/10 text-brand"
                            : "ring-border bg-transparent text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
                <div className="grid grid-cols-[2fr_90px_1.6fr_90px_90px_90px] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                  <div>Table</div>
                  <div className="text-right">Rows</div>
                  <div>Size (table / index)</div>
                  <div className="text-right">Total</div>
                  <div className="text-right">Dead</div>
                  <div className="text-right">Vacuumed</div>
                </div>
                {visibleTables.map((t) => {
                  const tablePct = (t.tableBytes / maxTotal) * 100;
                  const indexPct = (t.indexBytes / maxTotal) * 100;
                  return (
                    <div
                      key={t.name}
                      className="grid grid-cols-[2fr_90px_1.6fr_90px_90px_90px] gap-2 px-3 py-2 border-b border-border last:border-0 text-[11px] items-center"
                    >
                      <div className="font-mono text-[11px] truncate text-foreground/90">
                        {t.name}
                      </div>
                      <div className="text-right font-mono tabular-nums text-muted-foreground">
                        {fmtNum(t.rowEstimate)}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 rounded-full bg-border/60 overflow-hidden flex">
                          <div
                            className="h-full bg-brand/60"
                            style={{ width: `${tablePct}%` }}
                            title={`Table data: ${fmtBytes(t.tableBytes)}`}
                          />
                          <div
                            className="h-full bg-amber-400/60"
                            style={{ width: `${indexPct}%` }}
                            title={`Indexes: ${fmtBytes(t.indexBytes)}`}
                          />
                        </div>
                        <span className="font-mono text-[9px] text-muted-foreground tabular-nums w-20 text-right shrink-0">
                          {fmtBytes(t.tableBytes)} / {fmtBytes(t.indexBytes)}
                        </span>
                      </div>
                      <div className="text-right font-mono tabular-nums font-semibold">
                        {fmtBytes(t.totalBytes)}
                      </div>
                      <div
                        className={`text-right font-mono tabular-nums ${
                          t.deadTuples > 1000
                            ? "text-warning"
                            : "text-muted-foreground"
                        }`}
                      >
                        {fmtNum(t.deadTuples)}
                      </div>
                      <div className="text-right font-mono text-[10px] text-muted-foreground">
                        {fmtAgo(t.lastVacuumUnix)}
                      </div>
                    </div>
                  );
                })}
                {visibleTables.length === 0 && (
                  <div className="px-3 py-6 text-xs text-muted-foreground text-center">
                    {tables.length === 0
                      ? "No tables reported."
                      : "No tables match this filter."}
                  </div>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/70 flex items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-brand/60" /> table data
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-amber-400/60" /> indexes
                </span>
                <span>· bars scaled to the largest table</span>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

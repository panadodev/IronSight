import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Check,
  Copy,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/sys-relays")({
  head: () => ({ meta: [{ title: "API Relays — IronSight Sysadmin" }] }),
  component: SysRelaysPage,
});

function fmtAgo(unix) {
  if (!unix) return "never";
  const sec = Math.floor(Date.now() / 1000 - unix);
  if (sec < 0) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function StatusBadge({ relay }) {
  const cooling =
    relay.rateLimitedUntil && relay.rateLimitedUntil > Date.now() / 1000;
  if (!relay.enabled)
    return (
      <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        disabled
      </span>
    );
  if (cooling)
    return (
      <span className="text-[10px] font-mono uppercase tracking-widest text-warning">
        cooling
      </span>
    );
  if (relay.online)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-success">
        <span className="size-1.5 rounded-full bg-success" /> online
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-danger">
      <span className="size-1.5 rounded-full bg-danger" /> offline
    </span>
  );
}

function KeyReveal({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="rounded-md ring-1 ring-warning/40 bg-warning/10 p-3 space-y-2">
      <p className="text-xs text-warning font-medium">
        Copy this now — it is shown only once.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-[11px] font-mono break-all bg-background/60 rounded px-2 py-1.5 ring-1 ring-border">
          {value}
        </code>
        <button
          onClick={copy}
          className="shrink-0 flex items-center gap-1 text-[11px] font-mono px-2 py-1.5 rounded ring-1 ring-border bg-surface hover:bg-surface-bright"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Set this as <code className="font-mono">API_ENCRYPTION_KEY</code> on the
        relay container, then run a health check — it will come online.
      </p>
    </div>
  );
}

function SysRelaysPage() {
  const { sessionUser } = useAuth();
  const navigate = useNavigate();
  const [relays, setRelays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [addError, setAddError] = useState("");
  const [revealedKey, setRevealedKey] = useState("");
  const intervalRef = useRef(null);

  useEffect(() => {
    if (sessionUser && !sessionUser.isSysAdmin) navigate({ to: "/" });
  }, [sessionUser, navigate]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sys/relays", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setRelays(data.relays ?? []);
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
    if (autoRefresh) intervalRef.current = setInterval(load, 10000);
    else clearInterval(intervalRef.current);
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, load]);

  const createRelay = async () => {
    setAddError("");
    try {
      const res = await fetch("/api/sys/relays", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: newLabel, baseUrl: newUrl }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setAddError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setRevealedKey(body.apiEncryptionKey);
      setAddOpen(false);
      setNewLabel("");
      setNewUrl("");
      load();
    } catch {
      setAddError("Network error");
    }
  };

  const relayAction = async (id, action) => {
    setBusyId(id);
    try {
      let res;
      if (action === "health")
        res = await fetch(`/api/sys/relays/${id}/health`, {
          method: "POST",
          credentials: "include",
        });
      else if (action === "rotate")
        res = await fetch(`/api/sys/relays/${id}/rotate-key`, {
          method: "POST",
          credentials: "include",
        });
      else if (action === "delete")
        res = await fetch(`/api/sys/relays/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
      else
        res = await fetch(`/api/sys/relays/${id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(action),
        });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      if (body?.apiEncryptionKey) setRevealedKey(body.apiEncryptionKey);
      await load();
    } catch {
      setError("Network error");
    } finally {
      setBusyId(null);
    }
  };

  if (!sessionUser) return null;
  if (!sessionUser.isSysAdmin) return null;

  const onlineCount = relays.filter((r) => r.online && r.enabled).length;
  const totalRequests = relays.reduce(
    (s, r) => s + (r.stats?.requests ?? 0),
    0,
  );
  const totalErrors = relays.reduce((s, r) => s + (r.stats?.errors ?? 0), 0);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SiteNav />
      <div className="flex-1 flex flex-col max-w-[1400px] mx-auto w-full px-4 py-6 gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-widest text-danger mb-1">
              Sysadmin Only
            </p>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Server className="size-5 text-brand" />
              BattleMetrics API Relays
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Encrypted IP-diversity proxies for BattleMetrics. Requests fall
              back to a direct call when no relay is available.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
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
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" /> Add relay
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {revealedKey && (
          <div className="space-y-1">
            <p className="text-xs font-medium">New relay key</p>
            <KeyReveal value={revealedKey} />
            <button
              onClick={() => setRevealedKey("")}
              className="text-[11px] font-mono text-muted-foreground hover:text-foreground"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Overview */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Relays" value={relays.length} />
          <Stat label="Online" value={onlineCount} accent="text-success" />
          <Stat label="Requests (24h)" value={totalRequests.toLocaleString()} />
          <Stat
            label="Errors (24h)"
            value={totalErrors.toLocaleString()}
            accent={totalErrors ? "text-danger" : undefined}
          />
        </div>

        {/* Relay table */}
        <div className="rounded-lg ring-1 ring-border bg-surface overflow-hidden">
          <div className="grid grid-cols-[1.5fr_1fr_repeat(4,0.7fr)_auto] gap-2 px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground border-b border-border">
            <div>Relay</div>
            <div>Status</div>
            <div>Latency</div>
            <div>Last used</div>
            <div>Req 24h</div>
            <div>Err / RL</div>
            <div className="text-right">Actions</div>
          </div>
          {loading && !relays.length ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : !relays.length ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No relays configured. Add one to route BattleMetrics traffic
              through it.
            </div>
          ) : (
            relays.map((r) => (
              <div
                key={r.relayId}
                className="grid grid-cols-[1.5fr_1fr_repeat(4,0.7fr)_auto] gap-2 px-4 py-3 items-center border-b border-border/50 last:border-0 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {r.label || "Untitled relay"}
                  </div>
                  <div className="text-[11px] font-mono text-muted-foreground truncate">
                    {r.baseUrl}
                  </div>
                </div>
                <div>
                  <StatusBadge relay={r} />
                </div>
                <div className="font-mono tabular-nums text-xs">
                  {r.lastLatencyMs != null ? `${r.lastLatencyMs}ms` : "—"}
                </div>
                <div className="font-mono tabular-nums text-xs text-muted-foreground">
                  {fmtAgo(r.lastUsedAt)}
                </div>
                <div className="font-mono tabular-nums text-xs">
                  {(r.stats?.requests ?? 0).toLocaleString()}
                  {r.stats?.avgLatencyMs != null && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {r.stats.avgLatencyMs}ms
                    </span>
                  )}
                </div>
                <div className="font-mono tabular-nums text-xs">
                  <span className={r.stats?.errors ? "text-danger" : ""}>
                    {r.stats?.errors ?? 0}
                  </span>
                  {" / "}
                  <span className={r.stats?.rateLimited ? "text-warning" : ""}>
                    {r.stats?.rateLimited ?? 0}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-1">
                  <IconBtn
                    title="Health check"
                    disabled={busyId === r.relayId}
                    onClick={() => relayAction(r.relayId, "health")}
                  >
                    <Activity className="size-3.5" />
                  </IconBtn>
                  <button
                    disabled={busyId === r.relayId}
                    onClick={() =>
                      relayAction(r.relayId, { enabled: !r.enabled })
                    }
                    className="text-[10px] font-mono px-2 py-1 rounded ring-1 ring-border bg-surface hover:bg-surface-bright disabled:opacity-50"
                  >
                    {r.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    disabled={busyId === r.relayId}
                    onClick={() => {
                      if (
                        confirm(
                          "Rotate this relay's key? The current key stops working until you update the container.",
                        )
                      )
                        relayAction(r.relayId, "rotate");
                    }}
                    className="text-[10px] font-mono px-2 py-1 rounded ring-1 ring-border bg-surface hover:bg-surface-bright disabled:opacity-50"
                  >
                    rotate key
                  </button>
                  <IconBtn
                    title="Delete relay"
                    disabled={busyId === r.relayId}
                    onClick={() => {
                      if (confirm(`Delete relay "${r.label || r.baseUrl}"?`))
                        relayAction(r.relayId, "delete");
                    }}
                  >
                    <Trash2 className="size-3.5 text-danger" />
                  </IconBtn>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add relay</DialogTitle>
            <DialogDescription>
              A fresh API_ENCRYPTION_KEY is generated and shown once. Set it on
              the relay container, then run a health check.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="relay-label">Label</Label>
              <Input
                id="relay-label"
                placeholder="e.g. relay-eu-1"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="relay-url">Base URL</Label>
              <Input
                id="relay-url"
                placeholder="https://relay1.example.com"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
              />
            </div>
            {addError && <p className="text-sm text-danger">{addError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createRelay} disabled={!newUrl.trim()}>
              Create relay
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-lg ring-1 ring-border bg-surface px-4 py-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`text-lg font-semibold tabular-nums ${accent ?? ""}`}>
        {value}
      </div>
    </div>
  );
}

function IconBtn({ children, title, onClick, disabled }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="p-1.5 rounded ring-1 ring-border bg-surface hover:bg-surface-bright disabled:opacity-50"
    >
      {children}
    </button>
  );
}

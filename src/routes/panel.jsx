import { SteamRequiredGate } from "@/components/steam-required-gate";
import { SiteNav } from "@/components/site-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { usePteroPlugins } from "@/lib/use-ptero-plugins";
import { useTimezone } from "@/lib/timezone-store";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Bell,
  BellOff,
  Building2,
  Check,
  ChevronDown,
  CircleDot,
  Cpu,
  ExternalLink,
  HardDrive,
  Key,
  Layers,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  Target,
  Terminal,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import {
  COUNTRY_CENTROIDS,
  WORLD_LAND_PATH,
  WORLD_MAP_HEIGHT,
  WORLD_MAP_WIDTH,
  projectLatLng,
} from "@/lib/world-map";
const PANEL_TABS = ["rcon", "scripts", "presets", "status", "servers"];
const Route = createFileRoute("/panel")({
  component: PanelPage,
  validateSearch: (search) => {
    const t = search.tab;
    return {
      tab: typeof t === "string" && PANEL_TABS.includes(t) ? t : void 0,
    };
  },
});
const RANK_OPTIONS = [
  { value: 1, label: "Support" },
  { value: 2, label: "Admin" },
  { value: 3, label: "Sr. Admin" },
  { value: 4, label: "Management" },
];
const rankLabel = (r) =>
  RANK_OPTIONS.find((x) => x.value === r)?.label ?? `Rank ${r}`;
function extractVars(cmd) {
  const matches = cmd.match(/\{([a-zA-Z0-9_]+)\}/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.slice(1, -1))));
}
function applyVars(cmd, values) {
  return cmd.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => values[k] ?? `{${k}}`);
}
function PingBadge({ lastHealthPing, className = "" }) {
  const tz = useTimezone();
  if (!lastHealthPing) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-[9px] font-mono px-1 py-0.5 rounded ring-1 bg-muted/20 text-muted-foreground ring-border ${className}`}
        title="Plugin has never pinged"
      >
        <Activity className="size-2.5" /> never
      </span>
    );
  }
  const ageSec = Math.floor(Date.now() / 1000 - lastHealthPing);
  let label, cls;
  if (ageSec < 90) {
    label = `${ageSec}s ago`;
    cls = "bg-success/10 text-success ring-success/30";
  } else if (ageSec < 300) {
    const m = Math.floor(ageSec / 60);
    label = `${m}m ago`;
    cls = "bg-warning/10 text-warning ring-warning/30";
  } else {
    const m = Math.floor(ageSec / 60);
    label = m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
    cls = "bg-destructive/10 text-destructive ring-destructive/30";
  }
  return (
    <span
      className={`inline-flex items-center gap-1 text-[9px] font-mono px-1 py-0.5 rounded ring-1 ${cls} ${className}`}
      title={`Last plugin ping: ${new Date(lastHealthPing * 1000).toLocaleString(undefined, tz ? { timeZone: tz } : {})}`}
    >
      <Activity className="size-2.5" /> {label}
    </span>
  );
}

const PANEL_ORG_KEY = "panel.selectedOrgId";
const TAB_PERMISSION = {
  rcon: "rcon_access",
  scripts: "scripts_view",
  presets: "presets_manage",
  status: "status_view",
  servers: "servers_manage",
};

// manage implies view for these tabs
const TAB_ALT_PERMISSION = {
  scripts: "scripts_manage",
};

function PanelPage() {
  const { orgs, hasOrgPermission } = useAuth();
  const tz = useTimezone();
  const search = Route.useSearch();
  const tab = search.tab ?? "rcon";
  const tabPerm = TAB_PERMISSION[tab];
  const tabAltPerm = TAB_ALT_PERMISSION[tab] ?? null;
  const allowedOrgIds = useMemo(
    () =>
      orgs
        .filter(
          (o) =>
            hasOrgPermission(o.id, tabPerm) ||
            (tabAltPerm && hasOrgPermission(o.id, tabAltPerm)),
        )
        .map((o) => o.id),
    [orgs, hasOrgPermission, tabPerm, tabAltPerm],
  );
  const allowedOrgs = useMemo(
    () => orgs.filter((o) => allowedOrgIds.includes(o.id)),
    [orgs, allowedOrgIds],
  );
  const [orgId, setOrgIdState] = useState(null);
  useEffect(() => {
    const cached =
      typeof window !== "undefined"
        ? localStorage.getItem(PANEL_ORG_KEY)
        : null;
    if (cached && allowedOrgs.some((o) => o.id === cached)) {
      setOrgIdState(cached);
    } else if (allowedOrgs[0]) {
      setOrgIdState(allowedOrgs[0].id);
    }
  }, [allowedOrgs]);
  const setOrgId = (id) => {
    setOrgIdState(id);
    if (typeof window !== "undefined") localStorage.setItem(PANEL_ORG_KEY, id);
  };

  const [allServers, setAllServers] = useState([]);
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    fetch("/api/servers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (!cancelled)
          setAllServers(
            (d.servers ?? []).map((s) => ({
              id: s.serverId,
              name: s.serverName,
              ownerOrgId: s.ownerOrgId,
              ip: s.rconHost ?? "",
              port: s.gamePort ?? 28015,
              rconPort: s.rconPort ?? 28016,
              tags: Array.isArray(s.tags) ? s.tags : [],
              rconConfigured: s.rconConfigured ?? false,
              rconWorking: null,
              pteroIdentifier: s.pteroIdentifier ?? null,
            })),
          );
      })
      .catch(() => {
        if (!cancelled) setAllServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (allowedOrgs.length === 0) {
    const isScripts = tab === "scripts";
    return (
      <SteamRequiredGate>
        <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
          <SiteNav />
          <main className="flex-1 overflow-y-auto">
            <div className="p-10 max-w-xl mx-auto">
              <div className="rounded-lg ring-1 ring-border bg-surface/40 p-8 text-center">
                <Building2 className="size-8 mx-auto text-muted-foreground mb-3" />
                <h1 className="text-lg font-semibold mb-1">
                  {isScripts
                    ? "Scripts \u2014 Staff only"
                    : "Panel \u2014 Management only"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {isScripts
                    ? "You aren't a member of any organization."
                    : "You don't have management on any organization."}
                </p>
              </div>
            </div>
          </main>
        </div>
      </SteamRequiredGate>
    );
  }
  const activeOrg = allowedOrgs.find((o) => o.id === orgId) ?? allowedOrgs[0];
  const servers = allServers.filter((s) => s.ownerOrgId === activeOrg.id);
  return (
    <SteamRequiredGate>
      <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
        <SiteNav />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 max-w-[1500px] mx-auto space-y-5">
            {/* Org switcher */}
            <div className="flex items-center justify-end gap-4 flex-wrap">
              <OrgSwitcher
                orgs={allowedOrgs}
                value={activeOrg.id}
                onChange={setOrgId}
              />
            </div>

            {tab === "rcon" && (
              <RconTab
                key={activeOrg.id}
                servers={servers}
                orgId={activeOrg.id}
              />
            )}
            {tab === "scripts" && (
              <ScriptsTab
                key={activeOrg.id}
                servers={servers}
                orgId={activeOrg.id}
              />
            )}
            {tab === "presets" && (
              <PluginsTab
                key={activeOrg.id}
                servers={servers}
                orgId={activeOrg.id}
              />
            )}
            {tab === "status" && (
              <StatusTab key={activeOrg.id} orgId={activeOrg.id} />
            )}
            {tab === "servers" && (
              <ServersTab
                key={activeOrg.id}
                orgId={activeOrg.id}
                onServerUpdate={setAllServers}
              />
            )}
          </div>
        </main>
      </div>
    </SteamRequiredGate>
  );
}
function OrgSwitcher({ orgs, value, onChange }) {
  const current = orgs.find((o) => o.id === value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 px-3 py-2 rounded-md ring-1 ring-border bg-surface/60 hover:bg-surface transition-colors">
          <Building2 className="size-4 text-brand" />
          <div className="flex flex-col items-start leading-tight">
            <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
              Panel for
            </span>
            <span className="text-sm font-semibold">{current?.name}</span>
          </div>
          <ChevronDown className="size-3.5 text-muted-foreground ml-1" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 pb-1 mb-1 border-b border-border">
          Your manageable orgs
        </div>
        <div className="space-y-0.5">
          {orgs.map((o) => {
            const checked = o.id === value;
            return (
              <button
                key={o.id}
                onClick={() => onChange(o.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
              >
                <span
                  className={
                    "size-4 rounded-sm grid place-items-center ring-1 " +
                    (checked
                      ? "bg-brand ring-brand text-brand-foreground"
                      : "ring-border text-transparent")
                  }
                >
                  <Check className="size-3" />
                </span>
                <span className="text-xs font-medium flex-1">{o.name}</span>
                <span className="text-[9px] font-mono font-bold text-muted-foreground">
                  {o.short}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
function RconTab({ servers, orgId }) {
  const [selected, setSelected] = useState(servers[0]?.id ?? "");
  const [lines, setLines] = useState([]);
  const [cmd, setCmd] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingScript, setPendingScript] = useState(null);
  const [scripts, setScripts] = useState([]);
  // Live console feed state. `liveRef` mirrors `live` so the async send/runScript
  // closures can read the current value without re-creating themselves.
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/orgs/${orgId}/scripts`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setScripts(d.scripts ?? []))
      .catch(() => setScripts([]));
  }, [orgId]);

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  const log = (line) => setLines((prev) => [...prev, line]);

  // Live console feed: subscribe to the server's RCON console over SSE. Rust
  // broadcasts console output to every connected RCON client, so anything that
  // happens on the server — including commands sent from this panel — streams in
  // here, letting staff confirm a command actually took effect.
  const feedEligible = Boolean(
    servers.find((s) => s.id === selected)?.rconConfigured,
  );
  useEffect(() => {
    liveRef.current = false;
    setLive(false);
    if (!selected || !feedEligible) return;
    const es = new EventSource(
      `/api/servers/${selected}/rcon/console/stream`,
      { withCredentials: true },
    );
    es.onopen = () => {
      liveRef.current = true;
      setLive(true);
    };
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "log") {
        const text = String(msg.message ?? "");
        if (text.trim()) log(`[FEED] ${text}`);
      } else if (msg.type === "status") {
        liveRef.current = msg.message === "connected";
        setLive(liveRef.current);
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; reflect the dropped state meanwhile.
      liveRef.current = false;
      setLive(false);
    };
    return () => {
      liveRef.current = false;
      es.close();
    };
  }, [selected, feedEligible]);

  const execCommand = async (serverId, command) => {
    const res = await fetch(`/api/servers/${serverId}/rcon/exec`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data?.error) errMsg = data.error;
      } catch {}
      throw new Error(errMsg);
    }
    const data = await res.json();
    return {
      response: String(data.response ?? ""),
      consoleLogs: Array.isArray(data.consoleLogs) ? data.consoleLogs : [],
    };
  };

  const send = async () => {
    const c = cmd.trim();
    if (!c || sending) return;
    setCmd("");
    setSending(true);
    log(`> ${c}`);
    try {
      const { response, consoleLogs } = await execCommand(selected, c);
      // When the live feed is connected it already streams these broadcasts, so
      // skip them here to avoid double-printing each console line.
      if (!liveRef.current) for (const l of consoleLogs) log(`[LOG] ${l}`);
      if (response) {
        let display;
        try {
          display = JSON.stringify(JSON.parse(response), null, 2);
        } catch {
          display = response;
        }
        for (const line of display.split("\n")) {
          if (line) log(`[RCON] ${line}`);
        }
      }
    } catch (err) {
      log(`[ERR] ${String(err?.message ?? err)}`);
    } finally {
      setSending(false);
    }
  };
  const runScript = async (script, vars) => {
    if (sending) return;
    const cmds = applyVars(script.command, vars)
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);
    setPendingScript(null);
    setSending(true);
    log(`[SCRIPT] \u25B6 ${script.name} on ${server?.name}`);
    try {
      for (const c of cmds) {
        log(`> ${c}`);
        try {
          const { response, consoleLogs } = await execCommand(selected, c);
          if (!liveRef.current) for (const l of consoleLogs) log(`[LOG] ${l}`);
          if (response) {
            let display;
            try {
              display = JSON.stringify(JSON.parse(response), null, 2);
            } catch {
              display = response;
            }
            for (const line of display.split("\n")) {
              if (line) log(`[RCON] ${line}`);
            }
          }
        } catch (err) {
          log(`[ERR] ${String(err?.message ?? err)}`);
        }
      }
    } finally {
      setSending(false);
    }
  };
  const onPickScript = (script) => {
    if (extractVars(script.command).length === 0) {
      runScript(script, {});
    } else {
      setPendingScript(script);
    }
  };
  const server = servers.find((s) => s.id === selected);
  if (!servers.length)
    return <EmptyState label="No servers configured for this org" />;
  return (
    <div className="grid grid-cols-[260px_1fr] gap-4">
      <div className="space-y-1 ring-1 ring-border rounded-md bg-surface/40 p-2 h-fit">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 py-1">
          Servers
        </div>
        {servers.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelected(s.id)}
            className={
              "w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs " +
              (s.id === selected
                ? "bg-brand/15 ring-1 ring-brand/30"
                : "hover:bg-surface")
            }
          >
            <CircleDot
              className={
                "size-3 " +
                (s.rconConfigured
                  ? s.rconWorking === false
                    ? "text-destructive"
                    : "text-success"
                  : "text-muted-foreground/40")
              }
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{s.name}</div>
              <div className="text-[10px] font-mono text-muted-foreground truncate">
                {s.rconConfigured ? `${s.ip}:${s.rconPort}` : "No RCON"}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="ring-1 ring-border rounded-md bg-background flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="size-3.5 text-brand shrink-0" />
            <span className="text-xs font-mono truncate">{server?.name}</span>
            {server?.rconConfigured ? (
              <Badge
                variant="outline"
                className="text-[9px] font-mono shrink-0"
              >
                RCON · {server.ip}:{server.rconPort}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-[9px] font-mono shrink-0 border-warning/40 text-warning"
              >
                RCON not configured
              </Badge>
            )}
            {server?.rconConfigured && (
              <Badge
                variant="outline"
                className={
                  "text-[9px] font-mono shrink-0 flex items-center gap-1 " +
                  (live
                    ? "border-success/40 text-success"
                    : "border-muted-foreground/30 text-muted-foreground")
                }
                title={
                  live
                    ? "Live console feed connected"
                    : "Console feed reconnecting…"
                }
              >
                <span
                  className={
                    "size-1.5 rounded-full " +
                    (live ? "bg-success animate-pulse" : "bg-muted-foreground/50")
                  }
                />
                {live ? "LIVE" : "OFFLINE"}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ScriptPickerButton
              scripts={scripts}
              onPick={onPickScript}
              disabled={sending}
            />
            <Button size="sm" variant="ghost" onClick={() => setLines([])}>
              Clear
            </Button>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="h-[420px] overflow-y-auto p-3 font-mono text-[11px] leading-relaxed bg-black/40"
        >
          {lines.length === 0 && (
            <div className="text-muted-foreground/40">
              {server?.rconConfigured
                ? "Ready. Type a command below or pick a script."
                : "Configure RCON credentials for this server in the Servers tab."}
            </div>
          )}
          {lines.map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith(">")
                  ? "text-brand"
                  : l.includes("[RCON]")
                    ? "text-success"
                    : l.includes("[SCRIPT]")
                      ? "text-warning"
                      : l.includes("[ERR]")
                        ? "text-destructive"
                        : l.includes("[LOG]")
                          ? "text-foreground/70"
                          : l.includes("[FEED]")
                            ? "text-sky-300/70"
                            : "text-muted-foreground"
              }
            >
              {l}
            </div>
          ))}
        </div>
        <div className="border-t border-border p-2 flex gap-2">
          <span className="grid place-items-center px-2 font-mono text-xs text-brand">
            {">"}
          </span>
          <Input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={
              server?.rconConfigured
                ? "Type an RCON command…"
                : "Configure RCON first"
            }
            disabled={!server?.rconConfigured || sending}
            className="font-mono text-xs"
          />
          <Button
            size="sm"
            onClick={send}
            disabled={!server?.rconConfigured || sending || !cmd.trim()}
          >
            {sending ? "…" : "Send"}
          </Button>
        </div>
      </div>

      <RunVarsDialog
        pending={
          pendingScript
            ? {
                script: pendingScript,
                targets: [selected],
                targetLabel: server?.name ?? "",
              }
            : null
        }
        onClose={() => setPendingScript(null)}
        onRun={(s, _t, vars) => runScript(s, vars)}
      />
    </div>
  );
}
function ScriptPickerButton({ scripts, onPick, disabled }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = scripts.filter(
    (s) =>
      s.name.toLowerCase().includes(q.toLowerCase()) ||
      s.command.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <ScrollText className="size-3.5 mr-1" /> Script
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1.5">
        <div className="flex items-center gap-1.5 px-1 pb-1.5">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search scripts…"
            className="h-7 text-xs"
            autoFocus
          />
        </div>
        <div className="space-y-0.5 max-h-72 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              No scripts found
            </div>
          )}
          {filtered.map((s) => {
            const vars = extractVars(s.command);
            const lc = s.command.split("\n").filter(Boolean).length;
            return (
              <button
                key={s.id}
                onClick={() => {
                  onPick(s);
                  setOpen(false);
                  setQ("");
                }}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-surface flex flex-col gap-0.5"
              >
                <div className="flex items-center gap-1.5">
                  <Play className="size-3 text-brand" />
                  <span className="text-xs font-medium truncate">{s.name}</span>
                  <Badge
                    variant="outline"
                    className="text-[9px] font-mono h-4 px-1 ml-auto"
                  >
                    {lc} cmd
                  </Badge>
                  {vars.length > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[9px] font-mono h-4 px-1 border-warning/40 text-warning bg-warning/5"
                    >
                      {vars.length} var
                    </Badge>
                  )}
                </div>
                {s.description && (
                  <span className="text-[10px] text-muted-foreground line-clamp-1 pl-4.5">
                    {s.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
function ScriptsTab({ servers, orgId }) {
  const { rankOf, hasOrgPermission } = useAuth();
  const userRank = rankOf(orgId);
  const canManage = hasOrgPermission(orgId, "scripts_manage");
  const canRcon = hasOrgPermission(orgId, "rcon_access");
  const [scripts, setScripts] = useState([]);
  const [scriptsLoading, setScriptsLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [pendingRun, setPendingRun] = useState(null);
  const [runResults, setRunResults] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setScriptsLoading(true);
    fetch(`/api/orgs/${orgId}/scripts`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (!cancelled) setScripts(d.scripts ?? []);
      })
      .catch(() => {
        if (!cancelled) setScripts([]);
      })
      .finally(() => {
        if (!cancelled) setScriptsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const allTags = useMemo(
    () => Array.from(new Set(servers.flatMap((s) => s.tags))),
    [servers],
  );

  const deleteScript = async (scriptId) => {
    setScripts((p) => p.filter((x) => x.id !== scriptId));
    await fetch(`/api/orgs/${orgId}/scripts/${scriptId}`, {
      method: "DELETE",
      credentials: "include",
    }).catch(() => null);
  };

  const saveScript = async (draft) => {
    if (editing) {
      const res = await fetch(`/api/orgs/${orgId}/scripts/${editing.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          command: draft.command,
          description: draft.description,
          minRank: draft.minRank,
        }),
      });
      if (res.ok) {
        const { script } = await res.json();
        setScripts((p) => p.map((x) => (x.id === editing.id ? script : x)));
      }
    } else {
      const res = await fetch(`/api/orgs/${orgId}/scripts`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          command: draft.command,
          description: draft.description,
          minRank: draft.minRank,
        }),
      });
      if (res.ok) {
        const { script } = await res.json();
        setScripts((p) => [...p, script]);
      }
    }
    setCreating(false);
    setEditing(null);
  };

  const executeRun = async (script, targets, vars) => {
    if (running) return;
    setPendingRun(null);
    setRunning(true);
    const serverMap = Object.fromEntries(servers.map((s) => [s.id, s.name]));
    const initialResults = targets.map((id) => ({
      serverId: id,
      serverName: serverMap[id] ?? id,
      status: "pending",
      outputs: [],
    }));
    setRunResults({ scriptName: script.name, results: initialResults });
    for (let i = 0; i < targets.length; i++) {
      const serverId = targets[i];
      setRunResults((prev) => {
        if (!prev) return prev;
        const next = prev.results.map((r) =>
          r.serverId === serverId ? { ...r, status: "running" } : r,
        );
        return { ...prev, results: next };
      });
      let outputs = [];
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/scripts/${encodeURIComponent(script.id)}/exec`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ serverId, vars }),
          },
        );
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          outputs = [
            {
              cmd: script.name,
              ok: false,
              response: data?.error ?? `HTTP ${res.status}`,
            },
          ];
        } else {
          outputs = data?.outputs ?? [];
        }
      } catch {
        outputs = [{ cmd: script.name, ok: false, response: "Network error" }];
      }
      const allOk = outputs.every((o) => o.ok);
      setRunResults((prev) => {
        if (!prev) return prev;
        const next = prev.results.map((r) =>
          r.serverId === serverId
            ? { ...r, status: allOk ? "ok" : "error", outputs }
            : r,
        );
        return { ...prev, results: next };
      });
    }
    setRunning(false);
  };

  const triggerRun = (script, targets, targetLabel) => {
    if (!targets.length) return;
    if (!canRcon) return;
    if (userRank < script.minRank) return;
    const vars = extractVars(script.command);
    if (vars.length === 0) {
      executeRun(script, targets, {});
    } else {
      setPendingRun({ script, targets, targetLabel });
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Pre-configured RCON commands. One script can hold multiple lines and{" "}
          <code className="font-mono text-brand">{`{variables}`}</code> that get
          prompted at run-time. Each script has a minimum rank required to
          execute.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5 mr-1" /> New script
          </Button>
        )}
      </div>

      {scriptsLoading && (
        <p className="text-xs text-muted-foreground">Loading scripts…</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {scripts.map((s) => {
          const lines = s.command.split("\n").filter(Boolean);
          const vars = extractVars(s.command);
          const allowed = userRank >= s.minRank;
          return (
            <div
              key={s.id}
              className="ring-1 ring-border rounded-md bg-surface/40 p-3 flex flex-col gap-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-sm font-semibold truncate">
                      {s.name}
                    </div>
                    <Badge
                      variant="outline"
                      className="text-[9px] font-mono h-4 px-1.5"
                    >
                      {lines.length} cmd{lines.length === 1 ? "" : "s"}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={
                        "text-[9px] font-mono h-4 px-1.5 " +
                        (allowed
                          ? "border-brand/40 text-brand bg-brand/5"
                          : "border-destructive/40 text-destructive bg-destructive/5")
                      }
                      title={
                        allowed
                          ? "You can run this script"
                          : "Requires higher rank"
                      }
                    >
                      {rankLabel(s.minRank)}+
                    </Badge>
                    {vars.map((v) => (
                      <Badge
                        key={v}
                        variant="outline"
                        className="text-[9px] font-mono h-4 px-1.5 border-warning/40 text-warning bg-warning/5"
                      >
                        {`{${v}}`}
                      </Badge>
                    ))}
                  </div>
                  {s.description && (
                    <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                      {s.description}
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => setEditing(s)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive"
                      onClick={() => setConfirmDelete(s)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>

              <pre className="text-[10px] font-mono text-brand bg-black/30 ring-1 ring-border rounded p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
                {s.command}
              </pre>

              {canRcon && !allowed && (
                <div className="text-[10px] font-mono text-destructive bg-destructive/5 ring-1 ring-destructive/30 rounded px-2 py-1">
                  Requires {rankLabel(s.minRank)} or higher to execute.
                </div>
              )}
              {!canRcon && (
                <div className="text-[10px] font-mono text-muted-foreground bg-muted/10 ring-1 ring-border rounded px-2 py-1">
                  You don't have RCON access.
                </div>
              )}

              <div className="grid grid-cols-[1fr_auto_auto] gap-1.5">
                <Button
                  size="sm"
                  onClick={() =>
                    triggerRun(
                      s,
                      servers.map((x) => x.id),
                      `all ${servers.length} servers`,
                    )
                  }
                  disabled={!servers.length || !allowed || !canRcon || running}
                >
                  <Play className="size-3.5 mr-1" />{" "}
                  {running ? "Running…" : "Run all"}
                </Button>
                <RunOnGroupButton
                  tags={allTags}
                  disabled={!allowed || !canRcon || running}
                  onPick={(tag) =>
                    triggerRun(
                      s,
                      servers
                        .filter((x) => x.tags.includes(tag))
                        .map((x) => x.id),
                      `group: ${tag}`,
                    )
                  }
                />
                <RunOnServerButton
                  servers={servers}
                  disabled={!allowed || !canRcon || running}
                  onPick={(srv) => triggerRun(s, [srv.id], srv.name)}
                />
              </div>
            </div>
          );
        })}
      </div>

      <RunVarsDialog
        pending={pendingRun}
        onClose={() => setPendingRun(null)}
        onRun={executeRun}
      />

      <RunResultsDialog
        results={runResults}
        onClose={() => setRunResults(null)}
      />

      <Dialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete script?</DialogTitle>
            <DialogDescription>
              "{confirmDelete?.name}" will be permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteScript(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ScriptEditDialog
        open={creating || !!editing}
        initial={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={saveScript}
      />
    </div>
  );
}
function RunOnGroupButton({ tags, onPick, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={!tags.length || disabled}>
          <Layers className="size-3.5 mr-1" /> Run group
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-52 p-1.5">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 py-1">
          Pick a tag
        </div>
        <div className="space-y-0.5 max-h-60 overflow-y-auto">
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => {
                onPick(t);
                setOpen(false);
              }}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-surface text-xs font-mono flex items-center gap-2"
            >
              <Play className="size-3 text-brand" /> {t}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
function RunOnServerButton({ servers, onPick, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={!servers.length || disabled}
        >
          <Target className="size-3.5 mr-1" /> Run server
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 py-1">
          Pick a server
        </div>
        <div className="space-y-0.5 max-h-60 overflow-y-auto">
          {servers.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                onPick(s);
                setOpen(false);
              }}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-surface text-xs flex items-center gap-2"
            >
              <Play className="size-3 text-brand shrink-0" />
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
function RunResultsDialog({ results, onClose }) {
  if (!results) return null;
  const pending = results.results.some(
    (r) => r.status === "pending" || r.status === "running",
  );
  const anyError = results.results.some((r) => r.status === "error");
  return (
    <Dialog open={!!results} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="size-4" />
            {results.scriptName}
          </DialogTitle>
          <DialogDescription>
            Running on {results.results.length} server
            {results.results.length === 1 ? "" : "s"}
            {pending
              ? " — in progress…"
              : anyError
                ? " — completed with errors"
                : " — completed"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-[60vh] overflow-y-auto py-1">
          {results.results.map((r) => (
            <div
              key={r.serverId}
              className="ring-1 ring-border rounded-md bg-surface/40 p-2.5 space-y-1.5"
            >
              <div className="flex items-center gap-2">
                {r.status === "pending" && (
                  <div className="size-2 rounded-full bg-muted-foreground shrink-0" />
                )}
                {r.status === "running" && (
                  <RefreshCw className="size-3 text-brand shrink-0 animate-spin" />
                )}
                {r.status === "ok" && (
                  <Check className="size-3 text-success shrink-0" />
                )}
                {r.status === "error" && (
                  <X className="size-3 text-destructive shrink-0" />
                )}
                <span className="text-xs font-medium truncate">
                  {r.serverName}
                </span>
                <span
                  className={`text-[10px] font-mono ml-auto ${
                    r.status === "running"
                      ? "text-brand"
                      : r.status === "ok"
                        ? "text-success"
                        : r.status === "error"
                          ? "text-destructive"
                          : "text-muted-foreground"
                  }`}
                >
                  {r.status === "pending"
                    ? "queued"
                    : r.status === "running"
                      ? "running…"
                      : r.status === "ok"
                        ? "done"
                        : "error"}
                </span>
              </div>
              {r.outputs.length > 0 && (
                <div className="space-y-1">
                  {r.outputs.map((o, i) => (
                    <div key={i}>
                      <div className="text-[9px] font-mono text-muted-foreground truncate">
                        $ {o.cmd}
                      </div>
                      {o.response && (
                        <pre
                          className={`text-[10px] font-mono rounded p-1.5 whitespace-pre-wrap break-all ${
                            o.ok
                              ? "text-foreground bg-black/20"
                              : "text-destructive bg-destructive/5"
                          }`}
                        >
                          {o.response}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button onClick={onClose} disabled={pending}>
            {pending ? "Running…" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function RunVarsDialog({ pending, onClose, onRun }) {
  const [values, setValues] = useState({});
  const vars = pending ? extractVars(pending.script.command) : [];
  useEffect(() => {
    if (pending)
      setValues(
        Object.fromEntries(
          extractVars(pending.script.command).map((v) => [v, ""]),
        ),
      );
  }, [pending]);
  if (!pending) return null;
  const allFilled = vars.every((v) => values[v]?.trim());
  const preview = applyVars(pending.script.command, values);
  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run “{pending.script.name}”</DialogTitle>
          <DialogDescription>
            Target:{" "}
            <span className="font-mono text-foreground">
              {pending.targetLabel}
            </span>{" "}
            · fill in the variables below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {vars.map((v) => (
            <div key={v} className="space-y-1.5">
              <Label className="font-mono">{`{${v}}`}</Label>
              <Input
                value={values[v] ?? ""}
                onChange={(e) =>
                  setValues((p) => ({ ...p, [v]: e.target.value }))
                }
                placeholder={`value for ${v}`}
                className="font-mono text-xs"
              />
            </div>
          ))}

          <div className="space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Preview
            </div>
            <pre className="text-[11px] font-mono text-brand bg-black/40 ring-1 ring-border rounded p-2 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {preview}
            </pre>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!allFilled}
            onClick={() => onRun(pending.script, pending.targets, values)}
          >
            <Play className="size-3.5 mr-1" /> Execute on{" "}
            {pending.targets.length} server
            {pending.targets.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function ScriptEditDialog({ open, initial, onClose, onSave }) {
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    command: "",
    description: "",
    minRank: 2,
  });
  useEffect(() => {
    if (open) {
      setDraft(
        initial ?? {
          id: "",
          name: "",
          command: "",
          description: "",
          minRank: 2,
        },
      );
    }
  }, [open, initial]);
  const vars = extractVars(draft.command);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit script" : "New script"}</DialogTitle>
          <DialogDescription>
            One RCON command per line. Use{" "}
            <code className="font-mono text-brand">{`{name}`}</code> for
            variables — they'll be prompted at run-time.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>RCON commands (one per line)</Label>
            <Textarea
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              className="font-mono text-xs min-h-32"
              placeholder={"say Restart in {minutes} min\nrestart {minutes}"}
              rows={6}
            />
            {vars.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                <span className="text-[10px] text-muted-foreground">
                  Detected variables:
                </span>
                {vars.map((v) => (
                  <Badge
                    key={v}
                    variant="outline"
                    className="text-[9px] font-mono h-4 px-1.5 border-warning/40 text-warning bg-warning/5"
                  >
                    {`{${v}}`}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Minimum rank required</Label>
            <Select
              value={String(draft.minRank)}
              onValueChange={(v) => setDraft({ ...draft, minRank: Number(v) })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANK_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={String(r.value)}>
                    {r.label} (rank {r.value}+)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Only staff with this team rank or higher in the active org can
              execute this script.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Textarea
              value={draft.description ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!draft.name || !draft.command}
            onClick={() => onSave(draft)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
// Container for the two plugin views: the org-wide Registry (version/risk/tag
// management, deploy by group tag) and the per-server Files browser (live Oxide
// status, config editing, .cs upload on a single server).
function PluginsTab({ servers, orgId }) {
  const [view, setView] = useState("registry");
  const SUBTABS = [
    { id: "registry", label: "Registry", icon: Layers },
    { id: "files", label: "Server Files", icon: ScrollText },
  ];
  return (
    <div className="space-y-3">
      <div className="inline-flex items-center gap-0.5 ring-1 ring-border rounded-md bg-surface/40 p-0.5">
        {SUBTABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={
              "inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors " +
              (view === id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
      {view === "registry" ? (
        <OrgPluginsTab orgId={orgId} />
      ) : (
        <PresetsTab servers={servers} orgId={orgId} />
      )}
    </div>
  );
}

// Org-wide plugin registry: lists every plugin once (not per server) with its
// installed vs latest umod version, a risk group, the server group tags it
// deploys to, and which servers those tags resolve to. Push/unload act over all
// tag-matched servers at once.
const RISK_META = {
  1: { on: "bg-success/20 ring-success/50 text-success", title: "Low risk" },
  2: { on: "bg-warning/20 ring-warning/50 text-warning", title: "Medium risk" },
  3: {
    on: "bg-destructive/20 ring-destructive/50 text-destructive",
    title: "High risk",
  },
};

function OrgPluginsTab({ orgId }) {
  const tz = useTimezone();
  const [plugins, setPlugins] = useState([]);
  const [availableTags, setAvailableTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({});
  const [checking, setChecking] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch(`/api/orgs/${orgId}/plugins`, {
        credentials: "include",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setPlugins(data.plugins ?? []);
      setAvailableTags(data.availableTags ?? []);
      setError(null);
    } catch {
      setError("Failed to load plugins.");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const withBusy = async (id, fn) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const patchPlugin = (id, patch) =>
    withBusy(id, async () => {
      const res = await fetch(`/api/orgs/${orgId}/plugins/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) await load();
    });

  const setTags = (p, tags) => patchPlugin(p.id, { assignedTags: tags });

  const pushPlugin = (p, action) =>
    withBusy(p.id, async () => {
      const res = await fetch(`/api/orgs/${orgId}/plugins/${p.id}/push`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) await load();
    });

  const removePlugin = (p) =>
    withBusy(p.id, async () => {
      const res = await fetch(`/api/orgs/${orgId}/plugins/${p.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) await load();
    });

  const checkUpdates = async () => {
    setChecking(true);
    try {
      await fetch(`/api/orgs/${orgId}/plugins/refresh-versions`, {
        method: "POST",
        credentials: "include",
      });
      await load();
    } finally {
      setChecking(false);
    }
  };

  const fmtDate = (unix) =>
    unix
      ? new Date(unix * 1000).toLocaleDateString(
          undefined,
          tz ? { timeZone: tz } : {},
        )
      : null;

  const COLS = "grid grid-cols-[1.6fr_1fr_0.7fr_1.7fr_1.2fr_auto] gap-3";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground max-w-xl">
          Every plugin across this org's servers, with its uMod version, risk
          group, and the server group tags it deploys to. Push or unload acts on
          every server matching the plugin's tags.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={checkUpdates}
            disabled={checking}
            title="Look up the latest versions on umod.org"
          >
            <RefreshCw
              className={"size-3.5 mr-1.5 " + (checking ? "animate-spin" : "")}
            />
            Check for updates
          </Button>
          <Button
            size="sm"
            className="text-xs"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="size-3.5 mr-1.5" />
            Add plugin
          </Button>
        </div>
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground py-4">Loading plugins…</p>
      )}
      {!loading && error && (
        <div className="ring-1 ring-destructive/40 rounded-md bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {!loading && !error && plugins.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">
          No plugins registered yet. Add one to start tracking versions and
          deployments.
        </p>
      )}

      {!loading && !error && plugins.length > 0 && (
        <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
          <div
            className={`${COLS} px-3 py-2 border-b border-border bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground`}
          >
            <div>Plugin</div>
            <div>Version</div>
            <div>Risk</div>
            <div>Group tags</div>
            <div>Servers</div>
            <div />
          </div>
          {plugins.map((p) => {
            const outdated =
              p.latestVersion &&
              p.installedVersion &&
              p.latestVersion !== p.installedVersion;
            const unassignedTags = availableTags.filter(
              (t) => !p.assignedTags.includes(t),
            );
            const serverCount = p.servers?.length ?? 0;
            const isBusy = !!busy[p.id];
            return (
              <div
                key={p.id}
                className={`${COLS} px-3 py-2.5 border-b border-border last:border-0 items-center`}
              >
                {/* Plugin */}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold truncate">
                      {p.name}
                    </span>
                    <span
                      className={
                        "inline-flex items-center rounded-md border py-0.5 px-1.5 font-semibold text-[9px] font-mono h-4 " +
                        (p.source === "custom"
                          ? "border-brand/40 text-brand bg-brand/5"
                          : "border-border text-muted-foreground")
                      }
                    >
                      {p.source}
                    </span>
                  </div>
                  {p.umodSlug ? (
                    <a
                      href={`https://umod.org/plugins/${encodeURIComponent(p.umodSlug)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] font-mono text-muted-foreground truncate hover:text-foreground inline-flex items-center gap-0.5"
                    >
                      umod.org/{p.umodSlug}
                      <ExternalLink className="size-2.5" />
                    </a>
                  ) : (
                    <div className="text-[10px] font-mono text-muted-foreground truncate">
                      custom upload
                    </div>
                  )}
                </div>

                {/* Version */}
                <div>
                  <div className="text-xs font-mono flex items-center gap-1.5">
                    {p.installedVersion ?? "—"}
                    {outdated && (
                      <>
                        <span className="text-muted-foreground/50">→</span>
                        <span className="text-warning">{p.latestVersion}</span>
                        <span className="size-1.5 rounded-full bg-warning animate-pulse" />
                      </>
                    )}
                  </div>
                  {fmtDate(p.latestUpdatedAt) && (
                    <div className="text-[10px] text-muted-foreground">
                      {fmtDate(p.latestUpdatedAt)}
                    </div>
                  )}
                </div>

                {/* Risk */}
                <div className="inline-flex items-center gap-0.5 ring-1 ring-border rounded p-0.5 w-fit">
                  {[1, 2, 3].map((r) => (
                    <button
                      key={r}
                      disabled={isBusy}
                      onClick={() => r !== p.risk && patchPlugin(p.id, { risk: r })}
                      title={RISK_META[r].title}
                      className={
                        "px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 " +
                        (p.risk === r
                          ? RISK_META[r].on
                          : "bg-surface ring-border text-muted-foreground hover:text-foreground")
                      }
                    >
                      {r}
                    </button>
                  ))}
                </div>

                {/* Group tags */}
                <div className="flex gap-1 flex-wrap items-center">
                  {p.assignedTags.map((t) => (
                    <button
                      key={t}
                      disabled={isBusy}
                      onClick={() =>
                        setTags(
                          p,
                          p.assignedTags.filter((x) => x !== t),
                        )
                      }
                      title={`Remove ${t}`}
                      className="group inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold ring-1 bg-brand/15 ring-brand/40 text-brand hover:bg-destructive/15 hover:ring-destructive/40 hover:text-destructive transition-colors"
                    >
                      {t}
                      <X className="size-2.5 opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                  {unassignedTags.length > 0 && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          disabled={isBusy}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono ring-1 ring-dashed ring-border text-muted-foreground hover:text-foreground hover:ring-brand/40"
                          title="Add group tag"
                        >
                          <Plus className="size-2.5" /> tag
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-40 p-1">
                        {unassignedTags.map((t) => (
                          <button
                            key={t}
                            onClick={() => setTags(p, [...p.assignedTags, t])}
                            className="w-full text-left px-2 py-1 rounded text-xs font-mono hover:bg-surface"
                          >
                            {t}
                          </button>
                        ))}
                      </PopoverContent>
                    </Popover>
                  )}
                  {p.assignedTags.length === 0 &&
                    unassignedTags.length === 0 && (
                      <span className="text-[10px] text-muted-foreground italic">
                        no server tags
                      </span>
                    )}
                </div>

                {/* Servers */}
                <div className="min-w-0">
                  {serverCount === 0 ? (
                    <span className="text-[10px] text-muted-foreground italic">
                      none
                    </span>
                  ) : (
                    <div
                      className="flex flex-wrap gap-1"
                      title={p.servers.map((s) => s.name).join(", ")}
                    >
                      {p.servers.slice(0, 3).map((s) => (
                        <span
                          key={s.id}
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded ring-1 ring-border text-muted-foreground truncate max-w-[90px]"
                        >
                          {s.name}
                        </span>
                      ))}
                      {serverCount > 3 && (
                        <span className="text-[10px] font-mono text-muted-foreground">
                          +{serverCount - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                  <button
                    disabled={isBusy || serverCount === 0}
                    onClick={() => pushPlugin(p, "unload")}
                    title={`Unload on ${serverCount} server(s)`}
                    className="inline-flex items-center justify-center size-7 rounded hover:bg-accent disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <Power className="size-3.5 text-success" />
                  </button>
                  <button
                    disabled={isBusy || serverCount === 0 || !outdated}
                    onClick={() => pushPlugin(p, "reload")}
                    title={
                      outdated
                        ? `Push update to ${serverCount} server(s)`
                        : "Up to date"
                    }
                    className={
                      "inline-flex items-center gap-1 h-8 rounded-md px-3 text-xs font-medium disabled:opacity-50 disabled:pointer-events-none " +
                      (outdated
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "ring-1 ring-border bg-background text-muted-foreground")
                    }
                  >
                    <RefreshCw className="size-3.5" />
                    {outdated ? `Update (${serverCount})` : "Up to date"}
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => removePlugin(p)}
                    title="Remove from registry"
                    className="inline-flex items-center justify-center size-7 rounded hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AddPluginDialog
        open={addOpen}
        orgId={orgId}
        availableTags={availableTags}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          load();
        }}
      />
    </div>
  );
}

function AddPluginDialog({ open, orgId, availableTags, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState("umod");
  const [umodSlug, setUmodSlug] = useState("");
  const [installedVersion, setInstalledVersion] = useState("");
  const [risk, setRisk] = useState(2);
  const [tags, setTags] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setSource("umod");
      setUmodSlug("");
      setInstalledVersion("");
      setRisk(2);
      setTags([]);
      setError("");
    }
  }, [open]);

  const save = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/plugins`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          source,
          umodSlug: source === "umod" ? umodSlug.trim() : undefined,
          installedVersion: installedVersion.trim() || undefined,
          risk,
          assignedTags: tags,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Failed (${res.status})`);
        return;
      }
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add plugin</DialogTitle>
          <DialogDescription>
            Track a plugin's version and deploy it to servers by group tag.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label>Plugin name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="AdminMenu"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="umod">uMod</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Risk</Label>
              <Select
                value={String(risk)}
                onValueChange={(v) => setRisk(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 · Low</SelectItem>
                  <SelectItem value="2">2 · Medium</SelectItem>
                  <SelectItem value="3">3 · High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {source === "umod" && (
            <div className="space-y-1.5">
              <Label>uMod slug</Label>
              <Input
                value={umodSlug}
                onChange={(e) => setUmodSlug(e.target.value)}
                placeholder="admin-menu"
                className="font-mono"
              />
              <p className="text-[10px] text-muted-foreground">
                The slug from umod.org/plugins/&lt;slug&gt; — used to look up the
                latest version.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Installed version (optional)</Label>
            <Input
              value={installedVersion}
              onChange={(e) => setInstalledVersion(e.target.value)}
              placeholder="2.1.3"
              className="font-mono"
            />
          </div>
          {availableTags.length > 0 && (
            <div className="space-y-1.5">
              <Label>Group tags</Label>
              <div className="flex flex-wrap gap-1">
                {availableTags.map((t) => {
                  const on = tags.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() =>
                        setTags(
                          on ? tags.filter((x) => x !== t) : [...tags, t],
                        )
                      }
                      className={
                        "px-2 py-0.5 rounded text-[10px] font-mono font-bold ring-1 " +
                        (on
                          ? "bg-brand/15 ring-brand/40 text-brand"
                          : "bg-surface ring-border text-muted-foreground hover:text-foreground")
                      }
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Adding…" : "Add plugin"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PresetsTab({ servers, orgId }) {
  const pteroServers = servers.filter((s) => s.pteroIdentifier);
  const [selectedServerId, setSelectedServerId] = useState(
    pteroServers[0]?.id ?? null,
  );
  const [cmdState, setCmdState] = useState({});
  const [configDialog, setConfigDialog] = useState(null);
  const [deleteDialog, setDeleteDialog] = useState(null);
  const [uploadDialog, setUploadDialog] = useState(null);
  const fileInputRef = useRef(null);

  const {
    plugins,
    rconAvailable,
    loading,
    fetching,
    error: fetchError,
    refresh,
    invalidate,
    invalidateAll,
  } = usePteroPlugins(selectedServerId);

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) =>
      setUploadDialog({ fileName: file.name, content: ev.target.result });
    reader.readAsText(file);
  };

  // Auto-select first server when the server list arrives after mount
  useEffect(() => {
    if (selectedServerId === null && pteroServers.length > 0) {
      setSelectedServerId(pteroServers[0].id);
    }
  }, [pteroServers, selectedServerId]);

  const runCmd = async (pluginName, cmd) => {
    const key = `${pluginName}:${cmd}`;
    setCmdState((s) => ({ ...s, [key]: "loading" }));
    try {
      const res = await fetch(
        `/api/servers/${selectedServerId}/ptero-plugin-cmd`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cmd, pluginName }),
        },
      );
      const data = await res.json();
      setCmdState((s) => ({
        ...s,
        [key]: res.ok
          ? { output: data.output ?? "" }
          : { error: data.error ?? "Failed" },
      }));
      // A reload/unload changes the plugin's live status — refresh the list.
      if (res.ok) invalidate();
    } catch (err) {
      setCmdState((s) => ({ ...s, [key]: { error: err.message } }));
    }
    setTimeout(
      () =>
        setCmdState((s) => {
          const n = { ...s };
          delete n[key];
          return n;
        }),
      4000,
    );
  };

  const selectedServer = servers.find((s) => s.id === selectedServerId);

  if (pteroServers.length === 0) {
    return (
      <div className="rounded-lg ring-1 ring-border bg-surface/40 p-8 text-center">
        <Server className="size-8 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm font-medium mb-1">No Pterodactyl servers</p>
        <p className="text-xs text-muted-foreground">
          Import a server with a Pterodactyl identifier from the Servers tab to
          manage plugins here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground max-w-xl">
        Oxide plugins loaded from{" "}
        <span className="font-mono">/oxide/plugins/</span> via Pterodactyl.
        Reload and unload send RCON commands to the selected server. Config
        edits write to <span className="font-mono">/oxide/config/</span> and
        trigger a plugin reload.
      </p>

      {/* Server selector + upload */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {pteroServers.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedServerId(s.id)}
              className={
                "px-3 py-1 rounded text-xs font-medium ring-1 transition-colors " +
                (s.id === selectedServerId
                  ? "bg-primary text-primary-foreground ring-primary"
                  : "bg-surface/40 ring-border text-muted-foreground hover:text-foreground")
              }
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={() => refresh()}
            disabled={!selectedServerId || fetching}
            title="Refresh plugin list and status"
          >
            <RefreshCw
              className={"size-3.5 mr-1.5 " + (fetching ? "animate-spin" : "")}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-3.5 mr-1.5" />
            Upload plugin
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".cs"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground py-4">
          Loading plugins and checking status via RCON…
        </p>
      )}
      {!loading && fetchError && (
        <div className="ring-1 ring-destructive/40 rounded-md bg-destructive/5 p-3 text-sm text-destructive">
          {fetchError}
        </div>
      )}
      {!loading && !fetchError && plugins.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">
          No .cs plugins found in /oxide/plugins/
        </p>
      )}
      {!loading && !fetchError && plugins.length > 0 && (
        <>
          {rconAvailable === false && (
            <p className="text-[11px] text-muted-foreground">
              Configure RCON on this server to see active/failed status.
            </p>
          )}
          {rconAvailable === true && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-3">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                Active
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-destructive inline-block" />
                Failed to compile
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 inline-block" />
                Not loaded
              </span>
            </p>
          )}
          <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
            <div className="grid grid-cols-[2fr_0.7fr_2.5fr_auto] gap-3 px-3 py-2 border-b border-border bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              <div>Plugin</div>
              <div>Version</div>
              <div>Description</div>
              <div />
            </div>
            {plugins.map((p) => {
              const rKey = `${p.pluginName}:reload`;
              const uKey = `${p.pluginName}:unload`;
              const rState = cmdState[rKey];
              const uState = cmdState[uKey];
              return (
                <div
                  key={p.fileName}
                  className={
                    "grid grid-cols-[2fr_0.7fr_2.5fr_auto] gap-3 px-3 py-2.5 border-b border-border last:border-0 items-center " +
                    (p.status === "failed" ? "bg-destructive/5" : "")
                  }
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {p.status === "active" && (
                        <span
                          className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-success"
                          title="Active"
                        />
                      )}
                      {p.status === "failed" && (
                        <span
                          className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-destructive"
                          title="Failed to compile"
                        />
                      )}
                      {p.status === null && rconAvailable && (
                        <span
                          className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-muted-foreground/40"
                          title="Not loaded"
                        />
                      )}
                      <span className="text-sm font-semibold truncate">
                        {p.name}
                      </span>
                    </div>
                    {p.author && (
                      <div className="text-[10px] font-mono text-muted-foreground truncate">
                        {p.author}
                      </div>
                    )}
                    {p.status === "failed" && p.compileError && (
                      <div
                        className="text-[10px] text-destructive truncate"
                        title={p.compileError}
                      >
                        {p.compileError}
                      </div>
                    )}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">
                    {p.version ?? "—"}
                  </div>
                  <div
                    className="text-xs text-muted-foreground truncate"
                    title={p.description ?? ""}
                  >
                    {p.description ?? "—"}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      disabled={rState === "loading"}
                      onClick={() => runCmd(p.pluginName, "reload")}
                      title="Reload plugin (o.reload)"
                    >
                      <RefreshCw
                        className={
                          "size-3.5 " +
                          (rState === "loading"
                            ? "animate-spin text-muted-foreground"
                            : rState?.output !== undefined
                              ? "text-success"
                              : rState?.error
                                ? "text-destructive"
                                : "")
                        }
                      />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      disabled={uState === "loading"}
                      onClick={() => runCmd(p.pluginName, "unload")}
                      title="Unload plugin (o.unload)"
                    >
                      <Power
                        className={
                          "size-3.5 " +
                          (uState === "loading"
                            ? "text-muted-foreground animate-pulse"
                            : uState?.output !== undefined
                              ? "text-muted-foreground"
                              : uState?.error
                                ? "text-destructive"
                                : "text-success")
                        }
                      />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() =>
                        setConfigDialog({
                          serverId: selectedServerId,
                          pluginName: p.pluginName,
                          serverName: selectedServer?.name ?? "",
                        })
                      }
                      title="Edit config"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() =>
                        setDeleteDialog({ pluginName: p.pluginName })
                      }
                      title="Remove from all servers"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {configDialog && (
        <PluginConfigDialog
          serverId={configDialog.serverId}
          pluginName={configDialog.pluginName}
          serverName={configDialog.serverName}
          onClose={() => setConfigDialog(null)}
          onSaved={() => invalidate()}
        />
      )}
      {deleteDialog && (
        <BulkDeleteDialog
          pluginName={deleteDialog.pluginName}
          pteroServers={pteroServers}
          orgId={orgId}
          onClose={() => setDeleteDialog(null)}
          onSuccess={() => invalidateAll()}
        />
      )}
      {uploadDialog && (
        <BulkUploadDialog
          fileName={uploadDialog.fileName}
          content={uploadDialog.content}
          pteroServers={pteroServers}
          orgId={orgId}
          onClose={() => setUploadDialog(null)}
          onSuccess={() => invalidateAll()}
        />
      )}
    </div>
  );
}
function ServerPicker({ servers, selected, onChange }) {
  const allSelected = selected.size === servers.length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {selected.size} of {servers.length} server
          {servers.length !== 1 ? "s" : ""} selected
        </span>
        <button
          type="button"
          onClick={() =>
            onChange(
              allSelected ? new Set() : new Set(servers.map((s) => s.id)),
            )
          }
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </div>
      <div className="rounded-md border border-border bg-surface/40 divide-y divide-border max-h-44 overflow-y-auto">
        {servers.map((s) => (
          <label
            key={s.id}
            className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-surface/60 transition-colors"
          >
            <Checkbox
              checked={selected.has(s.id)}
              onCheckedChange={(v) => {
                const next = new Set(selected);
                v ? next.add(s.id) : next.delete(s.id);
                onChange(next);
              }}
            />
            <span className="text-sm">{s.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
function BulkOpResults({ results }) {
  return (
    <div className="space-y-1.5 max-h-56 overflow-y-auto">
      {results.map((r, i) => (
        <div key={r.serverId ?? i} className="flex items-center gap-2 text-sm">
          {r.ok ? (
            <Check className="size-3.5 text-success flex-shrink-0" />
          ) : (
            <X className="size-3.5 text-destructive flex-shrink-0" />
          )}
          <span className="truncate">{r.serverName}</span>
          {r.error && (
            <span className="text-[10px] text-destructive truncate ml-auto">
              {r.error}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
function BulkDeleteDialog({
  pluginName,
  pteroServers,
  orgId,
  onClose,
  onSuccess,
}) {
  const [selected, setSelected] = useState(
    () => new Set(pteroServers.map((s) => s.id)),
  );
  const [deleteConfig, setDeleteConfig] = useState(false);
  const [phase, setPhase] = useState("confirm");
  const [results, setResults] = useState([]);

  const handleDelete = async () => {
    setPhase("loading");
    try {
      const res = await fetch(`/api/orgs/${orgId}/ptero-plugin-bulk-delete`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pluginName,
          deleteConfig,
          serverIds: [...selected],
        }),
      });
      const data = await res.json();
      setResults(data.results ?? []);
      setPhase("done");
      if (data.results?.every((r) => r.ok)) onSuccess?.(pluginName);
    } catch (err) {
      setResults([
        { serverName: "Request failed", ok: false, error: err.message },
      ]);
      setPhase("done");
    }
  };

  return (
    <Dialog open onOpenChange={() => phase !== "loading" && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove from servers</DialogTitle>
          <DialogDescription>
            Delete <span className="font-mono">{pluginName}.cs</span> from the
            selected servers.
          </DialogDescription>
        </DialogHeader>
        {phase === "confirm" && (
          <>
            <ServerPicker
              servers={pteroServers}
              selected={selected}
              onChange={setSelected}
            />
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="delete-config"
                checked={deleteConfig}
                onCheckedChange={(v) => setDeleteConfig(!!v)}
              />
              <Label
                htmlFor="delete-config"
                className="text-sm font-normal cursor-pointer"
              >
                Also delete config (
                <span className="font-mono">{pluginName}.json</span>)
              </Label>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={selected.size === 0}
              >
                Remove from {selected.size} server
                {selected.size !== 1 ? "s" : ""}
              </Button>
            </DialogFooter>
          </>
        )}
        {phase === "loading" && (
          <p className="text-sm text-muted-foreground py-2">
            Deleting from {selected.size} server
            {selected.size !== 1 ? "s" : ""}…
          </p>
        )}
        {phase === "done" && (
          <>
            <BulkOpResults results={results} />
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
function BulkUploadDialog({
  fileName,
  content,
  pteroServers,
  orgId,
  onClose,
  onSuccess,
}) {
  const [selected, setSelected] = useState(
    () => new Set(pteroServers.map((s) => s.id)),
  );
  const [phase, setPhase] = useState("confirm");
  const [results, setResults] = useState([]);

  const handleUpload = async () => {
    setPhase("loading");
    const serverIds = [...selected].join(",");
    try {
      const res = await fetch(
        `/api/orgs/${orgId}/ptero-plugin-upload?fileName=${encodeURIComponent(fileName)}&serverIds=${encodeURIComponent(serverIds)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "text/plain" },
          body: content,
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setResults([
          { serverName: data.error ?? `HTTP ${res.status}`, ok: false },
        ]);
      } else {
        setResults(data.results ?? []);
        // New/replaced .cs files on the servers — refresh the plugin list.
        if (data.results?.some((r) => r.ok)) onSuccess?.();
      }
      setPhase("done");
    } catch (err) {
      setResults([
        { serverName: "Request failed", ok: false, error: err.message },
      ]);
      setPhase("done");
    }
  };

  return (
    <Dialog open onOpenChange={() => phase !== "loading" && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload plugin</DialogTitle>
          <DialogDescription>
            Write <span className="font-mono">{fileName}</span> to{" "}
            <span className="font-mono">/oxide/plugins/</span> on the selected
            servers, replacing any existing version.
          </DialogDescription>
        </DialogHeader>
        {phase === "confirm" && (
          <>
            <ServerPicker
              servers={pteroServers}
              selected={selected}
              onChange={setSelected}
            />
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleUpload} disabled={selected.size === 0}>
                Upload to {selected.size} server
                {selected.size !== 1 ? "s" : ""}
              </Button>
            </DialogFooter>
          </>
        )}
        {phase === "loading" && (
          <p className="text-sm text-muted-foreground py-2">
            Uploading to {selected.size} server
            {selected.size !== 1 ? "s" : ""}…
          </p>
        )}
        {phase === "done" && (
          <>
            <BulkOpResults results={results} />
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
function PluginConfigDialog({
  serverId,
  pluginName,
  serverName,
  onClose,
  onSaved,
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setLoading(true);
    setResult(null);
    fetch(
      `/api/servers/${serverId}/ptero-plugin-config/${encodeURIComponent(pluginName)}`,
      { credentials: "include" },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        setContent(d.content ?? "{}");
        setLoading(false);
      })
      .catch(() => {
        setContent("{}");
        setLoading(false);
      });
  }, [serverId, pluginName]);

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch(
        `/api/servers/${serverId}/ptero-plugin-config/${encodeURIComponent(pluginName)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "text/plain" },
          body: content,
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setResult({ error: data.error ?? "Failed to save" });
      } else {
        setResult({
          output: data.rconOutput ?? null,
          rconError: data.rconError ?? null,
        });
        // Config write triggers a plugin reload — refresh status.
        onSaved?.();
      }
    } catch (err) {
      setResult({ error: err.message });
    }
    setSaving(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{pluginName}.json</DialogTitle>
          <DialogDescription>{serverName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading config…</p>
          ) : (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="font-mono text-xs min-h-64 resize-y"
              spellCheck={false}
            />
          )}
          {result && (
            <div
              className={
                "rounded p-2 text-xs font-mono ring-1 " +
                (result.error
                  ? "bg-destructive/10 text-destructive ring-destructive/30"
                  : "bg-surface ring-border text-muted-foreground")
              }
            >
              {result.error && <div>Error: {result.error}</div>}
              {result.rconError && (
                <div className="text-warning">RCON: {result.rconError}</div>
              )}
              {result.output && <div>↳ {result.output}</div>}
              {!result.error && !result.rconError && !result.output && (
                <div className="text-success">Saved successfully</div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving ? "Saving…" : "Save & Reload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function fmtBytes(bytes) {
  if (!bytes || bytes < 0) return "0 MB";
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1048576).toFixed(0)} MB`;
}
function fmtMB(mb) {
  if (!mb) return "∞";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}
// Bandwidth rate (bytes/sec) → human readable. Pterodactyl's network_*_bytes
// are cumulative counters, so a rate is derived from the delta between polls.
function fmtRate(bytesPerSec) {
  const bps = bytesPerSec > 0 ? bytesPerSec : 0;
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}
function fmtUptime(ms) {
  if (!ms || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function StateDot({ state }) {
  const color =
    state === "running"
      ? "bg-success"
      : state === "starting" || state === "stopping"
        ? "bg-warning"
        : state === "offline"
          ? "bg-destructive"
          : "bg-muted-foreground/40";
  return (
    <span
      className={`size-2 rounded-full shrink-0 ${color}`}
      title={state ?? "unknown"}
    />
  );
}
function UsageBar({ value, max, tone = "bg-success" }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = pct > 90 ? "bg-destructive" : pct > 70 ? "bg-warning" : tone;
  return (
    <div className="h-1.5 rounded-full bg-surface ring-1 ring-border overflow-hidden">
      <div className={"h-full " + color} style={{ width: `${pct}%` }} />
    </div>
  );
}
function Spark({ data, dataKey, color }) {
  if (!data || data.length < 2) return <div className="h-8" />;
  const gid = `sp-${dataKey}-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <div className="h-8">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 2, right: 0, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, "auto"]} />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.25}
            fill={`url(#${gid})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
const COUNTRY_NAMES = {
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  NL: "Netherlands",
  SG: "Singapore",
  AU: "Australia",
  JP: "Japan",
  BR: "Brazil",
  CA: "Canada",
  SE: "Sweden",
  PL: "Poland",
  RU: "Russia",
  ZA: "South Africa",
  IN: "India",
  KR: "South Korea",
  FI: "Finland",
  CH: "Switzerland",
};

function rttColor(rtt) {
  if (rtt == null) return "bg-emerald-500/20 text-emerald-400";
  if (rtt < 50) return "bg-emerald-500/25 text-emerald-400";
  if (rtt < 150) return "bg-emerald-500/15 text-emerald-600";
  if (rtt < 300) return "bg-amber-500/20 text-amber-500";
  return "bg-orange-500/20 text-orange-400";
}

// One reachability grid cell, shared by the live snapshot and the history view.
function ReachabilityCell({ r, label }) {
  if (!r) {
    return (
      <td className="px-2 py-2 text-center">
        <span className="inline-block px-1.5 py-0.5 rounded ring-1 ring-border text-muted-foreground/50 font-mono">
          —
        </span>
      </td>
    );
  }
  if (!r.reachable) {
    return (
      <td className="px-2 py-2 text-center">
        <span
          className="inline-block px-1.5 py-0.5 rounded ring-1 ring-red-500/40 bg-red-500/15 text-red-400 font-mono"
          title={`Unreachable from ${label} · ${r.probeCount} probe${r.probeCount === 1 ? "" : "s"} tried`}
        >
          ✕
        </span>
      </td>
    );
  }
  return (
    <td className="px-2 py-2 text-center">
      <span
        className={`inline-block px-1.5 py-0.5 rounded ring-1 font-mono tabular-nums ${rttColor(r.avgRtt)} ring-current/20`}
        title={`${label} · avg ${r.avgRtt?.toFixed(1)} ms · min ${r.minRtt?.toFixed(1)} ms · max ${r.maxRtt?.toFixed(1)} ms · ${r.reachableCount}/${r.probeCount} probes`}
      >
        {r.avgRtt != null ? `${Math.round(r.avgRtt)}ms` : "ok"}
      </span>
    </td>
  );
}

// SVG fill class for a latency dot, mirroring rttColor's thresholds.
function rttDotColor(rtt) {
  if (rtt == null) return "fill-emerald-400";
  if (rtt < 50) return "fill-emerald-400";
  if (rtt < 150) return "fill-emerald-500";
  if (rtt < 300) return "fill-amber-500";
  return "fill-orange-400";
}

// World map plotting per-country latency to one server at a single point in
// time. Reachable probe origins get a latency-coloured dot (larger = slower);
// origins where the server was unreachable are flagged red so you can see from
// where the server may be inaccessible.
function WorldLatencyMap({ snapshot, countries }) {
  const cells = snapshot?.cells ?? {};
  const points = countries
    .map((cc) => {
      const c = COUNTRY_CENTROIDS[cc];
      if (!c) return null;
      return {
        cc,
        x: c.x,
        y: c.y,
        name: COUNTRY_NAMES[cc] ?? c.name ?? cc,
        r: cells[cc] ?? null,
      };
    })
    .filter(Boolean);

  return (
    <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
      <svg
        viewBox={`0 0 ${WORLD_MAP_WIDTH} ${WORLD_MAP_HEIGHT}`}
        className="w-full h-auto block"
        role="img"
        aria-label="World map of server latency by probe country"
      >
        <path
          d={WORLD_LAND_PATH}
          className="fill-foreground/10 stroke-border"
          strokeWidth={0.5}
        />
        {points.map((p) => {
          if (!p.r) {
            return (
              <circle
                key={p.cc}
                cx={p.x}
                cy={p.y}
                r={3}
                className="fill-muted-foreground/30 stroke-background"
                strokeWidth={0.5}
              >
                <title>{`${p.name}: no data`}</title>
              </circle>
            );
          }
          if (!p.r.reachable) {
            return (
              <g key={p.cc}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={10}
                  className="fill-red-500/25 animate-pulse"
                />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={5}
                  className="fill-red-500 stroke-background"
                  strokeWidth={0.8}
                />
                <path
                  d={`M${p.x - 2.2} ${p.y - 2.2}L${p.x + 2.2} ${p.y + 2.2}M${p.x + 2.2} ${p.y - 2.2}L${p.x - 2.2} ${p.y + 2.2}`}
                  className="stroke-white"
                  strokeWidth={1}
                  strokeLinecap="round"
                />
                <title>{`${p.name}: unreachable (${p.r.probeCount} probe${p.r.probeCount === 1 ? "" : "s"} tried)`}</title>
              </g>
            );
          }
          const radius =
            p.r.avgRtt == null
              ? 4
              : Math.max(3.5, Math.min(8, 3.5 + p.r.avgRtt / 80));
          return (
            <g key={p.cc}>
              <circle
                cx={p.x}
                cy={p.y}
                r={radius}
                className={`${rttDotColor(p.r.avgRtt)} stroke-background`}
                strokeWidth={0.8}
                opacity={0.9}
              />
              <title>{`${p.name}: ${p.r.avgRtt != null ? Math.round(p.r.avgRtt) + " ms avg" : "reachable"} (min ${p.r.minRtt != null ? p.r.minRtt.toFixed(0) : "—"} / max ${p.r.maxRtt != null ? p.r.maxRtt.toFixed(0) : "—"} ms, ${p.r.reachableCount}/${p.r.probeCount} probes)`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function WorldPlayerMap({ players }) {
  // Prefer precise proxycheck lat/long when we have it (plot at the real
  // connection point), clustering co-located players to ~1° cells so dense
  // regions stay readable. Players without geo fall back to a country centroid;
  // those without even a country are surfaced as an "unknown" count.
  const clusters = new Map();
  let unknownCount = 0;
  for (const p of players) {
    let key, x, y, label;
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      const rLat = Math.round(p.lat);
      const rLng = Math.round(p.lng);
      key = `geo:${rLat}:${rLng}`;
      const proj = projectLatLng(rLat, rLng);
      x = proj.x;
      y = proj.y;
      label = p.country
        ? COUNTRY_NAMES[p.country] ?? p.country
        : `${rLat}, ${rLng}`;
    } else if (p.country && COUNTRY_CENTROIDS[p.country]) {
      const c = COUNTRY_CENTROIDS[p.country];
      key = `cc:${p.country}`;
      x = c.x;
      y = c.y;
      label = COUNTRY_NAMES[p.country] ?? c.name ?? p.country;
    } else {
      unknownCount += 1;
      continue;
    }
    const entry = clusters.get(key) ?? { x, y, label, players: [] };
    entry.players.push(p);
    clusters.set(key, entry);
  }

  const points = [...clusters.entries()].map(([id, e]) => ({
    id,
    ...e,
    count: e.players.length,
  }));

  return (
    <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden relative">
      <svg
        viewBox={`0 0 ${WORLD_MAP_WIDTH} ${WORLD_MAP_HEIGHT}`}
        className="w-full h-auto block"
        role="img"
        aria-label="World map of online player locations"
      >
        <path
          d={WORLD_LAND_PATH}
          className="fill-foreground/10 stroke-border"
          strokeWidth={0.5}
        />
        {points.map((p) => {
          const radius = Math.max(4, Math.min(12, 4 + Math.log(p.count + 1) * 3));
          return (
            <g key={p.id}>
              <circle cx={p.x} cy={p.y} r={radius * 1.8} className="fill-emerald-500/15" />
              <circle
                cx={p.x}
                cy={p.y}
                r={radius}
                className="fill-emerald-400 stroke-background"
                strokeWidth={0.8}
                opacity={0.9}
              />
              {p.count > 1 && (
                <text
                  x={p.x}
                  y={p.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={Math.max(4, radius * 0.85)}
                  fontWeight="bold"
                  className="fill-background select-none"
                >
                  {p.count}
                </text>
              )}
              <title>{`${p.label}: ${p.count} player${p.count === 1 ? "" : "s"}`}</title>
            </g>
          );
        })}
      </svg>
      {unknownCount > 0 && (
        <div className="absolute bottom-2 right-2 text-[9px] font-mono text-muted-foreground bg-surface/80 px-1.5 py-0.5 rounded ring-1 ring-border">
          +{unknownCount} · unknown location
        </div>
      )}
    </div>
  );
}

function GlobalpingSection({ orgId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [triggering, setTriggering] = useState(false);
  const [secsLeft, setSecsLeft] = useState(null);
  const [mapServerId, setMapServerId] = useState("");
  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [snapIndex, setSnapIndex] = useState(0);
  const [playerMode, setPlayerMode] = useState(false);
  const [playerData, setPlayerData] = useState(null);
  const [playerLoading, setPlayerLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/globalping/results`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const body = await res.json();
      setData(body);
      setUpdatedAt(Date.now());
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const loadPlayers = useCallback(async () => {
    setPlayerLoading(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/player-list`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      setPlayerData(await res.json());
    } catch {
      // non-critical
    } finally {
      setPlayerLoading(false);
    }
  }, [orgId]);

  const trigger = useCallback(async () => {
    setTriggering(true);
    try {
      await fetch(`/api/orgs/${encodeURIComponent(orgId)}/globalping/trigger`, {
        method: "POST",
        credentials: "include",
      });
      await load();
    } catch {
      // non-critical
    } finally {
      setTriggering(false);
    }
  }, [orgId, load]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (updatedAt === null) return;
    const tick = () => {
      const ms = updatedAt + 5 * 60 * 1000 - Date.now();
      setSecsLeft(Math.max(0, Math.ceil(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [updatedAt]);

  const loadHistory = useCallback(
    async (serverId) => {
      if (!serverId) {
        setHistory(null);
        return;
      }
      setHistoryLoading(true);
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/globalping/history?serverId=${encodeURIComponent(serverId)}`,
          { credentials: "include" },
        );
        setHistory(res.ok ? await res.json() : null);
      } catch {
        setHistory(null);
      } finally {
        setHistoryLoading(false);
      }
    },
    [orgId],
  );

  // Default the map to the first server once data arrives.
  useEffect(() => {
    if (data?.servers?.length && !mapServerId) {
      setMapServerId(data.servers[0].serverId);
    }
  }, [data, mapServerId]);

  // Refetch history for the mapped server, also when the live data refreshes.
  useEffect(() => {
    loadHistory(mapServerId);
  }, [mapServerId, loadHistory, updatedAt]);

  // Snap the time slider to the newest sample whenever history (re)loads.
  useEffect(() => {
    const n = history?.snapshots?.length ?? 0;
    setSnapIndex(n > 0 ? n - 1 : 0);
  }, [history]);

  if (loading) return null;
  if (!data?.configured) {
    return (
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold">Network Reachability</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Globalping monitoring is not configured for this org. Enable it in
            Manage → Details.
          </p>
        </div>
      </div>
    );
  }

  const { servers = [], results = [], countries = [], pendingCount = 0 } = data;

  if (!servers.length) {
    return (
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-4">
        <p className="text-xs font-semibold mb-1">Network Reachability</p>
        <p className="text-[11px] text-muted-foreground">
          No servers with RCON/IP configured. Set an RCON host on your servers
          to enable network monitoring.
        </p>
      </div>
    );
  }

  const resultMap = new Map();
  for (const r of results) {
    resultMap.set(`${r.serverId}:${r.country}`, r);
  }

  const hasAnyResult = results.length > 0;

  // Chronological snapshots (history is newest-first) for the time slider, only
  // when they belong to the currently-selected server.
  const snaps =
    history && history.serverId === mapServerId
      ? [...history.snapshots].reverse()
      : [];
  const safeIndex = Math.min(snapIndex, Math.max(0, snaps.length - 1));
  const currentSnap = snaps[safeIndex] ?? null;
  const mapCountries = history?.countries ?? countries;
  const mapServerName =
    servers.find((s) => s.serverId === mapServerId)?.serverName ?? "";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          Network reachability · Globalping
        </h4>
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <span className="text-[10px] font-mono text-amber-500 flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
              {pendingCount} measurement{pendingCount === 1 ? "" : "s"} in
              progress
            </span>
          )}
          {updatedAt && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {new Date(updatedAt).toLocaleTimeString()}
            </span>
          )}
          <select
            value={mapServerId || servers[0]?.serverId || ""}
            onChange={(e) => setMapServerId(e.target.value)}
            title="Server to plot on the map"
            className="h-6 rounded ring-1 ring-border bg-surface px-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring [&>option]:bg-surface [&>option]:text-foreground [&>option]:normal-case"
          >
            {(playerMode ? (playerData?.servers ?? servers) : servers).map((s) => (
              <option key={s.serverId} value={s.serverId}>
                {s.serverName}
              </option>
            ))}
          </select>
          {triggering ? (
            <span className="text-[10px] font-mono uppercase tracking-widest text-amber-500 flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-amber-500 animate-pulse inline-block" />
              Running…
            </span>
          ) : secsLeft !== null ? (
            <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
              next in {Math.floor(secsLeft / 60)}:
              {String(secsLeft % 60).padStart(2, "0")}
            </span>
          ) : null}
          <button
            onClick={load}
            className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <RefreshCw className="size-3" /> Refresh
          </button>
          <button
            onClick={() => {
              const next = !playerMode;
              setPlayerMode(next);
              if (next) loadPlayers();
            }}
            className={`text-[10px] font-mono uppercase tracking-widest flex items-center gap-1 transition-colors ${
              playerMode
                ? "text-emerald-400 hover:text-emerald-300"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Users className="size-3" /> {playerMode ? "Latency" : "Players"}
          </button>
        </div>
      </div>

      {/* World latency map / player map for the selected server */}
      <div className="space-y-1.5">
        <div className="relative">
          {playerMode ? (
            <>
              <WorldPlayerMap
                players={(playerData?.players ?? []).filter(
                  (p) => p.isOnline && (!mapServerId || p.serverId === mapServerId),
                )}
              />
              {playerLoading && (
                <div className="absolute inset-0 grid place-items-center text-[11px] font-mono text-muted-foreground bg-background/40">
                  Loading players…
                </div>
              )}
            </>
          ) : (
            <>
              <WorldLatencyMap snapshot={currentSnap} countries={mapCountries} />
              {historyLoading && !snaps.length && (
                <div className="absolute inset-0 grid place-items-center text-[11px] font-mono text-muted-foreground bg-background/40">
                  Loading history…
                </div>
              )}
              {!historyLoading && !snaps.length && (
                <div className="absolute inset-0 grid place-items-center text-center text-[11px] font-mono text-muted-foreground bg-background/40 px-4">
                  No measurement history yet for {mapServerName || "this server"}.
                  Measurements run every few minutes — check back shortly.
                </div>
              )}
            </>
          )}
        </div>
        {!playerMode && snaps.length > 1 && (
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap tabular-nums">
              {currentSnap
                ? new Date(currentSnap.measuredAt * 1000).toLocaleString()
                : "—"}
            </span>
            <input
              type="range"
              min={0}
              max={snaps.length - 1}
              value={safeIndex}
              onChange={(e) => setSnapIndex(Number(e.target.value))}
              aria-label="Latency history time"
              className="flex-1 accent-emerald-500"
            />
            <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">
              {safeIndex >= snaps.length - 1
                ? "Latest"
                : `${snaps.length - 1 - safeIndex} step${snaps.length - 1 - safeIndex === 1 ? "" : "s"} back`}
            </span>
          </div>
        )}
      </div>

      {!hasAnyResult && !pendingCount ? (
        <div className="ring-1 ring-border rounded-md bg-surface/40 px-4 py-3 text-[11px] text-muted-foreground">
          Waiting for first measurement results. Measurements run every 5
          minutes — check back shortly.
        </div>
      ) : (
        <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-border bg-surface/60">
                <th className="text-left px-3 py-2 font-mono uppercase tracking-widest text-muted-foreground whitespace-nowrap">
                  Server
                </th>
                {countries.map((cc) => (
                  <th
                    key={cc}
                    className="px-2 py-2 font-mono uppercase tracking-widest text-muted-foreground whitespace-nowrap text-center"
                    title={COUNTRY_NAMES[cc] ?? cc}
                  >
                    {cc}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {servers.map((s, i) => (
                <tr
                  key={s.serverId}
                  className={
                    i < servers.length - 1 ? "border-b border-border" : ""
                  }
                >
                  <td className="px-3 py-2 font-medium whitespace-nowrap">
                    <div className="flex flex-col gap-0.5">
                      <span>{s.serverName}</span>
                      <span className="text-[9px] font-mono text-muted-foreground">
                        {s.rconHost}
                      </span>
                    </div>
                  </td>
                  {countries.map((cc) => (
                    <ReachabilityCell
                      key={cc}
                      r={resultMap.get(`${s.serverId}:${cc}`)}
                      label={COUNTRY_NAMES[cc] ?? cc}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-4 text-[10px] text-muted-foreground font-mono">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-emerald-500/25 ring-1 ring-emerald-500/30" />
          &lt;50 ms
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-emerald-500/15 ring-1 ring-emerald-500/20" />
          50–150 ms
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-amber-500/20 ring-1 ring-amber-500/30" />
          150–300 ms
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-orange-500/20 ring-1 ring-orange-500/30" />
          &gt;300 ms
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-red-500/15 ring-1 ring-red-500/40" />
          unreachable
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded ring-1 ring-border" />
          no data
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground/70 font-mono">
        Results are averaged across {data.probesPerCountry ?? "multiple"} probe
        {(data.probesPerCountry ?? 2) === 1 ? "" : "s"} per country.
        Measurements run periodically via the Globalping network. Hover a cell
        for per-probe detail.
      </p>
    </div>
  );
}

function NotificationToggle({ orgId }) {
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/notification-prefs`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => {});
  }, [orgId]);

  const toggle = async () => {
    if (busy || enabled === null) return;
    setBusy(true);
    const next = !enabled;
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/notification-prefs`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        },
      );
      if (res.ok) setEnabled(next);
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) return null;
  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={enabled ? "Disable Discord DM alerts for this org" : "Enable Discord DM alerts for this org"}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium ring-1 transition-colors ${
        enabled
          ? "ring-brand/40 bg-brand/10 text-brand hover:bg-brand/20"
          : "ring-border text-muted-foreground hover:text-foreground hover:bg-surface/50"
      }`}
    >
      {enabled ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
      {enabled ? "Alerts on" : "Alerts off"}
    </button>
  );
}

function StatusTab({ orgId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const historyRef = useRef(new Map());
  // Previous network counter sample per server, used to derive a live rate.
  const netSamplesRef = useRef(new Map());

  const pushHistory = useCallback((identifier, cpu, memPct) => {
    const hist = historyRef.current;
    const arr = hist.get(identifier) ?? [];
    arr.push({ cpu: Number(cpu.toFixed(2)), mem: Number(memPct.toFixed(2)) });
    while (arr.length > 30) arr.shift();
    hist.set(
      identifier,
      arr.map((p, i) => ({ ...p, i })),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ptero/status`,
        { credentials: "include" },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? `Failed to load status (HTTP ${res.status}).`);
        return;
      }
      setError("");

      // Derive a live bandwidth rate (bytes/sec) per container from the delta
      // between this poll and the previous one. The counters reset to a lower
      // value when a server restarts, so a decrease is treated as 0.
      if (Array.isArray(body?.servers)) {
        const now = Date.now();
        const samples = netSamplesRef.current;
        for (const s of body.servers) {
          if (!s.identifier || !s.live) continue;
          const rx = s.live.resources.networkRxBytes ?? 0;
          const tx = s.live.resources.networkTxBytes ?? 0;
          const prev = samples.get(s.identifier);
          if (prev && now > prev.t) {
            const dt = (now - prev.t) / 1000;
            s.live.rxRate = rx >= prev.rx ? (rx - prev.rx) / dt : 0;
            s.live.txRate = tx >= prev.tx ? (tx - prev.tx) / dt : 0;
          } else {
            s.live.rxRate = 0;
            s.live.txRate = 0;
          }
          samples.set(s.identifier, { t: now, rx, tx });
        }
      }

      setData(body);
      setUpdatedAt(Date.now());

      // Maintain a short rolling history per server for the live sparklines.
      if (Array.isArray(body?.servers)) {
        const hist = historyRef.current;
        for (const s of body.servers) {
          if (!s.identifier || !s.live) continue;
          const limitBytes = (s.limits?.memory ?? 0) * 1048576;
          const memPct =
            limitBytes > 0
              ? (s.live.resources.memoryBytes / limitBytes) * 100
              : 0;
          const arr = hist.get(s.identifier) ?? [];
          arr.push({
            cpu: Number((s.live.resources.cpuAbsolute ?? 0).toFixed(2)),
            mem: Number(memPct.toFixed(2)),
          });
          while (arr.length > 30) arr.shift();
          hist.set(
            s.identifier,
            arr.map((p, i) => ({ ...p, i })),
          );
        }
      }
    } catch {
      setError("Network error reaching the status service.");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setError("");
    historyRef.current = new Map();
    netSamplesRef.current = new Map();
    load();
    let id = setInterval(load, 8000);

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearInterval(id);
      } else {
        load();
        id = setInterval(load, 8000);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [load]);

  const servers = data?.servers ?? [];
  const nodes = data?.nodes ?? [];

  const nodeAgg = useMemo(() => {
    const map = new Map();
    for (const s of servers) {
      const key = s.nodeId ?? s.nodeName ?? "unknown";
      const agg = map.get(key) ?? {
        count: 0,
        running: 0,
        allocMem: 0,
        allocDisk: 0,
        allocCpu: 0,
        usedMemBytes: 0,
        usedDiskBytes: 0,
        usedCpu: 0,
        rxRate: 0,
        txRate: 0,
        hasUsage: false,
      };
      agg.count += 1;
      agg.allocMem += s.limits?.memory ?? 0;
      agg.allocDisk += s.limits?.disk ?? 0;
      agg.allocCpu += s.limits?.cpu ?? 0;
      const state = s.live?.state ?? (s.suspended ? "offline" : "unknown");
      if (state === "running") agg.running += 1;
      const usedMem = s.live?.resources.memoryBytes;
      const usedDisk = s.live?.resources.diskBytes;
      const usedCpu = s.live?.resources.cpuAbsolute;
      if (usedMem != null) {
        agg.usedMemBytes += usedMem;
        agg.hasUsage = true;
      }
      if (usedDisk != null) {
        agg.usedDiskBytes += usedDisk;
      }
      if (usedCpu != null) agg.usedCpu += usedCpu;
      agg.rxRate += s.live?.rxRate ?? 0;
      agg.txRate += s.live?.txRate ?? 0;
      map.set(key, agg);
    }
    return map;
  }, [servers]);

  if (loading && !data) {
    return (
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-10 text-center text-sm text-muted-foreground">
        Loading server status…
      </div>
    );
  }

  if (data && data.connected === false) {
    return (
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-8 text-center space-y-2">
        <Server className="size-8 mx-auto text-muted-foreground" />
        <h3 className="text-base font-semibold">Pterodactyl not connected</h3>
        <p className="text-sm text-muted-foreground">
          Connect this org's Pterodactyl panel in the{" "}
          <span className="font-mono text-foreground">Servers</span> tab to see
          live node and server status here.
        </p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="ring-1 ring-destructive/40 bg-destructive/10 rounded-md p-6 text-center space-y-2">
        <AlertTriangle className="size-7 mx-auto text-destructive" />
        <p className="text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => load()}>
          <RefreshCw className="size-3.5 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Globalping reachability — world latency map at the top of the page */}
      <GlobalpingSection orgId={orgId} />

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          Pterodactyl infrastructure · {nodes.length} node
          {nodes.length === 1 ? "" : "s"} · {servers.length} server
          {servers.length === 1 ? "" : "s"}
        </h3>
        <div className="flex items-center gap-3">
          <NotificationToggle orgId={orgId} />
          {updatedAt && (
            <span className="text-[10px] font-mono text-muted-foreground">
              Updated {new Date(updatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => load()}
            className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground flex items-center gap-1"
            title="Refresh now"
          >
            <RefreshCw className="size-3" /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-warning font-mono">
          {error} (showing last known data)
        </p>
      )}

      {data && data.liveSupported === false && (
        <div className="ring-1 ring-border rounded-md bg-surface/40 px-3 py-2 text-[11px] text-muted-foreground">
          Live utilization is unavailable — the stored Pterodactyl key is an
          application key, so only configured limits are shown. Provide a client
          API key to enable live CPU/RAM/uptime.
        </div>
      )}

      {/* Nodes */}
      <div>
        <h4 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
          Nodes
        </h4>
        {nodes.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No nodes returned by the panel.
          </p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {nodes.map((n) => {
              const agg = nodeAgg.get(n.id) ??
                nodeAgg.get(n.name) ?? {
                  count: 0,
                  running: 0,
                  allocMem: 0,
                  allocDisk: 0,
                  allocCpu: 0,
                  usedMemBytes: 0,
                  usedDiskBytes: 0,
                  usedCpu: 0,
                  rxRate: 0,
                  txRate: 0,
                  hasUsage: false,
                };
              const memCap = n.memory * (1 + (n.memoryOverallocate || 0) / 100);
              const diskCap = n.disk * (1 + (n.diskOverallocate || 0) / 100);
              return (
                <div
                  key={n.id}
                  className="ring-1 ring-border rounded-md bg-surface/40 p-3 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Server className="size-3.5 text-brand shrink-0" />
                      <span className="text-sm font-semibold truncate">
                        {n.name}
                      </span>
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        n.maintenanceMode
                          ? "border-warning/40 text-warning bg-warning/10 text-[9px]"
                          : n.online === false
                            ? "border-destructive/40 text-destructive bg-destructive/10 text-[9px]"
                            : "border-success/40 text-success bg-success/10 text-[9px]"
                      }
                    >
                      {n.maintenanceMode
                        ? "maintenance"
                        : n.online === false
                          ? "offline"
                          : "online"}
                    </Badge>
                  </div>

                  {n.fqdn && (
                    <div className="text-[10px] font-mono text-muted-foreground truncate">
                      {n.fqdn}
                    </div>
                  )}

                  {agg.hasUsage && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-muted-foreground uppercase tracking-widest">
                          CPU used
                        </span>
                        {/* Pterodactyl reports cpu_absolute as percent-of-one-core
                            (100% = 1 core), so the per-node sum is total cores in
                            use. Showing it as cores avoids a misleading "650%".
                            Allocation is the summed per-server cpu limit, also in
                            core-equivalents. */}
                        <span className="text-muted-foreground tabular-nums">
                          {(agg.usedCpu / 100).toFixed(2)} cores
                          {agg.allocCpu > 0
                            ? ` / ${(agg.allocCpu / 100).toFixed(1)}`
                            : ""}
                        </span>
                      </div>
                      <UsageBar
                        value={agg.usedCpu}
                        max={agg.allocCpu > 0 ? agg.allocCpu : agg.count * 100}
                        tone="bg-sky-500"
                      />
                    </div>
                  )}

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-mono">
                      <span className="text-muted-foreground uppercase tracking-widest">
                        {agg.hasUsage ? "Memory used" : "Memory allocated"}
                      </span>
                      <span className="text-muted-foreground">
                        {agg.hasUsage
                          ? `${fmtBytes(agg.usedMemBytes)} / ${fmtMB(memCap)}`
                          : `${fmtMB(agg.allocMem)} / ${fmtMB(memCap)}`}
                      </span>
                    </div>
                    <UsageBar
                      value={agg.hasUsage ? agg.usedMemBytes : agg.allocMem}
                      max={agg.hasUsage ? memCap * 1048576 : memCap}
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-mono">
                      <span className="text-muted-foreground uppercase tracking-widest">
                        {agg.hasUsage ? "Disk used" : "Disk allocated"}
                      </span>
                      <span className="text-muted-foreground">
                        {agg.hasUsage
                          ? `${fmtBytes(agg.usedDiskBytes)} / ${fmtMB(diskCap)}`
                          : `${fmtMB(agg.allocDisk)} / ${fmtMB(diskCap)}`}
                      </span>
                    </div>
                    <UsageBar
                      value={agg.hasUsage ? agg.usedDiskBytes : agg.allocDisk}
                      max={agg.hasUsage ? diskCap * 1048576 : diskCap}
                      tone="bg-brand"
                    />
                  </div>

                  {agg.hasUsage && (
                    <div className="flex items-center justify-between text-[10px] font-mono">
                      <span className="text-muted-foreground uppercase tracking-widest">
                        Network
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        ↓ {fmtRate(agg.rxRate)} · ↑ {fmtRate(agg.txRate)}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground pt-1 border-t border-border">
                    <span>
                      HOSTING{" "}
                      <span className="text-foreground">{agg.count}</span>{" "}
                      server
                      {agg.count === 1 ? "" : "s"}
                    </span>
                    {agg.hasUsage && (
                      <span>
                        <span className="text-success">{agg.running}</span>{" "}
                        running
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* Game servers */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Game servers ({servers.length})
          </h4>
          <div className="text-[10px] font-mono text-muted-foreground flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-success" /> running
            </span>
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-warning" /> starting
            </span>
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-destructive" /> offline
            </span>
          </div>
        </div>

        {servers.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No registered IronSight servers found. Link a Pterodactyl server to
            an IronSight server in the{" "}
            <span className="font-mono text-foreground">Servers</span> tab.
          </p>
        ) : (
          <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
            <div className="grid grid-cols-[1.5fr_0.7fr_1fr_1.1fr_0.8fr_0.9fr_0.6fr_auto] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
              <div>Server</div>
              <div>Node</div>
              <div>CPU</div>
              <div>Memory</div>
              <div>Disk</div>
              <div>Network</div>
              <div className="text-right">Uptime</div>
              <div />
            </div>
            {servers.map((s) => {
              const hist = historyRef.current.get(s.identifier) ?? [];
              const memLimitBytes = (s.limits?.memory ?? 0) * 1048576;

              const state =
                s.live?.state ?? (s.suspended ? "offline" : "unknown");
              const hasStats = !!s.live;
              const cpu = s.live?.resources.cpuAbsolute;
              const memBytes = s.live?.resources.memoryBytes;
              const diskBytes = s.live?.resources.diskBytes;
              const uptime = s.live?.resources.uptime;
              const rxRate = s.live?.rxRate ?? 0;
              const txRate = s.live?.txRate ?? 0;

              return (
                <Fragment key={s.uuid ?? s.identifier ?? s.pteroId}>
                  <div className="grid grid-cols-[1.5fr_0.7fr_1fr_1.1fr_0.8fr_0.9fr_0.6fr_auto] gap-2 px-3 py-2 border-b border-border items-center text-[11px] hover:bg-surface/40">
                    <div className="flex items-center gap-2 min-w-0">
                      <StateDot state={state} />
                      <span className="font-medium truncate">{s.name}</span>
                      {s.suspended && (
                        <span className="text-[8px] font-mono uppercase tracking-widest text-destructive bg-destructive/10 px-1 rounded shrink-0">
                          suspended
                        </span>
                      )}
                      <PingBadge
                        lastHealthPing={s.lastHealthPing}
                        className="shrink-0"
                      />
                      <span className="text-[9px] font-mono text-muted-foreground truncate">
                        {s.ip ? `${s.ip}:${s.port ?? ""}` : ""}
                      </span>
                    </div>

                    <div className="text-[10px] font-mono text-muted-foreground truncate">
                      {s.nodeName ?? "—"}
                    </div>

                    <div className="min-w-0">
                      {hasStats ? (
                        <div className="flex items-center gap-1.5">
                          <Cpu className="size-3 text-muted-foreground shrink-0" />
                          <span className="font-mono tabular-nums">
                            {(cpu ?? 0).toFixed(1)}%
                          </span>
                          <span className="text-[9px] font-mono text-muted-foreground">
                            / {s.limits?.cpu ? `${s.limits.cpu}%` : "∞"}
                          </span>
                          <div className="flex-1 min-w-[28px]">
                            <Spark
                              data={hist}
                              dataKey="cpu"
                              color="hsl(200 90% 60%)"
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-[10px] font-mono text-muted-foreground">
                          limit {s.limits?.cpu ? `${s.limits.cpu}%` : "∞"}
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 space-y-1">
                      {hasStats ? (
                        <>
                          <div className="flex items-center gap-1.5">
                            <HardDrive className="size-3 text-muted-foreground shrink-0" />
                            <span className="font-mono tabular-nums">
                              {fmtBytes(memBytes ?? 0)}
                            </span>
                            <span className="text-[9px] font-mono text-muted-foreground">
                              / {fmtMB(s.limits?.memory ?? 0)}
                            </span>
                          </div>
                          <UsageBar value={memBytes ?? 0} max={memLimitBytes} />
                        </>
                      ) : (
                        <span className="text-[10px] font-mono text-muted-foreground">
                          limit {fmtMB(s.limits?.memory ?? 0)}
                        </span>
                      )}
                    </div>

                    <div className="min-w-0">
                      {hasStats ? (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono tabular-nums">
                            {fmtBytes(diskBytes ?? 0)}
                          </span>
                          <span className="text-[9px] font-mono text-muted-foreground">
                            / {fmtMB(s.limits?.disk ?? 0)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[10px] font-mono text-muted-foreground">
                          limit {fmtMB(s.limits?.disk ?? 0)}
                        </span>
                      )}
                    </div>

                    <div className="min-w-0">
                      {hasStats ? (
                        <div className="flex flex-col gap-0.5 font-mono text-[10px] tabular-nums leading-tight">
                          <span
                            className="text-muted-foreground"
                            title="Inbound (download)"
                          >
                            ↓ {fmtRate(rxRate)}
                          </span>
                          <span
                            className="text-muted-foreground"
                            title="Outbound (upload)"
                          >
                            ↑ {fmtRate(txRate)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[10px] font-mono text-muted-foreground">
                          —
                        </span>
                      )}
                    </div>

                    <div className="text-right font-mono text-[10px] text-muted-foreground">
                      {hasStats ? fmtUptime(uptime) : "—"}
                    </div>

                    <div />
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
        <div className="text-[10px] text-muted-foreground/70 font-mono mt-1.5">
          CPU, memory, disk, network and uptime come from the Pterodactyl client
          API and refresh every 8s. Memory and disk are shown against each
          server's configured limit; network is the live in/out rate derived
          from the cumulative byte counters between refreshes.
        </div>
      </div>
    </div>
  );
}
function ServersTab({ orgId, onServerUpdate }) {
  const tz = useTimezone();
  const [pteroStatus, setPteroStatus] = useState(null); // null=loading, {connected,panelUrl}
  const [pteroForm, setPteroForm] = useState({ panelUrl: "", apiKey: "" });
  const [pteroSaving, setPteroSaving] = useState(false);
  const [pteroError, setPteroError] = useState(null);

  const [pteroServers, setPteroServers] = useState(null); // null=not fetched
  const [pteroLoading, setPteroLoading] = useState(false);
  const [pteroFetchError, setPteroFetchError] = useState(null);

  const [registeredServers, setRegisteredServers] = useState([]);
  const [regLoading, setRegLoading] = useState(true);

  const [importing, setImporting] = useState(null);
  const [apiKeyReveal, setApiKeyReveal] = useState(null);

  const [deleteConfirm, setDeleteConfirm] = useState(null); // { serverId, serverName }
  const [deleting, setDeleting] = useState(null);
  const [rotatingKey, setRotatingKey] = useState(null);
  const [rotatedKeyReveal, setRotatedKeyReveal] = useState(null); // { apiKey, serverName }
  const [rotateKeyConfirm, setRotateKeyConfirm] = useState(null); // { serverId, serverName }

  const [rconConfigFor, setRconConfigFor] = useState(null); // { serverId, serverName, rconHost, rconPort, gamePort, tags }
  const [rconSavingFor, setRconSavingFor] = useState(null);
  const [rconSaveError, setRconSaveError] = useState(null);

  const saveRconConfig = async (serverId, form) => {
    setRconSavingFor(serverId);
    setRconSaveError(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/rcon`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setRconSaveError(data?.error ?? "Failed to save");
        return;
      }
      const testPassed = data.testPassed ?? null;
      setRegisteredServers((prev) =>
        prev.map((s) =>
          s.serverId === serverId
            ? {
                ...s,
                rconHost: form.rconHost,
                rconPort: form.rconPort,
                gamePort: form.gamePort ?? s.gamePort,
                tags: form.tags ?? s.tags,
                rconConfigured: true,
                rconWorking: testPassed,
              }
            : s,
        ),
      );
      onServerUpdate?.((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? {
                ...s,
                ip: form.rconHost ?? s.ip,
                rconPort: form.rconPort ?? s.rconPort,
                port: form.gamePort ?? s.port,
                tags: form.tags ?? s.tags,
                rconConfigured: true,
                rconWorking: testPassed,
              }
            : s,
        ),
      );
      setRconConfigFor(null);
    } catch {
      setRconSaveError("Network error");
    } finally {
      setRconSavingFor(null);
    }
  };

  // Load ptero connection status
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/orgs/${orgId}/ptero`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (!cancelled) setPteroStatus(d);
      })
      .catch(() => {
        if (!cancelled) setPteroStatus({ connected: false });
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const loadRegistered = () => {
    setRegLoading(true);
    fetch("/api/servers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) =>
        setRegisteredServers(
          (d.servers ?? []).filter((s) => s.ownerOrgId === orgId),
        ),
      )
      .catch(() => setRegisteredServers([]))
      .finally(() => setRegLoading(false));
  };
  useEffect(() => {
    loadRegistered();
  }, [orgId]);

  const savePtero = async () => {
    setPteroSaving(true);
    setPteroError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}/ptero`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pteroForm),
      });
      const data = await res.json();
      if (!res.ok) {
        setPteroError(data?.error ?? "Failed to save");
        return;
      }
      setPteroStatus({ connected: true, panelUrl: data.panelUrl });
      setPteroForm({ panelUrl: "", apiKey: "" });
    } catch {
      setPteroError("Network error");
    } finally {
      setPteroSaving(false);
    }
  };

  const disconnectPtero = async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/ptero`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPteroError(data?.error ?? "Failed to disconnect");
        return;
      }
      setPteroStatus({ connected: false });
      setPteroServers(null);
    } catch {
      setPteroError("Network error");
    }
  };

  const fetchPteroServers = async () => {
    setPteroLoading(true);
    setPteroFetchError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}/ptero/servers`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setPteroFetchError(data?.error ?? "Failed to fetch");
        return;
      }
      setPteroServers(data.servers ?? []);
    } catch {
      setPteroFetchError("Network error");
    } finally {
      setPteroLoading(false);
    }
  };

  const importServer = async (pteroServer) => {
    setImporting(pteroServer.pteroId);
    try {
      const res = await fetch(`/api/orgs/${orgId}/ptero/servers/import`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverName: pteroServer.name,
          pteroIdentifier: pteroServer.identifier,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error ?? "Import failed");
        return;
      }
      setApiKeyReveal({
        serverId: data.server.serverId,
        serverName: pteroServer.name,
        apiKey: data.apiKey,
      });
      // Update local registered list directly so importedIdentifiers reflects
      // the new server immediately (GET /api/servers has a 30s Redis cache).
      setRegisteredServers((prev) =>
        prev.some((s) => s.serverId === data.server.serverId)
          ? prev
          : [
              ...prev,
              {
                serverId: data.server.serverId,
                serverName: data.server.serverName,
                ownerOrgId: data.server.ownerOrgId,
                pteroIdentifier: data.server.pteroIdentifier,
                rconConfigured: data.server.rconConfigured ?? false,
                rconHost: data.server.rconHost ?? null,
                rconPort: data.server.rconPort ?? null,
                gamePort: data.server.gamePort ?? null,
                tags: [],
                lastHealthPing: null,
                createdAt: null,
              },
            ],
      );
      // Keep the parent's shared server list in sync so sibling tabs (RCON,
      // presets, status) see the newly imported server immediately.
      onServerUpdate?.((prev) =>
        prev.some((s) => s.id === data.server.serverId)
          ? prev
          : [
              ...prev,
              {
                id: data.server.serverId,
                name: pteroServer.name,
                ownerOrgId: orgId,
                ip: data.server.rconHost ?? "",
                port: data.server.gamePort ?? 28015,
                rconPort: data.server.rconPort ?? 28016,
                tags: [],
                rconConfigured: data.server.rconConfigured ?? false,
                rconWorking: null,
              },
            ],
      );
    } catch {
      alert("Network error during import");
    } finally {
      setImporting(null);
    }
  };

  const deleteServer = async (serverId) => {
    setDeleting(serverId);
    try {
      const res = await fetch(`/api/servers/${serverId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setRegisteredServers((prev) =>
          prev.filter((s) => s.serverId !== serverId),
        );
        // Remove from the parent's shared list so it doesn't linger as a ghost
        // server in sibling tabs.
        onServerUpdate?.((prev) => prev.filter((s) => s.id !== serverId));
        setDeleteConfirm(null);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data?.error ?? "Failed to delete server");
      }
    } catch {
      alert("Network error while deleting server");
    } finally {
      setDeleting(null);
    }
  };

  const rotateKey = async (serverId, serverName) => {
    setRotatingKey(serverId);
    try {
      const res = await fetch(`/api/servers/${serverId}/rotate-key`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRotatedKeyReveal({ apiKey: data.apiKey, serverName });
      } else {
        alert(data?.error ?? "Failed to rotate API key");
      }
    } catch {
      alert("Network error while rotating key");
    } finally {
      setRotatingKey(null);
    }
  };

  // Cross-reference: ptero identifiers already imported into IronSight
  const importedIdentifiers = new Set(
    registeredServers.map((r) => r.pteroIdentifier).filter(Boolean),
  );

  return (
    <div className="space-y-4">
      {/* Pterodactyl connection */}
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="size-4 text-brand" />
          <span className="text-sm font-semibold">Pterodactyl Connection</span>
          {pteroStatus?.connected && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-success/10 text-success ring-1 ring-success/30">
              Connected
            </span>
          )}
        </div>

        {pteroStatus === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : pteroStatus.connected ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground">
              {pteroStatus.panelUrl}
            </span>
            <a
              href={pteroStatus.panelUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              <ExternalLink className="size-3" /> Open panel
            </a>
            <Button
              size="sm"
              variant="outline"
              onClick={disconnectPtero}
              className="text-destructive ml-auto"
            >
              <X className="size-3.5 mr-1" /> Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Panel URL
                </Label>
                <Input
                  value={pteroForm.panelUrl}
                  onChange={(e) =>
                    setPteroForm({ ...pteroForm, panelUrl: e.target.value })
                  }
                  placeholder="https://panel.example.com"
                  className="text-xs font-mono h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Application API Key
                </Label>
                <Input
                  type="password"
                  value={pteroForm.apiKey}
                  onChange={(e) =>
                    setPteroForm({ ...pteroForm, apiKey: e.target.value })
                  }
                  placeholder="ptla_…"
                  className="text-xs font-mono h-8"
                />
              </div>
            </div>
            {pteroError && (
              <p className="text-xs text-destructive">{pteroError}</p>
            )}
            <Button
              size="sm"
              disabled={pteroSaving || !pteroForm.panelUrl || !pteroForm.apiKey}
              onClick={savePtero}
            >
              {pteroSaving ? "Connecting…" : "Connect"}
            </Button>
          </div>
        )}
      </div>

      {/* Import from Pterodactyl */}
      {pteroStatus?.connected && (
        <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Pterodactyl Containers
              </span>
              {pteroServers !== null && (
                <span className="ml-2 text-[10px] font-mono text-muted-foreground/60">
                  {pteroServers.length} server
                  {pteroServers.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={fetchPteroServers}
              disabled={pteroLoading}
            >
              <RefreshCw
                className={`size-3.5 ${pteroLoading ? "animate-spin" : "mr-1"}`}
              />
              {!pteroLoading &&
                (pteroServers === null ? "Fetch servers" : "Refresh")}
            </Button>
          </div>

          {pteroFetchError && (
            <p className="px-4 py-3 text-xs text-destructive">
              {pteroFetchError}
            </p>
          )}
          {pteroServers === null && !pteroFetchError && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Click "Fetch servers" to list containers and their configured
              limits from your Pterodactyl panel.
            </p>
          )}
          {pteroServers !== null && pteroServers.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No servers found on that panel.
            </p>
          )}
          {pteroServers !== null && pteroServers.length > 0 && (
            <div className="divide-y divide-border">
              <div className="grid grid-cols-[auto_2fr_1.2fr_1fr_1.4fr_auto] gap-3 px-4 py-2 bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                <div>Status</div>
                <div>Name</div>
                <div>Allocation</div>
                <div>Node</div>
                <div>CPU / RAM / Disk</div>
                <div />
              </div>
              {pteroServers.map((s) => {
                const alreadyImported = importedIdentifiers.has(s.identifier);
                const panelLink = pteroStatus.panelUrl
                  ? `${pteroStatus.panelUrl}/server/${s.identifier}`
                  : null;
                let statusLabel, statusCls;
                if (s.suspended) {
                  statusLabel = "suspended";
                  statusCls =
                    "bg-destructive/10 ring-destructive/30 text-destructive";
                } else if (s.status === "installing") {
                  statusLabel = "installing";
                  statusCls = "bg-warning/10 ring-warning/30 text-warning";
                } else if (s.status === "install_failed") {
                  statusLabel = "failed";
                  statusCls =
                    "bg-destructive/10 ring-destructive/30 text-destructive";
                } else {
                  statusLabel = "active";
                  statusCls = "bg-success/10 ring-success/30 text-success";
                }
                const fmtMem = (mb) =>
                  mb === 0
                    ? "no limit"
                    : mb >= 1024
                      ? `${(mb / 1024).toFixed(1)}G`
                      : `${mb}M`;
                const fmtCpu = (c) => (c === 0 ? "no limit" : `${c}%`);
                return (
                  <div
                    key={s.pteroId}
                    className={`grid grid-cols-[auto_2fr_1.2fr_1fr_1.4fr_auto] gap-3 px-4 py-2.5 items-center ${s.suspended ? "opacity-60" : ""}`}
                  >
                    <span
                      className={`text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded ring-1 ${statusCls}`}
                    >
                      {statusLabel}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-medium truncate">
                          {s.name}
                        </span>
                        {panelLink && (
                          <a
                            href={panelLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-muted-foreground hover:text-brand"
                            title="Open in Pterodactyl"
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-muted-foreground truncate">
                        {s.identifier}
                      </div>
                    </div>
                    <div className="text-xs font-mono text-muted-foreground">
                      {s.ip ? `${s.ip}:${s.port}` : "—"}
                    </div>
                    <div className="text-xs font-mono text-muted-foreground truncate">
                      {s.nodeName ?? "—"}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
                      <Cpu className="size-3 shrink-0" />
                      <span>{fmtCpu(s.limits?.cpu ?? 0)}</span>
                      <span className="opacity-40">·</span>
                      <HardDrive className="size-3 shrink-0" />
                      <span>{fmtMem(s.limits?.memory ?? 0)}</span>
                      <span className="opacity-40">·</span>
                      <span>{fmtMem(s.limits?.disk ?? 0)}</span>
                    </div>
                    <div>
                      {alreadyImported ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono text-success px-2 py-1 rounded bg-success/10 ring-1 ring-success/20">
                          <Check className="size-2.5" /> Imported
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={importing === s.pteroId || s.suspended}
                          onClick={() => importServer(s)}
                          className="h-7 text-xs"
                        >
                          {importing === s.pteroId ? (
                            <RefreshCw className="size-3 animate-spin" />
                          ) : (
                            <>
                              <Upload className="size-3 mr-1" /> Import
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {pteroServers !== null && (
            <div className="px-4 py-2 border-t border-border bg-surface/30 text-[10px] text-muted-foreground/60 font-mono">
              Limits shown are configured maximums from Pterodactyl (CPU % · RAM
              · Disk). Real-time usage requires a Pterodactyl Client API key.
            </div>
          )}
        </div>
      )}

      {/* API Key reveal dialog after import */}
      {apiKeyReveal && (
        <Dialog open onOpenChange={() => setApiKeyReveal(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Server Imported</DialogTitle>
              <DialogDescription>
                <strong>{apiKeyReveal.serverName}</strong> has been added. Copy
                the API key below � it will only be shown once.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <Label className="text-xs text-muted-foreground">
                IronSight API Key (for chat ingest)
              </Label>
              <div className="flex gap-2 items-center">
                <Input
                  readOnly
                  value={apiKeyReveal.apiKey}
                  className="font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigator.clipboard.writeText(apiKeyReveal.apiKey)
                  }
                >
                  Copy
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Set this as the <code className="font-mono">x-api-key</code>{" "}
                header when POSTing to{" "}
                <code className="font-mono">/api/ingest/chat</code>.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Rotate key confirm dialog */}
      {rotateKeyConfirm && (
        <Dialog open onOpenChange={(o) => !o && setRotateKeyConfirm(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset API key?</DialogTitle>
              <DialogDescription>
                This will immediately invalidate the current API key for{" "}
                <strong>{rotateKeyConfirm.serverName}</strong>. Any server
                plugins using the old key will stop working until updated. This
                cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRotateKeyConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={rotatingKey === rotateKeyConfirm.serverId}
                onClick={() => {
                  rotateKey(
                    rotateKeyConfirm.serverId,
                    rotateKeyConfirm.serverName,
                  );
                  setRotateKeyConfirm(null);
                }}
              >
                {rotatingKey === rotateKeyConfirm.serverId ? (
                  <RefreshCw className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Key className="size-3.5 mr-1" />
                )}
                Reset key
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Rotate key reveal dialog */}
      {rotatedKeyReveal && (
        <Dialog open onOpenChange={() => setRotatedKeyReveal(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New API Key Generated</DialogTitle>
              <DialogDescription>
                The old key for <strong>{rotatedKeyReveal.serverName}</strong>{" "}
                is now invalid. Copy the new key — it will only be shown once.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <Label className="text-xs text-muted-foreground">
                New IronSight API Key
              </Label>
              <div className="flex gap-2 items-center">
                <Input
                  readOnly
                  value={rotatedKeyReveal.apiKey}
                  className="font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigator.clipboard.writeText(rotatedKeyReveal.apiKey)
                  }
                >
                  Copy
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Update the <code className="font-mono">x-api-key</code> header
                in your chat ingest plugin immediately.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <Dialog open onOpenChange={(o) => !o && setDeleteConfirm(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete server?</DialogTitle>
              <DialogDescription>
                This will permanently remove{" "}
                <strong>{deleteConfirm.serverName}</strong> from IronSight. All
                associated chat logs will also be deleted. This cannot be
                undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={deleting === deleteConfirm.serverId}
                onClick={() => deleteServer(deleteConfirm.serverId)}
              >
                {deleting === deleteConfirm.serverId ? (
                  <RefreshCw className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5 mr-1" />
                )}
                Delete server
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* RCON config dialog */}
      {rconConfigFor && (
        <RconConfigDialog
          server={rconConfigFor}
          saving={rconSavingFor === rconConfigFor.serverId}
          error={rconSaveError}
          onClose={() => {
            setRconConfigFor(null);
            setRconSaveError(null);
          }}
          onSave={(form) => saveRconConfig(rconConfigFor.serverId, form)}
        />
      )}

      {/* Registered IronSight servers */}
      <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Registered IronSight Servers
            </span>
            {registeredServers.length > 0 && (
              <span className="ml-2 text-[10px] font-mono text-muted-foreground/60">
                {registeredServers.length} server
                {registeredServers.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <NotificationToggle orgId={orgId} />
            <Button
              size="sm"
              variant="outline"
              onClick={loadRegistered}
              disabled={regLoading}
            >
              <RefreshCw
                className={`size-3.5 ${regLoading ? "animate-spin" : "mr-1"}`}
              />
              {!regLoading && "Refresh"}
            </Button>
          </div>
        </div>
        {regLoading ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Loading...</p>
        ) : registeredServers.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No servers registered yet. Import one from Pterodactyl above.
          </p>
        ) : (
          <div className="divide-y divide-border">
            <div className="grid grid-cols-[2fr_1fr_1fr_1.2fr_auto] gap-3 px-4 py-2 bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
              <div>Server</div>
              <div>Pterodactyl</div>
              <div>Last Ping</div>
              <div>Added</div>
              <div className="w-20 text-right">Actions</div>
            </div>
            {registeredServers.map((s) => {
              const panelLink =
                pteroStatus?.panelUrl && s.pteroIdentifier
                  ? `${pteroStatus.panelUrl}/server/${s.pteroIdentifier}`
                  : null;
              const addedDate = s.createdAt
                ? new Date(s.createdAt * 1000).toLocaleDateString(undefined, {
                    ...(tz ? { timeZone: tz } : {}),
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "—";
              return (
                <div
                  key={s.serverId}
                  className="grid grid-cols-[2fr_1fr_1fr_1.2fr_auto] gap-3 px-4 py-3 items-center"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <div className="text-sm font-medium truncate">
                        {s.serverName}
                      </div>
                      {s.rconConfigured ? (
                        s.rconWorking === false ? (
                          <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-destructive/10 text-destructive ring-1 ring-destructive/30">
                            RCON
                          </span>
                        ) : (
                          <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-success/10 text-success ring-1 ring-success/30">
                            RCON
                          </span>
                        )
                      ) : (
                        <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-warning/10 text-warning ring-1 ring-warning/30">
                          No RCON
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground">
                      {s.serverId.slice(0, 8)}…
                    </div>
                  </div>
                  <div className="min-w-0">
                    {panelLink ? (
                      <a
                        href={panelLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-mono text-brand hover:underline truncate"
                        title={s.pteroIdentifier}
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        {s.pteroIdentifier}
                      </a>
                    ) : s.pteroIdentifier ? (
                      <span className="text-[11px] font-mono text-muted-foreground truncate">
                        {s.pteroIdentifier}
                      </span>
                    ) : (
                      <span className="text-[11px] font-mono text-muted-foreground/40">
                        —
                      </span>
                    )}
                  </div>
                  <div>
                    <PingBadge lastHealthPing={s.lastHealthPing} />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {addedDate}
                  </div>
                  <div className="flex items-center gap-1 justify-end w-24">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Configure RCON"
                      onClick={() =>
                        setRconConfigFor({
                          serverId: s.serverId,
                          serverName: s.serverName,
                          rconHost: s.rconHost ?? "",
                          rconPort: s.rconPort ?? 28016,
                          gamePort: s.gamePort ?? 28015,
                          tags: s.tags ?? [],
                        })
                      }
                    >
                      <Settings className="size-3.5 text-muted-foreground" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Rotate API key"
                      disabled={rotatingKey === s.serverId}
                      onClick={() =>
                        setRotateKeyConfirm({
                          serverId: s.serverId,
                          serverName: s.serverName,
                        })
                      }
                    >
                      {rotatingKey === s.serverId ? (
                        <RefreshCw className="size-3.5 animate-spin" />
                      ) : (
                        <Key className="size-3.5 text-muted-foreground" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive hover:bg-destructive/10"
                      title="Delete server"
                      onClick={() =>
                        setDeleteConfirm({
                          serverId: s.serverId,
                          serverName: s.serverName,
                        })
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
function RconConfigDialog({ server, saving, error, onClose, onSave }) {
  const [form, setForm] = useState({
    rconHost: server.rconHost ?? "",
    rconPort: server.rconPort ?? 28016,
    rconPassword: "",
    gamePort: server.gamePort ?? 28015,
    tags: (server.tags ?? []).join(", "),
  });
  useEffect(() => {
    setForm({
      rconHost: server.rconHost ?? "",
      rconPort: server.rconPort ?? 28016,
      rconPassword: "",
      gamePort: server.gamePort ?? 28015,
      tags: (server.tags ?? []).join(", "),
    });
  }, [server.serverId]);

  const submit = () => {
    const tags = form.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    onSave({
      rconHost: form.rconHost.trim(),
      rconPort: Number(form.rconPort),
      rconPassword: form.rconPassword,
      gamePort: Number(form.gamePort),
      tags,
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure RCON — {server.serverName}</DialogTitle>
          <DialogDescription>
            RCON credentials are encrypted at rest. Password is required to save
            changes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                RCON Host
              </Label>
              <Input
                value={form.rconHost}
                onChange={(e) => setForm({ ...form, rconHost: e.target.value })}
                placeholder="51.83.12.4"
                className="font-mono text-xs h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                RCON Port
              </Label>
              <Input
                type="number"
                value={form.rconPort}
                onChange={(e) =>
                  setForm({ ...form, rconPort: Number(e.target.value) })
                }
                className="font-mono text-xs h-8"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                RCON Password
              </Label>
              <Input
                type="password"
                value={form.rconPassword}
                onChange={(e) =>
                  setForm({ ...form, rconPassword: e.target.value })
                }
                placeholder="leave blank to keep existing"
                className="font-mono text-xs h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Game Port
              </Label>
              <Input
                type="number"
                value={form.gamePort}
                onChange={(e) =>
                  setForm({ ...form, gamePort: Number(e.target.value) })
                }
                className="font-mono text-xs h-8"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Tags (comma-separated)
            </Label>
            <Input
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="main, eu, vanilla"
              className="font-mono text-xs h-8"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              saving ||
              !form.rconHost.trim() ||
              !form.rconPort ||
              !form.rconPassword
            }
            onClick={submit}
          >
            {saving ? "Testing…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServerEditDialog({ open, initial, tags, nodes, onClose, onSave }) {
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    ip: "",
    port: 28015,
    rconPort: 28016,
    tags: [],
    node: nodes[0] ?? "",
  });
  useEffect(() => {
    if (open) {
      setDraft(
        initial ?? {
          id: "",
          name: "",
          ip: "",
          port: 28015,
          rconPort: 28016,
          tags: [],
          node: nodes[0] ?? "",
        },
      );
    }
  }, [open, initial, nodes]);
  const toggle = (t) =>
    setDraft((d) => ({
      ...d,
      tags: d.tags.includes(t) ? d.tags.filter((x) => x !== t) : [...d.tags, t],
    }));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit server" : "Add server"}</DialogTitle>
          <DialogDescription>
            Configure how this server appears in the panel. Startup variables
            stay in Pterodactyl.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5 col-span-1">
              <Label>IP</Label>
              <Input
                value={draft.ip}
                onChange={(e) => setDraft({ ...draft, ip: e.target.value })}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Port</Label>
              <Input
                type="number"
                value={draft.port}
                onChange={(e) =>
                  setDraft({ ...draft, port: Number(e.target.value) })
                }
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label>RCON port</Label>
              <Input
                type="number"
                value={draft.rconPort}
                onChange={(e) =>
                  setDraft({ ...draft, rconPort: Number(e.target.value) })
                }
                className="font-mono"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Node</Label>
            <Select
              value={draft.node}
              onValueChange={(v) => setDraft({ ...draft, node: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Tags</Label>
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => {
                const on = draft.tags.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggle(t)}
                    className={
                      "px-2 py-0.5 rounded text-[11px] font-mono font-bold ring-1 transition-colors " +
                      (on
                        ? "bg-brand/15 ring-brand/40 text-brand"
                        : "bg-surface ring-border text-muted-foreground hover:text-foreground")
                    }
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!draft.name || !draft.ip}
            onClick={() => onSave(draft)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function EmptyState({ label }) {
  return (
    <div className="p-10 text-center text-xs text-muted-foreground ring-1 ring-border rounded-md bg-surface/40">
      {label}
    </div>
  );
}
function NodeAddDialog({ open, onClose, onSave }) {
  const empty = {
    code: "",
    name: "",
    uptimeHours: 0,
    status: "online",
    cpu: "",
    ram: "",
    storage: "",
    link: "1Gbps",
    ip: "",
    netInMbps: 0,
    netOutMbps: 0,
    bwUsedGB: 0,
    bwCapGB: null,
  };
  const [draft, setDraft] = useState(empty);
  const [metered, setMetered] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(empty);
      setMetered(false);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add dedicated machine</DialogTitle>
          <DialogDescription>
            Register a node so its servers and metrics show up in the status
            panel.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder="COV1234"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="willjum-game-eu-02"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>IP</Label>
              <Input
                value={draft.ip}
                onChange={(e) => setDraft({ ...draft, ip: e.target.value })}
                className="font-mono"
                placeholder="185.83.154.x"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Link</Label>
              <Select
                value={draft.link}
                onValueChange={(v) => setDraft({ ...draft, link: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1Gbps">1 Gbps</SelectItem>
                  <SelectItem value="2.5Gbps">2.5 Gbps</SelectItem>
                  <SelectItem value="10Gbps">10 Gbps</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>CPU</Label>
            <Input
              value={draft.cpu}
              onChange={(e) => setDraft({ ...draft, cpu: e.target.value })}
              placeholder="Ryzen 9 7900"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>RAM</Label>
              <Input
                value={draft.ram}
                onChange={(e) => setDraft({ ...draft, ram: e.target.value })}
                placeholder="256GB DDR5"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Storage</Label>
              <Input
                value={draft.storage}
                onChange={(e) =>
                  setDraft({ ...draft, storage: e.target.value })
                }
                placeholder="2x 2TB NVMe"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Bandwidth used (GB)</Label>
              <Input
                type="number"
                value={draft.bwUsedGB}
                onChange={(e) =>
                  setDraft({ ...draft, bwUsedGB: Number(e.target.value) })
                }
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{metered ? "Cap (GB)" : "Unmetered"}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  disabled={!metered}
                  value={draft.bwCapGB ?? 0}
                  onChange={(e) =>
                    setDraft({ ...draft, bwCapGB: Number(e.target.value) })
                  }
                  className="font-mono"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const next = !metered;
                    setMetered(next);
                    setDraft((d) => ({ ...d, bwCapGB: next ? 15e3 : null }));
                  }}
                >
                  {metered ? "Set unmetered" : "Set cap"}
                </Button>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!draft.name || !draft.ip || !draft.code}
            onClick={() => onSave(draft)}
          >
            Add node
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export { Route };

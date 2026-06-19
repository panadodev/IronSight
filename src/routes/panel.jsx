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
import { useTimezone } from "@/lib/timezone-store";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
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
              <PresetsTab
                key={activeOrg.id}
                servers={servers}
                orgId={activeOrg.id}
              />
            )}
            {tab === "status" && (
              <StatusTab key={activeOrg.id} orgId={activeOrg.id} />
            )}
            {tab === "servers" && (
              <ServersTab key={activeOrg.id} orgId={activeOrg.id} onServerUpdate={setAllServers} />
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

  const execCommand = async (serverId, command) => {
    const res = await fetch(`/api/servers/${serverId}/rcon/exec`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? "RCON error");
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
      for (const l of consoleLogs) log(`[LOG] ${l}`);
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
    const cmds = applyVars(script.command, vars)
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);
    setPendingScript(null);
    log(`[SCRIPT] \u25B6 ${script.name} on ${server?.name}`);
    for (const c of cmds) {
      log(`> ${c}`);
      try {
        const { response, consoleLogs } = await execCommand(selected, c);
        for (const l of consoleLogs) log(`[LOG] ${l}`);
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
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ScriptPickerButton scripts={scripts} onPick={onPickScript} />
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
function ScriptPickerButton({ scripts, onPick }) {
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
        <Button size="sm" variant="outline">
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
  const { rankOf } = useAuth();
  const userRank = rankOf(orgId);
  const [scripts, setScripts] = useState([]);
  const [scriptsLoading, setScriptsLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [pendingRun, setPendingRun] = useState(null);

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
    const cmds = applyVars(script.command, vars)
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);
    setPendingRun(null);
    for (const serverId of targets) {
      for (const cmd of cmds) {
        await fetch(`/api/servers/${serverId}/rcon/exec`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: cmd }),
        }).catch(() => null);
      }
    }
  };

  const triggerRun = (script, targets, targetLabel) => {
    if (!targets.length) return;
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
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5 mr-1" /> New script
        </Button>
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
                    onClick={() => deleteScript(s.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>

              <pre className="text-[10px] font-mono text-brand bg-black/30 ring-1 ring-border rounded p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
                {s.command}
              </pre>

              {!allowed && (
                <div className="text-[10px] font-mono text-destructive bg-destructive/5 ring-1 ring-destructive/30 rounded px-2 py-1">
                  Requires {rankLabel(s.minRank)} or higher to execute.
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
                  disabled={!servers.length || !allowed}
                >
                  <Play className="size-3.5 mr-1" /> Run all
                </Button>
                <RunOnGroupButton
                  tags={allTags}
                  disabled={!allowed}
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
                  disabled={!allowed}
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
function PresetsTab({ servers, orgId }) {
  const tz = useTimezone();
  const [plugins, setPlugins] = useState([]);
  const [pluginsLoading, setPluginsLoading] = useState(true);
  const [groupTags, setGroupTags] = useState(
    Array.from(new Set(servers.flatMap((s) => s.tags))),
  );
  const [newGroupTag, setNewGroupTag] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setPluginsLoading(true);
    fetch(`/api/orgs/${orgId}/plugins`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (!cancelled) {
          setPlugins(d.plugins ?? []);
          setPluginsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setPluginsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const patchPlugin = async (pluginId, fields) => {
    await fetch(`/api/orgs/${orgId}/plugins/${pluginId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  };

  const update = async (p) => {
    setPlugins((prev) =>
      prev.map((x) =>
        x.id === p.id ? { ...x, installedVersion: x.latestVersion } : x,
      ),
    );
    await fetch(`/api/orgs/${orgId}/plugins/${p.id}/push`, {
      method: "POST",
      credentials: "include",
    });
  };

  const toggleTag = async (pluginId, t) => {
    const plugin = plugins.find((p) => p.id === pluginId);
    if (!plugin) return;
    const newTags = plugin.assignedTags.includes(t)
      ? plugin.assignedTags.filter((x) => x !== t)
      : [...plugin.assignedTags, t];
    setPlugins((prev) =>
      prev.map((p) =>
        p.id === pluginId ? { ...p, assignedTags: newTags } : p,
      ),
    );
    await patchPlugin(pluginId, { assignedTags: newTags });
  };

  const setRisk = async (pluginId, r) => {
    setPlugins((prev) =>
      prev.map((p) => (p.id === pluginId ? { ...p, risk: r } : p)),
    );
    await patchPlugin(pluginId, { risk: r });
  };

  const unloadRisk = async (r) => {
    setPlugins((prev) =>
      prev.map((p) => (p.risk === r ? { ...p, enabled: false } : p)),
    );
    await fetch(`/api/orgs/${orgId}/plugins/unload-risk`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ risk: r }),
    });
  };

  const togglePlugin = async (id) => {
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) return;
    const newEnabled = !plugin.enabled;
    setPlugins((prev) =>
      prev.map((p) => (p.id === id ? { ...p, enabled: newEnabled } : p)),
    );
    await patchPlugin(id, { enabled: newEnabled });
  };

  const addPlugin = async (draft) => {
    const res = await fetch(`/api/orgs/${orgId}/plugins`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!res.ok) return;
    const data = await res.json();
    setPlugins((prev) => [
      ...prev,
      {
        id: data.pluginId,
        name: draft.name,
        source: draft.source ?? "custom",
        umodSlug: draft.umodSlug ?? null,
        installedVersion: draft.installedVersion ?? null,
        latestVersion: draft.latestVersion ?? null,
        latestUpdatedAt: draft.latestUpdatedAt ?? null,
        assignedTags: draft.assignedTags ?? [],
        risk: draft.risk ?? 2,
        enabled: true,
      },
    ]);
  };

  const riskCount = (r) =>
    plugins.filter((p) => p.risk === r && p.enabled).length;
  if (pluginsLoading)
    return (
      <p className="text-sm text-muted-foreground py-4">Loading plugins…</p>
    );
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-xs text-muted-foreground max-w-xl">
          uMod &amp; custom plugins, grouped by server tag. Each plugin carries
          a <b>risk</b> rating (1–3); use the unload buttons to instantly
          disable a whole risk class across every matching server.
        </p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {[1, 2, 3].map((r) => (
            <Button
              key={r}
              size="sm"
              variant="outline"
              onClick={() => unloadRisk(r)}
              disabled={riskCount(r) === 0}
              className={
                r === 1
                  ? "border-success/40 hover:bg-success/10 text-success"
                  : r === 2
                    ? "border-warning/40 hover:bg-warning/10 text-warning"
                    : "border-destructive/40 hover:bg-destructive/10 text-destructive"
              }
            >
              <AlertTriangle className="size-3.5 mr-1" /> Unload risk {r}
              <span className="ml-1 opacity-60">({riskCount(r)})</span>
            </Button>
          ))}
          <div className="w-px h-6 bg-border mx-1" />
          <Button size="sm" onClick={() => setAddingCustom(true)}>
            <Upload className="size-3.5 mr-1" /> Add custom plugin
          </Button>
        </div>
      </div>

      {/* Group tag manager */}
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-2 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground pl-1">
          Server group tags
        </span>
        {groupTags.map((t) => (
          <span
            key={t}
            className="px-2 py-0.5 rounded text-[10px] font-mono font-bold ring-1 bg-brand/10 ring-brand/30 text-brand"
          >
            {t}
          </span>
        ))}
        <div className="flex items-center gap-1 ml-auto">
          <Input
            value={newGroupTag}
            onChange={(e) => setNewGroupTag(e.target.value)}
            placeholder="new group tag"
            className="h-7 text-xs w-36"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newGroupTag.trim()) {
                setGroupTags((p) =>
                  Array.from(
                    /* @__PURE__ */ new Set([...p, newGroupTag.trim()]),
                  ),
                );
                setNewGroupTag("");
              }
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!newGroupTag.trim()}
            onClick={() => {
              setGroupTags((p) =>
                Array.from(/* @__PURE__ */ new Set([...p, newGroupTag.trim()])),
              );
              setNewGroupTag("");
            }}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
        <div className="grid grid-cols-[1.6fr_1fr_0.8fr_2fr_auto] gap-3 px-3 py-2 border-b border-border bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          <div>Plugin</div>
          <div>Version</div>
          <div>Risk</div>
          <div>Group tags</div>
          <div />
        </div>
        {plugins.map((p) => {
          const outdated = p.installedVersion !== p.latestVersion;
          const affected = servers.filter((s) =>
            s.tags.some((t) => p.assignedTags.includes(t)),
          );
          const unassigned = groupTags.filter(
            (t) => !p.assignedTags.includes(t),
          );
          return (
            <div
              key={p.id}
              className={
                "grid grid-cols-[1.6fr_1fr_0.8fr_2fr_auto] gap-3 px-3 py-2.5 border-b border-border last:border-0 items-center " +
                (p.enabled ? "" : "opacity-50")
              }
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold truncate">
                    {p.name}
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      "text-[9px] font-mono h-4 px-1.5 " +
                      (p.source === "custom"
                        ? "border-brand/40 text-brand bg-brand/5"
                        : "border-border text-muted-foreground")
                    }
                  >
                    {p.source}
                  </Badge>
                  {!p.enabled && (
                    <Badge
                      variant="outline"
                      className="text-[9px] font-mono h-4 px-1.5 border-destructive/40 text-destructive bg-destructive/5"
                    >
                      unloaded
                    </Badge>
                  )}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground truncate">
                  {p.source === "umod"
                    ? `umod.org/${p.umodSlug}`
                    : "custom upload"}
                </div>
              </div>
              <div>
                <div className="text-xs font-mono flex items-center gap-1.5">
                  {p.installedVersion}
                  {outdated && (
                    <>
                      <span className="text-muted-foreground/50">→</span>
                      <span className="text-warning">{p.latestVersion}</span>
                      <span className="size-1.5 rounded-full bg-warning animate-pulse" />
                    </>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {new Date(p.latestUpdatedAt * 1000).toLocaleDateString(undefined, tz ? { timeZone: tz } : {})}
                </div>
              </div>
              <RiskPicker risk={p.risk} onChange={(r) => setRisk(p.id, r)} />
              <div className="flex gap-1 flex-wrap items-center">
                {p.assignedTags.length === 0 && (
                  <span className="text-[10px] text-muted-foreground italic">
                    no tags
                  </span>
                )}
                {p.assignedTags.map((t) => (
                  <button
                    key={t}
                    onClick={() => toggleTag(p.id, t)}
                    className="group inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold ring-1 bg-brand/15 ring-brand/40 text-brand hover:bg-destructive/15 hover:ring-destructive/40 hover:text-destructive transition-colors"
                    title={`Remove ${t}`}
                  >
                    {t}
                    <X className="size-2.5 opacity-0 group-hover:opacity-100" />
                  </button>
                ))}
                {unassigned.length > 0 && (
                  <AddTagPopover
                    tags={unassigned}
                    onPick={(t) => toggleTag(p.id, t)}
                  />
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title={p.enabled ? "Unload plugin" : "Load plugin"}
                  onClick={() => togglePlugin(p.id)}
                >
                  <Power
                    className={
                      "size-3.5 " +
                      (p.enabled ? "text-success" : "text-muted-foreground")
                    }
                  />
                </Button>
                <Button
                  size="sm"
                  variant={outdated ? "default" : "outline"}
                  disabled={!outdated || !affected.length}
                  onClick={() => update(p)}
                  title={`Push to ${affected.length} server(s)`}
                >
                  <RefreshCw className="size-3.5 mr-1" />
                  {outdated ? `Update (${affected.length})` : "Up to date"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <CustomPluginDialog
        open={addingCustom}
        groupTags={groupTags}
        onClose={() => setAddingCustom(false)}
        onSave={async (p) => {
          await addPlugin(p);
          setAddingCustom(false);
        }}
      />
    </div>
  );
}
function RiskPicker({ risk, onChange }) {
  const cls = (r, on) =>
    on
      ? r === 1
        ? "bg-success/20 ring-success/50 text-success"
        : r === 2
          ? "bg-warning/20 ring-warning/50 text-warning"
          : "bg-destructive/20 ring-destructive/50 text-destructive"
      : "bg-surface ring-border text-muted-foreground hover:text-foreground";
  return (
    <div className="inline-flex items-center gap-0.5 ring-1 ring-border rounded p-0.5 w-fit">
      {[1, 2, 3].map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={
            "px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 " +
            cls(r, risk === r)
          }
          title={`Risk ${r}`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
function AddTagPopover({ tags, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono ring-1 ring-dashed ring-border text-muted-foreground hover:text-foreground hover:ring-brand/40"
          title="Add group tag"
        >
          <Plus className="size-2.5" /> tag
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1">
        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground px-1.5 py-1">
          Add group tag
        </div>
        <div className="space-y-0.5 max-h-56 overflow-y-auto">
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => {
                onPick(t);
                setOpen(false);
              }}
              className="w-full text-left px-2 py-1 rounded hover:bg-surface text-[11px] font-mono"
            >
              {t}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
function CustomPluginDialog({ open, groupTags, onClose, onSave }) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [risk, setRisk] = useState(2);
  const [tags, setTags] = useState([]);
  const [fileName, setFileName] = useState(null);
  useEffect(() => {
    if (open) {
      setName("");
      setVersion("0.1.0");
      setRisk(2);
      setTags([]);
      setFileName(null);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add custom plugin</DialogTitle>
          <DialogDescription>
            Upload a .cs / .dll plugin that isn't on uMod. It will sit alongside
            uMod plugins and follow the same tag &amp; risk rules.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Plugin file</Label>
            <label className="flex items-center gap-2 ring-1 ring-dashed ring-border rounded px-3 py-3 cursor-pointer hover:bg-surface/40">
              <Upload className="size-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground flex-1 truncate">
                {fileName ?? "Click to select a .cs or .dll file"}
              </span>
              <input
                type="file"
                accept=".cs,.dll,.zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setFileName(f.name);
                    if (!name) setName(f.name.replace(/\.(cs|dll|zip)$/i, ""));
                  }
                }}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="MyPlugin"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Version</Label>
              <Input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="font-mono"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Risk</Label>
            <RiskPicker risk={risk} onChange={setRisk} />
          </div>
          <div className="space-y-1.5">
            <Label>Assign to group tags</Label>
            <div className="flex flex-wrap gap-1">
              {groupTags.map((t) => {
                const on = tags.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() =>
                      setTags((p) =>
                        on ? p.filter((x) => x !== t) : [...p, t],
                      )
                    }
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
            disabled={!name || !fileName}
            onClick={() =>
              onSave({
                name,
                source: "custom",
                installedVersion: version,
                latestVersion: version,
                latestUpdatedAt: Math.floor(Date.now() / 1000),
                assignedTags: tags,
                risk,
                enabled: true,
              })
            }
          >
            <Upload className="size-3.5 mr-1" /> Add plugin
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
function stripAnsi(s) {
  // Strip ANSI escape sequences (CSI) so the console reads cleanly.
  return String(s).replace(/\[[0-9;]*[A-Za-z]/g, "");
}
function ConsoleFeed({ lines, status, error }) {
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView();
  }, [lines]);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[8px] font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1">
          <Terminal className="size-3" /> Console · read-only
        </span>
        <span className="text-[8px] font-mono uppercase tracking-widest text-muted-foreground">
          {status === "live"
            ? "streaming"
            : status === "connecting"
              ? "connecting…"
              : status === "error"
                ? "error"
                : "idle"}
        </span>
      </div>
      <div className="h-56 overflow-y-auto rounded ring-1 ring-border bg-black/60 p-2 font-mono text-[10px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : lines.length === 0 ? (
          <span className="text-muted-foreground italic">
            {status === "connecting"
              ? "Connecting to console…"
              : "Waiting for console output…"}
          </span>
        ) : (
          lines.map((l, i) => <div key={i}>{stripAnsi(l)}</div>)
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
function ServerDetailPanel({ server, stream, logs }) {
  const live = stream?.status === "live" ? stream : null;
  const info = [
    ["Identifier", server.identifier ?? "—"],
    ["UUID", server.uuid ?? "—"],
    ["Node", server.nodeName ?? "—"],
    ["Address", server.ip ? `${server.ip}:${server.port ?? ""}` : "—"],
    ["CPU limit", server.limits?.cpu ? `${server.limits.cpu}%` : "∞"],
    ["Memory limit", fmtMB(server.limits?.memory ?? 0)],
    ["Disk limit", fmtMB(server.limits?.disk ?? 0)],
    ["Install", server.installStatus ?? "—"],
  ];
  if (live) {
    info.push(["Net in", fmtBytes(live.rx ?? 0)]);
    info.push(["Net out", fmtBytes(live.tx ?? 0)]);
    info.push(["Uptime", fmtUptime(live.uptime ?? 0)]);
  }
  return (
    <div className="px-3 py-3 border-b border-border bg-background/60 space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5">
        {info.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="text-[8px] font-mono uppercase tracking-widest text-muted-foreground">
              {k}
            </div>
            <div className="text-[11px] font-mono truncate" title={String(v)}>
              {v}
            </div>
          </div>
        ))}
      </div>
      <ConsoleFeed lines={logs} status={stream?.status} error={stream?.error} />
    </div>
  );
}
function StatusTab({ orgId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const historyRef = useRef(new Map());

  // Live websocket streams, keyed by server identifier.
  const socketsRef = useRef(new Map());
  const [streams, setStreams] = useState({});

  // Expanded row + its console log feed (only one server expanded at a time).
  const [expandedId, setExpandedId] = useState(null);
  const expandedRef = useRef(null);
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    expandedRef.current = expandedId;
  }, [expandedId]);

  // Append a sample to a server's rolling sparkline history.
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

  const fetchWsCreds = useCallback(
    async (identifier) => {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ptero/servers/${encodeURIComponent(identifier)}/websocket`,
        { credentials: "include" },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok)
        throw new Error(body?.error ?? "Failed to get websocket token.");
      return body; // { socket, token }
    },
    [orgId],
  );

  const stopStream = useCallback((identifier) => {
    const entry = socketsRef.current.get(identifier);
    if (entry?.ws) {
      entry.ws.onclose = null;
      try {
        entry.ws.close();
      } catch {
        /* ignore */
      }
    }
    socketsRef.current.delete(identifier);
    setStreams((prev) => {
      const next = { ...prev };
      delete next[identifier];
      return next;
    });
  }, []);

  const startStream = useCallback(
    async (server) => {
      const identifier = server.identifier;
      if (!identifier || socketsRef.current.has(identifier)) return;
      const memLimitBytes = (server.limits?.memory ?? 0) * 1048576;

      socketsRef.current.set(identifier, { ws: null });
      setStreams((prev) => ({
        ...prev,
        [identifier]: { status: "connecting" },
      }));

      let creds;
      try {
        creds = await fetchWsCreds(identifier);
      } catch (err) {
        socketsRef.current.delete(identifier);
        setStreams((prev) => ({
          ...prev,
          [identifier]: { status: "error", error: err.message },
        }));
        return;
      }

      let ws;
      try {
        ws = new WebSocket(creds.socket);
      } catch {
        socketsRef.current.delete(identifier);
        setStreams((prev) => ({
          ...prev,
          [identifier]: { status: "error", error: "Could not open websocket." },
        }));
        return;
      }

      const entry = socketsRef.current.get(identifier);
      if (!entry) {
        // Stopped before the socket opened.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      entry.ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ event: "auth", args: [creds.token] }));
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.event) {
          case "auth success":
            entry.authed = true;
            ws.send(JSON.stringify({ event: "send stats", args: [null] }));
            if (identifier === expandedRef.current) {
              ws.send(JSON.stringify({ event: "send logs", args: [null] }));
            }
            break;
          case "console output": {
            if (identifier !== expandedRef.current) break;
            const line = msg.args?.[0] ?? "";
            setLogs((prev) => {
              const next = prev.concat(
                typeof line === "string" ? line : String(line),
              );
              return next.length > 250 ? next.slice(-250) : next;
            });
            break;
          }
          case "stats": {
            let st;
            try {
              st = JSON.parse(msg.args?.[0] ?? "{}");
            } catch {
              return;
            }
            const memBytes = st.memory_bytes ?? 0;
            const cpu = st.cpu_absolute ?? 0;
            const memPct =
              memLimitBytes > 0 ? (memBytes / memLimitBytes) * 100 : 0;
            pushHistory(identifier, cpu, memPct);
            setStreams((prev) => ({
              ...prev,
              [identifier]: {
                status: "live",
                state: st.state ?? null,
                cpu,
                mem: memBytes,
                disk: st.disk_bytes ?? 0,
                uptime: st.uptime ?? 0,
                rx: st.network?.rx_bytes ?? 0,
                tx: st.network?.tx_bytes ?? 0,
              },
            }));
            break;
          }
          case "token expiring":
          case "token expired":
            fetchWsCreds(identifier)
              .then((c) => {
                ws.send(JSON.stringify({ event: "auth", args: [c.token] }));
                if (identifier === expandedRef.current) {
                  ws.send(JSON.stringify({ event: "send logs", args: [null] }));
                }
              })
              .catch(() => {
                /* will surface via close */
              });
            break;
          default:
            break;
        }
      };
      ws.onerror = () => {
        setStreams((prev) => ({
          ...prev,
          [identifier]: {
            ...(prev[identifier] ?? {}),
            status: "error",
            error:
              "WebSocket error — the panel may not allow this origin (Wings allowed_origins).",
          },
        }));
      };
      ws.onclose = () => {
        socketsRef.current.delete(identifier);
        setStreams((prev) => {
          if (prev[identifier]?.status === "error") return prev;
          const next = { ...prev };
          delete next[identifier];
          return next;
        });
      };
    },
    [fetchWsCreds, pushHistory],
  );

  // Expanding a row opens the live stream (stats + console); collapsing closes
  // it. Only one server is expanded/streamed at a time.
  const toggleExpand = useCallback(
    (server) => {
      const id = server.identifier;
      if (!id) return;
      const prev = expandedRef.current;
      if (prev === id) {
        expandedRef.current = null;
        setExpandedId(null);
        setLogs([]);
        stopStream(id);
        return;
      }
      if (prev) stopStream(prev);
      expandedRef.current = id;
      setExpandedId(id);
      setLogs([]);
      const entry = socketsRef.current.get(id);
      if (!entry) {
        startStream(server);
      } else if (entry.authed && entry.ws?.readyState === 1) {
        try {
          entry.ws.send(JSON.stringify({ event: "send logs", args: [null] }));
        } catch {
          /* ignore */
        }
      }
    },
    [startStream, stopStream],
  );

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
    load();
    const id = setInterval(load, 8000);
    const sockets = socketsRef.current;
    return () => {
      clearInterval(id);
      for (const entry of sockets.values()) {
        if (entry?.ws) {
          entry.ws.onclose = null;
          try {
            entry.ws.close();
          } catch {
            /* ignore */
          }
        }
      }
      sockets.clear();
      setStreams({});
      expandedRef.current = null;
      setExpandedId(null);
      setLogs([]);
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
        allocMem: 0,
        allocDisk: 0,
        usedMemBytes: 0,
        usedDiskBytes: 0,
        hasUsage: false,
      };
      agg.count += 1;
      agg.allocMem += s.limits?.memory ?? 0;
      agg.allocDisk += s.limits?.disk ?? 0;
      const liveStream = streams[s.identifier];
      const usedMem =
        liveStream?.status === "live"
          ? liveStream.mem
          : s.live?.resources.memoryBytes;
      const usedDisk =
        liveStream?.status === "live"
          ? liveStream.disk
          : s.live?.resources.diskBytes;
      if (usedMem != null) {
        agg.usedMemBytes += usedMem;
        agg.hasUsage = true;
      }
      if (usedDisk != null) {
        agg.usedDiskBytes += usedDisk;
      }
      map.set(key, agg);
    }
    return map;
  }, [servers, streams]);

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
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          Pterodactyl infrastructure · {nodes.length} node
          {nodes.length === 1 ? "" : "s"} · {servers.length} server
          {servers.length === 1 ? "" : "s"}
        </h3>
        <div className="flex items-center gap-3">
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
                nodeAgg.get(n.name) ?? { count: 0, mem: 0, disk: 0 };
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
                          : "border-success/40 text-success bg-success/10 text-[9px]"
                      }
                    >
                      {n.maintenanceMode ? "maintenance" : "online"}
                    </Badge>
                  </div>

                  {n.fqdn && (
                    <div className="text-[10px] font-mono text-muted-foreground truncate">
                      {n.fqdn}
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

                  <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground pt-1 border-t border-border">
                    <span>
                      HOSTING{" "}
                      <span className="text-foreground">{agg.count}</span>{" "}
                      server
                      {agg.count === 1 ? "" : "s"}
                    </span>
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
            <div className="grid grid-cols-[1.5fr_0.7fr_1.1fr_1.2fr_0.9fr_0.6fr_auto] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
              <div>Server</div>
              <div>Node</div>
              <div>CPU</div>
              <div>Memory</div>
              <div>Disk</div>
              <div className="text-right">Uptime</div>
              <div />
            </div>
            {servers.map((s) => {
              const stream = streams[s.identifier];
              const isLiveStream = stream?.status === "live";
              const isExpanded = expandedId === s.identifier;
              const hist = historyRef.current.get(s.identifier) ?? [];
              const memLimitBytes = (s.limits?.memory ?? 0) * 1048576;

              // Prefer real-time websocket values, fall back to polled stats.
              const state =
                stream?.state ??
                s.live?.state ??
                (s.suspended ? "offline" : "unknown");
              const hasStats = isLiveStream || !!s.live;
              const cpu = isLiveStream
                ? stream.cpu
                : s.live?.resources.cpuAbsolute;
              const memBytes = isLiveStream
                ? stream.mem
                : s.live?.resources.memoryBytes;
              const diskBytes = isLiveStream
                ? stream.disk
                : s.live?.resources.diskBytes;
              const uptime = isLiveStream
                ? stream.uptime
                : s.live?.resources.uptime;

              return (
                <Fragment key={s.uuid ?? s.identifier ?? s.pteroId}>
                  <div
                    role="button"
                    tabIndex={s.identifier ? 0 : -1}
                    onClick={() => s.identifier && toggleExpand(s)}
                    onKeyDown={(e) => {
                      if (
                        s.identifier &&
                        (e.key === "Enter" || e.key === " ")
                      ) {
                        e.preventDefault();
                        toggleExpand(s);
                      }
                    }}
                    className={
                      "grid grid-cols-[1.5fr_0.7fr_1.1fr_1.2fr_0.9fr_0.6fr_auto] gap-2 px-3 py-2 border-b border-border items-center text-[11px] " +
                      (s.identifier ? "cursor-pointer " : "") +
                      (isExpanded ? "bg-surface/70" : "hover:bg-surface/40")
                    }
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <StateDot state={state} />
                      <span className="font-medium truncate">{s.name}</span>
                      {isLiveStream && (
                        <span className="flex items-center gap-1 text-[8px] font-mono uppercase tracking-widest text-success shrink-0">
                          <span className="size-1.5 rounded-full bg-success animate-pulse" />
                          live
                        </span>
                      )}
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

                    <div className="text-right font-mono text-[10px] text-muted-foreground">
                      {hasStats ? fmtUptime(uptime) : "—"}
                    </div>

                    <div className="flex justify-end items-center gap-1.5">
                      {stream?.status === "error" && (
                        <span title={stream.error}>
                          <AlertTriangle className="size-3 text-destructive" />
                        </span>
                      )}
                      {stream?.status === "connecting" && (
                        <span className="text-[8px] font-mono text-muted-foreground">
                          …
                        </span>
                      )}
                      {s.identifier && (
                        <ChevronDown
                          className={
                            "size-3.5 text-muted-foreground transition-transform " +
                            (isExpanded ? "rotate-180" : "")
                          }
                        />
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <ServerDetailPanel server={s} stream={stream} logs={logs} />
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
        <div className="text-[10px] text-muted-foreground/70 font-mono mt-1.5">
          CPU, memory, disk and uptime come from the Pterodactyl client API and
          refresh every 8s. Click a server to expand it — that opens a websocket
          for real-time stats and a read-only console feed. Memory and disk are
          shown against each server's configured limit.
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
                ip: "",
                port: 28015,
                rconPort: 28016,
                tags: [],
                rconConfigured: false,
                rconWorking: null,
              },
            ],
      );
      loadRegistered();
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

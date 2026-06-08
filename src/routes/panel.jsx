import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import {
  Terminal,
  ScrollText,
  Server,
  Building2,
  ChevronDown,
  Check,
  Play,
  Plus,
  RefreshCw,
  CircleDot,
  Cpu,
  HardDrive,
  Wifi,
  X,
  Pencil,
  Trash2,
  Globe2,
  Layers,
  Target,
  AlertTriangle,
  Upload,
  Power
} from "lucide-react";
import { Area, AreaChart, Brush, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
const PANEL_TABS = ["rcon", "scripts", "presets", "status", "servers"];
const Route = createFileRoute("/panel")({
  component: PanelPage,
  validateSearch: (search) => {
    const t = search.tab;
    return {
      tab: typeof t === "string" && PANEL_TABS.includes(t) ? t : void 0
    };
  }
});
const RANK_OPTIONS = [
  { value: 1, label: "Support" },
  { value: 2, label: "Admin" },
  { value: 3, label: "Sr. Admin" },
  { value: 4, label: "Management" }
];
const rankLabel = (r) => RANK_OPTIONS.find((x) => x.value === r)?.label ?? `Rank ${r}`;
function extractVars(cmd) {
  const matches = cmd.match(/\{([a-zA-Z0-9_]+)\}/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.slice(1, -1))));
}
function applyVars(cmd, values) {
  return cmd.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => values[k] ?? `{${k}}`);
}
const MOCK_NODES = [
  {
    id: "n_fra1",
    code: "COV0356",
    name: "sanc-box-01",
    uptimeHours: 742,
    status: "online",
    cpu: "Ryzen 9 7900",
    ram: "256GB DDR5",
    storage: "512GB Gen 4 NVMe SSD",
    link: "1Gbps",
    ip: "185.83.154.82",
    netInMbps: 16.63,
    netOutMbps: 41.7,
    bwUsedGB: 3550,
    bwCapGB: 15e3
  },
  {
    id: "n_fra2",
    code: "COV0921",
    name: "Willjum-Infra-Machine",
    uptimeHours: 1204,
    status: "online",
    cpu: "Ryzen 7 5700X",
    ram: "128GB DDR4",
    storage: "2x 2TB NVMe SSD",
    link: "10Gbps",
    ip: "185.83.152.207",
    netInMbps: 38.2,
    netOutMbps: 112.4,
    bwUsedGB: 5130,
    bwCapGB: 1e5
  },
  {
    id: "n_nyc1",
    code: "COV1294",
    name: "Willjum-EU-Game-Server",
    uptimeHours: 96,
    status: "online",
    cpu: "Ryzen 9 7900",
    ram: "128GB DDR5",
    storage: "512GB Gen 4 NVMe SSD",
    link: "1Gbps",
    ip: "185.83.154.85",
    netInMbps: 84.1,
    netOutMbps: 156.9,
    bwUsedGB: 8740,
    bwCapGB: 15e3
  }
];
function fmtBw(gb) {
  if (gb >= 1e3) return `${(gb / 1e3).toFixed(2)}TB`;
  return `${gb.toFixed(2)}GB`;
}
function seedSeries(seed, n, base, jitter, floor = 0) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) & 4294967295;
  const out = [];
  for (let i = 0; i < n; i++) {
    h = h * 1103515245 + 12345 & 2147483647;
    const r = h / 2147483647 - 0.5;
    const wave = Math.sin(i / 2.7 + h % 13) * jitter * 0.35;
    const v = Math.max(floor, base + r * jitter + wave);
    out.push({ i, v: Number(v.toFixed(2)) });
  }
  return out;
}
const MOCK_TAGS = ["2x", "vanilla", "main", "eu", "us", "modded"];
const MOCK_SERVERS_BY_ORG = {
  builders_sanctuary: [
    { id: "s_bs_main", name: "BS \xB7 Main EU", ip: "51.83.12.4", port: 28015, rconPort: 28016, tags: ["main", "eu", "vanilla"], node: "n_fra1" },
    { id: "s_bs_2x", name: "BS \xB7 2x EU", ip: "51.83.12.5", port: 28015, rconPort: 28016, tags: ["2x", "eu"], node: "n_fra1" },
    { id: "s_bs_us", name: "BS \xB7 Main US", ip: "104.21.4.91", port: 28015, rconPort: 28016, tags: ["main", "us", "vanilla"], node: "n_nyc1" },
    { id: "s_bs_2x_old", name: "BS \xB7 2x (legacy)", ip: "51.83.99.10", port: 28015, rconPort: 28016, tags: ["2x", "eu", "modded"], node: "n_fra2" },
    { id: "s_bs_5x_old", name: "BS \xB7 5x (legacy)", ip: "51.83.99.11", port: 28015, rconPort: 28016, tags: ["modded", "eu"], node: "n_fra2" }
  ],
  willjums: [
    { id: "s_wj_eu_solo", name: "[EU] Willjum's Solo Only | Small Map | Thursday Wipes", ip: "185.83.154.89", port: 28014, rconPort: 28015, tags: ["eu", "solo", "thursday"], node: "n_fra1" },
    { id: "s_wj_na_solo", name: "[NA] Willjum's Solo Only | Small Map | Thursday Wipes", ip: "156.236.84.33", port: 28014, rconPort: 28015, tags: ["us", "solo", "thursday"], node: "n_nyc1" },
    { id: "s_wj_na_2x", name: "[NA] Willjum's 2x Solo/Duo/Trio | Small maps | Monday wipes", ip: "156.236.84.39", port: 28014, rconPort: 28015, tags: ["us", "2x", "monday"], node: "n_nyc1" },
    { id: "s_wj_na_casual", name: "[NA] Willjum's Casual Solo/Duo | Small Map | Monthly", ip: "156.236.84.54", port: 28014, rconPort: 28015, tags: ["us", "casual", "monthly"], node: "n_nyc1" },
    { id: "s_wj_eu_casual", name: "[EU] Willjum's Casual Solo/Duo | Small Map | Monthly", ip: "185.83.154.88", port: 28014, rconPort: 28015, tags: ["eu", "casual", "monthly"], node: "n_fra1" },
    { id: "s_wj_eu_15x", name: "[EU] Willjum's 1.5x Solo/Duo/Trio", ip: "185.83.154.87", port: 28014, rconPort: 28015, tags: ["eu", "1.5x"], node: "n_fra1" },
    { id: "s_wj_na_3x", name: "[NA] Willjum's 3x Fridays", ip: "156.236.84.48", port: 28014, rconPort: 28015, tags: ["us", "3x", "friday"], node: "n_nyc1" },
    { id: "s_wj_eu_2x", name: "[EU] Willjum's 2x Solo/Duo/Trio | Small Maps | Monday wipes", ip: "185.83.154.86", port: 28014, rconPort: 28015, tags: ["eu", "2x", "monday"], node: "n_fra2" },
    { id: "s_wj_eu_1grid", name: "[EU] 2x Willjums 1grid Solo/Duo/Trio", ip: "185.83.154.90", port: 28014, rconPort: 28015, tags: ["eu", "2x", "1grid"], node: "n_fra2" },
    { id: "s_wj_na_1grid", name: "[NA] 2x Willjums 1grid Solo/Duo/Trio", ip: "156.236.84.42", port: 28014, rconPort: 28015, tags: ["us", "2x", "1grid"], node: "n_nyc1" }
  ]
};
const MOCK_SCRIPTS = [
  { id: "sc_maxpop", name: "maxpop 200", command: "maxplayers 200", description: "Raise pop cap before wipe", minRank: 2 },
  { id: "sc_save", name: "force save", command: "server.save", description: "Force a world save", minRank: 1 },
  { id: "sc_restart", name: "restart w/ warning", command: "say Restart in {minutes} min \u2014 {reason}\nrestart {minutes}", description: "Broadcast then restart. Variables: {minutes}, {reason}", minRank: 3 },
  { id: "sc_wipe", name: "full wipe", command: "say Wipe in 30s\nserver.save\nwipe map\nrestart 30", description: "Multi-step wipe sequence", minRank: 4 }
];
const MOCK_PLUGINS = [
  { id: "p_admin", name: "AdminMenu", source: "umod", umodSlug: "admin-menu", installedVersion: "2.1.3", latestVersion: "2.1.4", latestUpdatedAt: "2026-05-26T11:00:00Z", assignedTags: ["2x", "main"], risk: 1, enabled: true },
  { id: "p_kits", name: "Kits", source: "umod", umodSlug: "kits", installedVersion: "4.2.9", latestVersion: "4.2.9", latestUpdatedAt: "2026-04-12T14:00:00Z", assignedTags: ["2x"], risk: 1, enabled: true },
  { id: "p_disc", name: "DiscordCore", source: "umod", umodSlug: "discord-core", installedVersion: "3.0.1", latestVersion: "3.1.0", latestUpdatedAt: "2026-05-27T08:30:00Z", assignedTags: ["main", "2x", "modded"], risk: 2, enabled: true },
  { id: "p_zone", name: "ZoneManager", source: "umod", umodSlug: "zone-manager", installedVersion: "3.0.5", latestVersion: "3.0.5", latestUpdatedAt: "2026-02-01T09:00:00Z", assignedTags: ["modded"], risk: 2, enabled: true },
  { id: "p_wj_custom", name: "WillJum.Anticheat", source: "custom", installedVersion: "0.4.2", latestVersion: "0.4.2", latestUpdatedAt: "2026-05-20T10:00:00Z", assignedTags: ["main", "eu", "us"], risk: 3, enabled: true }
];
const PANEL_ORG_KEY = "panel.selectedOrgId";
function PanelPage() {
  const { orgs, manageableOrgIds, myOrgIds } = useAuth();
  const search = Route.useSearch();
  const tab = search.tab ?? "rcon";
  const allowedOrgIds = tab === "scripts" ? myOrgIds : manageableOrgIds;
  const allowedOrgs = useMemo(
    () => orgs.filter((o) => allowedOrgIds.includes(o.id)),
    [orgs, allowedOrgIds]
  );
  const [orgId, setOrgIdState] = useState(null);
  useEffect(() => {
    const cached = typeof window !== "undefined" ? localStorage.getItem(PANEL_ORG_KEY) : null;
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
  if (allowedOrgs.length === 0) {
    const isScripts = tab === "scripts";
    return <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
        <SiteNav />
        <main className="flex-1 overflow-y-auto">
          <div className="p-10 max-w-xl mx-auto">
            <div className="rounded-lg ring-1 ring-border bg-surface/40 p-8 text-center">
              <Building2 className="size-8 mx-auto text-muted-foreground mb-3" />
              <h1 className="text-lg font-semibold mb-1">
                {isScripts ? "Scripts \u2014 Staff only" : "Panel \u2014 Management only"}
              </h1>
              <p className="text-sm text-muted-foreground">
                {isScripts ? "You aren't a member of any organization." : "You don't have management on any organization."}
              </p>
            </div>
          </div>
        </main>
      </div>;
  }
  const activeOrg = allowedOrgs.find((o) => o.id === orgId) ?? allowedOrgs[0];
  const servers = MOCK_SERVERS_BY_ORG[activeOrg.id] ?? [];
  return <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-[1500px] mx-auto space-y-5">
          {
    /* Org switcher */
  }
          <div className="flex items-center justify-end gap-4 flex-wrap">
            <OrgSwitcher orgs={allowedOrgs} value={activeOrg.id} onChange={setOrgId} />
          </div>


          {tab === "rcon" && <RconTab key={activeOrg.id} servers={servers} />}
          {tab === "scripts" && <ScriptsTab key={activeOrg.id} servers={servers} orgId={activeOrg.id} />}
          {tab === "presets" && <PresetsTab key={activeOrg.id} servers={servers} />}
          {tab === "status" && <StatusTab key={activeOrg.id} servers={servers} />}
          {tab === "servers" && <ServersTab key={activeOrg.id} orgId={activeOrg.id} />}
        </div>
      </main>
    </div>;
}
function OrgSwitcher({
  orgs,
  value,
  onChange
}) {
  const current = orgs.find((o) => o.id === value);
  return <Popover>
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
    return <button
      key={o.id}
      onClick={() => onChange(o.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
    >
                <span
      className={"size-4 rounded-sm grid place-items-center ring-1 " + (checked ? "bg-brand ring-brand text-brand-foreground" : "ring-border text-transparent")}
    >
                  <Check className="size-3" />
                </span>
                <span className="text-xs font-medium flex-1">{o.name}</span>
                <span className="text-[9px] font-mono font-bold text-muted-foreground">
                  {o.short}
                </span>
              </button>;
  })}
        </div>
      </PopoverContent>
    </Popover>;
}
function RconTab({ servers }) {
  const [selected, setSelected] = useState(servers[0]?.id ?? "");
  const [lines, setLines] = useState([
    "[INFO] Connected to RCON",
    "[INFO] Server is running on map procedural_map (size 4500, seed 1337)",
    "[INFO] Population: 142/200"
  ]);
  const [cmd, setCmd] = useState("");
  const [pendingScript, setPendingScript] = useState(null);
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);
  const send = () => {
    if (!cmd.trim()) return;
    setLines((prev) => [
      ...prev,
      `> ${cmd}`,
      `[RCON] command "${cmd.split(" ")[0]}" executed`
    ]);
    setCmd("");
  };
  const runScript = (script, vars) => {
    const cmds = applyVars(script.command, vars).split("\n").map((c) => c.trim()).filter(Boolean);
    setLines((prev) => [
      ...prev,
      `[SCRIPT] \u25B6 ${script.name} on ${server?.name}`,
      ...cmds.flatMap((c) => [`> ${c}`, `[RCON] command "${c.split(" ")[0]}" executed`])
    ]);
    setPendingScript(null);
  };
  const onPickScript = (script) => {
    if (extractVars(script.command).length === 0) {
      runScript(script, {});
    } else {
      setPendingScript(script);
    }
  };
  const server = servers.find((s) => s.id === selected);
  if (!servers.length) return <EmptyState label="No servers configured for this org" />;
  return <div className="grid grid-cols-[260px_1fr] gap-4">
      <div className="space-y-1 ring-1 ring-border rounded-md bg-surface/40 p-2 h-fit">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 py-1">
          Servers
        </div>
        {servers.map((s) => <button
    key={s.id}
    onClick={() => setSelected(s.id)}
    className={"w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs " + (s.id === selected ? "bg-brand/15 ring-1 ring-brand/30" : "hover:bg-surface")}
  >
            <CircleDot className="size-3 text-success" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{s.name}</div>
              <div className="text-[10px] font-mono text-muted-foreground truncate">
                {s.ip}:{s.port}
              </div>
            </div>
          </button>)}
      </div>

      <div className="ring-1 ring-border rounded-md bg-background flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="size-3.5 text-brand shrink-0" />
            <span className="text-xs font-mono truncate">{server?.name}</span>
            <Badge variant="outline" className="text-[9px] font-mono shrink-0">
              RCON · {server?.ip}:{server?.rconPort}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ScriptPickerButton scripts={MOCK_SCRIPTS} onPick={onPickScript} />
            <Button size="sm" variant="ghost" onClick={() => setLines([])}>
              Clear
            </Button>
          </div>
        </div>
        <div
    ref={scrollRef}
    className="h-[420px] overflow-y-auto p-3 font-mono text-[11px] leading-relaxed bg-black/40"
  >
          {lines.map((l, i) => <div
    key={i}
    className={l.startsWith(">") ? "text-brand" : l.includes("[RCON]") ? "text-success" : l.includes("[SCRIPT]") ? "text-warning" : "text-muted-foreground"}
  >
              {l}
            </div>)}
        </div>
        <div className="border-t border-border p-2 flex gap-2">
          <span className="grid place-items-center px-2 font-mono text-xs text-brand">{">"}</span>
          <Input
    value={cmd}
    onChange={(e) => setCmd(e.target.value)}
    onKeyDown={(e) => e.key === "Enter" && send()}
    placeholder="Type an RCON command…"
    className="font-mono text-xs"
  />
          <Button size="sm" onClick={send}>
            Send
          </Button>
        </div>
      </div>

      <RunVarsDialog
    pending={pendingScript ? { script: pendingScript, targets: [selected], targetLabel: server?.name ?? "" } : null}
    onClose={() => setPendingScript(null)}
    onRun={(s, _t, vars) => runScript(s, vars)}
  />
    </div>;
}
function ScriptPickerButton({ scripts, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = scripts.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) || s.command.toLowerCase().includes(q.toLowerCase()));
  return <Popover open={open} onOpenChange={setOpen}>
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
          {filtered.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">No scripts found</div>}
          {filtered.map((s) => {
    const vars = extractVars(s.command);
    const lc = s.command.split("\n").filter(Boolean).length;
    return <button
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
                  <Badge variant="outline" className="text-[9px] font-mono h-4 px-1 ml-auto">{lc} cmd</Badge>
                  {vars.length > 0 && <Badge variant="outline" className="text-[9px] font-mono h-4 px-1 border-warning/40 text-warning bg-warning/5">
                      {vars.length} var
                    </Badge>}
                </div>
                {s.description && <span className="text-[10px] text-muted-foreground line-clamp-1 pl-4.5">{s.description}</span>}
              </button>;
  })}
        </div>
      </PopoverContent>
    </Popover>;
}
function ScriptsTab({ servers, orgId }) {
  const { rankOf } = useAuth();
  const userRank = rankOf(orgId);
  const [scripts, setScripts] = useState(MOCK_SCRIPTS);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [pendingRun, setPendingRun] = useState(null);
  const allTags = useMemo(
    () => Array.from(new Set(servers.flatMap((s) => s.tags))),
    [servers]
  );
  const executeRun = (script, targets, vars) => {
    const cmds = applyVars(script.command, vars).split("\n").map((c) => c.trim()).filter(Boolean);
    console.log("[mock] running", cmds, "on", targets);
    setPendingRun(null);
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
  return <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Pre-configured RCON commands. One script can hold multiple lines and{" "}
          <code className="font-mono text-brand">{`{variables}`}</code> that get prompted at run-time.
          Each script has a minimum rank required to execute.
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5 mr-1" /> New script
        </Button>
      </div>


      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {scripts.filter((s) => userRank >= s.minRank).map((s) => {
    const lines = s.command.split("\n").filter(Boolean);
    const vars = extractVars(s.command);
    const allowed = true;
    return <div
      key={s.id}
      className="ring-1 ring-border rounded-md bg-surface/40 p-3 flex flex-col gap-2.5"
    >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-sm font-semibold truncate">{s.name}</div>
                    <Badge variant="outline" className="text-[9px] font-mono h-4 px-1.5">
                      {lines.length} cmd{lines.length === 1 ? "" : "s"}
                    </Badge>
                    <Badge
      variant="outline"
      className={"text-[9px] font-mono h-4 px-1.5 " + (allowed ? "border-brand/40 text-brand bg-brand/5" : "border-destructive/40 text-destructive bg-destructive/5")}
      title={allowed ? "You can run this script" : "Requires higher rank"}
    >
                      {rankLabel(s.minRank)}+
                    </Badge>
                    {vars.map((v) => <Badge
      key={v}
      variant="outline"
      className="text-[9px] font-mono h-4 px-1.5 border-warning/40 text-warning bg-warning/5"
    >
                        {`{${v}}`}
                      </Badge>)}
                  </div>
                  {s.description && <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                      {s.description}
                    </p>}
                </div>
                <div className="flex gap-0.5">
                  <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(s)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
      size="icon"
      variant="ghost"
      className="size-7 text-destructive"
      onClick={() => setScripts((p) => p.filter((x) => x.id !== s.id))}
    >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>

              <pre className="text-[10px] font-mono text-brand bg-black/30 ring-1 ring-border rounded p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
                {s.command}
              </pre>

              {!allowed && <div className="text-[10px] font-mono text-destructive bg-destructive/5 ring-1 ring-destructive/30 rounded px-2 py-1">
                  Requires {rankLabel(s.minRank)} or higher to execute.
                </div>}

              <div className="grid grid-cols-[1fr_auto_auto] gap-1.5">
                <Button
      size="sm"
      onClick={() => triggerRun(s, servers.map((x) => x.id), `all ${servers.length} servers`)}
      disabled={!servers.length || !allowed}
    >
                  <Play className="size-3.5 mr-1" /> Run all
                </Button>
                <RunOnGroupButton
      tags={allTags}
      disabled={!allowed}
      onPick={(tag) => triggerRun(
        s,
        servers.filter((x) => x.tags.includes(tag)).map((x) => x.id),
        `group: ${tag}`
      )}
    />
                <RunOnServerButton
      servers={servers}
      disabled={!allowed}
      onPick={(srv) => triggerRun(s, [srv.id], srv.name)}
    />
              </div>
            </div>;
  })}

      </div>

      <RunVarsDialog pending={pendingRun} onClose={() => setPendingRun(null)} onRun={executeRun} />

      <ScriptEditDialog
    open={creating || !!editing}
    initial={editing}
    onClose={() => {
      setCreating(false);
      setEditing(null);
    }}
    onSave={(s) => {
      if (editing) {
        setScripts((p) => p.map((x) => x.id === editing.id ? { ...s, id: editing.id } : x));
      } else {
        setScripts((p) => [...p, { ...s, id: "sc_" + Math.random().toString(36).slice(2, 7) }]);
      }
      setCreating(false);
      setEditing(null);
    }}
  />
    </div>;
}
function RunOnGroupButton({
  tags,
  onPick,
  disabled
}) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
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
          {tags.map((t) => <button
    key={t}
    onClick={() => {
      onPick(t);
      setOpen(false);
    }}
    className="w-full text-left px-2 py-1.5 rounded hover:bg-surface text-xs font-mono flex items-center gap-2"
  >
              <Play className="size-3 text-brand" /> {t}
            </button>)}
        </div>
      </PopoverContent>
    </Popover>;
}
function RunOnServerButton({
  servers,
  onPick,
  disabled
}) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={!servers.length || disabled}>
          <Target className="size-3.5 mr-1" /> Run server
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 py-1">
          Pick a server
        </div>
        <div className="space-y-0.5 max-h-60 overflow-y-auto">
          {servers.map((s) => <button
    key={s.id}
    onClick={() => {
      onPick(s);
      setOpen(false);
    }}
    className="w-full text-left px-2 py-1.5 rounded hover:bg-surface text-xs flex items-center gap-2"
  >
              <Play className="size-3 text-brand shrink-0" />
              <span className="truncate">{s.name}</span>
            </button>)}
        </div>
      </PopoverContent>
    </Popover>;
}
function RunVarsDialog({
  pending,
  onClose,
  onRun
}) {
  const [values, setValues] = useState({});
  const vars = pending ? extractVars(pending.script.command) : [];
  useEffect(() => {
    if (pending) setValues(Object.fromEntries(extractVars(pending.script.command).map((v) => [v, ""])));
  }, [pending]);
  if (!pending) return null;
  const allFilled = vars.every((v) => values[v]?.trim());
  const preview = applyVars(pending.script.command, values);
  return <Dialog open={!!pending} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run “{pending.script.name}”</DialogTitle>
          <DialogDescription>
            Target: <span className="font-mono text-foreground">{pending.targetLabel}</span> · fill in the variables below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {vars.map((v) => <div key={v} className="space-y-1.5">
              <Label className="font-mono">{`{${v}}`}</Label>
              <Input
    value={values[v] ?? ""}
    onChange={(e) => setValues((p) => ({ ...p, [v]: e.target.value }))}
    placeholder={`value for ${v}`}
    className="font-mono text-xs"
  />
            </div>)}

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
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
    disabled={!allFilled}
    onClick={() => onRun(pending.script, pending.targets, values)}
  >
            <Play className="size-3.5 mr-1" /> Execute on {pending.targets.length} server
            {pending.targets.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
}
function ScriptEditDialog({
  open,
  initial,
  onClose,
  onSave
}) {
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    command: "",
    description: "",
    minRank: 2
  });
  useEffect(() => {
    if (open) {
      setDraft(initial ?? { id: "", name: "", command: "", description: "", minRank: 2 });
    }
  }, [open, initial]);
  const vars = extractVars(draft.command);
  return <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit script" : "New script"}</DialogTitle>
          <DialogDescription>
            One RCON command per line. Use <code className="font-mono text-brand">{`{name}`}</code> for variables — they'll be prompted at run-time.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
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
            {vars.length > 0 && <div className="flex flex-wrap gap-1 pt-1">
                <span className="text-[10px] text-muted-foreground">Detected variables:</span>
                {vars.map((v) => <Badge
    key={v}
    variant="outline"
    className="text-[9px] font-mono h-4 px-1.5 border-warning/40 text-warning bg-warning/5"
  >
                    {`{${v}}`}
                  </Badge>)}
              </div>}
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
                {RANK_OPTIONS.map((r) => <SelectItem key={r.value} value={String(r.value)}>
                    {r.label} (rank {r.value}+)
                  </SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Only staff with this team rank or higher in the active org can execute this script.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Textarea
    value={draft.description ?? ""}
    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
    rows={2}
  />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!draft.name || !draft.command} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
}
function PresetsTab({ servers }) {
  const [plugins, setPlugins] = useState(MOCK_PLUGINS);
  const [groupTags, setGroupTags] = useState(
    Array.from(new Set(servers.flatMap((s) => s.tags)))
  );
  const [newGroupTag, setNewGroupTag] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const update = (p) => {
    const affected = servers.filter((s) => s.tags.some((t) => p.assignedTags.includes(t)));
    console.log("[mock] pushing", p.name, p.latestVersion, "to", affected.map((s) => s.name));
    setPlugins(
      (prev) => prev.map((x) => x.id === p.id ? { ...x, installedVersion: x.latestVersion } : x)
    );
  };
  const toggleTag = (pluginId, t) => {
    setPlugins(
      (prev) => prev.map(
        (p) => p.id !== pluginId ? p : {
          ...p,
          assignedTags: p.assignedTags.includes(t) ? p.assignedTags.filter((x) => x !== t) : [...p.assignedTags, t]
        }
      )
    );
  };
  const setRisk = (pluginId, r) => {
    setPlugins((prev) => prev.map((p) => p.id === pluginId ? { ...p, risk: r } : p));
  };
  const unloadRisk = (r) => {
    setPlugins((prev) => prev.map((p) => p.risk === r ? { ...p, enabled: false } : p));
  };
  const togglePlugin = (id) => {
    setPlugins((prev) => prev.map((p) => p.id === id ? { ...p, enabled: !p.enabled } : p));
  };
  const riskCount = (r) => plugins.filter((p) => p.risk === r && p.enabled).length;
  return <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-xs text-muted-foreground max-w-xl">
          uMod &amp; custom plugins, grouped by server tag. Each plugin carries a <b>risk</b> rating (1–3); use the unload buttons to instantly disable a whole risk class across every matching server.
        </p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {[1, 2, 3].map((r) => <Button
    key={r}
    size="sm"
    variant="outline"
    onClick={() => unloadRisk(r)}
    disabled={riskCount(r) === 0}
    className={r === 1 ? "border-success/40 hover:bg-success/10 text-success" : r === 2 ? "border-warning/40 hover:bg-warning/10 text-warning" : "border-destructive/40 hover:bg-destructive/10 text-destructive"}
  >
              <AlertTriangle className="size-3.5 mr-1" /> Unload risk {r}
              <span className="ml-1 opacity-60">({riskCount(r)})</span>
            </Button>)}
          <div className="w-px h-6 bg-border mx-1" />
          <Button size="sm" onClick={() => setAddingCustom(true)}>
            <Upload className="size-3.5 mr-1" /> Add custom plugin
          </Button>
        </div>
      </div>

      {
    /* Group tag manager */
  }
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-2 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground pl-1">
          Server group tags
        </span>
        {groupTags.map((t) => <span key={t} className="px-2 py-0.5 rounded text-[10px] font-mono font-bold ring-1 bg-brand/10 ring-brand/30 text-brand">
            {t}
          </span>)}
        <div className="flex items-center gap-1 ml-auto">
          <Input
    value={newGroupTag}
    onChange={(e) => setNewGroupTag(e.target.value)}
    placeholder="new group tag"
    className="h-7 text-xs w-36"
    onKeyDown={(e) => {
      if (e.key === "Enter" && newGroupTag.trim()) {
        setGroupTags((p) => Array.from(/* @__PURE__ */ new Set([...p, newGroupTag.trim()])));
        setNewGroupTag("");
      }
    }}
  />
          <Button
    size="sm"
    variant="outline"
    disabled={!newGroupTag.trim()}
    onClick={() => {
      setGroupTags((p) => Array.from(/* @__PURE__ */ new Set([...p, newGroupTag.trim()])));
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
    const affected = servers.filter((s) => s.tags.some((t) => p.assignedTags.includes(t)));
    const unassigned = groupTags.filter((t) => !p.assignedTags.includes(t));
    return <div
      key={p.id}
      className={"grid grid-cols-[1.6fr_1fr_0.8fr_2fr_auto] gap-3 px-3 py-2.5 border-b border-border last:border-0 items-center " + (p.enabled ? "" : "opacity-50")}
    >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold truncate">{p.name}</span>
                  <Badge
      variant="outline"
      className={"text-[9px] font-mono h-4 px-1.5 " + (p.source === "custom" ? "border-brand/40 text-brand bg-brand/5" : "border-border text-muted-foreground")}
    >
                    {p.source}
                  </Badge>
                  {!p.enabled && <Badge variant="outline" className="text-[9px] font-mono h-4 px-1.5 border-destructive/40 text-destructive bg-destructive/5">
                      unloaded
                    </Badge>}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground truncate">
                  {p.source === "umod" ? `umod.org/${p.umodSlug}` : "custom upload"}
                </div>
              </div>
              <div>
                <div className="text-xs font-mono flex items-center gap-1.5">
                  {p.installedVersion}
                  {outdated && <>
                      <span className="text-muted-foreground/50">→</span>
                      <span className="text-warning">{p.latestVersion}</span>
                      <span className="size-1.5 rounded-full bg-warning animate-pulse" />
                    </>}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {new Date(p.latestUpdatedAt).toLocaleDateString()}
                </div>
              </div>
              <RiskPicker risk={p.risk} onChange={(r) => setRisk(p.id, r)} />
              <div className="flex gap-1 flex-wrap items-center">
                {p.assignedTags.length === 0 && <span className="text-[10px] text-muted-foreground italic">no tags</span>}
                {p.assignedTags.map((t) => <button
      key={t}
      onClick={() => toggleTag(p.id, t)}
      className="group inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold ring-1 bg-brand/15 ring-brand/40 text-brand hover:bg-destructive/15 hover:ring-destructive/40 hover:text-destructive transition-colors"
      title={`Remove ${t}`}
    >
                    {t}
                    <X className="size-2.5 opacity-0 group-hover:opacity-100" />
                  </button>)}
                {unassigned.length > 0 && <AddTagPopover tags={unassigned} onPick={(t) => toggleTag(p.id, t)} />}
              </div>
              <div className="flex items-center gap-1">
                <Button
      size="icon"
      variant="ghost"
      className="size-7"
      title={p.enabled ? "Unload plugin" : "Load plugin"}
      onClick={() => togglePlugin(p.id)}
    >
                  <Power className={"size-3.5 " + (p.enabled ? "text-success" : "text-muted-foreground")} />
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
            </div>;
  })}
      </div>

      <CustomPluginDialog
    open={addingCustom}
    groupTags={groupTags}
    onClose={() => setAddingCustom(false)}
    onSave={(p) => {
      setPlugins((prev) => [...prev, { ...p, id: "p_" + Math.random().toString(36).slice(2, 7) }]);
      setAddingCustom(false);
    }}
  />
    </div>;
}
function RiskPicker({ risk, onChange }) {
  const cls = (r, on) => on ? r === 1 ? "bg-success/20 ring-success/50 text-success" : r === 2 ? "bg-warning/20 ring-warning/50 text-warning" : "bg-destructive/20 ring-destructive/50 text-destructive" : "bg-surface ring-border text-muted-foreground hover:text-foreground";
  return <div className="inline-flex items-center gap-0.5 ring-1 ring-border rounded p-0.5 w-fit">
      {[1, 2, 3].map((r) => <button
    key={r}
    onClick={() => onChange(r)}
    className={"px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 " + cls(r, risk === r)}
    title={`Risk ${r}`}
  >
          {r}
        </button>)}
    </div>;
}
function AddTagPopover({ tags, onPick }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
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
          {tags.map((t) => <button
    key={t}
    onClick={() => {
      onPick(t);
      setOpen(false);
    }}
    className="w-full text-left px-2 py-1 rounded hover:bg-surface text-[11px] font-mono"
  >
              {t}
            </button>)}
        </div>
      </PopoverContent>
    </Popover>;
}
function CustomPluginDialog({
  open,
  groupTags,
  onClose,
  onSave
}) {
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
  return <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add custom plugin</DialogTitle>
          <DialogDescription>
            Upload a .cs / .dll plugin that isn't on uMod. It will sit alongside uMod plugins and follow the same tag &amp; risk rules.
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
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="MyPlugin" />
            </div>
            <div className="space-y-1.5">
              <Label>Version</Label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)} className="font-mono" />
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
    return <button
      key={t}
      onClick={() => setTags((p) => on ? p.filter((x) => x !== t) : [...p, t])}
      className={"px-2 py-0.5 rounded text-[11px] font-mono font-bold ring-1 transition-colors " + (on ? "bg-brand/15 ring-brand/40 text-brand" : "bg-surface ring-border text-muted-foreground hover:text-foreground")}
    >
                    {t}
                  </button>;
  })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
    disabled={!name || !fileName}
    onClick={() => onSave({
      name,
      source: "custom",
      installedVersion: version,
      latestVersion: version,
      latestUpdatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      assignedTags: tags,
      risk,
      enabled: true
    })}
  >
            <Upload className="size-3.5 mr-1" /> Add plugin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
}
function StatusTab({ servers }) {
  const metric = (seed, max) => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) & 65535;
    return Math.round(h % 1e3 / 1e3 * max);
  };
  const metricF = (seed, max) => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) & 65535;
    return Number((h % 1e3 / 1e3 * max).toFixed(2));
  };
  const PROBE_LOCATIONS = ["FRA", "LON", "NYC", "SGP", "SYD"];
  const [detail, setDetail] = useState(null);
  const serversByNode = useMemo(() => {
    const map = /* @__PURE__ */ new Map();
    for (const s of servers) {
      const arr = map.get(s.node) ?? [];
      arr.push(s);
      map.set(s.node, arr);
    }
    return map;
  }, [servers]);
  return <div className="space-y-5">
      <div>
        <h3 className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">
          Physical nodes · network from globalping
        </h3>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {MOCK_NODES.map((n) => {
    const nodeServers = serversByNode.get(n.id) ?? [];
    const cpu = metric(n.id + "cpu", 80);
    const mem = metric(n.id + "mem", 75);
    const pingMs = metric(n.id + "hbping", 40) + 5;
    const pteroOk = metric(n.id + "hbptero", 100) % 100 < 92;
    return <div
      key={n.id}
      className="ring-1 ring-border rounded-md bg-surface/40 p-3 space-y-3"
    >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Server className="size-3.5 text-brand shrink-0" />
                    <span className="text-sm font-semibold truncate">{n.name}</span>
                    <span className="text-[9px] font-mono text-muted-foreground shrink-0">{n.code}</span>
                  </div>
                  <Badge
      variant="outline"
      className={n.status === "online" ? "border-success/40 text-success bg-success/10 text-[9px]" : "border-destructive/40 text-destructive bg-destructive/10 text-[9px]"}
    >
                    {n.status}
                  </Badge>
                </div>

                {
      /* Heartbeats — Ping + Pterodactyl */
    }
                <div className="flex items-center gap-1.5">
                  <HeartbeatBadge label={`PING ${pingMs}ms`} ok={pingMs < 30} />
                  <HeartbeatBadge label={pteroOk ? "PTERO OK" : "PTERO FAIL"} ok={pteroOk} />
                </div>

                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] font-mono">
                  <div className="text-muted-foreground truncate" title={n.cpu}>{n.cpu}</div>
                  <div className="text-muted-foreground truncate" title={n.ram}>{n.ram}</div>
                  <div className="text-muted-foreground truncate" title={n.storage}>{n.storage}</div>
                  <div className="text-muted-foreground truncate">{n.link} · {n.ip}</div>
                </div>

                <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                  <span>UPTIME <span className="text-foreground">{n.uptimeHours}h</span></span>
                  <span>HOSTING <span className="text-foreground">{nodeServers.length}</span> server{nodeServers.length === 1 ? "" : "s"}</span>
                </div>

                {
      /* mini graphs — click any to drill down */
    }
                <div className="grid grid-cols-2 gap-1.5">
                  <ClickableMini onClick={() => setDetail({ node: n, metric: "mem" })}>
                    <MiniGraph
      seedId={n.id + "g-mem"}
      label="MEM"
      value={`${mem}%`}
      color="hsl(160 80% 55%)"
      data={seedSeries(n.id + "mem-s", 32, mem, 6)}
      yMax={100}
    />
                  </ClickableMini>
                  <ClickableMini onClick={() => setDetail({ node: n, metric: "cpu" })}>
                    <MiniGraph
      seedId={n.id + "g-cpu"}
      label="CPU"
      value={`${cpu}%`}
      color="hsl(200 90% 60%)"
      data={seedSeries(n.id + "cpu-s", 32, cpu, 10)}
      yMax={100}
    />
                  </ClickableMini>
                  <ClickableMini onClick={() => setDetail({ node: n, metric: "net" })}>
                    <MiniGraph
      seedId={n.id + "g-net"}
      label="NET"
      value={`${(n.netInMbps + n.netOutMbps).toFixed(0)}Mb`}
      color="hsl(280 80% 65%)"
      data={seedSeries(n.id + "net-s", 32, n.netInMbps + n.netOutMbps, (n.netInMbps + n.netOutMbps) * 0.4, 0)}
    />
                  </ClickableMini>
                  <ClickableMini onClick={() => setDetail({ node: n, metric: "loss" })}>
                    <MiniGraph
      seedId={n.id + "g-loss"}
      label="LOSS"
      value={`${metric(n.id + "lossavg", 4)}%`}
      color="hsl(0 80% 60%)"
      data={seedSeries(n.id + "loss-s", 32, metric(n.id + "lossavg", 4), 2, 0)}
      yMax={10}
    />
                  </ClickableMini>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                  <div className="flex items-center gap-1">
                    <Wifi className="size-2.5 text-sky-300" />
                    <span className="text-muted-foreground">IN</span>
                    <span className="text-sky-300 font-bold ml-auto">{n.netInMbps.toFixed(2)} Mbps</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Wifi className="size-2.5 text-emerald-300" />
                    <span className="text-muted-foreground">OUT</span>
                    <span className="text-emerald-300 font-bold ml-auto">{n.netOutMbps.toFixed(2)} Mbps</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <span className="text-muted-foreground uppercase tracking-widest">Bandwidth</span>
                    {n.bwCapGB === null ? <span className="text-muted-foreground">∞ Unmetered · {fmtBw(n.bwUsedGB)} used</span> : <span className="text-muted-foreground">
                        <span className="text-success">{fmtBw(n.bwUsedGB)}</span> / {fmtBw(n.bwCapGB)}
                        <span className="ml-1 text-muted-foreground/70">({Math.round(n.bwUsedGB / n.bwCapGB * 100)}%)</span>
                      </span>}
                  </div>
                  <div className="h-1.5 rounded-full bg-surface ring-1 ring-border overflow-hidden">
                    <div
      className="h-full bg-success"
      style={{ width: n.bwCapGB === null ? "8%" : `${Math.min(100, n.bwUsedGB / n.bwCapGB * 100)}%` }}
    />
                  </div>
                </div>

                <div className="border-t border-border pt-2 space-y-1">
                  <div className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    <Globe2 className="size-3" /> Loss per probe
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {PROBE_LOCATIONS.map((loc) => {
      const ping = metric(n.id + loc + "p", 80) + 5;
      const loss = metric(n.id + loc + "l", 6);
      const bad = loss >= 3;
      return <div
        key={loc}
        className={"rounded px-1 py-0.5 text-center ring-1 " + (bad ? "bg-destructive/10 ring-destructive/30" : "bg-success/5 ring-border")}
        title={`${ping}ms \xB7 ${loss}% loss from ${loc}`}
      >
                          <div className="text-[8px] font-mono text-muted-foreground">{loc}</div>
                          <div
        className={"text-[10px] font-mono font-bold " + (bad ? "text-destructive" : "text-foreground")}
      >
                            {loss}%
                          </div>
                        </div>;
    })}
                  </div>
                </div>
              </div>;
  })}
        </div>
      </div>

      {
    /* Game servers — condensed dense table-style rows */
  }
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
            Game servers ({servers.length})
          </h3>
          <div className="text-[10px] font-mono text-muted-foreground flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-success" /> ok</span>
            <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-warning" /> warn</span>
            <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-destructive" /> alert</span>
          </div>
        </div>

        <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
          <div className="grid grid-cols-[1.6fr_0.9fr_minmax(0,_1fr)_minmax(0,_1fr)_auto] gap-2 px-3 py-1.5 border-b border-border bg-surface/60 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
            <div>Server</div>
            <div>Node</div>
            <div>CPU (threads)</div>
            <div>RAM (GB)</div>
            <div className="w-28 text-right">Heartbeats</div>
          </div>
          {servers.map((s) => {
    const threads = metricF(s.id + "thr", 4) + 0.1;
    const ramGB = metricF(s.id + "ram", 10) + 0.4;
    return <div
      key={s.id}
      className="grid grid-cols-[1.6fr_0.9fr_minmax(0,_1fr)_minmax(0,_1fr)_auto] gap-2 px-3 py-2 border-b border-border last:border-0 items-center text-[11px]"
    >
                <div className="flex items-center gap-2 min-w-0">
                  <CircleDot className="size-2.5 text-success shrink-0" />
                  <span className="font-medium truncate">{s.name}</span>
                  <span className="text-[9px] font-mono text-muted-foreground truncate">
                    {s.ip}:{s.port}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground truncate">{s.node}</div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <Cpu className="size-3 text-muted-foreground shrink-0" />
                  <span className="font-mono tabular-nums text-[11px]">{threads.toFixed(2)}</span>
                  <span className="font-mono text-[9px] text-muted-foreground">thr</span>
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <HardDrive className="size-3 text-muted-foreground shrink-0" />
                  <span className="font-mono tabular-nums text-[11px]">{ramGB.toFixed(2)}</span>
                  <span className="font-mono text-[9px] text-muted-foreground">GB</span>
                </div>
                <div className="flex items-center gap-1 justify-end w-28">
                  <HeartbeatBadge label="P" ok />
                  <HeartbeatBadge label="BM" ok />
                  <HeartbeatBadge label="RCN" ok />
                </div>
              </div>;
  })}
        </div>
        <div className="text-[10px] text-muted-foreground/70 font-mono mt-1.5">
          Per-server CPU shown as threads in use, RAM as GB used — game servers run uncapped on their host. Network throughput is tracked per dedicated machine above. Heartbeats: P = Pterodactyl, BM = BattleMetrics, RCN = RCON.
        </div>
      </div>

      <NodeDetailDialog detail={detail} onClose={() => setDetail(null)} />
    </div>;
}
function MiniGraph({
  seedId,
  label,
  value,
  color,
  data,
  yMax
}) {
  const gid = `mg-${seedId.replace(/[^a-z0-9]/gi, "")}`;
  return <div className="rounded ring-1 ring-border bg-black/30 px-1.5 pt-1 pb-0.5">
      <div className="flex items-center justify-between text-[9px] font-mono uppercase tracking-widest">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-bold" style={{ color }}>{value}</span>
      </div>
      <div className="h-9 -mx-1 -mb-0.5">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.45} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[0, yMax ?? "auto"]} />
            <Area
    type="monotone"
    dataKey="v"
    stroke={color}
    strokeWidth={1.25}
    fill={`url(#${gid})`}
    isAnimationActive={false}
    dot={false}
  />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>;
}
function CompactBar({
  icon: Icon,
  value,
  suffix,
  max = 100
}) {
  const pct = Math.min(100, value / max * 100);
  const color = pct > 80 ? "bg-destructive" : pct > 60 ? "bg-warning" : "bg-success";
  return <div className="flex items-center gap-1.5 min-w-0">
      <Icon className="size-3 text-muted-foreground shrink-0" />
      <div className="flex-1 h-1 rounded-full bg-surface overflow-hidden">
        <div className={"h-full " + color} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono tabular-nums text-[10px] w-14 text-right shrink-0">
        {value}
        {suffix}
      </span>
    </div>;
}
function HeartbeatBadge({ label, ok }) {
  return <span
    className={"text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded ring-1 " + (ok ? "bg-success/10 ring-success/30 text-success" : "bg-destructive/10 ring-destructive/30 text-destructive")}
  >
      {label}
    </span>;
}
function ServersTab({ orgId }) {
  const [servers, setServers] = useState(MOCK_SERVERS_BY_ORG[orgId] ?? []);
  const [tags, setTags] = useState(MOCK_TAGS);
  const [nodes, setNodes] = useState(MOCK_NODES);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [creatingNode, setCreatingNode] = useState(false);
  const [newTag, setNewTag] = useState("");
  return <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground">
          Servers shown in this panel. Add servers from Pterodactyl by IP/port; tag them to group with scripts &amp; plugin presets.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setCreatingNode(true)}>
            <Plus className="size-3.5 mr-1" /> Add node
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5 mr-1" /> Add server
          </Button>
        </div>
      </div>

      {
    /* Nodes manager */
  }
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Dedicated machines / nodes
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {nodes.map((n) => <div key={n.id} className="ring-1 ring-border rounded bg-background/40 p-2 flex items-start gap-2">
              <Server className="size-3.5 text-brand mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <div className="text-xs font-semibold truncate">{n.name}</div>
                  <span className="text-[9px] font-mono text-muted-foreground">{n.code}</span>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground truncate">
                  {n.ip} · {n.link}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/80 truncate">
                  {n.cpu} · {n.ram}
                </div>
              </div>
              <button
    onClick={() => setNodes((p) => p.filter((x) => x.id !== n.id))}
    className="text-muted-foreground hover:text-destructive"
    title="Remove node"
  >
                <Trash2 className="size-3.5" />
              </button>
            </div>)}
          {nodes.length === 0 && <div className="text-[11px] text-muted-foreground col-span-full text-center py-3">
              No nodes yet.
            </div>}
        </div>
      </div>

      {
    /* Tags manager */
  }
      <div className="ring-1 ring-border rounded-md bg-surface/40 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Tags / server groups
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 items-center">
          {tags.map((t) => <span
    key={t}
    className="flex items-center gap-1 px-2 py-1 rounded bg-surface ring-1 ring-border text-[11px] font-mono"
  >
              {t}
              <button
    onClick={() => setTags((p) => p.filter((x) => x !== t))}
    className="text-muted-foreground hover:text-destructive"
  >
                <X className="size-3" />
              </button>
            </span>)}
          <div className="flex items-center gap-1">
            <Input
    value={newTag}
    onChange={(e) => setNewTag(e.target.value)}
    placeholder="new-tag"
    className="h-7 w-28 text-xs"
    onKeyDown={(e) => {
      if (e.key === "Enter" && newTag.trim()) {
        setTags((p) => Array.from(/* @__PURE__ */ new Set([...p, newTag.trim()])));
        setNewTag("");
      }
    }}
  />
            <Button
    size="sm"
    variant="outline"
    onClick={() => {
      if (newTag.trim()) {
        setTags((p) => Array.from(/* @__PURE__ */ new Set([...p, newTag.trim()])));
        setNewTag("");
      }
    }}
  >
              Add tag
            </Button>
          </div>
        </div>
      </div>

      {
    /* Servers list */
  }
      <div className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden">
        <div className="grid grid-cols-[1.5fr_1.2fr_1fr_2fr_auto] gap-3 px-3 py-2 border-b border-border bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          <div>Name</div>
          <div>IP : Port</div>
          <div>Node</div>
          <div>Tags</div>
          <div />
        </div>
        {servers.length === 0 && <div className="p-6 text-center text-xs text-muted-foreground">No servers yet.</div>}
        {servers.map((s) => <div
    key={s.id}
    className="grid grid-cols-[1.5fr_1.2fr_1fr_2fr_auto] gap-3 px-3 py-2 border-b border-border last:border-0 items-center"
  >
            <div className="text-sm font-medium truncate">{s.name}</div>
            <div className="text-xs font-mono text-muted-foreground">
              {s.ip}:{s.port} <span className="opacity-60">/ rcon {s.rconPort}</span>
            </div>
            <div className="text-xs font-mono text-muted-foreground">{s.node}</div>
            <div className="flex gap-1 flex-wrap">
              {s.tags.map((t) => <span
    key={t}
    className="px-1.5 py-0.5 rounded bg-brand/15 text-brand text-[10px] font-mono font-bold"
  >
                  {t}
                </span>)}
            </div>
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(s)}>
                <Pencil className="size-3.5" />
              </Button>
              <Button
    size="icon"
    variant="ghost"
    className="size-7 text-destructive"
    onClick={() => setServers((p) => p.filter((x) => x.id !== s.id))}
  >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>)}
      </div>

      <ServerEditDialog
    open={creating || !!editing}
    initial={editing}
    tags={tags}
    nodes={nodes.map((n) => n.id)}
    onClose={() => {
      setCreating(false);
      setEditing(null);
    }}
    onSave={(s) => {
      if (editing) {
        setServers((p) => p.map((x) => x.id === editing.id ? { ...s, id: editing.id } : x));
      } else {
        setServers((p) => [...p, { ...s, id: "s_" + Math.random().toString(36).slice(2, 7) }]);
      }
      setCreating(false);
      setEditing(null);
    }}
  />

      <NodeAddDialog
    open={creatingNode}
    onClose={() => setCreatingNode(false)}
    onSave={(n) => {
      setNodes((p) => [...p, { ...n, id: "n_" + Math.random().toString(36).slice(2, 7) }]);
      setCreatingNode(false);
    }}
  />
    </div>;
}
function ServerEditDialog({
  open,
  initial,
  tags,
  nodes,
  onClose,
  onSave
}) {
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    ip: "",
    port: 28015,
    rconPort: 28016,
    tags: [],
    node: nodes[0] ?? ""
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
          node: nodes[0] ?? ""
        }
      );
    }
  }, [open, initial, nodes]);
  const toggle = (t) => setDraft((d) => ({
    ...d,
    tags: d.tags.includes(t) ? d.tags.filter((x) => x !== t) : [...d.tags, t]
  }));
  return <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit server" : "Add server"}</DialogTitle>
          <DialogDescription>
            Configure how this server appears in the panel. Startup variables stay in Pterodactyl.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5 col-span-1">
              <Label>IP</Label>
              <Input value={draft.ip} onChange={(e) => setDraft({ ...draft, ip: e.target.value })} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>Port</Label>
              <Input
    type="number"
    value={draft.port}
    onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
    className="font-mono"
  />
            </div>
            <div className="space-y-1.5">
              <Label>RCON port</Label>
              <Input
    type="number"
    value={draft.rconPort}
    onChange={(e) => setDraft({ ...draft, rconPort: Number(e.target.value) })}
    className="font-mono"
  />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Node</Label>
            <Select value={draft.node} onValueChange={(v) => setDraft({ ...draft, node: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {nodes.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Tags</Label>
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => {
    const on = draft.tags.includes(t);
    return <button
      key={t}
      onClick={() => toggle(t)}
      className={"px-2 py-0.5 rounded text-[11px] font-mono font-bold ring-1 transition-colors " + (on ? "bg-brand/15 ring-brand/40 text-brand" : "bg-surface ring-border text-muted-foreground hover:text-foreground")}
    >
                    {t}
                  </button>;
  })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!draft.name || !draft.ip} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
}
function EmptyState({ label }) {
  return <div className="p-10 text-center text-xs text-muted-foreground ring-1 ring-border rounded-md bg-surface/40">
      {label}
    </div>;
}
function NodeAddDialog({
  open,
  onClose,
  onSave
}) {
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
    bwCapGB: null
  };
  const [draft, setDraft] = useState(empty);
  const [metered, setMetered] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(empty);
      setMetered(false);
    }
  }, [open]);
  return <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add dedicated machine</DialogTitle>
          <DialogDescription>
            Register a node so its servers and metrics show up in the status panel.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="COV1234" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="willjum-game-eu-02" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>IP</Label>
              <Input value={draft.ip} onChange={(e) => setDraft({ ...draft, ip: e.target.value })} className="font-mono" placeholder="185.83.154.x" />
            </div>
            <div className="space-y-1.5">
              <Label>Link</Label>
              <Select value={draft.link} onValueChange={(v) => setDraft({ ...draft, link: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
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
            <Input value={draft.cpu} onChange={(e) => setDraft({ ...draft, cpu: e.target.value })} placeholder="Ryzen 9 7900" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>RAM</Label>
              <Input value={draft.ram} onChange={(e) => setDraft({ ...draft, ram: e.target.value })} placeholder="256GB DDR5" />
            </div>
            <div className="space-y-1.5">
              <Label>Storage</Label>
              <Input value={draft.storage} onChange={(e) => setDraft({ ...draft, storage: e.target.value })} placeholder="2x 2TB NVMe" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Bandwidth used (GB)</Label>
              <Input type="number" value={draft.bwUsedGB} onChange={(e) => setDraft({ ...draft, bwUsedGB: Number(e.target.value) })} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>{metered ? "Cap (GB)" : "Unmetered"}</Label>
              <div className="flex items-center gap-2">
                <Input
    type="number"
    disabled={!metered}
    value={draft.bwCapGB ?? 0}
    onChange={(e) => setDraft({ ...draft, bwCapGB: Number(e.target.value) })}
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
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
    disabled={!draft.name || !draft.ip || !draft.code}
    onClick={() => onSave(draft)}
  >
            Add node
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
}
function ClickableMini({ onClick, children }) {
  return <button
    type="button"
    onClick={onClick}
    className="text-left rounded ring-1 ring-transparent hover:ring-brand/40 hover:bg-surface/40 transition-colors cursor-pointer"
    title="Click to drill down"
  >
      {children}
    </button>;
}
const RANGES = [
  { id: "1h", label: "1h", points: 60, tickFmt: (i, n) => `${-Math.round(n - i)}m` },
  { id: "6h", label: "6h", points: 72, tickFmt: (i, n) => `${-Math.round((n - i) * 5)}m` },
  { id: "24h", label: "24h", points: 144, tickFmt: (i, n) => `-${Math.round((n - i) * 10 / 60)}h` },
  { id: "7d", label: "7d", points: 168, tickFmt: (i, n) => `-${Math.round(n - i)}h` },
  { id: "30d", label: "30d", points: 240, tickFmt: (i, n) => `-${Math.round((n - i) * 3)}h` }
];
function NodeDetailDialog({
  detail,
  onClose
}) {
  const [range, setRange] = useState("24h");
  const [activeMetric, setActiveMetric] = useState("cpu");
  const [brush, setBrush] = useState(null);
  useEffect(() => {
    if (detail) {
      setActiveMetric(detail.metric);
      setRange("24h");
      setBrush(null);
    }
  }, [detail]);
  if (!detail) return null;
  const { node } = detail;
  const seedMetric = (seed, max2) => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) & 65535;
    return Math.round(h % 1e3 / 1e3 * max2);
  };
  const cpu = seedMetric(node.id + "cpu", 80);
  const mem = seedMetric(node.id + "mem", 75);
  const loss = seedMetric(node.id + "lossavg", 4);
  const net = node.netInMbps + node.netOutMbps;
  const METRICS = {
    cpu: { label: "CPU", unit: "%", color: "hsl(200 90% 60%)", base: cpu, jitter: 14, yMax: 100 },
    mem: { label: "Memory", unit: "%", color: "hsl(160 80% 55%)", base: mem, jitter: 8, yMax: 100 },
    net: { label: "Network", unit: "Mbps", color: "hsl(280 80% 65%)", base: net, jitter: net * 0.5 },
    loss: { label: "Packet loss", unit: "%", color: "hsl(0 80% 60%)", base: loss, jitter: 3, yMax: 12 }
  };
  const m = METRICS[activeMetric];
  const rangeDef = RANGES.find((r) => r.id === range);
  const data = seedSeries(node.id + activeMetric + range, rangeDef.points, m.base, m.jitter, 0);
  const slice = brush ? data.slice(brush.start, brush.end + 1) : data;
  const min = slice.reduce((a, b) => Math.min(a, b.v), Infinity);
  const max = slice.reduce((a, b) => Math.max(a, b.v), -Infinity);
  const avg = slice.reduce((a, b) => a + b.v, 0) / slice.length;
  const gid = `nd-${activeMetric}-${range}-${node.id}`;
  return <Dialog open={!!detail} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-4 text-brand" /> {node.name}
            <span className="text-[10px] font-mono text-muted-foreground">{node.code}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            {node.cpu} · {node.ram} · {node.storage} · {node.link} · {node.ip}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
          {
    /* metric switcher */
  }
          <div className="flex items-center gap-1 ring-1 ring-border rounded p-0.5 bg-surface/30">
            {Object.keys(METRICS).map((k) => {
    const on = k === activeMetric;
    return <button
      key={k}
      onClick={() => {
        setActiveMetric(k);
        setBrush(null);
      }}
      className={"px-2.5 py-1 text-[11px] font-mono rounded transition-colors " + (on ? "bg-background ring-1 ring-border text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
      style={on ? { color: METRICS[k].color } : void 0}
    >
                  {METRICS[k].label}
                </button>;
  })}
          </div>
          {
    /* range presets */
  }
          <div className="flex items-center gap-1 ring-1 ring-border rounded p-0.5 bg-surface/30">
            {RANGES.map((r) => {
    const on = r.id === range;
    return <button
      key={r.id}
      onClick={() => {
        setRange(r.id);
        setBrush(null);
      }}
      className={"px-2 py-1 text-[10px] font-mono rounded " + (on ? "bg-background ring-1 ring-border text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
    >
                  {r.label}
                </button>;
  })}
          </div>
        </div>

        {
    /* Stat strip */
  }
        <div className="grid grid-cols-4 gap-2 pt-1">
          {[
    { k: "Current", v: `${m.base.toFixed(2)}${m.unit}` },
    { k: "Min", v: `${min.toFixed(2)}${m.unit}` },
    { k: "Avg", v: `${avg.toFixed(2)}${m.unit}` },
    { k: "Max", v: `${max.toFixed(2)}${m.unit}` }
  ].map((s) => <div key={s.k} className="ring-1 ring-border rounded bg-surface/30 px-2 py-1.5">
              <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">{s.k}</div>
              <div className="text-sm font-mono font-bold" style={{ color: m.color }}>{s.v}</div>
            </div>)}
        </div>

        {
    /* Main chart */
  }
        <div className="ring-1 ring-border rounded-md bg-black/30 p-2">
          <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest mb-1">
            <span className="text-muted-foreground">{m.label} · {rangeDef.label}{brush ? " \xB7 zoomed" : ""}</span>
            <span className="text-muted-foreground">
              drag the brush below to zoom
              {brush && <button onClick={() => setBrush(null)} className="ml-2 text-brand hover:underline">reset</button>}
            </span>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={m.color} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={m.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis
    dataKey="i"
    tick={{ fill: "currentColor", fontSize: 9, opacity: 0.6 }}
    tickFormatter={(i) => rangeDef.tickFmt(i, data.length - 1)}
    stroke="currentColor"
    strokeOpacity={0.2}
    minTickGap={32}
  />
                <YAxis
    domain={[0, m.yMax ?? "auto"]}
    tick={{ fill: "currentColor", fontSize: 9, opacity: 0.6 }}
    stroke="currentColor"
    strokeOpacity={0.2}
    width={36}
    tickFormatter={(v) => `${v}${m.unit === "Mbps" ? "" : m.unit}`}
  />
                <RTooltip
    contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", fontSize: 11, fontFamily: "ui-monospace, monospace" }}
    labelFormatter={(i) => rangeDef.tickFmt(Number(i), data.length - 1)}
    formatter={(v) => [`${v}${m.unit}`, m.label]}
  />
                <Area
    type="monotone"
    dataKey="v"
    stroke={m.color}
    strokeWidth={1.75}
    fill={`url(#${gid})`}
    isAnimationActive={false}
    dot={false}
  />
                <Brush
    dataKey="i"
    height={22}
    stroke={m.color}
    fill="transparent"
    travellerWidth={8}
    startIndex={brush?.start}
    endIndex={brush?.end}
    onChange={(r) => {
      if (r?.startIndex != null && r?.endIndex != null) {
        if (r.startIndex === 0 && r.endIndex === data.length - 1) setBrush(null);
        else setBrush({ start: r.startIndex, end: r.endIndex });
      }
    }}
    tickFormatter={(i) => rangeDef.tickFmt(Number(i), data.length - 1)}
  />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
}
export {
  Route
};

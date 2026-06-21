import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertCircle,
  GripVertical,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
const Route = createFileRoute("/threat-triggers")({
  head: () => ({ meta: [{ title: "Threat Triggers \u2014 IronSight" }] }),
  component: ThreatTriggersPage,
});
const FACTS = [
  {
    id: "proxy",
    label: "Proxy / VPN detected",
    type: "bool",
    description: "IP flagged as proxy or VPN exit node",
  },
  {
    id: "vacBans",
    label: "VAC bans",
    type: "number",
    unit: "bans",
    description: "Number of VAC bans on Steam profile",
  },
  {
    id: "gameBans",
    label: "Game bans",
    type: "number",
    unit: "bans",
    description: "Non-VAC game bans on Steam profile",
  },
  {
    id: "daysSinceBan",
    label: "Days since last ban",
    type: "number",
    unit: "days",
    description: "Days since most recent ban anywhere",
  },
  {
    id: "accountAge",
    label: "Steam account age",
    type: "number",
    unit: "yrs",
    description: "Years since Steam profile creation",
  },
  {
    id: "playtimeHours",
    label: "Rust playtime",
    type: "number",
    unit: "hrs",
    description: "Total Rust hours on Steam",
  },
  {
    id: "bmBanHours",
    label: "BattleMetrics ban hours",
    type: "number",
    unit: "hrs",
    description: "Sum of ban durations on BM in last 12mo",
  },
  {
    id: "bmActiveBans",
    label: "BattleMetrics active bans",
    type: "number",
    unit: "bans",
    description: "Bans active right now on BM",
  },
  {
    id: "f7Last1h",
    label: "F7 reports in last 1h",
    type: "number",
    unit: "reports",
    description: "In-game F7 reports filed in last hour",
  },
  {
    id: "f7Last24h",
    label: "F7 reports in last 24h",
    type: "number",
    unit: "reports",
    description: "In-game F7 reports filed in last day",
  },
  {
    id: "f7Wipe",
    label: "F7 reports this wipe",
    type: "number",
    unit: "reports",
    description: "In-game F7 reports filed this wipe",
  },
  {
    id: "priorOffenses",
    label: "Prior offenses (your org)",
    type: "number",
    unit: "offenses",
    description: "Resolved offenses on file in this org",
  },
  {
    id: "wipeHours",
    label: "Server hours this wipe",
    type: "number",
    unit: "hrs",
    description: "Hours played on your servers this wipe",
  },
  {
    id: "hwidRecent",
    label: "HWID seen on banned account",
    type: "bool",
    description:
      "HWID/anti-cheat fingerprint matches a recently banned account",
  },
  {
    id: "thoriumFlags",
    label: "Thorium anti-cheat flags",
    type: "number",
    unit: "flags",
    description: "Anti-cheat heuristic flags in last 24h",
  },
];
const TEAMING_FACTS = [
  {
    id: "tcSharedBanned",
    label: "TC shared w/ banned player",
    type: "bool",
    description: "Shares a tool cupboard with a recently banned account",
  },
  {
    id: "teammateCount",
    label: "Distinct teammates this wipe",
    type: "number",
    unit: "players",
    description: "Unique players grouped with this wipe",
  },
  {
    id: "f7TeamingLast24h",
    label: "F7 teaming reports (24h)",
    type: "number",
    unit: "reports",
    description: "F7 reports specifically tagged as teaming in last day",
  },
  {
    id: "soloServerGroup",
    label: "Grouped on solo-only server",
    type: "bool",
    description: "Detected in a group on a solo/duo/trio-restricted server",
  },
  {
    id: "voiceWithBanned",
    label: "Voice proximity to banned",
    type: "number",
    unit: "events",
    description: "Times overheard in voice chat with a banned account",
  },
];
function factsFor(cat) {
  return cat === "cheating" ? FACTS : [...FACTS, ...TEAMING_FACTS];
}
const OPERATORS = [
  { id: "eq", label: "=", for: ["bool", "number"] },
  { id: "gt", label: ">", for: ["number"] },
  { id: "gte", label: "\u2265", for: ["number"] },
  { id: "lt", label: "<", for: ["number"] },
  { id: "lte", label: "\u2264", for: ["number"] },
];
const uid = () => Math.random().toString(36).slice(2, 9);
const DEFAULTS = {
  cheating: {
    signals: [
      { id: uid(), factId: "proxy", op: "eq", value: true, weight: 0.5 },
      { id: uid(), factId: "bmBanHours", op: "gt", value: 20, weight: 0.5 },
      { id: uid(), factId: "f7Last1h", op: "gte", value: 1, weight: 0.1 },
      { id: uid(), factId: "vacBans", op: "gt", value: 0, weight: 0.3 },
      { id: uid(), factId: "accountAge", op: "lt", value: 1, weight: 0.4 },
      { id: uid(), factId: "playtimeHours", op: "lt", value: 100, weight: 0.3 },
      { id: uid(), factId: "hwidRecent", op: "eq", value: true, weight: 0.8 },
      { id: uid(), factId: "thoriumFlags", op: "gte", value: 3, weight: 0.6 },
    ],
    blocks: [
      {
        id: uid(),
        name: "Smurf + behavior",
        conditions: [
          { id: uid(), factId: "accountAge", op: "lt", value: 1 },
          { id: uid(), factId: "f7Last1h", op: "gte", value: 3 },
          { id: uid(), factId: "proxy", op: "eq", value: true },
        ],
      },
      {
        id: uid(),
        name: "Known offender returning",
        conditions: [
          { id: uid(), factId: "hwidRecent", op: "eq", value: true },
          { id: uid(), factId: "wipeHours", op: "lt", value: 10 },
        ],
      },
    ],
  },
  teaming: {
    signals: [
      {
        id: uid(),
        factId: "tcSharedBanned",
        op: "eq",
        value: true,
        weight: 0.6,
      },
      {
        id: uid(),
        factId: "f7TeamingLast24h",
        op: "gte",
        value: 2,
        weight: 0.4,
      },
      { id: uid(), factId: "teammateCount", op: "gt", value: 1, weight: 0.5 },
      {
        id: uid(),
        factId: "soloServerGroup",
        op: "eq",
        value: true,
        weight: 0.7,
      },
      {
        id: uid(),
        factId: "voiceWithBanned",
        op: "gte",
        value: 3,
        weight: 0.3,
      },
    ],
    blocks: [
      {
        id: uid(),
        name: "Solo server group-up",
        conditions: [
          { id: uid(), factId: "soloServerGroup", op: "eq", value: true },
          { id: uid(), factId: "teammateCount", op: "gt", value: 1 },
        ],
      },
    ],
  },
};
DEFAULTS.cheating.blocks[0].conditions = [
  { id: uid(), factId: "accountAge", op: "lt", value: 1 },
  { id: uid(), factId: "f7Last1h", op: "gte", value: 3 },
  { id: uid(), factId: "proxy", op: "eq", value: true },
];
function ThreatTriggersPage() {
  const { orgs, hasOrgPermission } = useAuth();
  const orgId = useManageOrgId();
  const org = useMemo(
    () => (orgId ? (orgs.find((o) => o.id === orgId) ?? null) : null),
    [orgId, orgs],
  );
  const canManageTriggers = orgId
    ? hasOrgPermission(orgId, "triggers_manage")
    : false;
  const [tab, setTab] = useState("cheating");
  const [dataByOrg, setDataByOrg] = useState({});
  const [dirty, setDirty] = useState(false);

  if (!orgId || !org || !canManageTriggers) {
    return (
      <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 grid place-items-center px-6">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="size-10 text-warning mx-auto" />
            <h1 className="text-lg font-semibold">Permission required</h1>
            <p className="text-sm text-muted-foreground">
              Threat Triggers can only be configured with the{" "}
              <span className="font-mono text-foreground">
                Manage Threat Triggers
              </span>{" "}
              permission. Switch to an org you have it in using the selector next
              to <span className="font-mono text-foreground">MANAGE ORG</span> in
              the sidebar.
            </p>
          </div>
        </div>
      </div>
    );
  }
  const data = dataByOrg[orgId] ?? DEFAULTS;
  const cur = data[tab];
  const facts = factsFor(tab);
  const update = (next) => {
    setDataByOrg((all) => ({ ...all, [orgId]: next }));
    setDirty(true);
  };
  const updateSignal = (id, patch) => {
    update({
      ...data,
      [tab]: {
        ...cur,
        signals: cur.signals.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      },
    });
  };
  const removeSignal = (id) => {
    update({
      ...data,
      [tab]: { ...cur, signals: cur.signals.filter((s) => s.id !== id) },
    });
  };
  const addSignal = () => {
    const unused =
      facts.find((f) => !cur.signals.some((s) => s.factId === f.id)) ??
      facts[0];
    update({
      ...data,
      [tab]: {
        ...cur,
        signals: [
          ...cur.signals,
          {
            id: uid(),
            factId: unused.id,
            op: unused.type === "bool" ? "eq" : "gt",
            value: unused.type === "bool" ? true : 0,
            weight: 0.2,
          },
        ],
      },
    });
  };
  const updateBlock = (id, patch) =>
    update({
      ...data,
      [tab]: {
        ...cur,
        blocks: cur.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      },
    });
  const removeBlock = (id) =>
    update({
      ...data,
      [tab]: { ...cur, blocks: cur.blocks.filter((b) => b.id !== id) },
    });
  const addBlock = () =>
    update({
      ...data,
      [tab]: {
        ...cur,
        blocks: [
          ...cur.blocks,
          { id: uid(), name: "New trigger block", conditions: [] },
        ],
      },
    });
  const addCondition = (blockId) => {
    const f = facts[0];
    updateBlock(blockId, {
      conditions: [
        ...(cur.blocks.find((b) => b.id === blockId)?.conditions ?? []),
        {
          id: uid(),
          factId: f.id,
          op: f.type === "bool" ? "eq" : "gt",
          value: f.type === "bool" ? true : 0,
        },
      ],
    });
  };
  const updateCondition = (blockId, condId, patch) => {
    const b = cur.blocks.find((x) => x.id === blockId);
    if (!b) return;
    updateBlock(blockId, {
      conditions: b.conditions.map((c) =>
        c.id === condId ? { ...c, ...patch } : c,
      ),
    });
  };
  const removeCondition = (blockId, condId) => {
    const b = cur.blocks.find((x) => x.id === blockId);
    if (!b) return;
    updateBlock(blockId, {
      conditions: b.conditions.filter((c) => c.id !== condId),
    });
  };
  const totalWeight = cur.signals.reduce((acc, s) => acc + s.weight, 0);
  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold tracking-tight">
                  Threat Triggers
                </h1>
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  {org.name} · {org.short}
                </span>
              </div>

              <p className="text-xs text-muted-foreground max-w-2xl">
                Configure weighted signals about a player. When the sum of
                matched weights reaches{" "}
                <span className="font-mono text-foreground">1.0</span>, or a
                trigger block fully matches, the system auto-opens a ticket on
                the player. If a matching ticket already exists, it is
                re-activated with an internal note explaining why.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                disabled={!dirty}
                onClick={() => {
                  setDataByOrg((all) => {
                    const { [orgId]: _, ...rest } = all;
                    void _;
                    return rest;
                  });
                  setDirty(false);
                }}
              >
                <RotateCcw className="size-3.5" /> Reset
              </Button>
              <Button
                size="sm"
                disabled={!dirty}
                onClick={() => setDirty(false)}
              >
                <Save className="size-3.5" /> Save changes
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 bg-surface/60 ring-1 ring-border rounded-md p-0.5 w-fit">
            {["cheating", "teaming"].map((c) => (
              <button
                key={c}
                onClick={() => setTab(c)}
                className={
                  "px-4 py-1.5 text-xs font-mono uppercase tracking-widest rounded transition-colors " +
                  (tab === c
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {c}
              </button>
            ))}
          </div>

          {/* Signal weights */}
          <section className="rounded-md ring-1 ring-border bg-surface/40">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div>
                <h2 className="text-sm font-semibold">Signal weights</h2>
                <p className="text-[11px] text-muted-foreground">
                  Each matched signal adds its weight to the player's threat
                  score. At
                  <span className="font-mono text-foreground"> ≥ 1.0</span> a
                  ticket is opened.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Sum if all match
                </div>
                <span
                  className={
                    "px-2 py-0.5 rounded text-xs font-mono font-bold ring-1 " +
                    (totalWeight >= 1
                      ? "bg-danger/15 text-danger ring-danger/40"
                      : "bg-surface ring-border text-foreground")
                  }
                >
                  {totalWeight.toFixed(2)}
                </span>
                <Button size="sm" variant="outline" onClick={addSignal}>
                  <Plus className="size-3.5" /> Add signal
                </Button>
              </div>
            </div>
            <div className="divide-y divide-border">
              {cur.signals.map((s) => (
                <SignalRow
                  key={s.id}
                  signal={s}
                  facts={facts}
                  onChange={(patch) => updateSignal(s.id, patch)}
                  onRemove={() => removeSignal(s.id)}
                />
              ))}
              {cur.signals.length === 0 && (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No signals configured. Add one to start scoring players.
                </div>
              )}
            </div>
          </section>

          {/* Trigger blocks */}
          <section className="rounded-md ring-1 ring-border bg-surface/40">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div>
                <h2 className="text-sm font-semibold">Trigger blocks</h2>
                <p className="text-[11px] text-muted-foreground">
                  Sets of conditions joined with{" "}
                  <span className="font-mono">AND</span>. If <em>every</em>{" "}
                  condition matches, a ticket is opened immediately — no weight
                  required.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={addBlock}>
                <Plus className="size-3.5" /> Add block
              </Button>
            </div>
            <div className="p-4 space-y-3">
              {cur.blocks.map((b) => (
                <BlockCard
                  key={b.id}
                  block={b}
                  facts={facts}
                  onRename={(name) => updateBlock(b.id, { name })}
                  onRemove={() => removeBlock(b.id)}
                  onAddCondition={() => addCondition(b.id)}
                  onUpdateCondition={(cid, patch) =>
                    updateCondition(b.id, cid, patch)
                  }
                  onRemoveCondition={(cid) => removeCondition(b.id, cid)}
                />
              ))}
              {cur.blocks.length === 0 && (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No trigger blocks. Add one to define a specific
                  multi-condition rule.
                </div>
              )}
            </div>
          </section>

          <div className="flex items-start gap-2 text-[11px] text-muted-foreground bg-surface/40 ring-1 ring-border rounded-md px-3 py-2">
            <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
            <span>
              Auto-opened tickets are filed under{" "}
              <span className="font-mono text-foreground">{tab}</span> and
              routed to the team that handles that category. Re-activated
              tickets get an internal note like{" "}
              <span className="font-mono text-foreground">
                "reopened by threat trigger: matched 'Smurf + behavior' block"
              </span>
              .
            </span>
          </div>

        </div>
      </div>
    </div>
  );
}
function FactValueEditor({ fact, op, value, onChange }) {
  const allowedOps = OPERATORS.filter((o) => o.for.includes(fact.type));
  return (
    <div className="flex items-center gap-1.5">
      <Select value={op} onValueChange={(v) => onChange({ op: v })}>
        <SelectTrigger className="h-8 w-14 px-2 text-xs font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowedOps.map((o) => (
            <SelectItem key={o.id} value={o.id} className="font-mono">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {fact.type === "bool" ? (
        <Select
          value={String(value)}
          onValueChange={(v) => onChange({ value: v === "true" })}
        >
          <SelectTrigger className="h-8 w-20 px-2 text-xs font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true" className="font-mono">
              true
            </SelectItem>
            <SelectItem value="false" className="font-mono">
              false
            </SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            value={String(value)}
            onChange={(e) => onChange({ value: Number(e.target.value) })}
            className="h-8 w-20 text-xs font-mono"
          />
          {fact.unit && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {fact.unit}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
function FactPicker({ factId, facts, onChange }) {
  return (
    <Select value={factId} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {facts.map((f) => (
          <SelectItem key={f.id} value={f.id} className="text-xs">
            {f.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function SignalRow({ signal, facts, onChange, onRemove }) {
  const fact = facts.find((f) => f.id === signal.factId) ?? facts[0];
  return (
    <div className="px-4 py-3 grid grid-cols-12 gap-3 items-center hover:bg-surface/40">
      <div className="col-span-4 min-w-0">
        <FactPicker
          factId={signal.factId}
          facts={facts}
          onChange={(id) => {
            const f = facts.find((x) => x.id === id);
            onChange({
              factId: id,
              op:
                f.type === "bool"
                  ? "eq"
                  : signal.op === "eq"
                    ? "gt"
                    : signal.op,
              value:
                f.type === "bool"
                  ? true
                  : typeof signal.value === "boolean"
                    ? 0
                    : signal.value,
            });
          }}
        />
        <p className="text-[10px] text-muted-foreground mt-1 truncate">
          {fact.description}
        </p>
      </div>
      <div className="col-span-3">
        <FactValueEditor
          fact={fact}
          op={signal.op}
          value={signal.value}
          onChange={(patch) => onChange(patch)}
        />
      </div>
      <div className="col-span-4 flex items-center gap-3">
        <Slider
          value={[signal.weight]}
          min={0}
          max={1}
          step={0.05}
          onValueChange={([v]) => onChange({ weight: v })}
          className="flex-1"
        />
        <span className="text-xs font-mono font-bold w-10 text-right tabular-nums">
          {signal.weight.toFixed(2)}
        </span>
      </div>
      <div className="col-span-1 flex justify-end">
        <Button
          size="icon"
          variant="ghost"
          onClick={onRemove}
          className="size-7"
        >
          <Trash2 className="size-3.5 text-muted-foreground" />
        </Button>
      </div>
    </div>
  );
}
function BlockCard({
  block,
  facts,
  onRename,
  onRemove,
  onAddCondition,
  onUpdateCondition,
  onRemoveCondition,
}) {
  return (
    <div className="rounded-md ring-1 ring-border bg-background">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <GripVertical className="size-4 text-muted-foreground shrink-0" />
        <Input
          value={block.name}
          onChange={(e) => onRename(e.target.value)}
          className="h-8 text-sm font-semibold border-0 bg-transparent px-1 focus-visible:ring-1"
        />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 py-0.5 rounded bg-surface ring-1 ring-border">
          → open ticket
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={onRemove}
          className="size-7"
        >
          <Trash2 className="size-3.5 text-muted-foreground" />
        </Button>
      </div>
      <div className="p-3 space-y-2">
        {block.conditions.map((c, i) => {
          const fact = facts.find((f) => f.id === c.factId) ?? facts[0];
          return (
            <div key={c.id} className="flex items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground w-8 shrink-0">
                {i === 0 ? "if" : "and"}
              </span>
              <div className="flex-1 min-w-0">
                <FactPicker
                  factId={c.factId}
                  facts={facts}
                  onChange={(id) => {
                    const f = facts.find((x) => x.id === id);
                    onUpdateCondition(c.id, {
                      factId: id,
                      op:
                        f.type === "bool" ? "eq" : c.op === "eq" ? "gt" : c.op,
                      value:
                        f.type === "bool"
                          ? true
                          : typeof c.value === "boolean"
                            ? 0
                            : c.value,
                    });
                  }}
                />
              </div>
              <FactValueEditor
                fact={fact}
                op={c.op}
                value={c.value}
                onChange={(patch) => onUpdateCondition(c.id, patch)}
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onRemoveCondition(c.id)}
                className="size-7"
              >
                <Trash2 className="size-3.5 text-muted-foreground" />
              </Button>
            </div>
          );
        })}
        {block.conditions.length === 0 && (
          <p className="text-[11px] text-muted-foreground px-2 py-2">
            No conditions yet — add at least one.
          </p>
        )}
        <div className="pt-1">
          <Label className="sr-only">Add condition</Label>
          <Button size="sm" variant="ghost" onClick={onAddCondition}>
            <Plus className="size-3.5" /> Add condition
          </Button>
        </div>
      </div>
    </div>
  );
}
export { Route };

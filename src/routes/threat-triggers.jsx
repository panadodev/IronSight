import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  ShoppingCart,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const Route = createFileRoute("/threat-triggers")({
  head: () => ({ meta: [{ title: "Threat Triggers — IronSight" }] }),
  component: ThreatTriggersPage,
});

const OPERATORS = [
  { id: "eq", label: "=", for: ["bool", "number"] },
  { id: "gt", label: ">", for: ["number"] },
  { id: "gte", label: "≥", for: ["number"] },
  { id: "lt", label: "<", for: ["number"] },
  { id: "lte", label: "≤", for: ["number"] },
];
const uid = () => Math.random().toString(36).slice(2, 9);

// Attach ephemeral ids for stable React keys; stripped again before saving.
function hydrate(config) {
  return {
    threshold: config?.threshold ?? 1.0,
    signals: (config?.signals ?? []).map((s) => ({ ...s, id: uid() })),
    blocks: (config?.blocks ?? []).map((b) => ({
      id: uid(),
      name: b.name ?? "Trigger block",
      conditions: (b.conditions ?? []).map((c) => ({ ...c, id: uid() })),
    })),
    boughtAccount: {
      enabled: Boolean(config?.boughtAccount?.enabled),
      hoursRule: {
        enabled: config?.boughtAccount?.hoursRule?.enabled !== false,
        ratio: config?.boughtAccount?.hoursRule?.ratio ?? 10,
      },
      nameRule: {
        enabled: Boolean(config?.boughtAccount?.nameRule?.enabled),
        terms: Array.isArray(config?.boughtAccount?.nameRule?.terms)
          ? config.boughtAccount.nameRule.terms
          : [],
      },
      groupRule: {
        enabled: Boolean(config?.boughtAccount?.groupRule?.enabled),
        groups: Array.isArray(config?.boughtAccount?.groupRule?.groups)
          ? config.boughtAccount.groupRule.groups.map((g) => ({
              gid: String(g?.gid ?? ""),
              label: String(g?.label ?? g?.gid ?? ""),
              vanity: g?.vanity ? String(g.vanity) : null,
            }))
          : [],
      },
      steamLevelRule: {
        enabled: Boolean(config?.boughtAccount?.steamLevelRule?.enabled),
        maxLevel: config?.boughtAccount?.steamLevelRule?.maxLevel ?? 5,
      },
    },
  };
}

function dehydrate(data) {
  return {
    threshold: data.threshold,
    signals: data.signals.map(({ factId, op, value, weight }) => ({
      factId,
      op,
      value,
      weight,
    })),
    blocks: data.blocks.map((b) => ({
      name: b.name,
      conditions: b.conditions.map(({ factId, op, value }) => ({
        factId,
        op,
        value,
      })),
    })),
    boughtAccount: data.boughtAccount,
  };
}

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

  const [facts, setFacts] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  useEffect(() => {
    if (!orgId || !canManageTriggers) return;
    setLoading(true);
    setDirty(false);
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/threat-triggers`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((body) => {
        setFacts(body.facts ?? []);
        setData(hydrate(body.config));
      })
      .catch(() => setData(hydrate(null)))
      .finally(() => setLoading(false));
  }, [orgId, canManageTriggers]);

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
              permission. Switch to an org you have it in using the selector
              next to{" "}
              <span className="font-mono text-foreground">MANAGE ORG</span> in
              the sidebar.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const update = (next) => {
    setData(next);
    setDirty(true);
  };

  const cur = data;
  const totalWeight = (cur?.signals ?? []).reduce(
    (acc, s) => acc + (Number(s.weight) || 0),
    0,
  );

  // ── signal mutators ──
  const updateSignal = (id, patch) =>
    update({
      ...cur,
      signals: cur.signals.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  const removeSignal = (id) =>
    update({ ...cur, signals: cur.signals.filter((s) => s.id !== id) });
  const addSignal = () => {
    const unused =
      facts.find((f) => !cur.signals.some((s) => s.factId === f.id)) ??
      facts[0];
    if (!unused) return;
    update({
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
    });
  };

  // ── block mutators ──
  const updateBlock = (id, patch) =>
    update({
      ...cur,
      blocks: cur.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    });
  const removeBlock = (id) =>
    update({ ...cur, blocks: cur.blocks.filter((b) => b.id !== id) });
  const addBlock = () =>
    update({
      ...cur,
      blocks: [
        ...cur.blocks,
        { id: uid(), name: "New trigger block", conditions: [] },
      ],
    });
  const addCondition = (blockId) => {
    const f = facts[0];
    if (!f) return;
    const b = cur.blocks.find((x) => x.id === blockId);
    updateBlock(blockId, {
      conditions: [
        ...(b?.conditions ?? []),
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

  const setBought = (patch) =>
    update({ ...cur, boughtAccount: { ...cur.boughtAccount, ...patch } });

  async function handleSave() {
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/threat-triggers`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: dehydrate(cur) }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveErr(body?.error ?? "Failed to save.");
        return;
      }
      setData(hydrate(body.config));
      setDirty(false);
    } catch {
      setSaveErr("Network error.");
    } finally {
      setSaving(false);
    }
  }

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
                <span className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
                  {org.name} · {org.short}
                </span>
              </div>
              <p className="text-xs text-muted-foreground max-w-2xl">
                Configure weighted signals about a player. When the sum of
                matched weights reaches the threshold, a trigger block fully
                matches, or a bought-account rule fires, the system auto-opens a
                ticket on the player. Evaluated whenever a player's intel is
                refreshed and whenever an in-game F7 report arrives. An existing
                auto-ticket is reactivated with an internal note instead of
                duplicated.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                disabled={!dirty || saving}
                onClick={() =>
                  fetch(
                    `/api/orgs/${encodeURIComponent(orgId)}/threat-triggers`,
                    {
                      credentials: "include",
                    },
                  )
                    .then((r) => (r.ok ? r.json() : Promise.reject()))
                    .then((body) => {
                      setData(hydrate(body.config));
                      setDirty(false);
                    })
                    .catch(() => {})
                }
              >
                <RotateCcw className="size-3.5" /> Revert
              </Button>
              <Button
                size="sm"
                disabled={!dirty || saving}
                onClick={handleSave}
              >
                <Save className="size-3.5" />{" "}
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>

          {saveErr && <p className="text-[0.6875rem] text-danger">{saveErr}</p>}

          {loading || !cur ? (
            <p className="text-sm text-muted-foreground">Loading triggers…</p>
          ) : (
            <>
              {/* Signal weights */}
              <section className="rounded-md ring-1 ring-border bg-surface/40">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <div>
                    <h2 className="text-sm font-semibold">Signal weights</h2>
                    <p className="text-[0.6875rem] text-muted-foreground">
                      Each matched signal adds its weight to the player's threat
                      score. A ticket opens when the score reaches the
                      threshold.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
                        Threshold
                      </span>
                      <Input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={String(cur.threshold)}
                        onChange={(e) =>
                          update({
                            ...cur,
                            threshold: Number(e.target.value) || 1,
                          })
                        }
                        className="h-8 w-16 text-xs font-mono"
                      />
                    </div>
                    <div className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
                      Sum if all
                    </div>
                    <span
                      className={
                        "px-2 py-0.5 rounded text-xs font-mono font-bold ring-1 " +
                        (totalWeight >= cur.threshold
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
                    <p className="text-[0.6875rem] text-muted-foreground">
                      Sets of conditions joined with{" "}
                      <span className="font-mono">AND</span>. If <em>every</em>{" "}
                      condition matches, a ticket opens immediately — no weight
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

              {/* Bought account */}
              <BoughtAccountCard
                orgId={orgId}
                bought={cur.boughtAccount}
                onChange={setBought}
                onSave={handleSave}
                saving={saving}
                dirty={dirty}
              />

              <div className="flex items-start gap-2 text-[0.6875rem] text-muted-foreground bg-surface/40 ring-1 ring-border rounded-md px-3 py-2">
                <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
                <span>
                  Auto-opened tickets are filed under the{" "}
                  <span className="font-mono text-foreground">threat_auto</span>{" "}
                  category at <span className="font-mono">high</span> priority.
                  Each evaluation appends an internal note explaining which rule
                  matched.
                </span>
              </div>
            </>
          )}
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
            <span className="text-[0.625rem] font-mono text-muted-foreground">
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
  if (!fact) return null;
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
          {Number(signal.weight).toFixed(2)}
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
        <Input
          value={block.name}
          onChange={(e) => onRename(e.target.value)}
          className="h-8 text-sm font-semibold border-0 bg-transparent px-1 focus-visible:ring-1"
        />
        <span className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground px-2 py-0.5 rounded bg-surface ring-1 ring-border shrink-0">
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
          if (!fact) return null;
          return (
            <div key={c.id} className="flex items-center gap-2">
              <span className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground w-8 shrink-0">
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
          <p className="text-[0.6875rem] text-muted-foreground px-2 py-2">
            No conditions yet — add at least one.
          </p>
        )}
        <div className="pt-1">
          <Button size="sm" variant="ghost" onClick={onAddCondition}>
            <Plus className="size-3.5" /> Add condition
          </Button>
        </div>
      </div>
    </div>
  );
}

function BoughtAccountCard({ orgId, bought, onChange, onSave, saving, dirty }) {
  const [term, setTerm] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const [resolvingGroup, setResolvingGroup] = useState(false);
  const [groupError, setGroupError] = useState(null);
  const { hoursRule, nameRule } = bought;
  const groupRule = bought.groupRule ?? { enabled: false, groups: [] };
  const steamLevelRule = bought.steamLevelRule ?? { enabled: false, maxLevel: 5 };

  const setHours = (patch) =>
    onChange({ hoursRule: { ...hoursRule, ...patch } });
  const setName = (patch) => onChange({ nameRule: { ...nameRule, ...patch } });
  const setGroup = (patch) =>
    onChange({ groupRule: { ...groupRule, ...patch } });
  const setSteamLevel = (patch) =>
    onChange({ steamLevelRule: { ...steamLevelRule, ...patch } });

  const addTerm = () => {
    const t = term.trim();
    if (!t || nameRule.terms.includes(t)) {
      setTerm("");
      return;
    }
    setName({ terms: [...nameRule.terms, t] });
    setTerm("");
  };

  const addGroup = async () => {
    const raw = groupInput.trim();
    if (!raw || !orgId || resolvingGroup) return;
    setResolvingGroup(true);
    setGroupError(null);
    try {
      const res = await fetch(
        `/api/orgs/${orgId}/threat-triggers/resolve-group`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: raw }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGroupError(data?.error ?? "Could not resolve Steam group");
        return;
      }
      if (groupRule.groups.some((g) => g.gid === data.gid)) {
        setGroupError("Group already added");
        return;
      }
      setGroup({
        groups: [
          ...groupRule.groups,
          { gid: data.gid, label: data.label, vanity: data.vanity ?? null },
        ],
      });
      setGroupInput("");
    } catch {
      setGroupError("Could not resolve Steam group");
    } finally {
      setResolvingGroup(false);
    }
  };

  return (
    <section className="rounded-md ring-1 ring-border bg-surface/40">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <ShoppingCart className="size-4 text-amber-400" />
          <div>
            <h2 className="text-sm font-semibold">Bought account triggers</h2>
            <p className="text-[0.6875rem] text-muted-foreground">
              Tag resold / botted accounts on player lookup by playtime
              mismatch, known names, or Steam group membership. Display-only —
              these never open a ticket.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Toggle
            checked={bought.enabled}
            onClick={() => onChange({ enabled: !bought.enabled })}
            label={bought.enabled ? "Enabled" : "Disabled"}
          />
          <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
            <Save className="size-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div
        className={
          "p-4 space-y-4 " +
          (bought.enabled ? "" : "opacity-50 pointer-events-none")
        }
      >
        {/* Hours ratio rule */}
        <div className="rounded-md ring-1 ring-border bg-background p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold">Playtime mismatch</p>
              <p className="text-[0.625rem] text-muted-foreground">
                Flag when Steam Rust hours are far higher than BattleMetrics
                hours (e.g. 4000h on Steam, 40h tracked on BM).
              </p>
            </div>
            <Toggle
              checked={hoursRule.enabled}
              onClick={() => setHours({ enabled: !hoursRule.enabled })}
              label={hoursRule.enabled ? "On" : "Off"}
            />
          </div>
          <div className="flex items-center gap-3">
            <NumField
              label="Ratio ≥"
              value={hoursRule.ratio}
              onChange={(v) => setHours({ ratio: v })}
              suffix="×"
            />
          </div>
          <p className="text-[0.625rem] font-mono text-muted-foreground">
            Triggers when (Steam ÷ BM) ≥ {hoursRule.ratio}×.
          </p>
        </div>

        {/* Name match rule */}
        <div className="rounded-md ring-1 ring-border bg-background p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold">Known name match</p>
              <p className="text-[0.625rem] text-muted-foreground">
                Flag if a current or past name contains any of these terms
                (case-insensitive substring).
              </p>
            </div>
            <Toggle
              checked={nameRule.enabled}
              onClick={() => setName({ enabled: !nameRule.enabled })}
              label={nameRule.enabled ? "On" : "Off"}
            />
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTerm()}
              placeholder="Name or term"
              className="h-8 text-xs flex-1"
            />
            <Button size="sm" variant="outline" onClick={addTerm}>
              <Plus className="size-3.5" /> Add
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {nameRule.terms.length === 0 ? (
              <span className="text-[0.6875rem] text-muted-foreground italic">
                No terms yet.
              </span>
            ) : (
              nameRule.terms.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 text-[0.6875rem] font-mono bg-surface ring-1 ring-border rounded px-2 py-0.5"
                >
                  {t}
                  <button
                    onClick={() =>
                      setName({ terms: nameRule.terms.filter((x) => x !== t) })
                    }
                    className="text-muted-foreground hover:text-danger"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        {/* Steam level rule */}
        <div className="rounded-md ring-1 ring-border bg-background p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold">Steam level</p>
              <p className="text-[0.625rem] text-muted-foreground">
                Flag if the player's Steam level is at or below a threshold
                (e.g. level 0–5 suggests a newly created or purchased account).
              </p>
            </div>
            <Toggle
              checked={steamLevelRule.enabled}
              onClick={() => setSteamLevel({ enabled: !steamLevelRule.enabled })}
              label={steamLevelRule.enabled ? "On" : "Off"}
            />
          </div>
          <div className="flex items-center gap-3">
            <NumField
              label="Max level ≤"
              value={steamLevelRule.maxLevel}
              onChange={(v) => setSteamLevel({ maxLevel: v })}
            />
          </div>
          <p className="text-[0.625rem] font-mono text-muted-foreground">
            Triggers when Steam level ≤ {steamLevelRule.maxLevel}.
          </p>
        </div>

        {/* Steam group rule */}
        <div className="rounded-md ring-1 ring-border bg-background p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold">Steam group membership</p>
              <p className="text-[0.625rem] text-muted-foreground">
                Flag if the player is a member of any of these Steam groups
                (e.g. known account-farming / botting groups).
              </p>
            </div>
            <Toggle
              checked={groupRule.enabled}
              onClick={() => setGroup({ enabled: !groupRule.enabled })}
              label={groupRule.enabled ? "On" : "Off"}
            />
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={groupInput}
              onChange={(e) => {
                setGroupInput(e.target.value);
                setGroupError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && addGroup()}
              placeholder="Group vanity, URL, or GID"
              className="h-8 text-xs flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={addGroup}
              disabled={resolvingGroup || !groupInput.trim()}
            >
              <Plus className="size-3.5" />{" "}
              {resolvingGroup ? "Resolving…" : "Add"}
            </Button>
          </div>
          {groupError && (
            <p className="text-[0.625rem] text-danger">{groupError}</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {groupRule.groups.length === 0 ? (
              <span className="text-[0.6875rem] text-muted-foreground italic">
                No groups yet.
              </span>
            ) : (
              groupRule.groups.map((g) => (
                <span
                  key={g.gid}
                  className="inline-flex items-center gap-1 text-[0.6875rem] bg-surface ring-1 ring-border rounded px-2 py-0.5"
                  title={g.gid}
                >
                  {g.label}
                  <button
                    onClick={() =>
                      setGroup({
                        groups: groupRule.groups.filter((x) => x.gid !== g.gid),
                      })
                    }
                    className="text-muted-foreground hover:text-danger"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Toggle({ checked, onClick, label }) {
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center gap-2 h-7 px-2.5 rounded-md ring-1 text-[0.625rem] font-mono uppercase tracking-widest transition " +
        (checked
          ? "bg-brand/15 text-brand ring-brand/40"
          : "bg-transparent text-muted-foreground ring-border hover:text-foreground")
      }
    >
      <span
        className={
          "size-3 rounded-full transition " +
          (checked ? "bg-brand" : "bg-muted-foreground/40")
        }
      />
      {label}
    </button>
  );
}

function NumField({ label, value, onChange, suffix }) {
  return (
    <div className="space-y-1">
      <label className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          value={String(value)}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          className="h-8 text-xs font-mono"
        />
        {suffix && (
          <span className="text-[0.625rem] font-mono text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

export { Route };

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { SectionHeader, GateRank } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Upload,
  X,
  Bot,
  Key,
  Trash2,
  Pencil,
  Activity,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const Route = createFileRoute("/manage/toxicity")({
  component: ToxicityPage,
});

const CATEGORY_META = {
  harassment: {
    label: "Harassment",
    note: "IRL insults targeting a person personally.",
    defaultThreshold: 80,
    defaultAction: "automute",
  },
  "harassment/threatening": {
    label: "Threatening Harassment",
    note: "Direct threats of real-world harm against a player.",
    defaultThreshold: 75,
    defaultAction: "automute",
  },
  hate: {
    label: "Hate Speech",
    note: "Slurs or bigotry targeting protected groups.",
    defaultThreshold: 80,
    defaultAction: "automute",
  },
  "hate/threatening": {
    label: "Threatening Hate Speech",
    note: "Threatening content based on identity.",
    defaultThreshold: 75,
    defaultAction: "automute",
  },
  "self-harm": {
    label: "Self-Harm Content",
    note: "Content that may encourage self-harm.",
    defaultThreshold: 50,
    defaultAction: "highlight",
  },
  "self-harm/intent": {
    label: "Self-Harm Intent",
    note: "Expressed intent to self-harm — welfare concern.",
    defaultThreshold: 60,
    defaultAction: "highlight",
  },
  "self-harm/instructions": {
    label: "Self-Harm Instructions",
    note: "Instructions for self-harm.",
    defaultThreshold: 60,
    defaultAction: "highlight",
  },
  sexual: {
    label: "Sexual Content",
    note: "Explicit sexual content.",
    defaultThreshold: 80,
    defaultAction: "highlight",
  },
  "sexual/minors": {
    label: "Sexual Content (Minors)",
    note: "CSAM-adjacent content — zero tolerance.",
    defaultThreshold: 50,
    defaultAction: "automute",
  },
  violence: {
    label: "Violence",
    note: "Rust chat naturally scores high here (killing/raiding is the game). Use >95% threshold or leave disabled.",
    defaultThreshold: 95,
    defaultAction: "highlight",
  },
  "violence/graphic": {
    label: "Graphic Violence",
    note: "Graphic real-world gore descriptions.",
    defaultThreshold: 90,
    defaultAction: "highlight",
  },
};

const ALL_CATEGORIES = Object.keys(CATEGORY_META);

function ToxicityPage() {
  const { sessionUser, hasOrgPermission } = useAuth();
  const orgId = useManageOrgId();
  const isAdmin =
    Boolean(sessionUser?.isSysAdmin) ||
    hasOrgPermission(orgId, "toxicity_manage");

  if (!orgId) return null;

  return (
    <GateRank rank={isAdmin ? 4 : 0} required={4}>
      <SectionHeader
        title="Toxicity"
        blurb="AI-powered triggers score each chat message via OpenAI and automatically highlight or mute players based on configurable thresholds."
      />
      <AIModerationSection orgId={orgId} />
      <BlockedWordsSection orgId={orgId} />
    </GateRank>
  );
}

// ── AI Moderation triggers ────────────────────────────────────────────────────

function AIModerationSection({ orgId }) {
  const [triggers, setTriggers] = useState([]);
  const [hasKey, setHasKey] = useState(false);
  const [rateInfo, setRateInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const fetchTriggers = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ai-moderation/triggers`,
        { credentials: "include" },
      );
      if (res.ok) {
        const data = await res.json();
        setTriggers(data.triggers ?? []);
        setHasKey(Boolean(data.hasOpenAIKey));
        setRateInfo(data.rateInfo ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchTriggers();
  }, [fetchTriggers]);

  const deleteTrigger = async (triggerId) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ai-moderation/triggers/${triggerId}`,
      { method: "DELETE", credentials: "include" },
    );
    if (res.ok)
      setTriggers((prev) => prev.filter((t) => t.triggerId !== triggerId));
  };

  const toggleEnabled = async (trigger) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ai-moderation/triggers/${trigger.triggerId}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !trigger.enabled }),
      },
    );
    if (res.ok) {
      const updated = await res.json();
      setTriggers((prev) =>
        prev.map((t) => (t.triggerId === updated.triggerId ? updated : t)),
      );
    }
  };

  const onSaved = (saved, isNew) => {
    setTriggers((prev) =>
      isNew
        ? [...prev, saved]
        : prev.map((t) => (t.triggerId === saved.triggerId ? saved : t)),
    );
    setAdding(false);
    setEditingId(null);
  };

  return (
    <section className="rounded-md ring-1 ring-border bg-surface/40">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground shrink-0" />
          <div>
            <h2 className="text-sm font-semibold">AI Moderation Triggers</h2>
            <p className="text-[0.6875rem] text-muted-foreground">
              OpenAI scores each ingested chat message. Triggers fire when a
              score exceeds the threshold.
            </p>
          </div>
        </div>
        {!adding && editingId === null && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add Trigger
          </Button>
        )}
      </div>

      <div
        className={`flex items-center gap-2 px-4 py-2 border-b border-border text-xs ${
          hasKey ? "text-success bg-success/5" : "text-warning bg-warning/5"
        }`}
      >
        <Key className="size-3.5 shrink-0" />
        {hasKey ? (
          <span>
            OpenAI API key configured.{" "}
            <a
              href="/manage/details"
              className="underline underline-offset-2 hover:opacity-80"
            >
              Manage keys →
            </a>
          </span>
        ) : (
          <span>
            No OpenAI API key configured — moderation disabled.{" "}
            <a
              href="/manage/details"
              className="underline underline-offset-2 hover:opacity-80"
            >
              Add key in Org Details (service: openai) →
            </a>
          </span>
        )}
      </div>

      {hasKey && rateInfo && <RateLimitBar rateInfo={rateInfo} />}

      {adding && (
        <div className="border-b border-border">
          <TriggerForm
            orgId={orgId}
            onSaved={(t) => onSaved(t, true)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {loading ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">Loading…</div>
      ) : triggers.length === 0 && !adding ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">
          No triggers configured. Click <strong>Add Trigger</strong> to create
          your first rule.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {triggers.map((trigger) =>
            editingId === trigger.triggerId ? (
              <TriggerForm
                key={trigger.triggerId}
                orgId={orgId}
                existing={trigger}
                onSaved={(t) => onSaved(t, false)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <TriggerRow
                key={trigger.triggerId}
                trigger={trigger}
                onEdit={() => setEditingId(trigger.triggerId)}
                onDelete={() => deleteTrigger(trigger.triggerId)}
                onToggle={() => toggleEnabled(trigger)}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function RateLimitBar({ rateInfo }) {
  const now = Math.floor(Date.now() / 1000);
  const { openai, internal } = rateInfo;

  const fmtNum = (n) => (n != null ? n.toLocaleString() : "?");

  const openaiAge = openai?.fetchedAt ? now - openai.fetchedAt : null;

  const internalPct =
    internal && internal.limit > 0
      ? Math.round((internal.used / internal.limit) * 100)
      : 0;
  const internalColor =
    internalPct >= 90
      ? "text-danger"
      : internalPct >= 70
        ? "text-warning"
        : "text-muted-foreground";

  const openaiReqPct =
    openai?.limitRequests && openai.limitRequests > 0
      ? Math.round(
          ((openai.limitRequests -
            (openai.remainingRequests ?? openai.limitRequests)) /
            openai.limitRequests) *
            100,
        )
      : 0;
  const openaiColor =
    openaiReqPct >= 90
      ? "text-danger"
      : openaiReqPct >= 70
        ? "text-warning"
        : "text-muted-foreground";

  return (
    <div className="px-4 py-2 border-b border-border bg-surface/20 flex flex-wrap items-center gap-x-5 gap-y-1">
      <div className="flex items-center gap-1.5">
        <Activity className="size-3 text-muted-foreground shrink-0" />
        <span className="text-[0.625rem] font-mono font-medium text-muted-foreground uppercase tracking-wide">
          Rate limits
        </span>
      </div>

      {internal && (
        <div className="flex items-center gap-1 text-[0.6875rem] font-mono">
          <span className="text-muted-foreground">Org budget:</span>
          <span className={internalColor}>
            {internal.used.toLocaleString()} / {internal.limit.toLocaleString()}
          </span>
          <span className="text-muted-foreground">calls/min</span>
          {internal.ttl > 0 && (
            <span className="text-muted-foreground">
              · resets in {internal.ttl}s
            </span>
          )}
        </div>
      )}

      {openai ? (
        <div className="flex items-center gap-1 text-[0.6875rem] font-mono">
          <span className="text-muted-foreground">OpenAI requests:</span>
          <span className={openaiColor}>
            {fmtNum(openai.remainingRequests)} remaining
          </span>
          {openai.limitRequests != null && (
            <span className="text-muted-foreground">
              / {fmtNum(openai.limitRequests)}
            </span>
          )}
          {openai.remainingTokens != null && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">tokens:</span>
              <span className={openaiColor}>
                {fmtNum(openai.remainingTokens)}
              </span>
              {openai.limitTokens != null && (
                <span className="text-muted-foreground">
                  / {fmtNum(openai.limitTokens)}
                </span>
              )}
            </>
          )}
          {openaiAge != null && (
            <span className="text-muted-foreground">
              ·{" "}
              {openaiAge < 60
                ? `${openaiAge}s ago`
                : `${Math.floor(openaiAge / 60)}m ago`}
            </span>
          )}
        </div>
      ) : (
        <span className="text-[0.6875rem] font-mono text-muted-foreground">
          OpenAI limits: no data yet — updates after first moderation call
        </span>
      )}
    </div>
  );
}

function TriggerRow({ trigger, onEdit, onDelete, onToggle }) {
  const meta = CATEGORY_META[trigger.category];
  const actionColor =
    trigger.action === "automute" ? "text-danger" : "text-warning";

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 ${!trigger.enabled ? "opacity-50" : ""}`}
    >
      <Switch
        checked={trigger.enabled}
        onCheckedChange={onToggle}
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono font-medium">
            {meta?.label ?? trigger.category}
          </span>
          <span className="text-[0.625rem] text-muted-foreground font-mono">
            {trigger.category}
          </span>
          <Badge
            variant="outline"
            className={`text-[0.625rem] font-mono ${actionColor}`}
          >
            {trigger.action === "automute"
              ? trigger.muteDurationMinutes
                ? `automute ${trigger.muteDurationMinutes}m`
                : "automute (permanent)"
              : "highlight"}
          </Badge>
          <span className="text-[0.625rem] text-muted-foreground font-mono">
            ≥ {Math.round(trigger.threshold * 100)}%
          </span>
        </div>
        {meta?.note && (
          <p className="text-[0.625rem] text-muted-foreground mt-0.5 truncate">
            {meta.note}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="icon" variant="ghost" className="size-7" onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-danger hover:text-danger"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function TriggerForm({ orgId, existing, onSaved, onCancel }) {
  const isEdit = Boolean(existing);
  const firstCat = ALL_CATEGORIES[0];
  const defaultMeta = CATEGORY_META[firstCat];

  const [category, setCategory] = useState(existing?.category ?? firstCat);
  const [threshold, setThreshold] = useState(
    existing
      ? Math.round(existing.threshold * 100)
      : (defaultMeta?.defaultThreshold ?? 80),
  );
  const [action, setAction] = useState(
    existing?.action ?? defaultMeta?.defaultAction ?? "highlight",
  );
  const [muteDuration, setMuteDuration] = useState(
    existing?.muteDurationMinutes != null
      ? String(existing.muteDurationMinutes)
      : "",
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleCategoryChange = (val) => {
    setCategory(val);
    if (!isEdit) {
      const m = CATEGORY_META[val];
      if (m) {
        setThreshold(m.defaultThreshold);
        setAction(m.defaultAction);
      }
    }
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    const body = {
      category,
      threshold: threshold / 100,
      action,
      muteDurationMinutes:
        action === "automute" && muteDuration.trim()
          ? Number(muteDuration)
          : null,
    };
    const url = isEdit
      ? `/api/orgs/${encodeURIComponent(orgId)}/ai-moderation/triggers/${existing.triggerId}`
      : `/api/orgs/${encodeURIComponent(orgId)}/ai-moderation/triggers`;
    const res = await fetch(url, {
      method: isEdit ? "PATCH" : "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    setSaving(false);
    if (!res.ok) {
      setErr(data?.error ?? "Failed to save");
      return;
    }
    onSaved(data);
  };

  const meta = CATEGORY_META[category];

  return (
    <div className="px-4 py-3 bg-surface/60 space-y-3">
      <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
        {isEdit ? "Edit Trigger" : "New Trigger"}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {!isEdit && (
          <div className="space-y-1">
            <Label className="text-[0.6875rem] text-muted-foreground">
              Category
            </Label>
            <Select value={category} onValueChange={handleCategoryChange}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat} className="text-xs">
                    <span className="font-medium">
                      {CATEGORY_META[cat].label}
                    </span>
                    <span className="ml-2 text-muted-foreground font-mono text-[0.625rem]">
                      {cat}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-[0.6875rem] text-muted-foreground">
            Threshold —{" "}
            <span className="font-mono text-foreground">{threshold}%</span>
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-[0.625rem] font-mono text-muted-foreground w-6">
              1%
            </span>
            <input
              type="range"
              min={1}
              max={99}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="flex-1 accent-primary h-1.5 cursor-pointer"
            />
            <span className="text-[0.625rem] font-mono text-muted-foreground w-6">
              99%
            </span>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-[0.6875rem] text-muted-foreground">Action</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="highlight" className="text-xs">
                Highlight — flag in chat log
              </SelectItem>
              <SelectItem value="automute" className="text-xs">
                Auto-mute — mute player immediately
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {action === "automute" && (
          <div className="space-y-1">
            <Label className="text-[0.6875rem] text-muted-foreground">
              Mute duration (minutes, blank = permanent)
            </Label>
            <Input
              type="number"
              min={1}
              value={muteDuration}
              onChange={(e) => setMuteDuration(e.target.value)}
              placeholder="Permanent"
              className="h-8 text-xs font-mono"
            />
          </div>
        )}
      </div>

      {meta?.note && (
        <p className="text-[0.6875rem] text-muted-foreground italic">{meta.note}</p>
      )}

      {err && <p className="text-xs text-danger">{err}</p>}

      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Trigger"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Blocked Words ─────────────────────────────────────────────────────────────

function BlockedWordsSection({ orgId }) {
  const [words, setWords] = useState([]);
  const [wordsLoading, setWordsLoading] = useState(false);
  const [wordInput, setWordInput] = useState("");
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const fetchWords = useCallback(async () => {
    if (!orgId) return;
    setWordsLoading(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/blacklisted-words`);
      if (res.ok) {
        const data = await res.json();
        setWords(data.words ?? []);
      }
    } finally {
      setWordsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchWords();
  }, [fetchWords]);

  const addWord = async () => {
    const trimmed = wordInput.trim().toLowerCase();
    if (!trimmed || !orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/blacklisted-words`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: trimmed }),
    });
    if (res.ok) {
      const newWord = await res.json();
      setWords((prev) => [
        ...prev.filter((w) => w.word_id !== newWord.word_id),
        newWord,
      ]);
      setWordInput("");
    }
  };

  const deleteWord = async (wordId) => {
    const res = await fetch(`/api/orgs/${orgId}/blacklisted-words/${wordId}`, {
      method: "DELETE",
    });
    if (res.ok) setWords((prev) => prev.filter((w) => w.word_id !== wordId));
  };

  const importWords = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !orgId) return;
    e.target.value = "";
    const text = await file.text();
    const existing = new Set(words.map((w) => w.word));
    const toAdd = [
      ...new Set(
        text
          .split(/[\n,]+/)
          .map((w) => w.trim().toLowerCase())
          .filter((w) => w && w.length <= 100 && !existing.has(w)),
      ),
    ];
    if (!toAdd.length) return;
    setImporting(true);
    try {
      const results = await Promise.all(
        toAdd.map((word) =>
          fetch(`/api/orgs/${orgId}/blacklisted-words`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ word }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      );
      const added = results.filter(Boolean);
      if (added.length) {
        setWords((prev) => {
          const seen = new Set(prev.map((w) => w.word_id));
          return [...prev, ...added.filter((w) => !seen.has(w.word_id))];
        });
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="rounded-md ring-1 ring-border bg-surface/40">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">Blocked Words</h2>
        <p className="text-[0.6875rem] text-muted-foreground">
          Players cannot send messages containing these words. Requires plugin
          restart or daily server restart to take effect.
        </p>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex gap-2 flex-wrap">
          <Input
            value={wordInput}
            onChange={(e) => setWordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addWord();
              }
            }}
            placeholder="Add a word…"
            className="h-8 text-sm max-w-xs"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={addWord}
            disabled={!wordInput.trim()}
          >
            <Plus className="size-3.5" /> Add
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.csv,.text,text/plain,text/csv"
            className="hidden"
            onChange={importWords}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-3.5" />
            {importing ? "Importing…" : "Import file"}
          </Button>
        </div>
        {wordsLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : words.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No blocked words configured.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {words.map((w) => (
              <span
                key={w.word_id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface ring-1 ring-border text-xs font-mono"
              >
                {w.word}
                <button
                  onClick={() => deleteWord(w.word_id)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export { Route };

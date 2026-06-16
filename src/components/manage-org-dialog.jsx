import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BAN_CATEGORIES, TICKET_TYPE_KEYS, TICKET_TYPE_LABELS } from "@/lib/auth-context";
import { Switch } from "@/components/ui/switch";
import { Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
function ToxicityPanel({ orgId, config, onSave }) {
  const [yellow, setYellow] = useState(config.yellow.join(", "));
  const [red, setRed] = useState(config.red.join(", "));
  const [saved, setSaved] = useState(null);
  useEffect(() => {
    setYellow(config.yellow.join(", "));
    setRed(config.red.join(", "));
    setSaved(null);
  }, [orgId, config.yellow, config.red]);
  const splitCsv = (s) =>
    s
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  const save = async (kind, raw) => {
    const res = await onSave(kind, splitCsv(raw));
    if (res?.ok) {
      setSaved(kind);
      setTimeout(() => setSaved((cur) => (cur === kind ? null : cur)), 1200);
    }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] font-mono uppercase tracking-widest text-warning">
            Yellow phrases
          </Label>
          {saved === "yellow" && (
            <span className="text-[10px] font-mono uppercase tracking-widest text-success">
              Saved
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Highlighted yellow in toxicity chat logs. Separate with commas — exact
          match only.
        </p>
        <Textarea
          value={yellow}
          onChange={(e) => setYellow(e.target.value)}
          onBlur={() => save("yellow", yellow)}
          placeholder="ez noobs, trash kid, kys"
          className="min-h-[80px] font-mono text-xs"
        />
      </div>

      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] font-mono uppercase tracking-widest text-danger">
            Red phrases
          </Label>
          {saved === "red" && (
            <span className="text-[10px] font-mono uppercase tracking-widest text-success">
              Saved
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Highlighted red. If one of these appears in a player's chat log, any
          cleared toxicity report for them is automatically re-opened by the
          system — even with no new player report.
        </p>
        <Textarea
          value={red}
          onChange={(e) => setRed(e.target.value)}
          onBlur={() => save("red", red)}
          placeholder="[slur], i'll find where you live, go back to your country"
          className="min-h-[80px] font-mono text-xs"
        />
      </div>

      <p className="text-[10px] text-muted-foreground font-mono">
        Changes save automatically when the field loses focus.
      </p>
    </div>
  );
}
function PredefinesPanel({ orgId, items, onAdd, onUpdate, onRemove }) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ keyword: "", extras: "", content: "" });
  const [err, setErr] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({
    keyword: "",
    extras: "",
    content: "",
  });
  useEffect(() => {
    setQuery("");
    setAdding(false);
    setDraft({ keyword: "", extras: "", content: "" });
    setErr(null);
    setEditingId(null);
  }, [orgId]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...items].sort((a, b) =>
      a.keyword.localeCompare(b.keyword),
    );
    if (!q) return sorted;
    return sorted.filter((p) => {
      if (p.keyword.toLowerCase().includes(q)) return true;
      if (p.extraKeywords.some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [items, query]);
  const splitCsv = (s) =>
    s
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  const handleAdd = async () => {
    const res = await onAdd({
      keyword: draft.keyword,
      extraKeywords: splitCsv(draft.extras),
      content: draft.content,
    });
    if (!res?.ok) {
      setErr(res?.error ?? "Failed to add pre-define.");
      return;
    }
    setDraft({ keyword: "", extras: "", content: "" });
    setErr(null);
    setAdding(false);
  };
  const startEdit = (p) => {
    setEditingId(p.id);
    setEditDraft({
      keyword: p.keyword,
      extras: p.extraKeywords.join(", "),
      content: p.content,
    });
  };
  const saveEdit = async () => {
    if (!editingId) return;
    const res = await onUpdate(editingId, {
      keyword: editDraft.keyword,
      extraKeywords: splitCsv(editDraft.extras),
      content: editDraft.content,
    });
    if (!res?.ok) {
      setErr(res?.error ?? "Failed to save.");
      return;
    }
    setEditingId(null);
    setErr(null);
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by keyword or extra keyword..."
            className="pl-7 h-8 text-xs"
          />
        </div>
        <Button
          size="sm"
          variant={adding ? "secondary" : "default"}
          onClick={() => {
            setAdding((v) => !v);
            setErr(null);
          }}
        >
          <Plus className="size-3.5 mr-1" /> New
        </Button>
      </div>

      {adding && (
        <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
          <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
            New pre-define
          </Label>
          <Input
            value={draft.keyword}
            onChange={(e) =>
              setDraft((d) => ({ ...d, keyword: e.target.value }))
            }
            placeholder="Keyword (e.g. deny-appeal)"
            className="h-8 text-xs font-mono"
          />
          <Input
            value={draft.extras}
            onChange={(e) =>
              setDraft((d) => ({ ...d, extras: e.target.value }))
            }
            placeholder="Extra keywords, comma-separated (e.g. appeal-deny, denyappeal)"
            className="h-8 text-xs font-mono"
          />
          <Textarea
            value={draft.content}
            onChange={(e) =>
              setDraft((d) => ({ ...d, content: e.target.value }))
            }
            placeholder="Pre-define content — what gets pasted into the reply box."
            className="min-h-[80px] text-xs"
          />
          {err && <p className="text-[11px] text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setErr(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleAdd}>
              Save
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
        {filtered.map((p) => {
          const isEditing = editingId === p.id;
          if (isEditing) {
            return (
              <div
                key={p.id}
                className="rounded-md ring-1 ring-brand/40 bg-surface/40 p-3 space-y-2"
              >
                <Input
                  value={editDraft.keyword}
                  onChange={(e) =>
                    setEditDraft((d) => ({ ...d, keyword: e.target.value }))
                  }
                  className="h-8 text-xs font-mono"
                />
                <Input
                  value={editDraft.extras}
                  onChange={(e) =>
                    setEditDraft((d) => ({ ...d, extras: e.target.value }))
                  }
                  placeholder="Extra keywords, comma-separated"
                  className="h-8 text-xs font-mono"
                />
                <Textarea
                  value={editDraft.content}
                  onChange={(e) =>
                    setEditDraft((d) => ({ ...d, content: e.target.value }))
                  }
                  className="min-h-[80px] text-xs"
                />
                {err && <p className="text-[11px] text-danger">{err}</p>}
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(null);
                      setErr(null);
                    }}
                  >
                    <X className="size-3.5 mr-1" /> Cancel
                  </Button>
                  <Button size="sm" onClick={saveEdit}>
                    <Check className="size-3.5 mr-1" /> Save
                  </Button>
                </div>
              </div>
            );
          }
          return (
            <div
              key={p.id}
              className="flex items-start justify-between gap-2 bg-background ring-1 ring-border rounded-md p-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold font-mono">{p.keyword}</p>
                {p.extraKeywords.length > 0 && (
                  <p className="text-[10px] font-mono text-muted-foreground truncate">
                    aka {p.extraKeywords.join(", ")}
                  </p>
                )}
                <p className="text-xs text-foreground/80 mt-1 line-clamp-2 whitespace-pre-wrap">
                  {p.content}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => startEdit(p)}
                  title="Edit"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => onRemove(p.id)}
                  title="Remove"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            {items.length === 0
              ? "No pre-defines yet. Add one above."
              : "No pre-defines match your search."}
          </p>
        )}
      </div>
    </div>
  );
}
const TAB_LABEL = {
  cheating: "Cheating",
  teaming: "Teaming",
  toxicity: "Toxicity",
  mute: "Mute",
};
const ALL_TABS = [...BAN_CATEGORIES, "mute"];
function BanConfigsPanel({
  orgId,
  configs,
  muteConfig,
  onAddReason,
  onUpdateReason,
  onRemoveReason,
  onSetNoteFormat,
  onAddMuteReason,
  onUpdateMuteReason,
  onRemoveMuteReason,
  onSetMuteNoteFormat,
}) {
  const [tab, setTab] = useState("teaming");
  const [newReason, setNewReason] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const isMuteTab = tab === "mute";
  const cfg = isMuteTab
    ? muteConfig
    : (configs[tab] ?? { reasons: [], noteFormat: "" });
  useEffect(() => {
    setNoteDraft(cfg.noteFormat);
    setEditingId(null);
    setNewReason("");
  }, [orgId, tab, cfg.noteFormat]);
  const addReason = (label) =>
    isMuteTab ? onAddMuteReason(label) : onAddReason(tab, label);
  const updateReason = (id, label) =>
    isMuteTab ? onUpdateMuteReason(id, label) : onUpdateReason(tab, id, label);
  const removeReason = (id) =>
    isMuteTab ? onRemoveMuteReason(id) : onRemoveReason(tab, id);
  const setNoteFormat = (fmt) =>
    isMuteTab ? onSetMuteNoteFormat(fmt) : onSetNoteFormat(tab, fmt);
  const noun = isMuteTab ? "mute" : "ban";
  return (
    <div className="space-y-4">
      <div className="flex rounded ring-1 ring-border overflow-hidden text-[10px] font-bold uppercase tracking-wider">
        {ALL_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "flex-1 py-1.5 " +
              (tab === t
                ? "bg-brand/15 text-brand"
                : "bg-surface text-muted-foreground hover:text-foreground")
            }
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
          {TAB_LABEL[tab]} {noun} reasons
        </Label>
        <div className="flex gap-2">
          <Input
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            placeholder={
              isMuteTab
                ? "Add a reason (e.g. Mic abuse)"
                : "Add a reason (e.g. Aimbot)"
            }
            className="h-8 text-xs flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newReason.trim()) {
                addReason(newReason);
                setNewReason("");
              }
            }}
          />
          <Button
            size="sm"
            disabled={!newReason.trim()}
            onClick={() => {
              addReason(newReason);
              setNewReason("");
            }}
          >
            <Plus className="size-3.5 mr-1" /> Add
          </Button>
        </div>
        <div className="space-y-1 max-h-[160px] overflow-y-auto pr-1">
          {cfg.reasons.map((r) =>
            editingId === r.id ? (
              <div key={r.id} className="flex gap-1.5 items-center">
                <Input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  className="h-7 text-xs flex-1"
                  autoFocus
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => {
                    updateReason(r.id, editLabel);
                    setEditingId(null);
                  }}
                >
                  <Check className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setEditingId(null)}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : (
              <div
                key={r.id}
                className="flex items-center justify-between gap-2 bg-background ring-1 ring-border rounded px-2 py-1.5"
              >
                <span className="text-xs">{r.label}</span>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    onClick={() => {
                      setEditingId(r.id);
                      setEditLabel(r.label);
                    }}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    onClick={() => removeReason(r.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
            ),
          )}
          {cfg.reasons.length === 0 && (
            <p className="text-[11px] text-muted-foreground italic">
              No reasons yet. Staff will only have "Custom {noun} reason"
              available.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
            {TAB_LABEL[tab]} {noun} note format
          </Label>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Pre-fills the "{isMuteTab ? "Mute" : "Ban"} note" textarea when staff
          issue a {tab === "mute" ? "mute" : `${tab} ban`}. Saves on blur.
        </p>
        <Textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => setNoteFormat(noteDraft)}
          className="min-h-[140px] text-xs font-mono"
        />
      </div>

      <p className="text-[10px] text-muted-foreground font-mono">
        "Other" reports always use a custom reason and have no note template.
      </p>
    </div>
  );
}
function TicketTypesPanel({ enabled, onToggle }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
          Ticket types
        </Label>
        <p className="text-[11px] text-muted-foreground">
          Disabled types are hidden from the public submit form and from staff
          queues for this org.
        </p>
        <div className="divide-y divide-border">
          {TICKET_TYPE_KEYS.map((key) => (
            <div key={key} className="flex items-center justify-between py-2">
              <span className="text-sm">{TICKET_TYPE_LABELS[key]}</span>
              <Switch
                checked={enabled[key] ?? true}
                onCheckedChange={(v) => onToggle(key, v)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { BanConfigsPanel, PredefinesPanel, ToxicityPanel, TicketTypesPanel };

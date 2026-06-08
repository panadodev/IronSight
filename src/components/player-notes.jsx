import { useMemo, useState } from "react";
import { Pin, PinOff, Trash2, Lock, StickyNote } from "lucide-react";
import {
  usePlayerNotes,
  playerNotesStore,
  NOTE_RANK_OPTIONS,
  rankLabel,
  timeAgo
} from "@/lib/player-notes";
import { useAuth } from "@/lib/auth-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
function useEffectiveRank(orgId) {
  const { rankOf, selectedOrgIds, maxRankAcross } = useAuth();
  return orgId ? rankOf(orgId) : maxRankAcross(selectedOrgIds);
}
function NoteCard({
  note,
  canManage,
  canEdit
}) {
  return <li className="bg-surface/40 ring-1 ring-border rounded p-2.5 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
            {note.body}
          </p>
        </div>
        {canManage && <div className="flex items-center gap-1 shrink-0">
            <button
    onClick={() => playerNotesStore.update(note.id, { pinned: !note.pinned })}
    className={`p-1 rounded hover:bg-surface ${note.pinned ? "text-warning" : "text-muted-foreground"}`}
    title={note.pinned ? "Unpin" : "Pin to tickets"}
  >
              {note.pinned ? <Pin className="size-3" /> : <PinOff className="size-3" />}
            </button>
            {canEdit && <button
    onClick={() => playerNotesStore.remove(note.id)}
    className="p-1 rounded text-muted-foreground hover:text-danger hover:bg-surface"
    title="Delete note"
  >
                <Trash2 className="size-3" />
              </button>}
          </div>}
      </div>
      <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
        <span>{note.authorName}</span>
        <span>·</span>
        <span>{timeAgo(note.createdAt)}</span>
        <span className="ml-auto inline-flex items-center gap-1">
          <Lock className="size-2.5" />
          {rankLabel(note.minRank)}
        </span>
        {note.pinned && <span className="inline-flex items-center gap-0.5 text-warning">
            <Pin className="size-2.5" />
            pinned
          </span>}
      </div>
    </li>;
}
function PlayerNotesSection({
  subjectId,
  orgId
}) {
  const all = usePlayerNotes(subjectId);
  const { activeStaff, activeStaffId } = useAuth();
  const myRank = useEffectiveRank(orgId);
  const [body, setBody] = useState("");
  const [minRank, setMinRank] = useState(1);
  const visible = useMemo(
    () => all.filter((n) => myRank >= n.minRank).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    }),
    [all, myRank]
  );
  const submit = (e) => {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || !activeStaff) return;
    playerNotesStore.add({
      subjectId,
      body: trimmed,
      authorId: activeStaffId,
      authorName: activeStaff.name,
      minRank,
      pinned: false
    });
    setBody("");
    setMinRank(1);
  };
  return <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <StickyNote className="size-3" />
        Notes
        <span className="font-mono normal-case tracking-normal text-muted-foreground ml-auto">
          {visible.length}
        </span>
      </h3>

      <form
    onSubmit={submit}
    className="bg-surface/40 ring-1 ring-border rounded p-3 space-y-2 mb-3"
  >
        <textarea
    value={body}
    onChange={(e) => setBody(e.target.value)}
    rows={2}
    placeholder="Add a note about this player…"
    className="w-full bg-background ring-1 ring-border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-brand resize-y"
  />
        <div className="flex items-center gap-2">
          <Select value={String(minRank)} onValueChange={(v) => setMinRank(Number(v))}>
            <SelectTrigger className="h-8 text-xs flex-1 bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTE_RANK_OPTIONS.map((opt) => <SelectItem key={opt.value} value={String(opt.value)} className="text-xs">
                  {opt.label}
                </SelectItem>)}
            </SelectContent>
          </Select>
          <button
    type="submit"
    disabled={!body.trim()}
    className="h-8 px-3 bg-brand text-brand-foreground rounded text-xs font-semibold disabled:opacity-40 hover:opacity-90"
  >
            Save note
          </button>
        </div>
      </form>

      {visible.length === 0 ? <p className="text-xs text-muted-foreground italic">No notes visible to you.</p> : <ul className="space-y-2">
          {visible.map((n) => <NoteCard
    key={n.id}
    note={n}
    canManage={n.authorId === activeStaffId || myRank >= 4}
    canEdit={n.authorId === activeStaffId || myRank >= 4}
  />)}
        </ul>}
    </section>;
}
function PinnedPlayerNotesSection({
  subjectId,
  orgId
}) {
  const all = usePlayerNotes(subjectId);
  const myRank = useEffectiveRank(orgId);
  const visible = useMemo(
    () => all.filter((n) => n.pinned && myRank >= n.minRank).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [all, myRank]
  );
  if (visible.length === 0) return null;
  return <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <Pin className="size-3 text-warning" />
        Pinned Notes
        <span className="font-mono normal-case tracking-normal text-muted-foreground ml-auto">
          {visible.length}
        </span>
      </h2>
      <ul className="space-y-2">
        {visible.map((n) => <li
    key={n.id}
    className="bg-warning/5 ring-1 ring-warning/30 rounded p-2.5 space-y-1.5"
  >
            <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
              {n.body}
            </p>
            <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
              <span>{n.authorName}</span>
              <span>·</span>
              <span>{timeAgo(n.createdAt)}</span>
              <span className="ml-auto inline-flex items-center gap-1">
                <Lock className="size-2.5" />
                {rankLabel(n.minRank)}
              </span>
            </div>
          </li>)}
      </ul>
    </section>;
}
export {
  PinnedPlayerNotesSection,
  PlayerNotesSection
};

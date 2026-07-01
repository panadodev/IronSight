import { useCallback, useEffect, useMemo, useState } from "react";
import { Pin, PinOff, Trash2, Lock, StickyNote } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function timeAgo(unix) {
  const m = Math.floor((Date.now() / 1000 - unix) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

const LEGACY_RANK_LABELS = {
  1: "All staff",
  2: "Admin and above",
  3: "Sr. Admin and above",
  4: "Management only",
};

function noteVisibilityLabel(note, roles) {
  if (note.requiredRoleId) {
    const role = roles.find((r) => r.roleId === note.requiredRoleId);
    return role ? role.roleName : note.requiredRoleId;
  }
  return LEGACY_RANK_LABELS[note.minRank] ?? `Rank ${note.minRank}+`;
}

function useOrgNoteRoles(orgId) {
  const [roles, setRoles] = useState([]);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/note-roles`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setRoles(data?.roles ?? []))
      .catch(() => {});
  }, [orgId]);

  return roles;
}

function usePlayerNotesApi(orgId, subjectId) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!orgId || !subjectId) {
      setNotes([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/players/${encodeURIComponent(subjectId)}/notes`,
        { credentials: "include" },
      );
      const body = await res.json().catch(() => ({}));
      setNotes(res.ok ? (body.notes ?? []) : []);
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [orgId, subjectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { notes, loading, reload };
}

// Combined notes across all the caller's orgs + notes shared in by other orgs.
// Each note carries its own `orgId`, an `orgName`, and a `shared` flag so the
// lookup can attribute it, gate management per its source org, and filter by the
// active org selection. Used on the player lookup page (the per-org hook above
// still backs the single-org ticket view).
function usePlayerNotesCombined(subjectId) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!subjectId) {
      setNotes([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/players/${encodeURIComponent(subjectId)}/notes`,
        { credentials: "include" },
      );
      const body = await res.json().catch(() => ({}));
      setNotes(res.ok ? (body.notes ?? []) : []);
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [subjectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { notes, loading, reload };
}

function NoteCard({
  note,
  orgId,
  subjectId,
  canManage,
  canEdit,
  onChange,
  roles,
}) {
  const [busy, setBusy] = useState(false);

  const togglePin = async () => {
    setBusy(true);
    try {
      await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/players/${encodeURIComponent(subjectId)}/notes/${note.id}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned: !note.pinned }),
        },
      );
    } finally {
      setBusy(false);
      onChange();
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/players/${encodeURIComponent(subjectId)}/notes/${note.id}`,
        { method: "DELETE", credentials: "include" },
      );
    } finally {
      setBusy(false);
      onChange();
    }
  };

  return (
    <li className="bg-surface/40 ring-1 ring-border rounded p-2.5 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
            {note.body}
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={togglePin}
              disabled={busy}
              className={`p-1 rounded hover:bg-surface disabled:opacity-50 ${note.pinned ? "text-warning" : "text-muted-foreground"}`}
              title={note.pinned ? "Unpin" : "Pin to tickets"}
            >
              {note.pinned ? (
                <Pin className="size-3" />
              ) : (
                <PinOff className="size-3" />
              )}
            </button>
            {canEdit && (
              <button
                onClick={remove}
                disabled={busy}
                className="p-1 rounded text-muted-foreground hover:text-danger hover:bg-surface disabled:opacity-50"
                title="Delete note"
              >
                <Trash2 className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
        <span>{note.authorName ?? "unknown"}</span>
        <span>·</span>
        <span>{timeAgo(note.createdAt)}</span>
        {note.shared && note.orgName && (
          <span className="inline-flex items-center gap-0.5 text-brand">
            shared · {note.orgName}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1">
          <Lock className="size-2.5" />
          {noteVisibilityLabel(note, roles)}
        </span>
        {note.pinned && (
          <span className="inline-flex items-center gap-0.5 text-warning">
            <Pin className="size-2.5" />
            pinned
          </span>
        )}
      </div>
    </li>
  );
}

function PlayerNotesSection({ subjectId, orgId }) {
  // List spans all the caller's orgs + shared-in notes; create still targets the
  // active org (`orgId`).
  const { notes, loading, reload } = usePlayerNotesCombined(subjectId);
  const { sessionUser, rankOf, orgs, selectedOrgIds } = useAuth();
  const roles = useOrgNoteRoles(orgId);

  const [body, setBody] = useState("");
  // Encodes the note's visibility as either "rank:<1-4>" (a sensitivity level,
  // shareable cross-org) or "role:<roleId>" (gated to one org role, never shared).
  const [visibility, setVisibility] = useState("rank:1");
  const [saving, setSaving] = useState(false);

  // Same dropdown-scoping rule as the rest of the lookup: hide a note only when
  // all its sources are own-orgs the user has unchecked; shared-in notes stay.
  const visible = useMemo(() => {
    const ownSet = new Set(orgs.map((o) => o.id));
    const selectedSet = new Set(selectedOrgIds);
    return [...notes]
      .filter((n) => {
        const src = n.sourceOrgIds ?? (n.orgId ? [n.orgId] : []);
        const ownSources = src.filter((o) => ownSet.has(o));
        if (ownSources.length === 0) return true;
        return ownSources.some((o) => selectedSet.has(o));
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.createdAt - a.createdAt;
      });
  }, [notes, orgs, selectedOrgIds]);

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || !orgId || saving) return;
    const isRole = visibility.startsWith("role:");
    setSaving(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/players/${encodeURIComponent(subjectId)}/notes`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: trimmed,
            minRank: isRole ? 1 : Number(visibility.slice(5)),
            requiredRoleId: isRole ? visibility.slice(5) : null,
            pinned: false,
          }),
        },
      );
      if (res.ok) {
        setBody("");
        setVisibility("rank:1");
        reload();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <StickyNote className="size-3 shrink-0" />
        Notes
        <span className="font-mono normal-case tracking-normal text-muted-foreground ml-auto">
          {visible.length}
        </span>
      </h3>

      <form
        onSubmit={submit}
        className="bg-background/60 ring-1 ring-border rounded p-3 space-y-2 mb-3"
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={4000}
          placeholder="Add a note about this player…"
          className="w-full bg-background ring-1 ring-border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-brand resize-y"
        />
        <div className="flex items-center gap-2">
          <Select value={visibility} onValueChange={setVisibility}>
            <SelectTrigger className="h-8 text-xs flex-1 bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rank:1" className="text-xs">
                All staff
              </SelectItem>
              {roles.map((role) => (
                <SelectItem
                  key={role.roleId}
                  value={`role:${role.roleId}`}
                  className="text-xs"
                >
                  {role.roleName} only
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="submit"
            disabled={!body.trim() || saving || !orgId}
            className="h-8 px-3 bg-brand text-brand-foreground rounded text-xs font-semibold disabled:opacity-40 hover:opacity-90"
          >
            Save note
          </button>
        </div>
      </form>

      {loading ? (
        <p className="text-xs text-muted-foreground italic">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No notes visible to you.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((n) => {
            const isAuthor = n.authorId && n.authorId === sessionUser?.userId;
            // Shared-in notes are read-only; own notes follow the usual rule
            // (author, or rank 4 in that note's org).
            const canManage = !n.shared && (isAuthor || rankOf(n.orgId) >= 4);
            return (
              <NoteCard
                key={n.id}
                note={n}
                orgId={n.orgId ?? orgId}
                subjectId={subjectId}
                canManage={canManage}
                canEdit={canManage}
                onChange={reload}
                roles={roles}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PinnedPlayerNotesSection({ subjectId, orgId }) {
  const { notes } = usePlayerNotesApi(orgId, subjectId);
  const roles = useOrgNoteRoles(orgId);
  const visible = useMemo(
    () =>
      notes.filter((n) => n.pinned).sort((a, b) => b.createdAt - a.createdAt),
    [notes],
  );
  if (!orgId || visible.length === 0) return null;
  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <Pin className="size-3 shrink-0 text-warning" />
        Pinned Notes
        <span className="font-mono normal-case tracking-normal text-muted-foreground ml-auto">
          {visible.length}
        </span>
      </h2>
      <ul className="space-y-2">
        {visible.map((n) => (
          <li
            key={n.id}
            className="bg-warning/5 ring-1 ring-warning/30 rounded p-2.5 space-y-1.5"
          >
            <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
              {n.body}
            </p>
            <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
              <span>{n.authorName ?? "unknown"}</span>
              <span>·</span>
              <span>{timeAgo(n.createdAt)}</span>
              <span className="ml-auto inline-flex items-center gap-1">
                <Lock className="size-2.5" />
                {noteVisibilityLabel(n, roles)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export { PinnedPlayerNotesSection, PlayerNotesSection };

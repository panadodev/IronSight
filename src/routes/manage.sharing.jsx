import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { SectionHeader } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ShieldAlert,
  Plus,
  Check,
  X,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";

const Route = createFileRoute("/manage/sharing")({
  component: SharingPage,
});

// Friendly labels for the share categories the API accepts.
const CATEGORY_LABELS = {
  bans: "Bans",
  mutes: "Mutes",
  ips: "IP addresses",
  notes: "Player notes",
  reports: "In-game reports",
  sessions: "Session history",
  bm_bans: "BattleMetrics bans",
  alts: "Linked accounts",
};

// Note sensitivity levels (player_notes.min_rank). When sharing notes, the owner
// picks the ceiling — notes at/below this level (and not gated to a specific org
// role) are shared.
const NOTE_LEVELS = [
  { value: 1, label: "All-staff notes only" },
  { value: 2, label: "Up to Admin-level" },
  { value: 3, label: "Up to Sr. Admin-level" },
  { value: 4, label: "All notes (incl. management)" },
];

function SharingPage() {
  const { orgs, adminableOrgIds } = useAuth();
  const orgId = useManageOrgId();

  const [grants, setGrants] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({});

  // Create form
  const [granteeOrgId, setGranteeOrgId] = useState("");
  const [picked, setPicked] = useState([]);
  const [notesLevel, setNotesLevel] = useState(1);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState("");

  const isAdmin = adminableOrgIds?.includes(orgId);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/shares`, {
        credentials: "include",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setGrants(data.grants ?? []);
      setCategories(data.categories ?? []);
      setError(null);
    } catch {
      setError("Failed to load sharing arrangements.");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const orgName = (id) => orgs.find((o) => o.id === id)?.name ?? id;

  const withBusy = async (id, fn) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const accept = (g) =>
    withBusy(g.id, async () => {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/shares/${g.id}/accept`,
        { method: "POST", credentials: "include" },
      );
      if (res.ok) await load();
    });

  const revoke = (g) =>
    withBusy(g.id, async () => {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/shares/${g.id}`,
        { method: "DELETE", credentials: "include" },
      );
      if (res.ok) await load();
    });

  const toggle = (c) =>
    setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  const create = async () => {
    const target = granteeOrgId.trim();
    if (!target) {
      setCreateError("Enter the partner organization's ID.");
      return;
    }
    if (!picked.length) {
      setCreateError("Pick at least one category to share.");
      return;
    }
    setSaving(true);
    setCreateError("");
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/shares`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          granteeOrgId: target,
          categories: picked,
          notesShareLevel: notesLevel,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(data.error ?? `Failed (${res.status})`);
        return;
      }
      setGranteeOrgId("");
      setPicked([]);
      setNotesLevel(1);
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (!orgId) return null;
  if (!isAdmin) {
    return (
      <div className="rounded-lg ring-1 ring-border bg-surface/40 p-8 text-center space-y-2">
        <ShieldAlert className="size-8 mx-auto text-warning" />
        <h2 className="text-base font-semibold">Admin+ only</h2>
        <p className="text-sm text-muted-foreground">
          Only organization admins/owners can manage data-sharing arrangements.
        </p>
      </div>
    );
  }

  const outgoing = grants.filter((g) => g.direction === "outgoing");
  const incoming = grants.filter((g) => g.direction === "incoming");

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Data sharing"
        blurb="Grant other organizations read access to specific categories of your player data (bans, IPs, notes…). Data is shared by reference — records stay yours and the other org sees them read-only on player lookups. Both sides must agree."
      />

      {/* Create */}
      <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-3">
        <h3 className="text-sm font-semibold">Share with another org</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              Partner organization ID
            </label>
            <Input
              value={granteeOrgId}
              onChange={(e) => setGranteeOrgId(e.target.value)}
              placeholder="org_…"
              className="font-mono w-72"
            />
          </div>
          <Button onClick={create} disabled={saving}>
            <Plus className="size-3.5 mr-1.5" />
            {saving ? "Sending…" : "Send offer"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(categories.length ? categories : Object.keys(CATEGORY_LABELS)).map(
            (c) => {
              const on = picked.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggle(c)}
                  className={
                    "px-2.5 py-1 rounded text-xs font-medium ring-1 transition-colors " +
                    (on
                      ? "bg-brand/15 ring-brand/40 text-brand"
                      : "bg-surface ring-border text-muted-foreground hover:text-foreground")
                  }
                >
                  {CATEGORY_LABELS[c] ?? c}
                </button>
              );
            },
          )}
        </div>
        {picked.includes("notes") && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">
              Notes to share:
            </label>
            <select
              value={notesLevel}
              onChange={(e) => setNotesLevel(Number(e.target.value))}
              className="h-8 text-xs bg-background ring-1 ring-border rounded px-2 focus:outline-none focus:ring-brand"
            >
              {NOTE_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-muted-foreground">
              Role-restricted notes are never shared.
            </span>
          </div>
        )}
        {createError && (
          <p className="text-xs text-destructive">{createError}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          The partner org must accept the offer before any data is shared. Ask
          them for their organization ID.
        </p>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Incoming — others sharing with us */}
      <GrantList
        title="Shared with us"
        icon={ArrowLeft}
        empty="No org is sharing data with you yet."
        grants={incoming}
        orgLabel={(g) => orgName(g.ownerOrgId)}
        busy={busy}
        onAccept={accept}
        onRevoke={revoke}
        showAccept
      />

      {/* Outgoing — we share with others */}
      <GrantList
        title="We share"
        icon={ArrowRight}
        empty="You aren't sharing data with any org yet."
        grants={outgoing}
        orgLabel={(g) => g.granteeOrgName ?? g.granteeOrgId}
        busy={busy}
        onRevoke={revoke}
      />
    </div>
  );
}

function GrantList({
  title,
  icon: Icon,
  empty,
  grants,
  orgLabel,
  busy,
  onAccept,
  onRevoke,
  showAccept = false,
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
        <Icon className="size-3.5" />
        {title}
      </h3>
      {grants.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{empty}</p>
      ) : (
        <div className="rounded-md ring-1 ring-border divide-y divide-border overflow-hidden">
          {grants.map((g) => (
            <div
              key={g.id}
              className="flex items-center gap-3 px-3 py-2.5 bg-surface/30"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {orgLabel(g)}
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      "text-[9px] " +
                      (g.status === "active"
                        ? "border-success/40 text-success"
                        : "border-warning/40 text-warning")
                    }
                  >
                    {g.status}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {g.categories.map((c) => (
                    <span
                      key={c}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded ring-1 ring-border text-muted-foreground"
                    >
                      {CATEGORY_LABELS[c] ?? c}
                      {c === "notes" &&
                        ` · ${
                          NOTE_LEVELS.find(
                            (l) => l.value === (g.notesShareLevel ?? 1),
                          )?.label ?? `L${g.notesShareLevel}`
                        }`}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {showAccept && g.status === "pending" && (
                  <Button
                    size="sm"
                    className="h-7"
                    onClick={() => onAccept(g)}
                    disabled={!!busy[g.id]}
                  >
                    <Check className="size-3.5 mr-1" />
                    Accept
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-muted-foreground hover:text-destructive"
                  onClick={() => onRevoke(g)}
                  disabled={!!busy[g.id]}
                  title="Revoke / decline"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { Route };

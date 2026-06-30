import { SteamRequiredGate } from "@/components/steam-required-gate";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert, Edit3, X, Plus, Trash2 } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Hint, HINTS } from "@/components/hint";
import {
  NewBanDialog,
  DURATION_PRESETS,
  BAN_CATEGORIES,
  MUTE_CATEGORIES,
  computeExpiresAt,
  fmtRemaining,
} from "@/components/new-ban-dialog";

const Route = createFileRoute("/bans-mutes")({
  head: () => ({ meta: [{ title: "Bans / Mutes — IronSight" }] }),
  component: BansMutesPage,
});

function fmtAgo(unix) {
  const m = Math.max(0, Math.floor((Date.now() / 1000 - unix) / 60));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// A staffer can reach the Bans/Mutes view if they hold any ban permission in
// the org (create, modify, delete, the IP-ban perm, or the legacy umbrella).
function canAccessBansInOrg(hasOrgPermission, id) {
  return (
    hasOrgPermission(id, "bans_create") ||
    hasOrgPermission(id, "bans_modify") ||
    hasOrgPermission(id, "bans_delete") ||
    hasOrgPermission(id, "bans_purge") ||
    hasOrgPermission(id, "bans_ip") ||
    hasOrgPermission(id, "bans_manage")
  );
}

function BansMutesPage() {
  const { selectedOrgIds, hasOrgPermission, orgs } = useAuth();
  const canAccess = selectedOrgIds.some((id) =>
    canAccessBansInOrg(hasOrgPermission, id),
  );

  const [tab, setTab] = useState("bans");
  const [bans, setBans] = useState([]);
  const [mutes, setMutes] = useState([]);
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [actionResult, setActionResult] = useState(null);
  const [pendingRevoke, setPendingRevoke] = useState(null);

  const manageableOrgIds = useMemo(
    () =>
      selectedOrgIds.filter((id) => canAccessBansInOrg(hasOrgPermission, id)),
    [selectedOrgIds, hasOrgPermission],
  );

  // Orgs where the user can actually issue new bans (drives the "Issue" button
  // and the org options in the new-ban dialog).
  const creatableOrgIds = useMemo(
    () =>
      selectedOrgIds.filter(
        (id) =>
          hasOrgPermission(id, "bans_create") ||
          hasOrgPermission(id, "bans_manage"),
      ),
    [selectedOrgIds, hasOrgPermission],
  );

  const loadBans = useCallback(async () => {
    if (!manageableOrgIds.length) {
      setBans([]);
      setMutes([]);
      return;
    }
    setLoading(true);
    try {
      const [banGroups, muteGroups] = await Promise.all([
        Promise.all(
          manageableOrgIds.map((orgId) =>
            fetch(`/api/orgs/${encodeURIComponent(orgId)}/bans?type=ban`, {
              credentials: "include",
            })
              .then((r) => r.json())
              .then((b) => b.bans ?? [])
              .catch(() => []),
          ),
        ),
        Promise.all(
          manageableOrgIds.map((orgId) =>
            fetch(`/api/orgs/${encodeURIComponent(orgId)}/bans?type=mute`, {
              credentials: "include",
            })
              .then((r) => r.json())
              .then((b) => b.bans ?? [])
              .catch(() => []),
          ),
        ),
      ]);
      setBans(banGroups.flat().sort((a, b) => b.issuedAt - a.issuedAt));
      setMutes(muteGroups.flat().sort((a, b) => b.issuedAt - a.issuedAt));
    } finally {
      setLoading(false);
    }
  }, [manageableOrgIds]);

  const loadServers = useCallback(async () => {
    try {
      const res = await fetch("/api/servers", { credentials: "include" });
      if (res.ok) {
        const body = await res.json();
        setServers(body.servers ?? []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadBans();
    loadServers();
  }, [loadBans, loadServers]);

  const rows = useMemo(() => {
    const base = tab === "bans" ? bans : mutes;
    const q = query.trim().toLowerCase();
    return base.filter((r) =>
      q
        ? r.identifier.toLowerCase().includes(q) ||
          r.reason.toLowerCase().includes(q) ||
          (r.issuedByName ?? "").toLowerCase().includes(q)
        : true,
    );
  }, [tab, bans, mutes, query]);

  const revoke = async (record) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(record.orgId)}/bans/${record.banId}`,
      { method: "DELETE", credentials: "include" },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setActionResult({
        type: "error",
        message: body?.error ?? "Failed to revoke record.",
      });
      setTimeout(() => setActionResult(null), 6000);
      return;
    }
    if (body?.bmDeleteError) {
      setActionResult({
        type: "warn",
        message: `Revoked, but BM delete failed: ${body.bmDeleteError}`,
      });
      setTimeout(() => setActionResult(null), 6000);
    }
    loadBans();
  };

  const purge = async (record) => {
    if (
      !confirm(
        `Permanently delete this ${record.actionType} record? This cannot be undone.`,
      )
    )
      return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(record.orgId)}/bans/${record.banId}/purge`,
      { method: "DELETE", credentials: "include" },
    );
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.bmDeleteError) {
        setActionResult({
          type: "warn",
          message: `Record purged, but BM delete failed: ${body.bmDeleteError}`,
        });
        setTimeout(() => setActionResult(null), 6000);
      }
      loadBans();
    }
  };

  if (!canAccess) {
    return (
      <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 grid place-items-center px-6">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="size-10 text-warning mx-auto" />
            <h1 className="text-lg font-semibold">Permission required</h1>
            <p className="text-sm text-muted-foreground">
              Bans &amp; Mutes requires the Issue Bans / Mutes permission.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <SteamRequiredGate>
      <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
            {actionResult && (
              <div
                className={
                  "rounded-md border px-4 py-2.5 text-sm " +
                  (actionResult.type === "error"
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : "border-warning/40 bg-warning/10 text-warning")
                }
              >
                {actionResult.message}
              </div>
            )}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold tracking-tight">
                  Bans / Mutes
                </h1>
                <p className="text-xs text-muted-foreground mt-1">
                  Every active and historical {tab === "bans" ? "ban" : "mute"}{" "}
                  for your selected orgs.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-surface/60 ring-1 ring-border rounded-md p-0.5">
                  {["bans", "mutes"].map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setTab(t);
                        setQuery("");
                      }}
                      className={
                        "px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors " +
                        (tab === t
                          ? "bg-brand text-brand-foreground"
                          : "text-muted-foreground hover:text-foreground")
                      }
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {creatableOrgIds.length > 0 && (
                  <Button
                    size="sm"
                    onClick={() => setShowNew(true)}
                    className="gap-1.5"
                  >
                    <Plus className="size-3.5" />
                    Issue {tab === "bans" ? "Ban" : "Mute"}
                  </Button>
                )}
              </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                placeholder="Search identifier / reason / staff…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-9 max-w-xs"
              />
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground ml-auto">
                {loading ? "Loading…" : `${rows.length} records`}
              </div>
            </div>

            {/* Table */}
            <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
              <div className="grid grid-cols-[minmax(200px,2fr)_90px_1fr_120px_130px_110px_100px] gap-2 px-3 py-2 border-b border-border text-[10px] font-mono uppercase tracking-widest text-muted-foreground sticky top-0 bg-surface/80 backdrop-blur">
                <div>Identifier</div>
                <div>Category</div>
                <div>Reason</div>
                <div>Status</div>
                <div>Staff</div>
                <div>Issued</div>
                <div className="text-right">Actions</div>
              </div>
              <div className="divide-y divide-border/60">
                {rows.map((r) => {
                  const org = orgs.find((o) => o.id === r.orgId);
                  const canEdit =
                    hasOrgPermission(r.orgId, "bans_modify") ||
                    hasOrgPermission(r.orgId, "bans_manage");
                  const canRevoke = hasOrgPermission(r.orgId, "bans_delete");
                  return (
                    <div
                      key={r.banId}
                      className="grid grid-cols-[minmax(200px,2fr)_90px_1fr_120px_130px_110px_100px] gap-2 px-3 py-2 items-center text-xs hover:bg-surface/60"
                    >
                      <div className="min-w-0">
                        <div className="font-mono font-medium truncate">
                          {r.identifier}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                          <span
                            className={
                              "px-1 rounded text-[9px] font-bold ring-1 " +
                              (r.identifierType === "ip"
                                ? "bg-warning/15 text-warning ring-warning/40"
                                : "bg-brand/15 text-brand ring-brand/40")
                            }
                          >
                            {r.identifierType === "ip" ? "IP" : "Steam ID"}
                          </span>
                          {r.sourceIpBanId && (
                            <Hint text={HINTS.banEvasion}>
                              <span className="px-1 rounded text-[9px] font-bold ring-1 bg-danger/15 text-danger ring-danger/40 cursor-help">
                                IP-EVADE
                              </span>
                            </Hint>
                          )}
                          {org && (
                            <span className="text-[10px] font-mono text-muted-foreground">
                              {org.short}
                            </span>
                          )}
                        </div>
                        {r.identifierType === "ip" && r.playerSteamId && (
                          <div className="mt-1 text-[10px] font-mono text-muted-foreground truncate">
                            {r.playerSteamId}
                          </div>
                        )}
                        {r.identifierType === "ip" &&
                          r.linkedBans?.length > 0 && (
                            <div className="mt-1 space-y-0.5">
                              {r.linkedBans.map((lb) => (
                                <div
                                  key={lb.steamId}
                                  className="text-[10px] font-mono text-muted-foreground truncate flex items-center gap-1"
                                >
                                  <span className="px-1 rounded text-[9px] font-bold ring-1 bg-danger/10 text-danger ring-danger/30">
                                    auto-banned
                                  </span>
                                  <span className="truncate">
                                    {lb.name ?? lb.steamId}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                      </div>
                      <div>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 ring-border bg-surface capitalize">
                          {r.category?.replace("_", " ") ?? "—"}
                        </span>
                      </div>
                      <div
                        className="truncate text-muted-foreground"
                        title={r.reason}
                      >
                        {r.reason || "—"}
                      </div>
                      <div>
                        <span
                          className={
                            "px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 " +
                            (r.revoked
                              ? "bg-muted text-muted-foreground ring-border"
                              : !r.expiresAt
                                ? "bg-danger/15 text-danger ring-danger/40"
                                : r.expiresAt <= Math.floor(Date.now() / 1000)
                                  ? "bg-surface text-muted-foreground ring-border"
                                  : "bg-warning/15 text-warning ring-warning/40")
                          }
                        >
                          {fmtRemaining(r.expiresAt, r.revoked)}
                        </span>
                      </div>
                      <div className="truncate text-muted-foreground">
                        {r.issuedByName ?? "—"}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {fmtAgo(r.issuedAt)}
                      </div>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => canEdit && setEditing(r)}
                          disabled={!canEdit}
                          className={
                            "size-7 inline-flex items-center justify-center rounded ring-1 transition-colors " +
                            (canEdit
                              ? "ring-border hover:bg-surface"
                              : "ring-border/30 text-muted-foreground/30 cursor-not-allowed")
                          }
                          title={
                            canEdit ? "Edit" : "Requires ban modify permission"
                          }
                        >
                          <Edit3 className="size-3" />
                        </button>
                        {!r.revoked && (
                          <button
                            onClick={() => canRevoke && setPendingRevoke(r)}
                            disabled={!canRevoke}
                            className={
                              "size-7 inline-flex items-center justify-center rounded ring-1 transition-colors " +
                              (canRevoke
                                ? "ring-danger/40 text-danger hover:bg-danger/10"
                                : "ring-border/30 text-muted-foreground/30 cursor-not-allowed")
                            }
                            title={
                              canRevoke
                                ? "Revoke"
                                : "Requires ban delete permission"
                            }
                          >
                            <X className="size-3" />
                          </button>
                        )}
                        {hasOrgPermission(r.orgId, "bans_purge") && (
                          <button
                            onClick={() => purge(r)}
                            className="size-7 inline-flex items-center justify-center rounded ring-1 ring-danger/60 text-danger hover:bg-danger/20"
                            title="Purge record"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {!loading && rows.length === 0 && (
                  <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                    No records match your filters.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <NewBanDialog
          open={showNew}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            loadBans();
          }}
          defaultActionType={tab === "bans" ? "ban" : "mute"}
          manageableOrgIds={creatableOrgIds}
          orgs={orgs}
          servers={servers}
          hasOrgPermission={hasOrgPermission}
        />

        <EditDialog
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadBans();
          }}
        />

        <AlertDialog
          open={!!pendingRevoke}
          onOpenChange={(o) => !o && setPendingRevoke(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Revoke {pendingRevoke?.actionType === "mute" ? "mute" : "ban"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This will revoke the{" "}
                {pendingRevoke?.actionType === "mute" ? "mute" : "ban"} on{" "}
                <span className="font-mono">{pendingRevoke?.identifier}</span>.
                This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-danger text-white hover:bg-danger/90"
                onClick={() => {
                  revoke(pendingRevoke);
                  setPendingRevoke(null);
                }}
              >
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SteamRequiredGate>
  );
}

const LOG_META = {
  BAN_CREATED: { label: "Issued", dot: "bg-brand" },
  MUTE_CREATED: { label: "Issued", dot: "bg-brand" },
  BAN_UPDATED: { label: "Modified", dot: "bg-muted-foreground" },
  MUTE_UPDATED: { label: "Modified", dot: "bg-muted-foreground" },
  BAN_REVOKED: { label: "Revoked", dot: "bg-danger" },
  MUTE_REVOKED: { label: "Revoked", dot: "bg-danger" },
  BAN_PURGED: { label: "Purged", dot: "bg-danger" },
  MUTE_PURGED: { label: "Purged", dot: "bg-danger" },
};

function fmtLogDate(unix) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LogChangeSummary({ actionType, metadata }) {
  if (actionType.endsWith("_UPDATED")) {
    const changes = metadata?.changes ?? {};
    const parts = [];
    if ("reason" in changes) parts.push("reason");
    if ("note" in changes) parts.push("note");
    if ("expiresAt" in changes) parts.push("duration");
    if (parts.length === 0) return null;
    return (
      <span className="text-muted-foreground">
        {" — "}changed {parts.join(", ")}
      </span>
    );
  }
  return null;
}

function EditDialog({ record, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [duration, setDuration] = useState("keep");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    if (record) {
      setReason(record.reason);
      setNote(record.note);
      setDuration("keep");
      setError("");
      setLogs([]);
      setLogsLoading(true);
      fetch(
        `/api/orgs/${encodeURIComponent(record.orgId)}/bans/${record.banId}/audit`,
        { credentials: "include" },
      )
        .then((r) => r.json())
        .then((b) => setLogs(b.logs ?? []))
        .catch(() => {})
        .finally(() => setLogsLoading(false));
    }
  }, [record]);

  if (!record) return null;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const patch = { reason, note };
      if (duration !== "keep") {
        patch.expiresAt = computeExpiresAt(duration, record.issuedAt);
      }
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(record.orgId)}/bans/${record.banId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Failed to save.");
        return;
      }
      onSaved();
    } catch (err) {
      setError(err.message ?? "Unknown error.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!record} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Edit {record.actionType === "mute" ? "mute" : "ban"} —{" "}
            {record.identifier}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px]">
            {record.identifierType === "ip" ? "IP" : "Steam ID"} · issued{" "}
            {fmtAgo(record.issuedAt)}
            {record.issuedByName ? ` by ${record.issuedByName}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Reason
            </Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Duration
            </Label>
            <Select value={duration} onValueChange={setDuration}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">Keep current</SelectItem>
                {DURATION_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {duration === "keep"
                ? `Currently: ${fmtRemaining(record.expiresAt, record.revoked)}`
                : `New expiry: ${fmtRemaining(computeExpiresAt(duration, record.issuedAt), false)} (from issue date)`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Note
            </Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              className="font-mono text-xs"
            />
          </div>
          {error && (
            <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
        </div>

        {/* History */}
        <div className="border-t border-border pt-4">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">
            History
          </p>
          {logsLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : logs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No log entries.</p>
          ) : (
            <div className="relative pl-4">
              <div className="absolute left-[5px] top-0 bottom-0 w-px bg-border" />
              <div className="space-y-3">
                {logs.map((entry) => {
                  const meta = LOG_META[entry.actionType] ?? {
                    label: entry.actionType,
                    dot: "bg-muted-foreground",
                  };
                  return (
                    <div
                      key={entry.id}
                      className="relative flex gap-3 items-start"
                    >
                      <div
                        className={`absolute left-[-11px] mt-[5px] size-2.5 rounded-full border-2 border-background ${meta.dot}`}
                      />
                      <div className="min-w-0">
                        <div className="text-xs">
                          <span className="font-medium">{meta.label}</span>{" "}
                          <span className="text-muted-foreground">
                            by {entry.actorName}
                          </span>
                          <LogChangeSummary
                            actionType={entry.actionType}
                            metadata={entry.metadata}
                          />
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                          {fmtLogDate(entry.createdAt)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { Route };

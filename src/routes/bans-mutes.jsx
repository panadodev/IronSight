import { SteamRequiredGate } from "@/components/steam-required-gate";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert, Edit3, X, Plus } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

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

function fmtRemaining(expiresAt, revoked) {
  if (revoked) return "Revoked";
  if (!expiresAt) return "Permanent";
  const sec = expiresAt - Math.floor(Date.now() / 1000);
  if (sec <= 0) return "Expired";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m left`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h left`;
  return `${Math.floor(h / 24)}d left`;
}

const DURATION_PRESETS = [
  { label: "1 Hour", value: "60" },
  { label: "6 Hours", value: "360" },
  { label: "12 Hours", value: "720" },
  { label: "1 Day", value: "1440" },
  { label: "2 Days", value: "2880" },
  { label: "3 Days", value: "4320" },
  { label: "7 Days", value: "10080" },
  { label: "14 Days", value: "20160" },
  { label: "30 Days", value: "43200" },
  { label: "Permanent", value: "-1" },
];

const BAN_CATEGORIES = [
  "cheating",
  "teaming",
  "toxicity",
  "harassment",
  "ban_evasion",
  "other",
];
const MUTE_CATEGORIES = ["toxicity", "spam", "harassment", "mic_abuse"];

function computeExpiresAt(durationValue) {
  if (durationValue === "-1") return null;
  const minutes = parseInt(durationValue, 10);
  if (isNaN(minutes)) return null;
  return Math.floor(Date.now() / 1000) + minutes * 60;
}

function BansMutesPage() {
  const { selectedOrgIds, hasOrgPermission, orgs } = useAuth();
  const canAccess = selectedOrgIds.some(
    (id) => hasOrgPermission(id, "bans_manage") || hasOrgPermission(id, "bans_delete"),
  );

  const [tab, setTab] = useState("bans");
  const [bans, setBans] = useState([]);
  const [mutes, setMutes] = useState([]);
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const manageableOrgIds = useMemo(
    () =>
      selectedOrgIds.filter(
        (id) => hasOrgPermission(id, "bans_manage") || hasOrgPermission(id, "bans_delete"),
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
      setBans(
        banGroups.flat().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)),
      );
      setMutes(
        muteGroups.flat().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)),
      );
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
    if (res.ok) loadBans();
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
                {manageableOrgIds.length > 0 && (
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
                  return (
                    <div
                      key={r.banId}
                      className="grid grid-cols-[minmax(200px,2fr)_90px_1fr_120px_130px_110px_100px] gap-2 px-3 py-2 items-center text-xs hover:bg-surface/60"
                    >
                      <div className="min-w-0">
                        <div className="font-mono font-medium truncate">
                          {r.identifier}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
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
                          {org && (
                            <span className="text-[10px] font-mono text-muted-foreground">
                              {org.short}
                            </span>
                          )}
                        </div>
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
                          onClick={() => setEditing(r)}
                          className="size-7 inline-flex items-center justify-center rounded ring-1 ring-border hover:bg-surface"
                          title="Edit"
                        >
                          <Edit3 className="size-3" />
                        </button>
                        {!r.revoked && (
                          <button
                            onClick={() => revoke(r)}
                            className="size-7 inline-flex items-center justify-center rounded ring-1 ring-danger/40 text-danger hover:bg-danger/10"
                            title="Revoke"
                          >
                            <X className="size-3" />
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
          manageableOrgIds={manageableOrgIds}
          orgs={orgs}
          servers={servers}
        />

        <EditDialog
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadBans();
          }}
        />
      </div>
    </SteamRequiredGate>
  );
}

function NewBanDialog({
  open,
  onClose,
  onCreated,
  defaultActionType,
  manageableOrgIds,
  orgs,
  servers,
}) {
  const [orgId, setOrgId] = useState(manageableOrgIds[0] ?? "");
  const [actionType, setActionType] = useState(defaultActionType);
  const [identifierType, setIdentifierType] = useState("steam_id");
  const [identifier, setIdentifier] = useState("");
  const [selectedServerIds, setSelectedServerIds] = useState([]);
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("-1");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [rconResults, setRconResults] = useState(null);

  useEffect(() => {
    if (!open) return;
    setOrgId(manageableOrgIds[0] ?? "");
    setActionType(defaultActionType);
    setIdentifierType("steam_id");
    setIdentifier("");
    setSelectedServerIds([]);
    setCategory("");
    setReason("");
    setDuration("-1");
    setNote("");
    setError("");
    setRconResults(null);
  }, [open, manageableOrgIds, defaultActionType]);

  useEffect(() => {
    if (actionType === "mute") setIdentifierType("steam_id");
  }, [actionType]);

  const orgServers = useMemo(
    () => servers.filter((s) => s.ownerOrgId === orgId),
    [servers, orgId],
  );

  const toggleServer = (serverId) => {
    setSelectedServerIds((cur) =>
      cur.includes(serverId)
        ? cur.filter((id) => id !== serverId)
        : [...cur, serverId],
    );
  };

  const submit = async () => {
    if (!identifier.trim()) {
      setError("Identifier is required.");
      return;
    }
    if (!orgId) {
      setError("Select an organization.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/bans`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionType,
          identifier: identifier.trim(),
          identifierType,
          category: category || null,
          reason,
          note,
          expiresAt: computeExpiresAt(duration),
          serverIds: selectedServerIds,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Failed to issue ban.");
        return;
      }
      if (body.rconResults?.length) {
        setRconResults(body.rconResults);
      } else {
        onCreated();
      }
    } catch (err) {
      setError(err.message ?? "Unknown error.");
    } finally {
      setSubmitting(false);
    }
  };

  const categories = actionType === "mute" ? MUTE_CATEGORIES : BAN_CATEGORIES;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Issue {actionType === "mute" ? "Mute" : "Ban"}
          </DialogTitle>
          <DialogDescription>
            {actionType === "ban"
              ? "Ban a player by Steam ID or IP address across selected servers via RCON."
              : "Mute a player by Steam ID across selected servers via RCON."}
          </DialogDescription>
        </DialogHeader>

        {rconResults ? (
          <div className="space-y-3 py-2">
            <p className="text-sm font-medium">
              {actionType === "mute" ? "Mute" : "Ban"} issued. RCON results:
            </p>
            <div className="space-y-1.5">
              {rconResults.map((r) => (
                <div
                  key={r.serverId}
                  className={
                    "flex items-start justify-between px-3 py-2 rounded-md ring-1 text-xs " +
                    (r.ok
                      ? "ring-success/40 bg-success/10"
                      : "ring-danger/40 bg-danger/10")
                  }
                >
                  <span className="font-medium truncate">{r.serverName}</span>
                  <span className="text-[10px] font-mono ml-2 text-right shrink-0">
                    {r.ok ? r.response || "OK" : r.error}
                  </span>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button onClick={onCreated}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {manageableOrgIds.length > 1 && (
              <div className="space-y-1.5">
                <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Organization
                </Label>
                <Select value={orgId} onValueChange={setOrgId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select org" />
                  </SelectTrigger>
                  <SelectContent>
                    {manageableOrgIds.map((id) => {
                      const org = orgs.find((o) => o.id === id);
                      return (
                        <SelectItem key={id} value={id}>
                          {org?.name ?? id}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Action
              </Label>
              <div className="flex items-center gap-1 bg-surface/60 ring-1 ring-border rounded-md p-0.5 w-fit">
                {["ban", "mute"].map((t) => (
                  <button
                    key={t}
                    onClick={() => setActionType(t)}
                    className={
                      "px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors " +
                      (actionType === t
                        ? "bg-brand text-brand-foreground"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {actionType === "ban" && (
              <div className="space-y-1.5">
                <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Identifier Type
                </Label>
                <div className="flex items-center gap-1 bg-surface/60 ring-1 ring-border rounded-md p-0.5 w-fit">
                  {["steam_id", "ip"].map((t) => (
                    <button
                      key={t}
                      onClick={() => setIdentifierType(t)}
                      className={
                        "px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors " +
                        (identifierType === t
                          ? "bg-brand text-brand-foreground"
                          : "text-muted-foreground hover:text-foreground")
                      }
                    >
                      {t === "ip" ? "IP Address" : "Steam ID"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                {identifierType === "ip" ? "IP Address" : "Steam ID (64-bit)"}
              </Label>
              <Input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={
                  identifierType === "ip"
                    ? "e.g. 123.45.67.89"
                    : "e.g. 76561198000000000"
                }
                className="font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Target Servers
                {orgServers.length === 0 ? " (none configured)" : ""}
              </Label>
              {orgServers.length > 0 ? (
                <>
                  <div className="max-h-44 overflow-y-auto rounded-md ring-1 ring-border bg-surface/40 divide-y divide-border/60">
                    {orgServers.map((s) => {
                      const checked = selectedServerIds.includes(s.serverId);
                      return (
                        <button
                          key={s.serverId}
                          onClick={() => toggleServer(s.serverId)}
                          className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface/60 transition-colors"
                        >
                          <span
                            className={
                              "size-4 rounded-sm grid place-items-center ring-1 shrink-0 " +
                              (checked
                                ? "bg-brand ring-brand text-brand-foreground"
                                : "ring-border text-transparent")
                            }
                          >
                            <svg
                              className="size-3"
                              viewBox="0 0 12 12"
                              fill="none"
                            >
                              <polyline
                                points="2,6 5,9 10,3"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                          <span className="text-xs font-medium flex-1 truncate">
                            {s.serverName}
                          </span>
                          {!s.rconConfigured && (
                            <span className="text-[9px] font-mono text-warning shrink-0">
                              No RCON
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() =>
                        setSelectedServerIds(orgServers.map((s) => s.serverId))
                      }
                      className="text-[10px] font-semibold text-brand hover:underline"
                    >
                      Select all
                    </button>
                    <button
                      onClick={() => setSelectedServerIds([])}
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      Clear
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No servers registered for this org. The ban will be saved but
                  not pushed via RCON.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Category
              </Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c} value={c} className="capitalize">
                      {c.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Reason
              </Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason shown to the player…"
              />
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
                  {DURATION_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                {duration === "-1"
                  ? "This ban will never expire."
                  : `Expires in ${fmtRemaining(computeExpiresAt(duration), false)}.`}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Note (internal)
              </Label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder="Internal notes, not shown to the player…"
              />
            </div>

            {error && (
              <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={submitting}>
                {submitting
                  ? "Issuing…"
                  : `Issue ${actionType === "mute" ? "Mute" : "Ban"}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ record, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [duration, setDuration] = useState("keep");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (record) {
      setReason(record.reason);
      setNote(record.note);
      setDuration("keep");
      setError("");
    }
  }, [record]);

  if (!record) return null;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const patch = { reason, note };
      if (duration !== "keep") {
        patch.expiresAt = computeExpiresAt(duration);
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
      <DialogContent className="max-w-xl">
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
              Currently: {fmtRemaining(record.expiresAt, record.revoked)}
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

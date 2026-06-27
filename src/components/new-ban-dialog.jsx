import { useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { MediaPicker } from "@/components/media-picker";
import { Film, Image, FileIcon, X, ImagePlus } from "lucide-react";

export const DURATION_PRESETS = [
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

export const BAN_CATEGORIES = [
  "cheating",
  "teaming",
  "toxicity",
  "harassment",
  "ban_evasion",
  "other",
];

export const MUTE_CATEGORIES = ["toxicity", "spam", "harassment", "mic_abuse"];

export function computeExpiresAt(durationValue, fromUnix = null) {
  if (durationValue === "-1") return null;
  const minutes = parseInt(durationValue, 10);
  if (isNaN(minutes)) return null;
  const base = fromUnix ?? Math.floor(Date.now() / 1000);
  return base + minutes * 60;
}

export function fmtRemaining(expiresAt, revoked) {
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

export function NewBanDialog({
  open,
  onClose,
  onCreated,
  defaultActionType = "ban",
  defaultIdentifier = "",
  manageableOrgIds,
  orgs,
  servers: serversProp,
  hasOrgPermission,
}) {
  const { orgBanConfigs, orgMuteConfigs, loadOrgBanConfigs } = useAuth();
  const [orgId, setOrgId] = useState(manageableOrgIds[0] ?? "");
  const [actionType, setActionType] = useState(defaultActionType);
  const [identifierType, setIdentifierType] = useState("steam_id");
  const [identifier, setIdentifier] = useState(defaultIdentifier);
  const [selectedServerIds, setSelectedServerIds] = useState([]);
  const [category, setCategory] = useState("");
  const [reasonId, setReasonId] = useState("__custom__");
  const [customReason, setCustomReason] = useState("");
  const [duration, setDuration] = useState("-1");
  const [note, setNote] = useState("");
  const [noteEdited, setNoteEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [rconResults, setRconResults] = useState(null);
  const [servers, setServers] = useState(serversProp ?? []);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [linkedMediaIds, setLinkedMediaIds] = useState([]);
  const [linkedMediaItems, setLinkedMediaItems] = useState([]);

  useEffect(() => {
    if (!open) return;
    if (serversProp !== undefined) {
      setServers(serversProp);
      return;
    }
    fetch("/api/servers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { servers: [] }))
      .then((body) => setServers(body.servers ?? []))
      .catch(() => setServers([]));
  }, [open, serversProp]);

  const canIssueIp = orgId ? hasOrgPermission(orgId, "bans_ip") : false;

  useEffect(() => {
    if (!open || !orgId) return;
    if (orgBanConfigs[orgId] === undefined) loadOrgBanConfigs(orgId);
  }, [open, orgId, orgBanConfigs, loadOrgBanConfigs]);

  useEffect(() => {
    if (!open) return;
    setOrgId(manageableOrgIds[0] ?? "");
    setActionType(defaultActionType);
    setIdentifierType("steam_id");
    setIdentifier(defaultIdentifier);
    setSelectedServerIds([]);
    setCategory("");
    setReasonId("__custom__");
    setCustomReason("");
    setDuration("-1");
    setNote("");
    setNoteEdited(false);
    setError("");
    setRconResults(null);
    setLinkedMediaIds([]);
    setLinkedMediaItems([]);
  }, [open, manageableOrgIds, defaultActionType, defaultIdentifier]);

  useEffect(() => {
    if (actionType === "mute") setIdentifierType("steam_id");
  }, [actionType]);

  useEffect(() => {
    if (!canIssueIp && identifierType === "ip") setIdentifierType("steam_id");
  }, [canIssueIp, identifierType]);

  const activeConfig = useMemo(() => {
    if (actionType === "mute") return orgMuteConfigs[orgId] ?? null;
    if (!category || category === "other") return null;
    return orgBanConfigs[orgId]?.[category] ?? null;
  }, [actionType, category, orgId, orgBanConfigs, orgMuteConfigs]);

  const reasonOptions = activeConfig?.reasons ?? [];
  const noteFormat = activeConfig?.noteFormat ?? "";

  useEffect(() => {
    setReasonId(reasonOptions[0]?.id ?? "__custom__");
    setCustomReason("");
    if (!noteEdited) setNote(noteFormat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, actionType, activeConfig]);

  const reason = useMemo(() => {
    if (reasonId === "__custom__") return customReason.trim();
    return reasonOptions.find((r) => r.id === reasonId)?.label ?? "";
  }, [reasonId, customReason, reasonOptions]);

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
    if (!reason.trim()) {
      setError("A reason is required.");
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
          mediaIds: linkedMediaIds,
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
    <>
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

            {actionType === "ban" && canIssueIp && (
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
                {identifierType === "ip" && (
                  <p className="text-[10px] text-warning">
                    IP ban: anyone who later connects from this IP is
                    automatically given a linked ban record and removed.
                  </p>
                )}
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
              <select
                value={reasonId}
                onChange={(e) => setReasonId(e.target.value)}
                className="w-full bg-surface border border-border rounded px-2 py-2 text-sm"
              >
                {reasonOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
                <option value="__custom__">Custom reason…</option>
              </select>
              {reasonId === "__custom__" && (
                <Input
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                  placeholder="Reason shown to the player…"
                  autoFocus
                />
              )}
              {reasonOptions.length === 0 && category && category !== "other" && (
                <p className="text-[10px] text-muted-foreground italic">
                  No preset reasons for this category — add them in Manage org →
                  Ban configs, or enter a custom reason.
                </p>
              )}
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
                onChange={(e) => {
                  setNote(e.target.value);
                  setNoteEdited(true);
                }}
                rows={3}
                className="font-mono text-xs"
                placeholder="Internal notes, not shown to the player…"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Evidence
              </Label>
              {linkedMediaItems.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-1.5">
                  {linkedMediaItems.map((item) => (
                    <div
                      key={item.mediaId}
                      className="relative rounded-md ring-1 ring-border overflow-hidden w-16 h-16 bg-black/20 flex items-center justify-center shrink-0"
                    >
                      {item.fileType === "image" ? (
                        <img src={item.url} alt={item.filename} className="w-full h-full object-cover" />
                      ) : item.fileType === "video" ? (
                        <Film className="size-5 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-5 text-muted-foreground" />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setLinkedMediaIds((ids) => ids.filter((id) => id !== item.mediaId));
                          setLinkedMediaItems((items) => items.filter((i) => i.mediaId !== item.mediaId));
                        }}
                        className="absolute top-0.5 right-0.5 size-4 rounded-full bg-black/70 flex items-center justify-center text-white hover:bg-black"
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setMediaPickerOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md ring-1 ring-border bg-surface/40 hover:bg-surface/70 transition-colors text-muted-foreground hover:text-foreground"
              >
                <ImagePlus className="size-3.5" />
                {linkedMediaIds.length > 0
                  ? `${linkedMediaIds.length} item${linkedMediaIds.length !== 1 ? "s" : ""} linked — change`
                  : "Link evidence from gallery"}
              </button>
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

    {mediaPickerOpen && (
      <MediaPicker
        open={mediaPickerOpen}
        onClose={() => setMediaPickerOpen(false)}
        orgId={orgId}
        selectedIds={linkedMediaIds}
        onConfirm={(ids, items) => {
          setLinkedMediaIds(ids);
          setLinkedMediaItems(items);
        }}
      />
    )}
  </>
  );
}

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute } from "@tanstack/react-router";
import {
  Hash,
  RefreshCw,
  VolumeX,
  Clock,
  UserMinus,
  Ban,
  Volume2,
  ShieldOff,
  UserCheck,
  Paperclip,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/discord-mod")({
  head: () => ({ meta: [{ title: "Discord Mod — IronSight" }] }),
  component: DiscordModPage,
});

const TIMEOUT_PRESETS = [
  { label: "60 seconds", value: 60 },
  { label: "5 minutes", value: 300 },
  { label: "10 minutes", value: 600 },
  { label: "1 hour", value: 3600 },
  { label: "6 hours", value: 21600 },
  { label: "12 hours", value: 43200 },
  { label: "1 day", value: 86400 },
  { label: "7 days", value: 604800 },
  { label: "28 days", value: 2419200 },
];

function fmtTs(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString();
}

function fmtAgo(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ActionLabel({ type }) {
  const map = {
    TIMEOUT: { label: "Timeout", cls: "text-amber-400" },
    UNTIMEOUT: { label: "Untimeout", cls: "text-emerald-400" },
    MUTE: { label: "Mute", cls: "text-amber-400" },
    UNMUTE: { label: "Unmute", cls: "text-emerald-400" },
    KICK: { label: "Kick", cls: "text-orange-400" },
    BAN: { label: "Ban", cls: "text-danger" },
    UNBAN: { label: "Unban", cls: "text-emerald-400" },
  };
  const { label, cls } = map[type] ?? { label: type, cls: "text-muted-foreground" };
  return <span className={`font-semibold text-xs ${cls}`}>{label}</span>;
}

function DiscordModPage() {
  const { adminableOrgIds, orgs } = useAuth();

  const adminOrgs = useMemo(
    () => orgs.filter((o) => adminableOrgIds.includes(o.id)),
    [orgs, adminableOrgIds],
  );

  const [orgId, setOrgId] = useState(() => adminOrgs[0]?.id ?? "");
  const [tab, setTab] = useState("messages");

  // channels + messages
  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // mod log
  const [modLog, setModLog] = useState([]);
  const [loadingModLog, setLoadingModLog] = useState(false);

  // action dialog
  const [actionTarget, setActionTarget] = useState(null); // { discordId, username }
  const [actionType, setActionType] = useState("timeout");
  const [actionReason, setActionReason] = useState("");
  const [actionDuration, setActionDuration] = useState(3600);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (adminOrgs.length > 0 && !orgId) setOrgId(adminOrgs[0].id);
  }, [adminOrgs, orgId]);

  const fetchChannels = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/discord/channels`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const data = await res.json();
    setChannels(data.channels ?? []);
    if (!selectedChannel && data.channels?.length > 0) {
      setSelectedChannel(data.channels[0].id);
    }
  }, [orgId, selectedChannel]);

  const fetchMessages = useCallback(async () => {
    if (!orgId || !selectedChannel) return;
    setLoadingMessages(true);
    try {
      const url = `/api/orgs/${encodeURIComponent(orgId)}/discord/messages?channel_id=${encodeURIComponent(selectedChannel)}&limit=100`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages ?? []);
    } finally {
      setLoadingMessages(false);
    }
  }, [orgId, selectedChannel]);

  const fetchModLog = useCallback(async () => {
    if (!orgId) return;
    setLoadingModLog(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/discord/mod-log?limit=100`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const data = await res.json();
      setModLog(data.entries ?? []);
    } finally {
      setLoadingModLog(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (orgId) {
      fetchChannels();
      setSelectedChannel(null);
      setMessages([]);
    }
  }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedChannel) fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    if (tab === "modlog") fetchModLog();
  }, [tab, fetchModLog]);

  const handleSync = async () => {
    if (!orgId || syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/discord/sync`,
        { method: "POST", credentials: "include" },
      );
      const data = await res.json();
      if (!res.ok) {
        setSyncResult({ error: data.error ?? "Sync failed" });
      } else {
        setSyncResult({ totalSynced: data.totalSynced });
        await fetchChannels();
        if (selectedChannel) await fetchMessages();
      }
    } finally {
      setSyncing(false);
    }
  };

  const openAction = (discordId, username, defaultAction = "timeout") => {
    setActionTarget({ discordId, username });
    setActionType(defaultAction);
    setActionReason("");
    setActionDuration(3600);
    setActionError("");
  };

  const submitAction = async () => {
    if (!actionTarget || !orgId) return;
    setActionLoading(true);
    setActionError("");
    try {
      const body = {
        action: actionType,
        targetDiscordId: actionTarget.discordId,
        targetUsername: actionTarget.username,
        reason: actionReason || null,
        durationSeconds: actionType === "timeout" ? actionDuration : undefined,
      };
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/discord/mod`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? "Action failed");
        return;
      }
      setActionTarget(null);
      if (tab === "modlog") fetchModLog();
    } finally {
      setActionLoading(false);
    }
  };

  const needsBot = !channels.length && !syncing;

  if (adminableOrgIds.length === 0) {
    return (
      <div className="flex min-h-screen bg-background">
        <SiteNav />
        <main className="ml-56 flex-1 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">Admin access required.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <SiteNav />
      <main className="ml-56 flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="border-b border-border px-6 py-4 flex items-center gap-4 shrink-0">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-foreground">Discord Moderation</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Monitor messages and moderate members across your Discord server.
            </p>
          </div>

          {/* Org picker */}
          {adminOrgs.length > 1 && (
            <Select value={orgId} onValueChange={setOrgId}>
              <SelectTrigger className="w-40 h-8 text-xs">
                <SelectValue placeholder="Select org" />
              </SelectTrigger>
              <SelectContent>
                {adminOrgs.map((o) => (
                  <SelectItem key={o.id} value={o.id} className="text-xs">
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={handleSync}
            disabled={syncing || !orgId}
            className="gap-1.5 h-8"
          >
            <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync"}
          </Button>
        </div>

        {syncResult && (
          <div
            className={`mx-6 mt-3 px-3 py-2 rounded text-xs ring-1 ${
              syncResult.error
                ? "ring-danger/40 bg-danger/10 text-danger"
                : "ring-success/40 bg-success/10 text-success"
            }`}
          >
            {syncResult.error
              ? `Sync error: ${syncResult.error}`
              : `Synced ${syncResult.totalSynced} new message${syncResult.totalSynced !== 1 ? "s" : ""}.`}
          </div>
        )}

        {/* Tabs */}
        <div className="border-b border-border px-6 shrink-0">
          <div className="flex gap-1 -mb-px">
            {["messages", "modlog"].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                  tab === t
                    ? "border-brand text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "messages" ? "Messages" : "Mod Log"}
              </button>
            ))}
          </div>
        </div>

        {tab === "messages" && (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Channel list */}
            <div className="w-48 shrink-0 border-r border-border overflow-y-auto py-2">
              <div className="px-3 mb-1">
                <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                  Channels
                </span>
              </div>
              {needsBot && !syncing && (
                <p className="px-3 text-xs text-muted-foreground">
                  Click Sync to load channels.
                </p>
              )}
              {channels.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => setSelectedChannel(ch.id)}
                  className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-left transition-colors ${
                    selectedChannel === ch.id
                      ? "bg-surface text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-surface/50"
                  }`}
                >
                  <Hash className="size-3 shrink-0" />
                  <span className="truncate">{ch.name}</span>
                </button>
              ))}
            </div>

            {/* Message feed */}
            <div className="flex-1 overflow-y-auto">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-32">
                  <span className="text-xs text-muted-foreground">Loading…</span>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-32">
                  <p className="text-xs text-muted-foreground">
                    {selectedChannel ? "No messages — sync to fetch." : "Select a channel."}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className="px-5 py-3 hover:bg-surface/30 transition-colors group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-foreground">
                              {msg.authorUsername}
                            </span>
                            <span className="text-[10px] font-mono text-muted-foreground">
                              {msg.authorDiscordId}
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              {fmtAgo(msg.createdAt)}
                            </span>
                          </div>
                          <p className="text-sm text-foreground/90 mt-0.5 break-words whitespace-pre-wrap">
                            {msg.content || <em className="text-muted-foreground">[no text]</em>}
                          </p>
                          {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
                            <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                              <Paperclip className="size-3" />
                              {msg.attachments.length} attachment{msg.attachments.length !== 1 ? "s" : ""}
                            </div>
                          )}
                        </div>

                        {/* Action buttons — appear on hover */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button
                            onClick={() => openAction(msg.authorDiscordId, msg.authorUsername, "timeout")}
                            title="Timeout"
                            className="p-1 rounded hover:bg-amber-500/10 text-muted-foreground hover:text-amber-400 transition-colors"
                          >
                            <Clock className="size-3.5" />
                          </button>
                          <button
                            onClick={() => openAction(msg.authorDiscordId, msg.authorUsername, "mute")}
                            title="Voice Mute"
                            className="p-1 rounded hover:bg-amber-500/10 text-muted-foreground hover:text-amber-400 transition-colors"
                          >
                            <VolumeX className="size-3.5" />
                          </button>
                          <button
                            onClick={() => openAction(msg.authorDiscordId, msg.authorUsername, "kick")}
                            title="Kick"
                            className="p-1 rounded hover:bg-orange-500/10 text-muted-foreground hover:text-orange-400 transition-colors"
                          >
                            <UserMinus className="size-3.5" />
                          </button>
                          <button
                            onClick={() => openAction(msg.authorDiscordId, msg.authorUsername, "ban")}
                            title="Ban"
                            className="p-1 rounded hover:bg-danger/10 text-muted-foreground hover:text-danger transition-colors"
                          >
                            <Ban className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "modlog" && (
          <div className="flex-1 overflow-y-auto p-6">
            {loadingModLog ? (
              <div className="flex items-center justify-center h-32">
                <span className="text-xs text-muted-foreground">Loading…</span>
              </div>
            ) : modLog.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <p className="text-xs text-muted-foreground">No moderation actions recorded.</p>
              </div>
            ) : (
              <div className="space-y-0 rounded-md ring-1 ring-border overflow-hidden">
                <div className="grid grid-cols-[1fr_80px_1fr_120px_140px] gap-3 px-4 py-2 bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground border-b border-border">
                  <span>Target</span>
                  <span>Action</span>
                  <span>Reason</span>
                  <span>By</span>
                  <span>When</span>
                </div>
                {modLog.map((entry) => (
                  <div
                    key={entry.id}
                    className="grid grid-cols-[1fr_80px_1fr_120px_140px] gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface/30 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {entry.targetUsername || entry.targetDiscordId}
                      </div>
                      <div className="text-[10px] font-mono text-muted-foreground truncate">
                        {entry.targetDiscordId}
                      </div>
                    </div>
                    <div className="flex items-center">
                      <ActionLabel type={entry.actionType} />
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {entry.reason || <span className="italic">—</span>}
                      {entry.durationSeconds && (
                        <span className="ml-1 text-[10px] font-mono">
                          ({Math.round(entry.durationSeconds / 3600)}h)
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-foreground truncate">{entry.actorUsername}</div>
                    <div className="text-xs text-muted-foreground" title={fmtTs(entry.createdAt)}>
                      {fmtAgo(entry.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Mod action dialog */}
      <Dialog open={!!actionTarget} onOpenChange={(o) => !o && setActionTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Moderate member</DialogTitle>
            <DialogDescription>
              {actionTarget?.username} ({actionTarget?.discordId})
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label>Action</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { value: "timeout", label: "Timeout", icon: Clock },
                  { value: "untimeout", label: "Untimeout", icon: ShieldOff },
                  { value: "mute", label: "Voice Mute", icon: VolumeX },
                  { value: "unmute", label: "Unmute", icon: Volume2 },
                  { value: "kick", label: "Kick", icon: UserMinus },
                  { value: "ban", label: "Ban", icon: Ban },
                  { value: "unban", label: "Unban", icon: UserCheck },
                ].map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    onClick={() => setActionType(value)}
                    className={`flex items-center gap-1.5 px-2.5 py-2 rounded ring-1 text-xs font-medium transition-colors ${
                      actionType === value
                        ? "ring-brand bg-brand/10 text-brand"
                        : "ring-border text-muted-foreground hover:text-foreground hover:bg-surface/50"
                    }`}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {actionType === "timeout" && (
              <div className="space-y-1.5">
                <Label>Duration</Label>
                <Select
                  value={String(actionDuration)}
                  onValueChange={(v) => setActionDuration(Number(v))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEOUT_PRESETS.map((p) => (
                      <SelectItem key={p.value} value={String(p.value)} className="text-xs">
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Reason (optional)</Label>
              <Textarea
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                placeholder="Reason for this action…"
                rows={2}
                className="text-sm resize-none"
              />
            </div>

            {actionError && (
              <p className="text-xs text-danger">{actionError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setActionTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitAction}
              disabled={actionLoading}
              variant={actionType === "ban" || actionType === "kick" ? "destructive" : "default"}
            >
              {actionLoading ? "Applying…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

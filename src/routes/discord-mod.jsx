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
import { useTimezone } from "@/lib/timezone-store";
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
  Search,
  Users,
  ShieldAlert,
  Download,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

function fmtTs(unix, tz) {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleString(undefined, tz ? { timeZone: tz } : {});
}

function fmtAgo(unix) {
  if (!unix) return "";
  const m = Math.floor((Date.now() / 1000 - unix) / 60);
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
  const { label, cls } = map[type] ?? {
    label: type,
    cls: "text-muted-foreground",
  };
  return <span className={`font-semibold text-xs ${cls}`}>{label}</span>;
}

function MemberAvatar({ avatar, username, size = 7 }) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={username}
        className={`size-${size} rounded-full shrink-0 object-cover`}
      />
    );
  }
  return (
    <div
      className={`size-${size} rounded-full bg-[#5865F2]/20 text-[#5865F2] flex items-center justify-center shrink-0 text-[10px] font-bold uppercase`}
    >
      {username?.[0] ?? "?"}
    </div>
  );
}

function ActionButtons({ discordId, username, onAction, compact = false }) {
  const cls = compact
    ? "p-1 rounded text-muted-foreground transition-colors"
    : "p-1.5 rounded text-muted-foreground transition-colors";
  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={() => onAction(discordId, username, "timeout")}
        title="Timeout"
        className={`${cls} hover:bg-amber-500/10 hover:text-amber-400`}
      >
        <Clock className="size-3.5" />
      </button>
      <button
        onClick={() => onAction(discordId, username, "mute")}
        title="Voice Mute"
        className={`${cls} hover:bg-amber-500/10 hover:text-amber-400`}
      >
        <VolumeX className="size-3.5" />
      </button>
      <button
        onClick={() => onAction(discordId, username, "kick")}
        title="Kick"
        className={`${cls} hover:bg-orange-500/10 hover:text-orange-400`}
      >
        <UserMinus className="size-3.5" />
      </button>
      <button
        onClick={() => onAction(discordId, username, "ban")}
        title="Ban"
        className={`${cls} hover:bg-danger/10 hover:text-danger`}
      >
        <Ban className="size-3.5" />
      </button>
    </div>
  );
}

function DiscordModPage() {
  const { hasOrgPermission, orgs } = useAuth();
  const tz = useTimezone();

  const adminOrgs = useMemo(
    () => orgs.filter((o) => hasOrgPermission(o.id, "discord_mod")),
    [orgs, hasOrgPermission],
  );

  const [orgId, setOrgId] = useState(() => adminOrgs[0]?.id ?? "");
  const [tab, setTab] = useState("messages");

  // ── Messages tab ──────────────────────────────────────────────────────────
  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // ── Members tab ───────────────────────────────────────────────────────────
  const [memberQuery, setMemberQuery] = useState("");
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const memberSearchRef = useRef(null);
  const sentinelRef = useRef(null);
  const messagesScrollRef = useRef(null);
  const oldestCreatedAtRef = useRef(null);
  const newestCreatedAtRef = useRef(null);
  const loadingMoreRef = useRef(false);

  // ── Bans tab ──────────────────────────────────────────────────────────────
  const [bans, setBans] = useState([]);
  const [bansLoading, setBansLoading] = useState(false);
  const [banSyncing, setBanSyncing] = useState(false);
  const [banSyncResult, setBanSyncResult] = useState(null);
  const [banFilter, setBanFilter] = useState("");
  const [unbanBusy, setUnbanBusy] = useState({});
  const [unbanError, setUnbanError] = useState(null);

  // ── Mod Log tab ───────────────────────────────────────────────────────────
  const [modLog, setModLog] = useState([]);
  const [loadingModLog, setLoadingModLog] = useState(false);

  // ── Shared action dialog ──────────────────────────────────────────────────
  const [actionTarget, setActionTarget] = useState(null);
  const [actionType, setActionType] = useState("timeout");
  const [actionReason, setActionReason] = useState("");
  const [actionDuration, setActionDuration] = useState(3600);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (adminOrgs.length > 0 && !orgId) setOrgId(adminOrgs[0].id);
  }, [adminOrgs, orgId]);

  // ── Data fetchers ─────────────────────────────────────────────────────────
  const fetchChannels = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/discord/channels`,
      { credentials: "include" },
    );
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
      const url = `/api/orgs/${encodeURIComponent(orgId)}/discord/messages?channel_id=${encodeURIComponent(selectedChannel)}&limit=30`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const msgs = data.messages ?? [];
      setMessages(msgs);
      setHasMore(msgs.length === 30);
    } finally {
      setLoadingMessages(false);
    }
  }, [orgId, selectedChannel]);

  const loadMoreMessages = useCallback(async () => {
    if (!orgId || !selectedChannel || loadingMoreRef.current) return;
    const oldest = oldestCreatedAtRef.current;
    if (!oldest) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const url = `/api/orgs/${encodeURIComponent(orgId)}/discord/messages?channel_id=${encodeURIComponent(selectedChannel)}&limit=30&before=${encodeURIComponent(oldest)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const more = data.messages ?? [];
      setMessages((prev) => [...prev, ...more]);
      setHasMore(more.length === 30);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [orgId, selectedChannel]);

  const pollNewMessages = useCallback(async () => {
    if (!orgId || !selectedChannel) return;
    const after = newestCreatedAtRef.current;
    if (!after) return;
    try {
      const url = `/api/orgs/${encodeURIComponent(orgId)}/discord/messages?channel_id=${encodeURIComponent(selectedChannel)}&limit=30&after=${encodeURIComponent(after)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const newMsgs = data.messages ?? [];
      if (newMsgs.length > 0) {
        setMessages((prev) => [...newMsgs, ...prev]);
      }
    } catch {
      // ignore
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

  const fetchBans = useCallback(async () => {
    if (!orgId) return;
    setBansLoading(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/discord/bans`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const data = await res.json();
      setBans(data.bans ?? []);
    } finally {
      setBansLoading(false);
    }
  }, [orgId]);

  const searchMembers = useCallback(async () => {
    const q = memberQuery.trim();
    if (!orgId || !q) return;
    setMembersLoading(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/discord/members?query=${encodeURIComponent(q)}`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const data = await res.json();
      setMembers(data.members ?? []);
    } finally {
      setMembersLoading(false);
    }
  }, [orgId, memberQuery]);

  // ── Effect hooks ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (orgId) {
      setChannels([]);
      setSelectedChannel(null);
      setMessages([]);
      setHasMore(false);
      setMembers([]);
      setBans([]);
      setModLog([]);
      setSyncResult(null);
      setBanSyncResult(null);
      setUnbanError(null);
      setUnbanBusy({});
      fetchChannels();
    }
  }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedChannel) fetchMessages();
  }, [fetchMessages]);

  // Sync cursor refs whenever messages change
  useEffect(() => {
    if (messages.length > 0) {
      newestCreatedAtRef.current = messages[0].createdAt;
      oldestCreatedAtRef.current = messages[messages.length - 1].createdAt;
    }
  }, [messages]);

  // Poll for new messages every 15 seconds (only fetches newer than what we have)
  useEffect(() => {
    if (tab !== "messages" || !selectedChannel) return;
    const timer = setInterval(pollNewMessages, 15000);
    return () => clearInterval(timer);
  }, [tab, selectedChannel, pollNewMessages]);

  // Infinite scroll: observe sentinel at bottom of message list
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = messagesScrollRef.current;
    if (!sentinel || !container || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreMessages();
      },
      { root: container, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMoreMessages]);

  useEffect(() => {
    if (tab === "modlog") fetchModLog();
    if (tab === "bans") fetchBans();
    if (tab === "members") memberSearchRef.current?.focus();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Action handlers ───────────────────────────────────────────────────────
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

  const handleBanSync = async () => {
    if (!orgId || banSyncing) return;
    setBanSyncing(true);
    setBanSyncResult(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/discord/bans/sync`,
        { method: "POST", credentials: "include" },
      );
      const data = await res.json();
      if (!res.ok) {
        setBanSyncResult({ error: data.error ?? "Sync failed" });
      } else {
        setBanSyncResult({ synced: data.synced });
        await fetchBans();
        if (tab === "modlog") await fetchModLog();
      }
    } finally {
      setBanSyncing(false);
    }
  };

  const doUnban = async (discordUserId, username) => {
    setUnbanBusy((p) => ({ ...p, [discordUserId]: true }));
    setUnbanError(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/discord/mod`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "unban",
            targetDiscordId: discordUserId,
            targetUsername: username,
            reason: null,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUnbanError(data.error ?? "Unban failed");
        return;
      }
      await fetchBans();
    } catch {
      setUnbanError("Network error — could not reach server");
    } finally {
      setUnbanBusy((p) => ({ ...p, [discordUserId]: false }));
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
    const targetId = actionTarget.discordId;
    setActionLoading(true);
    setActionError("");
    try {
      const body = {
        action: actionType,
        targetDiscordId: targetId,
        targetUsername: actionTarget.username,
        reason: actionReason || null,
        durationSeconds: actionType === "timeout" ? actionDuration : undefined,
      };
      let res;
      try {
        res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/discord/mod`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
      } catch {
        setActionError("Network error — please try again");
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(data.error ?? `Action failed (${res.status})`);
        return;
      }
      setActionTarget(null);
      if (actionType === "unban") {
        setBans((prev) => prev.filter((b) => b.discordUserId !== targetId));
      }
      if (tab === "modlog") fetchModLog();
      if (tab === "bans") fetchBans();
    } finally {
      setActionLoading(false);
    }
  };

  // ── Derived state ─────────────────────────────────────────────────────────
  const filteredBans = useMemo(() => {
    if (!banFilter.trim()) return bans;
    const q = banFilter.toLowerCase();
    return bans.filter(
      (b) =>
        b.username?.toLowerCase().includes(q) ||
        b.discordUserId?.includes(q) ||
        b.reason?.toLowerCase().includes(q),
    );
  }, [bans, banFilter]);

  if (adminOrgs.length === 0) {
    return (
      <div className="flex min-h-screen bg-background">
        <SiteNav />
        <main className="ml-56 flex-1 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">
            Discord Moderation permission required.
          </p>
        </main>
      </div>
    );
  }

  const TABS = [
    { id: "messages", label: "Messages", icon: Hash },
    { id: "members", label: "Members", icon: Users },
    { id: "bans", label: "Bans", icon: ShieldAlert },
    { id: "modlog", label: "Mod Log", icon: ShieldOff },
  ];

  return (
    <div className="flex min-h-screen bg-background">
      <SiteNav />
      <main className="ml-56 flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="border-b border-border px-6 py-4 flex items-center gap-4 shrink-0">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-foreground">
              Discord Moderation
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Monitor messages and moderate members across your Discord server.
            </p>
          </div>

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

          {tab === "messages" && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleSync}
              disabled={syncing || !orgId}
              className="gap-1.5 h-8"
            >
              <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing…" : "Sync Messages"}
            </Button>
          )}

          {tab === "bans" && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleBanSync}
              disabled={banSyncing || !orgId}
              className="gap-1.5 h-8"
            >
              <Download className={`size-3.5 ${banSyncing ? "animate-spin" : ""}`} />
              {banSyncing ? "Syncing…" : "Sync from Discord"}
            </Button>
          )}
        </div>

        {/* Notification banners */}
        {tab === "messages" && syncResult && (
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

        {tab === "bans" && banSyncResult && (
          <div
            className={`mx-6 mt-3 px-3 py-2 rounded text-xs ring-1 ${
              banSyncResult.error
                ? "ring-danger/40 bg-danger/10 text-danger"
                : "ring-success/40 bg-success/10 text-success"
            }`}
          >
            {banSyncResult.error
              ? `Sync error: ${banSyncResult.error}`
              : banSyncResult.synced === 0
                ? "All Discord bans are already logged."
                : `Imported ${banSyncResult.synced} external ban${banSyncResult.synced !== 1 ? "s" : ""} from Discord.`}
          </div>
        )}

        {/* Tabs */}
        <div className="border-b border-border px-6 shrink-0">
          <div className="flex gap-1 -mb-px">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                  tab === id
                    ? "border-brand text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" />
                {label}
                {id === "bans" && bans.length > 0 && (
                  <span className="ml-0.5 px-1 py-0 rounded text-[9px] font-mono bg-danger/15 text-danger">
                    {bans.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* ── Messages ── */}
        {tab === "messages" && (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="w-48 shrink-0 border-r border-border overflow-y-auto py-2">
              <div className="px-3 mb-1">
                <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                  Channels
                </span>
              </div>
              {channels.length === 0 && (
                <p className="px-3 text-xs text-muted-foreground">
                  No channels yet — messages appear as the bot captures them.
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

            <div ref={messagesScrollRef} className="flex-1 overflow-y-auto">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-32">
                  <span className="text-xs text-muted-foreground">Loading…</span>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-32">
                  <p className="text-xs text-muted-foreground">
                    {selectedChannel
                      ? "No messages captured yet."
                      : "Select a channel."}
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
                            {msg.content || (
                              <em className="text-muted-foreground">[no text]</em>
                            )}
                          </p>
                          {Array.isArray(msg.attachments) &&
                            msg.attachments.length > 0 && (
                              <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                                <Paperclip className="size-3" />
                                {msg.attachments.length} attachment
                                {msg.attachments.length !== 1 ? "s" : ""}
                              </div>
                            )}
                        </div>
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <ActionButtons
                            discordId={msg.authorDiscordId}
                            username={msg.authorUsername}
                            onAction={openAction}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <div
                    ref={sentinelRef}
                    className="py-4 flex items-center justify-center"
                  >
                    {loadingMore ? (
                      <span className="text-xs text-muted-foreground">Loading…</span>
                    ) : !hasMore && messages.length > 0 ? (
                      <span className="text-[10px] text-muted-foreground/40">All messages loaded</span>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Members ── */}
        {tab === "members" && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden p-6 gap-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  ref={memberSearchRef}
                  placeholder="Search by username…"
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && searchMembers()}
                  className="pl-8 text-sm h-9"
                />
              </div>
              <Button
                size="sm"
                onClick={searchMembers}
                disabled={membersLoading || !memberQuery.trim()}
                className="h-9"
              >
                {membersLoading ? "Searching…" : "Search"}
              </Button>
            </div>

            {members.length === 0 && !membersLoading && (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-xs text-muted-foreground">
                  {memberQuery.trim()
                    ? "No members found."
                    : "Search for a Discord member by username."}
                </p>
              </div>
            )}

            {members.length > 0 && (
              <div className="rounded-md ring-1 ring-border overflow-hidden">
                <div className="grid grid-cols-[1fr_160px_auto] gap-3 px-4 py-2 bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground border-b border-border">
                  <span>Member</span>
                  <span>Discord ID</span>
                  <span>Actions</span>
                </div>
                {members.map((m) => (
                  <div
                    key={m.discordId}
                    className="grid grid-cols-[1fr_160px_auto] gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface/30 transition-colors items-center"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <MemberAvatar
                        avatar={m.avatar}
                        username={m.username}
                        size={7}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">
                          {m.username}
                        </div>
                        {m.nickname && m.nickname !== m.username && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            aka {m.nickname}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-[11px] font-mono text-muted-foreground">
                      {m.discordId}
                    </div>
                    <ActionButtons
                      discordId={m.discordId}
                      username={m.username}
                      onAction={openAction}
                      compact
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Bans ── */}
        {tab === "bans" && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden p-6 gap-4">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Filter by username, ID, or reason…"
                  value={banFilter}
                  onChange={(e) => setBanFilter(e.target.value)}
                  className="pl-8 text-sm h-9"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={fetchBans}
                disabled={bansLoading}
                className="gap-1.5 h-9 shrink-0"
              >
                <RefreshCw className={`size-3.5 ${bansLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>

            {bansLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-xs text-muted-foreground">
                  Loading bans from Discord…
                </span>
              </div>
            ) : filteredBans.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-xs text-muted-foreground">
                  {bans.length === 0
                    ? "No active bans in this Discord server."
                    : "No bans match your filter."}
                </p>
              </div>
            ) : (
              <div className="rounded-md ring-1 ring-border overflow-hidden overflow-y-auto">
                <div className="grid grid-cols-[1fr_160px_1fr_90px_80px] gap-3 px-4 py-2 bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground border-b border-border sticky top-0">
                  <span>User</span>
                  <span>Discord ID</span>
                  <span>Reason</span>
                  <span>Source</span>
                  <span></span>
                </div>
                {filteredBans.map((b) => (
                  <div
                    key={b.discordUserId}
                    className="grid grid-cols-[1fr_160px_1fr_90px_80px] gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface/30 transition-colors items-center"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="size-6 rounded-full bg-danger/10 text-danger flex items-center justify-center shrink-0 text-[10px] font-bold uppercase">
                        {b.username?.[0] ?? "?"}
                      </div>
                      <span className="text-sm font-medium text-foreground truncate">
                        {b.username}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-muted-foreground">
                      {b.discordUserId}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {b.reason || <span className="italic">No reason</span>}
                    </div>
                    <div>
                      {b.source === "panel" ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand/10 text-brand font-medium">
                          Panel
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
                          External
                        </span>
                      )}
                    </div>
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[10px] text-emerald-400 border-emerald-400/30 hover:bg-emerald-400/10 hover:border-emerald-400/60 disabled:opacity-50"
                        onClick={() => doUnban(b.discordUserId, b.username)}
                        disabled={!!unbanBusy[b.discordUserId]}
                      >
                        <UserCheck className="size-3 mr-1" />
                        {unbanBusy[b.discordUserId] ? "Unbanning…" : "Unban"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {unbanError && (
              <p className="text-xs text-danger">{unbanError}</p>
            )}

            {!bansLoading && bans.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {filteredBans.length !== bans.length
                  ? `${filteredBans.length} of ${bans.length} bans shown`
                  : `${bans.length} active ban${bans.length !== 1 ? "s" : ""}`}
                {" · "}
                Use "Sync from Discord" to import bans not made through this panel.
              </p>
            )}
          </div>
        )}

        {/* ── Mod Log ── */}
        {tab === "modlog" && (
          <div className="flex-1 overflow-y-auto p-6">
            {loadingModLog ? (
              <div className="flex items-center justify-center h-32">
                <span className="text-xs text-muted-foreground">Loading…</span>
              </div>
            ) : modLog.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <p className="text-xs text-muted-foreground">
                  No moderation actions recorded.
                </p>
              </div>
            ) : (
              <div className="space-y-0 rounded-md ring-1 ring-border overflow-hidden">
                <div className="grid grid-cols-[1fr_80px_1fr_100px_90px_140px] gap-3 px-4 py-2 bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground border-b border-border">
                  <span>Target</span>
                  <span>Action</span>
                  <span>Reason</span>
                  <span>By</span>
                  <span>Source</span>
                  <span>When</span>
                </div>
                {modLog.map((entry) => (
                  <div
                    key={entry.id}
                    className="grid grid-cols-[1fr_80px_1fr_100px_90px_140px] gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface/30 transition-colors"
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
                    <div className="text-xs text-foreground truncate">
                      {entry.actorUsername || (
                        <span className="italic text-muted-foreground">—</span>
                      )}
                    </div>
                    <div>
                      {entry.actorUsername ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand/10 text-brand font-medium">
                          Panel
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
                          External
                        </span>
                      )}
                    </div>
                    <div
                      className="text-xs text-muted-foreground"
                      title={fmtTs(entry.createdAt, tz)}
                    >
                      {fmtAgo(entry.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── Mod action dialog ── */}
      <Dialog
        open={!!actionTarget}
        onOpenChange={(o) => !o && setActionTarget(null)}
      >
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
                      <SelectItem
                        key={p.value}
                        value={String(p.value)}
                        className="text-xs"
                      >
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

            {actionError && <p className="text-xs text-danger">{actionError}</p>}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setActionTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitAction}
              disabled={actionLoading}
              variant={
                actionType === "ban" || actionType === "kick"
                  ? "destructive"
                  : "default"
              }
            >
              {actionLoading ? "Applying…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

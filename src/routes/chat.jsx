import { SteamRequiredGate } from "@/components/steam-required-gate";
import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAuth } from "@/lib/auth-context";
import { usePersistentState } from "@/lib/persistent-prefs";
import { useTimezone } from "@/lib/timezone-store";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Crown,
  MessageSquare,
  ShieldAlert,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const CATEGORY_LABELS = {
  harassment: "Harassment",
  "harassment/threatening": "Threatening",
  hate: "Hate Speech",
  "hate/threatening": "Threatening Hate",
  "self-harm": "Self-Harm",
  "self-harm/intent": "Self-Harm Intent",
  "self-harm/instructions": "Self-Harm Instr.",
  sexual: "Sexual",
  "sexual/minors": "Sexual/Minors",
  violence: "Violence",
  "violence/graphic": "Graphic Violence",
};

function FlaggedMessagesPanel({ orgId, canResolve, onJumpToMessage }) {
  const [flags, setFlags] = useState([]);
  const [totalReviewed, setTotalReviewed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actingIds, setActingIds] = useState(new Set());
  const [showResolved, setShowResolved] = useState(false);

  const fetchFlags = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        resolved: String(showResolved),
        limit: "50",
      });
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ai-moderation/flagged?${params}`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const data = await res.json();
      setFlags(data.flags ?? []);
      setTotalReviewed(data.totalReviewed ?? 0);
    } catch {
      // panel is supplementary; ignore errors
    } finally {
      setLoading(false);
    }
  }, [orgId, showResolved]);

  useEffect(() => {
    fetchFlags();
    const timer = setInterval(fetchFlags, 30000);
    return () => clearInterval(timer);
  }, [fetchFlags]);

  const act = useCallback(
    async (flagId, type) => {
      if (!orgId) return;
      setActingIds((s) => new Set(s).add(flagId));
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/ai-moderation/flagged/${flagId}/resolve`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type }),
          },
        );
        if (res.ok) {
          setFlags((prev) => prev.filter((f) => f.flagId !== flagId));
          setTotalReviewed((n) => n + 1);
        }
      } finally {
        setActingIds((s) => {
          const next = new Set(s);
          next.delete(flagId);
          return next;
        });
      }
    },
    [orgId],
  );

  return (
    <div className="w-72 shrink-0 border-l border-border flex flex-col bg-surface/20">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="size-3.5 text-danger" />
          <span className="text-[11px] font-semibold tracking-tight">
            Flagged Messages
          </span>
          {flags.length > 0 && !showResolved && (
            <span className="text-[9px] font-mono bg-danger/15 text-danger px-1.5 rounded-full">
              {flags.length}
            </span>
          )}
          {totalReviewed > 0 && (
            <span className="text-[9px] font-mono bg-success/10 text-success px-1.5 rounded-full">
              {totalReviewed} checked
            </span>
          )}
        </div>
        <button
          onClick={() => setShowResolved((v) => !v)}
          className={`text-[9px] font-mono uppercase tracking-widest transition-colors ${
            showResolved
              ? "text-brand"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {showResolved ? "Unresolved" : "Resolved"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && flags.length === 0 ? (
          <p className="text-[11px] text-muted-foreground text-center py-8">
            Loading…
          </p>
        ) : flags.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center px-4">
            <CheckCircle2 className="size-6 text-muted-foreground/30" />
            <p className="text-[11px] text-muted-foreground">
              {showResolved ? "No resolved flags." : "All clear."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {flags.map((flag) => (
              <FlagCard
                key={flag.flagId}
                flag={flag}
                canResolve={canResolve && !showResolved}
                acting={actingIds.has(flag.flagId)}
                onConfirm={() => act(flag.flagId, "confirmed")}
                onClear={() => act(flag.flagId, "cleared")}
                onJump={
                  flag.chatLogId
                    ? () =>
                        onJumpToMessage(flag.serverId, flag.chatLogId, flag.createdAt)
                    : null
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FlagCard({ flag, canResolve, acting, onConfirm, onClear, onJump }) {
  const scorePercent = Math.round(flag.score * 100);
  const label =
    CATEGORY_LABELS[flag.triggeredCategory] ?? flag.triggeredCategory;
  const isAutomute = flag.action === "automute";
  const age = fmtRelative(flag.createdAt * 1000);

  return (
    <div className="px-3 py-2.5 space-y-1.5 hover:bg-surface/40 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/player-lookup"
          search={{ steam: flag.steamId }}
          className="text-[11px] font-semibold truncate hover:text-brand hover:underline"
          title={flag.steamId}
        >
          {flag.playerName ?? flag.steamId}
        </Link>
        <span className="text-[9px] text-muted-foreground shrink-0">{age}</span>
      </div>

      {flag.serverName && (
        <p className="text-[9px] font-mono text-muted-foreground truncate">
          {flag.serverName}
        </p>
      )}

      <button
        onClick={onJump}
        disabled={!onJump}
        className={`text-left w-full text-[11px] text-foreground/80 line-clamp-2 break-words ${
          onJump ? "hover:text-brand cursor-pointer" : "cursor-default"
        }`}
        title={onJump ? "Jump to message in chat log" : undefined}
      >
        {flag.message}
      </button>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span
          className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
            isAutomute
              ? "bg-danger/15 text-danger ring-1 ring-danger/30"
              : "bg-warning/15 text-warning ring-1 ring-warning/30"
          }`}
        >
          {isAutomute ? "MUTED" : "FLAG"}
        </span>
        <span className="text-[9px] font-mono bg-surface px-1.5 py-0.5 rounded ring-1 ring-border">
          {label}
        </span>
        <span className="text-[9px] font-mono text-muted-foreground">
          {scorePercent}%
        </span>
        {flag.resolutionType && (
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ring-1 ${
            flag.resolutionType === "confirmed"
              ? "bg-danger/10 text-danger ring-danger/20"
              : "bg-muted/30 text-muted-foreground ring-border"
          }`}>
            {flag.resolutionType === "confirmed" ? "confirmed" : "cleared"}
          </span>
        )}
      </div>

      {canResolve && (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2 flex-1 text-danger border-danger/30 hover:bg-danger/10"
            disabled={acting}
            onClick={onConfirm}
            title="Keep flagged — AI was correct, but unlist from the queue"
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2 flex-1"
            disabled={acting}
            onClick={onClear}
            title="Dismiss — not a real concern"
          >
            Clear
          </Button>
        </div>
      )}
      {flag.resolved && flag.resolvedByName && (
        <p className="text-[9px] text-muted-foreground">
          {flag.resolutionType === "confirmed" ? "Confirmed" : "Cleared"} by{" "}
          {flag.resolvedByName}
        </p>
      )}
    </div>
  );
}
const Route = createFileRoute("/chat")({
  head: () => ({ meta: [{ title: "Chat Logs — IronSight" }] }),
  component: ChatPage,
});

const PRESETS = [
  { label: "Last hour", ms: 60 * 60 * 1e3 },
  { label: "Last 24h", ms: 24 * 60 * 60 * 1e3 },
  { label: "Last Week", ms: 7 * 24 * 60 * 60 * 1e3 },
];

function fmtLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseLocal(v) {
  return new Date(v).getTime();
}
function fmtTime(ms, tz) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, tz ? { timeZone: tz } : {});
}
function fmtRelative(ms) {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

// Shows who a team message was delivered to, reconstructed from team_events.
function TeamRecipients({ info, nameFor }) {
  if (!info) {
    return (
      <span
        className="text-[10px] text-yellow-500/40 italic shrink-0 self-center"
        title="No team roster recorded around this message's timestamp"
      >
        recipients unknown
      </span>
    );
  }

  const { recipients, members, leader, senderId } = info;

  if (recipients.length === 0) {
    return (
      <span className="text-[10px] text-yellow-500/50 shrink-0 self-center">
        → no teammates
      </span>
    );
  }

  const shown = recipients.slice(0, 3);
  const extra = recipients.length - shown.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1 text-[10px] text-yellow-500/70 hover:text-yellow-400 shrink-0 self-center max-w-[280px]">
          <ArrowRight className="size-3 shrink-0" />
          <span className="flex items-center gap-1 min-w-0">
            {shown.map((id) => (
              <span
                key={id}
                className="px-1 rounded bg-yellow-500/10 ring-1 ring-yellow-500/20 truncate max-w-[90px]"
              >
                {nameFor(id)}
              </span>
            ))}
            {extra > 0 && (
              <span className="text-yellow-500/60 shrink-0">+{extra}</span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="flex items-center gap-1.5 px-1 pb-2 mb-1 border-b border-border">
          <Users className="size-3.5 text-yellow-500" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Team · {members.length} member{members.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto space-y-0.5">
          {members.map((id) => {
            const isLeader = id === leader;
            const isSender = id === senderId;
            return (
              <Link
                key={id}
                to="/player-lookup"
                search={{ steam: id }}
                className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-surface text-left"
                title={id}
              >
                {isLeader ? (
                  <Crown className="size-3 text-yellow-500 shrink-0" />
                ) : (
                  <span className="size-3 shrink-0" />
                )}
                <span className="text-xs font-medium flex-1 truncate">
                  {nameFor(id)}
                </span>
                {isSender && (
                  <span className="text-[9px] font-mono uppercase tracking-wider text-brand shrink-0">
                    sender
                  </span>
                )}
                {isLeader && !isSender && (
                  <span className="text-[9px] font-mono uppercase tracking-wider text-yellow-500/70 shrink-0">
                    leader
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const NOW = Date.now();
const PAGE_SIZE = 100;

function ChatPage() {
  const { selectedOrgIds, orgsLoaded, hasStaffAccount, hasOrgPermission } =
    useAuth();
  const tz = useTimezone();

  const [servers, setServers] = useState([]);
  const [serversLoading, setServersLoading] = useState(true);

  const [serverId, setServerId] = useState("");
  const [start, setStart] = useState(fmtLocalInput(NOW - 60 * 60 * 1e3));
  const [end, setEnd] = useState(fmtLocalInput(NOW));
  const [query, setQuery] = useState("");
  const [selectedPlayers, setSelectedPlayers] = useState(new Set());
  const [relativeTs, setRelativeTs] = usePersistentState(
    "chat.relativeTs",
    false,
  );
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [hideTeamMsg, setHideTeamMsg] = usePersistentState(
    "chat.hideTeamMsg",
    false,
  );

  const [lines, setLines] = useState([]);
  const [teamEvents, setTeamEvents] = useState([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [linesError, setLinesError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [highlightedId, setHighlightedId] = useState(null);
  const pendingScrollId = useRef(null);

  const fetchAbortRef = useRef(null);
  const loadingMoreRef = useRef(false);
  const oldestTsRef = useRef(null);
  const newestTsRef = useRef(null);
  const sentinelRef = useRef(null);
  const scrollRef = useRef(null);

  // Fetch available servers
  useEffect(() => {
    let cancelled = false;
    setServersLoading(true);
    fetch("/api/servers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        if (cancelled) return;
        const fetched = data.servers ?? [];
        setServers(fetched);
        setServerId((cur) => {
          if (cur && fetched.some((s) => s.serverId === cur)) return cur;
          return fetched[0]?.serverId ?? "";
        });
      })
      .catch(() => {
        if (!cancelled) setServers([]);
      })
      .finally(() => {
        if (!cancelled) setServersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter servers to only those in currently selected orgs
  const availableServers = useMemo(
    () =>
      selectedOrgIds.length > 0
        ? servers.filter((s) => selectedOrgIds.includes(s.ownerOrgId))
        : servers,
    [servers, selectedOrgIds],
  );

  // When selected orgs change, reset server selection if the current one is no longer visible
  useEffect(() => {
    if (
      serverId &&
      availableServers.length > 0 &&
      !availableServers.some((s) => s.serverId === serverId)
    ) {
      setServerId(availableServers[0]?.serverId ?? "");
      setSelectedPlayers(new Set());
    }
  }, [availableServers, serverId]);

  const buildUrl = useCallback(
    (extra = {}) => {
      const startUnix = Math.floor(parseLocal(start) / 1000);
      const endUnix = Math.floor(parseLocal(end) / 1000);
      const params = new URLSearchParams({
        serverId,
        start: startUnix,
        end: endUnix,
        limit: PAGE_SIZE,
        ...extra,
      });
      return `/api/chat/logs?${params}`;
    },
    [serverId, start, end],
  );

  // Initial fetch when server/time window changes
  useEffect(() => {
    if (!serverId) {
      setLines([]);
      setHasMore(false);
      oldestTsRef.current = null;
      newestTsRef.current = null;
      return;
    }

    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setLinesLoading(true);
    setLinesError(null);
    setLines([]);
    setHasMore(false);
    oldestTsRef.current = null;
    newestTsRef.current = null;

    fetch(buildUrl(), { credentials: "include", signal: controller.signal })
      .then((r) => {
        if (!r.ok)
          return r.json().then((b) => Promise.reject(b?.error ?? r.status));
        return r.json();
      })
      .then((data) => {
        const msgs = data.lines ?? [];
        setLines(msgs);
        setHasMore(data.hasMore ?? false);
        if (msgs.length > 0) {
          newestTsRef.current = msgs[0].ts;
          oldestTsRef.current = msgs[msgs.length - 1].ts;
        }
        setLinesError(null);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setLinesError(String(err));
        setLines([]);
      })
      .finally(() => {
        setLinesLoading(false);
      });

    return () => controller.abort();
  }, [serverId, start, end]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch team lifecycle events covering the window so we can resolve which
  // teammates each team message was delivered to. We look back 7 days before
  // the window start so teams formed earlier still resolve for early messages.
  useEffect(() => {
    if (!serverId) {
      setTeamEvents([]);
      return;
    }
    const controller = new AbortController();
    const startUnix = Math.floor(parseLocal(start) / 1000) - 7 * 24 * 3600;
    const endUnix = Math.floor(parseLocal(end) / 1000);
    const params = new URLSearchParams({
      serverId,
      start: startUnix,
      end: endUnix,
      limit: 500,
    });
    fetch(`/api/teaminfo?${params}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => setTeamEvents(data.lines ?? []))
      .catch(() => {
        /* team data is supplementary; ignore failures */
      });
    return () => controller.abort();
  }, [serverId, start, end]);

  // Load older messages when sentinel is visible
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    const oldest = oldestTsRef.current;
    if (!oldest) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl({ before: oldest }), {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      const more = data.lines ?? [];
      setLines((prev) => [...prev, ...more]);
      setHasMore(data.hasMore ?? false);
      if (more.length > 0) {
        oldestTsRef.current = more[more.length - 1].ts;
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, buildUrl]);

  // Infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { root: container, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  // Poll for new messages every 10s
  const pollNew = useCallback(async () => {
    const newest = newestTsRef.current;
    if (!serverId || newest == null) return;
    try {
      const res = await fetch(buildUrl({ after: newest }), {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      const newMsgs = data.lines ?? [];
      if (newMsgs.length > 0) {
        setLines((prev) => [...newMsgs, ...prev]);
        newestTsRef.current = newMsgs[0].ts;
      }
    } catch {
      // ignore poll errors
    }
  }, [serverId, buildUrl]);

  useEffect(() => {
    if (!serverId) return;
    const timer = setInterval(pollNew, 10000);
    return () => clearInterval(timer);
  }, [serverId, pollNew]);

  // Update cursor refs as lines change
  useEffect(() => {
    if (lines.length > 0) {
      if (newestTsRef.current == null) newestTsRef.current = lines[0].ts;
    }
  }, [lines]);

  // Scroll to a message after navigation (fires when linesLoading goes false)
  useEffect(() => {
    if (!pendingScrollId.current || linesLoading) return;
    const id = pendingScrollId.current;
    pendingScrollId.current = null;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-msg-id="${id}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [linesLoading]);

  const onJumpToMessage = useCallback(
    (targetServerId, chatLogId, ts) => {
      const tsMs = ts * 1000;
      const halfWindow = 15 * 60 * 1000; // ±15 min around the message
      pendingScrollId.current = chatLogId;
      setHighlightedId(chatLogId);
      setServerId(targetServerId);
      setSelectedPlayers(new Set());
      setQuery("");
      setRelativeTs(false);
      setStart(fmtLocalInput(tsMs - halfWindow));
      setEnd(fmtLocalInput(tsMs + halfWindow));
    },
    [],
  );

  const startMs = parseLocal(start);
  const endMs = parseLocal(end);

  const playersInWindow = useMemo(() => {
    const seen = new Map();
    for (const l of lines) {
      if (!seen.has(l.steamId)) {
        seen.set(l.steamId, l.playerName ?? l.steamId);
      }
    }
    return Array.from(seen.entries()).map(([steamId, name]) => ({
      steamId,
      name,
    }));
  }, [lines]);

  // SteamID → display name, gathered from any chat line that carried a name.
  const nameMap = useMemo(() => {
    const m = new Map();
    for (const l of lines) {
      if (l.playerName) m.set(l.steamId, l.playerName);
    }
    return m;
  }, [lines]);
  const nameFor = useCallback((id) => nameMap.get(id) ?? id, [nameMap]);

  // Team rosters as point-in-time snapshots, ascending by event time. Each
  // team event carries the full roster at that moment, so the latest snapshot
  // at-or-before a message that still contains the sender is their team then.
  const teamSnapshots = useMemo(
    () =>
      [...teamEvents].sort(
        (a, b) => (a.eventTimeUnix ?? a.ts) - (b.eventTimeUnix ?? b.ts),
      ),
    [teamEvents],
  );

  // Resolve recipients for every team message currently loaded.
  const teamInfoById = useMemo(() => {
    const map = new Map();
    for (const l of lines) {
      if (!l.teamMessage) continue;
      let snapshot = null;
      for (const e of teamSnapshots) {
        const when = e.eventTimeUnix ?? e.ts;
        if (when > l.ts) break;
        const roster = [e.teamLeader, ...(e.teamMembers ?? [])];
        if (roster.includes(l.steamId)) snapshot = e;
      }
      if (!snapshot) continue;
      const members = [
        ...new Set([snapshot.teamLeader, ...(snapshot.teamMembers ?? [])]),
      ];
      map.set(l.id, {
        leader: snapshot.teamLeader,
        senderId: l.steamId,
        members,
        recipients: members.filter((id) => id !== l.steamId),
      });
    }
    return map;
  }, [lines, teamSnapshots]);

  // When relative preset changes, update start/end
  useEffect(() => {
    if (!relativeTs) return;
    const now = Date.now();
    setStart(fmtLocalInput(now - PRESETS[selectedPreset].ms));
    setEnd(fmtLocalInput(now));
  }, [relativeTs, selectedPreset]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      if (hideTeamMsg && l.teamMessage) return false;
      if (selectedPlayers.size > 0 && !selectedPlayers.has(l.steamId))
        return false;
      if (q && !l.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [lines, selectedPlayers, query, hideTeamMsg]);

  const toggle = (id) => {
    setSelectedPlayers((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const playersLabel =
    selectedPlayers.size === 0
      ? "All players"
      : selectedPlayers.size === 1
        ? (playersInWindow.find((p) => selectedPlayers.has(p.steamId))?.name ??
          "1 player")
        : `${selectedPlayers.size} players`;

  const activeServer = availableServers.find((s) => s.serverId === serverId);

  if (orgsLoaded && !hasStaffAccount) {
    return (
      <SteamRequiredGate>
        <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
          <SiteNav />
          <main className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              You must belong to an organization to view chat logs.
            </p>
          </main>
        </div>
      </SteamRequiredGate>
    );
  }

  return (
    <SteamRequiredGate>
      <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
        <SiteNav />
        <main className="flex-1 overflow-hidden flex flex-col">
          <div className="border-b border-border bg-surface/30 px-6 py-3 space-y-3 shrink-0">
            <div className="flex items-center gap-2">
              <MessageSquare className="size-4 text-brand" />
              <h1 className="text-sm font-semibold tracking-tight">
                Server Chat Logs
              </h1>
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                {filtered.length} / {lines.length} lines
                {hasMore && " (more below)"}
              </span>
              <span className="hidden sm:flex items-center gap-1.5 text-[10px] text-muted-foreground ml-auto">
                <span className="text-[9px] font-bold uppercase tracking-widest text-yellow-500/80 bg-yellow-500/10 px-1 rounded">
                  team
                </span>
                <ArrowRight className="size-3 text-yellow-500/70" />
                <span>recipients</span>
              </span>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Server
                </Label>
                <select
                  value={serverId}
                  onChange={(e) => {
                    setServerId(e.target.value);
                    setSelectedPlayers(new Set());
                  }}
                  className="h-8 px-2 text-xs bg-background ring-1 ring-border rounded-md"
                  disabled={serversLoading}
                >
                  {availableServers.map((s) => (
                    <option key={s.serverId} value={s.serverId}>
                      {s.serverName}
                    </option>
                  ))}
                  {availableServers.length === 0 && (
                    <option value="">
                      {serversLoading
                        ? "Loading…"
                        : "No servers in selected orgs"}
                    </option>
                  )}
                </select>
              </div>

              {relativeTs ? (
                <div className="space-y-1">
                  <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Timeframe
                  </Label>
                  <div className="flex ring-1 ring-border rounded-md overflow-hidden h-8">
                    {PRESETS.map((p, i) => (
                      <button
                        key={p.label}
                        onClick={() => setSelectedPreset(i)}
                        className={`px-3 text-xs font-mono transition-colors ${
                          selectedPreset === i
                            ? "bg-brand text-brand-foreground"
                            : "text-muted-foreground hover:text-foreground bg-background"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      From
                    </Label>
                    <Input
                      type="datetime-local"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                      className="h-8 w-[195px] text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      To
                    </Label>
                    <Input
                      type="datetime-local"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      className="h-8 w-[195px] text-xs"
                    />
                  </div>
                </>
              )}

              <div className="space-y-1">
                <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Players
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="h-8 px-2.5 text-xs bg-background ring-1 ring-border rounded-md flex items-center gap-1.5 min-w-[160px]">
                      <span className="flex-1 text-left truncate">
                        {playersLabel}
                      </span>
                      <ChevronDown className="size-3 text-muted-foreground" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-2">
                    <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-border">
                      <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                        In timeframe ({playersInWindow.length})
                      </span>
                      <button
                        onClick={() => setSelectedPlayers(new Set())}
                        className="text-[10px] font-semibold text-brand hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="max-h-72 overflow-y-auto space-y-0.5">
                      {playersInWindow.length === 0 && (
                        <p className="text-[11px] text-muted-foreground px-2 py-2">
                          No players spoke in this window.
                        </p>
                      )}
                      {playersInWindow.map((p) => {
                        const checked = selectedPlayers.has(p.steamId);
                        return (
                          <button
                            key={p.steamId}
                            onClick={() => toggle(p.steamId)}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
                          >
                            <span
                              className={
                                "size-4 rounded-sm grid place-items-center ring-1 " +
                                (checked
                                  ? "bg-brand ring-brand text-brand-foreground"
                                  : "ring-border text-transparent")
                              }
                            >
                              <Check className="size-3" />
                            </span>
                            <span className="text-xs font-medium flex-1 truncate">
                              {p.name}
                            </span>
                            <span className="text-[9px] font-mono text-muted-foreground truncate">
                              {p.steamId.slice(-6)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-1 flex-1 min-w-[200px]">
                <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Search text
                </Label>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search chat content…"
                  className="h-8 text-xs"
                />
              </div>

              <div className="flex items-end gap-3 pb-0.5">
                <button
                  onClick={() => {
                    const next = !relativeTs;
                    setRelativeTs(next);
                    if (next) setSelectedPreset(0);
                  }}
                  className={`h-8 px-3 text-xs font-mono rounded-md ring-1 transition-colors ${
                    relativeTs
                      ? "bg-brand text-brand-foreground ring-brand"
                      : "bg-background text-muted-foreground ring-border hover:text-foreground"
                  }`}
                >
                  Relative time
                </button>
                <button
                  onClick={() => setHideTeamMsg((v) => !v)}
                  className={`h-8 px-3 text-xs font-mono rounded-md ring-1 transition-colors ${
                    hideTeamMsg
                      ? "bg-brand text-brand-foreground ring-brand"
                      : "bg-background text-muted-foreground ring-border hover:text-foreground"
                  }`}
                >
                  Hide team chat
                </button>
              </div>
            </div>

            {activeServer && (
              <p className="text-[10px] font-mono text-muted-foreground">
                {activeServer.serverName}
              </p>
            )}
          </div>

          <div className="flex-1 overflow-hidden flex">
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
              {linesLoading ? (
                <p className="text-sm text-muted-foreground text-center py-12">
                  Loading…
                </p>
              ) : linesError ? (
                <p className="text-sm text-destructive text-center py-12">
                  {linesError}
                </p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-12">
                  No chat lines match these filters.
                </p>
              ) : (
                <div className="space-y-0.5 font-mono text-[12px] max-w-4xl mx-auto">
                  {filtered.map((l) => (
                    <div
                      key={l.id}
                      data-msg-id={l.id}
                      className={`flex gap-3 px-2 py-1 hover:bg-surface/50 rounded items-baseline transition-colors ${
                        l.teamMessage
                          ? "border-l-2 border-yellow-500/40 pl-1.5"
                          : ""
                      } ${String(l.id) === String(highlightedId) ? "bg-warning/10 ring-1 ring-warning/30" : ""}`}
                    >
                      <span className="text-muted-foreground shrink-0 w-[100px] text-[11px]">
                        {relativeTs
                          ? fmtRelative(l.ts * 1000)
                          : fmtTime(l.ts * 1000, tz)}
                      </span>
                      {l.teamMessage && (
                        <span className="text-[9px] font-bold uppercase tracking-widest text-yellow-500/80 shrink-0 self-center bg-yellow-500/10 px-1 rounded">
                          team
                        </span>
                      )}
                      <Link
                        to="/player-lookup"
                        search={{ steam: l.steamId }}
                        className="font-semibold shrink-0 w-[140px] truncate hover:text-brand hover:underline"
                        title={l.steamId}
                      >
                        {l.playerName ?? l.steamId}
                      </Link>
                      <div className="flex-1 min-w-0 flex items-baseline justify-between gap-3">
                        <span
                          className={`break-words min-w-0 ${l.teamMessage ? "text-yellow-400/80" : "text-foreground/90"}`}
                        >
                          {l.message}
                        </span>
                        {l.teamMessage && (
                          <TeamRecipients
                            info={teamInfoById.get(l.id)}
                            nameFor={nameFor}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                  <div
                    ref={sentinelRef}
                    className="py-3 flex items-center justify-center"
                  >
                    {loadingMore ? (
                      <span className="text-xs text-muted-foreground">
                        Loading older messages…
                      </span>
                    ) : !hasMore && lines.length > 0 ? (
                      <span className="text-[10px] text-muted-foreground/40">
                        All messages loaded
                      </span>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
            <FlaggedMessagesPanel
              orgId={activeServer?.ownerOrgId ?? selectedOrgIds[0]}
              canResolve={hasOrgPermission(
                activeServer?.ownerOrgId ?? selectedOrgIds[0],
                "flagged_messages_resolve",
              )}
              onJumpToMessage={onJumpToMessage}
            />
          </div>
        </main>
      </div>
    </SteamRequiredGate>
  );
}
export { Route };

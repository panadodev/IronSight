import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, Search, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/tickets")({
  head: () => ({ meta: [{ title: "Ticket Queue - IronSight" }] }),
  component: TicketsPage,
});

const TYPE_META = {
  player_report: { label: "Report", color: "text-rose-400" },
  ban_appeal: { label: "Appeal", color: "text-yellow-400" },
  vip_issue: { label: "VIP", color: "text-cyan-400" },
  general_support: { label: "Support", color: "text-green-400" },
};

function typeFromName(name) {
  const n = (name ?? "").toLowerCase();
  if (n.includes("ban appeal") || n.includes("appeal")) return "ban_appeal";
  if (n.includes("vip")) return "vip_issue";
  if (n.includes("player report") || n.includes("report"))
    return "player_report";
  return "general_support";
}

function ticketMeta(ticket) {
  return TYPE_META[ticket.type] ?? TYPE_META.general_support;
}

function formatRelativeTime(unixSec) {
  if (!unixSec) return "";
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Parse the teaminfo RCON response.
// Format: [RCON] ID: 445 steamID username online leader 76561198047982255 DEADLY x x 76561198041858160 Ringo Starfish
// "online" and "leader" columns are the literal character "x" when true, absent when false.
function parseTeamInfoResponse(raw) {
  if (!raw) return null;
  const text = raw.replace(/^\[RCON\]\s*/i, "").trim();

  const idMatch = text.match(/\bID:\s*(\d+)/i);
  if (!idMatch) return null;
  const teamId = Number(idMatch[1]);

  // Strip everything up to and including the column header row
  const afterHeader = text
    .replace(/\bID:\s*\d+\s+steamID\s+username\s+online\s+leader\s*/i, "")
    .trim();

  if (!afterHeader) return { teamId, members: [] };

  // Steam IDs are always 17-digit numbers beginning with 7656119
  const steamIdRe = /\b(7656119\d{10})\b/g;
  const positions = [];
  let m;
  while ((m = steamIdRe.exec(afterHeader)) !== null) {
    positions.push({ steamId: m[1], end: m.index + m[1].length });
  }

  if (!positions.length) return { teamId, members: [] };

  const members = positions.map(({ steamId, end }, i) => {
    const nextStart =
      i + 1 < positions.length ? positions[i + 1].index : afterHeader.length;
    const segment = afterHeader.slice(end, nextStart).trim();
    const tokens = segment.split(/\s+/).filter(Boolean);

    // "online" precedes "leader" in the column order. Both are "x" when true.
    // Pop from the end so we don't confuse multi-word names.
    let leader = false;
    let online = false;
    if (tokens[tokens.length - 1] === "x") {
      leader = true;
      tokens.pop();
    }
    if (tokens[tokens.length - 1] === "x") {
      online = true;
      tokens.pop();
    }

    return { steamId, username: tokens.join(" ") || "Unknown", online, leader };
  });

  return { teamId, members };
}

const NON_CLOSED = new Set(["open", "waiting_response"]);

const TAB_STATUSES = {
  active: new Set(["open"]),
  waiting: new Set(["waiting_response"]),
  closed: new Set(["closed"]),
};

const TYPE_FILTERS = ["ALL", "REPORT", "APPEAL", "VIP", "SUPPORT"];
const TYPE_FILTER_MAP = {
  ALL: null,
  REPORT: "player_report",
  APPEAL: "ban_appeal",
  VIP: "vip_issue",
  SUPPORT: "general_support",
};

function TicketsPage() {
  const { adminableOrgIds, orgs, sessionUser, orgsLoaded, sessionOrgPermissions } = useAuth();

  const ticketOrgIds = useMemo(() => {
    const ids = new Set(adminableOrgIds);
    for (const org of orgs) {
      if ((sessionOrgPermissions[org.id] ?? []).includes("tickets_view")) ids.add(org.id);
    }
    return Array.from(ids);
  }, [adminableOrgIds, orgs, sessionOrgPermissions]);

  const [tab, setTab] = useState("active");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [noteText, setNoteText] = useState("");
  const [replyText, setReplyText] = useState("");
  const [composerMode, setComposerMode] = useState("reply");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Team info panel state
  const [orgServers, setOrgServers] = useState([]);
  const [teamSteamId, setTeamSteamId] = useState("");
  const [teamServerId, setTeamServerId] = useState("");
  const [teamResult, setTeamResult] = useState(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState("");

  useEffect(() => {
    if (!orgsLoaded || !ticketOrgIds.length) return;
    let cancelled = false;
    setLoading(true);

    Promise.all(
      ticketOrgIds.map((orgId) =>
        fetch(`/api/orgs/${encodeURIComponent(orgId)}/tickets?limit=200`, {
          credentials: "include",
        })
          .then((r) => (r.ok ? r.json() : { tickets: [] }))
          .then((data) =>
            (data.tickets ?? []).map((t) => ({
              ...t,
              type: typeFromName(t.ticket_type_name),
            })),
          )
          .catch(() => []),
      ),
    ).then((results) => {
      if (cancelled) return;
      const all = results.flat().sort((a, b) => b.created_at - a.created_at);
      setTickets(all);
      if (all.length > 0) setSelectedId((prev) => prev ?? all[0].ticket_id);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [orgsLoaded, ticketOrgIds]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setDetailLoading(true);
    setSelectedMessages([]);

    fetch(`/api/tickets/${selectedId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data) => {
        if (!cancelled) {
          setSelectedMessages(data.messages ?? []);
          setDetailLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Fetch RCON-configured servers for the selected ticket's org
  const selectedOrgId =
    tickets.find((t) => t.ticket_id === selectedId)?.org_id ?? null;
  useEffect(() => {
    if (!selectedOrgId) return;
    setTeamResult(null);
    setTeamError("");

    fetch("/api/servers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { servers: [] }))
      .then((data) => {
        const filtered = (data.servers ?? []).filter(
          (s) => s.ownerOrgId === selectedOrgId && s.rconConfigured,
        );
        setOrgServers(filtered);
        setTeamServerId((prev) => {
          const stillValid = filtered.some((s) => s.serverId === prev);
          return stillValid ? prev : (filtered[0]?.serverId ?? "");
        });
      })
      .catch(() => {});
  }, [selectedOrgId]);

  const totalNonClosed = useMemo(
    () => tickets.filter((t) => NON_CLOSED.has(t.status)).length,
    [tickets],
  );

  const filtered = useMemo(() => {
    const statuses = TAB_STATUSES[tab];
    const typeVal = TYPE_FILTER_MAP[typeFilter];
    const q = search.trim().toLowerCase();
    return tickets.filter((t) => {
      if (!statuses.has(t.status)) return false;
      if (typeVal && t.type !== typeVal) return false;
      if (q) {
        const name = (t.created_by_username ?? "").toLowerCase();
        const steamId = t.created_by_steam_id ?? "";
        if (
          !t.title.toLowerCase().includes(q) &&
          !name.includes(q) &&
          !steamId.includes(q)
        )
          return false;
      }
      return true;
    });
  }, [tab, typeFilter, search, tickets]);

  const selectedTicket =
    tickets.find((t) => t.ticket_id === selectedId) ?? null;

  const handlePostNote = useCallback(async () => {
    if (!noteText.trim() || !selectedId || submitting) return;
    setSubmitting(true);
    try {
      await fetch(`/api/tickets/${selectedId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: noteText.trim(), isInternal: true }),
      });
      const res = await fetch(`/api/tickets/${selectedId}`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedMessages(data.messages ?? []);
      }
      setNoteText("");
    } finally {
      setSubmitting(false);
    }
  }, [noteText, selectedId, submitting]);

  const handlePostReply = useCallback(async () => {
    if (!replyText.trim() || !selectedId || submitting) return;
    setSubmitting(true);
    try {
      await fetch(`/api/tickets/${selectedId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: replyText.trim(), isInternal: false }),
      });
      const res = await fetch(`/api/tickets/${selectedId}`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedMessages(data.messages ?? []);
      }
      setReplyText("");
    } finally {
      setSubmitting(false);
    }
  }, [replyText, selectedId, submitting]);

  const handleClaim = useCallback(async () => {
    if (!selectedId || !sessionUser?.userId) return;
    const res = await fetch(`/api/tickets/${selectedId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: sessionUser.userId }),
    });
    if (res.ok) {
      setTickets((prev) =>
        prev.map((t) =>
          t.ticket_id === selectedId
            ? {
                ...t,
                assigned_to: sessionUser.userId,
                assigned_to_username: sessionUser.username,
              }
            : t,
        ),
      );
    }
  }, [selectedId, sessionUser]);

  const handleUpdateStatus = useCallback(
    async (status) => {
      if (!selectedId) return;
      const res = await fetch(`/api/tickets/${selectedId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        setTickets((prev) =>
          prev.map((t) => (t.ticket_id === selectedId ? { ...t, status } : t)),
        );
      }
    },
    [selectedId],
  );

  const handleTeamLookup = useCallback(async () => {
    const sid = teamSteamId.trim();
    if (!sid || !teamServerId || teamLoading) return;
    setTeamLoading(true);
    setTeamError("");
    setTeamResult(null);
    try {
      const res = await fetch(
        `/api/servers/${encodeURIComponent(teamServerId)}/rcon/exec`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: `teaminfo ${sid}` }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setTeamError(data?.error ?? "RCON command failed");
        return;
      }
      const parsed = parseTeamInfoResponse(data.response ?? "");
      if (parsed && parsed.members.length > 0) {
        setTeamResult(parsed);
      } else {
        setTeamError("Player is not in a team or no result returned.");
      }
    } catch {
      setTeamError("Failed to reach server.");
    } finally {
      setTeamLoading(false);
    }
  }, [teamSteamId, teamServerId, teamLoading]);

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 flex min-h-0">
        {/* Left: ticket list */}
        <aside className="w-[230px] shrink-0 border-r border-border flex flex-col bg-background">
          <div className="px-3 py-2 border-b border-border shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase tracking-widest font-bold text-foreground">
                Active Queue
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {totalNonClosed}
              </span>
            </div>
            <div className="flex ring-1 ring-border rounded overflow-hidden">
              {["active", "waiting", "closed"].map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 py-1 text-[10px] font-mono capitalize transition-colors ${
                    tab === t
                      ? "bg-brand text-brand-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "active"
                    ? "Active"
                    : t === "waiting"
                      ? "Waiting"
                      : "Closed"}
                </button>
              ))}
            </div>
          </div>

          <div className="px-2 py-2 border-b border-border shrink-0">
            <div className="relative">
              <Search className="size-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search player name or Steam ID..."
                className="w-full bg-background border border-border rounded pl-6 pr-2 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
              />
            </div>
          </div>

          <div className="px-2 py-1.5 border-b border-border flex gap-0.5 flex-wrap shrink-0">
            {TYPE_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setTypeFilter(f)}
                className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded transition-colors ${
                  typeFilter === f
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="text-[10px] text-muted-foreground text-center py-10">
                Loading...
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-[10px] text-muted-foreground text-center py-10">
                No tickets
              </div>
            ) : (
              filtered.map((ticket) => (
                <TicketListItem
                  key={ticket.ticket_id}
                  ticket={ticket}
                  orgs={orgs}
                  selected={ticket.ticket_id === selectedId}
                  onClick={() => setSelectedId(ticket.ticket_id)}
                />
              ))
            )}
          </div>
        </aside>

        {/* Center: detail */}
        {selectedTicket ? (
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden border-r border-border">
            <TicketDetail
              ticket={selectedTicket}
              messages={selectedMessages}
              noteText={noteText}
              onNoteChange={setNoteText}
              onPostNote={handlePostNote}
              replyText={replyText}
              onReplyChange={setReplyText}
              onPostReply={handlePostReply}
              composerMode={composerMode}
              onComposerModeChange={setComposerMode}
              onClaim={handleClaim}
              onUpdateStatus={handleUpdateStatus}
              submitting={submitting}
              detailLoading={detailLoading}
              sessionUser={sessionUser}
            />
          </main>
        ) : (
          <main className="flex-1 grid place-items-center border-r border-border">
            <p className="text-sm text-muted-foreground">
              {loading ? "Loading tickets..." : "Select a ticket"}
            </p>
          </main>
        )}

        {/* Right: team info panel */}
        {selectedTicket && (
          <TeamInfoPanel
            servers={orgServers}
            steamId={teamSteamId}
            onSteamIdChange={setTeamSteamId}
            serverId={teamServerId}
            onServerIdChange={setTeamServerId}
            onLookup={handleTeamLookup}
            loading={teamLoading}
            result={teamResult}
            error={teamError}
          />
        )}
      </div>
    </div>
  );
}

function getOrgPrefix(orgId, orgs) {
  const org = orgs.find((o) => o.id === orgId);
  return org ? org.short : (orgId ?? "??").slice(0, 2).toUpperCase();
}

function TicketListItem({ ticket, orgs, selected, onClick }) {
  const meta = ticketMeta(ticket);
  const prefix = getOrgPrefix(ticket.org_id, orgs);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 border-b border-border transition-colors flex items-start gap-1.5 min-w-0 ${
        selected ? "bg-brand/10" : "hover:bg-surface/60"
      }`}
    >
      <span className="text-[9px] font-mono font-bold text-muted-foreground shrink-0 mt-0.5 w-4 text-center">
        {prefix}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 min-w-0">
          <span
            className={`text-[10px] font-mono font-bold shrink-0 ${meta.color}`}
          >
            {meta.label}
          </span>
          <span className="text-[9px] text-muted-foreground shrink-0">·</span>
          <span className="text-[10px] font-medium truncate min-w-0">
            {ticket.created_by_username ?? "Unknown"}
          </span>
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[9px] font-mono text-muted-foreground capitalize">
            {ticket.priority}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground ml-auto shrink-0">
            {formatRelativeTime(ticket.created_at)}
          </span>
        </div>
      </div>
    </button>
  );
}

function TicketDetail({
  ticket,
  messages,
  noteText,
  onNoteChange,
  onPostNote,
  replyText,
  onReplyChange,
  onPostReply,
  composerMode,
  onComposerModeChange,
  onClaim,
  onUpdateStatus,
  submitting,
  detailLoading,
  sessionUser,
}) {
  const isClaimed = ticket.assigned_to === sessionUser?.userId;
  const isClosed = ticket.status === "closed";
  const internalMessages = messages.filter((m) => m.isInternal);
  const publicMessages = messages.filter((m) => !m.isInternal);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-mono text-brand shrink-0">
            #{ticket.ticket_id}
          </span>
          <h2 className="text-sm font-bold truncate">{ticket.title}</h2>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-mono bg-surface/60 ring-1 ring-border rounded px-2 py-0.5">
            {ticket.ticket_type_name ?? "Unknown type"}
          </span>
          <button className="flex items-center gap-1 text-[10px] font-mono bg-surface/60 ring-1 ring-border rounded px-2 py-0.5 hover:bg-surface transition-colors">
            {ticket.assigned_to_username ?? "Assign"}
            <ChevronDown size={9} className="text-muted-foreground" />
          </button>
          <button
            onClick={onClaim}
            className={`text-[10px] font-mono rounded px-2 py-0.5 hover:opacity-90 transition-colors ${
              isClaimed
                ? "bg-surface/60 ring-1 ring-border text-muted-foreground"
                : "bg-brand text-brand-foreground"
            }`}
          >
            {isClaimed ? "CLAIMED" : "CLAIM"}
          </button>
          <span
            className={`text-[9px] font-mono uppercase font-bold tracking-wider ml-auto ${
              ticket.priority === "urgent"
                ? "text-danger"
                : ticket.priority === "high"
                  ? "text-warning"
                  : "text-muted-foreground"
            }`}
          >
            {ticket.priority}
          </span>
        </div>
      </div>

      {/* Action row */}
      <div className="px-4 py-1.5 border-b border-border flex items-center gap-1 shrink-0">
        {!isClosed ? (
          <>
            <button
              onClick={() => onUpdateStatus("waiting_response")}
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-surface/60 ring-1 ring-border text-muted-foreground hover:text-foreground transition-colors"
            >
              Wait for response
            </button>
            <button
              onClick={() => onUpdateStatus("closed")}
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-surface/60 ring-1 ring-border text-muted-foreground hover:text-foreground transition-colors"
            >
              Close
            </button>
          </>
        ) : (
          <button
            onClick={() => onUpdateStatus("open")}
            className="text-[10px] font-mono px-2 py-0.5 rounded bg-brand/20 text-brand hover:bg-brand/30 transition-colors"
          >
            Reopen
          </button>
        )}
        {ticket.status === "waiting_response" && (
          <button
            onClick={() => onUpdateStatus("open")}
            className="text-[10px] font-mono px-2 py-0.5 rounded bg-brand/20 text-brand hover:bg-brand/30 transition-colors"
          >
            Mark Active
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {detailLoading ? (
          <div className="text-[10px] text-muted-foreground text-center py-10">
            Loading...
          </div>
        ) : (
          <>
            {publicMessages.length > 0 && (
              <div className="px-4 pt-3 pb-2 space-y-2">
                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                  Conversation
                </div>
                {publicMessages.map((msg) => (
                  <MessageBubble key={msg.messageId} msg={msg} />
                ))}
              </div>
            )}
            {internalMessages.length > 0 && (
              <div className="px-4 py-2 space-y-2">
                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                  Internal Notes
                </div>
                {internalMessages.map((msg) => (
                  <MessageBubble key={msg.messageId} msg={msg} internal />
                ))}
              </div>
            )}
            {messages.length === 0 && (
              <div className="text-[10px] text-muted-foreground text-center py-10">
                No messages yet
              </div>
            )}
          </>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border px-4 py-3 shrink-0">
        <div className="flex items-center gap-1 mb-2">
          <button
            onClick={() => onComposerModeChange("reply")}
            className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
              composerMode === "reply"
                ? "bg-brand text-brand-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Reply
          </button>
          <button
            onClick={() => onComposerModeChange("note")}
            className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
              composerMode === "note"
                ? "bg-brand text-brand-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Internal Note
          </button>
          {composerMode === "note" && (
            <span className="text-[9px] font-mono text-muted-foreground/50 ml-1">
              · Staff-only. Reporters never see these.
            </span>
          )}
        </div>
        {composerMode === "reply" ? (
          <>
            <textarea
              value={replyText}
              onChange={(e) => onReplyChange(e.target.value)}
              placeholder="Write a reply to the submitter..."
              disabled={isClosed}
              className="w-full h-20 bg-background border border-border rounded p-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
            />
            <div className="flex items-center justify-end mt-1.5">
              <button
                onClick={onPostReply}
                disabled={!replyText.trim() || submitting || isClosed}
                className="text-[10px] font-mono bg-brand text-brand-foreground rounded px-3 py-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Sending..." : "Send Reply"}
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea
              value={noteText}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="Discuss this case with other staff — evidence checks, second opinions, decisions..."
              disabled={isClosed}
              className="w-full h-20 bg-background border border-border rounded p-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
            />
            <div className="flex items-center justify-end mt-1.5">
              <button
                onClick={onPostNote}
                disabled={!noteText.trim() || submitting || isClosed}
                className="text-[10px] font-mono bg-brand text-brand-foreground rounded px-3 py-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Posting..." : "Post Note"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg, internal }) {
  return (
    <div
      className={`rounded-md px-3 py-2 ring-1 text-xs ${
        internal ? "bg-brand/10 ring-brand/20" : "bg-surface/60 ring-border"
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="font-semibold text-[10px]">
          {msg.username ?? "Unknown"}
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">
          {formatRelativeTime(msg.createdAt)}
        </span>
        {internal && (
          <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground ml-auto">
            Internal Note
          </span>
        )}
      </div>
      <p className="leading-relaxed">{msg.message}</p>
    </div>
  );
}

function TeamInfoPanel({
  servers,
  steamId,
  onSteamIdChange,
  serverId,
  onServerIdChange,
  onLookup,
  loading,
  result,
  error,
}) {
  const handleKeyDown = (e) => {
    if (e.key === "Enter") onLookup();
  };

  return (
    <aside className="w-[220px] shrink-0 flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-1.5">
        <Users size={10} className="text-muted-foreground shrink-0" />
        <span className="text-[10px] font-mono uppercase tracking-widest font-bold">
          Team Info
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {/* Steam ID input */}
        <input
          value={steamId}
          onChange={(e) => onSteamIdChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Steam ID..."
          className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
        />

        {/* Server selector — only shown when multiple RCON servers exist */}
        {servers.length > 1 && (
          <select
            value={serverId}
            onChange={(e) => onServerIdChange(e.target.value)}
            className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
          >
            {servers.map((s) => (
              <option key={s.serverId} value={s.serverId}>
                {s.serverName}
              </option>
            ))}
          </select>
        )}

        {servers.length === 0 && (
          <p className="text-[10px] font-mono text-muted-foreground">
            No RCON servers configured for this org.
          </p>
        )}

        <button
          onClick={onLookup}
          disabled={
            !steamId.trim() || !serverId || loading || servers.length === 0
          }
          className="w-full text-[10px] font-mono bg-brand text-brand-foreground rounded py-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {loading ? "Looking up..." : "Lookup"}
        </button>

        {/* Error */}
        {error && (
          <p className="text-[10px] font-mono text-danger leading-snug">
            {error}
          </p>
        )}

        {/* Results */}
        {result && (
          <div>
            <div className="text-[9px] font-mono text-muted-foreground mb-1.5">
              Team #{result.teamId} · {result.members.length}{" "}
              {result.members.length === 1 ? "member" : "members"}
            </div>
            <div className="space-y-1">
              {result.members.map((member) => (
                <div
                  key={member.steamId}
                  className="ring-1 ring-border rounded px-2 py-1.5 bg-surface/30"
                >
                  <div className="flex items-center gap-1 min-w-0">
                    {member.online && (
                      <span className="text-[8px] text-green-400 shrink-0">
                        ●
                      </span>
                    )}
                    {member.leader && (
                      <span className="text-[8px] font-mono font-bold text-amber-400 shrink-0 uppercase">
                        Lead
                      </span>
                    )}
                    <span className="text-[10px] font-medium truncate">
                      {member.username}
                    </span>
                  </div>
                  <div className="text-[9px] font-mono text-muted-foreground mt-0.5 truncate">
                    {member.steamId}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/tickets")({
  head: () => ({ meta: [{ title: "Ticket Queue - IronSight" }] }),
  component: TicketsPage,
});

const TYPE_META = {
  player_report:   { label: "Report",   color: "text-rose-400" },
  ban_appeal:      { label: "Appeal",   color: "text-yellow-400" },
  vip_issue:       { label: "VIP",      color: "text-cyan-400" },
  general_support: { label: "Support",  color: "text-green-400" },
};

function typeFromName(name) {
  const n = (name ?? "").toLowerCase();
  if (n.includes("ban appeal") || n.includes("appeal")) return "ban_appeal";
  if (n.includes("vip")) return "vip_issue";
  if (n.includes("player report") || n.includes("report")) return "player_report";
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

const NON_CLOSED = new Set(["open", "waiting_response"]);

const TAB_STATUSES = {
  active:  new Set(["open"]),
  waiting: new Set(["waiting_response"]),
  closed:  new Set(["closed"]),
};

const TYPE_FILTERS = ["ALL", "REPORT", "APPEAL", "VIP", "SUPPORT"];
const TYPE_FILTER_MAP = {
  ALL: null, REPORT: "player_report", APPEAL: "ban_appeal",
  VIP: "vip_issue", SUPPORT: "general_support",
};

function TicketsPage() {
  const { adminableOrgIds, orgs, sessionUser, orgsLoaded } = useAuth();

  const [tab, setTab] = useState("active");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [noteText, setNoteText] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!orgsLoaded || !adminableOrgIds.length) return;
    let cancelled = false;
    setLoading(true);

    Promise.all(
      adminableOrgIds.map((orgId) =>
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
  }, [orgsLoaded, adminableOrgIds]);

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

  const selectedTicket = tickets.find((t) => t.ticket_id === selectedId) ?? null;

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
          prev.map((t) =>
            t.ticket_id === selectedId ? { ...t, status } : t,
          ),
        );
      }
    },
    [selectedId],
  );

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
                  {t === "active" ? "Active" : t === "waiting" ? "Waiting" : "Closed"}
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
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <TicketDetail
              ticket={selectedTicket}
              messages={selectedMessages}
              noteText={noteText}
              onNoteChange={setNoteText}
              onPostNote={handlePostNote}
              onClaim={handleClaim}
              onUpdateStatus={handleUpdateStatus}
              submitting={submitting}
              detailLoading={detailLoading}
              sessionUser={sessionUser}
            />
          </main>
        ) : (
          <main className="flex-1 grid place-items-center">
            <p className="text-sm text-muted-foreground">
              {loading ? "Loading tickets..." : "Select a ticket"}
            </p>
          </main>
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
          <span className={`text-[10px] font-mono font-bold shrink-0 ${meta.color}`}>
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

      {/* Note composer */}
      <div className="border-t border-border px-4 py-3 shrink-0">
        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
          Internal Note{" "}
          <span className="normal-case tracking-normal text-muted-foreground/50">
            · Staff-only. Reporters never see these.
          </span>
        </div>
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
        <span className="font-semibold text-[10px]">{msg.username ?? "Unknown"}</span>
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

import { GateRank, SectionHeader } from "@/components/manage-section";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

const Route = createFileRoute("/manage/tickets")({
  component: TicketsPage,
});

const STATUS_OPTS = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "waiting_response", label: "Waiting" },
  { value: "closed", label: "Closed" },
];

const STATUS_TONE = {
  open: "text-brand ring-brand/30 bg-brand/10",
  waiting_response: "text-warning ring-warning/30 bg-warning/10",
  closed: "text-muted-foreground ring-border bg-surface",
};
const STATUS_LABEL = {
  open: "Open",
  waiting_response: "Waiting",
  closed: "Closed",
};
const PRIORITY_TONE = {
  urgent: "text-danger font-semibold",
  high: "text-warning",
  normal: "text-muted-foreground",
  low: "text-muted-foreground/60",
};
const PRIORITY_LABEL = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };

function timeAgo(unixTs) {
  const diff = Math.floor(Date.now() / 1000) - unixTs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function TicketThread({ orgId, ticketId, session, onStatusChange }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [updatingPriority, setUpdatingPriority] = useState(false);
  const messagesEndRef = useRef(null);

  async function loadDetail() {
    setLoading(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        credentials: "include",
      });
      if (res.ok) setDetail(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!ticketId) return;
    setDetail(null);
    setDraft("");
    setSendError("");
    loadDetail();
  }, [ticketId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages]);

  async function sendReply() {
    if (!draft.trim()) return;
    setSending(true);
    setSendError("");
    try {
      const res = await fetch(`/api/tickets/${ticketId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: draft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendError(data?.error ?? "Failed to send.");
        return;
      }
      setDraft("");
      await loadDetail();
    } catch {
      setSendError("Network error.");
    } finally {
      setSending(false);
    }
  }

  async function updateStatus(newStatus) {
    setUpdatingStatus(true);
    try {
      await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      await loadDetail();
      onStatusChange?.();
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function updatePriority(newPriority) {
    setUpdatingPriority(true);
    try {
      await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: newPriority }),
      });
      await loadDetail();
      onStatusChange?.();
    } finally {
      setUpdatingPriority(false);
    }
  }

  async function assignToSelf() {
    try {
      await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedTo: session?.userId ?? null }),
      });
      await loadDetail();
      onStatusChange?.();
    } catch {
      /* ignore */
    }
  }

  if (loading) {
    return (
      <div className="flex-1 grid place-items-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex-1 grid place-items-center">
        <p className="text-sm text-danger">Failed to load ticket.</p>
      </div>
    );
  }

  const { ticket, messages } = detail;
  const isClosed = ticket.status === "closed";

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Ticket header */}
      <div className="px-5 py-4 border-b border-border flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">
              #{ticket.ticket_id} · {ticket.ticket_type_name ?? "Ticket"}
            </p>
            <h2 className="text-base font-semibold leading-snug truncate">
              {ticket.title}
            </h2>
            <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
              {ticket.created_by_username ?? "Unknown"}
              {ticket.created_by_steam_id && (
                <> · Steam {ticket.created_by_steam_id}</>
              )}{" "}
              · {timeAgo(ticket.created_at)}
            </p>
          </div>
          <span
            className={
              "shrink-0 text-[9px] font-mono uppercase tracking-widest px-2 py-1 ring-1 rounded " +
              (STATUS_TONE[ticket.status] ?? "text-muted-foreground ring-border bg-surface")
            }
          >
            {STATUS_LABEL[ticket.status] ?? ticket.status}
          </span>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Status */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground font-mono">Status:</span>
            {["open", "waiting_response", "closed"].map((s) => (
              <button
                key={s}
                disabled={updatingStatus || ticket.status === s}
                onClick={() => updateStatus(s)}
                className={
                  "text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 ring-1 rounded transition-opacity " +
                  (ticket.status === s
                    ? (STATUS_TONE[s] ?? "") + " opacity-100"
                    : "ring-border text-muted-foreground hover:bg-surface/70 opacity-60 hover:opacity-100")
                }
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>

          {/* Priority */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground font-mono">Priority:</span>
            {["urgent", "high", "normal", "low"].map((p) => (
              <button
                key={p}
                disabled={updatingPriority || ticket.priority === p}
                onClick={() => updatePriority(p)}
                className={
                  "text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 ring-1 rounded transition-opacity " +
                  (ticket.priority === p
                    ? (PRIORITY_TONE[p] ?? "") + " ring-current opacity-100"
                    : "ring-border text-muted-foreground hover:bg-surface/70 opacity-60 hover:opacity-100")
                }
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>

          {/* Assign */}
          {ticket.assigned_to !== session?.userId && (
            <button
              onClick={assignToSelf}
              className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 ring-1 ring-brand/30 text-brand rounded hover:bg-brand/10 transition-colors"
            >
              Assign to me
            </button>
          )}
          {ticket.assigned_to_username && (
            <span className="text-[10px] font-mono text-muted-foreground">
              → {ticket.assigned_to_username}
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
        {messages.map((msg) => {
          const isStaff = msg.userId !== ticket.created_by;
          return (
            <div key={msg.messageId} className={`flex gap-3 ${isStaff ? "flex-row-reverse" : ""}`}>
              <div
                className={
                  "size-7 shrink-0 rounded-full ring-1 grid place-items-center text-[10px] font-bold " +
                  (isStaff
                    ? "bg-brand/10 ring-brand/30 text-brand"
                    : "bg-surface ring-border text-muted-foreground")
                }
              >
                {(msg.username ?? "?")[0].toUpperCase()}
              </div>
              <div className={`max-w-[75%] space-y-1 ${isStaff ? "items-end" : ""}`}>
                <div className="flex items-center gap-2">
                  <p className="text-[10px] font-mono text-muted-foreground">
                    {msg.username ?? "Unknown"}
                    {isStaff && (
                      <span className="ml-1 text-brand">· Staff</span>
                    )}
                  </p>
                  <p className="text-[10px] font-mono text-muted-foreground/60">
                    {timeAgo(msg.createdAt)}
                  </p>
                </div>
                <div
                  className={
                    "px-3 py-2 rounded-lg text-sm ring-1 whitespace-pre-wrap break-words " +
                    (isStaff
                      ? "bg-brand/10 ring-brand/20 text-foreground"
                      : "bg-surface ring-border text-foreground")
                  }
                >
                  {msg.message}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Reply box */}
      <div className="px-5 py-4 border-t border-border space-y-2">
        {isClosed ? (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              This ticket is closed.
            </p>
            <button
              onClick={() => updateStatus("open")}
              className="text-xs text-brand hover:underline font-semibold"
            >
              Reopen
            </button>
          </div>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Reply to this ticket…"
              rows={3}
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendReply();
              }}
            />
            {sendError && (
              <p className="text-xs text-danger">{sendError}</p>
            )}
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground">
                Ctrl+Enter to send
              </p>
              <button
                onClick={sendReply}
                disabled={sending || !draft.trim()}
                className="px-4 py-1.5 bg-brand text-brand-foreground rounded text-xs font-semibold disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                {sending ? "Sending…" : "Send reply"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TicketsPage() {
  const { realRankOf } = useAuth();
  const orgId = useManageOrgId();
  const [session, setSession] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedTicketId, setSelectedTicketId] = useState(null);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setSession(data?.user ?? null))
      .catch(() => {});
  }, []);

  async function loadTickets() {
    if (!orgId) return;
    setTicketsLoading(true);
    try {
      const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/tickets${qs}`, {
        credentials: "include",
      });
      if (res.ok) {
        const body = await res.json();
        setTickets(body.tickets ?? []);
      }
    } finally {
      setTicketsLoading(false);
    }
  }

  useEffect(() => {
    setSelectedTicketId(null);
    loadTickets();
  }, [orgId, statusFilter]);

  if (!orgId) return null;

  const rank = realRankOf(orgId);

  return (
    <GateRank rank={rank} required={2}>
      <SectionHeader
        title="Support Queue"
        blurb="View and respond to tickets submitted by your community."
      />

      <div
        className="flex gap-0 ring-1 ring-border rounded-lg overflow-hidden"
        style={{ height: "calc(100vh - 260px)", minHeight: "400px" }}
      >
        {/* Left: ticket list */}
        <div className="w-72 shrink-0 border-r border-border flex flex-col overflow-hidden">
          {/* Filter bar */}
          <div className="px-3 py-2.5 border-b border-border flex items-center gap-1.5 flex-wrap">
            {STATUS_OPTS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setStatusFilter(opt.value)}
                className={
                  "text-[9px] font-mono uppercase tracking-widest px-2 py-0.5 rounded ring-1 transition-colors " +
                  (statusFilter === opt.value
                    ? "bg-brand text-brand-foreground ring-brand"
                    : "ring-border text-muted-foreground hover:bg-surface/70")
                }
              >
                {opt.label}
              </button>
            ))}
            <button
              onClick={loadTickets}
              className="ml-auto text-[9px] font-mono text-muted-foreground hover:text-foreground transition-colors uppercase tracking-widest"
              title="Refresh"
            >
              ↺
            </button>
          </div>

          {/* Ticket list */}
          <div className="flex-1 overflow-y-auto">
            {ticketsLoading ? (
              <div className="p-4">
                <p className="text-sm text-muted-foreground">Loading…</p>
              </div>
            ) : tickets.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-sm text-muted-foreground">No tickets.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {tickets.map((t) => {
                  const active = selectedTicketId === t.ticket_id;
                  return (
                    <li key={t.ticket_id}>
                      <button
                        onClick={() => setSelectedTicketId(t.ticket_id)}
                        className={
                          "w-full text-left px-3 py-3 transition-colors " +
                          (active ? "bg-surface" : "hover:bg-surface/50")
                        }
                      >
                        <div className="flex items-start gap-2 mb-0.5">
                          <p className="text-xs font-medium flex-1 leading-snug line-clamp-2">
                            {t.title}
                          </p>
                          <span
                            className={
                              "shrink-0 text-[8px] font-mono uppercase tracking-widest px-1 py-0.5 ring-1 rounded " +
                              (STATUS_TONE[t.status] ?? "text-muted-foreground ring-border bg-surface")
                            }
                          >
                            {STATUS_LABEL[t.status] ?? t.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={
                              "text-[9px] font-mono uppercase tracking-wider " +
                              (PRIORITY_TONE[t.priority] ?? "text-muted-foreground")
                            }
                          >
                            {PRIORITY_LABEL[t.priority] ?? t.priority}
                          </span>
                          <span className="text-[9px] font-mono text-muted-foreground truncate flex-1">
                            · {t.ticket_type_name ?? "Ticket"}
                          </span>
                          <span className="text-[9px] font-mono text-muted-foreground/60 shrink-0">
                            {timeAgo(t.updated_at)}
                          </span>
                        </div>
                        {t.created_by_username && (
                          <p className="text-[9px] font-mono text-muted-foreground/50 mt-0.5 truncate">
                            {t.created_by_username}
                            {t.created_by_steam_id && (
                              <> · {t.created_by_steam_id}</>
                            )}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Right: thread */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {selectedTicketId === null ? (
            <div className="flex-1 grid place-items-center">
              <p className="text-sm text-muted-foreground">
                Select a ticket to view the thread.
              </p>
            </div>
          ) : (
            <TicketThread
              key={selectedTicketId}
              orgId={orgId}
              ticketId={selectedTicketId}
              session={session}
              onStatusChange={loadTickets}
            />
          )}
        </div>
      </div>
    </GateRank>
  );
}

export { Route };


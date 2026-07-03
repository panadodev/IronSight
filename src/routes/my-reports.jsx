import { SiteNav } from "@/components/site-nav";
import { Markdown } from "@/components/markdown";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const Route = createFileRoute("/my-reports")({
  validateSearch: (s) => ({
    org: typeof s.org === "string" ? s.org : void 0,
    ticket: typeof s.ticket === "number" ? s.ticket : void 0,
  }),
  head: () => ({
    meta: [
      { title: "My Tickets" },
      {
        name: "description",
        content: "Chat with staff on your tickets and track their status.",
      },
    ],
  }),
  component: MyTicketsPage,
});

const STATUS_TONE = {
  open: "text-brand ring-brand/30 bg-brand/10",
  waiting_response: "text-warning ring-warning/30 bg-warning/10",
  closed: "text-muted-foreground ring-border bg-surface",
};
const STATUS_LABEL = {
  open: "Open",
  waiting_response: "Waiting for you",
  closed: "Closed",
};
const PRIORITY_TONE = {
  urgent: "text-danger",
  high: "text-warning",
  normal: "text-muted-foreground",
  low: "text-muted-foreground/60",
};

function timeAgo(unixTs) {
  const diff = Math.floor(Date.now() / 1000) - unixTs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function MyTicketsPage() {
  const { ticket: openTicketId } = Route.useSearch();

  const [session, setSession] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [tickets, setTickets] = useState([]);
  const [ticketsLoaded, setTicketsLoaded] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(openTicketId ?? null);
  const [ticketDetail, setTicketDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  // Load session
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) {
          setSession(data?.user ?? null);
          setSessionChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) setSessionChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load ticket list
  useEffect(() => {
    if (!sessionChecked || !session) return;
    let cancelled = false;
    fetch("/api/tickets/mine", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { tickets: [] }))
      .then((data) => {
        if (!cancelled) {
          setTickets(data.tickets ?? []);
          setTicketsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setTicketsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionChecked, session]);

  // Load ticket detail when selectedTicket changes
  useEffect(() => {
    if (!selectedTicket) {
      setTicketDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setTicketDetail(null);
    fetch(`/api/tickets/${selectedTicket}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) {
          setTicketDetail(data);
          setDetailLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTicket]);

  async function sendReply() {
    if (!draft.trim() || !selectedTicket) return;
    setSending(true);
    setSendError("");
    try {
      const res = await fetch(`/api/tickets/${selectedTicket}/messages`, {
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
      // Reload detail
      const detail = await fetch(`/api/tickets/${selectedTicket}`, {
        credentials: "include",
      });
      if (detail.ok) setTicketDetail(await detail.json());
      // Refresh list
      const list = await fetch("/api/tickets/mine", { credentials: "include" });
      if (list.ok) {
        const body = await list.json();
        setTickets(body.tickets ?? []);
      }
    } catch {
      setSendError("Network error.");
    } finally {
      setSending(false);
    }
  }

  if (!sessionChecked) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center">
          <p className="text-sm text-muted-foreground">Loading\u2026</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="text-center max-w-sm">
            <h1 className="text-xl font-semibold mb-2">
              Sign in to view your tickets
            </h1>
            <p className="text-sm text-muted-foreground mb-6">
              You need to be signed in to see your tickets.
            </p>
            <Link
              to="/support"
              className="inline-flex px-4 py-2 bg-brand text-brand-foreground rounded text-sm font-semibold"
            >
              Go to Support
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-hidden flex">
        {/* Ticket list */}
        <div className="w-80 shrink-0 border-r border-border flex flex-col">
          <div className="p-4 border-b border-border">
            <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-1">
              Player Portal
            </p>
            <h1 className="text-lg font-semibold">My Tickets</h1>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!ticketsLoaded ? (
              <div className="p-4">
                <p className="text-sm text-muted-foreground">Loading\u2026</p>
              </div>
            ) : tickets.length === 0 ? (
              <div className="p-6 text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  You have no tickets yet.
                </p>
                <Link
                  to="/support"
                  className="inline-flex px-4 py-2 bg-brand text-brand-foreground rounded text-xs font-semibold uppercase tracking-wider"
                >
                  Submit a ticket
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {tickets.map((t) => {
                  const active = selectedTicket === t.ticket_id;
                  return (
                    <li key={t.ticket_id}>
                      <button
                        onClick={() => setSelectedTicket(t.ticket_id)}
                        className={
                          "w-full text-left px-4 py-3 transition-colors " +
                          (active ? "bg-surface" : "hover:bg-surface/50")
                        }
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <p className="text-sm font-medium truncate flex-1">
                            {t.title}
                          </p>
                          <span
                            className={
                              "shrink-0 text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 ring-1 rounded " +
                              (STATUS_TONE[t.status] ??
                                "text-muted-foreground ring-border bg-surface")
                            }
                          >
                            {STATUS_LABEL[t.status] ?? t.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <p className="text-[10px] font-mono text-muted-foreground truncate">
                            {t.ticket_type_name ?? "Ticket"} \u00b7{" "}
                            {t.org_name ?? t.org_id}
                          </p>
                          <p className="text-[10px] font-mono text-muted-foreground ml-auto shrink-0">
                            {timeAgo(t.updated_at)}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="p-3 border-t border-border">
            <Link
              to="/support"
              className="w-full flex items-center justify-center px-3 py-2 bg-brand text-brand-foreground rounded text-xs font-semibold uppercase tracking-wider hover:opacity-90"
            >
              New ticket
            </Link>
          </div>
        </div>

        {/* Ticket detail */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!selectedTicket ? (
            <div className="flex-1 grid place-items-center">
              <p className="text-sm text-muted-foreground">
                Select a ticket to view it.
              </p>
            </div>
          ) : detailLoading ? (
            <div className="flex-1 grid place-items-center">
              <p className="text-sm text-muted-foreground">Loading\u2026</p>
            </div>
          ) : !ticketDetail ? (
            <div className="flex-1 grid place-items-center">
              <p className="text-sm text-muted-foreground">
                Failed to load ticket.
              </p>
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="p-4 border-b border-border shrink-0">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-mono text-muted-foreground mb-0.5">
                      #{ticketDetail.ticket.ticket_id} \u00b7{" "}
                      {ticketDetail.ticket.ticket_type_name ?? "Ticket"} \u00b7{" "}
                      {ticketDetail.ticket.org_id}
                    </p>
                    <h2 className="text-base font-semibold truncate">
                      {ticketDetail.ticket.title}
                    </h2>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={
                        "text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 ring-1 rounded " +
                        (STATUS_TONE[ticketDetail.ticket.status] ??
                          "text-muted-foreground ring-border bg-surface")
                      }
                    >
                      {STATUS_LABEL[ticketDetail.ticket.status] ??
                        ticketDetail.ticket.status}
                    </span>
                    <span
                      className={
                        "text-[9px] font-mono uppercase tracking-widest " +
                        (PRIORITY_TONE[ticketDetail.ticket.priority] ??
                          "text-muted-foreground")
                      }
                    >
                      {ticketDetail.ticket.priority}
                    </span>
                  </div>
                </div>
                {ticketDetail.ticket.assigned_to_username && (
                  <p className="text-[10px] font-mono text-muted-foreground mt-1">
                    Assigned to: {ticketDetail.ticket.assigned_to_username}
                  </p>
                )}
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {Array.isArray(ticketDetail.ticket.form_data) &&
                  ticketDetail.ticket.form_data.length > 0 && (
                    <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-3">
                      <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                        Your submission
                      </p>
                      {ticketDetail.ticket.form_data.map((f, i) => (
                        <div key={i}>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
                            {f.label}
                          </p>
                          <p className="text-sm whitespace-pre-wrap break-words">
                            {f.value}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                {ticketDetail.messages.map((msg) => {
                  const isMe = msg.userId === session.userId;
                  return (
                    <div
                      key={msg.messageId}
                      className={
                        isMe ? "flex justify-end" : "flex justify-start"
                      }
                    >
                      <div
                        className={
                          "max-w-xl rounded-lg px-4 py-3 " +
                          (isMe
                            ? "bg-brand/10 ring-1 ring-brand/20"
                            : "bg-surface/60 ring-1 ring-border")
                        }
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-semibold">
                            {isMe ? "You" : (msg.username ?? "Staff")}
                          </span>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {timeAgo(msg.createdAt)}
                          </span>
                        </div>
                        <Markdown className="text-sm">{msg.message}</Markdown>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Reply box */}
              {ticketDetail.ticket.status !== "closed" && (
                <div className="p-4 border-t border-border shrink-0 space-y-2">
                  {sendError && (
                    <p className="text-xs text-danger">{sendError}</p>
                  )}
                  <div className="flex gap-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Type your reply..."
                      rows={3}
                      className="flex-1 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-none"
                    />
                    <button
                      onClick={sendReply}
                      disabled={!draft.trim() || sending}
                      className="px-4 py-2 bg-brand text-brand-foreground text-xs font-semibold rounded hover:opacity-90 disabled:opacity-40 self-end"
                    >
                      {sending ? "Sending\u2026" : "Send"}
                    </button>
                  </div>
                </div>
              )}
              {ticketDetail.ticket.status === "closed" && (
                <div className="p-4 border-t border-border shrink-0">
                  <p className="text-xs text-muted-foreground text-center">
                    This ticket is closed. To continue, please open a new
                    ticket.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export { Route };

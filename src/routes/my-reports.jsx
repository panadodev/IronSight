import { SiteNav } from "@/components/site-nav";
import { Markdown } from "@/components/markdown";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

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
  const [dmToggling, setDmToggling] = useState(false);
  const [dmFeedback, setDmFeedback] = useState(null);
  const dmFeedbackTimerRef = useRef(null);

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

  // Clear DM feedback when switching tickets
  useEffect(() => {
    setDmFeedback(null);
    clearTimeout(dmFeedbackTimerRef.current);
  }, [selectedTicket]);

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

  async function toggleDmNotifications() {
    if (!selectedTicket || !ticketDetail || dmToggling) return;
    const currentlyEnabled = ticketDetail.ticket.dm_notifications_enabled;
    const enabling = !currentlyEnabled;
    setDmToggling(true);
    setDmFeedback(null);
    try {
      const res = await fetch(
        `/api/tickets/${selectedTicket}/dm-notifications`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: enabling }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setDmFeedback({ type: "error", message: data?.error ?? "Failed." });
        return;
      }
      // Optimistically update the ticket detail
      setTicketDetail((prev) =>
        prev
          ? {
              ...prev,
              ticket: {
                ...prev.ticket,
                dm_notifications_enabled: enabling,
              },
            }
          : prev,
      );
      if (!enabling) {
        setDmFeedback({ type: "info", message: "Notifications disabled." });
      } else if (data.dmStatus === "sent") {
        if (!data.inGuild) {
          setDmFeedback({
            type: "warn",
            message: "Test DM sent! You're not in the community Discord server.",
            inviteUrl: data.inviteUrl,
          });
        } else {
          setDmFeedback({ type: "ok", message: "Test DM sent! You'll be notified on new replies." });
        }
      } else if (data.dmStatus === "dms_closed") {
        setDmFeedback({
          type: "warn",
          message: "Notifications enabled, but your Discord DMs are closed for this server. Open your Discord privacy settings to allow DMs.",
          inviteUrl: data.inGuild ? null : data.inviteUrl,
        });
      } else if (data.dmStatus === "not_sharing_server") {
        setDmFeedback({
          type: "warn",
          message: "Notifications enabled, but the bot can't reach you — you must share a Discord server with the bot.",
          inviteUrl: data.inviteUrl,
        });
      } else if (data.dmStatus === "no_discord") {
        setDmFeedback({
          type: "warn",
          message: "Notifications enabled, but no Discord account is linked to your session.",
        });
      } else {
        setDmFeedback({ type: "ok", message: "Notifications enabled." });
      }
      clearTimeout(dmFeedbackTimerRef.current);
      dmFeedbackTimerRef.current = setTimeout(
        () => setDmFeedback(null),
        12000,
      );
    } catch {
      setDmFeedback({ type: "error", message: "Network error." });
    } finally {
      setDmToggling(false);
    }
  }

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
            <p className="text-[0.625rem] font-mono uppercase tracking-widest text-brand mb-1">
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
                              "shrink-0 text-[0.625rem] font-mono uppercase tracking-widest px-1.5 py-0.5 ring-1 rounded " +
                              (STATUS_TONE[t.status] ??
                                "text-muted-foreground ring-border bg-surface")
                            }
                          >
                            {STATUS_LABEL[t.status] ?? t.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <p className="text-[0.625rem] font-mono text-muted-foreground truncate">
                            {t.ticket_type_name ?? "Ticket"} \u00b7{" "}
                            {t.org_name ?? t.org_id}
                          </p>
                          <p className="text-[0.625rem] font-mono text-muted-foreground ml-auto shrink-0">
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
                    <p className="text-[0.625rem] font-mono text-muted-foreground mb-0.5">
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
                        "text-[0.625rem] font-mono uppercase tracking-widest px-1.5 py-0.5 ring-1 rounded " +
                        (STATUS_TONE[ticketDetail.ticket.status] ??
                          "text-muted-foreground ring-border bg-surface")
                      }
                    >
                      {STATUS_LABEL[ticketDetail.ticket.status] ??
                        ticketDetail.ticket.status}
                    </span>
                    {ticketDetail.ticket.created_by === session?.userId && (
                      <button
                        onClick={toggleDmNotifications}
                        disabled={dmToggling}
                        title={
                          ticketDetail.ticket.dm_notifications_enabled
                            ? "Disable Discord DM notifications"
                            : "Enable Discord DM notifications"
                        }
                        className={
                          "flex items-center justify-center w-7 h-7 rounded transition-colors disabled:opacity-40 " +
                          (ticketDetail.ticket.dm_notifications_enabled
                            ? "text-brand bg-brand/10 ring-1 ring-brand/30 hover:bg-brand/20"
                            : "text-muted-foreground hover:text-foreground hover:bg-surface")
                        }
                      >
                        {ticketDetail.ticket.dm_notifications_enabled ? (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            className="w-4 h-4"
                          >
                            <path d="M4.214 3.227a.75.75 0 0 0-1.156-.956 8.97 8.97 0 0 0-1.856 3.826.75.75 0 0 0 1.466.316 7.47 7.47 0 0 1 1.546-3.186ZM16.942 2.271a.75.75 0 0 0-1.157.956 7.47 7.47 0 0 1 1.547 3.186.75.75 0 0 0 1.466-.316 8.971 8.971 0 0 0-1.856-3.826Z" />
                            <path
                              fillRule="evenodd"
                              d="M10 2a6 6 0 0 0-6 6c0 1.887-.454 3.665-1.257 5.234a.75.75 0 0 0 .515 1.076 32.91 32.91 0 0 0 3.256.508 3.5 3.5 0 0 0 6.972 0 32.91 32.91 0 0 0 3.256-.508.75.75 0 0 0 .515-1.076A11.448 11.448 0 0 1 16 8a6 6 0 0 0-6-6Zm0 14.5a2 2 0 0 1-1.95-1.557 33.54 33.54 0 0 0 3.9 0A2 2 0 0 1 10 16.5Z"
                              clipRule="evenodd"
                            />
                          </svg>
                        ) : (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.5}
                            stroke="currentColor"
                            className="w-4 h-4"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
                            />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                </div>
                {ticketDetail.ticket.assigned_to_username && (
                  <p className="text-[0.625rem] font-mono text-muted-foreground mt-1">
                    Assigned to: {ticketDetail.ticket.assigned_to_username}
                  </p>
                )}
                {dmFeedback && (
                  <div
                    className={
                      "mt-2 rounded px-3 py-2 text-xs flex items-start gap-2 " +
                      (dmFeedback.type === "ok"
                        ? "bg-green-500/10 text-green-400 ring-1 ring-green-500/20"
                        : dmFeedback.type === "warn"
                          ? "bg-warning/10 text-warning ring-1 ring-warning/20"
                          : dmFeedback.type === "error"
                            ? "bg-danger/10 text-danger ring-1 ring-danger/20"
                            : "bg-surface text-muted-foreground ring-1 ring-border")
                    }
                  >
                    <span className="flex-1">{dmFeedback.message}</span>
                    {dmFeedback.inviteUrl && (
                      <a
                        href={dmFeedback.inviteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 underline font-semibold"
                      >
                        Join server
                      </a>
                    )}
                    <button
                      onClick={() => setDmFeedback(null)}
                      className="shrink-0 opacity-60 hover:opacity-100"
                    >
                      \u00d7
                    </button>
                  </div>
                )}
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {Array.isArray(ticketDetail.ticket.form_data) &&
                  ticketDetail.ticket.form_data.length > 0 && (
                    <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-3">
                      <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
                        Your submission
                      </p>
                      {ticketDetail.ticket.form_data.map((f, i) => (
                        <div key={i}>
                          <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
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
                          <span className="text-[0.625rem] font-semibold">
                            {isMe ? "You" : (msg.username ?? "Staff")}
                          </span>
                          <span className="text-[0.625rem] text-muted-foreground font-mono">
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

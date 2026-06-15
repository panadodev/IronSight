import { SectionHeader } from "@/components/manage-section";
import { PredefineSearch } from "@/components/predefine-search";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const Route = createFileRoute("/manage/tickets")({
  component: TicketsPage,
});

// ── Ticket type display helpers ──────────────────────────────────────────────

const TYPE_COLORS = {
  "player report":   "hsl(0 75% 60%)",
  "ban appeal":      "hsl(35 90% 55%)",
  "vip issue":       "hsl(265 75% 65%)",
  "general support": "hsl(195 80% 55%)",
};

const TYPE_SHORT = {
  "player report":   "Report",
  "ban appeal":      "Appeal",
  "vip issue":       "VIP",
  "general support": "Support",
};

function typeColor(name) {
  return TYPE_COLORS[(name ?? "").toLowerCase()] ?? "hsl(220 13% 55%)";
}

function typeShort(name) {
  return TYPE_SHORT[(name ?? "").toLowerCase()] ?? (name || "Ticket");
}

// ── Priority / Status constants ──────────────────────────────────────────────

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

const PRIORITY_TONE = {
  urgent: "text-danger font-semibold",
  high:   "text-warning",
  normal: "text-muted-foreground",
  low:    "text-muted-foreground/60",
};
const PRIORITY_LABEL = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };

const STATUS_TONE = {
  open:              "text-brand ring-brand/30 bg-brand/10",
  waiting_response:  "text-warning ring-warning/30 bg-warning/10",
  closed:            "text-muted-foreground ring-border bg-surface",
};
const STATUS_LABEL = { open: "Open", waiting_response: "Waiting", closed: "Closed" };

function timeAgo(unixTs) {
  const diff = Math.floor(Date.now() / 1000) - unixTs;
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── TicketThread (right pane) ────────────────────────────────────────────────

function TicketThread({ orgId, ticketId, session, onStatusChange }) {
  const [detail, setDetail]             = useState(null);
  const [loading, setLoading]           = useState(true);
  const [composerMode, setComposerMode] = useState("reply"); // "reply" | "note"
  const [draft, setDraft]               = useState("");
  const [waitForResponse, setWaitForResponse] = useState(false);
  const [sending, setSending]           = useState(false);
  const [sendError, setSendError]       = useState("");
  const [updatingStatus, setUpdatingStatus]   = useState(false);
  const [updatingPriority, setUpdatingPriority] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const messagesEndRef = useRef(null);

  async function loadDetail() {
    setLoading(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, { credentials: "include" });
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
    setComposerMode("reply");
    setWaitForResponse(false);
    setConfirmClose(false);
    loadDetail();
  }, [ticketId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages]);

  async function sendMessage() {
    if (!draft.trim()) return;
    const isNote = composerMode === "note";
    setSending(true);
    setSendError("");
    try {
      const res = await fetch(`/api/tickets/${ticketId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: draft.trim(), isInternal: isNote }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendError(data?.error ?? "Failed to send.");
        return;
      }
      setDraft("");
      setWaitForResponse(false);
      // If staff wants to set ticket to waiting after their reply
      if (!isNote && waitForResponse) {
        await fetch(`/api/tickets/${ticketId}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "waiting_response" }),
        });
      }
      await loadDetail();
      onStatusChange?.();
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
    } catch { /* ignore */ }
  }

  async function unassign() {
    try {
      await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedTo: null }),
      });
      await loadDetail();
      onStatusChange?.();
    } catch { /* ignore */ }
  }

  function requestClose() {
    if (!detail) return;
    const { ticket, messages } = detail;
    // Check if last public message is from the ticket creator
    const publicMsgs = messages.filter((m) => !m.isInternal);
    const lastPublic = publicMsgs[publicMsgs.length - 1];
    if (lastPublic && lastPublic.userId === ticket.created_by) {
      setConfirmClose(true);
    } else {
      updateStatus("closed");
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
  const isClosed  = ticket.status === "closed";
  const isWaiting = ticket.status === "waiting_response";
  const statusDot = isClosed ? "bg-danger" : isWaiting ? "bg-warning" : "bg-success";

  // First message is the original ticket description
  const [originMsg, ...threadMsgs] = messages;
  const isAssignedToMe = ticket.assigned_to === session?.userId;

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">

      {/* ── Header ── */}
      <div className="px-5 py-3 border-b border-border space-y-2">

        {/* Row 1: status dot · id · title · status badge */}
        <div className="flex items-center gap-2 min-w-0">
          <span className={`size-2 rounded-full shrink-0 ${statusDot}`} title={STATUS_LABEL[ticket.status]} />
          <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{ticket.ticket_id}</span>
          <h2 className="text-sm font-semibold leading-snug truncate flex-1 min-w-0">
            {ticket.title}
          </h2>
          <span
            className={
              "shrink-0 text-[9px] font-mono uppercase tracking-widest px-2 py-0.5 ring-1 rounded " +
              (STATUS_TONE[ticket.status] ?? "text-muted-foreground ring-border bg-surface")
            }
          >
            {STATUS_LABEL[ticket.status] ?? ticket.status}
          </span>
        </div>

        {/* Row 2: type · creator · time */}
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground flex-wrap">
          <span
            className="font-semibold"
            style={{ color: typeColor(ticket.ticket_type_name) }}
          >
            {typeShort(ticket.ticket_type_name)}
          </span>
          <span>·</span>
          <span>{ticket.created_by_username ?? "Unknown"}</span>
          {ticket.created_by_steam_id && (
            <>
              <span>·</span>
              <span className="text-muted-foreground/70">{ticket.created_by_steam_id}</span>
            </>
          )}
          <span>·</span>
          <span>{timeAgo(ticket.created_at)}</span>
        </div>

        {/* Row 3: assignee + status + priority controls */}
        <div className="flex items-center gap-2 flex-wrap">

          {/* Assignee */}
          <div className="flex items-center h-7 bg-surface border border-border rounded-md overflow-hidden">
            <span className="text-[10px] text-muted-foreground pl-2 pr-1">→</span>
            {ticket.assigned_to_username ? (
              <span className="text-xs font-mono pr-2">{ticket.assigned_to_username}</span>
            ) : (
              <span className="text-[10px] text-muted-foreground/60 pr-2">Unassigned</span>
            )}
            {!isAssignedToMe && (
              <button
                onClick={assignToSelf}
                className="text-[10px] font-semibold uppercase tracking-wider text-brand hover:text-brand/80 px-2 h-full border-l border-border"
              >
                Claim
              </button>
            )}
            {isAssignedToMe && (
              <button
                onClick={unassign}
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-danger px-2 h-full border-l border-border"
                title="Unassign"
              >
                ×
              </button>
            )}
          </div>

          {/* Status buttons */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground font-mono">Status:</span>
            {["open", "waiting_response"].map((s) => (
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

          {/* Priority buttons */}
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

          {/* Close / Reopen */}
          {isClosed ? (
            <button
              onClick={() => updateStatus("open")}
              disabled={updatingStatus}
              className="ml-auto text-[9px] font-mono uppercase tracking-wider px-3 py-0.5 ring-1 ring-brand/30 text-brand bg-brand/10 rounded hover:bg-brand/20 transition-colors"
            >
              Reopen
            </button>
          ) : (
            <button
              onClick={requestClose}
              disabled={updatingStatus}
              className="ml-auto text-[9px] font-mono uppercase tracking-wider px-3 py-0.5 ring-1 ring-danger bg-danger text-danger-foreground rounded hover:opacity-90 transition-opacity"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* ── Messages thread ── */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5 min-h-0">

        {/* Original ticket card */}
        {originMsg && (
          <div className="max-w-[60ch] bg-surface/40 ring-1 ring-border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Original ticket
              </span>
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-mono text-muted-foreground">
                {timeAgo(ticket.created_at)}
              </span>
            </div>
            <h3 className="text-xs font-semibold">{ticket.title}</h3>
            <p className="text-xs text-muted-foreground/90 leading-relaxed whitespace-pre-wrap">
              {originMsg.message}
            </p>
          </div>
        )}

        {/* Thread messages */}
        {threadMsgs.map((msg) => {
          if (msg.isInternal) {
            return (
              <div
                key={msg.messageId}
                className="max-w-[60ch] ml-auto p-4 rounded-lg border bg-brand/5 border-brand/10"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-brand">
                    Internal Note
                  </span>
                  <span className="h-px flex-1 bg-brand/10" />
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {timeAgo(msg.createdAt)}
                  </span>
                </div>
                <p className="text-[10px] font-mono text-brand/80 mb-1">{msg.username ?? "Staff"}</p>
                <p className="text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap">
                  {msg.message}
                </p>
              </div>
            );
          }

          const isStaff = msg.userId !== ticket.created_by;
          return (
            <div key={msg.messageId} className="flex items-start gap-3 max-w-[60ch]">
              <div
                className={
                  "size-8 rounded-sm shrink-0 grid place-items-center font-mono text-xs font-bold " +
                  (isStaff
                    ? "bg-brand/20 text-brand"
                    : "bg-surface-bright text-foreground")
                }
              >
                {(msg.username ?? "?").replace(/[\[\]]/g, "").slice(0, 2).toUpperCase()}
              </div>
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{msg.username ?? "Unknown"}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{timeAgo(msg.createdAt)}</span>
                  {isStaff && (
                    <span className="text-[9px] font-bold uppercase tracking-widest text-brand">Staff</span>
                  )}
                </div>
                <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap break-words">
                  {msg.message}
                </p>
              </div>
            </div>
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Composer ── */}
      <div className="px-5 py-4 border-t border-border bg-background">
        {/* Mode tabs */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setComposerMode("reply")}
            className={
              "text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded " +
              (composerMode === "reply"
                ? "bg-surface text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            Reply
          </button>
          <button
            onClick={() => setComposerMode("note")}
            className={
              "text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded " +
              (composerMode === "note"
                ? "bg-brand/10 text-brand"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            Internal Note
          </button>
        </div>

        {composerMode === "reply" && !isClosed && (
          <PredefineSearch
            orgId={orgId}
            onPick={(content) =>
              setDraft((d) => (d ? `${d}${d.endsWith("\n") ? "" : "\n"}${content}` : content))
            }
          />
        )}

        {isClosed && composerMode === "reply" ? (
          <p className="text-xs text-muted-foreground mb-2">
            This ticket is closed. Reopen it to send a public reply, or switch to Internal Note.
          </p>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                composerMode === "reply"
                  ? "Type your response to the player…"
                  : "Leave an internal note for your team…"
              }
              rows={3}
              className="w-full bg-surface/60 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMessage();
              }}
            />
            {sendError && <p className="text-xs text-danger mt-1">{sendError}</p>}
            <div className="flex items-center justify-between mt-2 gap-3">
              {composerMode === "reply" ? (
                <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={waitForResponse}
                    onChange={(e) => setWaitForResponse(e.target.checked)}
                    className="accent-brand"
                  />
                  Set to waiting for response
                </label>
              ) : (
                <span className="text-[10px] text-muted-foreground">Only visible to staff</span>
              )}
              <div className="flex items-center gap-2 shrink-0">
                <p className="text-[10px] text-muted-foreground hidden sm:block">Ctrl+Enter</p>
                <button
                  onClick={sendMessage}
                  disabled={sending || !draft.trim()}
                  className="px-4 py-1.5 bg-brand text-brand-foreground rounded text-xs font-semibold disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                  {sending
                    ? "Sending…"
                    : composerMode === "reply"
                      ? "Send reply"
                      : "Post note"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Confirm close dialog ── */}
      {confirmClose && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center z-50 p-4"
          onClick={() => setConfirmClose(false)}
        >
          <div
            className="bg-background ring-1 ring-border rounded-lg max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[10px] font-mono uppercase tracking-widest text-warning mb-2">
              Heads up
            </p>
            <h3 className="text-lg font-semibold mb-2">Player replied last</h3>
            <p className="text-sm text-muted-foreground mb-6">
              The player sent the most recent message and hasn't received a staff reply yet. Close
              anyway?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { updateStatus("closed"); setConfirmClose(false); }}
                className="px-4 py-2 bg-surface ring-1 ring-border rounded text-xs font-semibold uppercase tracking-wider hover:bg-surface-bright"
              >
                Close anyway
              </button>
              <button
                onClick={() => setConfirmClose(false)}
                className="px-4 py-2 bg-brand text-brand-foreground rounded text-xs font-semibold uppercase tracking-wider"
              >
                Write reply first
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TicketsPage (full layout) ────────────────────────────────────────────────

function TicketsPage() {
  const { orgs, sessionOrgAdminIds, sessionUser } = useAuth();
  const orgId = useManageOrgId();

  const [allTickets, setAllTickets]       = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [queueView, setQueueView]         = useState("active"); // "active" | "waiting" | "closed"
  const [search, setSearch]               = useState("");
  const [typeFilter, setTypeFilter]       = useState("");
  const [sortBy, setSortBy]               = useState("newest");
  const [selectedTicketId, setSelectedTicketId] = useState(null);

  const isMember =
    orgs.some((o) => o.id === orgId) || sessionOrgAdminIds.includes(orgId);

  async function loadTickets() {
    if (!orgId) return;
    setTicketsLoading(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/tickets?limit=200`,
        { credentials: "include" },
      );
      if (res.ok) {
        const body = await res.json();
        setAllTickets(body.tickets ?? []);
      }
    } finally {
      setTicketsLoading(false);
    }
  }

  useEffect(() => {
    setSelectedTicketId(null);
    loadTickets();
  }, [orgId]);

  // Tab counts
  const counts = useMemo(
    () => ({
      active:  allTickets.filter((t) => t.status === "open").length,
      waiting: allTickets.filter((t) => t.status === "waiting_response").length,
      closed:  allTickets.filter((t) => t.status === "closed").length,
    }),
    [allTickets],
  );

  // Derive unique ticket types from loaded data
  const typeOptions = useMemo(
    () => Array.from(new Set(allTickets.map((t) => t.ticket_type_name).filter(Boolean))),
    [allTickets],
  );

  // Filtered + sorted ticket list
  const visible = useMemo(() => {
    let list = allTickets;

    // Queue filter
    if (queueView === "active")  list = list.filter((t) => t.status === "open");
    else if (queueView === "waiting") list = list.filter((t) => t.status === "waiting_response");
    else list = list.filter((t) => t.status === "closed");

    // Type filter (client-side)
    if (typeFilter) list = list.filter((t) => t.ticket_type_name === typeFilter);

    // Search (client-side)
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.created_by_username ?? "").toLowerCase().includes(q) ||
          (t.created_by_steam_id ?? "").includes(q),
      );
    }

    // Sort
    if (sortBy === "priority") {
      list = [...list].sort(
        (a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3),
      );
    }
    // default: already newest-first from API

    return list;
  }, [allTickets, queueView, typeFilter, search, sortBy]);

  // Group: assigned-to-me first, then rest
  const myUserId = sessionUser?.userId;
  const assignedToMe = visible.filter((t) => myUserId && t.assigned_to === myUserId);
  const allOther     = visible.filter((t) => !(myUserId && t.assigned_to === myUserId));

  function renderTicketRow(t) {
    const active = selectedTicketId === t.ticket_id;
    const tColor = typeColor(t.ticket_type_name);
    const tShort = typeShort(t.ticket_type_name);

    return (
      <button
        key={t.ticket_id}
        onClick={() => setSelectedTicketId(t.ticket_id)}
        style={{ borderLeftColor: tColor }}
        className={
          "w-full text-left pl-2.5 pr-3 py-2 cursor-pointer transition-colors block border-l-[3px] " +
          (active ? "bg-surface/70" : "hover:bg-surface/30")
        }
        title={`${tShort} · ${t.created_by_username ?? ""}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-xs font-medium truncate flex-1 min-w-0">
            <span className="font-semibold" style={{ color: tColor }}>
              {tShort}
            </span>
            <span className="text-muted-foreground/50 mx-1.5">·</span>
            <span>{t.created_by_username ?? "Unknown"}</span>
          </h3>
          <span
            className={
              "text-[9px] font-mono uppercase tracking-wider shrink-0 " +
              (PRIORITY_TONE[t.priority] ?? "text-muted-foreground")
            }
          >
            {PRIORITY_LABEL[t.priority] ?? t.priority}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
            {timeAgo(t.updated_at)}
          </span>
        </div>
        <p className="text-[10px] font-mono text-muted-foreground/60 truncate mt-0.5">
          {t.title}
        </p>
      </button>
    );
  }

  if (!orgId) return null;

  if (!isMember) {
    return (
      <div className="rounded-lg ring-1 ring-border bg-surface/40 p-8 text-center space-y-2">
        <ShieldAlert className="size-8 mx-auto text-warning" />
        <h2 className="text-base font-semibold">Insufficient permissions</h2>
        <p className="text-sm text-muted-foreground">
          You need to be a member of this organization to access the support queue.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Support Queue"
        blurb="View and respond to tickets submitted by your community."
      />

      <div
        className="flex gap-0 ring-1 ring-border rounded-lg overflow-hidden"
        style={{ height: "calc(100vh - 260px)", minHeight: "400px" }}
      >
        {/* ── Left: ticket list ── */}
        <aside className="w-72 shrink-0 border-r border-border flex flex-col overflow-hidden bg-background">

          <div className="p-3 border-b border-border space-y-2.5">

            {/* Queue tabs */}
            <div className="flex rounded ring-1 ring-border overflow-hidden text-[10px] font-bold uppercase tracking-wider">
              {[
                ["active",  "Active"],
                ["waiting", "Waiting"],
                ["closed",  "Closed"],
              ].map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setQueueView(v)}
                  className={
                    "flex-1 py-1.5 transition-colors " +
                    (queueView === v
                      ? "bg-brand/15 text-brand"
                      : "bg-surface text-muted-foreground hover:text-foreground")
                  }
                >
                  {label}
                  <span className="ml-1 opacity-60 font-mono">{counts[v]}</span>
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search player, title, Steam ID…"
                className="w-full bg-surface border border-border rounded px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-brand"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground hover:text-foreground px-1"
                >
                  ×
                </button>
              )}
            </div>

            {/* Type filter chips */}
            {typeOptions.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setTypeFilter("")}
                  className={
                    "px-2 py-0.5 text-[10px] font-semibold rounded uppercase transition-colors " +
                    (!typeFilter
                      ? "bg-brand/10 text-brand ring-1 ring-brand/20"
                      : "bg-surface text-muted-foreground ring-1 ring-border hover:text-foreground")
                  }
                >
                  All
                </button>
                {typeOptions.map((type) => {
                  const tc = typeColor(type);
                  const ts = typeShort(type);
                  const active = typeFilter === type;
                  return (
                    <button
                      key={type}
                      onClick={() => setTypeFilter(active ? "" : type)}
                      style={
                        active
                          ? {
                              backgroundColor: `color-mix(in oklab, ${tc} 18%, transparent)`,
                              color: tc,
                              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tc} 35%, transparent)`,
                            }
                          : {
                              color: `color-mix(in oklab, ${tc} 75%, transparent)`,
                              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tc} 25%, transparent)`,
                            }
                      }
                      className="px-2 py-0.5 text-[10px] font-semibold rounded uppercase hover:brightness-125 transition-all"
                    >
                      {ts}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Sort + Refresh */}
            <div className="flex items-center gap-2">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="flex-1 bg-surface border border-border rounded px-2 py-1 text-[11px] font-mono text-foreground focus:outline-none"
              >
                <option value="newest">Newest</option>
                <option value="priority">Priority</option>
              </select>
              <button
                onClick={loadTickets}
                disabled={ticketsLoading}
                className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                title="Refresh"
              >
                ↺
              </button>
            </div>
          </div>

          {/* Ticket list */}
          <div className="flex-1 overflow-y-auto">
            {ticketsLoading ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : visible.length === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground">
                No tickets.
              </p>
            ) : (
              <>
                {assignedToMe.length > 0 && (
                  <div>
                    <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-3 py-1.5 border-b border-border flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-brand">
                        Assigned to You
                      </span>
                      <span className="text-[10px] font-mono bg-brand/10 text-brand px-1.5 py-0.5 rounded">
                        {assignedToMe.length}
                      </span>
                    </div>
                    <div className="divide-y divide-border">
                      {assignedToMe.map(renderTicketRow)}
                    </div>
                  </div>
                )}
                {allOther.length > 0 && (
                  <div>
                    {assignedToMe.length > 0 && (
                      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-3 py-1.5 border-b border-border flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                          All Tickets
                        </span>
                        <span className="text-[10px] font-mono bg-surface px-1.5 py-0.5 rounded text-muted-foreground">
                          {allOther.length}
                        </span>
                      </div>
                    )}
                    <div className="divide-y divide-border">
                      {allOther.map(renderTicketRow)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        {/* ── Right: ticket thread ── */}
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
              session={sessionUser}
              onStatusChange={loadTickets}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export { Route };

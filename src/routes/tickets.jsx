import { SiteNav } from "@/components/site-nav";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  TICKETS,
  TICKET_TYPE_LABEL,
  STATUS_LABEL,
  getPlayer,
  getStaff,
} from "@/lib/mock-data";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Search } from "lucide-react";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/tickets")({
  head: () => ({ meta: [{ title: "Ticket Queue - IronSight" }] }),
  component: TicketsPage,
});

const PRIORITY_META = {
  urgent: {
    card: "bg-rose-500/10 ring-rose-500/30 hover:bg-rose-500/15",
    badge: "border-rose-500/40 text-rose-400 bg-rose-500/10",
  },
  high: {
    card: "bg-orange-500/10 ring-orange-500/30 hover:bg-orange-500/15",
    badge: "border-orange-500/40 text-orange-400 bg-orange-500/10",
  },
  normal: {
    card: "bg-yellow-500/10 ring-yellow-500/30 hover:bg-yellow-500/15",
    badge: "border-yellow-500/40 text-yellow-400 bg-yellow-500/10",
  },
  low: {
    card: "bg-blue-500/10 ring-blue-500/30 hover:bg-blue-500/15",
    badge: "border-blue-500/40 text-blue-400 bg-blue-500/10",
  },
};

function metaFor(priority) {
  return PRIORITY_META[priority] ?? PRIORITY_META.normal;
}

const TICKET_TYPES = [
  "player_report",
  "ban_appeal",
  "vip_issue",
  "general_support",
];

const ACTIVE_STATUSES = new Set([
  "open",
  "in_progress",
  "triage",
  "waiting_response",
]);
const CLOSED_STATUSES = new Set(["closed", "resolved", "cleared", "banned"]);

function TicketsPage() {
  const [view, setView] = useState("queue");
  const [closedSearch, setClosedSearch] = useState("");
  const [selectedTicket, setSelectedTicket] = useState(null);

  const activeTickets = useMemo(
    () => TICKETS.filter((t) => ACTIVE_STATUSES.has(t.status)),
    [],
  );

  const closedTickets = useMemo(() => {
    const q = closedSearch.trim().toLowerCase();
    return TICKETS.filter(
      (t) =>
        CLOSED_STATUSES.has(t.status) &&
        (!q ||
          t.title.toLowerCase().includes(q) ||
          (t.assigneeId
            ? (getStaff(t.assigneeId)?.name ?? "").toLowerCase().includes(q)
            : false)),
    );
  }, [closedSearch]);

  const ticketsByType = useMemo(() => {
    const map = new Map(TICKET_TYPES.map((t) => [t, []]));
    for (const t of activeTickets) {
      if (map.has(t.type)) map.get(t.type).push(t);
    }
    return map;
  }, [activeTickets]);

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1600px] mx-auto px-6 py-5 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Ticket Queue
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Active support tickets from players.
              </p>
            </div>
            <div className="flex items-center gap-0.5 bg-surface/60 ring-1 ring-border rounded-md p-0.5">
              <button
                onClick={() => setView("queue")}
                className={`px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors ${
                  view === "queue"
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Queue
              </button>
              <button
                onClick={() => setView("closed")}
                className={`px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors ${
                  view === "closed"
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Closed
              </button>
            </div>
          </div>

          {view === "queue" ? (
            <QueueView
              ticketsByType={ticketsByType}
              onOpen={setSelectedTicket}
            />
          ) : (
            <ClosedView
              tickets={closedTickets}
              search={closedSearch}
              onSearchChange={setClosedSearch}
              onOpen={setSelectedTicket}
            />
          )}
        </div>
      </main>

      <Dialog
        open={selectedTicket !== null}
        onOpenChange={(open) => !open && setSelectedTicket(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              #{selectedTicket?.number} · {selectedTicket?.title}
            </DialogTitle>
            <DialogDescription>
              {TICKET_TYPE_LABEL[selectedTicket?.type] ?? selectedTicket?.type}{" "}
              · {selectedTicket?.createdLabel}
            </DialogDescription>
          </DialogHeader>
          {selectedTicket && <TicketDetail ticket={selectedTicket} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QueueView({ ticketsByType, onOpen }) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-3 items-start">
      {TICKET_TYPES.map((type) => {
        const tickets = ticketsByType.get(type) ?? [];
        return (
          <div
            key={type}
            className="w-[280px] shrink-0 rounded-md ring-1 ring-border bg-surface/40 flex flex-col max-h-[calc(100vh-200px)]"
          >
            <div className="px-3 py-2.5 border-b border-border flex items-center justify-between gap-2 sticky top-0 bg-surface/80 backdrop-blur rounded-t-md z-10">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">
                  {TICKET_TYPE_LABEL[type]}
                </div>
                <div className="text-[9px] font-mono uppercase tracking-widest text-brand">
                  {tickets.length} ticket{tickets.length !== 1 ? "s" : ""}
                </div>
              </div>
            </div>

            <div className="p-2 space-y-2 overflow-y-auto min-h-[60px]">
              {tickets.length === 0 ? (
                <div className="text-[10px] text-muted-foreground text-center py-8">
                  No active tickets
                </div>
              ) : (
                tickets.map((ticket) => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    onClick={() => onOpen(ticket)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TicketCard({ ticket, onClick }) {
  const meta = metaFor(ticket.priority);
  const reporter = getPlayer(ticket.reporterId);
  const assignee = ticket.assigneeId ? getStaff(ticket.assigneeId) : null;
  return (
    <button
      onClick={onClick}
      className={`group w-full text-left rounded-md ring-1 p-2.5 space-y-1.5 transition-colors ${meta.card}`}
    >
      <div className="flex items-start gap-1.5">
        <span className="text-xs font-medium leading-snug flex-1">
          {ticket.title}
        </span>
        <Badge
          variant="outline"
          className={`text-[9px] font-mono h-4 px-1.5 shrink-0 mt-0.5 ${meta.badge}`}
        >
          {ticket.priority}
        </Badge>
      </div>
      {ticket.summary && (
        <p className="text-[10px] text-muted-foreground line-clamp-2">
          {ticket.summary}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono text-muted-foreground truncate">
          {reporter?.name ?? ticket.reporterId}
        </span>
        {assignee ? (
          <span className="text-[9px] font-mono text-brand shrink-0">
            → {assignee.name}
          </span>
        ) : (
          <span className="text-[10px] font-mono text-muted-foreground">
            {ticket.createdLabel}
          </span>
        )}
      </div>
    </button>
  );
}

function ClosedView({ tickets, search, onSearchChange, onOpen }) {
  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search closed tickets…"
          className="pl-9 h-8 text-sm"
        />
      </div>

      {tickets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-24 text-center">
          <CheckCircle2 className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {search ? "No matching closed tickets" : "No closed tickets"}
          </p>
        </div>
      ) : (
        <div className="ring-1 ring-border rounded-md overflow-hidden">
          <div className="grid grid-cols-[1fr_140px_140px_90px_80px] gap-3 px-3 py-2 border-b border-border bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            <div>Ticket</div>
            <div>Type</div>
            <div>Assignee</div>
            <div>Status</div>
            <div>Age</div>
          </div>
          {tickets.map((ticket) => {
            const assignee = ticket.assigneeId
              ? getStaff(ticket.assigneeId)
              : null;
            return (
              <button
                key={ticket.id}
                onClick={() => onOpen(ticket)}
                className="w-full grid grid-cols-[1fr_140px_140px_90px_80px] gap-3 px-3 py-2.5 border-b border-border last:border-0 items-center text-left hover:bg-surface/60 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{ticket.title}</p>
                  {ticket.summary && (
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                      {ticket.summary}
                    </p>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {TICKET_TYPE_LABEL[ticket.type] ?? ticket.type}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {assignee?.name ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {STATUS_LABEL[ticket.status] ?? ticket.status}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground">
                  {ticket.createdLabel}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TicketDetail({ ticket }) {
  const reporter = getPlayer(ticket.reporterId);
  const assignee = ticket.assigneeId ? getStaff(ticket.assigneeId) : null;
  const meta = metaFor(ticket.priority);
  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-[9px] font-mono uppercase tracking-widest px-2 py-0.5 rounded ring-1 ${meta.badge}`}
        >
          {ticket.priority}
        </span>
        <span className="text-[9px] font-mono uppercase tracking-widest px-2 py-0.5 rounded ring-1 ring-border bg-surface text-muted-foreground">
          {STATUS_LABEL[ticket.status] ?? ticket.status}
        </span>
      </div>

      {ticket.summary && (
        <p className="text-sm text-muted-foreground">{ticket.summary}</p>
      )}

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="space-y-0.5">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Reporter
          </p>
          <p className="font-medium">{reporter?.name ?? ticket.reporterId}</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Assignee
          </p>
          <p className="font-medium">{assignee?.name ?? "Unassigned"}</p>
        </div>
      </div>

      {ticket.messages.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Activity ({ticket.messages.length})
          </p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {ticket.messages.map((msg, i) => (
              <div
                key={i}
                className={`rounded-md px-3 py-2 text-xs ${
                  msg.authorKind === "system"
                    ? "bg-surface/40 ring-1 ring-border text-muted-foreground font-mono"
                    : msg.authorKind === "staff"
                      ? "bg-brand/10 ring-1 ring-brand/20"
                      : "bg-surface/60 ring-1 ring-border"
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-[10px]">
                    {msg.authorName}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {msg.timestamp}
                  </span>
                </div>
                <p className="leading-relaxed line-clamp-3">{msg.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

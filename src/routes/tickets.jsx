import { PlayerSidebar } from "@/components/player-sidebar";
import { SiteNav } from "@/components/site-nav";
import {
  SERVERS,
  TEAM_META,
  TICKETS,
  getPlayer,
  getStaff,
} from "@/lib/mock-data";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, Lock, Search } from "lucide-react";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/tickets")({
  head: () => ({ meta: [{ title: "Ticket Queue - IronSight" }] }),
  component: TicketsPage,
});

function getOrgId(serverId) {
  if (!serverId) return null;
  return SERVERS.find((s) => s.id === serverId)?.orgId ?? null;
}

function getOrgPrefix(orgId) {
  if (orgId === "willjums") return "WJ";
  if (orgId === "builders_sanctuary") return "BS";
  return orgId ? orgId.slice(0, 2).toUpperCase() : "??";
}

const TYPE_META = {
  cheating:        { label: "Cheating", color: "text-rose-400" },
  teaming:         { label: "Teaming",  color: "text-orange-400" },
  toxicity:        { label: "Toxicity", color: "text-violet-400" },
  other:           { label: "Other",    color: "text-muted-foreground" },
  ban_appeal:      { label: "Appeal",   color: "text-yellow-400" },
  vip_issue:       { label: "VIP",      color: "text-cyan-400" },
  general_support: { label: "Support",  color: "text-green-400" },
};

function ticketMeta(ticket) {
  if (ticket.type === "player_report") return TYPE_META[ticket.category] ?? TYPE_META.other;
  return TYPE_META[ticket.type] ?? TYPE_META.other;
}

const TEAM_BADGE_COLOR = {
  management: "text-pink-400",
  sr_admins:  "text-amber-400",
  admins:     "text-orange-400",
  support:    "text-green-400",
};

const NON_CLOSED = new Set(["open", "in_progress", "triage", "waiting_response"]);

const TAB_STATUSES = {
  active:  new Set(["open", "in_progress", "triage"]),
  waiting: new Set(["waiting_response"]),
  closed:  new Set(["closed", "resolved", "cleared", "banned"]),
};

const TYPE_FILTERS = ["ALL", "REPORT", "APPEAL", "VIP", "SUPPORT"];
const TYPE_FILTER_MAP = {
  ALL: null, REPORT: "player_report", APPEAL: "ban_appeal",
  VIP: "vip_issue", SUPPORT: "general_support",
};

function TicketsPage() {
  const [tab, setTab] = useState("active");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(TICKETS[0]?.id ?? null);
  const [noteText, setNoteText] = useState("");

  const totalNonClosed = useMemo(
    () => TICKETS.filter((t) => NON_CLOSED.has(t.status)).length,
    [],
  );

  const filtered = useMemo(() => {
    const statuses = TAB_STATUSES[tab];
    const typeVal = TYPE_FILTER_MAP[typeFilter];
    const q = search.trim().toLowerCase();
    return TICKETS.filter((t) => {
      if (!statuses.has(t.status)) return false;
      if (typeVal && t.type !== typeVal) return false;
      if (q) {
        const name = getPlayer(t.subjectId ?? t.reporterId)?.name ?? "";
        if (!t.title.toLowerCase().includes(q) && !name.toLowerCase().includes(q))
          return false;
      }
      return true;
    });
  }, [tab, typeFilter, search]);

  const selectedTicket = TICKETS.find((t) => t.id === selectedId) ?? null;
  const subject = selectedTicket?.subjectId ? getPlayer(selectedTicket.subjectId) : null;
  const reporter = selectedTicket ? getPlayer(selectedTicket.reporterId) : null;
  const orgId = selectedTicket ? getOrgId(selectedTicket.serverId) : null;

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 flex min-h-0">
        {/* Left: ticket list */}
        <aside className="w-[230px] shrink-0 border-r border-border flex flex-col bg-background">
          {/* Header + tabs */}
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

          {/* Search */}
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

          {/* Type filter pills */}
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

          {/* Ticket rows */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="text-[10px] text-muted-foreground text-center py-10">
                No tickets
              </div>
            ) : (
              filtered.map((ticket) => (
                <TicketListItem
                  key={ticket.id}
                  ticket={ticket}
                  selected={ticket.id === selectedId}
                  onClick={() => setSelectedId(ticket.id)}
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
              noteText={noteText}
              onNoteChange={setNoteText}
            />
          </main>
        ) : (
          <main className="flex-1 grid place-items-center">
            <p className="text-sm text-muted-foreground">Select a ticket</p>
          </main>
        )}

        {/* Right: player sidebar */}
        {selectedTicket && subject && (
          <PlayerSidebar
            subject={subject}
            reporter={reporter}
            team={selectedTicket.team}
            reports={
              selectedTicket.reports?.length ? selectedTicket.reports : undefined
            }
            category={selectedTicket.category ?? selectedTicket.type}
            serverId={selectedTicket.serverId}
            ticketStatus={selectedTicket.status}
            onAutoReopen={() => {}}
            messages={selectedTicket.messages}
            orgId={orgId}
          />
        )}
      </div>
    </div>
  );
}

function TicketListItem({ ticket, selected, onClick }) {
  const meta = ticketMeta(ticket);
  const prefix = getOrgPrefix(getOrgId(ticket.serverId));
  const teamColor = TEAM_BADGE_COLOR[ticket.team] ?? "text-muted-foreground";
  const teamShort = TEAM_META[ticket.team]?.short ?? ticket.team;
  const person = getPlayer(ticket.subjectId ?? ticket.reporterId);
  const reportCount = ticket.reports?.length ?? 0;

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
            {person?.name ?? "Unknown"}
          </span>
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          {reportCount > 1 && (
            <span className="text-[9px] font-mono text-muted-foreground">
              +{reportCount - 1}
            </span>
          )}
          <span className={`text-[9px] font-mono font-bold ${teamColor}`}>
            {teamShort}
          </span>
          {ticket.restrictedRank && (
            <Lock size={9} className="text-muted-foreground shrink-0" />
          )}
          <span className="text-[9px] font-mono text-muted-foreground ml-auto shrink-0">
            {ticket.createdLabel}
          </span>
        </div>
      </div>
    </button>
  );
}

function TicketDetail({ ticket, noteText, onNoteChange }) {
  const [subFilter, setSubFilter] = useState("all");
  const assignee = ticket.assigneeId ? getStaff(ticket.assigneeId) : null;
  const reports = ticket.reports ?? [];
  const sysMessages = ticket.messages
    .filter((m) => m.authorKind === "system")
    .slice(0, 4);
  const convMessages = ticket.messages.filter((m) => m.authorKind !== "system");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Ticket header */}
      <div className="px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-mono text-brand shrink-0">
            #{ticket.number}
          </span>
          <h2 className="text-sm font-bold truncate">{ticket.title}</h2>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button className="flex items-center gap-1 text-[10px] font-mono bg-surface/60 ring-1 ring-border rounded px-2 py-0.5 hover:bg-surface transition-colors">
            → {TEAM_META[ticket.team]?.label ?? ticket.team}
            <ChevronDown size={9} className="text-muted-foreground" />
          </button>
          <button className="flex items-center gap-1 text-[10px] font-mono bg-surface/60 ring-1 ring-border rounded px-2 py-0.5 hover:bg-surface transition-colors">
            {assignee ? assignee.name : "Assign"}
            <ChevronDown size={9} className="text-muted-foreground" />
          </button>
          <button className="text-[10px] font-mono bg-brand text-brand-foreground rounded px-2 py-0.5 hover:opacity-90">
            CLAIM
          </button>
          <button className="flex items-center gap-1 text-[10px] font-mono bg-surface/60 ring-1 ring-border rounded px-2 py-0.5 hover:bg-surface transition-colors">
            <Lock size={9} /> Lock
          </button>
        </div>
      </div>

      {/* Action filter row */}
      <div className="px-4 py-1.5 border-b border-border flex items-center gap-1 shrink-0">
        {[
          ["all", "All time"],
          ["proof", "Proof only"],
          ["waitonline", "Wait online"],
          ["close", "Close"],
        ].map(([val, label]) => (
          <button
            key={val}
            onClick={() => setSubFilter(val)}
            className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
              subFilter === val
                ? "text-foreground bg-surface/80 ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
        <button className="text-[10px] font-mono px-2 py-0.5 rounded bg-danger/20 text-danger hover:bg-danger/30 ml-1 transition-colors">
          Ban
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Reporter submissions */}
        {reports.length > 0 && (
          <div className="px-4 pt-3 pb-2">
            <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
              Reporter Submissions ({reports.length} · All Time)
            </div>
            <div className="space-y-3">
              {reports.map((r) => (
                <ReporterCard key={r.id} report={r} />
              ))}
            </div>
          </div>
        )}

        {/* System messages */}
        {sysMessages.length > 0 && (
          <div className="px-4 py-2 space-y-3">
            {sysMessages.map((msg, i) => (
              <div key={i}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                    {msg.authorName === "F7 Report" ? "F7 Report" : "System Action"}
                  </span>
                  <span className="text-[9px] font-mono text-muted-foreground">
                    {msg.timestamp}
                  </span>
                </div>
                <p className="text-[10px] font-mono text-foreground/70 leading-relaxed break-words">
                  {msg.body}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Conversation messages (staff/reporter) */}
        {convMessages.length > 0 && (
          <div className="px-4 py-2 space-y-2">
            {convMessages.map((msg, i) => (
              <div
                key={i}
                className={`rounded-md px-3 py-2 ring-1 text-xs ${
                  msg.authorKind === "staff"
                    ? "bg-brand/10 ring-brand/20"
                    : "bg-surface/60 ring-border"
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-[10px]">{msg.authorName}</span>
                  <span className="font-mono text-[9px] text-muted-foreground">
                    {msg.timestamp}
                  </span>
                  {msg.authorKind !== "staff" && (
                    <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground ml-auto">
                      Internal Note
                    </span>
                  )}
                </div>
                <p className="leading-relaxed">{msg.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Note composer */}
      <div className="border-t border-border px-4 py-3 shrink-0">
        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
          Internal Note{" "}
          <span className="normal-case tracking-normal text-muted-foreground/50">
            · Staff-only discussion. Reporters never see these.
          </span>
        </div>
        <textarea
          value={noteText}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder="Discuss this case with other staff — evidence checks, second opinions, decisions..."
          className="w-full h-20 bg-background border border-border rounded p-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-brand/40"
        />
        <div className="flex items-center justify-between mt-1.5">
          <label className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground cursor-pointer select-none">
            <input type="checkbox" className="size-3 accent-brand" />
            Pin to bottom of thread
          </label>
          <button className="text-[10px] font-mono bg-brand text-brand-foreground rounded px-3 py-1 hover:opacity-90">
            Post Note
          </button>
        </div>
      </div>
    </div>
  );
}

function ReporterCard({ report }) {
  const reporter = getPlayer(report.reporterId);
  const statusColor =
    report.status === "pending"
      ? "text-warning"
      : report.status === "banned"
        ? "text-danger"
        : "text-muted-foreground";
  const evidenceLines = report.evidence
    ? report.evidence.split("\n").filter(Boolean)
    : [];

  return (
    <div className="ring-1 ring-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-surface/40 border-b border-border">
        <div className="flex items-center gap-2">
          <div
            className="size-6 rounded-full grid place-items-center text-[9px] font-bold text-background shrink-0"
            style={{ background: reporter?.avatarColor ?? "oklch(0.4 0.02 285)" }}
          >
            {(reporter?.name ?? "?").replace(/[\[\]]/g, "").slice(0, 2).toUpperCase()}
          </div>
          <span className="text-xs font-semibold">{reporter?.name ?? report.reporterId}</span>
          <span className="text-[10px] font-mono text-muted-foreground">
            {report.submittedLabel}
          </span>
        </div>
        <span className={`text-[9px] font-mono uppercase font-bold tracking-wider ${statusColor}`}>
          {report.status}
        </span>
      </div>
      <div className="px-3 py-2.5 space-y-2">
        <div>
          <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">
            Description
          </div>
          <p className="text-xs leading-relaxed">{report.description}</p>
        </div>
        <div>
          <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5">
            Evidence
          </div>
          {evidenceLines.length > 0 ? (
            <div className="space-y-0.5">
              {evidenceLines.map((link, i) => (
                <p key={i} className="text-[10px] font-mono text-brand break-all">
                  {link}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-[10px] font-mono text-muted-foreground italic">
              No evidence attached.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

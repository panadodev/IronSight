import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { PlayerSidebar } from "@/components/player-sidebar";
import {
  AppealSidebar,
  AppealModerationActions,
} from "@/components/appeal-sidebar";
import { useAuth } from "@/lib/auth-context";
import { PredefineSearch } from "@/components/predefine-search";
import { BanDialog } from "@/components/ban-dialog";
import {
  STATUS_LABEL,
  TICKETS,
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  TEAM_IDS,
  TEAM_META,
  REPORT_CATEGORY_LABEL,
  getPlayer,
} from "@/lib/mock-data";
const Route = createFileRoute("/")({
  validateSearch: (search) => ({
    ticket: typeof search.ticket === "string" ? search.ticket : void 0,
  }),
  head: () => ({
    meta: [
      { title: "Staff Dashboard \u2014 IronSight Support" },
      {
        name: "description",
        content:
          "Rust server staff support console: triage tickets, assign teams, audit players.",
      },
    ],
  }),
  component: StaffDashboard,
});
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function truncateName(name, max = 15) {
  if (name.length <= max) return name;
  return name.slice(0, max) + "\u2026";
}
const TYPE_COLOR = {
  player_report: "hsl(0 75% 60%)",
  // red
  ban_appeal: "hsl(35 90% 55%)",
  // amber
  vip_issue: "hsl(265 75% 65%)",
  // purple
  general_support: "hsl(195 80% 55%)",
  // cyan
};
const TYPE_SHORT = {
  player_report: "Report",
  ban_appeal: "Appeal",
  vip_issue: "VIP",
  general_support: "Support",
};
const ORG_ROTATION = ["builders_sanctuary", "willjums"];
const ORG_SHORT = {
  builders_sanctuary: "BS",
  willjums: "WJ",
};
const orgForTicket = (number) => ORG_ROTATION[number % ORG_ROTATION.length];
function StaffDashboard() {
  const {
    view,
    activeStaff,
    activeRank,
    rankOf,
    staff,
    selectedOrgIds,
    isOwner,
  } = useAuth();
  void activeRank;
  const { ticket: ticketSearchId } = Route.useSearch();
  const [tickets, setTickets] = useState(TICKETS);
  const [typeFilter, setTypeFilter] = useState("all");
  const [teamFilter, setTeamFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [queueView, setQueueView] = useState("active");
  const [proofOnly, setProofOnly] = useState(false);
  const [recencyDays, setRecencyDays] = useState(0);
  const [selectedId, setSelectedId] = useState(
    ticketSearchId && TICKETS.some((t) => t.id === ticketSearchId)
      ? ticketSearchId
      : TICKETS[0].id,
  );
  useEffect(() => {
    if (!ticketSearchId) return;
    const t = tickets.find((x) => x.id === ticketSearchId);
    if (!t) return;
    setSelectedId(t.id);
    const closed = ["closed", "cleared", "banned"];
    if (closed.includes(t.status)) setQueueView("closed");
    else if (t.status === "waiting_response") setQueueView("waiting");
    else setQueueView("active");
  }, [ticketSearchId, tickets]);
  const [composerMode, setComposerMode] = useState("reply");
  const [pinNote, setPinNote] = useState(false);
  const [draft, setDraft] = useState("");
  const [waitForResponse, setWaitForResponse] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [banDialogOpen, setBanDialogOpen] = useState(false);
  const [muteDialogOpen, setMuteDialogOpen] = useState(false);
  const [playerQuery, setPlayerQuery] = useState("");
  if (view === "public") {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="text-center max-w-md">
            <p className="text-[10px] font-mono uppercase tracking-widest text-danger mb-3">
              Access denied
            </p>
            <h1 className="text-2xl font-semibold mb-2">Staff console</h1>
            <p className="text-sm text-muted-foreground mb-6">
              You're in <span className="text-foreground">PUBLIC</span> view.
              Switch to <span className="text-foreground">STAFF</span> view in
              the top bar, or submit a ticket via the Player Portal.
            </p>
            <Link
              to="/submit"
              className="inline-flex px-4 py-2 bg-brand text-brand-foreground rounded text-sm font-semibold"
            >
              Go to Player Portal
            </Link>
          </div>
        </div>
      </div>
    );
  }
  const TYPE_MIN_RANK = {
    general_support: 1,
    // Support+
    player_report: 2,
    // Admins+
    ban_appeal: 3,
    // Sr. Admins+
    vip_issue: 4,
    // Management
  };
  const canSee = (t) => {
    const r = rankOf(orgForTicket(t.number));
    if (isOwner) return true;
    const minRank =
      t.type === "player_report" && t.category === "toxicity"
        ? 1
        : TYPE_MIN_RANK[t.type];
    return r >= minRank && (t.restrictedRank === null || r >= t.restrictedRank);
  };
  const CLOSED_STATUSES = ["closed", "cleared", "banned"];
  const visible = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    const searching = q.length > 0;
    const ticketMatchesQuery = (t) => {
      if (!searching) return true;
      const ids = /* @__PURE__ */ new Set();
      if (t.type === "player_report") {
        if (t.subjectId) ids.add(t.subjectId);
      } else {
        ids.add(t.reporterId);
        if (t.subjectId) ids.add(t.subjectId);
      }
      for (const id of ids) {
        if (id.toLowerCase().includes(q)) return true;
        const p = getPlayer(id);
        if (p && p.name.toLowerCase().includes(q)) return true;
      }
      return false;
    };
    const filtered = tickets
      .filter(canSee)
      .filter((t) => selectedOrgIds.includes(orgForTicket(t.number)))
      .filter((t) => {
        if (searching) return true;
        if (queueView === "closed") return CLOSED_STATUSES.includes(t.status);
        if (queueView === "waiting") return t.status === "waiting_response";
        return (
          !CLOSED_STATUSES.includes(t.status) && t.status !== "waiting_response"
        );
      })
      .filter((t) => (typeFilter === "all" ? true : t.type === typeFilter))
      .filter((t) => (teamFilter === "all" ? true : t.team === teamFilter))
      .filter(ticketMatchesQuery);
    const myId = activeStaff?.id;
    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === "priority")
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (sortBy === "type") return a.type.localeCompare(b.type);
      return b.createdAt.localeCompare(a.createdAt);
    });
    return sorted;
  }, [
    tickets,
    typeFilter,
    teamFilter,
    sortBy,
    queueView,
    activeRank,
    isOwner,
    selectedOrgIds,
    playerQuery,
  ]);
  const selected =
    tickets.find((t) => t.id === selectedId && canSee(t)) ?? visible[0] ?? null;
  const subject = selected?.subjectId ? getPlayer(selected.subjectId) : null;
  const reporter = selected ? getPlayer(selected.reporterId) : getPlayer("");
  const isReport = selected?.type === "player_report";
  const STATUS_LOG = {
    open: "moved ticket back to Active",
    in_progress: "moved ticket back to Active",
    waiting_response: "moved ticket to Waiting",
    closed: "closed the ticket",
    cleared: "closed the ticket",
  };
  const updateTicket = (id, patch) =>
    setTickets((all) =>
      all.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...patch };
        if (!activeStaff) return next;
        const logs = [];
        if (patch.assigneeId !== void 0 && patch.assigneeId !== t.assigneeId) {
          const who = patch.assigneeId
            ? (staff.find((s) => s.id === patch.assigneeId)?.name ?? "unknown")
            : null;
          logs.push(
            who ? `assigned ticket to ${who}` : "unassigned the ticket",
          );
        }
        if (patch.team !== void 0 && patch.team !== t.team) {
          logs.push(`reassigned ticket to ${TEAM_META[patch.team].label}`);
        }
        if (
          patch.restrictedRank !== void 0 &&
          patch.restrictedRank !== t.restrictedRank
        ) {
          logs.push(
            patch.restrictedRank === null
              ? "unlocked ticket visibility"
              : `locked ticket to rank \u2265 ${patch.restrictedRank}`,
          );
        }
        if (patch.status !== void 0 && patch.status !== t.status) {
          const msg = STATUS_LOG[patch.status];
          if (msg) logs.push(msg);
        }
        if (logs.length === 0) return next;
        const stamp = /* @__PURE__ */ new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const newMessages = [
          ...(patch.messages ?? next.messages),
          ...logs.map((body) => ({
            authorId: activeStaff.id,
            authorName: `${activeStaff.name} (internal)`,
            authorKind: "system",
            timestamp: stamp,
            body: `${activeStaff.name} ${body}.`,
          })),
        ];
        return { ...next, messages: newMessages };
      }),
    );
  useEffect(() => {
    setTickets((all) =>
      all.map((t) => {
        if (
          t.type === "player_report" &&
          t.status === "waiting_response" &&
          t.subjectId &&
          getPlayer(t.subjectId).lastSeen.startsWith("Now")
        ) {
          return { ...t, status: "open" };
        }
        return t;
      }),
    );
  }, [tickets.length]);
  const assignToMe = () =>
    selected &&
    activeStaff &&
    updateTicket(selected.id, {
      assigneeId: activeStaff.id,
      status: selected.status === "open" ? "in_progress" : selected.status,
    });
  const lastMessageKind = (() => {
    if (!selected || selected.messages.length === 0) return null;
    return selected.messages[selected.messages.length - 1].authorKind;
  })();
  const requestClose = () => {
    if (!selected) return;
    if (lastMessageKind === "reporter") {
      setConfirmClose(true);
    } else {
      doClose();
    }
  };
  const doClose = () => {
    if (!selected) return;
    updateTicket(selected.id, { status: "closed" });
    setConfirmClose(false);
  };
  const markCleared = () => {
    if (!selected || !selected.reports) return;
    updateTicket(selected.id, {
      status: "cleared",
      reports: selected.reports.map((r) =>
        r.status === "pending" ? { ...r, status: "case_closed" } : r,
      ),
    });
  };
  const reopenReport = () => {
    if (!selected || !selected.reports) return;
    updateTicket(selected.id, {
      status: "open",
      reports: selected.reports.map((r) =>
        r.status === "case_closed" ? { ...r, status: "pending" } : r,
      ),
    });
  };
  const waitUntilOnline = () => {
    if (!selected) return;
    updateTicket(selected.id, { status: "waiting_response" });
  };
  const openBanDialog = () => {
    if (!selected || !selected.reports) return;
    setBanDialogOpen(true);
  };
  const openMuteDialog = () => {
    if (!selected || !selected.reports) return;
    setMuteDialogOpen(true);
  };
  const submitBan = (sub) => {
    if (!selected || !selected.reports || !activeStaff) return;
    const lines = [
      `\u{1F528} Ban issued by ${activeStaff.name}`,
      `Reason: ${sub.reason}`,
      `Length: ${sub.lengthLabel}`,
    ];
    if (sub.note) lines.push("", sub.note);
    updateTicket(selected.id, {
      status: "banned",
      reports: selected.reports.map((r) => ({ ...r, status: "banned" })),
      messages: [
        ...selected.messages,
        {
          authorId: activeStaff.id,
          authorName: activeStaff.name,
          authorKind: "system",
          timestamp: /* @__PURE__ */ new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          body: lines.join("\n"),
        },
      ],
    });
  };
  const submitMute = (sub) => {
    if (!selected || !activeStaff) return;
    const lines = [
      `\u{1F507} Mute issued by ${activeStaff.name}`,
      `Reason: ${sub.reason}`,
      `Length: ${sub.lengthLabel}`,
    ];
    if (sub.note) lines.push("", sub.note);
    updateTicket(selected.id, {
      messages: [
        ...selected.messages,
        {
          authorId: activeStaff.id,
          authorName: activeStaff.name,
          authorKind: "system",
          timestamp: /* @__PURE__ */ new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          body: lines.join("\n"),
        },
      ],
    });
  };
  const selectedOrgRank = selected ? rankOf(orgForTicket(selected.number)) : 0;
  const toggleHide = () => {
    if (!selected) return;
    if (
      selected.restrictedRank !== null &&
      selected.restrictedRank <= selectedOrgRank
    ) {
      updateTicket(selected.id, { restrictedRank: null });
    } else {
      updateTicket(selected.id, { restrictedRank: selectedOrgRank });
    }
  };
  const sendMessage = () => {
    if (!selected || !draft.trim() || !activeStaff) return;
    const isNote = composerMode === "note";
    const nextStatus =
      !isNote && waitForResponse
        ? "waiting_response"
        : selected.status === "open"
          ? "in_progress"
          : selected.status;
    updateTicket(selected.id, {
      status: nextStatus,
      messages: [
        ...selected.messages,
        {
          authorId: activeStaff.id,
          authorName: isNote
            ? `${activeStaff.name} (internal)`
            : activeStaff.name,
          authorKind: isNote ? "system" : "staff",
          timestamp: /* @__PURE__ */ new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          body: draft.trim(),
          pinned: isNote ? pinNote : false,
        },
      ],
    });
    setDraft("");
    setPinNote(false);
    setWaitForResponse(false);
  };
  const togglePin = (index) => {
    if (!selected) return;
    updateTicket(selected.id, {
      messages: selected.messages.map((m, i) =>
        i === index ? { ...m, pinned: !m.pinned } : m,
      ),
    });
  };
  const canHide =
    selected !== null &&
    (isOwner ||
      (selected.restrictedRank === null
        ? selectedOrgRank >= TEAM_META[selected.team].rank
        : selectedOrgRank >= selected.restrictedRank));
  const isHidden = selected?.restrictedRank !== null && selected !== null;
  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <SiteNav />
      <main className="flex flex-1 overflow-hidden">
        {/* Feed */}
        <aside className="w-80 shrink-0 border-r border-border flex flex-col bg-background">
          <div className="p-4 border-b border-border space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {queueView === "closed"
                  ? "Closed Tickets"
                  : queueView === "waiting"
                    ? "Waiting Response"
                    : "Active Queue"}
              </h2>
              <span className="text-[10px] font-mono bg-surface px-1.5 py-0.5 rounded text-muted-foreground">
                {visible.length}
              </span>
            </div>
            <div className="flex rounded ring-1 ring-border overflow-hidden text-[10px] font-bold uppercase tracking-wider">
              {["active", "waiting", "closed"].map((v) => (
                <button
                  key={v}
                  onClick={() => setQueueView(v)}
                  className={
                    "flex-1 py-1 " +
                    (queueView === v
                      ? "bg-brand/15 text-brand"
                      : "bg-surface text-muted-foreground hover:text-foreground")
                  }
                >
                  {v === "waiting"
                    ? "Waiting"
                    : v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
            <div className="relative">
              <input
                type="text"
                value={playerQuery}
                onChange={(e) => setPlayerQuery(e.target.value)}
                placeholder="Search player name or Steam ID…"
                className="w-full bg-surface border border-border rounded px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-brand"
              />
              {playerQuery && (
                <button
                  onClick={() => setPlayerQuery("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground hover:text-foreground px-1"
                  title="Clear search"
                >
                  ×
                </button>
              )}
              {playerQuery.trim() && (
                <p className="mt-1 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                  Searching all tickets · active + closed
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Chip
                active={typeFilter === "all"}
                onClick={() => setTypeFilter("all")}
              >
                All
              </Chip>
              {TICKET_TYPES.map((t) => (
                <Chip
                  key={t.id}
                  active={typeFilter === t.id}
                  color={TYPE_COLOR[t.id]}
                  onClick={() => setTypeFilter(t.id)}
                >
                  {TYPE_SHORT[t.id]}
                </Chip>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest text-muted-foreground">
              <span>Team</span>
              <select
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
                className="bg-surface border border-border rounded px-2 py-1 text-foreground font-mono flex-1"
              >
                <option value="all">All teams</option>
                {TEAM_IDS.map((id) => (
                  <option key={id} value={id}>
                    {TEAM_META[id].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
              <span>Sort</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="bg-surface border border-border rounded px-2 py-1 text-foreground font-mono"
              >
                <option value="newest">Newest</option>
                <option value="priority">Priority</option>
                <option value="type">Type</option>
              </select>
            </div>
          </div>
          <div className="overflow-y-auto flex-1">
            {(() => {
              const myId = activeStaff?.id;
              const assignedToMe = visible.filter(
                (t) => myId && t.assigneeId === myId,
              );
              const allOther = visible.filter(
                (t) => !(myId && t.assigneeId === myId),
              );
              const renderTicket = (t) => {
                const isActive = t.id === selected?.id;
                const assignee = staff.find((s) => s.id === t.assigneeId);
                const reportCount = t.reports?.length ?? 0;
                const orgShort = ORG_SHORT[orgForTicket(t.number)];
                const typeShort =
                  t.type === "player_report" && t.category
                    ? REPORT_CATEGORY_LABEL[t.category]
                    : TYPE_SHORT[t.type];
                const nameForRow =
                  t.type === "player_report"
                    ? t.subjectId
                      ? getPlayer(t.subjectId).name
                      : "\u2014"
                    : getPlayer(t.reporterId).name;
                return (
                  <button
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    style={{ borderLeftColor: TYPE_COLOR[t.type] }}
                    className={
                      "w-full text-left pl-2.5 pr-3 py-1.5 cursor-pointer transition-colors block border-l-[3px] " +
                      (isActive ? "bg-surface/70" : "hover:bg-surface/30")
                    }
                    title={`${orgShort} \xB7 ${typeShort} \xB7 ${nameForRow} \xB7 ${TEAM_META[t.team].label}${assignee ? ` \xB7 ${assignee.name}` : " \xB7 Unassigned"}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-xs font-medium truncate flex-1">
                        <span className="font-mono text-muted-foreground">
                          {orgShort}
                        </span>
                        <span className="text-muted-foreground/50 mx-1.5">
                          ·
                        </span>
                        <span
                          className="font-semibold"
                          style={{ color: TYPE_COLOR[t.type] }}
                        >
                          {typeShort}
                        </span>
                        <span className="text-muted-foreground/50 mx-1.5">
                          ·
                        </span>
                        <span>{nameForRow}</span>
                      </h3>
                      {t.type === "player_report" && reportCount > 1 && (
                        <span className="text-[9px] font-mono text-muted-foreground shrink-0">
                          ×{reportCount}
                        </span>
                      )}
                      <span
                        className="text-[9px] font-bold font-mono shrink-0 hidden xl:inline"
                        style={{ color: TYPE_COLOR[t.type] }}
                      >
                        {TEAM_META[t.team].short}
                      </span>
                      {t.restrictedRank !== null && (
                        <Lock size={10} className="shrink-0 text-warning" />
                      )}
                      <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                        {t.createdLabel}
                      </span>
                    </div>
                  </button>
                );
              };
              return (
                <>
                  {assignedToMe.length > 0 && (
                    <div>
                      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-3 py-1.5 border-y border-border flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-brand">
                          Assigned to You
                        </span>
                        <span className="text-[10px] font-mono bg-brand/10 text-brand px-1.5 py-0.5 rounded">
                          {assignedToMe.length}
                        </span>
                      </div>
                      <div className="divide-y divide-border">
                        {assignedToMe.map(renderTicket)}
                      </div>
                    </div>
                  )}
                  {allOther.length > 0 && (
                    <div>
                      {assignedToMe.length > 0 && (
                        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-3 py-1.5 border-y border-border flex items-center justify-between">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                            All Tickets
                          </span>
                          <span className="text-[10px] font-mono bg-surface px-1.5 py-0.5 rounded text-muted-foreground">
                            {allOther.length}
                          </span>
                        </div>
                      )}
                      <div className="divide-y divide-border">
                        {allOther.map(renderTicket)}
                      </div>
                    </div>
                  )}
                  {visible.length === 0 && (
                    <div className="p-6 text-center text-xs text-muted-foreground">
                      No tickets match your filters or access level.
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </aside>

        {/* Detail */}
        {selected ? (
          <section className="flex-1 flex flex-col bg-surface/10 overflow-hidden min-w-0">
            <div className="px-6 py-4 border-b border-border flex flex-col gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className={
                    "size-2.5 rounded-full shrink-0 " +
                    (selected.status === "waiting_response"
                      ? "bg-warning"
                      : selected.status === "resolved" ||
                          selected.status === "closed" ||
                          selected.status === "cleared" ||
                          selected.status === "banned"
                        ? "bg-danger"
                        : "bg-success")
                  }
                  title={selected.status}
                />
                <span className="text-[10px] font-mono text-muted-foreground">
                  #{selected.number}
                </span>
                <h1 className="text-lg font-semibold tracking-tight truncate">
                  {isReport
                    ? `${selected.category ? REPORT_CATEGORY_LABEL[selected.category] : "Report"} \u2014 ${truncateName(subject?.name ?? "")}`
                    : `${TICKET_TYPE_LABEL[selected.type]} \u2014 ${truncateName(reporter.name)}`}
                </h1>

                {selected.restrictedRank !== null && (
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded ring-1 ring-warning/30 bg-warning/10 text-warning uppercase tracking-wider">
                    ◈ Hidden ≤ {selected.restrictedRank - 1}
                  </span>
                )}
                <div className="flex gap-1.5 items-center flex-wrap ml-2">
                  <select
                    value={selected.team}
                    onChange={(e) =>
                      updateTicket(selected.id, { team: e.target.value })
                    }
                    className="h-8 bg-surface border border-border rounded-md px-2 text-xs [&>option]:bg-surface [&>option]:text-foreground"
                    title="Assigned team"
                  >
                    {TEAM_IDS.map((id) => (
                      <option key={id} value={id}>
                        → {TEAM_META[id].label}
                      </option>
                    ))}
                  </select>
                  <div className="h-8 flex items-center gap-1 bg-surface border border-border rounded-md pr-1">
                    <select
                      value={selected.assigneeId ?? ""}
                      onChange={(e) =>
                        updateTicket(selected.id, {
                          assigneeId: e.target.value || null,
                        })
                      }
                      className="h-full bg-transparent px-2 text-xs focus:outline-none [&>option]:bg-surface [&>option]:text-foreground"
                      title="Assigned staff"
                    >
                      <option value="">Assign</option>
                      {staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({TEAM_META[s.team].short})
                        </option>
                      ))}
                    </select>
                    {!selected.assigneeId && activeStaff && (
                      <button
                        onClick={assignToMe}
                        className="text-[10px] font-semibold uppercase tracking-wider text-brand hover:text-brand/80 px-1.5 h-6 border-l border-border"
                        title="Assign this ticket to yourself"
                      >
                        Claim
                      </button>
                    )}
                  </div>
                  {canHide && (
                    <button
                      onClick={toggleHide}
                      className={
                        "h-8 px-3 text-xs font-semibold rounded-md ring-1 transition-colors " +
                        (isHidden
                          ? "bg-warning/10 text-warning ring-warning/30 hover:bg-warning/20"
                          : "bg-surface text-foreground ring-border hover:bg-surface-bright")
                      }
                      title="Restrict visibility to your team rank and above"
                    >
                      {isHidden ? "\u25C8 Unlock" : "\u25C8 Lock"}
                    </button>
                  )}
                </div>
              </div>
              <div className="flex gap-1.5 items-center flex-wrap">
                {isReport ? (
                  <>
                    <select
                      value={recencyDays}
                      onChange={(e) => setRecencyDays(Number(e.target.value))}
                      className="h-8 bg-surface ring-1 ring-border rounded-md px-2 text-xs font-mono text-foreground focus:outline-none"
                      title="Hide reports older than this"
                    >
                      <option value={0}>All time</option>
                      <option value={7}>1 week</option>
                      <option value={30}>1 month</option>
                      <option value={90}>3 months</option>
                      <option value={365}>1 year</option>
                    </select>
                    <button
                      onClick={() => setProofOnly((v) => !v)}
                      className={
                        "h-8 px-3 text-xs font-semibold rounded-md ring-1 transition-colors " +
                        (proofOnly
                          ? "bg-brand/15 text-brand ring-brand/30"
                          : "bg-surface text-foreground ring-border hover:bg-surface-bright")
                      }
                      title="Hide reports that have no evidence attached"
                    >
                      Proof only
                    </button>
                    <button
                      onClick={waitUntilOnline}
                      disabled={selected.status === "banned"}
                      className="h-8 px-3 bg-surface text-foreground text-xs font-semibold rounded-md ring-1 ring-border hover:bg-surface-bright disabled:opacity-40"
                      title="Move to Waiting until the player logs on"
                    >
                      Wait online
                    </button>
                    <button
                      onClick={
                        selected.status === "cleared"
                          ? reopenReport
                          : markCleared
                      }
                      disabled={selected.status === "banned"}
                      className={
                        "h-8 px-3 text-xs font-semibold rounded-md ring-1 disabled:opacity-40 " +
                        (selected.status === "cleared"
                          ? "bg-warning/15 text-warning ring-warning/30 hover:bg-warning/25"
                          : "bg-surface text-foreground ring-border hover:bg-surface-bright")
                      }
                    >
                      {selected.status === "cleared" ? "Unclose" : "Close"}
                    </button>
                    {selectedOrgRank >= 2 && (
                      <button
                        onClick={openBanDialog}
                        className="h-8 px-3 bg-danger text-danger-foreground text-xs font-semibold rounded-md ring-1 ring-danger hover:opacity-90"
                      >
                        Ban
                      </button>
                    )}
                    {selected.category === "toxicity" && (
                      <button
                        onClick={openMuteDialog}
                        className="h-8 px-3 bg-warning/15 text-warning text-xs font-semibold rounded-md ring-1 ring-warning/40 hover:bg-warning/25"
                      >
                        Mute
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {selected.type === "ban_appeal" && (
                      <AppealModerationActions
                        appellant={getPlayer(selected.reporterId)}
                      />
                    )}
                    <button
                      onClick={requestClose}
                      className="h-8 px-3 bg-danger text-danger-foreground text-xs font-semibold rounded-md ring-1 ring-danger hover:opacity-90"
                    >
                      Close
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-8 space-y-6">
              {!isReport && (
                <div className="max-w-[60ch] bg-surface/40 ring-1 ring-border rounded-lg p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      Original ticket
                    </span>
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {selected.createdLabel}
                    </span>
                  </div>
                  <h2 className="text-sm font-semibold">{selected.title}</h2>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {selected.summary}
                  </p>
                </div>
              )}

              {isReport && selected.reports && (
                <ReportsList
                  reports={selected.reports}
                  proofOnly={proofOnly}
                  recencyDays={recencyDays}
                />
              )}

              {[...selected.messages]
                .map((m, i) => ({ m, i }))
                .sort((a, b) => Number(!!a.m.pinned) - Number(!!b.m.pinned))
                .map(({ m, i }) =>
                  m.authorKind === "system" ? (
                    <div
                      key={i}
                      className={
                        "max-w-[60ch] ml-auto p-4 rounded-lg border " +
                        (m.pinned
                          ? "bg-warning/10 border-warning/30"
                          : "bg-brand/5 border-brand/10")
                      }
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={
                            "text-[10px] font-mono uppercase tracking-widest " +
                            (m.pinned ? "text-warning" : "text-brand")
                          }
                        >
                          {m.pinned
                            ? "\u{1F4CC} Pinned Note"
                            : m.authorName === "System"
                              ? "System Action"
                              : "Internal Note"}
                        </span>
                        <span
                          className={
                            "h-px flex-1 " +
                            (m.pinned ? "bg-warning/20" : "bg-brand/10")
                          }
                        />
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {m.timestamp}
                        </span>
                        {m.authorName !== "System" && (
                          <button
                            onClick={() => togglePin(i)}
                            className={
                              "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 " +
                              (m.pinned
                                ? "text-warning ring-warning/30 hover:bg-warning/20"
                                : "text-muted-foreground ring-border hover:text-foreground")
                            }
                            title={
                              m.pinned
                                ? "Unpin this note"
                                : "Pin to bottom of thread"
                            }
                          >
                            {m.pinned ? "Unpin" : "Pin"}
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground italic">
                        {m.body}
                      </p>
                    </div>
                  ) : (
                    <div key={i} className="max-w-[60ch]">
                      <div className="flex items-start gap-4">
                        <div
                          className={
                            "size-8 rounded-sm shrink-0 grid place-items-center font-mono text-xs font-bold " +
                            (m.authorKind === "staff"
                              ? "bg-brand/20 text-brand"
                              : "bg-surface-bright text-foreground")
                          }
                        >
                          {m.authorName
                            .replace(/[\[\]]/g, "")
                            .slice(0, 2)
                            .toUpperCase()}
                        </div>
                        <div className="space-y-2 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">
                              {m.authorName}
                            </span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {m.timestamp}
                            </span>
                            {m.authorKind === "staff" && (
                              <span className="text-[9px] uppercase font-bold tracking-widest text-brand">
                                Staff
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-foreground/90 leading-relaxed">
                            {m.body}
                          </p>
                        </div>
                      </div>
                    </div>
                  ),
                )}
            </div>

            {!isReport && (
              <div className="p-6 border-t border-border bg-background">
                <div className="max-w-[60ch] mx-auto">
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
                  {composerMode === "reply" && selected && (
                    <PredefineSearch
                      orgId={orgForTicket(selected.number)}
                      onPick={(content) =>
                        setDraft((d) =>
                          d
                            ? `${d}${d.endsWith("\n") ? "" : "\n"}${content}`
                            : content,
                        )
                      }
                    />
                  )}
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-full h-28 bg-surface/60 border border-border rounded-lg p-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand/50"
                    placeholder={
                      composerMode === "reply"
                        ? "Type your response to the player..."
                        : "Leave an internal note for your team..."
                    }
                  />
                  <div className="flex items-center justify-between mt-2 gap-3">
                    {composerMode === "note" ? (
                      <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pinNote}
                          onChange={(e) => setPinNote(e.target.checked)}
                          className="accent-warning"
                        />
                        📌 Pin to bottom of thread
                      </label>
                    ) : (
                      <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={waitForResponse}
                          onChange={(e) => setWaitForResponse(e.target.checked)}
                          className="accent-brand"
                        />
                        Set to waiting for response
                      </label>
                    )}
                    <button
                      onClick={sendMessage}
                      className="px-4 py-1.5 bg-brand text-brand-foreground text-xs font-semibold rounded ring-1 ring-brand hover:opacity-90"
                    >
                      Submit
                    </button>
                  </div>
                </div>
              </div>
            )}
            {isReport && (
              <div className="p-6 border-t border-border bg-background">
                <div className="max-w-[60ch] mx-auto">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded bg-brand/10 text-brand">
                      Internal Note
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      Staff-only discussion. Reporters never see these.
                    </span>
                  </div>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-full h-28 bg-surface/60 border border-border rounded-lg p-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand/50"
                    placeholder="Discuss this case with other staff — evidence checks, second opinions, decisions..."
                  />
                  <div className="flex items-center justify-between mt-2 gap-3">
                    <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pinNote}
                        onChange={(e) => setPinNote(e.target.checked)}
                        className="accent-warning"
                      />
                      📌 Pin to bottom of thread
                    </label>
                    <button
                      onClick={() => {
                        setComposerMode("note");
                        sendMessage();
                      }}
                      className="px-4 py-1.5 bg-brand text-brand-foreground text-xs font-semibold rounded ring-1 ring-brand hover:opacity-90 shrink-0"
                    >
                      Post Note
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="flex-1 grid place-items-center text-muted-foreground text-sm">
            No tickets match this filter.
          </section>
        )}

        {selected &&
          (selected.type === "player_report" ? (
            <PlayerSidebar
              subject={subject}
              reporter={reporter}
              team={TEAM_META[selected.team].label}
              reports={isReport ? selected.reports : void 0}
              category={selected.category}
              serverId={selected.serverId}
              ticketStatus={selected.status}
              messages={selected.messages}
              orgId={orgForTicket(selected.number)}
              onAutoReopen={(reason) => {
                updateTicket(selected.id, {
                  status: "open",
                  messages: [
                    ...selected.messages,
                    {
                      authorId: "system",
                      authorName: "System",
                      authorKind: "system",
                      timestamp: /* @__PURE__ */ new Date().toLocaleTimeString(
                        [],
                        { hour: "2-digit", minute: "2-digit" },
                      ),
                      body: reason,
                    },
                  ],
                });
              }}
            />
          ) : (
            <AppealSidebar
              ticket={selected}
              team={TEAM_META[selected.team].label}
            />
          ))}
      </main>

      {selected && selected.type === "player_report" && selected.category && (
        <>
          <BanDialog
            open={banDialogOpen}
            onOpenChange={setBanDialogOpen}
            orgId={orgForTicket(selected.number)}
            category={selected.category}
            subjectName={subject?.name ?? "player"}
            onSubmit={submitBan}
          />
          {selected.category === "toxicity" && (
            <BanDialog
              open={muteDialogOpen}
              onOpenChange={setMuteDialogOpen}
              orgId={orgForTicket(selected.number)}
              category="toxicity"
              subjectName={subject?.name ?? "player"}
              onSubmit={submitMute}
              mode="mute"
            />
          )}
        </>
      )}

      {confirmClose && selected && (
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
            <h3 className="text-lg font-semibold mb-2">
              The player typed last on this ticket
            </h3>
            <p className="text-sm text-muted-foreground mb-6">
              They wrote the most recent message and haven't received a staff
              reply. Do you want to give them a response before closing?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={doClose}
                className="px-4 py-2 bg-surface ring-1 ring-border rounded text-xs font-semibold uppercase tracking-wider hover:bg-surface-bright"
              >
                No, close anyway
              </button>
              <button
                onClick={() => setConfirmClose(false)}
                className="px-4 py-2 bg-brand text-brand-foreground rounded text-xs font-semibold uppercase tracking-wider"
              >
                Yes, write reply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function ReportsList({ reports, proofOnly, recencyDays }) {
  const cutoff = recencyDays > 0 ? Date.now() - recencyDays * 864e5 : 0;
  const byProof = proofOnly
    ? reports.filter((r) => r.evidence.trim().length > 0)
    : reports;
  const shown =
    cutoff > 0
      ? byProof.filter((r) => {
          const t = Date.parse(r.submittedAt);
          return Number.isNaN(t) ? true : t >= cutoff;
        })
      : byProof;
  const hiddenCount = reports.length - shown.length;
  const recencyLabel =
    recencyDays === 7
      ? "past week"
      : recencyDays === 30
        ? "past month"
        : recencyDays === 90
          ? "past 3 months"
          : recencyDays === 365
            ? "past year"
            : "all time";
  return (
    <div className="max-w-[60ch] space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Reporter submissions ({shown.length} · {recencyLabel}
        {hiddenCount > 0 ? ` \xB7 ${hiddenCount} hidden` : ""})
      </p>

      {shown.map((r) => {
        const p = getPlayer(r.reporterId);
        const tone =
          r.status === "banned"
            ? "text-danger ring-danger/30 bg-danger/10"
            : r.status === "case_closed"
              ? "text-muted-foreground ring-border bg-surface"
              : "text-warning ring-warning/30 bg-warning/10";
        const hasEvidence = r.evidence.trim().length > 0;
        return (
          <div
            key={r.id}
            className="bg-surface/40 ring-1 ring-border rounded-lg p-4"
          >
            <div className="flex items-center justify-between mb-3 gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className="size-6 rounded-sm grid place-items-center font-mono text-[10px] font-bold text-background shrink-0"
                  style={{ background: p.avatarColor }}
                >
                  {p.name
                    .replace(/[\[\]]/g, "")
                    .slice(0, 2)
                    .toUpperCase()}
                </div>
                <span className="text-sm font-semibold truncate">{p.name}</span>
                <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                  {r.submittedLabel}
                </span>
              </div>
              <span
                className={`text-[9px] font-bold uppercase tracking-wider ring-1 rounded px-1.5 py-0.5 ${tone}`}
              >
                {r.status === "case_closed" ? "case closed" : r.status}
              </span>
            </div>
            {!proofOnly && (
              <div className="mb-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                  Description
                </p>
                <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-line">
                  {r.description}
                </p>
              </div>
            )}
            <div>
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                Evidence
              </p>
              {hasEvidence ? (
                <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-line font-mono break-all">
                  {r.evidence}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No evidence attached.
                </p>
              )}
            </div>
          </div>
        );
      })}
      {shown.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          No reports with evidence yet. Reporters are still visible in the
          sidebar.
        </p>
      )}
    </div>
  );
}
function Chip({ active, onClick, children, color }) {
  const style = color
    ? active
      ? {
          backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
          color,
          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)`,
        }
      : {
          color: `color-mix(in oklab, ${color} 75%, transparent)`,
          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 25%, transparent)`,
        }
    : void 0;
  return (
    <button
      onClick={onClick}
      style={style}
      className={
        "px-2 py-1 text-[10px] font-semibold rounded uppercase transition-colors " +
        (color
          ? "hover:brightness-125"
          : active
            ? "bg-brand/10 text-brand ring-1 ring-brand/20"
            : "bg-surface text-muted-foreground ring-1 ring-border hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}
function TypeBadge({ type }) {
  const tone =
    type === "player_report"
      ? "bg-danger/10 text-danger ring-danger/20"
      : type === "ban_appeal"
        ? "bg-warning/10 text-warning ring-warning/20"
        : type === "vip_issue"
          ? "bg-brand/10 text-brand ring-brand/20"
          : "bg-surface text-muted-foreground ring-border";
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded ring-1 uppercase font-bold tracking-wider ${tone}`}
    >
      {TICKET_TYPE_LABEL[type]}
    </span>
  );
}
function StatusBadge({ status }) {
  const tone =
    status === "banned"
      ? "bg-danger/10 text-danger ring-danger/20"
      : status === "cleared"
        ? "bg-success/10 text-success ring-success/20"
        : status === "waiting_response"
          ? "bg-warning/10 text-warning ring-warning/20"
          : status === "closed"
            ? "bg-surface text-muted-foreground ring-border"
            : "bg-surface text-muted-foreground ring-border";
  return (
    <span
      className={`px-2 py-0.5 ring-1 text-[10px] font-bold rounded uppercase tracking-wider ${tone}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
export { Route };

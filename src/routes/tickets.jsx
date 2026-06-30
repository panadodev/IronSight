import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  ChevronDown,
  Copy,
  ExternalLink,
  FileIcon,
  Gamepad2,
  LayoutList,
  Search,
  Shield,
  UserSearch,
  Users,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

function typeFromTicket(ticket) {
  // Use the authoritative DB category first
  const cat = ticket.ticket_type_category;
  if (cat === "player_single" || cat === "player_multi") return "player_report";

  // Fall back to name-based inference for generic category (appeal, vip, etc.)
  const n = (ticket.ticket_type_name ?? "").toLowerCase();
  if (n.includes("ban appeal") || n.includes("appeal")) return "ban_appeal";
  if (n.includes("vip")) return "vip_issue";
  if (
    n.includes("cheating") ||
    n.includes("cheat") ||
    n.includes("teaming") ||
    n.includes("toxicity") ||
    n.includes("player report") ||
    n.includes("report")
  )
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
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

function formatHours(h) {
  if (h == null) return "—";
  return Math.round(Number(h)).toLocaleString();
}

function initials(name) {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function parseTeamInfoResponse(raw) {
  if (!raw) return null;
  const text = raw.replace(/^\[RCON\]\s*/i, "").trim();
  const idMatch = text.match(/\bID:\s*(\d+)/i);
  if (!idMatch) return null;
  const teamId = Number(idMatch[1]);
  const afterHeader = text
    .replace(/\bID:\s*\d+\s+steamID\s+username\s+online\s+leader\s*/i, "")
    .trim();
  if (!afterHeader) return { teamId, members: [] };
  const steamIdRe = /\b(7656119\d{10})\b/g;
  const positions = [];
  let m;
  while ((m = steamIdRe.exec(afterHeader)) !== null) {
    positions.push({ steamId: m[1], end: m.index + m[1].length });
  }
  if (!positions.length) return { teamId, members: [] };
  return {
    teamId,
    members: positions.map(({ steamId, end }, i) => {
      const nextStart =
        i + 1 < positions.length ? positions[i + 1].index : afterHeader.length;
      const segment = afterHeader.slice(end, nextStart).trim();
      const tokens = segment.split(/\s+/).filter(Boolean);
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
      return {
        steamId,
        username: tokens.join(" ") || "Unknown",
        online,
        leader,
      };
    }),
  };
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
  const {
    adminableOrgIds,
    orgs,
    sessionUser,
    orgsLoaded,
    sessionOrgPermissions,
  } = useAuth();

  const ticketOrgIds = useMemo(() => {
    const ids = new Set(adminableOrgIds);
    for (const org of orgs) {
      const perms = sessionOrgPermissions[org.id] ?? [];
      if (perms.includes("tickets_view") || perms.includes("tickets_manage"))
        ids.add(org.id);
    }
    return Array.from(ids);
  }, [adminableOrgIds, orgs, sessionOrgPermissions]);

  const [tab, setTab] = useState("active");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [selectedMedia, setSelectedMedia] = useState([]);
  const [submitterSteamAccounts, setSubmitterSteamAccounts] = useState([]);
  const [noteText, setNoteText] = useState("");
  const [replyText, setReplyText] = useState("");
  const [composerMode, setComposerMode] = useState("reply");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [orgServers, setOrgServers] = useState([]);
  const [orgStaff, setOrgStaff] = useState([]);
  const [orgPredefines, setOrgPredefines] = useState([]);

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
              type: typeFromTicket(t),
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
    setSelectedMedia([]);
    setSubmitterSteamAccounts([]);
    fetch(`/api/tickets/${selectedId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { messages: [], media: [] }))
      .then((data) => {
        if (!cancelled) {
          setSelectedMessages(data.messages ?? []);
          setSelectedMedia(data.media ?? []);
          setSubmitterSteamAccounts(data.submitterSteamAccounts ?? []);
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

  const selectedOrgId =
    tickets.find((t) => t.ticket_id === selectedId)?.org_id ?? null;

  useEffect(() => {
    if (!selectedOrgId) return;
    fetch("/api/servers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { servers: [] }))
      .then((data) => {
        const filtered = (data.servers ?? []).filter(
          (s) => s.ownerOrgId === selectedOrgId && s.rconConfigured,
        );
        setOrgServers(filtered);
      })
      .catch(() => {});
  }, [selectedOrgId]);

  useEffect(() => {
    if (!selectedOrgId) return;
    let cancelled = false;
    fetch(`/api/orgs/${encodeURIComponent(selectedOrgId)}/ticket-assignees`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((data) => {
        if (!cancelled) setOrgStaff(data.members ?? []);
      })
      .catch(() => {
        if (!cancelled) setOrgStaff([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOrgId]);

  useEffect(() => {
    if (!selectedOrgId) return;
    let cancelled = false;
    fetch(`/api/orgs/${encodeURIComponent(selectedOrgId)}/predefines`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : { predefines: [] }))
      .then((data) => {
        if (!cancelled) setOrgPredefines(data.predefines ?? []);
      })
      .catch(() => {
        if (!cancelled) setOrgPredefines([]);
      });
    return () => {
      cancelled = true;
    };
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

  const refreshMessages = useCallback(async () => {
    if (!selectedId) return;
    const res = await fetch(`/api/tickets/${selectedId}`, {
      credentials: "include",
    });
    if (res.ok) {
      const data = await res.json();
      setSelectedMessages(data.messages ?? []);
      setSelectedMedia(data.media ?? []);
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const es = new EventSource(`/api/tickets/${selectedId}/stream`, {
      withCredentials: true,
    });
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "new_message") {
          setSelectedMessages((prev) =>
            prev.some((m) => m.messageId === event.message.messageId)
              ? prev
              : [...prev, event.message],
          );
        } else if (event.type === "ticket_updated") {
          setTickets((prev) =>
            prev.map((t) =>
              t.ticket_id === selectedId ? { ...t, ...event.ticket } : t,
            ),
          );
        }
      } catch {}
    };
    return () => es.close();
  }, [selectedId]);

  const handlePostNote = useCallback(async () => {
    if (!noteText.trim() || !selectedId || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch(`/api/tickets/${selectedId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: noteText.trim(), isInternal: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSubmitError(data?.error ?? "Failed to post note.");
        return;
      }
      setNoteText("");
      await refreshMessages();
    } finally {
      setSubmitting(false);
    }
  }, [noteText, selectedId, submitting, refreshMessages]);

  const handlePostReply = useCallback(async () => {
    if (!replyText.trim() || !selectedId || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch(`/api/tickets/${selectedId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: replyText.trim(), isInternal: false }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSubmitError(data?.error ?? "Failed to send reply.");
        return;
      }
      setReplyText("");
      await refreshMessages();
    } finally {
      setSubmitting(false);
    }
  }, [replyText, selectedId, submitting, refreshMessages]);

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

  const handleAssign = useCallback(
    async (userId, username) => {
      if (!selectedId) return;
      const res = await fetch(`/api/tickets/${selectedId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedTo: userId }),
      });
      if (res.ok) {
        setTickets((prev) =>
          prev.map((t) =>
            t.ticket_id === selectedId
              ? { ...t, assigned_to: userId, assigned_to_username: username }
              : t,
          ),
        );
      }
    },
    [selectedId],
  );

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

  const hasPlayerIntelAccess =
    selectedOrgId &&
    (adminableOrgIds.includes(selectedOrgId) ||
      (sessionOrgPermissions[selectedOrgId] ?? []).includes(
        "tickets_player_intel",
      ));

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
              media={selectedMedia}
              noteText={noteText}
              onNoteChange={setNoteText}
              onPostNote={handlePostNote}
              replyText={replyText}
              onReplyChange={setReplyText}
              onPostReply={handlePostReply}
              composerMode={composerMode}
              onComposerModeChange={setComposerMode}
              onClaim={handleClaim}
              onAssign={handleAssign}
              onUpdateStatus={handleUpdateStatus}
              submitting={submitting}
              submitError={submitError}
              detailLoading={detailLoading}
              sessionUser={sessionUser}
              orgStaff={orgStaff}
              predefines={orgPredefines}
            />
          </main>
        ) : (
          <main className="flex-1 grid place-items-center border-r border-border">
            <p className="text-sm text-muted-foreground">
              {loading ? "Loading tickets..." : "Select a ticket"}
            </p>
          </main>
        )}

        {/* Right: player intel / team info panel */}
        {selectedTicket &&
          (hasPlayerIntelAccess ? (
            <PlayerIntelSidebar
              ticketId={selectedId}
              orgId={selectedOrgId}
              servers={orgServers}
              submitterUsername={selectedTicket.created_by_username}
              submitterSteamId={selectedTicket.created_by_steam_id}
              submitterSteamAccounts={submitterSteamAccounts}
              ticketCreatedAt={selectedTicket.created_at}
            />
          ) : (
            <TeamInfoPanel servers={orgServers} />
          ))}
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

function PredefinesPicker({ predefines, ticketTypeId, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const relevant = useMemo(() => {
    const q = query.trim().toLowerCase();
    return predefines.filter((p) => {
      // Show if scoped to this ticket type, or unscoped (applies to all)
      const typeMatch =
        !p.ticketTypeIds?.length ||
        (ticketTypeId != null && p.ticketTypeIds.includes(ticketTypeId));
      if (!typeMatch) return false;
      if (!q) return true;
      return (
        p.keyword.toLowerCase().includes(q) ||
        p.extraKeywords.some((k) => k.toLowerCase().includes(q)) ||
        p.content.toLowerCase().includes(q)
      );
    });
  }, [predefines, ticketTypeId, query]);

  if (!predefines.length) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        title="Insert pre-define"
        className={`flex items-center gap-1 text-[10px] font-mono rounded px-2 py-0.5 ring-1 transition-colors ${
          open
            ? "bg-brand text-brand-foreground ring-brand"
            : "bg-surface/60 ring-border text-muted-foreground hover:text-foreground"
        }`}
      >
        <LayoutList size={10} />
        Pre-defines
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-20 w-72 bg-surface border border-border rounded-md shadow-lg overflow-hidden">
          <div className="p-2 border-b border-border">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pre-defines..."
              className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {relevant.length === 0 ? (
              <div className="px-3 py-3 text-[10px] font-mono text-muted-foreground">
                No pre-defines
                {query ? " match your search" : " for this ticket type"}.
              </div>
            ) : (
              relevant.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelect(p.content);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-surface-bright transition-colors border-b border-border last:border-0"
                >
                  <p className="text-[10px] font-mono font-bold text-foreground">
                    {p.keyword}
                  </p>
                  <p className="text-[9px] text-muted-foreground line-clamp-2 mt-0.5 leading-snug">
                    {p.content}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AssignDropdown({ ticket, orgStaff, onAssign }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] font-mono bg-surface/60 ring-1 ring-border rounded px-2 py-0.5 hover:bg-surface transition-colors"
      >
        {ticket.assigned_to_username ?? "Assign"}
        <ChevronDown size={9} className="text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-20 min-w-[160px] bg-surface border border-border rounded-md shadow-lg overflow-hidden">
          {orgStaff.length === 0 ? (
            <div className="px-3 py-2 text-[10px] font-mono text-muted-foreground">
              No staff
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {ticket.assigned_to && (
                <button
                  onClick={() => {
                    onAssign(null, null);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-muted-foreground hover:bg-surface-bright transition-colors"
                >
                  Unassign
                </button>
              )}
              {orgStaff.map((m) => (
                <button
                  key={m.userId}
                  onClick={() => {
                    onAssign(m.userId, m.username);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-[10px] font-mono hover:bg-surface-bright transition-colors ${
                    ticket.assigned_to === m.userId
                      ? "text-brand"
                      : "text-foreground"
                  }`}
                >
                  {m.username}
                  {ticket.assigned_to === m.userId && " ✓"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TicketDetail({
  ticket,
  messages,
  media = [],
  noteText,
  onNoteChange,
  onPostNote,
  replyText,
  onReplyChange,
  onPostReply,
  composerMode,
  onComposerModeChange,
  onClaim,
  onAssign,
  onUpdateStatus,
  submitting,
  submitError,
  detailLoading,
  sessionUser,
  orgStaff,
  predefines = [],
}) {
  const isClaimed = ticket.assigned_to === sessionUser?.userId;
  const isClosed = ticket.status === "closed";
  const internalMessages = messages.filter((m) => m.isInternal);
  const publicMessages = messages.filter((m) => !m.isInternal);

  return (
    <div className="flex flex-col h-full overflow-hidden">
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
          <AssignDropdown
            ticket={ticket}
            orgStaff={orgStaff}
            onAssign={onAssign}
          />
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
            {media.length > 0 && (
              <div className="px-4 py-2 space-y-2">
                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                  Evidence / Attachments
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {media.map((item) => (
                    <a
                      key={item.mediaId}
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative rounded ring-1 ring-border hover:ring-brand transition-colors overflow-hidden"
                    >
                      {item.fileType === "image" && item.url ? (
                        <img
                          src={item.url}
                          alt={item.title || item.filename}
                          className="w-full aspect-square object-cover group-hover:opacity-75 transition-opacity"
                        />
                      ) : item.fileType === "video" && item.url ? (
                        <video
                          src={item.url}
                          className="w-full aspect-square object-cover group-hover:opacity-75 transition-opacity"
                          preload="metadata"
                        />
                      ) : (
                        <div className="w-full aspect-square bg-surface/40 flex items-center justify-center">
                          <FileIcon className="size-6 text-muted-foreground" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                      {(item.title || item.filename) && (
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <p className="text-[9px] text-white truncate">
                            {item.title || item.filename}
                          </p>
                        </div>
                      )}
                    </a>
                  ))}
                </div>
              </div>
            )}
            {messages.length === 0 && media.length === 0 && (
              <div className="text-[10px] text-muted-foreground text-center py-10">
                No messages yet
              </div>
            )}
          </>
        )}
      </div>

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
          <div className="ml-auto">
            <PredefinesPicker
              predefines={predefines}
              ticketTypeId={ticket.ticket_type_id ?? null}
              onSelect={(content) => {
                if (composerMode === "reply") {
                  onReplyChange(
                    replyText ? `${replyText}\n\n${content}` : content,
                  );
                } else {
                  onNoteChange(
                    noteText ? `${noteText}\n\n${content}` : content,
                  );
                }
              }}
            />
          </div>
        </div>
        {submitError && (
          <p className="text-[10px] font-mono text-danger mb-2">
            {submitError}
          </p>
        )}
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

// ── Player Intel Sidebar ──────────────────────────────────────────────────────

function CopyButton({ text, className = "" }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handle}
      title={copied ? "Copied!" : "Copy"}
      className={`inline-flex items-center justify-center rounded hover:bg-muted transition-colors p-0.5 ${className}`}
    >
      <Copy size={10} className="text-muted-foreground" />
    </button>
  );
}

function ExternalLinks({ steamId, size = 13 }) {
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0">
      <Link
        to="/player-lookup"
        search={{ steam: steamId }}
        title="Open in Player Lookup"
        className="inline-flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground p-1"
      >
        <UserSearch size={size} aria-hidden />
      </Link>
      <a
        href={`https://steamcommunity.com/profiles/${steamId}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Open Steam profile"
        className="inline-flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground p-1"
      >
        <Gamepad2 size={size} aria-hidden />
      </a>
      <a
        href={`https://www.battlemetrics.com/players?filter%5Bsearch%5D=${steamId}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Open BattleMetrics profile"
        className="inline-flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground p-1"
      >
        <Activity size={size} aria-hidden />
      </a>
    </span>
  );
}

function PlayerCard({ player }) {
  const name = player.displayName ?? player.steamId;
  const kd =
    player.bm && player.bm.deaths > 0
      ? (player.bm.kills / player.bm.deaths).toFixed(2)
      : player.bm?.kills
        ? player.bm.kills
        : "—";
  const proxy = player.ipHistory?.find((ip) => !ip.isVpn);
  const isProxy = proxy?.isProxy ?? null;
  const country = proxy?.country ?? null;

  return (
    <div className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <div className="flex items-center gap-3 mb-4">
        {player.avatarUrl ? (
          <img
            src={player.avatarUrl}
            alt={name}
            className="size-12 rounded ring-1 ring-black/40 shrink-0"
          />
        ) : (
          <div className="size-12 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background bg-brand/70 shrink-0 text-lg">
            {initials(name)}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">{name}</h3>
          <p className="text-[10px] font-mono text-muted-foreground uppercase truncate flex items-center gap-0.5">
            <span className="truncate">{player.steamId}</span>
            <CopyButton text={player.steamId} />
            <ExternalLinks steamId={player.steamId} />
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-y-3">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase">S-Hours</p>
          <p className="text-sm font-mono text-foreground">
            {formatHours(player.steam?.rustHours)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase">
            BM-Hours
          </p>
          <p className="text-sm font-mono text-foreground">
            {formatHours(player.bm?.rustHours)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase">
            AIM-TRAIN Hours
          </p>
          <p className="text-sm font-mono text-foreground">
            {formatHours(player.bm?.aimtrainHours)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase">K.D</p>
          <p className="text-sm font-mono text-foreground">{kd}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase">Proxy</p>
          <p
            className={`text-sm font-mono ${isProxy === null ? "text-muted-foreground" : isProxy ? "text-danger" : "text-success"}`}
          >
            {isProxy === null ? "—" : isProxy ? "True" : "False"}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase">
            Location
          </p>
          <p className="text-sm font-mono text-foreground">{country ?? "—"}</p>
        </div>
      </div>
    </div>
  );
}

function OrgBansSection({ orgBans }) {
  const now = Math.floor(Date.now() / 1000);
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>Previous Offenses</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {orgBans.length}
        </span>
      </h2>
      {orgBans.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No offenses on record.
        </p>
      ) : (
        <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-muted-foreground bg-surface/60">
                <th className="px-1.5 py-1 text-left font-medium">Type</th>
                <th className="px-1.5 py-1 text-left font-medium">Status</th>
                <th className="px-1.5 py-1 text-left font-medium">Reason</th>
                <th className="px-1.5 py-1 text-left font-medium">Staff</th>
                <th className="px-1.5 py-1 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {orgBans.map((b) => {
                const expired = b.expiresAt && b.expiresAt < now;
                const active =
                  !b.revoked && (!b.expiresAt || b.expiresAt > now);
                let statusText = "—";
                let statusColor = "text-muted-foreground";
                if (b.revoked) {
                  statusText = "Revoked";
                  statusColor = "text-muted-foreground";
                } else if (b.expiresAt) {
                  if (expired) {
                    statusText = `Expired ${formatRelativeTime(b.expiresAt)}`;
                    statusColor = "text-muted-foreground";
                  } else {
                    const diff = b.expiresAt - now;
                    const days = Math.ceil(diff / 86400);
                    statusText = `Expires in ${days}d`;
                    statusColor = "text-warning";
                  }
                } else if (active) {
                  statusText = "Permanent";
                  statusColor = "text-danger";
                }
                return (
                  <tr key={b.banId} className="border-t border-border">
                    <td
                      className={`px-1.5 py-1 font-bold uppercase ${b.actionType === "ban" ? "text-danger" : "text-warning"}`}
                    >
                      {b.actionType === "ban" ? "Ban" : "Mute"}
                    </td>
                    <td className={`px-1.5 py-1 ${statusColor}`}>
                      {statusText}
                    </td>
                    <td className="px-1.5 py-1 text-foreground truncate max-w-[80px]">
                      {b.reason || b.category || "—"}
                    </td>
                    <td className="px-1.5 py-1 text-muted-foreground truncate">
                      {b.issuedByUsername ?? "—"}
                    </td>
                    <td className="px-1.5 py-1 text-right text-muted-foreground">
                      {formatRelativeTime(b.issuedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BmBansSection({ bmBans }) {
  const now = Math.floor(Date.now() / 1000);
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>
          Bans on Other Orgs
          <span className="ml-2 normal-case tracking-normal text-[9px] text-muted-foreground/70">
            (read-only · BattleMetrics)
          </span>
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {bmBans.length}
        </span>
      </h2>
      {bmBans.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No BattleMetrics bans on record.
        </p>
      ) : (
        <div className="space-y-1.5">
          {bmBans.slice(0, 5).map((b) => {
            const expired = b.expiresAt && b.expiresAt < now;
            return (
              <div
                key={b.bmBanId}
                className="bg-surface/40 ring-1 ring-border rounded px-2 py-1.5 flex items-start gap-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-medium truncate">
                    {b.bmOrgName ?? "Unknown org"}
                  </p>
                  <p className="text-[9px] font-mono text-muted-foreground truncate">
                    {b.reason ?? "No reason"}
                  </p>
                </div>
                <span
                  className={`text-[9px] font-mono font-bold uppercase shrink-0 ${expired ? "text-muted-foreground" : "text-danger"}`}
                >
                  {b.permanent ? "Perm" : expired ? "Exp" : "Active"}
                </span>
              </div>
            );
          })}
          {bmBans.length > 5 && (
            <p className="text-[9px] font-mono text-muted-foreground text-center">
              +{bmBans.length - 5} more
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function IpLinkedSection({ relatedAccounts, ipHistory, steamId }) {
  const nonProxyIps = ipHistory?.filter((ip) => !ip.isProxy && !ip.isVpn) ?? [];
  const hasResidentialIps = nonProxyIps.length > 0;
  const linked = relatedAccounts?.length ?? 0;
  const withBmBans = relatedAccounts?.filter((r) => r.hasBmBans).length ?? 0;
  const withEacBans = relatedAccounts?.filter((r) => r.hasEacBans).length ?? 0;

  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Wifi className="size-3" aria-hidden />
          IP-Linked Accounts
        </span>
        <Link
          to="/player-lookup"
          search={{ steam: steamId }}
          className="text-[9px] font-mono uppercase tracking-wider text-brand hover:underline inline-flex items-center gap-1"
        >
          Lookup <ExternalLink className="size-2.5" aria-hidden />
        </Link>
      </h2>
      {linked === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No linked accounts found.
        </p>
      ) : (
        <div className="bg-surface/40 ring-1 ring-border rounded-lg p-3 space-y-2">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-lg font-mono font-bold text-foreground">
                {linked}
              </p>
              <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                Linked
              </p>
            </div>
            <div>
              <p
                className={`text-lg font-mono font-bold ${withBmBans > 0 ? "text-danger" : "text-foreground"}`}
              >
                {withBmBans}
              </p>
              <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                BM Bans
              </p>
            </div>
            <div>
              <p
                className={`text-lg font-mono font-bold ${withEacBans > 0 ? "text-warning" : "text-foreground"}`}
              >
                {withEacBans}
              </p>
              <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                EAC Bans
              </p>
            </div>
          </div>
          {hasResidentialIps && (withBmBans > 0 || withEacBans > 0) && (
            <div className="flex items-start gap-2 bg-danger/10 ring-1 ring-danger/40 rounded p-2">
              <Shield
                className="size-3.5 text-danger shrink-0 mt-0.5"
                aria-hidden
              />
              <p className="text-[10px] text-danger leading-snug">
                <span className="font-bold">{withBmBans + withEacBans}</span>{" "}
                linked account
                {withBmBans + withEacBans !== 1 ? "s" : ""} share a{" "}
                <span className="font-bold">residential IP</span> and have a ban
                record.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ServerHistorySection({ bmSessions }) {
  const sessions = (bmSessions ?? [])
    .slice()
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
    .slice(0, 6);

  function fmtDuration(hours) {
    if (!hours) return "—";
    const h = Math.floor(Number(hours));
    const m = Math.round((Number(hours) - h) * 60);
    if (h === 0) return `${m}m`;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center justify-between">
        <span>Server History</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {sessions.length}
        </span>
      </h2>
      {sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No server history available.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((s) => (
            <li
              key={s.bmServerId}
              className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1"
            >
              <span className="text-[10px] font-medium truncate min-w-0 flex-1">
                {s.serverName ?? s.bmServerId}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground shrink-0">
                {fmtDuration(s.hoursPlayed)}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground shrink-0">
                {s.lastSeen ? formatRelativeTime(s.lastSeen) : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RconTeamSection({ servers, initialSteamId = "" }) {
  const [steamId, setSteamId] = useState(initialSteamId);
  const [serverId, setServerId] = useState(servers[0]?.serverId ?? "");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setServerId((prev) => {
      const still = servers.some((s) => s.serverId === prev);
      return still ? prev : (servers[0]?.serverId ?? "");
    });
  }, [servers]);

  // When the viewed player changes, reset and auto-run across all servers
  useEffect(() => {
    setSteamId(initialSteamId);
    setResult(null);
    setError("");
    const sid = initialSteamId.trim();
    if (!sid || servers.length === 0) return;
    let cancelled = false;
    setLoading(true);
    const tryServer = (server) =>
      fetch(`/api/servers/${encodeURIComponent(server.serverId)}/rcon/exec`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: `teaminfo ${sid}` }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return null;
          const parsed = parseTeamInfoResponse(data.response ?? "");
          return parsed && parsed.members.length > 0
            ? { server, parsed }
            : null;
        })
        .catch(() => null);
    Promise.all(servers.map(tryServer)).then((results) => {
      if (cancelled) return;
      const hit = results.find(Boolean);
      if (hit) {
        setServerId(hit.server.serverId);
        setResult(hit.parsed);
      } else {
        setError("Player is not in a team on any server.");
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [initialSteamId, servers]);

  const handleLookup = async () => {
    const sid = steamId.trim();
    if (!sid || !serverId || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/rcon/exec`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: `teaminfo ${sid}` }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "RCON command failed");
        return;
      }
      const parsed = parseTeamInfoResponse(data.response ?? "");
      if (parsed && parsed.members.length > 0) {
        setResult(parsed);
      } else {
        setError("Player is not in a team or no result returned.");
      }
    } catch {
      setError("Failed to reach server.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <Users className="size-3" aria-hidden />
        RCON Team Lookup
      </h2>
      <div className="space-y-2">
        <input
          value={steamId}
          onChange={(e) => setSteamId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          placeholder="Steam ID..."
          disabled={loading}
          className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
        />
        {servers.length > 1 && (
          <select
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
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
            No RCON servers configured.
          </p>
        )}
        <button
          onClick={handleLookup}
          disabled={
            !steamId.trim() || !serverId || loading || servers.length === 0
          }
          className="w-full text-[10px] font-mono bg-brand text-brand-foreground rounded py-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {loading ? "Looking up..." : "Lookup"}
        </button>
        {error && (
          <p className="text-[10px] font-mono text-danger leading-snug">
            {error}
          </p>
        )}
        {result && (
          <div>
            <div className="text-[9px] font-mono text-muted-foreground mb-1.5">
              Team #{result.teamId} · {result.members.length} member
              {result.members.length !== 1 ? "s" : ""}
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
                    <ExternalLinks steamId={member.steamId} size={9} />
                  </div>
                  <div className="text-[9px] font-mono text-muted-foreground mt-0.5 truncate flex items-center gap-1">
                    {member.steamId}
                    <CopyButton text={member.steamId} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function PlayerIntelSidebar({
  ticketId,
  orgId,
  servers,
  submitterUsername,
  submitterSteamId,
  submitterSteamAccounts,
  ticketCreatedAt,
}) {
  const [intelData, setIntelData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (!ticketId) return;
    let cancelled = false;
    setLoading(true);
    setIntelData(null);
    setSelectedIdx(0);
    fetch(`/api/tickets/${ticketId}/player-intel`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { players: [] }))
      .then((data) => {
        if (!cancelled) {
          setIntelData(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const players = intelData?.players ?? [];
  const player = players[selectedIdx] ?? null;
  const hasPlayers = players.length > 0;

  return (
    <aside className="w-[28rem] shrink-0 border-l border-border bg-background overflow-y-auto">
      <div className="p-6 space-y-8">
        {loading && (
          <div className="text-[10px] font-mono text-muted-foreground text-center py-10">
            Loading player intel...
          </div>
        )}

        {!loading && hasPlayers && players.length > 1 && (
          <div className="flex gap-1 flex-wrap">
            {players.map((p, i) => (
              <button
                key={p.steamId}
                onClick={() => setSelectedIdx(i)}
                className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ring-1 ${
                  i === selectedIdx
                    ? "bg-brand text-brand-foreground ring-brand"
                    : "text-muted-foreground ring-border hover:text-foreground"
                }`}
              >
                {p.displayName ?? p.steamId.slice(-6)}
              </button>
            ))}
          </div>
        )}

        {!loading && player && !player.fetching && (
          <>
            <section>
              <PlayerCard player={player} />
            </section>

            <OrgBansSection orgBans={player.orgBans ?? []} />

            <BmBansSection bmBans={player.bmBans ?? []} />

            <IpLinkedSection
              relatedAccounts={player.relatedAccounts}
              ipHistory={player.ipHistory}
              steamId={player.steamId}
            />

            <ServerHistorySection bmSessions={player.bmSessions} />
          </>
        )}

        {!loading && player?.fetching && (
          <div className="bg-surface/40 ring-1 ring-border rounded-lg p-4 text-center space-y-2">
            <p className="text-[10px] font-mono text-muted-foreground">
              Player data is being fetched from Steam & BattleMetrics.
            </p>
            <p className="text-[10px] font-mono text-muted-foreground">
              Refresh in a moment to see their profile.
            </p>
          </div>
        )}

        {!loading && !hasPlayers && (
          <div className="bg-surface/40 ring-1 ring-border rounded-lg p-4 text-center">
            <p className="text-[10px] font-mono text-muted-foreground">
              No reported players on this ticket.
            </p>
          </div>
        )}

        <RconTeamSection
          servers={servers}
          initialSteamId={player?.steamId ?? ""}
        />

        {submitterUsername && (
          <section>
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
              <span>Reporter</span>
              <span className="font-mono normal-case tracking-normal text-muted-foreground">
                {formatRelativeTime(ticketCreatedAt)}
              </span>
            </h2>
            <div className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1.5 mb-2">
              <div className="size-5 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background bg-muted-foreground/40 shrink-0 text-[8px]">
                {initials(submitterUsername)}
              </div>
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <p className="text-xs font-medium truncate">
                  {submitterUsername}
                </p>
                {submitterSteamId && (
                  <ExternalLinks steamId={submitterSteamId} size={10} />
                )}
              </div>
            </div>
            {submitterSteamAccounts && submitterSteamAccounts.length > 1 && (
              <div className="space-y-1">
                <p className="text-[10px] font-mono text-warning uppercase tracking-widest">
                  Multiple Steam accounts linked
                </p>
                {submitterSteamAccounts.map((acct) => (
                  <div
                    key={acct.steamId}
                    className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1.5"
                  >
                    {acct.isPrimary && (
                      <span className="shrink-0 text-[8px] font-mono px-1 py-0.5 rounded bg-brand/15 text-brand ring-1 ring-brand/30">
                        PRIMARY
                      </span>
                    )}
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <p className="text-xs font-medium truncate">
                        {acct.steamName ?? acct.steamId}
                      </p>
                      <ExternalLinks steamId={acct.steamId} size={10} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

// ── Fallback team info panel (no intel access) ────────────────────────────────

function TeamInfoPanel({ servers }) {
  const [steamId, setSteamId] = useState("");
  const [serverId, setServerId] = useState(servers[0]?.serverId ?? "");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setServerId((prev) => {
      const still = servers.some((s) => s.serverId === prev);
      return still ? prev : (servers[0]?.serverId ?? "");
    });
  }, [servers]);

  const handleLookup = async () => {
    const sid = steamId.trim();
    if (!sid || !serverId || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/rcon/exec`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: `teaminfo ${sid}` }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "RCON command failed");
        return;
      }
      const parsed = parseTeamInfoResponse(data.response ?? "");
      if (parsed && parsed.members.length > 0) {
        setResult(parsed);
      } else {
        setError("Player is not in a team or no result returned.");
      }
    } catch {
      setError("Failed to reach server.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="w-[220px] shrink-0 flex flex-col bg-background overflow-hidden">
      <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-1.5">
        <Users size={10} className="text-muted-foreground shrink-0" />
        <span className="text-[10px] font-mono uppercase tracking-widest font-bold">
          Team Info
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        <input
          value={steamId}
          onChange={(e) => setSteamId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          placeholder="Steam ID..."
          disabled={loading}
          className="w-full bg-background border border-border rounded px-2 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
        />
        {servers.length > 1 && (
          <select
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
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
          onClick={handleLookup}
          disabled={
            !steamId.trim() || !serverId || loading || servers.length === 0
          }
          className="w-full text-[10px] font-mono bg-brand text-brand-foreground rounded py-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {loading ? "Looking up..." : "Lookup"}
        </button>
        {error && (
          <p className="text-[10px] font-mono text-danger leading-snug">
            {error}
          </p>
        )}
        {result && (
          <div>
            <div className="text-[9px] font-mono text-muted-foreground mb-1.5">
              Team #{result.teamId} · {result.members.length} member
              {result.members.length !== 1 ? "s" : ""}
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

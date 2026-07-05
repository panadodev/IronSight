import { SiteNav } from "@/components/site-nav";
import { Markdown } from "@/components/markdown";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileIcon,
  Gamepad2,
  LayoutList,
  Maximize2,
  Minimize2,
  Search,
  Shield,
  UserCheck,
  UserSearch,
  Users,
  Wifi,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/tickets")({
  head: () => ({ meta: [{ title: "Ticket Queue - IronSight" }] }),
  component: TicketsPage,
});

const IP_IN_TEXT_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

// A ticket's display "kind" is derived only from authoritative data: the
// server-set `category` (auto/case overrides) and the ticket type's own
// `ticket_type_category` column — never by string-matching the type name.
// Structural kinds get fixed colours; every other (generic) type is shown under
// its real configured name with a colour derived deterministically from that
// name, so custom types like "Bug Report" render correctly and consistently
// without any per-name special-casing.
const STRUCTURAL_KINDS = {
  REPORT: {
    key: "REPORT",
    label: "Report",
    color: "text-rose-400",
    dot: "bg-rose-400",
  },
  APPLY: {
    key: "APPLY",
    label: "Apply",
    color: "text-purple-400",
    dot: "bg-purple-400",
  },
  AUTO: {
    key: "AUTO",
    label: "Auto",
    color: "text-orange-400",
    dot: "bg-orange-400",
  },
  CASE: {
    key: "CASE",
    label: "Case",
    color: "text-sky-400",
    dot: "bg-sky-400",
  },
};

// Order structural kinds ahead of generic ones in the filter row.
const STRUCTURAL_ORDER = ["REPORT", "APPLY", "AUTO", "CASE"];

// Palette for generic ticket types, picked so none collide with the structural
// kind colours above.
const GENERIC_PALETTE = [
  { color: "text-green-400", dot: "bg-green-400" },
  { color: "text-yellow-400", dot: "bg-yellow-400" },
  { color: "text-cyan-400", dot: "bg-cyan-400" },
  { color: "text-lime-400", dot: "bg-lime-400" },
  { color: "text-fuchsia-400", dot: "bg-fuchsia-400" },
  { color: "text-teal-400", dot: "bg-teal-400" },
  { color: "text-amber-400", dot: "bg-amber-400" },
  { color: "text-indigo-400", dot: "bg-indigo-400" },
];

// Deterministic string hash (FNV-1a) → palette index, so a given type name
// always maps to the same colour across reloads and across orgs.
function paletteForName(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return GENERIC_PALETTE[Math.abs(h) % GENERIC_PALETTE.length];
}

// Returns { key, label, color, dot } for a ticket. `key` is stable per kind and
// used for filtering/counting.
function ticketKind(ticket) {
  // Server-set overrides win (auto-opened threats, staff-initiated cases).
  if (ticket.category === "threat_auto") return STRUCTURAL_KINDS.AUTO;
  if (ticket.category === "staff_case") return STRUCTURAL_KINDS.CASE;

  const cat = ticket.ticket_type_category;
  if (cat === "player_single" || cat === "player_multi")
    return STRUCTURAL_KINDS.REPORT;
  if (cat === "staff_application") return STRUCTURAL_KINDS.APPLY;

  // Generic type: identify it by its real configured name, grouped
  // case-insensitively so the same type across orgs shares one chip/colour.
  const label = ticket.ticket_type_name?.trim() || "Support";
  const norm = label.toLowerCase();
  return { key: `TYPE:${norm}`, label, ...paletteForName(norm) };
}

// The person who opened the ticket plays a different role depending on the
// ticket type. Derived from category only — generic types are just "Submitter".
function submitterRoleLabel(ticket) {
  if (ticket?.category === "threat_auto" || ticket?.category === "staff_case")
    return "Submitter";
  const cat = ticket?.ticket_type_category;
  if (cat === "player_single" || cat === "player_multi") return "Reporter";
  if (cat === "staff_application") return "Applicant";
  return "Submitter";
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
    positions.push({
      steamId: m[1],
      index: m.index,
      end: m.index + m[1].length,
    });
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

function TicketsPage() {
  const {
    adminableOrgIds,
    orgs,
    sessionUser,
    orgsLoaded,
    sessionOrgPermissions,
    selectedOrgIds,
  } = useAuth();

  const ticketOrgIds = useMemo(() => {
    const ids = new Set(adminableOrgIds);
    for (const org of orgs) {
      const perms = sessionOrgPermissions[org.id] ?? [];
      if (
        perms.includes("tickets_view") ||
        perms.includes("tickets_manage") ||
        perms.includes("applications_view")
      )
        ids.add(org.id);
    }
    return Array.from(ids).filter((id) => selectedOrgIds.includes(id));
  }, [adminableOrgIds, orgs, sessionOrgPermissions, selectedOrgIds]);

  const applicationOrgIds = useMemo(() => {
    const ids = new Set(adminableOrgIds);
    for (const org of orgs) {
      const perms = sessionOrgPermissions[org.id] ?? [];
      if (perms.includes("applications_view")) ids.add(org.id);
    }
    return Array.from(ids).filter((id) => selectedOrgIds.includes(id));
  }, [adminableOrgIds, orgs, sessionOrgPermissions, selectedOrgIds]);

  const [tab, setTab] = useState("active");
  const [assignee, setAssignee] = useState("all");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [selectedMedia, setSelectedMedia] = useState([]);
  const [selectedFormData, setSelectedFormData] = useState([]);
  const [submitterSteamAccounts, setSubmitterSteamAccounts] = useState([]);
  const [noteText, setNoteText] = useState("");
  const [replyText, setReplyText] = useState("");
  const [composerMode, setComposerModeRaw] = useState("note");
  const setComposerMode = useCallback((mode) => {
    setComposerModeRaw(mode);
    setSubmitError("");
  }, []);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [orgServers, setOrgServers] = useState([]);
  const [orgStaff, setOrgStaff] = useState([]);
  const [orgPredefines, setOrgPredefines] = useState([]);
  // null = blacklist manager closed; otherwise the prefill for the add form.
  const [blacklistPrefill, setBlacklistPrefill] = useState(null);

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
              kind: ticketKind(t),
            })),
          )
          .catch(() => []),
      ),
    ).then((results) => {
      if (cancelled) return;
      const all = results.flat().sort((a, b) => b.created_at - a.created_at);
      setTickets(all);
      const first = all.find(
        (t) =>
          t.ticket_type_category !== "staff_application" ||
          applicationOrgIds.includes(t.org_id),
      );
      if (first) setSelectedId((prev) => prev ?? first.ticket_id);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [orgsLoaded, ticketOrgIds, applicationOrgIds]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setDetailLoading(true);
    setSelectedMessages([]);
    setSelectedMedia([]);
    setSelectedFormData([]);
    setSubmitterSteamAccounts([]);
    setSubmitError("");
    fetch(`/api/tickets/${selectedId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { messages: [], media: [] }))
      .then((data) => {
        if (!cancelled) {
          setSelectedMessages(data.messages ?? []);
          setSelectedMedia(data.media ?? []);
          setSelectedFormData(
            Array.isArray(data.ticket?.form_data) ? data.ticket.form_data : [],
          );
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

  // Application tickets only surface for orgs where the caller has
  // applications_view; everything else in the queue is already scoped
  // by ticketOrgIds at fetch time.
  const visibleTickets = useMemo(
    () =>
      tickets.filter(
        (t) =>
          t.ticket_type_category !== "staff_application" ||
          applicationOrgIds.includes(t.org_id),
      ),
    [tickets, applicationOrgIds],
  );

  const totalNonClosed = useMemo(
    () => visibleTickets.filter((t) => NON_CLOSED.has(t.status)).length,
    [visibleTickets],
  );

  // Tab + search narrowing, before the assignee and type filters — so the
  // "My tickets" and per-type counts stay live for the current view.
  const baseTickets = useMemo(() => {
    const statuses = TAB_STATUSES[tab];
    const q = search.trim().toLowerCase();
    return visibleTickets.filter((t) => {
      if (!statuses.has(t.status)) return false;
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
  }, [tab, search, visibleTickets]);

  const myTicketCount = useMemo(
    () =>
      sessionUser?.userId
        ? baseTickets.filter((t) => t.assigned_to === sessionUser.userId).length
        : 0,
    [baseTickets, sessionUser],
  );

  const scopedTickets = useMemo(
    () =>
      assignee === "mine"
        ? baseTickets.filter((t) => t.assigned_to === sessionUser?.userId)
        : baseTickets,
    [assignee, baseTickets, sessionUser],
  );

  const typeCounts = useMemo(() => {
    const counts = {};
    for (const t of scopedTickets)
      counts[t.kind.key] = (counts[t.kind.key] ?? 0) + 1;
    return counts;
  }, [scopedTickets]);

  // Filter chips are built from the kinds actually present: structural kinds in
  // a fixed order, then generic types alphabetically. No hardcoded taxonomy, so
  // any custom ticket type gets its own chip automatically.
  const typeFilters = useMemo(() => {
    const byKey = new Map();
    for (const t of scopedTickets) {
      if (!byKey.has(t.kind.key))
        byKey.set(t.kind.key, {
          key: t.kind.key,
          label: t.kind.label,
          dot: t.kind.dot,
        });
    }
    const structural = STRUCTURAL_ORDER.filter((k) => byKey.has(k)).map((k) =>
      byKey.get(k),
    );
    const generic = [...byKey.values()]
      .filter((f) => !STRUCTURAL_ORDER.includes(f.key))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [{ key: "ALL", label: "All", dot: null }, ...structural, ...generic];
  }, [scopedTickets]);

  const filtered = useMemo(() => {
    if (typeFilter === "ALL") return scopedTickets;
    return scopedTickets.filter((t) => t.kind.key === typeFilter);
  }, [typeFilter, scopedTickets]);

  // If the selected type chip no longer has any tickets (e.g. after switching
  // tab/scope), fall back to "All" so the queue never looks mysteriously empty.
  useEffect(() => {
    if (typeFilter !== "ALL" && !typeFilters.some((f) => f.key === typeFilter))
      setTypeFilter("ALL");
  }, [typeFilters, typeFilter]);

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
    if (IP_IN_TEXT_RE.test(noteText.trim())) {
      setSubmitError("Raw IP addresses are not permitted in ticket messages.");
      return;
    }
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
    if (IP_IN_TEXT_RE.test(replyText.trim())) {
      setSubmitError("Raw IP addresses are not permitted in ticket messages.");
      return;
    }
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

  const handleDeleteTicket = useCallback(async () => {
    if (!selectedId) return;
    const res = await fetch(`/api/tickets/${selectedId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      setTickets((prev) => prev.filter((t) => t.ticket_id !== selectedId));
      setSelectedId(null);
    }
  }, [selectedId]);

  const hasPlayerIntelAccess =
    selectedOrgId &&
    (adminableOrgIds.includes(selectedOrgId) ||
      (sessionOrgPermissions[selectedOrgId] ?? []).includes(
        "tickets_player_intel",
      ));

  const canBlacklist =
    selectedOrgId &&
    (adminableOrgIds.includes(selectedOrgId) ||
      (sessionOrgPermissions[selectedOrgId] ?? []).includes(
        "tickets_blacklist",
      ));

  const openBlacklist = useCallback(() => {
    setBlacklistPrefill({
      steamId: selectedTicket?.created_by_steam_id ?? "",
      ticketTypeId: selectedTicket?.ticket_type_id ?? null,
    });
  }, [selectedTicket]);

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 flex min-h-0">
        {/* Left: ticket list. On mobile this is a master-detail flow: the
            queue fills the screen until a ticket is selected, then hides. */}
        <aside
          className={`shrink-0 border-r border-border flex-col bg-background md:flex md:w-[230px] ${
            selectedTicket ? "hidden" : "flex w-full"
          }`}
        >
          <div className="px-3 py-2 border-b border-border shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[0.625rem] font-mono uppercase tracking-widest font-bold text-foreground">
                Ticket Queue
              </span>
              <span className="text-[0.625rem] font-mono text-muted-foreground">
                {totalNonClosed}
              </span>
            </div>
            <div className="flex ring-1 ring-border rounded overflow-hidden">
              {["active", "waiting", "closed"].map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 py-1 text-[0.625rem] font-mono capitalize transition-colors ${
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
            <div className="flex ring-1 ring-border rounded overflow-hidden mt-1.5">
              <button
                onClick={() => setAssignee("all")}
                className={`flex-1 py-1 text-[0.625rem] font-mono transition-colors ${
                  assignee === "all"
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                All tickets
              </button>
              <button
                onClick={() => setAssignee("mine")}
                className={`flex-1 py-1 text-[0.625rem] font-mono transition-colors ${
                  assignee === "mine"
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                My tickets{myTicketCount > 0 ? ` (${myTicketCount})` : ""}
              </button>
            </div>
          </div>
          <div className="px-2 py-2 border-b border-border shrink-0">
            <div className="relative">
              <Search className="size-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search player name or Steam ID..."
                className="w-full bg-background border border-border rounded pl-6 pr-2 py-1 text-[0.625rem] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
              />
            </div>
          </div>
          <div className="px-2 py-1.5 border-b border-border flex gap-1 flex-wrap shrink-0">
            {typeFilters.map((f) => {
              const isAll = f.key === "ALL";
              const count = isAll
                ? scopedTickets.length
                : (typeCounts[f.key] ?? 0);
              const active = typeFilter === f.key;
              // Hide empty type chips to keep the row scannable, but never
              // hide "All" or the chip that is currently selected.
              if (count === 0 && !active && !isAll) return null;
              return (
                <button
                  key={f.key}
                  onClick={() => setTypeFilter(f.key)}
                  className={`flex items-center gap-1 text-[0.625rem] font-mono px-1.5 py-0.5 rounded transition-colors ${
                    active
                      ? "bg-brand text-brand-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-surface/60"
                  }`}
                >
                  {f.dot && (
                    <span className={`size-1.5 rounded-full ${f.dot}`} />
                  )}
                  {f.label}
                  <span
                    className={
                      active
                        ? "text-brand-foreground/70"
                        : "text-muted-foreground/70"
                    }
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="text-[0.625rem] text-muted-foreground text-center py-10">
                Loading...
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-[0.625rem] text-muted-foreground text-center py-10">
                {assignee === "mine"
                  ? "No tickets assigned to you"
                  : "No tickets"}
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
            <button
              onClick={() => setSelectedId(null)}
              className="md:hidden flex items-center gap-1.5 px-3 py-2 border-b border-border text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground shrink-0"
            >
              ← Back to queue
            </button>
            <TicketDetail
              ticket={selectedTicket}
              messages={selectedMessages}
              media={selectedMedia}
              formData={selectedFormData}
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
              onDelete={handleDeleteTicket}
              submitting={submitting}
              submitError={submitError}
              detailLoading={detailLoading}
              sessionUser={sessionUser}
              orgStaff={orgStaff}
              predefines={orgPredefines}
              canBlacklist={canBlacklist}
              onOpenBlacklist={openBlacklist}
            />
          </main>
        ) : (
          <main className="flex-1 hidden md:grid place-items-center border-r border-border">
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
              submitterDiscordId={selectedTicket.created_by_discord_id}
              submitterLabel={submitterRoleLabel(selectedTicket)}
              submitterSteamAccounts={submitterSteamAccounts}
              ticketCreatedAt={selectedTicket.created_at}
            />
          ) : (
            <TeamInfoPanel servers={orgServers} />
          ))}
      </div>
      {blacklistPrefill && selectedOrgId && (
        <BlacklistManager
          orgId={selectedOrgId}
          prefill={blacklistPrefill}
          onClose={() => setBlacklistPrefill(null)}
        />
      )}
    </div>
  );
}

function getOrgPrefix(orgId, orgs) {
  const org = orgs.find((o) => o.id === orgId);
  return org ? org.short : (orgId ?? "??").slice(0, 2).toUpperCase();
}

function TicketListItem({ ticket, orgs, selected, onClick }) {
  const kind = ticket.kind ?? ticketKind(ticket);
  const prefix = getOrgPrefix(ticket.org_id, orgs);
  const isAuto = ticket.category === "threat_auto";
  const isCase = ticket.category === "staff_case";
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 border-b border-border transition-colors flex items-start gap-1.5 min-w-0 ${
        selected ? "bg-brand/10" : "hover:bg-surface/60"
      }`}
    >
      <span className="text-[0.625rem] font-mono font-bold text-muted-foreground shrink-0 mt-0.5 w-4 text-center">
        {prefix}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 min-w-0">
          <span
            className={`text-[0.625rem] font-mono font-bold shrink-0 truncate max-w-[7rem] ${kind.color}`}
            title={kind.label}
          >
            {kind.label}
          </span>
          {isAuto && (
            <span className="text-[0.5625rem] font-mono uppercase tracking-widest text-orange-400/70 bg-orange-400/10 px-1 rounded shrink-0">
              auto
            </span>
          )}
          {isCase && (
            <span className="text-[0.5625rem] font-mono uppercase tracking-widest text-sky-400/70 bg-sky-400/10 px-1 rounded shrink-0">
              staff
            </span>
          )}
          <span className="text-[0.625rem] text-muted-foreground shrink-0">
            ·
          </span>
          <span className="text-[0.625rem] font-medium truncate min-w-0">
            {isAuto || isCase
              ? (ticket.title ?? "—")
              : (ticket.created_by_username ?? "Unknown")}
          </span>
        </div>
        <div className="flex items-center gap-1 mt-0.5 min-w-0">
          {ticket.last_staff_reply_at ? (
            <span className="flex items-center gap-1 min-w-0 overflow-hidden">
              <UserCheck size={8} className="shrink-0 text-muted-foreground" />
              <span className="text-[0.5625rem] font-mono text-muted-foreground truncate">
                {ticket.last_staff_reply_username ?? "Staff"}
              </span>
              <span className="text-[0.5625rem] font-mono text-muted-foreground shrink-0">
                · {formatRelativeTime(ticket.last_staff_reply_at)}
              </span>
            </span>
          ) : (
            <span className="text-[0.5625rem] font-mono text-muted-foreground/50 italic">
              No replies yet
            </span>
          )}
          <span className="text-[0.625rem] font-mono text-muted-foreground ml-auto shrink-0">
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
        className={`flex items-center gap-1 text-[0.625rem] font-mono rounded px-2 py-0.5 ring-1 transition-colors ${
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
              className="w-full bg-background border border-border rounded px-2 py-1 text-[0.625rem] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {relevant.length === 0 ? (
              <div className="px-3 py-3 text-[0.625rem] font-mono text-muted-foreground">
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
                  <p className="text-[0.625rem] font-mono font-bold text-foreground">
                    {p.keyword}
                  </p>
                  <p className="text-[0.625rem] text-muted-foreground line-clamp-2 mt-0.5 leading-snug">
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
        className="flex items-center gap-1 text-[0.625rem] font-mono bg-surface/60 ring-1 ring-border rounded px-2 py-0.5 hover:bg-surface transition-colors"
      >
        {ticket.assigned_to_username ?? "Assign"}
        <ChevronDown size={9} className="text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-20 min-w-[160px] bg-surface border border-border rounded-md shadow-lg overflow-hidden">
          {orgStaff.length === 0 ? (
            <div className="px-3 py-2 text-[0.625rem] font-mono text-muted-foreground">
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
                  className="w-full text-left px-3 py-1.5 text-[0.625rem] font-mono text-muted-foreground hover:bg-surface-bright transition-colors"
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
                  className={`w-full text-left px-3 py-1.5 text-[0.625rem] font-mono hover:bg-surface-bright transition-colors ${
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

// Splits plain text on http(s) URLs and renders them as external links.
// React escapes the text nodes, and only https?:// hrefs are ever emitted.
function LinkifiedText({ text }) {
  const parts = String(text).split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand hover:underline break-all"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

// The structured submission a typed ticket was created with — each field the
// submitter filled in renders as its own labeled section.
function SubmissionDetails({ formData }) {
  return (
    <div className="px-4 pt-3 pb-2">
      <div className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-2">
        Submission
      </div>
      <div className="bg-surface/60 ring-1 ring-border rounded-md px-3 py-2.5 space-y-2.5">
        {formData.map((f, i) => (
          <div key={i}>
            <div className="text-[0.625rem] font-mono font-semibold uppercase tracking-wider text-muted-foreground">
              {f.label}
            </div>
            <div className="text-xs mt-0.5 whitespace-pre-wrap break-words leading-relaxed">
              <LinkifiedText text={f.value} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Blacklist manager modal — lists the org's ticket blacklist and lets a
// permitted staffer bar a Steam account from opening a specific ticket type (or
// all of them). Opened prefilled with the current ticket's submitter + type.
function BlacklistManager({ orgId, prefill, onClose }) {
  const [entries, setEntries] = useState([]);
  const [ticketTypes, setTicketTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [steamId, setSteamId] = useState(prefill?.steamId ?? "");
  const [typeId, setTypeId] = useState(
    prefill?.ticketTypeId != null ? String(prefill.ticketTypeId) : "ALL",
  );
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const loadEntries = useCallback(() => {
    setLoading(true);
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/ticket-blacklist`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((data) => setEntries(data.entries ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [orgId]);

  useEffect(() => {
    loadEntries();
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/ticket-types`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : { ticketTypes: [] }))
      .then((data) => setTicketTypes(data.ticketTypes ?? []))
      .catch(() => setTicketTypes([]));
  }, [orgId, loadEntries]);

  const handleAdd = async () => {
    const sid = steamId.trim();
    if (!/^\d{17}$/.test(sid)) {
      setError("Enter a valid SteamID64 (17 digits).");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ticket-blacklist`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            steamId: sid,
            ticketTypeId: typeId === "ALL" ? null : Number(typeId),
            reason: reason.trim(),
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Failed to add entry.");
        return;
      }
      setReason("");
      loadEntries();
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ticket-blacklist/${id}`,
      { method: "DELETE", credentials: "include" },
    );
    if (res.ok) setEntries((prev) => prev.filter((e) => e.blacklistId !== id));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[85vh] flex flex-col bg-background border border-border rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Ban className="size-3.5 text-danger" />
            <span className="text-xs font-bold">Ticket Blacklist</span>
          </div>
          <button
            onClick={onClose}
            className="text-[0.625rem] font-mono text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="px-4 py-3 border-b border-border shrink-0 space-y-2">
          <div className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
            Add entry
          </div>
          <input
            value={steamId}
            onChange={(e) => setSteamId(e.target.value)}
            placeholder="SteamID64 (17 digits)"
            className="w-full bg-background border border-border rounded px-2 py-1 text-[0.6875rem] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="w-full bg-background border border-border rounded px-2 py-1 text-[0.6875rem] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
          >
            <option value="ALL">All ticket types</option>
            {ticketTypes.map((t) => (
              <option key={t.ticketTypeId} value={t.ticketTypeId}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={500}
            className="w-full bg-background border border-border rounded px-2 py-1 text-[0.6875rem] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
          {error && (
            <p className="text-[0.625rem] font-mono text-danger">{error}</p>
          )}
          <button
            onClick={handleAdd}
            disabled={saving}
            className="text-[0.625rem] font-mono bg-danger text-white rounded px-3 py-1 hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "Adding..." : "Add to blacklist"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-[0.625rem] text-muted-foreground text-center py-8">
              Loading...
            </div>
          ) : entries.length === 0 ? (
            <div className="text-[0.625rem] text-muted-foreground text-center py-8">
              No blacklisted users
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {entries.map((e) => (
                <li
                  key={e.blacklistId}
                  className="px-4 py-2 flex items-start gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[0.6875rem] font-mono truncate">
                        {e.steamId}
                      </span>
                      <span className="text-[0.5625rem] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface/60 ring-1 ring-border text-muted-foreground shrink-0">
                        {e.ticketTypeName ?? "All types"}
                      </span>
                    </div>
                    {e.reason && (
                      <p className="text-[0.625rem] text-muted-foreground mt-0.5 break-words">
                        {e.reason}
                      </p>
                    )}
                    <p className="text-[0.625rem] font-mono text-muted-foreground/60 mt-0.5">
                      {e.createdBy ? `by ${e.createdBy} · ` : ""}
                      {formatRelativeTime(e.createdAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRemove(e.blacklistId)}
                    className="text-[0.625rem] font-mono text-muted-foreground hover:text-danger shrink-0"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function MediaLightbox({ media, initialIndex, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStart = useRef(null);
  const containerRef = useRef(null);

  const item = media[index];
  const prev = () => {
    setIndex((i) => (i - 1 + media.length) % media.length);
    resetView();
  };
  const next = () => {
    setIndex((i) => (i + 1) % media.length);
    resetView();
  };
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Attach wheel zoom as a native non-passive listener so e.preventDefault()
  // actually suppresses the parent overflow-y:auto container's scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      setZoom((z) => Math.min(8, Math.max(1, z - e.deltaY * 0.002)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const onMouseDown = (e) => {
    if (zoom <= 1) return;
    setPanning(true);
    panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };
  const onMouseMove = (e) => {
    if (!panning || !panStart.current) return;
    setPan({
      x: e.clientX - panStart.current.x,
      y: e.clientY - panStart.current.y,
    });
  };
  const onMouseUp = () => setPanning(false);

  const formatBytes = (b) => {
    if (!b) return null;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 shrink-0">
        <span className="text-xs font-mono text-white/60">
          {index + 1} / {media.length}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setZoom((z) => Math.min(8, z + 0.5))}
            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          >
            <ZoomIn size={16} />
          </button>
          <span className="text-xs font-mono text-white/40 w-10 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          >
            <ZoomOut size={16} />
          </button>
          <button
            onClick={resetView}
            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          >
            <Minimize2 size={16} />
          </button>
          <div className="w-px h-4 bg-white/20 mx-1" />
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Viewer */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden flex items-center justify-center"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{
          cursor: zoom > 1 ? (panning ? "grabbing" : "grab") : "default",
        }}
      >
        {media.length > 1 && (
          <button
            onClick={prev}
            className="absolute left-3 z-10 p-2 rounded-full bg-black/50 hover:bg-black/80 text-white/60 hover:text-white transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
        )}

        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center",
            transition: panning ? "none" : "transform 0.1s ease",
            userSelect: "none",
          }}
          className="max-w-full max-h-full"
        >
          {item?.fileType === "image" && item.url ? (
            <img
              src={item.url}
              alt={item.title || item.filename}
              draggable={false}
              className="max-w-[80vw] max-h-[70vh] object-contain"
            />
          ) : item?.fileType === "video" && item.url ? (
            <video
              src={item.url}
              controls
              className="max-w-[80vw] max-h-[70vh]"
              style={{ pointerEvents: zoom > 1 ? "none" : "auto" }}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 text-white/40">
              <FileIcon size={48} />
              <span className="text-sm font-mono">
                {item?.filename ?? "Unknown file"}
              </span>
            </div>
          )}
        </div>

        {media.length > 1 && (
          <button
            onClick={next}
            className="absolute right-3 z-10 p-2 rounded-full bg-black/50 hover:bg-black/80 text-white/60 hover:text-white transition-colors"
          >
            <ChevronRight size={20} />
          </button>
        )}
      </div>

      {/* Info panel */}
      <div className="shrink-0 border-t border-white/10 px-4 py-2 flex items-start gap-4 bg-black/60">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white font-medium truncate">
            {item?.title || item?.filename || "Untitled"}
          </p>
          {item?.title && item?.filename && (
            <p className="text-xs font-mono text-white/40 truncate mt-0.5">
              {item.filename}
            </p>
          )}
        </div>
        <div className="flex items-center gap-4 shrink-0 text-xs font-mono text-white/40">
          {item?.mimeType && <span>{item.mimeType}</span>}
          {item?.fileSize && <span>{formatBytes(item.fileSize)}</span>}
          {item?.uploadedAt && (
            <span>{new Date(item.uploadedAt * 1000).toLocaleString()}</span>
          )}
          {item?.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-white/40 hover:text-white transition-colors"
            >
              <ExternalLink size={12} />
              Open
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function TicketDetail({
  ticket,
  messages,
  media = [],
  formData = [],
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
  onDelete,
  submitting,
  submitError,
  detailLoading,
  sessionUser,
  orgStaff,
  predefines = [],
  canBlacklist = false,
  onOpenBlacklist,
}) {
  const isClaimed = ticket.assigned_to === sessionUser?.userId;
  const isClosed = ticket.status === "closed";
  const isAuto = ticket.category === "threat_auto";
  const isCase = ticket.category === "staff_case";
  const isInternalOnly = isAuto || isCase;
  const internalMessages = messages.filter((m) => m.isInternal);
  const publicMessages = messages.filter((m) => !m.isInternal);
  const isSysAdmin = sessionUser?.isSysAdmin || sessionUser?.globalAdmin;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null);

  const noteHasIp = IP_IN_TEXT_RE.test(noteText);
  const replyHasIp = IP_IN_TEXT_RE.test(replyText);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[0.625rem] font-mono text-brand shrink-0">
            #{ticket.ticket_id}
          </span>
          <h2 className="text-sm font-bold truncate">{ticket.title}</h2>
          {isAuto && (
            <span className="text-[0.5625rem] font-mono uppercase tracking-widest text-orange-400 bg-orange-400/10 ring-1 ring-orange-400/30 px-1.5 py-0.5 rounded shrink-0">
              Auto-opened
            </span>
          )}
          {isCase && (
            <span className="text-[0.5625rem] font-mono uppercase tracking-widest text-sky-400 bg-sky-400/10 ring-1 ring-sky-400/30 px-1.5 py-0.5 rounded shrink-0">
              Staff Case
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[0.625rem] font-mono bg-surface/60 ring-1 ring-border rounded px-2 py-0.5">
            {ticket.ticket_type_name ?? "Unknown type"}
          </span>
          <AssignDropdown
            ticket={ticket}
            orgStaff={orgStaff}
            onAssign={onAssign}
          />
          <button
            onClick={onClaim}
            className={`text-[0.625rem] font-mono rounded px-2 py-0.5 hover:opacity-90 transition-colors ${
              isClaimed
                ? "bg-surface/60 ring-1 ring-border text-muted-foreground"
                : "bg-brand text-brand-foreground"
            }`}
          >
            {isClaimed ? "CLAIMED" : "CLAIM"}
          </button>
        </div>
      </div>

      <div className="px-4 py-1.5 border-b border-border flex items-center gap-1 shrink-0">
        {!isClosed ? (
          <>
            <button
              onClick={() => onUpdateStatus("waiting_response")}
              className="text-[0.625rem] font-mono px-2 py-0.5 rounded bg-surface/60 ring-1 ring-border text-muted-foreground hover:text-foreground transition-colors"
            >
              Wait for response
            </button>
            <button
              onClick={() => onUpdateStatus("closed")}
              className="text-[0.625rem] font-mono px-2 py-0.5 rounded bg-surface/60 ring-1 ring-border text-muted-foreground hover:text-foreground transition-colors"
            >
              Close
            </button>
          </>
        ) : (
          <button
            onClick={() => onUpdateStatus("open")}
            className="text-[0.625rem] font-mono px-2 py-0.5 rounded bg-brand/20 text-brand hover:bg-brand/30 transition-colors"
          >
            Reopen
          </button>
        )}
        {ticket.status === "waiting_response" && (
          <button
            onClick={() => onUpdateStatus("open")}
            className="text-[0.625rem] font-mono px-2 py-0.5 rounded bg-brand/20 text-brand hover:bg-brand/30 transition-colors"
          >
            Mark Active
          </button>
        )}
        {canBlacklist && (
          <button
            onClick={onOpenBlacklist}
            title="Blacklist this submitter from ticket types"
            className="flex items-center gap-1 text-[0.625rem] font-mono px-2 py-0.5 rounded bg-surface/60 ring-1 ring-border text-muted-foreground hover:text-danger transition-colors"
          >
            <Ban size={10} className="shrink-0" />
            Blacklist
          </button>
        )}
        {isSysAdmin && (
          <div className="ml-auto flex items-center gap-1">
            {confirmDelete ? (
              <>
                <span className="text-[0.625rem] font-mono text-danger">
                  Delete?
                </span>
                <button
                  onClick={() => {
                    onDelete();
                    setConfirmDelete(false);
                  }}
                  className="text-[0.625rem] font-mono px-2 py-0.5 rounded bg-danger text-white hover:bg-danger/80 transition-colors"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-[0.625rem] font-mono px-2 py-0.5 rounded bg-surface/60 ring-1 ring-border text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-[0.625rem] font-mono px-2 py-0.5 rounded bg-surface/60 ring-1 ring-border text-danger/80 hover:text-danger transition-colors"
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {detailLoading ? (
          <div className="text-[0.625rem] text-muted-foreground text-center py-10">
            Loading...
          </div>
        ) : (
          <>
            {formData.length > 0 && <SubmissionDetails formData={formData} />}
            {publicMessages.length > 0 && (
              <div className="px-4 pt-3 pb-2 space-y-2">
                <div className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                  Conversation
                </div>
                {publicMessages.map((msg) => (
                  <MessageBubble
                    key={msg.messageId}
                    msg={msg}
                    myUserId={sessionUser?.userId}
                  />
                ))}
              </div>
            )}
            {internalMessages.length > 0 && (
              <div className="px-4 py-2 space-y-2">
                <div className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                  Internal Notes
                </div>
                {internalMessages.map((msg) => (
                  <MessageBubble
                    key={msg.messageId}
                    msg={msg}
                    internal
                    myUserId={sessionUser?.userId}
                  />
                ))}
              </div>
            )}
            {media.length > 0 && (
              <div className="px-4 py-2 space-y-2">
                <div className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                  Evidence / Attachments
                </div>
                <div className="columns-2 sm:columns-3 md:columns-4 gap-2">
                  {media.map((item, idx) => (
                    <button
                      key={item.mediaId}
                      onClick={() => setLightboxIndex(idx)}
                      className="group relative mb-2 block break-inside-avoid rounded ring-1 ring-border hover:ring-brand transition-colors overflow-hidden w-full text-left"
                    >
                      {/* Prefer the small generated thumbnail so the evidence
                          grid doesn't fetch full clips/images from R2. */}
                      {item.thumbUrl ? (
                        <img
                          src={item.thumbUrl}
                          alt={item.title || item.filename}
                          className="w-full h-auto object-contain group-hover:opacity-75 transition-opacity"
                          loading="lazy"
                        />
                      ) : item.fileType === "image" && item.url ? (
                        <img
                          src={item.url}
                          alt={item.title || item.filename}
                          className="w-full h-auto object-contain group-hover:opacity-75 transition-opacity"
                        />
                      ) : (
                        <div className="w-full aspect-square bg-surface/40 flex items-center justify-center">
                          <FileIcon className="size-6 text-muted-foreground" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                      {(item.title || item.filename) && (
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <p className="text-[0.625rem] text-white truncate">
                            {item.title || item.filename}
                          </p>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {lightboxIndex !== null && media.length > 0 && (
              <MediaLightbox
                media={media}
                initialIndex={lightboxIndex}
                onClose={() => setLightboxIndex(null)}
              />
            )}
            {messages.length === 0 &&
              media.length === 0 &&
              formData.length === 0 && (
                <div className="text-[0.625rem] text-muted-foreground text-center py-10">
                  No messages yet
                </div>
              )}
          </>
        )}
      </div>

      <div className="border-t border-border px-4 py-3 shrink-0">
        <div className="flex items-center gap-1 mb-2">
          {!isInternalOnly && (
            <button
              onClick={() => onComposerModeChange("reply")}
              className={`text-[0.625rem] font-mono px-2 py-0.5 rounded transition-colors ${
                composerMode === "reply"
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Reply
            </button>
          )}
          <button
            onClick={() => onComposerModeChange("note")}
            className={`text-[0.625rem] font-mono px-2 py-0.5 rounded transition-colors ${
              composerMode === "note" || isInternalOnly
                ? "bg-brand text-brand-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Internal Note
          </button>
          {(composerMode === "note" || isInternalOnly) && (
            <span className="text-[0.625rem] font-mono text-muted-foreground/50 ml-1">
              {isInternalOnly
                ? "· No external recipient — internal notes only."
                : "· Staff-only. Reporters never see these."}
            </span>
          )}
          <div className="ml-auto">
            <PredefinesPicker
              predefines={predefines}
              ticketTypeId={ticket.ticket_type_id ?? null}
              onSelect={(content) => {
                if (composerMode === "reply" && !isInternalOnly) {
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
          <p className="text-[0.625rem] font-mono text-danger mb-2">
            {submitError}
          </p>
        )}
        {composerMode === "reply" && !isInternalOnly ? (
          <>
            {replyHasIp && (
              <p className="text-[0.625rem] font-mono text-warning mb-2 flex items-center gap-1">
                <AlertTriangle size={10} className="shrink-0" />
                Raw IP addresses are not permitted in ticket messages.
              </p>
            )}
            <textarea
              value={replyText}
              onChange={(e) => onReplyChange(e.target.value)}
              placeholder="Write a reply to the submitter..."
              disabled={isClosed}
              className="w-full h-20 bg-background border border-border rounded p-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[0.625rem] font-mono text-muted-foreground">
                Markdown supported
              </span>
              <button
                onClick={onPostReply}
                disabled={
                  !replyText.trim() || submitting || isClosed || replyHasIp
                }
                className="text-[0.625rem] font-mono bg-brand text-brand-foreground rounded px-3 py-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Sending..." : "Send Reply"}
              </button>
            </div>
          </>
        ) : (
          <>
            {noteHasIp && (
              <p className="text-[0.625rem] font-mono text-warning mb-2 flex items-center gap-1">
                <AlertTriangle size={10} className="shrink-0" />
                Raw IP addresses are not permitted in ticket messages.
              </p>
            )}
            <textarea
              value={noteText}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="Discuss this case with other staff — evidence checks, second opinions, decisions..."
              disabled={isClosed}
              className="w-full h-20 bg-background border border-border rounded p-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[0.625rem] font-mono text-muted-foreground">
                Markdown supported
              </span>
              <button
                onClick={onPostNote}
                disabled={
                  !noteText.trim() || submitting || isClosed || noteHasIp
                }
                className="text-[0.625rem] font-mono bg-brand text-brand-foreground rounded px-3 py-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
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

function parseApplicationMessage(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    // Accept "1. Question", "1.Question", "1)Question", etc.
    const match = line.match(/^(\d+)[.)]\s*(.*)/);
    if (match) {
      if (current) entries.push(current);
      current = {
        num: parseInt(match[1], 10),
        question: match[2].trim(),
        answer: "",
      };
    } else if (current !== null) {
      const trimmed = line.trim();
      if (trimmed) {
        current.answer = current.answer
          ? current.answer + "\n" + trimmed
          : trimmed;
      }
    }
  }
  if (current) entries.push(current);
  // Require at least 2 questions with sequential numbering starting at 1 to avoid false positives
  if (entries.length < 2) return null;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].num !== i + 1) return null;
  }
  return entries;
}

const STAFF_COLORS = [
  {
    bg: "bg-violet-500/10",
    ring: "ring-violet-500/30",
    name: "text-violet-300",
  },
  { bg: "bg-teal-500/10", ring: "ring-teal-500/30", name: "text-teal-300" },
  { bg: "bg-amber-500/10", ring: "ring-amber-500/30", name: "text-amber-300" },
  { bg: "bg-pink-500/10", ring: "ring-pink-500/30", name: "text-pink-300" },
  { bg: "bg-lime-500/10", ring: "ring-lime-500/30", name: "text-lime-300" },
  { bg: "bg-sky-500/10", ring: "ring-sky-500/30", name: "text-sky-300" },
  {
    bg: "bg-orange-500/10",
    ring: "ring-orange-500/30",
    name: "text-orange-300",
  },
  { bg: "bg-rose-500/10", ring: "ring-rose-500/30", name: "text-rose-300" },
];

function staffColorFor(userId) {
  if (!userId) return null;
  let h = 0;
  for (const c of String(userId)) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return STAFF_COLORS[h % STAFF_COLORS.length];
}

function MessageBubble({ msg, internal, myUserId }) {
  const isMe = !!(
    msg.userId &&
    myUserId &&
    String(msg.userId) === String(myUserId)
  );
  const isSubmitter = !msg.userId;
  const appEntries = !internal ? parseApplicationMessage(msg.message) : null;
  const color = !isMe && !isSubmitter ? staffColorFor(msg.userId) : null;

  let bgClass, ringClass;
  if (isMe) {
    bgClass = "bg-brand/15";
    ringClass = "ring-brand/30";
  } else if (color) {
    bgClass = color.bg;
    ringClass = color.ring;
  } else {
    bgClass = internal ? "bg-brand/10" : "bg-surface/60";
    ringClass = internal ? "ring-brand/20" : "ring-border";
  }

  const nameColor = isMe
    ? "text-brand"
    : color
      ? color.name
      : "text-foreground";

  return (
    <div className={isMe ? "flex justify-end" : ""}>
      <div
        className={`rounded-md px-3 py-2 ring-1 text-xs ${isMe ? "max-w-[75%]" : "w-full"} ${bgClass} ${ringClass}`}
      >
        <div
          className={`flex items-center gap-2 mb-0.5 ${isMe ? "flex-row-reverse" : ""}`}
        >
          {msg.discordAvatarUrl ? (
            <img
              src={msg.discordAvatarUrl}
              alt={msg.username ?? "Unknown"}
              className="size-4 rounded-full ring-1 ring-black/40 shrink-0"
            />
          ) : (
            <div className="size-4 rounded-full ring-1 ring-black/40 grid place-items-center font-mono font-bold text-[0.5625rem] text-background bg-brand/70 shrink-0">
              {initials(msg.username ?? "?")}
            </div>
          )}
          <span className={`font-semibold text-[0.625rem] ${nameColor}`}>
            {msg.username ?? "Unknown"}
          </span>
          <span className="font-mono text-[0.625rem] text-muted-foreground">
            {formatRelativeTime(msg.createdAt)}
          </span>
          {internal && (
            <span
              className={`text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground ${isMe ? "" : "ml-auto"}`}
            >
              Internal Note
            </span>
          )}
        </div>
        {appEntries ? (
          <div className="space-y-2 mt-1.5">
            {appEntries.map((entry, i) => (
              <div key={i}>
                <div className="text-[0.625rem] font-semibold text-foreground">
                  {i + 1}. {entry.question}
                </div>
                <div className="text-[0.625rem] text-muted-foreground mt-0.5 pl-3">
                  {entry.answer ? (
                    <Markdown>{entry.answer}</Markdown>
                  ) : (
                    "(no answer)"
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Markdown>{msg.message}</Markdown>
        )}
      </div>
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

// A single labeled identifier row (Steam / Discord) with copy-to-clipboard.
function SubmitterIdRow({ label, value, href = null }) {
  return (
    <div className="flex items-center gap-1.5 text-[0.625rem] font-mono min-w-0">
      <span className="uppercase tracking-wider text-[0.625rem] text-muted-foreground w-12 shrink-0">
        {label}
      </span>
      {value ? (
        <>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground truncate hover:text-brand transition-colors"
            >
              {value}
            </a>
          ) : (
            <span className="text-foreground truncate">{value}</span>
          )}
          <CopyButton text={value} />
        </>
      ) : (
        <span className="text-muted-foreground/60 italic">Not linked</span>
      )}
    </div>
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
        href={`https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${steamId}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Open in BattleMetrics RCON"
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
  const lastSession =
    (player.bmSessions ?? [])
      .filter((s) => s.lastSeen)
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0] ?? null;

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
          <p className="text-[0.625rem] font-mono text-muted-foreground uppercase truncate flex items-center gap-0.5">
            <span className="truncate">{player.steamId}</span>
            <CopyButton text={player.steamId} />
            <ExternalLinks steamId={player.steamId} />
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-y-3">
        <div>
          <p className="text-[0.625rem] text-muted-foreground uppercase">
            S-Hours
          </p>
          <p className="text-sm font-mono text-foreground">
            {formatHours(player.steam?.rustHours)}
          </p>
        </div>
        <div>
          <p className="text-[0.625rem] text-muted-foreground uppercase">
            BM-Hours
          </p>
          <p className="text-sm font-mono text-foreground">
            {formatHours(player.bm?.rustHours)}
          </p>
        </div>
        <div>
          <p className="text-[0.625rem] text-muted-foreground uppercase">
            AIM-TRAIN Hours
          </p>
          <p className="text-sm font-mono text-foreground">
            {formatHours(player.bm?.aimtrainHours)}
          </p>
        </div>
        <div>
          <p className="text-[0.625rem] text-muted-foreground uppercase">K.D</p>
          <p className="text-sm font-mono text-foreground">{kd}</p>
        </div>
        <div>
          <p className="text-[0.625rem] text-muted-foreground uppercase">
            Proxy
          </p>
          <p
            className={`text-sm font-mono ${isProxy === null ? "text-muted-foreground" : isProxy ? "text-danger" : "text-success"}`}
          >
            {isProxy === null ? "—" : isProxy ? "True" : "False"}
          </p>
        </div>
        <div>
          <p className="text-[0.625rem] text-muted-foreground uppercase">
            Location
          </p>
          <p className="text-sm font-mono text-foreground">{country ?? "—"}</p>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-border">
        <p className="text-[0.625rem] text-muted-foreground uppercase">
          Last Server
        </p>
        {lastSession ? (
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium truncate min-w-0">
              {lastSession.serverName ?? lastSession.bmServerId}
            </p>
            <span className="text-[0.625rem] font-mono text-muted-foreground ml-auto shrink-0">
              {formatRelativeTime(lastSession.lastSeen)}
            </span>
          </div>
        ) : (
          <p className="text-sm font-mono text-muted-foreground">—</p>
        )}
      </div>
    </div>
  );
}

function OrgBansSection({ orgBans }) {
  const now = Math.floor(Date.now() / 1000);
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
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
          <table className="w-full text-[0.625rem] font-mono">
            <thead>
              <tr className="text-[0.625rem] uppercase tracking-wider text-muted-foreground bg-surface/60">
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
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>
          Bans on Other Orgs
          <span className="ml-2 normal-case tracking-normal text-[0.625rem] text-muted-foreground/70">
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
                  <p className="text-[0.625rem] font-medium truncate">
                    {b.bmOrgName ?? "Unknown org"}
                  </p>
                  <p className="text-[0.625rem] font-mono text-muted-foreground truncate">
                    {b.reason ?? "No reason"}
                  </p>
                </div>
                <span
                  className={`text-[0.625rem] font-mono font-bold uppercase shrink-0 ${expired ? "text-muted-foreground" : "text-danger"}`}
                >
                  {b.permanent ? "Perm" : expired ? "Exp" : "Active"}
                </span>
              </div>
            );
          })}
          {bmBans.length > 5 && (
            <p className="text-[0.625rem] font-mono text-muted-foreground text-center">
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
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Wifi className="size-3" aria-hidden />
          IP-Linked Accounts
        </span>
        <Link
          to="/player-lookup"
          search={{ steam: steamId }}
          className="text-[0.625rem] font-mono uppercase tracking-wider text-brand hover:underline inline-flex items-center gap-1"
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
              <p className="text-[0.625rem] font-mono uppercase tracking-wider text-muted-foreground">
                Linked
              </p>
            </div>
            <div>
              <p
                className={`text-lg font-mono font-bold ${withBmBans > 0 ? "text-danger" : "text-foreground"}`}
              >
                {withBmBans}
              </p>
              <p className="text-[0.625rem] font-mono uppercase tracking-wider text-muted-foreground">
                BM Bans
              </p>
            </div>
            <div>
              <p
                className={`text-lg font-mono font-bold ${withEacBans > 0 ? "text-warning" : "text-foreground"}`}
              >
                {withEacBans}
              </p>
              <p className="text-[0.625rem] font-mono uppercase tracking-wider text-muted-foreground">
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
              <p className="text-[0.625rem] text-danger leading-snug">
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
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center justify-between">
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
              <span className="text-[0.625rem] font-medium truncate min-w-0 flex-1">
                {s.serverName ?? s.bmServerId}
              </span>
              <span className="text-[0.625rem] font-mono text-muted-foreground shrink-0">
                {fmtDuration(s.hoursPlayed)}
              </span>
              <span className="text-[0.625rem] font-mono text-muted-foreground shrink-0">
                {s.lastSeen ? formatRelativeTime(s.lastSeen) : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function F7ReportsSection({ reports }) {
  const list = reports ?? [];
  if (list.length === 0) return null;

  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <AlertTriangle className="size-3" aria-hidden />
          F7 Reports
        </span>
        <span className="font-mono normal-case tracking-normal">
          {list.length}
        </span>
      </h2>
      <div className="space-y-1.5">
        {list.map((r) => (
          <div
            key={r.id}
            className="ring-1 ring-border rounded px-2 py-1.5 bg-surface/30 space-y-0.5"
          >
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="text-[0.625rem] font-mono font-semibold text-foreground truncate">
                {r.reportReason || r.reportType}
              </span>
              <span className="text-[0.5625rem] font-mono text-muted-foreground shrink-0">
                {formatRelativeTime(r.createdAt)}
              </span>
            </div>
            {r.reportDescription && (
              <p className="text-[0.5625rem] font-mono text-muted-foreground leading-snug line-clamp-2">
                {r.reportDescription}
              </p>
            )}
            <p className="text-[0.5625rem] font-mono text-muted-foreground truncate">
              by {r.reporterName} · {r.serverName}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TeamHistorySection({ orgId, steamId }) {
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!orgId || !steamId) return;
    let cancelled = false;
    setLoading(true);
    setEvents(null);
    fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/player-teams?steamId=${encodeURIComponent(steamId)}&limit=20`,
      { credentials: "include" },
    )
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((data) => {
        if (!cancelled) {
          setEvents(data.events ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvents([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, steamId]);

  if (loading) {
    return (
      <section>
        <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
          <Users className="size-3" aria-hidden />
          Team History
        </h2>
        <p className="text-[0.625rem] font-mono text-muted-foreground">
          Loading...
        </p>
      </section>
    );
  }

  if (!events || events.length === 0) {
    return (
      <section>
        <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
          <Users className="size-3" aria-hidden />
          Team History
        </h2>
        <p className="text-[0.625rem] font-mono text-muted-foreground">
          No team history found.
        </p>
      </section>
    );
  }

  // events are ordered DESC (most recent first)
  const latest = events[0];
  const older = events.slice(1);

  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <Users className="size-3" aria-hidden />
        Team History
      </h2>
      <div className="space-y-3">
        <TeamEventCard event={latest} isCurrent />
        {older.length > 0 && (
          <div className="space-y-2">
            <p className="text-[0.5625rem] font-mono text-muted-foreground uppercase tracking-widest">
              Earlier
            </p>
            {older.map((ev) => (
              <TeamEventCard key={ev.id} event={ev} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TeamEventCard({ event, isCurrent = false }) {
  const eventLabels = {
    created: "Created",
    joined: "Joined",
    left: "Left",
    invited: "Invited",
  };
  const eventColors = {
    created: "text-brand",
    joined: "text-green-400",
    left: "text-muted-foreground",
    invited: "text-amber-400",
  };
  return (
    <div
      className={`ring-1 rounded px-2 py-2 space-y-1.5 ${isCurrent ? "ring-brand/40 bg-brand/5" : "ring-border bg-surface/30"}`}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span
          className={`text-[0.5625rem] font-mono font-semibold uppercase ${eventColors[event.eventType] ?? "text-muted-foreground"}`}
        >
          {eventLabels[event.eventType] ?? event.eventType}
        </span>
        <span className="text-[0.5625rem] font-mono text-muted-foreground shrink-0">
          {formatRelativeTime(event.createdAt)}
        </span>
      </div>
      <p className="text-[0.5625rem] font-mono text-muted-foreground truncate">
        {event.serverName}
      </p>
      {event.teamMembers.length > 0 && (
        <div className="space-y-1 pt-0.5">
          {event.teamMembers.map((sid) => (
            <div key={sid} className="flex items-center gap-1 min-w-0">
              {sid === event.teamLeader && (
                <span className="text-[0.5rem] font-mono font-bold text-amber-400 shrink-0 uppercase">
                  Lead
                </span>
              )}
              <span className="text-[0.5625rem] font-mono text-foreground truncate">
                {sid}
              </span>
              <ExternalLinks steamId={sid} size={9} />
              <CopyButton text={sid} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatSeconds(sec) {
  if (!sec || sec <= 0) return "0m";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Pairwise relationship intel between the reported players — Steam
// friendship, time spent on the org's servers together, and kills between
// the pair. Shown automatically for teaming-style multi-player reports.
function RelationshipPairCard({ pair, playersById, onSelectPlayer }) {
  const [a, b] = pair.steamIds;
  const nameOf = (sid) => playersById.get(sid)?.displayName ?? sid.slice(-6);
  const sessions = pair.sharedSessions;
  const kills = pair.kills;
  const totalKills = kills.aToB + kills.bToA;
  const playedTogether = sessions.count > 0;

  return (
    <div className="bg-surface/40 ring-1 ring-border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-1.5 min-w-0 text-xs font-medium">
        <button
          onClick={() => onSelectPlayer?.(a)}
          className="truncate hover:text-brand transition-colors text-left"
        >
          {nameOf(a)}
        </button>
        <span className="text-muted-foreground shrink-0">↔</span>
        <button
          onClick={() => onSelectPlayer?.(b)}
          className="truncate hover:text-brand transition-colors text-left"
        >
          {nameOf(b)}
        </button>
      </div>

      <div className="flex items-center gap-1.5 text-[0.625rem] font-mono">
        <span className="uppercase tracking-wider text-[0.625rem] text-muted-foreground w-14 shrink-0">
          Friends
        </span>
        {pair.friends === true ? (
          <span className="text-danger font-bold">
            Steam friends
            {pair.friendsSince
              ? ` · seen ${formatRelativeTime(pair.friendsSince)}`
              : ""}
          </span>
        ) : pair.friends === false ? (
          <span className="text-muted-foreground">Not friends</span>
        ) : (
          <span className="text-muted-foreground italic">
            Unknown (private or unfetched friends list)
          </span>
        )}
      </div>

      <div className="flex items-start gap-1.5 text-[0.625rem] font-mono">
        <span className="uppercase tracking-wider text-[0.625rem] text-muted-foreground w-14 shrink-0 mt-px">
          Together
        </span>
        {playedTogether ? (
          <div className="min-w-0">
            <span className="text-warning font-bold">
              {sessions.count} shared session
              {sessions.count !== 1 ? "s" : ""}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {formatSeconds(sessions.totalSeconds)}
              {sessions.lastTogether
                ? ` · last ${formatRelativeTime(sessions.lastTogether)}`
                : ""}
            </span>
            {sessions.servers.length > 0 && (
              <p className="text-[0.625rem] text-muted-foreground truncate">
                {sessions.servers
                  .slice(0, 3)
                  .map((s) => s.serverName)
                  .join(", ")}
                {sessions.servers.length > 3
                  ? ` +${sessions.servers.length - 3}`
                  : ""}
              </p>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">
            No shared sessions recorded
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[0.625rem] font-mono">
        <span className="uppercase tracking-wider text-[0.625rem] text-muted-foreground w-14 shrink-0">
          Kills
        </span>
        {totalKills > 0 ? (
          <span className="text-foreground">
            {kills.aToB > 0 && (
              <>
                {nameOf(a)} → {nameOf(b)}:{" "}
                <span className="font-bold">{kills.aToB}</span>
              </>
            )}
            {kills.aToB > 0 && kills.bToA > 0 && " · "}
            {kills.bToA > 0 && (
              <>
                {nameOf(b)} → {nameOf(a)}:{" "}
                <span className="font-bold">{kills.bToA}</span>
              </>
            )}
            {kills.lastKillAt
              ? ` · last ${formatRelativeTime(kills.lastKillAt)}`
              : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">Never killed each other</span>
        )}
      </div>
    </div>
  );
}

function RelationshipSection({ data, onSelectPlayer }) {
  const playersById = useMemo(
    () => new Map((data?.players ?? []).map((p) => [p.steamId, p])),
    [data],
  );
  const pairs = data?.pairs ?? [];
  if (pairs.length === 0) return null;
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <Users className="size-3" aria-hidden />
        Player Relationships
      </h2>
      <div className="space-y-2">
        {pairs.map((pair) => (
          <RelationshipPairCard
            key={pair.steamIds.join("|")}
            pair={pair}
            playersById={playersById}
            onSelectPlayer={onSelectPlayer}
          />
        ))}
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
  submitterDiscordId,
  submitterLabel = "Submitter",
  submitterSteamAccounts,
  ticketCreatedAt,
}) {
  const [intelData, setIntelData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [relationshipData, setRelationshipData] = useState(null);

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
  const hasMultiplePlayers = players.length >= 2;

  const handleSelectPlayer = useCallback(
    (steamId) => {
      const idx = players.findIndex((p) => p.steamId === steamId);
      if (idx >= 0) setSelectedIdx(idx);
    },
    [players],
  );

  // Pairwise relationship intel (friends / shared sessions / kills) only
  // exists for multi-player reports such as teaming.
  useEffect(() => {
    setRelationshipData(null);
    if (!ticketId || !hasMultiplePlayers) return;
    let cancelled = false;
    fetch(`/api/tickets/${ticketId}/relationships`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setRelationshipData(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ticketId, hasMultiplePlayers]);

  return (
    <aside className="w-[28rem] shrink-0 border-l border-border bg-background overflow-y-auto hidden xl:block">
      <div className="p-6 space-y-8">
        {loading && (
          <div className="text-[0.625rem] font-mono text-muted-foreground text-center py-10">
            Loading player intel...
          </div>
        )}

        {!loading && hasPlayers && players.length > 1 && (
          <div className="flex gap-1 flex-wrap">
            {players.map((p, i) => (
              <button
                key={p.steamId}
                onClick={() => setSelectedIdx(i)}
                className={`text-[0.625rem] font-mono px-2 py-0.5 rounded transition-colors ring-1 ${
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

        {!loading && relationshipData && (
          <RelationshipSection
            data={relationshipData}
            onSelectPlayer={handleSelectPlayer}
          />
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

            <F7ReportsSection reports={player.f7Reports} />
          </>
        )}

        {!loading && player?.fetching && (
          <div className="bg-surface/40 ring-1 ring-border rounded-lg p-4 text-center space-y-2">
            <p className="text-[0.625rem] font-mono text-muted-foreground">
              Player data is being fetched from Steam & BattleMetrics.
            </p>
            <p className="text-[0.625rem] font-mono text-muted-foreground">
              Refresh in a moment to see their profile.
            </p>
          </div>
        )}

        {!loading && hasPlayers && orgId && (
          <TeamHistorySection orgId={orgId} steamId={player?.steamId ?? ""} />
        )}

        {submitterUsername && (
          <section>
            <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
              <span>{submitterLabel}</span>
              <span className="font-mono normal-case tracking-normal text-muted-foreground">
                {formatRelativeTime(ticketCreatedAt)}
              </span>
            </h2>
            <div className="bg-surface/40 ring-1 ring-border rounded px-2 py-2 mb-2 space-y-2">
              <div className="flex items-center gap-2">
                <div className="size-5 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background bg-muted-foreground/40 shrink-0 text-[0.5625rem]">
                  {initials(submitterUsername)}
                </div>
                <p className="text-xs font-medium truncate min-w-0 flex-1">
                  {submitterUsername}
                </p>
                {submitterSteamId && (
                  <ExternalLinks steamId={submitterSteamId} size={10} />
                )}
              </div>
              <div className="space-y-1 pl-7">
                <SubmitterIdRow
                  label="Steam"
                  value={submitterSteamId}
                  href={
                    submitterSteamId
                      ? `https://steamcommunity.com/profiles/${submitterSteamId}`
                      : null
                  }
                />
                <SubmitterIdRow label="Discord" value={submitterDiscordId} />
              </div>
            </div>
            {submitterSteamAccounts && submitterSteamAccounts.length > 1 && (
              <div className="space-y-1">
                <p className="text-[0.625rem] font-mono text-warning uppercase tracking-widest">
                  Multiple Steam accounts linked
                </p>
                {submitterSteamAccounts.map((acct) => (
                  <div
                    key={acct.steamId}
                    className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1.5"
                  >
                    {acct.isPrimary && (
                      <span className="shrink-0 text-[0.5625rem] font-mono px-1 py-0.5 rounded bg-brand/15 text-brand ring-1 ring-brand/30">
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
    <aside className="w-[220px] shrink-0 hidden lg:flex flex-col bg-background overflow-hidden">
      <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-1.5">
        <Users size={10} className="text-muted-foreground shrink-0" />
        <span className="text-[0.625rem] font-mono uppercase tracking-widest font-bold">
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
          className="w-full bg-background border border-border rounded px-2 py-1 text-[0.625rem] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
        />
        {servers.length > 1 && (
          <select
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            className="w-full bg-background border border-border rounded px-2 py-1 text-[0.625rem] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
          >
            {servers.map((s) => (
              <option key={s.serverId} value={s.serverId}>
                {s.serverName}
              </option>
            ))}
          </select>
        )}
        {servers.length === 0 && (
          <p className="text-[0.625rem] font-mono text-muted-foreground">
            No RCON servers configured for this org.
          </p>
        )}
        <button
          onClick={handleLookup}
          disabled={
            !steamId.trim() || !serverId || loading || servers.length === 0
          }
          className="w-full text-[0.625rem] font-mono bg-brand text-brand-foreground rounded py-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {loading ? "Looking up..." : "Lookup"}
        </button>
        {error && (
          <p className="text-[0.625rem] font-mono text-danger leading-snug">
            {error}
          </p>
        )}
        {result && (
          <div>
            <div className="text-[0.625rem] font-mono text-muted-foreground mb-1.5">
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
                      <span className="text-[0.5625rem] text-green-400 shrink-0">
                        ●
                      </span>
                    )}
                    {member.leader && (
                      <span className="text-[0.5625rem] font-mono font-bold text-amber-400 shrink-0 uppercase">
                        Lead
                      </span>
                    )}
                    <span className="text-[0.625rem] font-medium truncate">
                      {member.username}
                    </span>
                  </div>
                  <div className="text-[0.625rem] font-mono text-muted-foreground mt-0.5 truncate">
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

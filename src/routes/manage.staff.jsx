import { GateRank, SectionHeader } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import { invalidateAuthMe } from "@/lib/auth-cache";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowDown,
  ArrowUpDown,
  Crown,
  Gavel,
  Search,
  ShieldCheck,
  Ticket,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useMemo, useEffect, useState } from "react";

export const Route = createFileRoute("/manage/staff")({
  component: StaffPage,
});

const ROLE_PALETTE = [
  { bg: "bg-amber-500/15", text: "text-amber-300", ring: "ring-amber-500/30" },
  { bg: "bg-brand/15", text: "text-brand", ring: "ring-brand/30" },
  { bg: "bg-sky-500/15", text: "text-sky-300", ring: "ring-sky-500/30" },
  {
    bg: "bg-emerald-500/15",
    text: "text-emerald-300",
    ring: "ring-emerald-500/30",
  },
  {
    bg: "bg-violet-500/15",
    text: "text-violet-300",
    ring: "ring-violet-500/30",
  },
  { bg: "bg-rose-500/15", text: "text-rose-300", ring: "ring-rose-500/30" },
];

function roleColor(roleId, customRoles) {
  const idx = customRoles.findIndex((r) => r.roleId === roleId);
  if (idx === -1) return ROLE_PALETTE[1];
  return ROLE_PALETTE[idx % ROLE_PALETTE.length];
}

function roleLabel(roleId, customRoles) {
  if (roleId === "org_owner") return "Owner";
  if (roleId === "org_admin") return "Admin";
  if (roleId === "org_member") return "Member";
  if (roleId === "org_disabled") return "Disabled";
  return customRoles.find((r) => r.roleId === roleId)?.roleName ?? roleId;
}

function roleShort(roleId, customRoles) {
  const label = roleLabel(roleId, customRoles);
  return label.slice(0, 4).toUpperCase();
}

function formatRelative(unixSec) {
  if (!unixSec) return null;
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / (86400 * 30))}mo`;
}

function relativeColor(unixSec) {
  if (!unixSec) return "text-muted-foreground/40";
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 3600) return "text-emerald-400";
  if (diff < 86400 * 7) return "text-foreground";
  if (diff < 86400 * 30) return "text-amber-400/80";
  return "text-muted-foreground/60";
}

function StatCard({ label, value, icon: Icon, colorClass, bgClass }) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg ring-1 bg-surface/40 px-4 py-3.5 ${colorClass}`}
    >
      <div
        className={`absolute inset-0 bg-gradient-to-br pointer-events-none ${bgClass}`}
      />
      <div className="relative flex items-start justify-between">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
        </div>
        <Icon className="size-4 text-muted-foreground/70" aria-hidden />
      </div>
    </div>
  );
}

const SORT_COLS = [
  { key: "name", label: "Member", title: "Staff member name" },
  { key: "role", label: "Role", title: "Rank within this org" },
  {
    key: "tickets_7d",
    label: "7d",
    title: "Tickets closed in the last 7 days",
  },
  {
    key: "tickets_30d",
    label: "30d",
    title: "Tickets closed in the last 30 days",
  },
  { key: "tickets_all", label: "All", title: "Tickets closed all-time" },
  { key: "last_panel", label: "Panel", title: "Most recent panel login" },
  {
    key: "last_ingame",
    label: "In-game",
    title: "Most recent time seen connected to a server",
  },
  {
    key: "last_ban",
    label: "Ban",
    title: "Most recent ban this staff member handed out",
  },
  { key: "ingame_h", label: "All", title: "Total in-game hours all-time" },
];

function SortTh({
  colKey,
  label,
  title,
  sortCol,
  sortDir,
  onSort,
  className = "",
  right = false,
}) {
  const active = sortCol === colKey;
  return (
    <th
      className={`bg-surface/60 px-3 py-2 border-b border-border text-[10px] font-mono uppercase tracking-widest sticky top-0 ${className}`}
    >
      <button
        title={title}
        onClick={() => onSort(colKey)}
        className={`inline-flex items-center gap-1 hover:text-foreground transition-colors w-full ${right ? "justify-end" : "justify-start"} ${active ? "text-brand" : "text-muted-foreground"}`}
      >
        <span className="truncate">{label}</span>
        {active ? (
          <ArrowDown
            className={`size-3 shrink-0 opacity-100 ${sortDir === "asc" ? "rotate-180" : ""}`}
            aria-hidden
          />
        ) : (
          <ArrowUpDown className="size-3 shrink-0 opacity-40" aria-hidden />
        )}
      </button>
    </th>
  );
}

function StaffPage() {
  const { sessionOrgOwnerIds, sessionUser, hasOrgPermission } = useAuth();
  const orgId = useManageOrgId();

  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [customRoles, setCustomRoles] = useState([]);
  const [staffStats, setStaffStats] = useState(null);

  const [discordId, setDiscordId] = useState("");
  const [addErr, setAddErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [removeErr, setRemoveErr] = useState(null);
  const [changingRoleId, setChangingRoleId] = useState(null);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");

  const [sortCol, setSortCol] = useState("tickets_30d");
  const [sortDir, setSortDir] = useState("desc");

  async function loadMembers() {
    if (!orgId) return;
    setMembersLoading(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/members`,
        {
          credentials: "include",
        },
      );
      if (res.ok) {
        const body = await res.json();
        setMembers(body.members ?? []);
      }
    } finally {
      setMembersLoading(false);
    }
  }

  async function loadCustomRoles() {
    if (!orgId) return;
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/roles`, {
        credentials: "include",
      });
      if (res.ok) {
        const body = await res.json();
        setCustomRoles(body.roles ?? []);
      }
    } catch {}
  }

  async function loadStaffStats() {
    if (!orgId) return;
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/staff-stats`,
        { credentials: "include" },
      );
      if (res.ok) {
        const body = await res.json();
        setStaffStats(body);
      }
    } catch {}
  }

  useEffect(() => {
    loadMembers();
    loadCustomRoles();
    loadStaffStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  if (!orgId) return null;

  const isAdmin =
    Boolean(sessionUser?.isSysAdmin) || hasOrgPermission(orgId, "org_manage");
  const isOwner = sessionOrgOwnerIds.includes(orgId);

  async function handleAdd() {
    const id = discordId.trim();
    if (!id) {
      setAddErr("Discord ID is required.");
      return;
    }
    setAdding(true);
    setAddErr(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/members`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ discordId: id }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setAddErr(body?.error ?? "Failed to add member.");
        return;
      }
      setDiscordId("");
      await loadMembers();
      await loadStaffStats();
    } catch {
      setAddErr("Network error.");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId) {
    setRemovingId(userId);
    setRemoveErr(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRemoveErr(body?.error ?? "Failed to remove member.");
        return;
      }
      await loadMembers();
      await loadStaffStats();
    } catch {
      setRemoveErr("Network error.");
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRoleChange(userId, newRole) {
    setChangingRoleId(userId);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ team: newRole }),
        },
      );
      if (!res.ok) return;
      invalidateAuthMe();
      await loadMembers();
    } finally {
      setChangingRoleId(null);
    }
  }

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (roleFilter !== "ALL" && m.roleId !== roleFilter) return false;
      if (q) {
        const match =
          (m.username ?? "").toLowerCase().includes(q) ||
          (m.steamId ?? "").includes(q) ||
          (m.discordId ?? "").includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [members, roleFilter, search]);

  const performanceRows = useMemo(() => {
    const statsMap = {};
    for (const s of staffStats?.memberStats ?? []) statsMap[s.userId] = s;

    return filteredMembers
      .map((m) => ({ ...m, ...(statsMap[m.userId] ?? {}) }))
      .sort((a, b) => {
        const get = (x) => {
          switch (sortCol) {
            case "name":
              return (x.username ?? "").toLowerCase();
            case "role":
              return roleLabel(x.roleId, customRoles).toLowerCase();
            case "tickets_7d":
              return x.tickets7d ?? 0;
            case "tickets_30d":
              return x.tickets30d ?? 0;
            case "tickets_all":
              return x.ticketsAll ?? 0;
            case "last_panel":
              return x.lastPanelLogin ?? 0;
            case "last_ingame":
              return x.lastIngame ?? 0;
            case "last_ban":
              return x.lastBan ?? 0;
            case "ingame_h":
              return x.ingameHoursAll ?? 0;
            default:
              return 0;
          }
        };
        const av = get(a),
          bv = get(b);
        if (av < bv) return sortDir === "desc" ? 1 : -1;
        if (av > bv) return sortDir === "desc" ? -1 : 1;
        return 0;
      });
  }, [filteredMembers, staffStats, sortCol, sortDir, customRoles]);

  const rank = isAdmin ? 4 : 0;
  const orgStats = staffStats?.orgStats;

  return (
    <GateRank rank={rank} required={4}>
      <SectionHeader
        title="Staff"
        blurb="Staff roster, activity, and moderation stats."
      />

      {/* Add staff */}
      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
          Add staff
        </Label>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Discord ID or Steam ID"
            value={discordId}
            onChange={(e) => {
              setDiscordId(e.target.value);
              setAddErr(null);
            }}
            className="flex-1 min-w-[200px]"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button size="sm" onClick={handleAdd} disabled={adding}>
            <UserPlus className="size-3.5 mr-1" />
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
        {addErr && <p className="text-[11px] text-danger">{addErr}</p>}
      </div>

      {removeErr && <p className="text-[11px] text-danger px-1">{removeErr}</p>}

      {/* Roster */}
      <div className="space-y-1.5">
        {membersLoading ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : members.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No members yet.
          </p>
        ) : (
          members.map((m) => {
            const isOwnerRow = m.roleId === "org_owner";
            const isDisabledRow = m.roleId === "org_disabled";
            const isMe = sessionUser?.userId === m.userId;
            const isChangingRole = changingRoleId === m.userId;
            const canActOnRow = isOwner || !isOwnerRow;
            const canChangeRole = !isMe && canActOnRow;
            const canRemove = !isMe && (isOwner || !isOwnerRow);

            return (
              <div
                key={m.userId}
                className={`flex items-center justify-between gap-2 ring-1 rounded-md p-2 ${isDisabledRow ? "bg-danger/5 ring-danger/20 opacity-70" : "bg-background ring-border"}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="size-7 rounded bg-brand/20 text-brand text-[10px] font-mono font-bold grid place-items-center shrink-0">
                    {(m.username ?? "?")[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate flex items-center gap-1.5">
                      {m.username ?? "Unknown"}
                      {isOwnerRow && (
                        <Crown
                          className="size-3 text-brand shrink-0"
                          title="Owner — cannot be removed"
                        />
                      )}
                      {isMe && (
                        <span className="text-[9px] font-mono uppercase tracking-widest text-brand bg-brand/10 px-1 py-0.5 rounded">
                          You
                        </span>
                      )}
                    </p>
                    <p className="text-[10px] font-mono text-muted-foreground truncate">
                      {m.steamId ? `steam:${m.steamId}` : "no steam"} ·{" "}
                      {m.discordId ? `discord:${m.discordId}` : "no discord"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    asChild
                    className="h-7 px-2 text-[10px] font-mono uppercase tracking-widest gap-1"
                    title="View audit log"
                  >
                    <Link
                      to="/staff-audit"
                      search={{
                        staff: m.userId,
                        org: orgId,
                        name: m.username ?? undefined,
                      }}
                    >
                      <Activity className="size-3" />
                      Audit
                    </Link>
                  </Button>

                  {canChangeRole && (
                    <RoleSelect
                      value={m.roleId}
                      isOwner={isOwner}
                      customRoles={customRoles}
                      disabled={isChangingRole}
                      onValueChange={(val) => handleRoleChange(m.userId, val)}
                    />
                  )}

                  {isMe && (
                    <Button
                      size="sm"
                      disabled
                      className="h-7 px-2 text-[10px] font-mono uppercase tracking-widest gap-1"
                      title="You"
                    >
                      <ShieldCheck className="size-3" />
                      You
                    </Button>
                  )}

                  {canRemove && (
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={removingId === m.userId}
                      onClick={() => handleRemove(m.userId)}
                      className="size-7 text-danger/60 hover:text-danger hover:bg-danger/10"
                      title="Remove from org"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Bans · 30d"
          value={orgStats ? orgStats.bans30d.toLocaleString() : "—"}
          icon={Gavel}
          colorClass="ring-rose-500/30"
          bgClass="from-rose-500/20 to-rose-500/0"
        />
        <StatCard
          label="Tickets · 30d"
          value={orgStats ? orgStats.tickets30d.toLocaleString() : "—"}
          icon={Ticket}
          colorClass="ring-brand/30"
          bgClass="from-brand/25 to-brand/0"
        />
        <StatCard
          label="Open Tickets"
          value={orgStats ? orgStats.openTickets.toLocaleString() : "—"}
          icon={Activity}
          colorClass="ring-sky-500/30"
          bgClass="from-sky-500/20 to-sky-500/0"
        />
        <StatCard
          label="Online Now"
          value={orgStats ? `${orgStats.onlineNow} / ${members.length}` : "—"}
          icon={Users}
          colorClass="ring-emerald-500/30"
          bgClass="from-emerald-500/20 to-emerald-500/0"
        />
      </div>

      {/* Search + role filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search
            className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            placeholder="Search by name, role, or Steam ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-3 rounded-md bg-surface/40 ring-1 ring-border text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-brand/60"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setRoleFilter("ALL")}
            className={`h-8 px-2.5 rounded-md ring-1 inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest transition ${
              roleFilter === "ALL"
                ? "bg-foreground/10 text-foreground ring-foreground/20"
                : "bg-transparent text-muted-foreground ring-border hover:text-foreground"
            }`}
          >
            All
          </button>
          {customRoles.map((r, i) => {
            const c = ROLE_PALETTE[i % ROLE_PALETTE.length];
            const active = roleFilter === r.roleId;
            return (
              <button
                key={r.roleId}
                onClick={() => setRoleFilter(active ? "ALL" : r.roleId)}
                className={`h-8 px-2.5 rounded-md ring-1 inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest transition ${
                  active
                    ? `${c.bg} ${c.text} ring-current/40`
                    : "bg-transparent text-muted-foreground ring-border hover:text-foreground"
                }`}
              >
                {r.roleName.slice(0, 4)}
                <span className="ml-1 opacity-70">
                  {members.filter((m) => m.roleId === r.roleId).length}
                </span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          {filteredMembers.length} results
        </div>
      </div>

      {/* Performance table */}
      <div className="rounded-lg ring-1 ring-border bg-surface/30 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-separate border-spacing-0 min-w-[900px]">
            <thead>
              <tr className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/70">
                <th
                  className="bg-surface/60 px-3 py-1.5 text-left border-b border-border"
                  colSpan={2}
                />
                <th
                  className="bg-surface/60 px-3 py-1.5 text-center border-b border-l border-border"
                  colSpan={3}
                >
                  Tickets Closed
                </th>
                <th
                  className="bg-surface/60 px-3 py-1.5 text-center border-b border-l border-border"
                  colSpan={3}
                >
                  Last Seen
                </th>
                <th
                  className="bg-surface/60 px-3 py-1.5 text-center border-b border-l border-border"
                  colSpan={1}
                >
                  In-game Hours
                </th>
              </tr>
              <tr>
                <SortTh
                  colKey="name"
                  label="Member"
                  title="Staff member name"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="pl-4 w-[220px]"
                />
                <SortTh
                  colKey="role"
                  label="Role"
                  title="Rank within this org"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="w-[110px]"
                />
                <SortTh
                  colKey="tickets_7d"
                  label="7d"
                  title="Tickets closed in the last 7 days"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="border-l border-border w-[70px]"
                  right
                />
                <SortTh
                  colKey="tickets_30d"
                  label="30d"
                  title="Tickets closed in the last 30 days"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="w-[70px]"
                  right
                />
                <SortTh
                  colKey="tickets_all"
                  label="All"
                  title="Tickets closed all-time"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="w-[80px]"
                  right
                />
                <SortTh
                  colKey="last_panel"
                  label="Panel"
                  title="Most recent panel login"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="border-l border-border w-[80px]"
                  right
                />
                <SortTh
                  colKey="last_ingame"
                  label="In-game"
                  title="Most recent time seen on a server"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="w-[80px]"
                  right
                />
                <SortTh
                  colKey="last_ban"
                  label="Ban"
                  title="Most recent ban issued"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="w-[80px]"
                  right
                />
                <SortTh
                  colKey="ingame_h"
                  label="Total"
                  title="Total in-game hours all-time"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="border-l border-border w-[80px] pr-4"
                  right
                />
              </tr>
            </thead>
            <tbody>
              {performanceRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-6 text-center text-[11px] text-muted-foreground border-t border-border/40"
                  >
                    {membersLoading
                      ? "Loading…"
                      : "No staff members match your search."}
                  </td>
                </tr>
              ) : (
                performanceRows.map((m, i) => {
                  const c = roleColor(m.roleId, customRoles);
                  const panelStr = formatRelative(m.lastPanelLogin);
                  const ingameStr = formatRelative(m.lastIngame);
                  const banStr = formatRelative(m.lastBan);
                  return (
                    <tr
                      key={m.userId}
                      className={`group transition-colors hover:bg-surface/60 ${i % 2 === 1 ? "bg-surface/20" : "bg-transparent"}`}
                    >
                      <td className="px-3 py-2.5 pl-4 border-t border-border/40">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`size-8 rounded-md grid place-items-center font-bold text-[11px] ring-1 ${c.bg} ${c.text} ${c.ring}`}
                          >
                            {(m.username ?? "?")[0].toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold truncate text-[13px]">
                              {m.username ?? "Unknown"}
                            </div>
                            {m.steamId && (
                              <div className="text-[10px] font-mono text-muted-foreground truncate">
                                {m.steamId}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 border-t border-border/40">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase tracking-widest ring-1 ${c.bg} ${c.text} ${c.ring}`}
                        >
                          {roleShort(m.roleId, customRoles)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums border-t border-border/40 border-l border-l-border">
                        {m.tickets7d ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums border-t border-border/40">
                        {m.tickets30d ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums border-t border-border/40 text-muted-foreground">
                        {m.ticketsAll != null
                          ? m.ticketsAll.toLocaleString()
                          : "—"}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right font-mono tabular-nums border-t border-border/40 border-l border-l-border ${relativeColor(m.lastPanelLogin)}`}
                      >
                        {panelStr ?? "—"}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right font-mono tabular-nums border-t border-border/40 ${relativeColor(m.lastIngame)}`}
                      >
                        {ingameStr ?? "—"}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right font-mono tabular-nums border-t border-border/40 ${relativeColor(m.lastBan)}`}
                      >
                        {banStr ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums border-t border-border/40 border-l border-l-border text-muted-foreground pr-4">
                        {m.ingameHoursAll
                          ? `${Math.round(m.ingameHoursAll).toLocaleString()}h`
                          : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Built-in role legend */}
      <div className="rounded-md ring-1 ring-border/50 bg-surface/20 p-3 space-y-1.5">
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          Built-in roles
        </p>
        <div className="space-y-1">
          <div className="flex items-start gap-2">
            <Crown className="size-3 text-brand mt-0.5 shrink-0" />
            <p className="text-[11px] text-muted-foreground">
              <span className="text-foreground font-medium">Owner</span> — full
              access to this org; can assign any role and manage other owners.
              Cannot be removed by admins.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <ShieldCheck className="size-3 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-[11px] text-muted-foreground">
              <span className="text-foreground font-medium">Admin</span> — can
              add/remove non-owner staff and assign custom roles to them.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <span className="size-3 mt-0.5 shrink-0" />
            <p className="text-[11px] text-muted-foreground">
              <span className="text-foreground font-medium">Member</span> — part
              of the org with no additional panel permissions beyond assigned
              custom roles.
            </p>
          </div>
        </div>
      </div>
    </GateRank>
  );
}

function RoleSelect({ value, isOwner, customRoles, disabled, onValueChange }) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        className="h-7 w-[130px] text-[11px] font-mono disabled:opacity-50"
        title="Change role"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {isOwner ? (
          <>
            <SelectGroup>
              <SelectLabel className="text-[10px] font-mono uppercase tracking-widest px-2 py-1">
                Built-in
              </SelectLabel>
              <SelectItem value="org_member">Member</SelectItem>
              <SelectItem value="org_admin">Admin</SelectItem>
              <SelectItem value="org_owner">Owner</SelectItem>
            </SelectGroup>
            {customRoles.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel className="text-[10px] font-mono uppercase tracking-widest px-2 py-1">
                    Custom
                  </SelectLabel>
                  {customRoles.map((r) => (
                    <SelectItem key={r.roleId} value={r.roleId}>
                      {r.roleName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
            <SelectSeparator />
            <SelectItem value="org_disabled" className="text-danger">
              Disabled
            </SelectItem>
          </>
        ) : (
          <>
            {value === "org_admin" && (
              <SelectItem value="org_admin" disabled>
                Admin (current)
              </SelectItem>
            )}
            <SelectItem value="org_member">Member</SelectItem>
            {customRoles.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel className="text-[10px] font-mono uppercase tracking-widest px-2 py-1">
                    Custom
                  </SelectLabel>
                  {customRoles.map((r) => (
                    <SelectItem key={r.roleId} value={r.roleId}>
                      {r.roleName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
            <SelectSeparator />
            <SelectItem value="org_disabled" className="text-danger">
              Disabled
            </SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

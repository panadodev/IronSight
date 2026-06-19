import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAuthMe, invalidateAuthMe } from "@/lib/auth-cache";
import { useAuth } from "@/lib/auth-context";
import { timezoneStore } from "@/lib/timezone-store";
import { lastVisitStore } from "@/lib/last-visit";
import { manageOrgStore, useManageOrgId } from "@/lib/manage-org-store";
import { TEAM_META } from "@/lib/mock-data";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Building2, Check, ChevronDown, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
function SiteNav() {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const path = location.pathname;
  const {
    view,
    setView,
    activeStaff,
    orgs,
    selectedOrgIds,
    toggleOrg,
    setSelectedOrgIds,
    hasStaffAccount,
    publicSignedIn,
    profile,
    updateProfile,
    realManageableOrgIds,
    adminableOrgIds,
    isImpersonating,
    stopImpersonating,
    hasOrgPermission,
  } = useAuth();
  void realManageableOrgIds;
  const [sessionUser, setSessionUser] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [draft, setDraft] = useState({ ...profile, timezone: timezoneStore.get() });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [createdOrgs, setCreatedOrgs] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [guildId, setGuildId] = useState("");
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);
  const isSysAdminSession = Boolean(sessionUser?.isSysAdmin);

  // Per-org permission helpers. A link should appear if the user has the
  // relevant permission in ANY org (admins/owners pass via hasOrgPermission,
  // sysadmins always pass). This mirrors the server-side permission checks so
  // permission-granted (non-admin) staff see the features they can actually use.
  const anyOrgHas = useMemo(() => {
    return (perm) =>
      isSysAdminSession || orgs.some((o) => hasOrgPermission(o.id, perm));
  }, [isSysAdminSession, orgs, hasOrgPermission]);

  const canRcon = anyOrgHas("rcon_access");
  const canScriptsView = anyOrgHas("scripts_view") || anyOrgHas("scripts_manage");
  const canPresets = anyOrgHas("presets_manage");
  const canStatus = anyOrgHas("status_view");
  const canServers = anyOrgHas("servers_manage");
  const canTicketsView = anyOrgHas("tickets_view") || anyOrgHas("tickets_manage");
  const canOrgManage = anyOrgHas("org_manage");
  const canRoleManage = anyOrgHas("role_create");
  const canPredefines = anyOrgHas("predefines_manage");
  const canToxicity = anyOrgHas("toxicity_manage");
  const canBanConfigs = anyOrgHas("ban_configs_manage");
  const canPlayersView = anyOrgHas("players_view");
  const canBansManage = anyOrgHas("bans_manage");
  const canTriggers = anyOrgHas("triggers_manage");
  const canDiscordMod = anyOrgHas("discord_mod");
  const canManageSection =
    canOrgManage ||
    canRoleManage ||
    canPredefines ||
    canToxicity ||
    canBanConfigs;

  const allOrgs = useMemo(() => {
    const map = new Map(orgs.map((o) => [o.id, o]));
    for (const org of createdOrgs) {
      map.set(org.id, org);
    }
    return Array.from(map.values());
  }, [orgs, createdOrgs]);

  useEffect(() => {
    let cancelled = false;

    // Re-use the cached /api/auth/me result that the root beforeLoad already
    // fetched. In the common case this is a synchronous cache-hit (no extra
    // network request). Only on first mount (or after invalidation) does a
    // real fetch occur — and even then it is shared with the guard above.
    getAuthMe().then(({ status, user }) => {
      if (cancelled) return;

      setSessionUser(user);

      if (user) {
        const linkedSteam = user.steamId
          ? { id: user.steamId, name: user.username }
          : null;
        const linkedDiscord = user.discordId
          ? { id: user.discordId, name: user.username }
          : null;

        setDraft((current) => ({
          ...current,
          displayName: user.username,
          steamLinked: linkedSteam,
          discordLinked: linkedDiscord,
        }));
      }

      setSessionChecked(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const openProfile = () => {
    setProfileError("");
    setDraft((current) => ({
      ...profile,
      ...current,
      displayName: sessionUser?.username ?? profile.displayName,
      steamLinked: sessionUser?.steamId
        ? { id: sessionUser.steamId, name: sessionUser.username }
        : profile.steamLinked,
      discordLinked: sessionUser?.discordId
        ? { id: sessionUser.discordId, name: sessionUser.username }
        : profile.discordLinked,
      timezone: timezoneStore.get(),
    }));
    setProfileOpen(true);
  };
  const saveProfile = async () => {
    const trimmedName = draft.displayName.trim();
    setProfileSaving(true);
    setProfileError("");

    try {
      let nextSessionUser = sessionUser;

      if (sessionUser && trimmedName && trimmedName !== sessionUser.username) {
        const res = await fetch("/api/auth/me", {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: trimmedName }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setProfileError(body?.error ?? "Failed to update name.");
          return;
        }

        const body = await res.json();
        nextSessionUser = body?.user ?? sessionUser;
        setSessionUser(nextSessionUser);
        invalidateAuthMe(); // stale username in cache — evict so next load is fresh
      }

      timezoneStore.set(draft.timezone ?? "");
      updateProfile({
        ...draft,
        displayName: nextSessionUser?.username ?? trimmedName,
      });
      setProfileOpen(false);
    } catch {
      setProfileError("Failed to update name.");
    } finally {
      setProfileSaving(false);
    }
  };
  const manageableOrgsForSwitcher = useMemo(() => {
    if (sessionUser?.isSysAdmin) return allOrgs;

    const MANAGE_PERMS = [
      "org_manage",
      "role_create",
      "ban_configs_manage",
      "toxicity_manage",
      "predefines_manage",
    ];
    const sessionOrgAdminIds = Array.isArray(sessionUser?.orgAdminOrgIds)
      ? sessionUser.orgAdminOrgIds
      : [];
    const orgPerms =
      sessionUser?.orgPermissions && typeof sessionUser.orgPermissions === "object"
        ? sessionUser.orgPermissions
        : {};

    const filtered = allOrgs.filter(
      (o) =>
        sessionOrgAdminIds.includes(o.id) ||
        adminableOrgIds.includes(o.id) ||
        MANAGE_PERMS.some((p) => (orgPerms[o.id] ?? []).includes(p)),
    );
    return filtered;
  }, [sessionUser, allOrgs, adminableOrgIds]);

  async function createOrganization() {
    setCreateError("");

    if (!orgName.trim()) {
      setCreateError("Organization name is required.");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/orgs", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: orgName.trim(),
          orgId: orgId.trim() || undefined,
          guildId: guildId.trim() || undefined,
        }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setCreateError(body?.error ?? "Failed to create organization.");
        return;
      }

      const created = {
        id: body.organization.orgId,
        name: body.organization.name,
        short: body.organization.orgId.slice(0, 2).toUpperCase(),
      };

      setCreatedOrgs((current) => {
        if (current.some((o) => o.id === created.id)) return current;
        return [...current, created];
      });
      setSelectedOrgIds((current) =>
        current.includes(created.id) ? current : [...current, created.id],
      );

      manageOrgStore.set(created.id);
      setCreateOpen(false);
      setOrgName("");
      setOrgId("");
      setGuildId("");
    } catch (error) {
      setCreateError(error?.message ?? "Failed to create organization.");
    } finally {
      setCreating(false);
    }
  }
  const switchView = (v) => {
    setView(v);
    if (v === "public") {
      if (
        !path.startsWith("/submit") &&
        !path.startsWith("/support") &&
        !path.startsWith("/my-reports")
      ) {
        navigate({ to: "/support" });
      }
    } else {
      if (
        path.startsWith("/submit") ||
        path.startsWith("/support") ||
        path.startsWith("/my-reports")
      ) {
        navigate({ to: "/" });
      }
    }
  };

  const signOut = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      invalidateAuthMe();
      window.location.assign(`/login?next=${encodeURIComponent(path || "/")}`);
    }
  };
  const currentSearch = location.search;
  const currentOrgId =
    typeof currentSearch?.org === "string" ? currentSearch.org : void 0;
  const publicGroups = [
    {
      label: "Player Portal",
      links: [
        { to: "/support", label: "Submit Ticket" },
        { to: "/my-reports", label: "My Tickets" },
      ],
    },
  ];
  const staffGroups = [
    {
      label: "Panel",
      links: [
        { to: "/todo", label: "Todo", show: true },
        {
          to: "/panel",
          label: "RCON",
          search: { tab: "rcon" },
          matchSearch: (s) => (s.tab ?? "rcon") === "rcon",
          show: canRcon,
        },
        {
          to: "/panel",
          label: "Scripts",
          search: { tab: "scripts" },
          matchSearch: (s) => s.tab === "scripts",
          show: canScriptsView,
        },
        {
          to: "/panel",
          label: "Pre-sets",
          search: { tab: "presets" },
          matchSearch: (s) => s.tab === "presets",
          show: canPresets,
        },
        {
          to: "/panel",
          label: "Status",
          search: { tab: "status" },
          matchSearch: (s) => s.tab === "status",
          show: canStatus,
        },
      ],
    },
    {
      label: "Moderation",
      links: [
        {
          to: "/tickets",
          label: "Tickets",
          show: canTicketsView,
        },
        { to: "/player-lookup", label: "Player Lookup", show: canPlayersView },
        { to: "/player-list", label: "Player List", show: canPlayersView },
        { to: "/chat", label: "Chat", show: true },
        { to: "/bans-mutes", label: "Bans / Mutes", show: canBansManage },
        {
          to: "/discord-mod",
          label: "Discord Mod",
          show: canDiscordMod,
        },
        { to: "/docs", label: "Docs", show: true },
      ],
    },
    {
      label: "Manage Org",
      links: [
        {
          to: "/manage/details",
          label: "Manage",
          show: canManageSection,
        },
        {
          to: "/manage/roles",
          label: "Roles",
          show: canRoleManage,
        },
        {
          to: "/manage/predefines",
          label: "Pre-defines",
          show: canPredefines,
        },
        {
          to: "/manage/toxicity",
          label: "Toxicity",
          show: canToxicity,
        },
        {
          to: "/manage/ban-configs",
          label: "Ban configs",
          show: canBanConfigs,
        },
        {
          to: "/manage/staff",
          label: "Staff",
          show: canOrgManage,
        },
        {
          to: "/threat-triggers",
          label: "Triggers",
          show: canTriggers,
        },
        {
          to: "/panel",
          label: "Servers",
          search: { tab: "servers" },
          matchSearch: (s) => s.tab === "servers",
          show: canServers,
        },
      ],
    },
  ]
    .map((g) => ({ ...g, links: g.links.filter((l) => l.show !== false) }))
    .filter((g) => g.links.length > 0);
  const effectiveView = sessionUser ? view : "public";
  const groups = effectiveView === "public" ? publicGroups : staffGroups;
  const hasNewTodo = false;
  useEffect(() => {
    if (effectiveView !== "staff") return;
    if (path === "/") lastVisitStore.mark("/");
    else if (path.startsWith("/todo")) lastVisitStore.mark("/todo");
  }, [path, effectiveView]);
  const selectedOrgsLabel =
    selectedOrgIds.length === allOrgs.length
      ? "All orgs"
      : selectedOrgIds.length === 0
        ? "No orgs"
        : selectedOrgIds
            .map((id) => allOrgs.find((o) => o.id === id)?.short)
            .filter(Boolean)
            .join(" \xB7 ");
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 w-56 border-r border-border bg-background flex flex-col">
        {/* Brand */}
        <div className="h-14 px-4 flex items-center gap-2 border-b border-border shrink-0">
          <svg
            viewBox="80 80 260 260"
            width="28"
            height="28"
            aria-hidden="true"
            className="shrink-0"
          >
            <circle
              cx="210"
              cy="210"
              r="130"
              strokeDasharray="4 6"
              fill="none"
              stroke="#3d3d3a"
              strokeWidth="0.8"
              opacity="0.35"
            />
            <polyline
              points="110,120 110,100 130,100"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <polyline
              points="290,100 310,100 310,120"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <polyline
              points="110,300 110,320 130,320"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <polyline
              points="290,320 310,320 310,300"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <circle
              cx="210"
              cy="210"
              r="72"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="1.5"
            />
            <circle
              cx="210"
              cy="210"
              r="38"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="1.5"
            />
            <line
              x1="210"
              y1="100"
              x2="210"
              y2="168"
              stroke="#60a5fa"
              strokeWidth="1.5"
            />
            <line
              x1="210"
              y1="252"
              x2="210"
              y2="320"
              stroke="#60a5fa"
              strokeWidth="1.5"
            />
            <line
              x1="100"
              y1="210"
              x2="168"
              y2="210"
              stroke="#60a5fa"
              strokeWidth="1.5"
            />
            <line
              x1="252"
              y1="210"
              x2="320"
              y2="210"
              stroke="#60a5fa"
              strokeWidth="1.5"
            />
            <line
              x1="210"
              y1="134"
              x2="210"
              y2="143"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <line
              x1="210"
              y1="277"
              x2="210"
              y2="286"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <line
              x1="124"
              y1="210"
              x2="133"
              y2="210"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <line
              x1="287"
              y1="210"
              x2="296"
              y2="210"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <line
              x1="159"
              y1="159"
              x2="165"
              y2="165"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <line
              x1="261"
              y1="159"
              x2="255"
              y2="165"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <line
              x1="159"
              y1="261"
              x2="165"
              y2="255"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <line
              x1="261"
              y1="261"
              x2="255"
              y2="255"
              stroke="#60a5fa"
              strokeWidth="2"
            />
            <polygon
              points="210,192 224,201 224,219 210,228 196,219 196,201"
              fill="#60a5fa"
              fillOpacity="0.15"
            />
            <polygon
              points="210,192 224,201 224,219 210,228 196,219 196,201"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="1.5"
            />
            <circle cx="210" cy="210" r="4" fill="#60a5fa" />
            <circle cx="210" cy="192" r="2" fill="#60a5fa" />
            <circle cx="224" cy="201" r="2" fill="#60a5fa" />
            <circle cx="224" cy="219" r="2" fill="#60a5fa" />
            <circle cx="210" cy="228" r="2" fill="#60a5fa" />
            <circle cx="196" cy="219" r="2" fill="#60a5fa" />
            <circle cx="196" cy="201" r="2" fill="#60a5fa" />
          </svg>
          <span className="text-sm font-bold tracking-tight text-foreground">
            IRONSIGHT
          </span>
          <span className="ml-auto text-[9px] font-mono uppercase tracking-widest text-brand">
            {effectiveView}
          </span>
        </div>

        {/* Org selector (staff only) */}
        {effectiveView === "staff" && sessionUser && (
          <div className="p-2 border-b border-border">
            <Popover>
              <PopoverTrigger asChild>
                <button className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md ring-1 ring-border bg-surface/40 hover:bg-surface transition-colors">
                  <Building2 className="size-3.5 text-brand shrink-0" />
                  <div className="flex flex-col items-start leading-tight min-w-0 flex-1">
                    <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                      Selected Orgs
                    </span>
                    <span className="text-xs font-semibold text-foreground truncate w-full text-left">
                      {selectedOrgsLabel}
                    </span>
                  </div>
                  <ChevronDown className="size-3 text-muted-foreground shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="right" className="w-64 p-2">
                <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-border">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Organizations
                  </span>
                  <button
                    onClick={() =>
                      setSelectedOrgIds(
                        selectedOrgIds.length === allOrgs.length
                          ? []
                          : allOrgs.map((o) => o.id),
                      )
                    }
                    className="text-[10px] font-semibold text-brand hover:underline"
                  >
                    {selectedOrgIds.length === allOrgs.length
                      ? "Clear"
                      : "Select all"}
                  </button>
                </div>
                <div className="space-y-0.5">
                  {allOrgs.map((o) => {
                    const checked = selectedOrgIds.includes(o.id);
                    return (
                      <button
                        key={o.id}
                        onClick={() => toggleOrg(o.id)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
                      >
                        <span
                          className={
                            "size-4 rounded-sm grid place-items-center ring-1 " +
                            (checked
                              ? "bg-brand ring-brand text-brand-foreground"
                              : "ring-border text-transparent")
                          }
                        >
                          <Check className="size-3" />
                        </span>
                        <span className="text-xs font-medium flex-1">
                          {o.name}
                        </span>
                        <span className="text-[9px] font-mono font-bold text-muted-foreground">
                          {o.short}
                        </span>
                      </button>
                    );
                  })}
                  {sessionUser?.isSysAdmin ? (
                    <button
                      onClick={() => setCreateOpen(true)}
                      className="w-full mt-1 px-2 py-1.5 rounded border border-dashed border-border hover:bg-surface text-left text-xs font-semibold text-brand"
                    >
                      + Create organization
                    </button>
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}

        {/* Nav groups */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="px-2 mb-1 flex items-center gap-2">
                <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                  {group.label}
                </span>
                {group.label === "Manage Org" &&
                  manageableOrgsForSwitcher.length > 0 && (
                    <ManageOrgInlineSwitcher orgs={manageableOrgsForSwitcher} />
                  )}
              </div>

              <div className="space-y-0.5">
                {group.links.map((l, idx) => {
                  const pathMatches =
                    l.to === "/" ? path === "/" : path.startsWith(l.to);
                  const active = l.matchSearch
                    ? pathMatches && l.matchSearch(location.search)
                    : pathMatches;
                  const search =
                    l.search ??
                    (view === "public" && currentOrgId
                      ? { org: currentOrgId }
                      : void 0);
                  const showDot =
                    l.to === "/todo" && hasNewTodo && path !== "/todo";
                  return (
                    <Link
                      key={l.to + ":" + (l.label ?? idx)}
                      to={l.to}
                      search={search}
                      className={
                        "relative flex items-center px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors " +
                        (active
                          ? "text-foreground bg-surface"
                          : "text-muted-foreground hover:text-foreground hover:bg-surface/50")
                      }
                    >
                      {l.label}
                      {showDot && (
                        <span
                          className="ml-auto size-2 rounded-full bg-danger"
                          aria-label="New"
                        />
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer actions */}
        <div className="border-t border-border p-2 space-y-1.5 shrink-0">
          {effectiveView === "staff" && isImpersonating && (
            <button
              onClick={stopImpersonating}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 ring-1 ring-warning/40 bg-warning/10 text-warning rounded-md hover:bg-warning/20 transition-colors text-[10px] font-mono uppercase tracking-widest"
              title="Stop impersonating"
            >
              Stop: {activeStaff?.name}
            </button>
          )}

          {effectiveView === "staff" && (sessionUser || activeStaff) ? (
            <button
              onClick={openProfile}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface/60 ring-1 ring-border rounded-md hover:bg-surface transition-colors cursor-pointer"
              title="Open profile"
            >
              <div className="size-2 bg-success rounded-full shrink-0" />
              <span className="text-xs font-mono truncate flex-1 text-left">
                {sessionUser?.username ?? activeStaff?.name}
              </span>
              <span className="text-[9px] font-bold text-brand uppercase tracking-widest shrink-0">
                {activeStaff ? TEAM_META[activeStaff.team].short : "LIVE"}
              </span>
            </button>
          ) : (
            <button
              onClick={openProfile}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface/60 ring-1 ring-border rounded-md hover:bg-surface transition-colors cursor-pointer"
              title="Open profile"
            >
              <div
                className={
                  "size-2 rounded-full shrink-0 " +
                  (publicSignedIn ? "bg-success" : "bg-muted-foreground")
                }
              />
              <span className="text-xs font-mono truncate flex-1 text-left">
                {publicSignedIn ? "Public View" : "Not signed in"}
              </span>
            </button>
          )}

          {/* Staff login icon — visible when no staff session exists */}
          {!sessionUser && (
            <Link
              to="/login"
              search={{ next: "/" }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-muted-foreground hover:text-foreground hover:bg-surface/50 rounded-md transition-colors"
              title="Staff login"
            >
              <Lock className="size-3.5 shrink-0" />
              <span className="text-[10px] font-mono uppercase tracking-widest">
                Staff Login
              </span>
            </Link>
          )}

          <div className="flex gap-3 justify-center px-2.5 py-1">
            <Link
              to="/privacy"
              className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              Privacy
            </Link>
            <span className="text-[9px] text-muted-foreground/30">·</span>
            <Link
              to="/tos"
              className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              Terms
            </Link>
          </div>
        </div>
      </aside>

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Profile</DialogTitle>
            <DialogDescription>
              Manage your support system identity, linked accounts, and
              integration tokens.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            <div className="space-y-1.5">
              <Label>Demo view</Label>
              <div className="flex items-center gap-1 bg-surface/60 ring-1 ring-border rounded-md p-0.5 w-fit">
                {["public", "staff"].map((v) => (
                  <button
                    key={v}
                    disabled={!sessionUser && v === "staff"}
                    onClick={() => switchView(v)}
                    className={
                      "px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors " +
                      (view === v
                        ? "bg-brand text-brand-foreground"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    {v} view
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Toggle between the public player-facing site and the staff
                panel.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Signed in as</Label>
              <div className="flex items-center justify-between bg-surface/60 ring-1 ring-border rounded-md p-3">
                {sessionUser ? (
                  <>
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="size-10 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0"
                        style={{ background: "hsl(170 70% 40%)" }}
                      >
                        {sessionUser.username.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">
                          {sessionUser.username}
                        </p>
                        <p className="text-[10px] font-mono text-muted-foreground truncate">
                          {sessionUser.steamId ?? "No Steam linked"} ·{" "}
                          {sessionUser.discordId}
                        </p>
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={signOut}>
                      Sign out
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">
                      No active session
                    </span>
                    <Button
                      size="sm"
                      onClick={() =>
                        window.location.assign(
                          `/login?next=${encodeURIComponent(path || "/")}`,
                        )
                      }
                    >
                      Sign in
                    </Button>
                  </>
                )}
              </div>
            </div>

            {sessionUser && (
              <div className="space-y-1.5">
                <Label htmlFor="display-name">Display name</Label>
                <Input
                  id="display-name"
                  value={draft.displayName}
                  onChange={(e) =>
                    setDraft({ ...draft, displayName: e.target.value })
                  }
                  maxLength={64}
                  disabled={profileSaving}
                />
                <p className="text-[11px] text-muted-foreground">
                  How your name appears to players and other staff in this org.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <Select
                value={draft.timezone || "__browser_default__"}
                onValueChange={(v) =>
                  setDraft({ ...draft, timezone: v === "__browser_default__" ? null : v })
                }
              >
                <SelectTrigger id="timezone">
                  <SelectValue placeholder="Browser default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__browser_default__">Browser default</SelectItem>
                  <SelectItem value="UTC">UTC</SelectItem>
                  <SelectItem value="America/Los_Angeles">America/Los_Angeles (PT)</SelectItem>
                  <SelectItem value="America/Denver">America/Denver (MT)</SelectItem>
                  <SelectItem value="America/Chicago">America/Chicago (CT)</SelectItem>
                  <SelectItem value="America/New_York">America/New_York (ET)</SelectItem>
                  <SelectItem value="America/Halifax">America/Halifax (AT)</SelectItem>
                  <SelectItem value="America/Sao_Paulo">America/Sao_Paulo (BRT)</SelectItem>
                  <SelectItem value="Europe/London">Europe/London (GMT/BST)</SelectItem>
                  <SelectItem value="Europe/Paris">Europe/Paris (CET/CEST)</SelectItem>
                  <SelectItem value="Europe/Helsinki">Europe/Helsinki (EET/EEST)</SelectItem>
                  <SelectItem value="Europe/Moscow">Europe/Moscow (MSK)</SelectItem>
                  <SelectItem value="Asia/Dubai">Asia/Dubai (GST)</SelectItem>
                  <SelectItem value="Asia/Kolkata">Asia/Kolkata (IST)</SelectItem>
                  <SelectItem value="Asia/Singapore">Asia/Singapore (SGT)</SelectItem>
                  <SelectItem value="Asia/Tokyo">Asia/Tokyo (JST)</SelectItem>
                  <SelectItem value="Australia/Sydney">Australia/Sydney (AEST/AEDT)</SelectItem>
                  <SelectItem value="Pacific/Auckland">Pacific/Auckland (NZST/NZDT)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Timestamps throughout the panel will display in this timezone.
              </p>
            </div>

            {profileError ? (
              <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {profileError}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label>Linked accounts</Label>
              <LinkedAccountRow
                provider="Steam"
                linked={
                  sessionUser?.steamId
                    ? { id: sessionUser.steamId, name: sessionUser.username }
                    : draft.steamLinked
                }
                readOnly
              />
              <LinkedAccountRow
                provider="Discord"
                linked={
                  sessionUser?.discordId
                    ? { id: sessionUser.discordId, name: sessionUser.username }
                    : draft.discordLinked
                }
                readOnly
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setProfileOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveProfile} disabled={profileSaving}>
              {profileSaving ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>
              Sysadmin action. Creates a new organization record and selects it
              for editing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-org-name">Name</Label>
              <Input
                id="new-org-name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="My Organization"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-org-id">Org ID (optional)</Label>
              <Input
                id="new-org-id"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                placeholder="my_organization"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-guild-id">Discord Guild ID (optional)</Label>
              <Input
                id="new-guild-id"
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                placeholder="123456789012345678"
              />
            </div>
            {createError ? (
              <p className="text-xs text-danger">{createError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createOrganization} disabled={creating}>
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
function LinkedAccountRow({
  provider,
  linked,
  readOnly = false,
  onLink,
  onUnlink,
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-md ring-1 ring-border bg-surface/40">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground w-14">
          {provider}
        </span>
        {linked ? (
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{linked.name}</div>
            <div className="text-[10px] font-mono text-muted-foreground truncate">
              {linked.id}
            </div>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Not linked</span>
        )}
      </div>
      {readOnly ? (
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          Provider-managed
        </span>
      ) : linked ? (
        <Button size="sm" variant="outline" onClick={onUnlink}>
          Unlink
        </Button>
      ) : (
        <Button size="sm" onClick={onLink}>
          Link {provider}
        </Button>
      )}
    </div>
  );
}
function ManageOrgInlineSwitcher({ orgs }) {
  const [localOrgs, setLocalOrgs] = useState(orgs);

  useEffect(() => {
    setLocalOrgs((current) => {
      const map = new Map(current.map((o) => [o.id, o]));
      for (const org of orgs) {
        map.set(org.id, org);
      }
      return Array.from(map.values());
    });
  }, [orgs]);

  const currentId = useManageOrgId();
  const active = useMemo(
    () => localOrgs.find((o) => o.id === currentId) ?? localOrgs[0],
    [localOrgs, currentId],
  );

  useEffect(() => {
    if (localOrgs.length === 0) return;
    if (!currentId || !localOrgs.some((o) => o.id === currentId)) {
      manageOrgStore.set(localOrgs[0].id);
    }
  }, [localOrgs, currentId]);

  if (!active) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded ring-1 ring-border bg-surface/40 hover:bg-surface transition-colors"
          title={
            active
              ? `Editing configs for ${active.name}`
              : "Editing configs for"
          }
        >
          <span className="text-[9px] font-mono font-bold text-brand">
            {active ? active.short : "--"}
          </span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-56 p-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 pb-1 mb-1 border-b border-border">
          Editing configs for
        </div>
        <div className="space-y-0.5">
          {localOrgs.map((o) => {
            const checked = o.id === active?.id;
            return (
              <button
                key={o.id}
                onClick={() => manageOrgStore.set(o.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
              >
                <span
                  className={
                    "size-4 rounded-sm grid place-items-center ring-1 " +
                    (checked
                      ? "bg-brand ring-brand text-brand-foreground"
                      : "ring-border text-transparent")
                  }
                >
                  <Check className="size-3" />
                </span>
                <span className="text-xs font-medium flex-1">{o.name}</span>
                <span className="text-[9px] font-mono font-bold text-muted-foreground">
                  {o.short}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
export { SiteNav };

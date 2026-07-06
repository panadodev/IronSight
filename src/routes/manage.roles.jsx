import { GateRank, SectionHeader } from "@/components/manage-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Lock,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/manage/roles")({
  component: RolesPage,
});

const PERMISSION_GROUPS = [
  {
    label: "Panel",
    perms: [
      {
        id: "rcon_access",
        label: "RCON Access",
        desc: "Execute RCON commands on servers",
      },
      {
        id: "scripts_view",
        label: "View Scripts",
        desc: "View saved RCON command scripts",
      },
      {
        id: "scripts_manage",
        label: "Manage Scripts",
        desc: "Create, edit, and delete RCON scripts",
      },
      {
        id: "presets_manage",
        label: "Manage Plugins",
        desc: "Manage server plugin configurations",
      },
      {
        id: "status_view",
        label: "View Status",
        desc: "View server status and health",
      },
      {
        id: "media_upload",
        label: "Upload Media",
        desc: "Upload and manage evidence clips and screenshots",
      },
    ],
  },
  {
    label: "Moderation",
    perms: [
      {
        isParent: true,
        id: "_tickets",
        label: "Tickets",
        desc: "Access to the ticket system",
        showTicketTypes: true,
        children: [
          {
            id: "tickets_view",
            label: "View Tickets",
            desc: "View and search support tickets",
          },
          {
            id: "tickets_manage",
            label: "Interact with Tickets",
            desc: "Respond to and close support tickets",
          },
          {
            id: "tickets_player_intel",
            label: "Player Intel Panel",
            desc: "View the player intelligence sidebar in tickets",
          },
          {
            id: "tickets_blacklist",
            label: "Manage Ticket Blacklist",
            desc: "Blacklist users from submitting certain ticket types again",
          },
          {
            id: "cases_create",
            label: "Create Cases",
            desc: "Create internal staff cases from the Player Lookup page (owners and admins always have this)",
          },
        ],
      },
      {
        isParent: true,
        id: "_players",
        label: "Player Lookup",
        desc: "Player search and profile access",
        children: [
          {
            id: "players_view",
            label: "Search & Overview",
            desc: "Search for players and view the overview section (Steam stats, BM stats, risk flags)",
          },
          {
            id: "player_list",
            label: "Player List",
            desc: "Access the live player list page showing all players seen on servers",
          },
          {
            id: "player_session_history",
            label: "Session History",
            desc: "View BattleMetrics session history and session timeline on player profiles",
          },
          {
            id: "player_steam_friends",
            label: "Steam Friends",
            desc: "View a player's Steam friends list on their profile",
          },
          {
            id: "player_notes",
            label: "Player Notes",
            desc: "View and add staff notes on player profiles",
          },
          {
            id: "staff_discord_lookup",
            label: "Discord → Steam Lookup",
            desc: "Search for Steam accounts linked to org members' Discord accounts on the player lookup page",
          },
        ],
      },
      {
        id: "ip_read",
        label: "View Connection Points",
        desc: "See connection history",
      },
      {
        id: "view_raw_ip",
        label: "View Raw IPs",
        desc: "Reveal unmasked IP addresses on connection points (requires View Connection Points)",
      },
      {
        isParent: true,
        id: "_chat",
        label: "View Chat Logs",
        desc: "Access the in-game chat log viewer",
        children: [
          {
            id: "chat_view",
            label: "View Chat Logs",
            desc: "Access the in-game chat log viewer",
          },
          {
            id: "flagged_messages_resolve",
            label: "Flag Resolution — Full",
            desc: "Can both confirm and dismiss any AI-flagged chat message",
          },
          {
            id: "flagged_messages_confirm",
            label: "Flag Resolution — Confirm Only",
            desc: "Mark flagged messages as confirmed violations",
          },
          {
            id: "flagged_messages_clear",
            label: "Flag Resolution — Clear Only",
            desc: "Dismiss flagged messages as non-violations",
          },
        ],
      },
      {
        isParent: true,
        id: "_bans",
        label: "Bans / Mutes",
        desc: "Issue and manage player bans and mutes",
        children: [
          {
            id: "bans_create",
            label: "Create Bans / Mutes",
            desc: "Issue new bans and mutes",
          },
          {
            id: "bans_modify",
            label: "Modify Bans / Mutes",
            desc: "Edit existing bans and mutes",
          },
          {
            id: "bans_delete",
            label: "Revoke Bans / Mutes",
            desc: "Delete and revoke existing bans and mutes",
          },
          {
            id: "bans_purge",
            label: "Purge Ban Records",
            desc: "Permanently delete ban records (also removes from BattleMetrics)",
          },
          {
            id: "bans_ip",
            label: "Issue IP Bans",
            desc: "Ban by IP and auto-ban evaders who rejoin (off by default)",
          },
        ],
      },
      {
        isParent: true,
        id: "_discord_mod",
        label: "Discord Moderation",
        desc: "Granular controls for Discord moderation actions and views",
        children: [
          {
            id: "discord_warn",
            label: "Warn via Discord DM",
            desc: "DM a player a warning",
          },
          {
            id: "discord_timeout",
            label: "Timeout / Mute",
            desc: "Timeout, untimeout, mute, and unmute members",
          },
          {
            id: "discord_kick",
            label: "Kick Members",
            desc: "Kick members from the Discord server",
          },
          {
            id: "discord_ban",
            label: "Ban Members",
            desc: "Ban and unban members in Discord",
          },
          {
            id: "discord_delete_messages",
            label: "Delete Messages",
            desc: "Allow deleting a banned user's Discord messages",
          },
          {
            id: "discord_bans_view",
            label: "View Ban List",
            desc: "View and sync the Discord ban list",
          },
          {
            id: "discord_modlog_view",
            label: "View Mod Log",
            desc: "View moderation actions recorded by the panel",
          },
        ],
      },
    ],
  },
  {
    label: "Organization",
    perms: [
      {
        id: "staff_online_view",
        label: "View Online Staff",
        desc: "See who is currently active on the panel (Online Staff popup)",
      },
      {
        id: "org_manage",
        label: "Manage Members",
        desc: "Add, remove, and change member roles below their own",
      },
      {
        id: "role_create",
        label: "Manage Roles",
        desc: "Create, edit, and reorder roles below their own in the hierarchy",
      },
      {
        id: "servers_manage",
        label: "Manage Servers",
        desc: "Add and configure game server connections",
      },
      {
        id: "ticket_types_manage",
        label: "Manage Ticket Types",
        desc: "Enable and disable ticket types for this org",
      },
      {
        id: "predefines_manage",
        label: "Manage Pre-defines",
        desc: "Configure ticket response templates",
      },
      {
        id: "ban_configs_manage",
        label: "Manage Ban Configs",
        desc: "Configure ban and mute reason categories",
      },
      {
        id: "toxicity_manage",
        label: "Manage Toxicity",
        desc: "Configure toxicity word filters",
      },
      {
        id: "triggers_manage",
        label: "Manage Threat Triggers",
        desc: "Configure automated threat trigger rules",
      },
      {
        id: "todo_read",
        label: "View Todos",
        desc: "View the organization todo list",
      },
      {
        id: "todo_write",
        label: "Manage Todos",
        desc: "Create and edit todos",
      },
      {
        id: "todo_delete",
        label: "Delete Todos",
        desc: "Permanently delete todos",
      },
    ],
  },
  {
    label: "Documentation",
    perms: [
      {
        id: "docs_view",
        label: "View Docs",
        desc: "Read the documentation wiki (article visibility gated by minimum role setting)",
      },
      {
        id: "docs_edit",
        label: "Edit Docs",
        desc: "Create, edit, and organize documentation articles and categories",
      },
    ],
  },
];

function PermCheckbox({ checked, onClick, label, desc, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className={
        "flex items-start gap-2.5 px-2 py-1.5 rounded text-left w-full group " +
        (disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-surface/60")
      }
    >
      <span
        className={
          "mt-0.5 size-4 rounded grid place-items-center ring-1 shrink-0 transition-colors " +
          (checked
            ? "bg-brand ring-brand text-brand-foreground"
            : "ring-border text-transparent" +
              (disabled ? "" : " group-hover:ring-brand/40"))
        }
      >
        {checked && (
          <svg viewBox="0 0 10 8" className="size-2.5 fill-none stroke-current">
            <path
              d="M1 4L3.5 6.5L9 1"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium leading-tight">{label}</p>
        <p className="text-[0.625rem] text-muted-foreground leading-tight mt-0.5">
          {desc}
        </p>
      </div>
    </button>
  );
}

function ParentPermCheckbox({
  allChecked,
  someChecked,
  onClick,
  label,
  desc,
  disabled,
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className={
        "flex items-start gap-2.5 px-2 py-1.5 rounded text-left w-full group " +
        (disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-surface/60")
      }
    >
      <span
        className={
          "mt-0.5 size-4 rounded grid place-items-center ring-1 shrink-0 transition-colors " +
          (allChecked
            ? "bg-brand ring-brand text-brand-foreground"
            : someChecked
              ? "bg-brand/20 ring-brand/50 text-brand"
              : "ring-border text-transparent" +
                (disabled ? "" : " group-hover:ring-brand/40"))
        }
      >
        {allChecked && (
          <svg viewBox="0 0 10 8" className="size-2.5 fill-none stroke-current">
            <path
              d="M1 4L3.5 6.5L9 1"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {someChecked && !allChecked && (
          <svg viewBox="0 0 10 2" className="size-2.5 fill-none stroke-current">
            <path d="M2 1H8" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium leading-tight">{label}</p>
        <p className="text-[0.625rem] text-muted-foreground leading-tight mt-0.5">
          {desc}
        </p>
      </div>
    </button>
  );
}

function RolesPage() {
  const {
    sessionUser,
    sessionOrgAdminIds,
    sessionOrgOwnerIds,
    sessionOrgPermissions,
  } = useAuth();
  const orgId = useManageOrgId();

  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ticketTypes, setTicketTypes] = useState([]);
  const [guildRoles, setGuildRoles] = useState([]);
  const [callerDiscordPos, setCallerDiscordPos] = useState(null);
  const [servers, setServers] = useState([]);
  const [newRoleName, setNewRoleName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [callerPosition, setCallerPosition] = useState(null);
  const [reorderingId, setReorderingId] = useState(null);
  const [draftPerms, setDraftPerms] = useState({});
  const [draftTicketTypes, setDraftTicketTypes] = useState({});
  const [draftDiscordRoleIds, setDraftDiscordRoleIds] = useState({});
  const [draftServerAdminAll, setDraftServerAdminAll] = useState({});
  const [draftServerAdminServers, setDraftServerAdminServers] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [saveErr, setSaveErr] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteErr, setDeleteErr] = useState(null);

  const isOwner =
    sessionOrgOwnerIds.includes(orgId ?? "") ||
    Boolean(sessionUser?.isSysAdmin);
  // "Top of hierarchy" = owner, sysadmin, or org admin — sits above every
  // custom role and bypasses the per-permission grant ceiling.
  const isTop = isOwner || sessionOrgAdminIds.includes(orgId ?? "");
  // null position from the API means "top of hierarchy".
  const callerPos =
    callerPosition == null ? Number.POSITIVE_INFINITY : callerPosition;

  const canManageRoles =
    isTop || (sessionOrgPermissions[orgId ?? ""] ?? []).includes("role_create");
  const rank = canManageRoles ? 4 : 0;

  const canGrant = isTop
    ? () => true
    : (permId) => (sessionOrgPermissions[orgId ?? ""] ?? []).includes(permId);

  // A role is editable only when it sits strictly below the caller.
  const canEditRole = (role) =>
    callerPos === Number.POSITIVE_INFINITY || (role.position ?? 0) < callerPos;

  async function loadRoles() {
    if (!orgId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/roles`, {
        credentials: "include",
      });
      if (res.ok) {
        const body = await res.json();
        setRoles(body.roles ?? []);
        setCallerPosition(body.callerPosition ?? null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleReorder(roleId, direction) {
    setReorderingId(roleId);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}/reorder`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ direction }),
        },
      );
      if (res.ok) await loadRoles();
    } finally {
      setReorderingId(null);
    }
  }

  useEffect(() => {
    loadRoles();
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/ticket-types`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => body && setTicketTypes(body.ticketTypes ?? []))
      .catch(() => {});
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/discord-roles`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body) return;
        setGuildRoles(body.discordRoles ?? []);
        setCallerDiscordPos(body.callerDiscordPosition ?? null);
      })
      .catch(() => {});
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/servers`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (body) =>
          body &&
          setServers(
            (body.servers ?? []).filter((s) => s.ownerOrgId === orgId),
          ),
      )
      .catch(() => {});
  }, [orgId]);

  if (!orgId) return null;

  async function handleCreate() {
    const name = newRoleName.trim();
    if (!name) {
      setCreateErr("Role name is required.");
      return;
    }
    setCreating(true);
    setCreateErr(null);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/roles`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleName: name, permissions: [] }),
      });
      const body = await res.json();
      if (!res.ok) {
        setCreateErr(body?.error ?? "Failed to create role.");
        return;
      }
      setNewRoleName("");
      const newRoleId = body.role?.roleId;
      await loadRoles();
      if (newRoleId) {
        setExpandedId(newRoleId);
        setDraftPerms((prev) => ({ ...prev, [newRoleId]: [] }));
        setDraftTicketTypes((prev) => ({ ...prev, [newRoleId]: [] }));
        setDraftDiscordRoleIds((prev) => ({ ...prev, [newRoleId]: [] }));
      }
    } catch {
      setCreateErr("Network error.");
    } finally {
      setCreating(false);
    }
  }

  async function handleSave(roleId) {
    setSavingId(roleId);
    setSaveErr(null);
    try {
      const role = roles.find((r) => r.roleId === roleId);
      const lockedPerms = (role?.permissions ?? []).filter((p) => !canGrant(p));
      const editablePerms = (draftPerms[roleId] ?? []).filter((p) =>
        canGrant(p),
      );
      const permissions = [...editablePerms, ...lockedPerms];
      const ticketTypeIds = draftTicketTypes[roleId] ?? [];
      const discordRoleIds = draftDiscordRoleIds[roleId] ?? [];
      const serverAdminAll =
        draftServerAdminAll[roleId] ?? role?.serverAdminAll ?? false;
      const serverAdminServerIds =
        draftServerAdminServers[roleId] ?? role?.serverAdminServerIds ?? [];
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            permissions,
            ticketTypeIds,
            discordRoleIds,
            serverAdminAll,
            serverAdminServerIds,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSaveErr(body?.error ?? "Failed to save role.");
        return;
      }
      await loadRoles();
    } catch {
      setSaveErr("Network error.");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(roleId) {
    setDeletingId(roleId);
    setDeleteErr(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteErr(body?.error ?? "Failed to delete role.");
        return;
      }
      if (expandedId === roleId) setExpandedId(null);
      await loadRoles();
    } catch {
      setDeleteErr("Network error.");
    } finally {
      setDeletingId(null);
    }
  }

  function toggleExpand(role) {
    const roleId = role.roleId;
    if (expandedId === roleId) {
      setExpandedId(null);
    } else {
      setExpandedId(roleId);
      setDraftPerms((prev) => ({ ...prev, [roleId]: [...role.permissions] }));
      setDraftTicketTypes((prev) => ({
        ...prev,
        [roleId]: [...(role.ticketTypeIds ?? [])],
      }));
      setDraftDiscordRoleIds((prev) => ({
        ...prev,
        [roleId]: [...(role.discordRoleIds ?? [])],
      }));
      setDraftServerAdminAll((prev) => ({
        ...prev,
        [roleId]: !!role.serverAdminAll,
      }));
      setDraftServerAdminServers((prev) => ({
        ...prev,
        [roleId]: [...(role.serverAdminServerIds ?? [])],
      }));
    }
  }

  function toggleServerAdminServer(roleId, serverId) {
    setDraftServerAdminServers((prev) => {
      const cur = prev[roleId] ?? [];
      return {
        ...prev,
        [roleId]: cur.includes(serverId)
          ? cur.filter((s) => s !== serverId)
          : [...cur, serverId],
      };
    });
  }

  function togglePerm(roleId, permId) {
    setDraftPerms((prev) => {
      const cur = prev[roleId] ?? [];
      return {
        ...prev,
        [roleId]: cur.includes(permId)
          ? cur.filter((p) => p !== permId)
          : [...cur, permId],
      };
    });
  }

  function toggleParentPerm(roleId, grantableChildIds, allGrantableChecked) {
    setDraftPerms((prev) => {
      const cur = prev[roleId] ?? [];
      return {
        ...prev,
        [roleId]: allGrantableChecked
          ? cur.filter((p) => !grantableChildIds.includes(p))
          : [...new Set([...cur, ...grantableChildIds])],
      };
    });
  }

  function toggleTicketType(roleId, typeId) {
    setDraftTicketTypes((prev) => {
      const cur = prev[roleId] ?? [];
      return {
        ...prev,
        [roleId]: cur.includes(typeId)
          ? cur.filter((t) => t !== typeId)
          : [...cur, typeId],
      };
    });
  }

  function toggleDiscordRole(roleId, discordRoleId) {
    setDraftDiscordRoleIds((prev) => {
      const cur = prev[roleId] ?? [];
      return {
        ...prev,
        [roleId]: cur.includes(discordRoleId)
          ? cur.filter((id) => id !== discordRoleId)
          : [...cur, discordRoleId],
      };
    });
  }

  return (
    <GateRank rank={rank} required={4}>
      <SectionHeader
        title="Roles"
        blurb="Create custom roles with specific permission sets. Assign roles to staff from the Staff section."
      />

      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <Label className="text-[0.6875rem] font-mono uppercase tracking-widest text-muted-foreground">
          New role
        </Label>
        <div className="flex gap-2">
          <Input
            placeholder="e.g. Moderator, Trial Admin"
            value={newRoleName}
            onChange={(e) => {
              setNewRoleName(e.target.value);
              setCreateErr(null);
            }}
            className="flex-1 text-sm"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <Button size="sm" onClick={handleCreate} disabled={creating}>
            <Plus className="size-3.5 mr-1" />
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
        {createErr && (
          <p className="text-[0.6875rem] text-danger">{createErr}</p>
        )}
      </div>

      <div className="space-y-2">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading roles…</p>
        ) : roles.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No custom roles yet. Create one above.
          </p>
        ) : (
          [...roles]
            .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
            .map((role, idx, arr) => {
              const editable = canEditRole(role);
              const atTop = idx === 0;
              const atBottom = idx === arr.length - 1;
              const isExpanded = editable && expandedId === role.roleId;
              const draft = draftPerms[role.roleId] ?? role.permissions;
              const draftTT =
                draftTicketTypes[role.roleId] ?? role.ticketTypeIds ?? [];
              const draftDR =
                draftDiscordRoleIds[role.roleId] ?? role.discordRoleIds ?? [];
              const draftSAAll =
                draftServerAdminAll[role.roleId] ??
                role.serverAdminAll ??
                false;
              const draftSAServers =
                draftServerAdminServers[role.roleId] ??
                role.serverAdminServerIds ??
                [];
              const isDirty =
                isExpanded &&
                (JSON.stringify([...draft].sort()) !==
                  JSON.stringify([...role.permissions].sort()) ||
                  JSON.stringify([...draftTT].sort((a, b) => a - b)) !==
                    JSON.stringify(
                      [...(role.ticketTypeIds ?? [])].sort((a, b) => a - b),
                    ) ||
                  JSON.stringify([...draftDR].sort()) !==
                    JSON.stringify([...(role.discordRoleIds ?? [])].sort()) ||
                  draftSAAll !== (role.serverAdminAll ?? false) ||
                  JSON.stringify([...draftSAServers].sort()) !==
                    JSON.stringify(
                      [...(role.serverAdminServerIds ?? [])].sort(),
                    ));

              return (
                <div
                  key={role.roleId}
                  className="rounded-md ring-1 ring-border bg-background overflow-hidden"
                >
                  <div className="flex items-center justify-between gap-2 p-2.5">
                    <button
                      className={
                        "flex items-center gap-2 flex-1 min-w-0 text-left " +
                        (editable ? "" : "cursor-default")
                      }
                      onClick={() => editable && toggleExpand(role)}
                      title={
                        editable
                          ? undefined
                          : "This role sits at or above yours in the hierarchy — you can't edit it."
                      }
                    >
                      {!editable ? (
                        <Lock className="size-3.5 text-muted-foreground/60 shrink-0" />
                      ) : isExpanded ? (
                        <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-sm font-medium truncate">
                        {role.roleName}
                      </span>
                      <span className="text-[0.625rem] font-mono text-muted-foreground shrink-0">
                        {role.permissions.length}{" "}
                        {role.permissions.length === 1 ? "perm" : "perms"}
                      </span>
                      {(role.discordRoleIds ?? []).length > 0 && (
                        <span className="text-[0.625rem] font-mono text-[#5865F2] shrink-0">
                          {role.discordRoleIds.length} Discord{" "}
                          {role.discordRoleIds.length === 1 ? "role" : "roles"}
                        </span>
                      )}
                    </button>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isExpanded && isDirty && (
                        <Button
                          size="sm"
                          className="h-7 text-[0.625rem] font-mono uppercase tracking-widest"
                          onClick={() => handleSave(role.roleId)}
                          disabled={savingId === role.roleId}
                        >
                          {savingId === role.roleId ? "Saving…" : "Save"}
                        </Button>
                      )}
                      {deleteErr && expandedId === role.roleId && (
                        <p className="text-[0.6875rem] text-danger">
                          {deleteErr}
                        </p>
                      )}
                      {editable && (
                        <div className="flex flex-col">
                          <button
                            className="text-muted-foreground/50 hover:text-foreground disabled:opacity-25 disabled:hover:text-muted-foreground/50"
                            disabled={atTop || reorderingId === role.roleId}
                            onClick={() => handleReorder(role.roleId, "up")}
                            title="Move up (higher authority)"
                          >
                            <ArrowUp className="size-3" />
                          </button>
                          <button
                            className="text-muted-foreground/50 hover:text-foreground disabled:opacity-25 disabled:hover:text-muted-foreground/50"
                            disabled={atBottom || reorderingId === role.roleId}
                            onClick={() => handleReorder(role.roleId, "down")}
                            title="Move down (lower authority)"
                          >
                            <ArrowDown className="size-3" />
                          </button>
                        </div>
                      )}
                      {editable && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-7 text-danger/60 hover:text-danger hover:bg-danger/10"
                              disabled={deletingId === role.roleId}
                              title="Delete role"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Delete “{role.roleName}”?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                This permanently deletes the role. Any staff
                                currently assigned to it will be reset to Member
                                and lose its permissions. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-danger text-danger-foreground hover:bg-danger/90"
                                onClick={() => handleDelete(role.roleId)}
                              >
                                Delete role
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-border p-3 space-y-4">
                      {PERMISSION_GROUPS.map((group) => (
                        <div key={group.label}>
                          <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">
                            {group.label}
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5">
                            {group.perms.map((perm) => {
                              if (perm.isParent) {
                                const childIds = perm.children.map((c) => c.id);
                                const grantableChildIds = childIds.filter(
                                  (id) => canGrant(id),
                                );
                                const checkedCount = childIds.filter((id) =>
                                  draft.includes(id),
                                ).length;
                                const allChecked =
                                  checkedCount === childIds.length &&
                                  childIds.length > 0;
                                const someChecked =
                                  checkedCount > 0 && !allChecked;
                                const grantableCheckedCount =
                                  grantableChildIds.filter((id) =>
                                    draft.includes(id),
                                  ).length;
                                const allGrantableChecked =
                                  grantableChildIds.length > 0 &&
                                  grantableCheckedCount ===
                                    grantableChildIds.length;
                                const parentDisabled =
                                  grantableChildIds.length === 0;
                                const ticketsActive =
                                  perm.showTicketTypes &&
                                  childIds.some((id) => draft.includes(id));

                                return (
                                  <div key={perm.id} className="col-span-full">
                                    <ParentPermCheckbox
                                      allChecked={allChecked}
                                      someChecked={someChecked}
                                      label={perm.label}
                                      desc={perm.desc}
                                      disabled={parentDisabled}
                                      onClick={() =>
                                        toggleParentPerm(
                                          role.roleId,
                                          grantableChildIds,
                                          allGrantableChecked,
                                        )
                                      }
                                    />
                                    <div className="ml-6 border-l border-border/40 pl-2 mt-0.5 grid grid-cols-1 sm:grid-cols-2 gap-0.5">
                                      {perm.children.map((child) => (
                                        <PermCheckbox
                                          key={child.id}
                                          checked={draft.includes(child.id)}
                                          disabled={!canGrant(child.id)}
                                          onClick={() =>
                                            togglePerm(role.roleId, child.id)
                                          }
                                          label={child.label}
                                          desc={child.desc}
                                        />
                                      ))}
                                    </div>
                                    {ticketsActive &&
                                      ticketTypes.length > 0 && (
                                        <div className="ml-6 border-l border-border/40 pl-2 mt-2">
                                          <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-0.5 px-2">
                                            Ticket type access
                                          </p>
                                          <p className="text-[0.625rem] text-muted-foreground mb-1 px-2">
                                            Restrict to specific types, or keep
                                            "All types" for no restriction.
                                          </p>
                                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5">
                                            <PermCheckbox
                                              checked={draftTT.length === 0}
                                              onClick={() =>
                                                setDraftTicketTypes((prev) => ({
                                                  ...prev,
                                                  [role.roleId]: [],
                                                }))
                                              }
                                              label="All types"
                                              desc="No restriction — can see every ticket type"
                                            />
                                            {ticketTypes.map((tt) => (
                                              <PermCheckbox
                                                key={tt.ticketTypeId}
                                                checked={draftTT.includes(
                                                  tt.ticketTypeId,
                                                )}
                                                onClick={() =>
                                                  toggleTicketType(
                                                    role.roleId,
                                                    tt.ticketTypeId,
                                                  )
                                                }
                                                label={tt.name}
                                                desc={tt.description}
                                              />
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                  </div>
                                );
                              }

                              return (
                                <PermCheckbox
                                  key={perm.id}
                                  checked={draft.includes(perm.id)}
                                  disabled={!canGrant(perm.id)}
                                  onClick={() =>
                                    togglePerm(role.roleId, perm.id)
                                  }
                                  label={perm.label}
                                  desc={perm.desc}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ))}

                      <div>
                        <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">
                          Server Admin (in-game)
                        </p>
                        <PermCheckbox
                          checked={draft.includes("server_admin")}
                          disabled={!canGrant("server_admin")}
                          onClick={() =>
                            togglePerm(role.roleId, "server_admin")
                          }
                          label="Admin on Server"
                          desc="Grant in-game admin via RCON on assignment (moderatorid + usergroup admin); revoked on removal."
                        />
                        {draft.includes("server_admin") && (
                          <div className="ml-6 border-l border-border/40 pl-2 mt-0.5">
                            <PermCheckbox
                              checked={draftSAAll}
                              disabled={!canGrant("server_admin")}
                              onClick={() =>
                                setDraftServerAdminAll((prev) => ({
                                  ...prev,
                                  [role.roleId]: !draftSAAll,
                                }))
                              }
                              label="All servers"
                              desc="Apply to every imported server, including ones added later."
                            />
                            {!draftSAAll &&
                              (servers.length === 0 ? (
                                <p className="text-[0.6875rem] text-muted-foreground italic px-2 py-1">
                                  No servers imported yet.
                                </p>
                              ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5 mt-0.5">
                                  {servers.map((s) => (
                                    <PermCheckbox
                                      key={s.serverId}
                                      checked={draftSAServers.includes(
                                        s.serverId,
                                      )}
                                      disabled={!canGrant("server_admin")}
                                      onClick={() =>
                                        toggleServerAdminServer(
                                          role.roleId,
                                          s.serverId,
                                        )
                                      }
                                      label={s.serverName}
                                      desc={
                                        s.rconConfigured
                                          ? "RCON configured"
                                          : "RCON not configured — grants skipped"
                                      }
                                    />
                                  ))}
                                </div>
                              ))}
                          </div>
                        )}
                      </div>

                      <div>
                        <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">
                          Discord Roles
                        </p>
                        {guildRoles.length === 0 ? (
                          <p className="text-[0.6875rem] text-muted-foreground italic px-2">
                            No Discord roles found. Make sure the bot is in your
                            server and the guild ID is set.
                          </p>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5">
                            {guildRoles
                              .filter(
                                (gr) =>
                                  callerDiscordPos === null ||
                                  (gr.position ?? 0) < callerDiscordPos,
                              )
                              .map((gr) => (
                                <DiscordRoleCheckbox
                                  key={gr.id}
                                  checked={draftDR.includes(gr.id)}
                                  onClick={() =>
                                    toggleDiscordRole(role.roleId, gr.id)
                                  }
                                  name={gr.name}
                                  color={gr.color}
                                />
                              ))}
                          </div>
                        )}
                        <p className="text-[0.625rem] text-muted-foreground mt-1.5 px-2">
                          Members assigned this role will receive these Discord
                          roles. They are removed automatically when staff is
                          removed or reassigned.
                        </p>
                      </div>

                      {isDirty && (
                        <div className="flex flex-col gap-1 pt-1 border-t border-border">
                          {saveErr && expandedId === role.roleId && (
                            <p className="text-[0.6875rem] text-danger">
                              {saveErr}
                            </p>
                          )}
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              onClick={() => handleSave(role.roleId)}
                              disabled={savingId === role.roleId}
                            >
                              {savingId === role.roleId
                                ? "Saving…"
                                : "Save changes"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
        )}
      </div>
    </GateRank>
  );
}

function DiscordRoleCheckbox({ checked, onClick, name, color }) {
  const hex =
    color && color !== 0
      ? `#${color.toString(16).padStart(6, "0")}`
      : undefined;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-surface/60 text-left w-full group"
    >
      <span
        className={
          "size-4 rounded grid place-items-center ring-1 shrink-0 transition-colors " +
          (checked
            ? "bg-[#5865F2] ring-[#5865F2] text-white"
            : "ring-border text-transparent group-hover:ring-[#5865F2]/50")
        }
      >
        {checked && (
          <svg viewBox="0 0 10 8" className="size-2.5 fill-none stroke-current">
            <path
              d="M1 4L3.5 6.5L9 1"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {hex && (
        <span
          className="size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: hex }}
        />
      )}
      <span className="text-xs font-medium truncate">{name}</span>
    </button>
  );
}

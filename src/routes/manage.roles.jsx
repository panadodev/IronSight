import { GateRank, SectionHeader } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
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
        label: "Manage Presets",
        desc: "Manage server plugin presets",
      },
      {
        id: "status_view",
        label: "View Status",
        desc: "View server status and health",
      },
      {
        id: "servers_manage",
        label: "Manage Servers",
        desc: "Add and configure game server connections",
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
            label: "Manage Tickets",
            desc: "Respond to and close support tickets",
          },
        ],
      },
      {
        id: "players_view",
        label: "View Players",
        desc: "Use player lookup and the player list",
      },
      {
        id: "bans_manage",
        label: "Issue Bans / Mutes",
        desc: "Create and edit bans and mutes",
      },
      {
        id: "bans_delete",
        label: "Revoke Bans / Mutes",
        desc: "Delete and revoke existing bans and mutes",
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
        id: "discord_mod",
        label: "Discord Moderation",
        desc: "Use the Discord moderation tools",
      },
    ],
  },
  {
    label: "Organization",
    perms: [
      {
        id: "org_manage",
        label: "Manage Members",
        desc: "Add, remove, and change member roles",
      },
      {
        id: "role_create",
        label: "Manage Roles",
        desc: "Create and configure custom roles",
      },
      {
        id: "predefines_manage",
        label: "Manage Pre-defines",
        desc: "Configure ticket response templates",
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
        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
          {desc}
        </p>
      </div>
    </button>
  );
}

function ParentPermCheckbox({ allChecked, someChecked, onClick, label, desc, disabled }) {
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
        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
          {desc}
        </p>
      </div>
    </button>
  );
}

function RolesPage() {
  const { hasOrgPermission, sessionOrgAdminIds, sessionOrgPermissions } = useAuth();
  const orgId = useManageOrgId();

  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ticketTypes, setTicketTypes] = useState([]);
  const [guildRoles, setGuildRoles] = useState([]);
  const [newRoleName, setNewRoleName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [draftPerms, setDraftPerms] = useState({});
  const [draftTicketTypes, setDraftTicketTypes] = useState({});
  const [draftDiscordRoleIds, setDraftDiscordRoleIds] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const isAdmin = hasOrgPermission(orgId ?? "", "role_create");
  const rank = isAdmin ? 4 : 0;

  const canGrant = sessionOrgAdminIds.includes(orgId ?? "")
    ? () => true
    : (permId) => (sessionOrgPermissions[orgId ?? ""] ?? []).includes(permId);

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
      }
    } finally {
      setLoading(false);
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
      .then((body) => body && setGuildRoles(body.discordRoles ?? []))
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
    try {
      const role = roles.find((r) => r.roleId === roleId);
      const lockedPerms = (role?.permissions ?? []).filter((p) => !canGrant(p));
      const editablePerms = (draftPerms[roleId] ?? []).filter((p) => canGrant(p));
      const permissions = [...editablePerms, ...lockedPerms];
      const ticketTypeIds = draftTicketTypes[roleId] ?? [];
      const discordRoleIds = draftDiscordRoleIds[roleId] ?? [];
      await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissions, ticketTypeIds, discordRoleIds }),
        },
      );
      await loadRoles();
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(roleId) {
    setDeletingId(roleId);
    try {
      await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (expandedId === roleId) setExpandedId(null);
      await loadRoles();
    } finally {
      setDeletingId(null);
    }
  }

  function toggleExpand(roleId, currentPerms, currentTicketTypeIds, currentDiscordRoleIds) {
    if (expandedId === roleId) {
      setExpandedId(null);
    } else {
      setExpandedId(roleId);
      setDraftPerms((prev) => ({ ...prev, [roleId]: [...currentPerms] }));
      setDraftTicketTypes((prev) => ({
        ...prev,
        [roleId]: [...currentTicketTypeIds],
      }));
      setDraftDiscordRoleIds((prev) => ({
        ...prev,
        [roleId]: [...currentDiscordRoleIds],
      }));
    }
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
        <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
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
        {createErr && <p className="text-[11px] text-danger">{createErr}</p>}
      </div>

      <div className="space-y-2">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading roles…</p>
        ) : roles.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No custom roles yet. Create one above.
          </p>
        ) : (
          roles.map((role) => {
            const isExpanded = expandedId === role.roleId;
            const draft = draftPerms[role.roleId] ?? role.permissions;
            const draftTT =
              draftTicketTypes[role.roleId] ?? role.ticketTypeIds ?? [];
            const draftDR =
              draftDiscordRoleIds[role.roleId] ?? role.discordRoleIds ?? [];
            const isDirty =
              isExpanded &&
              (JSON.stringify([...draft].sort()) !==
                JSON.stringify([...role.permissions].sort()) ||
                JSON.stringify([...draftTT].sort((a, b) => a - b)) !==
                  JSON.stringify(
                    [...(role.ticketTypeIds ?? [])].sort((a, b) => a - b),
                  ) ||
                JSON.stringify([...draftDR].sort()) !==
                  JSON.stringify([...(role.discordRoleIds ?? [])].sort()));

            return (
              <div
                key={role.roleId}
                className="rounded-md ring-1 ring-border bg-background overflow-hidden"
              >
                <div className="flex items-center justify-between gap-2 p-2.5">
                  <button
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    onClick={() =>
                      toggleExpand(
                        role.roleId,
                        role.permissions,
                        role.ticketTypeIds ?? [],
                        role.discordRoleIds ?? [],
                      )
                    }
                  >
                    {isExpanded ? (
                      <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-sm font-medium truncate">
                      {role.roleName}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                      {role.permissions.length}{" "}
                      {role.permissions.length === 1 ? "perm" : "perms"}
                    </span>
                    {(role.discordRoleIds ?? []).length > 0 && (
                      <span className="text-[10px] font-mono text-[#5865F2] shrink-0">
                        {role.discordRoleIds.length} Discord{" "}
                        {role.discordRoleIds.length === 1 ? "role" : "roles"}
                      </span>
                    )}
                  </button>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {isExpanded && isDirty && (
                      <Button
                        size="sm"
                        className="h-7 text-[10px] font-mono uppercase tracking-widest"
                        onClick={() => handleSave(role.roleId)}
                        disabled={savingId === role.roleId}
                      >
                        {savingId === role.roleId ? "Saving…" : "Save"}
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-danger/60 hover:text-danger hover:bg-danger/10"
                      disabled={deletingId === role.roleId}
                      onClick={() => handleDelete(role.roleId)}
                      title="Delete role"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border p-3 space-y-4">
                    {PERMISSION_GROUPS.map((group) => (
                      <div key={group.label}>
                        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">
                          {group.label}
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5">
                          {group.perms.map((perm) => {
                            if (perm.isParent) {
                              const childIds = perm.children.map((c) => c.id);
                              const grantableChildIds = childIds.filter((id) => canGrant(id));
                              const checkedCount = childIds.filter((id) =>
                                draft.includes(id),
                              ).length;
                              const allChecked =
                                checkedCount === childIds.length &&
                                childIds.length > 0;
                              const someChecked =
                                checkedCount > 0 && !allChecked;
                              const grantableCheckedCount = grantableChildIds.filter((id) =>
                                draft.includes(id),
                              ).length;
                              const allGrantableChecked =
                                grantableChildIds.length > 0 &&
                                grantableCheckedCount === grantableChildIds.length;
                              const parentDisabled = grantableChildIds.length === 0;
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
                                  {ticketsActive && ticketTypes.length > 0 && (
                                    <div className="ml-6 border-l border-border/40 pl-2 mt-2">
                                      <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-0.5 px-2">
                                        Ticket type access
                                      </p>
                                      <p className="text-[10px] text-muted-foreground mb-1 px-2">
                                        Restrict to specific types, or keep "All types" for no restriction.
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
                                onClick={() => togglePerm(role.roleId, perm.id)}
                                label={perm.label}
                                desc={perm.desc}
                              />
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    <div>
                      <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">
                        Discord Roles
                      </p>
                      {guildRoles.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground italic px-2">
                          No Discord roles found. Make sure the bot is in your
                          server and the guild ID is set.
                        </p>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5">
                          {guildRoles.map((gr) => (
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
                      <p className="text-[10px] text-muted-foreground mt-1.5 px-2">
                        Members assigned this role will receive these Discord
                        roles. They are removed automatically when staff is
                        removed or reassigned.
                      </p>
                    </div>

                    {isDirty && (
                      <div className="flex justify-end pt-1 border-t border-border">
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

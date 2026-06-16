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
        id: "tickets_view",
        label: "View Tickets",
        desc: "View support tickets",
      },
      {
        id: "tickets_manage",
        label: "Manage Tickets",
        desc: "Respond to and close support tickets",
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

function PermCheckbox({ checked, onClick, label, desc }) {
  return (
    <button
      onClick={onClick}
      className="flex items-start gap-2.5 px-2 py-1.5 rounded hover:bg-surface/60 text-left w-full group"
    >
      <span
        className={
          "mt-0.5 size-4 rounded grid place-items-center ring-1 shrink-0 transition-colors " +
          (checked
            ? "bg-brand ring-brand text-brand-foreground"
            : "ring-border text-transparent group-hover:ring-brand/40")
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

function RolesPage() {
  const { sessionOrgAdminIds } = useAuth();
  const orgId = useManageOrgId();

  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [draftPerms, setDraftPerms] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const isAdmin = sessionOrgAdminIds.includes(orgId ?? "");
  const rank = isAdmin ? 4 : 0;

  async function loadRoles() {
    if (!orgId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/roles`,
        { credentials: "include" },
      );
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
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/roles`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roleName: name, permissions: [] }),
        },
      );
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
      const permissions = draftPerms[roleId] ?? [];
      await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissions }),
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

  function toggleExpand(roleId, currentPerms) {
    if (expandedId === roleId) {
      setExpandedId(null);
    } else {
      setExpandedId(roleId);
      setDraftPerms((prev) => ({ ...prev, [roleId]: [...currentPerms] }));
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
        {createErr && (
          <p className="text-[11px] text-danger">{createErr}</p>
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
          roles.map((role) => {
            const isExpanded = expandedId === role.roleId;
            const draft = draftPerms[role.roleId] ?? role.permissions;
            const isDirty =
              isExpanded &&
              JSON.stringify([...draft].sort()) !==
                JSON.stringify([...role.permissions].sort());

            return (
              <div
                key={role.roleId}
                className="rounded-md ring-1 ring-border bg-background overflow-hidden"
              >
                <div className="flex items-center justify-between gap-2 p-2.5">
                  <button
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    onClick={() => toggleExpand(role.roleId, role.permissions)}
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
                          {group.perms.map((perm) => (
                            <PermCheckbox
                              key={perm.id}
                              checked={draft.includes(perm.id)}
                              onClick={() => togglePerm(role.roleId, perm.id)}
                              label={perm.label}
                              desc={perm.desc}
                            />
                          ))}
                        </div>
                      </div>
                    ))}

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

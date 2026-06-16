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
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, Crown, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/manage/staff")({
  component: StaffPage,
});

function roleLabel(roleId, customRoles) {
  if (roleId === "org_owner") return "Owner";
  if (roleId === "org_admin") return "Admin";
  if (roleId === "org_member") return "Member";
  return customRoles.find((r) => r.roleId === roleId)?.roleName ?? roleId;
}

function StaffPage() {
  const { sessionOrgAdminIds, sessionOrgOwnerIds, sessionUser } = useAuth();
  const orgId = useManageOrgId();

  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [customRoles, setCustomRoles] = useState([]);
  const [discordId, setDiscordId] = useState("");
  const [addErr, setAddErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [removeErr, setRemoveErr] = useState(null);
  const [changingRoleId, setChangingRoleId] = useState(null);

  if (!orgId) return null;

  const isAdmin = sessionOrgAdminIds.includes(orgId);
  const isOwner = sessionOrgOwnerIds.includes(orgId);

  async function loadMembers() {
    setMembersLoading(true);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
        credentials: "include",
      });
      if (res.ok) {
        const body = await res.json();
        setMembers(body.members ?? []);
      }
    } finally {
      setMembersLoading(false);
    }
  }

  async function loadCustomRoles() {
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

  useEffect(() => {
    if (!orgId) return;
    loadMembers();
    loadCustomRoles();
  }, [orgId]);

  async function handleAdd() {
    const id = discordId.trim();
    if (!id) {
      setAddErr("Discord ID is required.");
      return;
    }
    setAdding(true);
    setAddErr(null);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discordId: id }),
      });
      const body = await res.json();
      if (!res.ok) {
        setAddErr(body?.error ?? "Failed to add member.");
        return;
      }
      setDiscordId("");
      await loadMembers();
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
    } catch {
      setRemoveErr("Network error.");
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRoleChange(userId, newRole) {
    setChangingRoleId(userId);
    try {
      await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ team: newRole }),
        },
      );
      await loadMembers();
    } finally {
      setChangingRoleId(null);
    }
  }

  const rank = isAdmin ? 4 : 0;

  return (
    <GateRank rank={rank} required={4}>
      <SectionHeader
        title="Staff"
        blurb="Add, remove, or change roles for staff members."
      />

      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
          Add staff member
        </Label>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Discord ID (e.g. 123456789012345678)"
            value={discordId}
            onChange={(e) => {
              setDiscordId(e.target.value);
              setAddErr(null);
            }}
            className="flex-1 min-w-[240px] font-mono text-sm"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button size="sm" onClick={handleAdd} disabled={adding}>
            <UserPlus className="size-3.5 mr-1" />
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Staff are added by Discord ID. They will be prompted to link Steam on
          first login if not already linked.
        </p>
        {addErr && <p className="text-[11px] text-danger">{addErr}</p>}
      </div>

      {removeErr && (
        <p className="text-[11px] text-danger px-1">{removeErr}</p>
      )}

      <div className="space-y-1.5">
        {membersLoading ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : members.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No members yet.</p>
        ) : (
          members.map((m) => {
            const isOwnerRow = m.roleId === "org_owner";
            const isMe = sessionUser?.userId === m.userId;
            const isChangingRole = changingRoleId === m.userId;
            // Admins can only interact with non-owner rows
            const canActOnRow = isOwner || !isOwnerRow;
            const canChangeRole = !isMe && canActOnRow;
            const canRemove = !isMe && (isOwner || !isOwnerRow);

            return (
              <div
                key={m.userId}
                className="flex items-center justify-between gap-2 bg-background ring-1 ring-border rounded-md p-2.5"
              >
                {/* Identity */}
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="size-8 rounded bg-brand/20 text-brand text-[11px] font-mono font-bold grid place-items-center shrink-0 uppercase">
                    {(m.username ?? "?")[0]}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate flex items-center gap-1.5">
                      {m.username ?? "Unknown"}
                      {isOwnerRow && (
                        <Crown
                          className="size-3 text-brand shrink-0"
                          title="Organization owner"
                        />
                      )}
                      {m.roleId === "org_admin" && (
                        <ShieldCheck
                          className="size-3 text-muted-foreground shrink-0"
                          title="Admin"
                        />
                      )}
                      {isMe && (
                        <span className="text-[9px] font-mono uppercase tracking-widest text-brand bg-brand/10 px-1 py-0.5 rounded">
                          You
                        </span>
                      )}
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                      {m.discordId ? (
                        <span className="text-[9px] font-mono text-muted-foreground bg-[#5865f2]/10 text-[#7289da] px-1.5 py-0.5 rounded">
                          Discord linked
                        </span>
                      ) : (
                        <span className="text-[9px] font-mono text-danger/80 bg-danger/10 px-1.5 py-0.5 rounded">
                          No Discord
                        </span>
                      )}
                      {m.steamId ? (
                        <span className="text-[9px] font-mono text-[#66c0f4] bg-[#66c0f4]/10 px-1.5 py-0.5 rounded">
                          Steam linked
                        </span>
                      ) : (
                        <span className="text-[9px] font-mono text-warning/80 bg-warning/10 px-1.5 py-0.5 rounded">
                          No Steam · cannot use moderation
                        </span>
                      )}
                      <span className="text-[9px] font-mono text-muted-foreground/50">
                        {roleLabel(m.roleId, customRoles)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
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
          </>
        ) : (
          <>
            {/* Admin: current role shown if it's an elevated built-in (display-only) */}
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
          </>
        )}
      </SelectContent>
    </Select>
  );
}

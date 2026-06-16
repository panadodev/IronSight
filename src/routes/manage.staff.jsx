import { GateRank, SectionHeader } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, Crown, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/manage/staff")({
  component: StaffPage,
});

function StaffPage() {
  const { sessionOrgAdminIds, sessionUser } = useAuth();
  const orgId = useManageOrgId();

  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [discordId, setDiscordId] = useState("");
  const [addErr, setAddErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [changingRoleId, setChangingRoleId] = useState(null);

  if (!orgId) return null;

  const isAdmin = sessionOrgAdminIds.includes(orgId);

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

  useEffect(() => {
    if (!orgId) return;
    loadMembers();
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
    try {
      await fetch(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      await loadMembers();
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRoleChange(userId, newRole) {
    setChangingRoleId(userId);
    try {
      await fetch(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ team: newRole }),
      });
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
          Staff are added by Discord ID. They will be prompted to link Steam on first login if not already linked.
        </p>
        {addErr && <p className="text-[11px] text-danger">{addErr}</p>}
      </div>

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
                        <Crown className="size-3 text-brand shrink-0" title="Organization owner" />
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
                        {m.roleId === "org_owner" ? "Owner" : m.roleId === "org_admin" ? "Admin" : "Member"}
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
                    <Link to="/staff-audit" search={{ staff: m.userId, org: orgId, name: m.username ?? undefined }}>
                      <Activity className="size-3" />
                      Audit
                    </Link>
                  </Button>

                  {!isMe && (
                    <select
                      value={m.roleId}
                      disabled={isChangingRole}
                      onChange={(e) => handleRoleChange(m.userId, e.target.value)}
                      className="bg-surface border border-border rounded px-2 py-1 text-[11px] font-mono disabled:opacity-50 h-7"
                      title="Change role"
                    >
                      <option value="org_member">Member</option>
                      <option value="org_admin">Admin</option>
                      <option value="org_owner">Owner</option>
                    </select>
                  )}

                  {!isOwnerRow && !isMe && (
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
    </GateRank>
  );
}

import { SiteNav } from "@/components/site-nav";
import { Badge } from "@/components/ui/badge";
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
import { createFileRoute, Link } from "@tanstack/react-router";
import {
    Building2,
    ClipboardList,
    Key,
    Trash2,
    UserCog,
    UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/view-org")({
  head: () => ({ meta: [{ title: "Staff - IronSight" }] }),
  component: ViewOrgPage,
});

function redirectToLogin() {
  window.location.assign(
    `/login?next=${encodeURIComponent(window.location.pathname)}`,
  );
}

function authFetch(url, init) {
  return fetch(url, init).then((res) => {
    if (res.status === 401) {
      redirectToLogin();
      const err = new Error("Session expired");
      err.code = "AUTH_EXPIRED";
      throw err;
    }
    return res;
  });
}

function isAuthExpired(error) {
  return error?.code === "AUTH_EXPIRED";
}

function ViewOrgPage() {
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [pageNotice, setPageNotice] = useState("");
  const [sessionUser, setSessionUser] = useState(null);
  const [globalAdmin, setGlobalAdmin] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [members, setMembers] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");

  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberIdentifier, setNewMemberIdentifier] = useState("");
  const [newTeam, setNewTeam] = useState("org_member");
  const [isAdding, setIsAdding] = useState(false);
  const [actionInProgress, setActionInProgress] = useState(new Set());
  const [memberTeams, setMemberTeams] = useState(new Map());
  const [impersonateModalOpen, setImpersonateModalOpen] = useState(false);
  const [impersonateTarget, setImpersonateTarget] = useState(null);
  const [orgMemberRoles, setOrgMemberRoles] = useState(new Map()); // userId → roleId
  const [customRoles, setCustomRoles] = useState([]);

  async function fetchBootstrap() {
    setLoading(true);
    setPageError("");

    try {
      const res = await authFetch("/api/todo/bootstrap");
      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to load organization data.");
        setLoading(false);
        return;
      }

      const data = await res.json();
      setSessionUser(data.user ?? null);
      setGlobalAdmin(Boolean(data.globalAdmin));
      setOrgs(data.orgs ?? []);
      setMembers(data.members ?? []);
      setSelectedOrgId((current) => current || data.orgs?.[0]?.orgId || "");
      setLoading(false);
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to load organization data.");
      setLoading(false);
    }
  }

  async function fetchOrgMemberRoles(orgId) {
    if (!orgId) return;
    try {
      const res = await authFetch(`/api/orgs/${orgId}/members`);
      if (!res.ok) return;
      const data = await res.json();
      const roleMap = new Map();
      for (const m of data.members ?? []) {
        if (m.userId) roleMap.set(m.userId, m.roleId);
      }
      setOrgMemberRoles(roleMap);
      setMemberTeams(new Map()); // clear pending overrides
    } catch {
      // non-fatal
    }
  }

  async function fetchCustomRoles(orgId) {
    if (!orgId) return;
    try {
      const res = await authFetch(`/api/orgs/${orgId}/roles`);
      if (!res.ok) return;
      const data = await res.json();
      setCustomRoles(data.roles ?? []);
    } catch {
      // non-fatal
    }
  }

  useEffect(() => {
    fetchBootstrap().catch((error) => {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to load organization data.");
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (selectedOrgId) {
      fetchOrgMemberRoles(selectedOrgId);
      fetchCustomRoles(selectedOrgId);
    }
  }, [selectedOrgId]);

  const memberMap = useMemo(() => {
    const map = new Map();
    for (const member of members) {
      if (member.discordId) map.set(member.discordId, member);
    }
    return map;
  }, [members]);

  const selectedOrg = useMemo(
    () => orgs.find((org) => org.orgId === selectedOrgId) ?? null,
    [orgs, selectedOrgId],
  );

  const orgMembers = useMemo(() => {
    if (!selectedOrg) return [];
    return selectedOrg.discordIds.map((discordId) => {
      const member = memberMap.get(discordId);
      if (member) return member;
      return {
        userId: null,
        username: `user_${discordId.slice(-6)}`,
        discordId,
        steamId: null,
      };
    });
  }, [selectedOrg, memberMap]);

  const canManageSelectedOrg = useMemo(() => {
    if (!sessionUser || !selectedOrgId) return false;
    return Boolean(
      globalAdmin || sessionUser.orgAdminOrgIds?.includes(selectedOrgId),
    );
  }, [sessionUser, globalAdmin, selectedOrgId]);

  const isOwner = useMemo(
    () => globalAdmin || Boolean(sessionUser?.orgOwnerOrgIds?.includes(selectedOrgId)),
    [globalAdmin, sessionUser, selectedOrgId],
  );

  async function handleAddMember(event) {
    event.preventDefault();
    if (!selectedOrgId || !canManageSelectedOrg) return;

    const identifier = newMemberIdentifier.trim();
    if (!identifier) {
      setPageError("Discord ID is required.");
      setPageNotice("");
      return;
    }
    const isSteam = identifier.startsWith("76561198");
    if (isSteam) {
      setPageError("Adding by Steam ID is not available yet on this page.");
      setPageNotice("Use a Discord ID for now. Steam ID support is WIP.");
      return;
    }

    setIsAdding(true);
    setPageError("");
    setPageNotice("");

    try {
      const res = await authFetch(`/api/orgs/${selectedOrgId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          discordId: identifier,
          username: newMemberName.trim() || undefined,
          team: newTeam,
        }),
      });

      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to add member.");
        return;
      }

      setNewMemberName("");
      setNewMemberIdentifier("");
      setNewTeam("org_member");
      await fetchBootstrap();
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to add member.");
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemoveMember(memberId) {
    if (!selectedOrgId || !canManageSelectedOrg) return;
    if (!confirm(`Remove this member from the organization?`)) return;

    setActionInProgress((prev) => new Set([...prev, `remove-${memberId}`]));
    setPageError("");

    try {
      const res = await authFetch(`/api/orgs/${selectedOrgId}/members/${memberId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to remove member.");
        setActionInProgress((prev) => {
          const next = new Set(prev);
          next.delete(`remove-${memberId}`);
          return next;
        });
        return;
      }

      await fetchBootstrap();
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to remove member.");
      setActionInProgress((prev) => {
        const next = new Set(prev);
        next.delete(`remove-${memberId}`);
        return next;
      });
    }
  }

  async function handleChangeTeam(memberId, newTeamValue) {
    if (!selectedOrgId || !canManageSelectedOrg) return;

    setMemberTeams((prev) => new Map(prev).set(memberId, newTeamValue));
    setActionInProgress((prev) => new Set([...prev, `team-${memberId}`]));
    setPageError("");

    try {
      const res = await authFetch(`/api/orgs/${selectedOrgId}/members/${memberId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ team: newTeamValue }),
      });

      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to change team.");
        setMemberTeams((prev) => {
          const next = new Map(prev);
          next.delete(memberId);
          return next;
        });
      } else {
        await fetchBootstrap();
        await fetchOrgMemberRoles(selectedOrgId);
      }
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to change team.");
      setMemberTeams((prev) => {
        const next = new Map(prev);
        next.delete(memberId);
        return next;
      });
    } finally {
      setActionInProgress((prev) => {
        const next = new Set(prev);
        next.delete(`team-${memberId}`);
        return next;
      });
    }
  }

  async function handleImpersonate(memberId) {
    if (!selectedOrgId || !canManageSelectedOrg) return;

    setActionInProgress((prev) => new Set([...prev, `impersonate-${memberId}`]));
    setPageError("");

    try {
      const res = await authFetch(
        `/api/orgs/${selectedOrgId}/members/${memberId}/impersonate`,
        { method: "POST", credentials: "include" },
      );

      const result = await safeJson(res);

      if (!res.ok || !result?.ok) {
        setPageError(result?.error ?? "Failed to load member data.");
        return;
      }

      setImpersonateTarget(result);
      setImpersonateModalOpen(true);
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to view member data.");
    } finally {
      setActionInProgress((prev) => {
        const next = new Set(prev);
        next.delete(`impersonate-${memberId}`);
        return next;
      });
    }
  }

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
          <header className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold">Staff</h1>
              <p className="text-sm text-muted-foreground">
                Manage organization members and access.
              </p>
            </div>
          </header>

          {pageError ? (
            <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {pageError}
            </div>
          ) : null}

          {pageNotice ? (
            <div className="rounded-md ring-1 ring-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {pageNotice}
            </div>
          ) : null}

          {loading ? (
            <div className="rounded-md ring-1 ring-border bg-surface/40 p-4 text-sm">
              Loading...
            </div>
          ) : null}

          <ImpersonateModal
            open={impersonateModalOpen}
            data={impersonateTarget}
            onClose={() => {
              setImpersonateModalOpen(false);
              setImpersonateTarget(null);
            }}
          />

          {!loading ? (
            <section className="rounded-lg ring-1 ring-border bg-surface/30 p-4 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-sm font-semibold">Manage staff</h2>
                  <p className="text-[11px] text-muted-foreground">
                    Add, review, and manage members in this organization.
                  </p>
                </div>
                <div className="w-full sm:w-auto sm:min-w-[260px]">
                  <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground mb-1 block">
                    <Building2 className="inline size-3 mr-1" /> Organization
                  </Label>
                  <select
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                    value={selectedOrgId}
                    onChange={(e) => setSelectedOrgId(e.target.value)}
                  >
                    {orgs.map((org) => (
                      <option key={org.orgId} value={org.orgId}>
                        {org.name ?? org.orgId}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
                <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
                  Add staff
                </Label>
                <form
                  onSubmit={handleAddMember}
                  className="flex flex-wrap items-end gap-2"
                >
                  <div className="space-y-1 min-w-[180px]">
                    <Label htmlFor="new-member-name" className="text-[11px]">
                      Name (optional)
                    </Label>
                    <Input
                      id="new-member-name"
                      value={newMemberName}
                      onChange={(e) => {
                        setNewMemberName(e.target.value);
                        setPageError("");
                      }}
                      placeholder="OlathVlos"
                      disabled={!canManageSelectedOrg || isAdding}
                    />
                  </div>
                  <div className="space-y-1 min-w-[240px] flex-1">
                    <Label
                      htmlFor="new-member-identifier"
                      className="text-[11px]"
                    >
                      Discord ID or Steam ID
                    </Label>
                    <Input
                      id="new-member-identifier"
                      value={newMemberIdentifier}
                      onChange={(e) => {
                        setNewMemberIdentifier(e.target.value);
                        setPageError("");
                        setPageNotice("");
                      }}
                      placeholder="olath#0001 or 76561199084351346"
                      disabled={!canManageSelectedOrg || isAdding}
                    />
                  </div>
                  <div className="space-y-1 min-w-[140px]">
                    <Label className="text-[11px]">Role</Label>
                    <select
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs"
                      value={newTeam}
                      onChange={(e) => setNewTeam(e.target.value)}
                      disabled={!canManageSelectedOrg || isAdding}
                    >
                      <option value="org_member">Member</option>
                      <option value="org_admin">Admin</option>
                      {isOwner && <option value="org_owner">Owner</option>}
                      {customRoles.map((r) => (
                        <option key={r.roleId} value={r.roleId}>
                          {r.roleName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="submit"
                    disabled={!canManageSelectedOrg || isAdding}
                    className="h-9"
                  >
                    <UserPlus className="size-3.5 mr-1" />
                    {isAdding ? "Adding..." : "Add"}
                  </Button>
                </form>
                <p className="text-[11px] text-muted-foreground">
                  Steam ID adds are currently WIP for this API-backed page.
                </p>
                {!canManageSelectedOrg ? (
                  <p className="text-xs text-muted-foreground">
                    You need org admin or global admin permissions to add
                    members.
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                {orgMembers.map((member) => {
                  const displayName =
                    member.username ||
                    `user_${String(member.discordId || "").slice(-6)}`;
                  const avatar = displayName.slice(0, 1).toUpperCase() || "?";
                  const hasUserId = Boolean(member.userId);
                  // Pending local override takes priority, then server role, then fallback
                  const currentRole =
                    memberTeams.get(member.userId) ||
                    orgMemberRoles.get(member.userId) ||
                    "org_member";
                  const isOwnerRow = hasUserId && orgMemberRoles.get(member.userId) === "org_owner";
                  const canActOnRow = isOwner || !isOwnerRow;
                  return (
                    <div
                      key={member.discordId}
                      className="flex items-center justify-between gap-2 bg-background ring-1 ring-border rounded-md p-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="size-7 rounded bg-brand/20 text-brand text-[10px] font-mono font-bold grid place-items-center shrink-0">
                          {avatar}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {displayName}
                          </p>
                          <p className="text-[10px] font-mono text-muted-foreground truncate">
                            {member.steamId ? `steam:${member.steamId}` : ""}
                            {member.steamId && member.discordId ? " · " : ""}
                            {member.discordId
                              ? `discord:${member.discordId}`
                              : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Link
                          to={`/staff-audit?staff=${encodeURIComponent(member.userId || member.discordId || "")}`}
                          className="inline-flex items-center justify-center h-7 px-2 text-[10px] font-mono uppercase tracking-widest gap-1 rounded-md border border-border bg-background hover:bg-surface"
                        >
                          <ClipboardList className="size-3" />
                          Audit
                        </Link>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleImpersonate(member.userId)}
                          disabled={!canManageSelectedOrg || !hasUserId || actionInProgress.has(`impersonate-${member.userId}`)}
                          className="h-7 px-2 text-[10px] font-mono uppercase tracking-widest gap-1"
                          title={!hasUserId ? "Member not yet in the system" : undefined}
                        >
                          <UserCog className="size-3" />
                          {actionInProgress.has(`impersonate-${member.userId}`)
                            ? "Impersonating..."
                            : "Impersonate"}
                        </Button>
                        <select
                          value={currentRole}
                          onChange={(e) => handleChangeTeam(member.userId, e.target.value)}
                          disabled={!canManageSelectedOrg || !hasUserId || !canActOnRow || actionInProgress.has(`team-${member.userId}`)}
                          className="bg-surface border border-border rounded px-2 py-1 text-[11px] font-mono disabled:opacity-50"
                        >
                          <option value="org_member">Member</option>
                          <option value="org_admin">Admin</option>
                          {isOwner && <option value="org_owner">Owner</option>}
                          {customRoles.map((r) => (
                            <option key={r.roleId} value={r.roleId}>
                              {r.roleName}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleRemoveMember(member.userId)}
                          disabled={!canManageSelectedOrg || !hasUserId || actionInProgress.has(`remove-${member.userId}`)}
                          className="size-7"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {!orgMembers.length ? (
                  <p className="text-xs text-muted-foreground italic">
                    No members yet.
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function roleLabel(roleId) {
  if (roleId === "org_owner") return "Owner";
  if (roleId === "org_admin") return "Admin";
  if (roleId === "org_member") return "Member";
  return roleId;
}

const PERMISSION_LABELS = {
  org_manage: "Manage Members",
  role_create: "Manage Roles",
  todo_write: "Write Todos",
};

function ImpersonateModal({ open, data, onClose }) {
  if (!data) return null;
  const { member, access } = data;
  const permissions = access?.permissions ?? [];
  const canWrite = access?.canWrite ?? false;
  const managedOrgs = access?.orgAdminOrgIds ?? [];

  const allPerms = Array.from(
    new Set([
      ...permissions,
      ...(canWrite && !permissions.includes("todo_write") ? ["todo_write"] : []),
    ]),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog className="size-4 text-brand" />
            Member view — {member?.username}
          </DialogTitle>
          <DialogDescription>
            Read-only snapshot of this member's identity and permissions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Identity */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Identity
            </p>
            <div className="rounded-md ring-1 ring-border bg-surface/40 px-3 py-2.5 space-y-1.5 text-xs font-mono">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Username</span>
                <span className="font-semibold">{member?.username ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Role</span>
                <Badge variant="outline" className="text-[9px] font-mono h-4 px-1.5">
                  {roleLabel(member?.roleId)}
                </Badge>
              </div>
              {member?.steamId && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Steam</span>
                  <span className="text-brand truncate max-w-[200px]">{member.steamId}</span>
                </div>
              )}
              {member?.discordId && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Discord</span>
                  <span className="text-brand truncate max-w-[200px]">{member.discordId}</span>
                </div>
              )}
            </div>
          </div>

          {/* Permissions */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1">
              <Key className="size-3" /> Permissions
            </p>
            {allPerms.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No explicit permissions.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {allPerms.map((p) => (
                  <Badge
                    key={p}
                    variant="outline"
                    className="text-[9px] font-mono h-4 px-1.5 border-brand/40 text-brand bg-brand/5"
                  >
                    {PERMISSION_LABELS[p] ?? p}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Org admin access */}
          {managedOrgs.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Manages orgs
              </p>
              <div className="flex flex-wrap gap-1.5">
                {managedOrgs.map((id) => (
                  <Badge
                    key={id}
                    variant="outline"
                    className="text-[9px] font-mono h-4 px-1.5"
                  >
                    {id}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

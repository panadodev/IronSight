import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/view-org")({
  head: () => ({ meta: [{ title: "Staff - IronSight" }] }),
  component: ViewOrgPage
});

function redirectToLogin() {
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
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
  const [sessionUser, setSessionUser] = useState(null);
  const [globalAdmin, setGlobalAdmin] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [members, setMembers] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");

  const [newMemberDiscordId, setNewMemberDiscordId] = useState("");
  const [isAdding, setIsAdding] = useState(false);

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

  useEffect(() => {
    fetchBootstrap().catch((error) => {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to load organization data.");
      setLoading(false);
    });
  }, []);

  const memberMap = useMemo(() => {
    const map = new Map();
    for (const member of members) {
      if (member.discordId) map.set(member.discordId, member);
    }
    return map;
  }, [members]);

  const selectedOrg = useMemo(
    () => orgs.find((org) => org.orgId === selectedOrgId) ?? null,
    [orgs, selectedOrgId]
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
        steamId: null
      };
    });
  }, [selectedOrg, memberMap]);

  const canManageSelectedOrg = useMemo(() => {
    if (!sessionUser || !selectedOrgId) return false;
    return Boolean(globalAdmin || sessionUser.orgAdminOrgIds?.includes(selectedOrgId));
  }, [sessionUser, globalAdmin, selectedOrgId]);

  async function handleAddMember(event) {
    event.preventDefault();
    if (!selectedOrgId || !canManageSelectedOrg) return;

    const discordId = newMemberDiscordId.trim();
    if (!discordId) {
      setPageError("Discord ID is required.");
      return;
    }

    setIsAdding(true);
    setPageError("");

    try {
      const res = await authFetch(`/api/orgs/${selectedOrgId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discordId })
      });

      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to add member.");
        return;
      }

      setNewMemberDiscordId("");
      await fetchBootstrap();
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to add member.");
    } finally {
      setIsAdding(false);
    }
  }

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
          <header className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold">Staff</h1>
              <p className="text-sm text-muted-foreground">
                Manage organization members and access by Discord identity.
              </p>
            </div>
          </header>

          {pageError ? (
            <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {pageError}
            </div>
          ) : null}

          {loading ? <div className="rounded-md ring-1 ring-border bg-surface/40 p-4 text-sm">Loading...</div> : null}

          {!loading ? (
            <section className="rounded-md ring-1 ring-border bg-surface/40 p-4 space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1 min-w-[220px]">
                  <Label>Organization</Label>
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

                <form onSubmit={handleAddMember} className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1 min-w-[240px]">
                    <Label htmlFor="new-discord-id">Add member (Discord ID)</Label>
                    <Input
                      id="new-discord-id"
                      value={newMemberDiscordId}
                      onChange={(e) => setNewMemberDiscordId(e.target.value)}
                      placeholder="476047124694433822"
                      disabled={!canManageSelectedOrg || isAdding}
                    />
                  </div>
                  <Button type="submit" disabled={!canManageSelectedOrg || isAdding}>
                    {isAdding ? "Adding..." : "Add member"}
                  </Button>
                </form>
              </div>

              {!canManageSelectedOrg ? (
                <p className="text-xs text-muted-foreground">
                  You need org admin or global admin permissions to add members.
                </p>
              ) : null}

              <div className="rounded-md ring-1 ring-border bg-background/50 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-surface/60">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Username</th>
                      <th className="text-left px-3 py-2 font-medium">Discord ID</th>
                      <th className="text-left px-3 py-2 font-medium">Steam ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orgMembers.map((member) => (
                      <tr key={member.discordId} className="border-t border-border">
                        <td className="px-3 py-2">{member.username}</td>
                        <td className="px-3 py-2 font-mono text-xs">{member.discordId}</td>
                        <td className="px-3 py-2 font-mono text-xs">{member.steamId ?? "-"}</td>
                      </tr>
                    ))}
                    {!orgMembers.length ? (
                      <tr>
                        <td className="px-3 py-4 text-muted-foreground" colSpan={3}>No members in this organization.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
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

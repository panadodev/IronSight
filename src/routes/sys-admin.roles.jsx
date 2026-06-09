import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Plus, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/sys-admin/roles")({
  head: () => ({ meta: [{ title: "Roles — IronSight" }] }),
  component: RolesPage,
});

function redirectToLogin() {
  window.location.assign(
    `/login?next=${encodeURIComponent(window.location.pathname)}`,
  );
}

async function authFetch(url, init) {
  const res = await fetch(url, init);
  if (res.status === 401) {
    redirectToLogin();
    const err = new Error("Session expired");
    err.code = "AUTH_EXPIRED";
    throw err;
  }
  return res;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function RolesPage() {
  const [sessionUser, setSessionUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [newRoleName, setNewRoleName] = useState("");
  const [creatingRole, setCreatingRole] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [rolePermissions, setRolePermissions] = useState({});
  const [updatingRoleId, setUpdatingRoleId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) setSessionUser(null);
          return;
        }

        const body = await res.json();
        if (!cancelled) setSessionUser(body?.user ?? null);
      } catch {
        if (!cancelled) setSessionUser(null);
      }
    }

    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionUser?.isSysAdmin) return;

    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setError("");

      try {
        const [rolesRes, permsRes] = await Promise.all([
          authFetch("/api/roles"),
          authFetch("/api/permissions"),
        ]);

        if (!cancelled) {
          if (rolesRes.ok) {
            const body = await rolesRes.json();
            setRoles(body.roles ?? []);
            if (body.roles && body.roles[0]) {
              setSelectedRoleId(body.roles[0].roleId);
            }
          }
          if (permsRes.ok) {
            const body = await permsRes.json();
            setPermissions(body.permissions ?? []);
          }
        }
      } catch (err) {
        if (!cancelled && err?.code !== "AUTH_EXPIRED") {
          setError(err?.message ?? "Failed to load roles and permissions.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, [sessionUser]);

  useEffect(() => {
    if (!selectedRoleId || !sessionUser?.isSysAdmin) return;

    let cancelled = false;

    async function loadRolePerms() {
      try {
        const res = await authFetch(`/api/roles/${selectedRoleId}/permissions`);
        if (!res.ok) {
          if (!cancelled) setError("Failed to load role permissions.");
          return;
        }

        const body = await res.json();
        if (!cancelled) {
          const permsMap = {};
          (body.permissions ?? []).forEach((perm) => {
            permsMap[perm.permissionId] = perm.granted ?? false;
          });
          setRolePermissions(permsMap);
        }
      } catch (err) {
        if (!cancelled && err?.code !== "AUTH_EXPIRED") {
          setError("Failed to load role permissions.");
        }
      }
    }

    loadRolePerms();

    return () => {
      cancelled = true;
    };
  }, [selectedRoleId, sessionUser]);

  async function handleCreateRole(event) {
    event.preventDefault();
    if (!newRoleName.trim()) {
      setError("Role name is required.");
      return;
    }

    setCreatingRole(true);
    setError("");

    try {
      const res = await authFetch("/api/roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleName: newRoleName.trim() }),
      });

      const body = await safeJson(res);
      if (!res.ok) {
        setError(body?.error ?? "Failed to create role.");
        return;
      }

      setRoles((prev) => [...prev, body.role]);
      setNewRoleName("");
      setSelectedRoleId(body.role.roleId);
    } catch (err) {
      if (err?.code !== "AUTH_EXPIRED") {
        setError(err?.message ?? "Failed to create role.");
      }
    } finally {
      setCreatingRole(false);
    }
  }

  async function handleTogglePermission(permissionId) {
    if (!selectedRoleId) return;

    const isCurrentlyGranted = rolePermissions[permissionId] ?? false;
    const newPerms = isCurrentlyGranted
      ? Object.entries(rolePermissions)
          .filter(([pid]) => pid !== permissionId)
          .reduce((acc, [pid, granted]) => ({ ...acc, [pid]: granted }), {})
      : { ...rolePermissions, [permissionId]: true };

    setRolePermissions(newPerms);
    setUpdatingRoleId(selectedRoleId);

    try {
      const res = await authFetch(`/api/roles/${selectedRoleId}/permissions`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          permissionIds: Object.keys(newPerms).filter((pid) => newPerms[pid]),
        }),
      });

      const body = await safeJson(res);
      if (!res.ok) {
        setError(body?.error ?? "Failed to update permissions.");
        setRolePermissions((prev) => ({
          ...prev,
          [permissionId]: isCurrentlyGranted,
        }));
      }
    } catch (err) {
      if (err?.code !== "AUTH_EXPIRED") {
        setError("Failed to update permissions.");
        setRolePermissions((prev) => ({
          ...prev,
          [permissionId]: isCurrentlyGranted,
        }));
      }
    } finally {
      setUpdatingRoleId(null);
    }
  }

  if (!sessionUser?.isSysAdmin) {
    return (
      <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
        <SiteNav />
        <main className="flex-1 grid place-items-center px-6">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="size-10 text-warning mx-auto" />
            <h1 className="text-lg font-semibold">Sysadmin Access Required</h1>
            <p className="text-sm text-muted-foreground">
              This section is restricted to system administrators only.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
          <header>
            <h1 className="text-2xl font-semibold">Roles & Permissions</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Create and manage global roles with permission toggles.
            </p>
          </header>

          {error ? (
            <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          ) : null}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Create Role Section */}
            <div className="lg:col-span-1 space-y-4">
              <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-3">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Plus className="size-4" />
                  Create Role
                </h2>

                <form onSubmit={handleCreateRole} className="space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="role-name" className="text-xs">
                      Role name
                    </Label>
                    <Input
                      id="role-name"
                      value={newRoleName}
                      onChange={(e) => setNewRoleName(e.target.value)}
                      placeholder="e.g., Moderator"
                      disabled={creatingRole}
                      className="text-xs h-8"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={creatingRole || !newRoleName.trim()}
                    size="sm"
                    className="w-full"
                  >
                    {creatingRole ? "Creating..." : "Create Role"}
                  </Button>
                </form>
              </div>

              {/* Roles List */}
              <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  All Roles
                </h3>
                {loading ? (
                  <div className="text-xs text-muted-foreground">
                    Loading...
                  </div>
                ) : roles.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    No roles created yet.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {roles.map((role) => (
                      <button
                        key={role.roleId}
                        onClick={() => setSelectedRoleId(role.roleId)}
                        className={`w-full text-left px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                          selectedRoleId === role.roleId
                            ? "bg-brand text-brand-foreground"
                            : "bg-surface/60 hover:bg-surface text-foreground"
                        }`}
                      >
                        {role.roleName}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Permissions Section */}
            <div className="lg:col-span-2">
              {selectedRoleId &&
              roles.find((r) => r.roleId === selectedRoleId) ? (
                <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-4">
                  <div>
                    <h2 className="text-sm font-semibold">
                      {roles.find((r) => r.roleId === selectedRoleId)?.roleName}{" "}
                      — Permissions
                    </h2>
                    <p className="text-xs text-muted-foreground mt-1">
                      Toggle permissions for this role. Click to grant or
                      revoke.
                    </p>
                  </div>

                  {loading ? (
                    <div className="text-xs text-muted-foreground">
                      Loading permissions...
                    </div>
                  ) : permissions.length === 0 ? (
                    <div className="text-xs text-muted-foreground">
                      No permissions available.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {permissions.map((perm) => {
                        const isGranted =
                          rolePermissions[perm.permissionId] ?? false;
                        const isUpdating = updatingRoleId === selectedRoleId;

                        return (
                          <button
                            key={perm.permissionId}
                            onClick={() =>
                              handleTogglePermission(perm.permissionId)
                            }
                            disabled={isUpdating}
                            className={`w-full flex items-center gap-3 px-3 py-2 rounded text-xs font-medium transition-all ${
                              isGranted
                                ? "bg-brand/20 text-brand ring-1 ring-brand/40"
                                : "bg-surface/60 text-muted-foreground hover:bg-surface hover:text-foreground ring-1 ring-border"
                            } ${isUpdating ? "opacity-50" : ""}`}
                          >
                            <span
                              className={`size-4 rounded-sm grid place-items-center ring-1 ${
                                isGranted
                                  ? "bg-brand ring-brand text-brand-foreground"
                                  : "ring-border text-transparent"
                              }`}
                            >
                              {isGranted ? <Check className="size-3" /> : null}
                            </span>
                            <span className="flex-1 text-left">
                              {perm.permissionName}
                            </span>
                            {isUpdating && (
                              <span className="text-[9px] text-muted-foreground">
                                Updating...
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 text-center text-sm text-muted-foreground">
                  Select a role to manage its permissions.
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { manageOrgStore, useManageOrgId } from "@/lib/manage-org-store";
import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
const Route = createFileRoute("/manage")({
  component: ManageLayout,
});
function ManageLayout() {
  const { adminableOrgIds, orgs } = useAuth();
  const orgId = useManageOrgId();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [sessionUser, setSessionUser] = useState(null);

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

  const manageableOrgIds = useMemo(() => {
    if (sessionUser?.isSysAdmin) return orgs.map((o) => o.id);

    const sessionOrgAdminIds = Array.isArray(sessionUser?.orgAdminOrgIds)
      ? sessionUser.orgAdminOrgIds
      : [];

    if (sessionOrgAdminIds.length > 0) return sessionOrgAdminIds;
    return adminableOrgIds;
  }, [sessionUser, orgs, adminableOrgIds]);

  const manageable = useMemo(
    () => orgs.filter((o) => manageableOrgIds.includes(o.id)),
    [orgs, manageableOrgIds],
  );
  useEffect(() => {
    if (manageable.length === 0) {
      if (orgId) manageOrgStore.set(null);
      return;
    }
    if (!orgId || !manageable.some((o) => o.id === orgId)) {
      manageOrgStore.set(manageable[0].id);
    }
  }, [manageable, orgId]);
  useEffect(() => {
    if (path === "/manage" || path === "/manage/") {
      navigate({ to: "/manage/details", replace: true });
    }
  }, [path, navigate]);
  if (manageable.length === 0) {
    return (
      <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
        <SiteNav />
        <main className="flex-1 overflow-y-auto">
          <div className="p-10 max-w-xl mx-auto">
            <div className="rounded-lg ring-1 ring-border bg-surface/40 p-8 text-center">
              <ShieldAlert className="size-8 mx-auto text-warning mb-3" />
              <h1 className="text-lg font-semibold mb-1">
                Manage Org — Admin+ only
              </h1>
              <p className="text-sm text-muted-foreground">
                You don't have admin permissions on any organization.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }
  void manageable;
  return (
    <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
export { Route };

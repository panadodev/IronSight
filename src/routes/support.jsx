import { SiteNav } from "@/components/site-nav";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { useEffect, useState } from "react";
const Route = createFileRoute("/support")({
  validateSearch: (s) => ({
    org: typeof s.org === "string" ? s.org : void 0,
    error: typeof s.error === "string" ? s.error : void 0,
  }),
  beforeLoad: ({ search }) => {
    if (search.org) {
      throw redirect({ to: "/submit", search: { org: search.org } });
    }
  },
  head: () => ({
    meta: [
      { title: "Support" },
      {
        name: "description",
        content: "Pick a community to file a support ticket with.",
      },
    ],
  }),
  component: SupportLanding,
});

const ERROR_LABELS = {
  steam_state_invalid: "Steam login state was invalid. Please try again.",
  steam_state_expired: "Steam login state expired. Please try again.",
  steam_auth_failed: "Steam authentication failed. Please try again.",
};

function SupportLanding() {
  const { error: errorCode } = Route.useSearch();
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/orgs")
      .then((r) => r.ok ? r.json() : { orgs: [] })
      .then((body) => {
        if (!cancelled) {
          setOrgs(body.orgs ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-8 space-y-8">
          <header>
            <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-2">
              IronSight / support
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Pick an organization
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-prose">
              Choose which community you want to file a ticket for. In most
              cases you'll get here from a direct link and skip this step
              entirely.
            </p>
          </header>

          {errorCode && ERROR_LABELS[errorCode] && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {ERROR_LABELS[errorCode]}
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading organizations…</p>
          ) : orgs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No organizations found.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {orgs.map((o) => (
                <Link
                  key={o.orgId}
                  to="/submit"
                  search={{ org: o.orgId }}
                  className="group flex items-center justify-between px-4 py-4 rounded-lg ring-1 ring-border bg-surface/40 hover:bg-surface/70 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-10 rounded ring-1 ring-border grid place-items-center bg-background">
                      <Building2 className="size-4 text-brand" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{o.name}</p>
                      <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        {o.short}
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground group-hover:text-brand">
                    Continue →
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
export { Route };

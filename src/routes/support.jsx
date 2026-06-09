import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
const Route = createFileRoute("/support")({
  validateSearch: (s) => ({
    org: typeof s.org === "string" ? s.org : void 0,
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
function SupportLanding() {
  const { orgs } = useAuth();
  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-8 space-y-8">
          <header>
            <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-2">
              archipel.gg / support
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Pick an organization
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-prose">
              Choose which community you want to file a ticket for. In most
              cases you'll get here from a direct link (e.g. sanc.gg/support,
              willjum.com/support) and skip this step entirely.
            </p>
          </header>

          <div className="grid grid-cols-1 gap-2">
            {orgs.map((o) => (
              <Link
                key={o.id}
                to="/support"
                search={{ org: o.id }}
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
        </div>
      </main>
    </div>
  );
}
export { Route };

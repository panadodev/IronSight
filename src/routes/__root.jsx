import { getAuthMe, invalidateAuthMe } from "@/lib/auth-cache";
import { fetchAuthStatus } from "@/lib/auth-guard";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { Toaster } from "@/components/ui/sonner";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  redirect,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import appCss from "../styles.css?url";
function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-3">
          Error 404
        </p>
        <h1 className="text-3xl font-semibold text-foreground">Signal lost</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          That route isn't on the grid. Head back to the dashboard.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90"
          >
            Return to console
          </Link>
        </div>
      </div>
    </div>
  );
}
function ErrorComponent({ error, reset }) {
  console.error(error);
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <p className="text-[10px] font-mono uppercase tracking-widest text-danger mb-3">
          System fault
        </p>
        <h1 className="text-xl font-semibold text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something failed on our end. Retry, or head back to the console.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground hover:opacity-90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-surface"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
const Route = createRootRouteWithContext()({
  beforeLoad: async ({ location }) => {
    const publicPaths = new Set([
      "/login",
      "/submit",
      "/support",
      "/my-reports",
      "/privacy",
      "/tos",
    ]);
    if (publicPaths.has(location.pathname)) return;

    // Check auth on both the server (SSR) and the client. Running it during
    // SSR is what prevents the protected page from being streamed to the
    // browser and flashing for a frame before the client-side redirect fires.
    const isServer = typeof window === "undefined";
    const { status } = isServer ? await fetchAuthStatus() : await getAuthMe();

    if (status === 401) {
      // Evict the cache so the next login attempt gets a fresh response.
      if (!isServer) invalidateAuthMe();
      // Unauthenticated visitors go to the public ticket portal, not login.
      throw redirect({ to: "/support" });
    }

    // Authenticated staff land on the ticket queue, not the dashboard.
    if (location.pathname === "/") {
      throw redirect({ to: "/tickets" });
    }
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Iron Sight \u2014" },
      {
        name: "description",
        content:
          "Staff support console and player portal for a Rust game server.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});
function RootShell({ children }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Apply the saved accessibility text size before first paint so the
            panel doesn't reflow on load. Mirrors text-size-store.js (key +
            default). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var s=localStorage.getItem('iron_text_size_v1');if(s!=='normal'&&s!=='large')s='small';document.documentElement.setAttribute('data-text-size',s);}catch(e){}})();",
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
function ServerHealthBanner() {
  const { selectedOrgIds, sessionUser } = useAuth();
  const [staleServers, setStaleServers] = useState([]);

  useEffect(() => {
    if (!sessionUser || !selectedOrgIds.length) {
      setStaleServers([]);
      return;
    }

    let cancelled = false;
    const STALE_SECS = 15 * 60;

    const fetchHealth = async () => {
      const NOW = Math.floor(Date.now() / 1000);
      const stale = [];
      for (const orgId of selectedOrgIds) {
        try {
          const res = await fetch(
            `/api/orgs/${encodeURIComponent(orgId)}/servers`,
            { credentials: "include" },
          );
          if (!res.ok) continue;
          const { servers = [] } = await res.json().catch(() => ({}));
          for (const s of servers) {
            if (
              s.lastHealthPing !== null &&
              NOW - s.lastHealthPing > STALE_SECS
            ) {
              stale.push(s.serverName ?? s.serverId);
            }
          }
        } catch {}
      }
      if (!cancelled) setStaleServers(stale);
    };

    fetchHealth();
    const id = setInterval(fetchHealth, 2 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionUser, selectedOrgIds]);

  if (!sessionUser || !staleServers.length) return null;

  return (
    <div className="fixed top-14 md:top-0 left-0 md:left-56 right-0 z-20 bg-destructive/15 border-b-2 border-destructive/50 px-4 md:px-5 py-2.5 flex items-center gap-3">
      <AlertTriangle className="size-4 text-destructive shrink-0" />
      <p className="text-xs text-destructive leading-snug">
        <span className="font-bold">Server heartbeat lost —</span>{" "}
        {staleServers.join(" · ")} has not sent a ping in over 15 minutes.
      </p>
    </div>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Outlet />
        <ServerHealthBanner />
        <Toaster position="top-right" />
      </AuthProvider>
    </QueryClientProvider>
  );
}
export { Route };

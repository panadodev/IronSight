import { SiteNav } from "@/components/site-nav";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Building2, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";

const Route = createFileRoute("/support")({
  validateSearch: (s) => ({
    org: typeof s.org === "string" ? s.org : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
    step: typeof s.step === "string" ? s.step : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Support — IronSight" },
      {
        name: "description",
        content: "Link your accounts and file a ticket with any community.",
      },
    ],
  }),
  component: SupportLanding,
});

const ERROR_LABELS = {
  // Discord
  discord_callback_invalid: "Discord login returned an invalid callback.",
  discord_state_invalid: "Discord login state expired. Please start again.",
  discord_auth_failed: "Discord authentication failed. Please try again.",
  // Steam
  steam_state_invalid: "Steam login state was invalid. Please try again.",
  steam_state_expired: "Steam login state expired. Please try again.",
  steam_auth_failed: "Steam authentication failed. Please try again.",
  steam_requires_discord: "You need to link Discord before linking Steam.",
  steam_already_linked:
    "That Steam account is already linked to a different Discord. Contact support if you need help.",
  service_unavailable: "Service is temporarily unavailable. Please try again.",
};

function ErrorBanner({ code }) {
  const message = ERROR_LABELS[code];
  if (!message) return null;
  return (
    <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
    </div>
  );
}

function StepIndicator({ step }) {
  const steps = [
    { n: 1, label: "Discord" },
    { n: 2, label: "Steam" },
    { n: 3, label: "Submit" },
  ];
  return (
    <ol className="flex items-center text-xs">
      {steps.map((s, i) => {
        const done = s.n < step;
        const active = s.n === step;
        return (
          <li key={s.n} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <span
                className={
                  "size-6 rounded-full ring-1 flex items-center justify-center font-bold text-[0.625rem] " +
                  (done
                    ? "bg-brand/10 ring-brand/40 text-brand"
                    : active
                      ? "bg-brand ring-brand text-brand-foreground"
                      : "bg-surface ring-border text-muted-foreground")
                }
              >
                {done ? <CheckCircle2 className="size-3.5" /> : s.n}
              </span>
              <span
                className={
                  "font-mono uppercase tracking-wider " +
                  (active
                    ? "text-foreground font-semibold"
                    : "text-muted-foreground")
                }
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={
                  "w-10 h-px mx-2 mt-[-14px] " +
                  (s.n < step ? "bg-brand/40" : "bg-border")
                }
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SupportLanding() {
  const { org: orgParam, error: errorCode } = Route.useSearch();

  // "loading" | "unauthenticated" | "pending" | "authenticated"
  const [status, setStatus] = useState("loading");
  const [session, setSession] = useState(null);
  const [pending, setPending] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [orgsLoading, setOrgsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const [meRes, pendingRes] = await Promise.all([
          fetch("/api/auth/me", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
          fetch("/api/auth/pending-link", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);

        if (cancelled) return;

        if (meRes?.user) {
          setSession(meRes.user);
          setStatus("authenticated");
          // Deep-link: if ?org= is present and user is already authenticated,
          // skip the org picker and go straight to submission.
          if (orgParam) {
            window.location.assign(
              `/submit?org=${encodeURIComponent(orgParam)}`,
            );
          }
        } else if (pendingRes?.pending) {
          setPending(pendingRes.pending);
          setStatus("pending");
        } else {
          setStatus("unauthenticated");
        }
      } catch {
        if (!cancelled) setStatus("unauthenticated");
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load org list once authenticated
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    setOrgsLoading(true);
    fetch("/api/orgs")
      .then((r) => (r.ok ? r.json() : { orgs: [] }))
      .then((body) => {
        if (!cancelled) {
          setOrgs(body.orgs ?? []);
          setOrgsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setOrgsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  function startDiscordAuth() {
    const params = orgParam ? `?org=${encodeURIComponent(orgParam)}` : "";
    window.location.assign(`/api/auth/public/discord/start${params}`);
  }

  function startSteamAuth() {
    const params = orgParam ? `?org=${encodeURIComponent(orgParam)}` : "";
    window.location.assign(`/api/auth/steam/public/start${params}`);
  }

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setSession(null);
    setPending(null);
    setStatus("unauthenticated");
    setOrgs([]);
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  if (status === "loading") {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  // ── Step 1: Link Discord ───────────────────────────────────────────────────

  if (status === "unauthenticated") {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-md bg-surface/60 ring-1 ring-border rounded-xl p-8 space-y-6">
            <div className="text-center">
              <p className="text-[0.625rem] font-mono uppercase tracking-widest text-brand mb-2">
                IronSight / support
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                Submit a ticket
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Link your accounts once — then submit any time.
              </p>
            </div>

            <div className="flex justify-center">
              <StepIndicator step={1} />
            </div>

            {errorCode && <ErrorBanner code={errorCode} />}

            <div className="space-y-3">
              <p className="text-xs text-muted-foreground text-center">
                Start by linking your Discord. We use it to message you ticket
                updates and let staff reply directly.
              </p>
              <button
                onClick={startDiscordAuth}
                className="w-full py-3 bg-[#5865f2] hover:bg-[#4f58d9] text-white rounded-md text-sm font-semibold flex items-center justify-center gap-3 transition-colors"
              >
                <svg
                  className="size-4 fill-white"
                  viewBox="0 0 127.14 96.36"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z" />
                </svg>
                Continue with Discord
              </button>
            </div>

            <p className="text-[0.625rem] text-center text-muted-foreground">
              Already submitted a ticket?{" "}
              <Link to="/my-reports" className="text-brand hover:underline">
                View your tickets
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 2: Link Steam (Discord done, Steam pending) ──────────────────────

  if (status === "pending") {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-md bg-surface/60 ring-1 ring-border rounded-xl p-8 space-y-6">
            <div className="text-center">
              <p className="text-[0.625rem] font-mono uppercase tracking-widest text-brand mb-2">
                IronSight / support
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                One more step
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Discord linked as{" "}
                <span className="text-foreground font-semibold">
                  {pending?.username}
                </span>
                . Now connect Steam to verify your in-game identity.
              </p>
            </div>

            <div className="flex justify-center">
              <StepIndicator step={2} />
            </div>

            {errorCode && <ErrorBanner code={errorCode} />}

            <div className="space-y-3">
              <p className="text-xs text-muted-foreground text-center">
                Steam verifies who you are in-game. Staff can look up your game
                history when reviewing your ticket.
              </p>
              <button
                onClick={startSteamAuth}
                className="w-full py-3 bg-[#171a21] hover:bg-[#1f242d] ring-1 ring-border text-white rounded-md text-sm font-semibold flex items-center justify-center gap-3 transition-colors"
              >
                <span className="font-mono text-xs uppercase tracking-widest text-[#66c0f4]">
                  Steam
                </span>
                Link Steam account
              </button>
            </div>

            <p className="text-[0.625rem] text-center text-muted-foreground">
              Wrong Discord account?{" "}
              <button
                onClick={async () => {
                  await fetch("/api/auth/logout", {
                    method: "POST",
                    credentials: "include",
                  });
                  window.location.reload();
                }}
                className="text-brand hover:underline"
              >
                Start over
              </button>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 3: Authenticated — org selection ─────────────────────────────────

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-8 space-y-8">
          <header>
            <p className="text-[0.625rem] font-mono uppercase tracking-widest text-brand mb-2">
              IronSight / support
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Pick an organization
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-prose">
              Choose which community you want to file a ticket for.
            </p>
            <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                Signed in as{" "}
                <span className="text-foreground font-semibold">
                  {session?.username}
                </span>
                {session?.steamId && <> · Steam {session.steamId}</>}
              </span>
              <button
                onClick={handleSignOut}
                className="text-danger hover:underline"
              >
                Sign out
              </button>
            </div>
          </header>

          {errorCode && <ErrorBanner code={errorCode} />}

          {orgsLoading ? (
            <p className="text-sm text-muted-foreground">
              Loading organizations…
            </p>
          ) : orgs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No organizations found.
            </p>
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
                      <p className="text-[0.625rem] font-mono uppercase tracking-wider text-muted-foreground">
                        {o.short}
                      </p>
                    </div>
                  </div>
                  <span className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground group-hover:text-brand">
                    Continue →
                  </span>
                </Link>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-border">
            <p className="text-xs text-muted-foreground">
              Already submitted a ticket?{" "}
              <Link to="/my-reports" className="text-brand hover:underline">
                View my tickets
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

export { Route };

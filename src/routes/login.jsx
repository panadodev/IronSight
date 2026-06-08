import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/login")({
  validateSearch: (search) => ({
    next: typeof search.next === "string" ? search.next : "/todo",
    step: typeof search.step === "string" ? search.step : "discord",
    error: typeof search.error === "string" ? search.error : ""
  }),
  head: () => ({ meta: [{ title: "Login - IronSight" }] }),
  component: LoginPage
});

const ERROR_LABELS = {
  discord_callback_invalid: "Discord login returned an invalid callback.",
  discord_state_invalid: "Discord login state expired. Start again.",
  discord_config_missing: "Discord OAuth is not configured on the server.",
  discord_token_exchange_failed: "Discord rejected the OAuth code exchange. Check client ID/secret and registered callback URL.",
  discord_user_lookup_failed: "Discord authentication succeeded, but fetching your Discord profile failed.",
  discord_auth_failed: "Discord authentication failed.",
  service_unavailable: "Login service is temporarily unavailable. Please try again in a moment.",
  steam_requires_discord: "Start with Discord before linking Steam.",
  steam_state_invalid: "Steam login state is missing.",
  steam_state_expired: "Steam login state expired. Start again.",
  steam_auth_failed: "Steam authentication failed.",
  steam_already_linked: "That Steam account is already linked to another Discord account."
};

function LoginPage() {
  const search = Route.useSearch();
  const [checking, setChecking] = useState(true);
  const [sessionUser, setSessionUser] = useState(null);
  const [pending, setPending] = useState(null);
  const [pageError, setPageError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setChecking(true);
      setPageError(search.error ? ERROR_LABELS[search.error] ?? "Authentication failed." : "");

      try {
        const [meRes, pendingRes] = await Promise.all([
          fetch("/api/auth/me"),
          fetch("/api/auth/pending-link")
        ]);

        if (!cancelled && meRes.ok) {
          const me = await meRes.json();
          setSessionUser(me.user);
          window.location.assign(search.next || "/todo");
          return;
        }

        if (!cancelled && pendingRes.ok) {
          const pendingBody = await pendingRes.json();
          setPending(pendingBody.pending);
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(error?.message ?? "Failed to check login state.");
        }
      } finally {
        if (!cancelled) {
          setChecking(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [search.error, search.next]);

  function startDiscord() {
    window.location.assign(`/api/auth/discord/start?next=${encodeURIComponent(search.next || "/todo")}`);
  }

  function startSteam() {
    window.location.assign("/api/auth/steam/start");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  return (
    <div className="min-h-screen bg-background text-foreground px-4 py-10">
      <div className="mx-auto max-w-4xl grid gap-6 lg:grid-cols-[1.15fr_0.85fr] items-start">
        <section className="space-y-4">
          <p className="text-[11px] uppercase tracking-[0.28em] text-brand">IronSight Panel</p>
          <h1 className="text-4xl font-semibold leading-tight">Sign in with verified Discord and Steam identity.</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            First-time access starts with Discord OAuth2, then Steam OpenID links your Steam account. After that, Discord alone is enough to sign in.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Feature title="Discord OAuth2" body="Uses provider-issued user identity instead of typed IDs." />
            <Feature title="Steam OpenID" body="Links the Steam account through Steam's login verifier." />
            <Feature title="Session Security" body="Stores server-side session state in Redis with httpOnly cookies." />
          </div>
        </section>

        <Card className="border-border bg-surface/40">
          <CardHeader>
            <CardTitle>Login</CardTitle>
            <CardDescription>
              Continue to {search.next || "/todo"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pageError ? (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {pageError}
              </div>
            ) : null}

            {checking ? <p className="text-sm text-muted-foreground">Checking authentication state...</p> : null}

            {!checking && sessionUser ? (
              <div className="space-y-3">
                <p className="text-sm">Signed in as {sessionUser.username}</p>
                <div className="flex gap-2">
                  <Button onClick={() => window.location.assign(search.next || "/todo")}>Continue</Button>
                  <Button variant="outline" onClick={logout}>Sign out</Button>
                </div>
              </div>
            ) : null}

            {!checking && !sessionUser ? (
              <div className="space-y-3">
                <Button className="w-full" onClick={startDiscord}>
                  {pending ? "Restart Discord" : "Continue with Discord"}
                </Button>

                {pending ? (
                  <div className="rounded-md border border-border bg-background/60 px-3 py-3 space-y-3">
                    <div>
                      <p className="text-sm font-medium">Discord connected</p>
                      <p className="text-xs text-muted-foreground">
                        {pending.username} · {pending.discordId}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Finish first-time setup by linking Steam.
                    </p>
                    <Button className="w-full" variant="secondary" onClick={startSteam}>
                      Continue with Steam
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Start with Discord. If this is your first login, you will be prompted to link Steam after Discord returns.
                  </p>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Feature({ title, body }) {
  return (
    <div className="rounded-lg border border-border bg-surface/30 p-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

import { SiteNav } from "@/components/site-nav";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

const Route = createFileRoute("/submit")({
  validateSearch: (s) => ({
    org: typeof s.org === "string" ? s.org : void 0,
  }),
  beforeLoad: ({ search }) => {
    if (!search.org) throw redirect({ to: "/support" });
  },
  head: () => ({
    meta: [
      { title: "Submit a Ticket \u2014 IronSight Support" },
      {
        name: "description",
        content:
          "Sign in with Steam and report cheaters, appeal bans, or get support.",
      },
    ],
  }),
  component: SubmitPage,
});

const REPORT_CATEGORIES = [
  { id: "cheating", label: "Cheating", blurb: "Aimbot, ESP, scripts, macros." },
  {
    id: "teaming",
    label: "Teaming",
    blurb: "Group size violation / cross-team play.",
  },
  {
    id: "toxicity",
    label: "Toxicity",
    blurb: "Slurs, harassment, hate speech.",
  },
];

function SubmitPage() {
  const { org: orgId } = Route.useSearch();
  const [session, setSession] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [org, setOrg] = useState(null);
  const [orgLoading, setOrgLoading] = useState(true);
  const [ticketTypes, setTicketTypes] = useState([]);
  const [selectedTypeId, setSelectedTypeId] = useState(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [targetSteamId, setTargetSteamId] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedPlayers, setSelectedPlayers] = useState([]);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerResults, setPlayerResults] = useState([]);
  const [playerSearching, setPlayerSearching] = useState(false);
  const [playerDropdownOpen, setPlayerDropdownOpen] = useState(false);
  const playerSearchRef = useRef(null);
  const [reportCategory, setReportCategory] = useState("cheating");
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitted, setSubmitted] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) {
          setSession(data?.user ?? null);
          setSessionChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) setSessionChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    Promise.all([
      fetch("/api/orgs").then((r) => (r.ok ? r.json() : { orgs: [] })),
      fetch(`/api/orgs/${encodeURIComponent(orgId)}/ticket-types`).then((r) =>
        r.ok ? r.json() : { ticketTypes: [] },
      ),
    ])
      .then(([orgsBody, typesBody]) => {
        if (cancelled) return;
        const found = (orgsBody.orgs ?? []).find((o) => o.orgId === orgId);
        setOrg(found ?? null);
        setTicketTypes(typesBody.ticketTypes ?? []);
        setOrgLoading(false);
      })
      .catch(() => {
        if (!cancelled) setOrgLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const selectedType =
    ticketTypes.find((t) => t.ticketTypeId === selectedTypeId) ?? null;
  const isPlayerReport = selectedType?.category === "player_single" || selectedType?.category === "player_multi";
  const isMultiPlayerReport = selectedType?.category === "player_multi";

  useEffect(() => {
    if (!isPlayerReport) return;
    const q = playerQuery.trim();
    if (q.length < 2) {
      setPlayerResults([]);
      setPlayerDropdownOpen(false);
      return;
    }
    setPlayerSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/players/search?q=${encodeURIComponent(q)}`,
          { credentials: "include" },
        );
        if (res.ok) {
          const data = await res.json();
          setPlayerResults(data.players ?? []);
          setPlayerDropdownOpen(true);
        }
      } catch {}
      setPlayerSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [playerQuery, isPlayerReport, orgId]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (!playerSearchRef.current?.contains(e.target))
        setPlayerDropdownOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function handleSubmit() {
    if (!selectedTypeId || !orgId) return;
    let ticketTitle = title.trim();
    let message = body.trim();
    if (isPlayerReport) {
      const players = isMultiPlayerReport ? selectedPlayers : (selectedPlayer ? [selectedPlayer] : []);
      if (players.length === 0 || !message) return;
      const steamIds = players.map((p) => p.steamId).join(", ");
      ticketTitle = ticketTitle || `${reportCategory} \u2014 ${steamIds}`;
      const evidenceText = evidence.trim();
      if (evidenceText) message = `${message}\n\nEvidence:\n${evidenceText}`;
      if (isMultiPlayerReport) {
        message = `Target Steam IDs: ${steamIds}\nCategory: ${reportCategory}\n\n${message}`;
      } else {
        message = `Target Steam ID: ${steamIds}\nCategory: ${reportCategory}\n\n${message}`;
      }
    } else {
      if (!ticketTitle || !message) return;
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          ticketTypeId: selectedTypeId,
          title: ticketTitle,
          message,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data?.error ?? "Failed to submit ticket.");
        return;
      }
      setSubmitted({ ticketId: data.ticketId });
    } catch {
      setSubmitError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setSubmitted(null);
    setSelectedTypeId(null);
    setTitle("");
    setBody("");
    setTargetSteamId("");
    setSelectedPlayer(null);
    setSelectedPlayers([]);
    setPlayerQuery("");
    setPlayerResults([]);
    setPlayerDropdownOpen(false);
    setReportCategory("cheating");
    setEvidence("");
    setSubmitError("");
  }

  if (!sessionChecked || orgLoading) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center">
          <p className="text-sm text-muted-foreground">Loading\u2026</p>
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
        <SiteNav />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto p-8">
            <div className="rounded-lg ring-1 ring-border bg-surface/40 p-6 space-y-2">
              <h1 className="text-lg font-semibold">Organization not found</h1>
              <p className="text-sm text-muted-foreground">
                The organization "{orgId}" does not exist or is unavailable.
              </p>
              <Link
                to="/support"
                className="text-sm font-semibold text-brand hover:underline"
              >
                Back to organization selection
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-md bg-surface/60 ring-1 ring-border rounded-xl p-8 text-center">
            <div className="size-12 mx-auto mb-4 bg-brand rounded-md grid place-items-center font-mono font-bold text-brand-foreground text-lg">
              R
            </div>
            <h1 className="text-xl font-semibold mb-2">Verify your identity</h1>
            <p className="text-sm text-muted-foreground mb-1">
              Filing for{" "}
              <span className="text-foreground font-semibold">{org.name}</span>.
            </p>
            <p className="text-sm text-muted-foreground mb-6">
              Link your Discord and Steam accounts to submit a ticket.
            </p>
            <a
              href={`/support?org=${encodeURIComponent(orgId)}`}
              className="w-full py-3 bg-brand hover:opacity-90 text-brand-foreground rounded-md text-sm font-semibold flex items-center justify-center gap-2 transition-opacity"
            >
              Link accounts to continue
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-md bg-surface/60 ring-1 ring-border rounded-xl p-8 text-center">
            <div className="size-10 mx-auto mb-4 bg-success/10 ring-1 ring-success/30 rounded-full grid place-items-center text-success font-bold text-lg">
              \u2713
            </div>
            <h1 className="text-xl font-semibold mb-1">Ticket submitted</h1>
            <p className="text-sm text-muted-foreground mb-2">
              Your ticket reference is{" "}
              <span className="font-mono text-brand">
                #{submitted.ticketId}
              </span>
              .
            </p>
            <p className="text-xs text-muted-foreground mb-6">
              Staff will review your ticket shortly. Track it in{" "}
              <Link
                to="/my-reports"
                search={{ org: orgId }}
                className="text-brand underline"
              >
                My Tickets
              </Link>
              .
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={resetForm}
                className="px-4 py-2 bg-surface ring-1 ring-border rounded text-xs font-semibold uppercase tracking-wider hover:bg-surface/80"
              >
                Submit another
              </button>
              <Link
                to="/my-reports"
                search={{ org: orgId }}
                className="px-4 py-2 bg-brand text-brand-foreground rounded text-xs font-semibold uppercase tracking-wider hover:opacity-90"
              >
                View my tickets
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const canSubmit = (() => {
    if (!selectedTypeId) return false;
    if (isPlayerReport) {
      const hasPlayers = isMultiPlayerReport ? selectedPlayers.length > 0 : !!selectedPlayer;
      return hasPlayers && body.trim().length > 0;
    }
    return title.trim().length > 0 && body.trim().length > 0;
  })();

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8 space-y-8">
          <header>
            <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-2">
              {org.name} \u00b7 Player Portal
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Submit a ticket
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-prose">
              Pick a ticket type and provide as much detail as possible.
            </p>
            <p className="text-[10px] font-mono text-muted-foreground mt-1">
              Signed in as{" "}
              <span className="text-foreground">{session.username}</span>
              {session.steamId && <> \u00b7 Steam {session.steamId}</>}
            </p>
          </header>

          <section className="space-y-3">
            <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
              Ticket type
            </label>
            {ticketTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No ticket types available.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {ticketTypes.map((t) => {
                  const active = selectedTypeId === t.ticketTypeId;
                  return (
                    <button
                      key={t.ticketTypeId}
                      onClick={() => setSelectedTypeId(t.ticketTypeId)}
                      className={
                        "text-left p-4 rounded-lg ring-1 transition-colors " +
                        (active
                          ? "bg-brand/10 ring-brand/30"
                          : "bg-surface/40 ring-border hover:bg-surface/70")
                      }
                    >
                      <div className="flex items-center justify-between mb-1">
                        <p
                          className={
                            "text-sm font-semibold " +
                            (active ? "text-brand" : "text-foreground")
                          }
                        >
                          {t.name}
                        </p>
                        {active && (
                          <span className="size-1.5 rounded-full bg-brand" />
                        )}
                      </div>
                      <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                        {t.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {selectedType && isPlayerReport && (
            <>
              <section className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Step 1 · Reported player{isMultiPlayerReport ? "s" : ""}
                </label>
                {isMultiPlayerReport ? (
                  <>
                    {selectedPlayers.length > 0 && (
                      <div className="flex flex-wrap gap-2 p-3 bg-surface/40 ring-1 ring-border rounded">
                        {selectedPlayers.map((player) => (
                          <div
                            key={player.steamId}
                            className="flex items-center gap-2 px-3 py-1 bg-brand/20 ring-1 ring-brand/40 rounded-full"
                          >
                            <span className="text-sm font-medium">{player.name}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPlayers(
                                  selectedPlayers.filter((p) => p.steamId !== player.steamId)
                                );
                              }}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div ref={playerSearchRef} className="relative">
                      <input
                        type="text"
                        value={playerQuery}
                        onChange={(e) => setPlayerQuery(e.target.value)}
                        onFocus={() =>
                          playerResults.length > 0 && setPlayerDropdownOpen(true)
                        }
                        placeholder="Add players by name or Steam ID…"
                        className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
                      />
                      {playerSearching && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                          Searching…
                        </span>
                      )}
                      {playerDropdownOpen && playerResults.length > 0 && (
                        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-background ring-1 ring-border rounded-md shadow-lg">
                          {playerResults.map((p) => (
                            <button
                              key={p.steamId}
                              type="button"
                              onClick={() => {
                                if (!selectedPlayers.find((sp) => sp.steamId === p.steamId)) {
                                  setSelectedPlayers([...selectedPlayers, p]);
                                }
                                setPlayerDropdownOpen(false);
                                setPlayerQuery("");
                                setPlayerResults([]);
                              }}
                              className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-surface/60 transition-colors border-b border-border/50 last:border-0"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">{p.name}</p>
                                <p className="text-[10px] font-mono text-muted-foreground">
                                  {p.steamId}
                                </p>
                              </div>
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                {new Date(p.lastSeenAt * 1000).toLocaleDateString()}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      {playerQuery.trim().length >= 2 &&
                        !playerSearching &&
                        playerResults.length === 0 && (
                          <div className="absolute z-20 mt-1 w-full bg-background ring-1 ring-border rounded-md shadow-lg">
                            <div className="p-3 text-xs text-muted-foreground">
                              No players found matching "{playerQuery.trim()}".
                            </div>
                          </div>
                        )}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Search for players by their in-game name or Steam64 ID. Add as many as needed.
                    </p>
                  </>
                ) : (
                  <>
                    {selectedPlayer ? (
                      <div className="flex items-center gap-3 p-3 bg-surface/40 ring-1 ring-border rounded">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{selectedPlayer.name}</p>
                          <p className="text-[10px] font-mono text-muted-foreground">
                            {selectedPlayer.steamId}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPlayer(null);
                            setTargetSteamId("");
                            setPlayerQuery("");
                            setPlayerResults([]);
                          }}
                          className="text-xs text-muted-foreground hover:text-foreground shrink-0 px-2 py-1 rounded hover:bg-surface/60 transition-colors"
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <div ref={playerSearchRef} className="relative">
                        <input
                          type="text"
                          value={playerQuery}
                          onChange={(e) => {
                            setPlayerQuery(e.target.value);
                            setSelectedPlayer(null);
                            setTargetSteamId("");
                          }}
                          onFocus={() =>
                            playerResults.length > 0 && setPlayerDropdownOpen(true)
                          }
                          placeholder="Search by name or Steam ID…"
                          className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
                        />
                        {playerSearching && (
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                            Searching…
                          </span>
                        )}
                        {playerDropdownOpen && playerResults.length > 0 && (
                          <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-background ring-1 ring-border rounded-md shadow-lg">
                            {playerResults.map((p) => (
                              <button
                                key={p.steamId}
                                type="button"
                                onClick={() => {
                                  setSelectedPlayer(p);
                                  setTargetSteamId(p.steamId);
                                  setPlayerDropdownOpen(false);
                                  setPlayerQuery("");
                                  setPlayerResults([]);
                                }}
                                className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-surface/60 transition-colors border-b border-border/50 last:border-0"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium">{p.name}</p>
                                  <p className="text-[10px] font-mono text-muted-foreground">
                                    {p.steamId}
                                  </p>
                                </div>
                                <span className="text-[10px] text-muted-foreground shrink-0">
                                  {new Date(p.lastSeenAt * 1000).toLocaleDateString()}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        {playerQuery.trim().length >= 2 &&
                          !playerSearching &&
                          playerResults.length === 0 && (
                            <div className="absolute z-20 mt-1 w-full bg-background ring-1 ring-border rounded-md shadow-lg">
                              <div className="p-3 text-xs text-muted-foreground">
                                No players found matching "{playerQuery.trim()}".
                              </div>
                            </div>
                          )}
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      Search for the player by their in-game name or Steam64 ID.
                    </p>
                  </>
                )}
              </section>
              <section className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Step 2 \u00b7 What did they do?
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {REPORT_CATEGORIES.map((c) => {
                    const active = reportCategory === c.id;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setReportCategory(c.id)}
                        className={
                          "text-left p-3 rounded-lg ring-1 transition-colors " +
                          (active
                            ? "bg-brand/10 ring-brand/30"
                            : "bg-surface/40 ring-border hover:bg-surface/70")
                        }
                      >
                        <p
                          className={
                            "text-sm font-semibold " +
                            (active ? "text-brand" : "text-foreground")
                          }
                        >
                          {c.label}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {c.blurb}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Step 3 \u00b7 Description
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Describe what you saw. Include time, server, grid coords..."
                  className="w-full h-32 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                />
              </section>
              <section className="space-y-3">
                <label className="flex items-center justify-between text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  <span>Step 4 \u00b7 Evidence links</span>
                  <span className="text-muted-foreground/70 normal-case tracking-normal font-mono">
                    optional
                  </span>
                </label>
                <textarea
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder={"https://medal.tv/...\nhttps://youtu.be/..."}
                  className="w-full h-24 bg-background border border-border rounded p-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                />
              </section>
            </>
          )}

          {selectedType && !isPlayerReport && (
            <>
              <section className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short summary of your issue..."
                  maxLength={255}
                  className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
              </section>
              {title.trim() && (
                <section className="space-y-3">
                  <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                    Details
                  </label>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Provide as much detail as possible..."
                    className="w-full h-40 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                  />
                </section>
              )}
            </>
          )}

          {selectedType && (
            <div className="flex flex-col items-center gap-3 pt-2">
              {submitError && (
                <p className="text-sm text-danger">{submitError}</p>
              )}
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || submitting}
                className="px-8 py-3 bg-brand text-brand-foreground text-sm font-semibold rounded-md ring-1 ring-brand hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {submitting ? "Submitting\u2026" : "Submit ticket"}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export { Route };

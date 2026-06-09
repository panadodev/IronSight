import { PlayerCombobox } from "@/components/player-combobox";
import { SiteNav } from "@/components/site-nav";
import { addAssociationReports } from "@/lib/associations";
import { useAuth } from "@/lib/auth-context";
import {
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABEL,
  SERVERS,
  TEAM_META,
  TICKETS,
  TICKET_TYPES,
  TICKET_TYPE_ROUTING,
  getPlayer,
  getServerPlayers,
} from "@/lib/mock-data";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { X as XIcon } from "lucide-react";
import { useMemo, useState } from "react";
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
const CURRENT_USER_ID = "76561198000000002";
function SubmitPage() {
  const me = getPlayer(CURRENT_USER_ID);
  const { org: orgId } = Route.useSearch();
  const { orgs, publicSignedIn, setPublicSignedIn } = useAuth();
  const org = orgs.find((o) => o.id === orgId);
  if (!org) {
    return (
      <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
        <SiteNav />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto p-8">
            <div className="rounded-lg ring-1 ring-border bg-surface/40 p-6 space-y-2">
              <h1 className="text-lg font-semibold">Organization not found</h1>
              <p className="text-sm text-muted-foreground">
                The selected organization is not available for your current
                session.
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
  const [type, setType] = useState(null);
  const [category, setCategory] = useState("cheating");
  const [serverId, setServerId] = useState(SERVERS[0].id);
  const [subjectId, setSubjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState("");
  const [body, setBody] = useState("");
  const [associatedIds, setAssociatedIds] = useState([]);
  const [submitted, setSubmitted] = useState(null);
  const MAX_ASSOCIATED = 5;
  const routedTeam = type ? TICKET_TYPE_ROUTING[type] : null;
  const players = useMemo(() => getServerPlayers(serverId), [serverId]);
  const subject = useMemo(() => {
    if (type !== "player_report" || !subjectId) return null;
    return getPlayer(subjectId);
  }, [type, subjectId]);
  const associatedPlayers = associatedIds
    .map((id) => getPlayer(id))
    .filter((p) => Boolean(p));
  const canAddAssociated =
    category === "teaming" && associatedIds.length < MAX_ASSOCIATED;
  const associatedCandidates = players.filter(
    (p) => p.steamId !== subjectId && !associatedIds.includes(p.steamId),
  );
  const existingCase = useMemo(() => {
    if (type !== "player_report" || !subjectId) return null;
    return (
      TICKETS.find(
        (t) =>
          t.type === "player_report" &&
          t.subjectId === subjectId &&
          t.category === category &&
          t.status !== "banned",
      ) ?? null
    );
  }, [type, subjectId, category]);
  const submit = () => {
    if (!type || !routedTeam) return;
    if (type === "player_report") {
      if (!description.trim() || !subjectId) return;
      const subj = getPlayer(subjectId);
      if (category === "teaming" && subj && associatedPlayers.length > 0) {
        addAssociationReports(
          { steamId: subj.steamId, name: subj.name },
          associatedPlayers.map((p) => ({ steamId: p.steamId, name: p.name })),
        );
      }
      if (existingCase) {
        const entry = {
          id: `r_${Date.now()}`,
          reporterId: CURRENT_USER_ID,
          description: description.trim(),
          evidence: evidence.trim(),
          submittedAt: /* @__PURE__ */ new Date().toISOString(),
          submittedLabel: "just now",
          status: "pending",
        };
        existingCase.reports = [...(existingCase.reports ?? []), entry];
        if (existingCase.status === "cleared") existingCase.status = "open";
        setSubmitted({ ref: `#${existingCase.number}`, aggregated: true });
        return;
      }
      const num2 = Math.floor(4900 + Math.random() * 1e3);
      const newTicket2 = {
        id: `t_${num2}`,
        number: num2,
        type,
        category,
        team: routedTeam,
        status: "open",
        priority: "normal",
        title: `${REPORT_CATEGORY_LABEL[category]} \u2014 ${subj.name}`,
        summary: description.trim().slice(0, 140),
        createdAt: /* @__PURE__ */ new Date().toISOString(),
        createdLabel: "just now",
        reporterId: CURRENT_USER_ID,
        subjectId,
        serverId,
        assigneeId: null,
        restrictedRank: null,
        messages: [],
        reports: [
          {
            id: `r_${Date.now()}`,
            reporterId: CURRENT_USER_ID,
            description: description.trim(),
            evidence: evidence.trim(),
            submittedAt: /* @__PURE__ */ new Date().toISOString(),
            submittedLabel: "just now",
            status: "pending",
          },
        ],
      };
      TICKETS.unshift(newTicket2);
      setSubmitted({ ref: `#${num2}`, aggregated: false });
      return;
    }
    if (!body.trim() || !title.trim()) return;
    const num = Math.floor(4900 + Math.random() * 1e3);
    const newTicket = {
      id: `t_${num}`,
      number: num,
      type,
      team: routedTeam,
      status: "open",
      priority: "normal",
      title: title.trim(),
      summary: body.trim().slice(0, 140),
      createdAt: /* @__PURE__ */ new Date().toISOString(),
      createdLabel: "just now",
      reporterId: CURRENT_USER_ID,
      subjectId: null,
      serverId,
      assigneeId: null,
      restrictedRank: null,
      messages: [
        {
          authorId: CURRENT_USER_ID,
          authorName: me.name,
          authorKind: "reporter",
          timestamp: /* @__PURE__ */ new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          body: body.trim(),
        },
      ],
    };
    TICKETS.unshift(newTicket);
    setSubmitted({ ref: `#${num}`, aggregated: false });
  };
  if (!publicSignedIn) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-md bg-surface/60 ring-1 ring-border rounded-xl p-8 text-center">
            <div className="size-12 mx-auto mb-4 bg-brand rounded-md grid place-items-center font-mono font-bold text-brand-foreground">
              R
            </div>
            <h1 className="text-xl font-semibold mb-2">
              Sign in to submit a ticket
            </h1>
            <p className="text-sm text-muted-foreground mb-1">
              Filing for{" "}
              <span className="text-foreground font-semibold">{org.name}</span>.
            </p>
            <p className="text-sm text-muted-foreground mb-6">
              We use your Steam profile to verify your in-game activity and
              prior history.
            </p>
            <button
              onClick={() => setPublicSignedIn(true)}
              className="w-full py-3 bg-[#171a21] hover:bg-[#1f242d] ring-1 ring-border text-white rounded-md text-sm font-semibold flex items-center justify-center gap-3 transition-colors"
            >
              <span className="font-mono text-xs uppercase tracking-widest text-[#66c0f4]">
                Steam
              </span>
              Sign in through Steam
            </button>
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
            <div className="size-10 mx-auto mb-4 bg-success/10 ring-1 ring-success/30 rounded-full grid place-items-center text-success font-bold">
              ✓
            </div>
            <h1 className="text-xl font-semibold mb-1">
              {submitted.aggregated
                ? "Added to existing case"
                : "Ticket submitted"}
            </h1>
            <p className="text-sm text-muted-foreground mb-2">
              {submitted.aggregated
                ? "Your evidence was attached to the open case "
                : "Your ticket reference is "}
              <span className="font-mono text-brand">{submitted.ref}</span>.
            </p>
            <p className="text-xs text-muted-foreground mb-6">
              Routed to{" "}
              <span className="text-foreground">
                {routedTeam ? TEAM_META[routedTeam].label : ""}
              </span>
              .
              {type === "player_report" ? (
                <>
                  {" "}
                  Track status in{" "}
                  <Link to="/my-reports" className="text-brand underline">
                    My Tickets
                  </Link>
                  .
                </>
              ) : (
                " You'll receive a Steam notification when staff reply."
              )}
            </p>

            <button
              onClick={() => {
                setSubmitted(null);
                setTitle("");
                setBody("");
                setDescription("");
                setEvidence("");
                setAssociatedIds([]);
              }}
              className="px-4 py-2 bg-surface ring-1 ring-border rounded text-xs font-semibold uppercase tracking-wider hover:bg-surface-bright"
            >
              Submit another
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8 space-y-8">
          <header>
            <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-2">
              {org.name} · Player Portal
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Submit a ticket
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-prose">
              Pick a ticket type. Reports require you to choose the server you
              saw the player on, then pick them from the live roster.
            </p>
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mt-3">
              Filing for {org.name}
            </p>
          </header>

          {/* Type picker */}
          <section className="space-y-3">
            <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
              Ticket type
            </label>
            <div className="grid grid-cols-2 gap-2">
              {TICKET_TYPES.map((t) => {
                const active = type === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setType(t.id)}
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
                        {t.label}
                      </p>
                      {active && (
                        <span className="size-1.5 rounded-full bg-brand" />
                      )}
                    </div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                      → {TEAM_META[TICKET_TYPE_ROUTING[t.id]].label}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Player report: progressive disclosure — only show next step when previous one is satisfied */}
          {type === "player_report" && (
            <section className="space-y-4">
              <div className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Step 1 · Server
                </label>
                <div className="grid grid-cols-1 gap-2">
                  {SERVERS.map((s) => {
                    const active = s.id === serverId;
                    return (
                      <button
                        key={s.id}
                        onClick={() => {
                          setServerId(s.id);
                          setSubjectId("");
                        }}
                        className={
                          "text-left px-4 py-3 rounded-lg ring-1 transition-colors flex items-center justify-between " +
                          (active
                            ? "bg-brand/10 ring-brand/30"
                            : "bg-surface/40 ring-border hover:bg-surface/70")
                        }
                      >
                        <div>
                          <p
                            className={
                              "text-sm font-semibold " +
                              (active ? "text-brand" : "text-foreground")
                            }
                          >
                            {s.name}
                          </p>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                            {s.region} · {s.playerIds.length} online
                          </p>
                        </div>
                        {active && (
                          <span className="size-1.5 rounded-full bg-brand" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {serverId && (
                <div className="space-y-3">
                  <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                    Step 2 · Reported player ({players.length} online on this
                    server)
                  </label>
                  <PlayerCombobox
                    players={players}
                    value={subjectId}
                    onChange={setSubjectId}
                    placeholder="Type a name or Steam ID — or scroll the list..."
                  />
                  {subject && subjectId && (
                    <div className="p-4 bg-background ring-1 ring-border rounded-md flex items-center gap-4">
                      <div
                        className="size-12 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0"
                        style={{ background: subject.avatarColor }}
                      >
                        {subject.name
                          .replace(/[\[\]]/g, "")
                          .slice(0, 2)
                          .toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate">
                          {subject.name}
                        </p>
                        <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                          Last seen {subject.lastSeen}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {subjectId && (
                <div className="space-y-3">
                  <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                    Step 3 · What did they do?
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {REPORT_CATEGORIES.map((c) => {
                      const active = category === c.id;
                      return (
                        <button
                          key={c.id}
                          onClick={() => setCategory(c.id)}
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
                  <p className="text-[10px] font-mono text-muted-foreground">
                    Each rule violation is its own ticket. Reporting the same
                    player for cheating AND teaming creates two separate cases.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* Title — non-report tickets only */}
          {type && type !== "player_report" && (
            <section className="space-y-3">
              <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary..."
                className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
              />
            </section>
          )}

          {type === "player_report"
            ? subjectId &&
              category && (
                <>
                  {category === "teaming" && (
                    <section className="space-y-3">
                      <label className="flex items-center justify-between text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                        <span>Associated players (optional)</span>
                        <span className="text-muted-foreground/70 normal-case tracking-normal font-mono">
                          up to {MAX_ASSOCIATED} · {associatedIds.length}/
                          {MAX_ASSOCIATED}
                        </span>
                      </label>
                      <p className="text-[11px] text-muted-foreground">
                        Add anyone you saw teaming with the reported player.
                        Each one you add is filed as being associated with this
                        player and counted on their teaming history.
                      </p>
                      {associatedPlayers.length > 0 && (
                        <ul className="space-y-1.5">
                          {associatedPlayers.map((p) => (
                            <li
                              key={p.steamId}
                              className="flex items-center gap-3 p-2 bg-background ring-1 ring-border rounded"
                            >
                              <div
                                className="size-7 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-[10px] text-background shrink-0"
                                style={{ background: p.avatarColor }}
                              >
                                {p.name
                                  .replace(/[\[\]]/g, "")
                                  .slice(0, 2)
                                  .toUpperCase()}
                              </div>
                              <span className="text-xs font-medium truncate flex-1">
                                {p.name}
                              </span>
                              <span className="text-[9px] font-mono text-muted-foreground truncate">
                                {p.steamId}
                              </span>
                              <button
                                onClick={() =>
                                  setAssociatedIds((ids) =>
                                    ids.filter((id) => id !== p.steamId),
                                  )
                                }
                                className="text-muted-foreground hover:text-foreground shrink-0"
                                title="Remove"
                              >
                                <XIcon size={14} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {canAddAssociated && (
                        <div>
                          <PlayerCombobox
                            players={associatedCandidates}
                            value=""
                            onChange={(id) => {
                              if (!id) return;
                              setAssociatedIds((ids) =>
                                ids.includes(id) || ids.length >= MAX_ASSOCIATED
                                  ? ids
                                  : [...ids, id],
                              );
                            }}
                            placeholder={
                              associatedIds.length === 0
                                ? "Add an associated player (optional)..."
                                : `Add another${associatedIds.length >= MAX_ASSOCIATED - 1 ? " (last one)" : ""}...`
                            }
                          />
                        </div>
                      )}
                      {!canAddAssociated &&
                        associatedIds.length >= MAX_ASSOCIATED && (
                          <p className="text-[10px] font-mono text-muted-foreground">
                            Maximum {MAX_ASSOCIATED} associated players reached.
                          </p>
                        )}
                    </section>
                  )}
                  <section className="space-y-3">
                    <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                      Step 4 · Description — what happened
                    </label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Describe what you saw. Grid coordinates, time of day, weapons used, anything unusual..."
                      className="w-full h-32 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                  </section>
                  <section className="space-y-3">
                    <label className="flex items-center justify-between text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                      <span>
                        Step 5 · Evidence (links to clips, screenshots,
                        recordings)
                      </span>
                      <span className="text-muted-foreground/70 normal-case tracking-normal font-mono">
                        optional but strongly recommended
                      </span>
                    </label>
                    <textarea
                      value={evidence}
                      onChange={(e) => setEvidence(e.target.value)}
                      placeholder="https://medal.tv/...&#10;https://youtu.be/...&#10;Imgur album link"
                      className="w-full h-28 bg-background border border-border rounded p-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Reports without evidence can be hidden by staff when
                      reviewing — only your name stays visible in the reporter
                      list.
                    </p>
                  </section>
                </>
              )
            : type
              ? title.trim() && (
                  <section className="space-y-3">
                    <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                      Details
                    </label>
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder="What happened? Include grid coordinates, timestamps, links to video if you have them..."
                      className="w-full h-40 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                  </section>
                )
              : null}

          {type && (
            <div className="flex justify-center pt-2">
              <button
                onClick={submit}
                disabled={
                  type === "player_report"
                    ? !description.trim() || !subjectId
                    : !body.trim() || !title.trim()
                }
                className="px-8 py-3 bg-brand text-brand-foreground text-sm font-semibold rounded-md ring-1 ring-brand hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                Submit ticket
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
export { Route };

import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SiteNav } from "@/components/site-nav";
import {
  TICKETS,
  TICKET_TYPES,
  getPlayer,
  REPORT_CATEGORY_LABEL,
} from "@/lib/mock-data";
const Route = createFileRoute("/my-reports")({
  validateSearch: (s) => ({
    org: typeof s.org === "string" ? s.org : void 0,
  }),
  head: () => ({
    meta: [
      { title: "My Tickets" },
      {
        name: "description",
        content:
          "Chat with staff on your tickets and track the status of players you've reported.",
      },
    ],
  }),
  component: MyTicketsPage,
});
const CURRENT_USER_ID = "76561198000000002";
const STATUS_TONE = {
  pending: "text-warning ring-warning/30 bg-warning/10",
  case_closed: "text-muted-foreground ring-border bg-surface",
  banned: "text-danger ring-danger/30 bg-danger/10",
};
const STATUS_LABEL = {
  pending: "Pending",
  case_closed: "Case closed",
  banned: "Banned",
};
const STATUS_BLURB = {
  pending:
    "Staff are actively investigating. We'll update you when there's a verdict.",
  case_closed:
    "We're no longer actively investigating this report. If you have more proof, send it and we'll reopen your case.",
  banned:
    "We banned the player you reported. Thanks for keeping the server clean.",
};
const TICKET_TYPE_LABEL = Object.fromEntries(
  TICKET_TYPES.map((t) => [t.id, t.label]),
);
const ORG_ROTATION = ["builders_sanctuary", "willjums"];
const orgForTicket = (number) => ORG_ROTATION[number % ORG_ROTATION.length];
function MyTicketsPage() {
  const { org: orgId } = Route.useSearch();
  const me = getPlayer(CURRENT_USER_ID);
  const [tab, setTab] = useState("tickets");
  const [tickets, setTickets] = useState(TICKETS);
  const [expanded, setExpanded] = useState(null);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState({});
  const scoped = useMemo(
    () =>
      orgId ? tickets.filter((t) => orgForTicket(t.number) === orgId) : tickets,
    [tickets, orgId],
  );
  const reportRows = useMemo(() => {
    const out = [];
    for (const t of scoped) {
      if (t.type !== "player_report" || !t.reports || !t.subjectId) continue;
      for (const r of t.reports) {
        if (r.reporterId === CURRENT_USER_ID) {
          out.push({
            ticketId: t.id,
            number: t.number,
            subjectId: t.subjectId,
            category: t.category,
            entry: r,
          });
        }
      }
    }
    return out.sort((a, b) =>
      b.entry.submittedAt.localeCompare(a.entry.submittedAt),
    );
  }, [scoped]);
  const myTickets = useMemo(
    () =>
      scoped.filter(
        (t) => t.type !== "player_report" && t.reporterId === CURRENT_USER_ID,
      ),
    [scoped],
  );
  const addProof = (row) => {
    if (!draft.trim()) return;
    setTickets((all) =>
      all.map((t) => {
        if (t.id !== row.ticketId || !t.reports) return t;
        return {
          ...t,
          status: t.status === "cleared" ? "open" : t.status,
          reports: t.reports.map((r) =>
            r.id === row.entry.id
              ? {
                  ...r,
                  status: r.status === "banned" ? "banned" : "pending",
                  evidence:
                    r.evidence.trim().length > 0
                      ? r.evidence + "\n\u2014 Update \u2014\n" + draft.trim()
                      : draft.trim(),
                  submittedLabel: "just now",
                }
              : r,
          ),
        };
      }),
    );
    setDraft("");
    setExpanded(null);
  };
  const sendReply = (ticketId) => {
    const body = (reply[ticketId] ?? "").trim();
    if (!body) return;
    const msg = {
      authorId: CURRENT_USER_ID,
      authorName: me.name,
      authorKind: "reporter",
      timestamp: "just now",
      body,
    };
    const shared = TICKETS.find((t) => t.id === ticketId);
    if (shared) shared.messages = [...shared.messages, msg];
    setTickets((all) =>
      all.map((t) =>
        t.id === ticketId ? { ...t, messages: [...t.messages, msg] } : t,
      ),
    );
    setReply((r) => ({ ...r, [ticketId]: "" }));
  };
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteNav />
      <main className="flex-1">
        <div className="max-w-3xl mx-auto p-8 space-y-6">
          <header>
            <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-2">
              Player Portal
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              My Tickets
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-prose">
              Signed in as <span className="text-foreground">{me.name}</span>.
            </p>
          </header>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border">
            {["tickets", "reports"].map((id) => {
              const active = tab === id;
              const count =
                id === "tickets" ? myTickets.length : reportRows.length;
              return (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={
                    "px-4 py-2.5 text-xs font-semibold uppercase tracking-wider border-b-2 -mb-px transition-colors " +
                    (active
                      ? "border-brand text-brand"
                      : "border-transparent text-muted-foreground hover:text-foreground")
                  }
                >
                  {id === "tickets" ? "Tickets" : "Player Reports"}
                  <span className="ml-2 text-[10px] font-mono opacity-70">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {tab === "tickets" &&
            (myTickets.length === 0 ? (
              <div className="bg-surface/40 ring-1 ring-border rounded-lg p-8 text-center">
                <p className="text-sm text-muted-foreground mb-4">
                  You haven't opened any tickets yet.
                </p>
                <Link
                  to="/submit"
                  className="inline-flex px-4 py-2 bg-brand text-brand-foreground rounded text-xs font-semibold uppercase tracking-wider"
                >
                  Open a ticket
                </Link>
              </div>
            ) : (
              <ul className="space-y-3">
                {myTickets.map((t) => {
                  const open = expanded === t.id;
                  const closed =
                    t.status === "closed" || t.status === "resolved";
                  return (
                    <li
                      key={t.id}
                      className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden"
                    >
                      <button
                        onClick={() => setExpanded(open ? null : t.id)}
                        className="w-full p-4 flex items-center gap-4 text-left hover:bg-surface/60"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold truncate">
                              {t.title}
                            </p>
                            <span className="text-[10px] font-mono text-muted-foreground">
                              #{t.number}
                            </span>
                          </div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                            {TICKET_TYPE_LABEL[t.type]} · opened{" "}
                            {t.createdLabel}
                          </p>
                        </div>
                        <span
                          className={
                            "text-[10px] font-bold uppercase tracking-wider ring-1 rounded px-2 py-0.5 " +
                            (closed
                              ? "text-muted-foreground ring-border bg-surface"
                              : "text-success ring-success/30 bg-success/10")
                          }
                        >
                          {closed ? "Closed" : "Active"}
                        </span>
                      </button>
                      {open && (
                        <div className="px-4 pb-4 space-y-3 border-t border-border bg-background/40">
                          <div className="space-y-2 pt-4">
                            {t.messages.length === 0 && (
                              <p className="text-xs italic text-muted-foreground">
                                No replies yet — staff will respond here.
                              </p>
                            )}
                            {t.messages.map((m, i) => {
                              const mine =
                                m.authorKind === "reporter" &&
                                m.authorId === CURRENT_USER_ID;
                              return (
                                <div
                                  key={i}
                                  className={
                                    "rounded-md p-3 ring-1 " +
                                    (m.authorKind === "system"
                                      ? "bg-surface/40 ring-border text-muted-foreground"
                                      : mine
                                        ? "bg-brand/10 ring-brand/20"
                                        : "bg-surface/60 ring-border")
                                  }
                                >
                                  <div className="flex items-center justify-between mb-1">
                                    <p className="text-[10px] font-mono uppercase tracking-wider">
                                      <span
                                        className={
                                          m.authorKind === "staff"
                                            ? "text-brand"
                                            : mine
                                              ? "text-foreground"
                                              : "text-muted-foreground"
                                        }
                                      >
                                        {m.authorName}
                                      </span>
                                      {m.authorKind === "staff" && (
                                        <span className="ml-2 text-muted-foreground">
                                          Staff
                                        </span>
                                      )}
                                    </p>
                                    <span className="text-[10px] font-mono text-muted-foreground">
                                      {m.timestamp}
                                    </span>
                                  </div>
                                  <p className="text-sm whitespace-pre-line leading-relaxed">
                                    {m.body}
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                          {!closed && (
                            <div className="space-y-2">
                              <textarea
                                value={reply[t.id] ?? ""}
                                onChange={(e) =>
                                  setReply((r) => ({
                                    ...r,
                                    [t.id]: e.target.value,
                                  }))
                                }
                                placeholder="Reply to staff..."
                                className="w-full h-20 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                              />
                              <div className="flex justify-end">
                                <button
                                  onClick={() => sendReply(t.id)}
                                  disabled={!(reply[t.id] ?? "").trim()}
                                  className="px-4 py-2 bg-brand text-brand-foreground text-xs font-semibold rounded uppercase tracking-wider disabled:opacity-40"
                                >
                                  Send reply
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ))}

          {tab === "reports" && (
            <>
              <p className="text-xs text-muted-foreground -mt-2">
                Reports never open a direct chat — but you can attach more proof
                to any pending or closed case.
              </p>
              {reportRows.length === 0 ? (
                <div className="bg-surface/40 ring-1 ring-border rounded-lg p-8 text-center">
                  <p className="text-sm text-muted-foreground mb-4">
                    You haven't reported any players yet.
                  </p>
                  <Link
                    to="/submit"
                    className="inline-flex px-4 py-2 bg-brand text-brand-foreground rounded text-xs font-semibold uppercase tracking-wider"
                  >
                    Report a player
                  </Link>
                </div>
              ) : (
                <ul className="space-y-3">
                  {reportRows.map((row) => {
                    const subject = getPlayer(row.subjectId);
                    const open = expanded === row.entry.id;
                    return (
                      <li
                        key={row.entry.id}
                        className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden"
                      >
                        <button
                          onClick={() =>
                            setExpanded(open ? null : row.entry.id)
                          }
                          className="w-full p-4 flex items-center gap-4 text-left hover:bg-surface/60"
                        >
                          <div
                            className="size-10 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0"
                            style={{ background: subject.avatarColor }}
                          >
                            {subject.name
                              .replace(/[\[\]]/g, "")
                              .slice(0, 2)
                              .toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold truncate">
                                {subject.name}
                              </p>
                              {row.category && (
                                <span className="text-[10px] font-mono uppercase tracking-wider ring-1 rounded px-1.5 py-0.5 bg-surface ring-border text-muted-foreground">
                                  {REPORT_CATEGORY_LABEL[row.category]}
                                </span>
                              )}
                              <span className="text-[10px] font-mono text-muted-foreground">
                                #{row.number}
                              </span>
                            </div>
                            <p className="text-[10px] font-mono text-muted-foreground">
                              Submitted {row.entry.submittedLabel}
                            </p>
                          </div>
                          <span
                            className={`text-[10px] font-bold uppercase tracking-wider ring-1 rounded px-2 py-0.5 ${STATUS_TONE[row.entry.status]}`}
                          >
                            {STATUS_LABEL[row.entry.status]}
                          </span>
                        </button>
                        {open && (
                          <div className="px-4 pb-4 space-y-4 border-t border-border bg-background/40">
                            <p className="text-xs text-muted-foreground italic mt-4">
                              {STATUS_BLURB[row.entry.status]}
                            </p>
                            <div>
                              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                                What you described
                              </p>
                              <p className="text-sm whitespace-pre-line text-foreground/90 leading-relaxed">
                                {row.entry.description}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                                Evidence you sent
                              </p>
                              {row.entry.evidence.trim().length > 0 ? (
                                <p className="text-sm whitespace-pre-line font-mono break-all text-foreground/90 leading-relaxed">
                                  {row.entry.evidence}
                                </p>
                              ) : (
                                <p className="text-xs text-muted-foreground italic">
                                  You didn't attach evidence. Staff are more
                                  likely to act when you add proof.
                                </p>
                              )}
                            </div>
                            {row.entry.status !== "banned" && (
                              <div className="space-y-2">
                                <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                                  Add more proof
                                </p>
                                <textarea
                                  value={draft}
                                  onChange={(e) => setDraft(e.target.value)}
                                  placeholder="Link a clip, add a timestamp, or describe new evidence..."
                                  className="w-full h-24 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                                />
                                <div className="flex justify-end">
                                  <button
                                    onClick={() => addProof(row)}
                                    disabled={!draft.trim()}
                                    className="px-4 py-2 bg-brand text-brand-foreground text-xs font-semibold rounded uppercase tracking-wider disabled:opacity-40"
                                  >
                                    Submit evidence
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
export { Route };

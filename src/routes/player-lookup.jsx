import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Search, ExternalLink } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { Slider } from "@/components/ui/slider";
import {
  deriveStats,
  pingTone,
  Field,
  OffensesTable,
  TeammatesSection,
  ServerHistorySection,
  HitDistanceSection,
  FriendlyRecipientsSection,
  ChatLogSection,
  KillFeedSection,
} from "@/components/player-sidebar";
import { BanDialog } from "@/components/ban-dialog";
import { AppealModerationActions } from "@/components/appeal-sidebar";
import { fmtNum, getPlayer, REPORT_CATEGORIES, TICKETS } from "@/lib/mock-data";
import { useAuth } from "@/lib/auth-context";
import { PlayerLinks } from "@/components/player-links";
import { LinkedAccountsSection } from "@/components/linked-accounts";
import { ExternalBansSection } from "@/components/external-bans";
import { PlayerNotesSection } from "@/components/player-notes";
import { Ban, MicOff } from "lucide-react";
const Route = createFileRoute("/player-lookup")({
  head: () => ({
    meta: [{ title: "Player Lookup \u2014 IronSight" }],
  }),
  validateSearch: (s) => ({
    steam:
      typeof s.steam === "string" && /^\d{17}$/.test(s.steam)
        ? s.steam
        : void 0,
  }),
  component: PlayerLookupPage,
});
function Avatar({ player, size = 64 }) {
  return (
    <div
      className="rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0"
      style={{
        width: size,
        height: size,
        background: player.avatarColor,
        fontSize: size / 2.6,
      }}
    >
      {player.name
        .replace(/[\[\]]/g, "")
        .slice(0, 2)
        .toUpperCase()}
    </div>
  );
}
function PlayerLookupPage() {
  const { selectedOrgIds, orgs, maxRankAcross } = useAuth();
  const isSupportOnly = maxRankAcross(selectedOrgIds) < 2;
  const search = Route.useSearch();
  const [input, setInput] = useState(search.steam ?? "");
  const [steamId, setSteamId] = useState(search.steam ?? null);
  const [banPickerOpen, setBanPickerOpen] = useState(false);
  const [banCategory, setBanCategory] = useState(null);
  const [muteOpen, setMuteOpen] = useState(false);
  useEffect(() => {
    if (search.steam && search.steam !== steamId) {
      setSteamId(search.steam);
      setInput(search.steam);
    }
  }, [search.steam, steamId]);
  const submit = (e) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (/^\d{17}$/.test(trimmed)) setSteamId(trimmed);
  };
  const subject = steamId ? getPlayer(steamId) : null;
  const stats = subject ? deriveStats(subject) : null;
  const banOrgId = selectedOrgIds[0] ?? orgs[0]?.id ?? "";
  const playerTickets = useMemo(() => {
    if (!subject) return [];
    return TICKETS.filter((t) =>
      t.type === "player_report"
        ? t.subjectId === subject.steamId
        : t.reporterId === subject.steamId,
    );
  }, [subject]);
  const alertSources = useMemo(() => {
    if (!subject) return [];
    const out = [];
    for (const t of TICKETS) {
      if (t.subjectId !== subject.steamId) continue;
      for (const m of t.messages) {
        if (m.body.startsWith("[F7 REPORT")) {
          out.push({ ticket: t, msg: m, kind: "f7" });
        } else if (m.body.startsWith("[THORIUM ALERT")) {
          out.push({ ticket: t, msg: m, kind: "thorium" });
        }
      }
    }
    return out;
  }, [subject]);
  const submitBan = (sub) => {
    console.log("Ban from lookup", { steamId, category: banCategory, ...sub });
    setBanCategory(null);
  };
  const submitMute = (sub) => {
    console.log("Mute from lookup", { steamId, ...sub });
    setMuteOpen(false);
  };
  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <SiteNav />
      <main className="flex-1 flex flex-col min-h-0">
        <div className="border-b border-border bg-surface/30 px-6 py-5">
          <div className="max-w-3xl mx-auto">
            <h1 className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground mb-2">
              Player Lookup
            </h1>
            <form onSubmit={submit} className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Paste a 17-digit Steam ID (e.g. 76561198000000001)"
                  className="w-full pl-9 pr-3 py-2.5 bg-background ring-1 ring-border rounded-md text-sm font-mono focus:outline-none focus:ring-brand"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2.5 bg-brand text-brand-foreground rounded-md text-sm font-semibold hover:opacity-90"
              >
                Lookup
              </button>
            </form>
            {input.trim().length > 0 && !/^\d{17}$/.test(input.trim()) && (
              <p className="mt-2 text-[11px] text-warning">
                Steam IDs are 17 digits.
              </p>
            )}
          </div>
        </div>

        {!subject || !stats ? (
          <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
            Enter a Steam ID above to see everything we have on a player.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
              {/* Summary profile */}
              <section>
                <div className="bg-surface/60 ring-1 ring-border rounded-lg p-5">
                  <div className="flex items-center justify-between gap-4 mb-5">
                    <div className="flex items-center gap-4 min-w-0">
                      <Avatar player={subject} size={64} />
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold truncate">
                          {subject.name}
                        </h2>
                        <p className="text-[11px] font-mono text-muted-foreground uppercase truncate flex items-center gap-1.5">
                          {subject.steamId}
                          <PlayerLinks steamId={subject.steamId} size="sm" />
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <AppealModerationActions appellant={subject} />
                      <button
                        onClick={() => setMuteOpen(true)}
                        className="flex items-center gap-2 px-3 py-2 bg-warning/15 text-warning ring-1 ring-warning/40 rounded-md text-xs font-semibold uppercase tracking-widest hover:bg-warning/25"
                      >
                        <MicOff className="size-3.5" />
                        Mute
                      </button>
                      {!isSupportOnly && (
                        <div className="relative">
                          <button
                            onClick={() => setBanPickerOpen((v) => !v)}
                            className="flex items-center gap-2 px-3 py-2 bg-danger text-danger-foreground rounded-md text-xs font-semibold uppercase tracking-widest hover:opacity-90"
                          >
                            <Ban className="size-3.5" />
                            Ban
                          </button>
                          {banPickerOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-40"
                                onClick={() => setBanPickerOpen(false)}
                              />
                              <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-background ring-1 ring-border rounded-md shadow-lg p-1">
                                <p className="px-2 py-1.5 text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                                  Ban category
                                </p>
                                {REPORT_CATEGORIES.map((c) => (
                                  <button
                                    key={c.id}
                                    onClick={() => {
                                      setBanPickerOpen(false);
                                      setBanCategory(c.id);
                                    }}
                                    className="w-full text-left px-2 py-1.5 text-xs hover:bg-surface rounded"
                                  >
                                    {c.label}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {!isSupportOnly && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-y-4 gap-x-6">
                      <Field
                        label="S-Hours"
                        value={fmtNum(subject.playtimeHours)}
                      />
                      <Field label="BM-Hours" value={fmtNum(stats.bmHours)} />
                      <Field label="AT-Hours" value={fmtNum(stats.atHours)} />
                      <Field label="K.D" value={stats.kd.toFixed(2)} />
                      <Field label="Hit %" value={`${stats.hitPct}%`} />
                      <Field
                        label="Proxy"
                        value={stats.proxy ? "True" : "False"}
                        tone={stats.proxy ? "danger" : "success"}
                      />
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase">
                          Location
                        </p>
                        <p className="text-sm font-mono text-foreground flex items-center gap-1.5">
                          {subject.country}
                          <span
                            className={`inline-block size-1.5 rounded-full ${pingTone(stats.pingMs).color}`}
                            title={`${stats.pingMs}ms ping`}
                          />
                          <span className="text-[10px] text-muted-foreground">
                            {stats.pingMs}ms
                          </span>
                        </p>
                      </div>
                      <Field label="Last Seen" value={subject.lastSeen} />
                    </div>
                  )}
                </div>
              </section>

              {/* Notes — staff-authored, permission-gated, pinnable */}
              <PlayerNotesSection subjectId={subject.steamId} />

              {/* Tickets — quick hyperlinks to every related ticket */}
              <PlayerTicketsSection
                subjectId={subject.steamId}
                tickets={playerTickets}
              />

              {/* Previous Offenses — support only sees mutes */}
              {(() => {
                const visible = isSupportOnly
                  ? stats.offenses.filter((o) => o.type === "Mute")
                  : stats.offenses;
                return (
                  <section>
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
                      <span>Previous Offenses</span>
                      <span className="font-mono normal-case tracking-normal text-muted-foreground">
                        {visible.length}
                      </span>
                    </h3>
                    {visible.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">
                        No prior offenses.
                      </p>
                    ) : (
                      <OffensesTable offenses={visible} />
                    )}
                  </section>
                );
              })()}

              {/* Bans on other orgs — read-only, shared from partner orgs' banlists */}
              {!isSupportOnly && (
                <ExternalBansSection subjectId={subject.steamId} />
              )}

              {/* Alerts — browse each F7 report / Thorium alert ever raised against this player */}
              <AlertBrowser entries={alertSources} />

              {/* Linked accounts — IP-overlap intel. Hidden from support, IPs masked for admins. */}
              {!isSupportOnly && (
                <LinkedAccountsSection
                  subjectId={subject.steamId}
                  subjectName={subject.name}
                  canSeeRealIp={maxRankAcross(selectedOrgIds) >= 3}
                />
              )}

              {/* Hit % by Distance */}
              {!isSupportOnly && (
                <HitDistanceSection subjectId={subject.steamId} />
              )}

              {/* Current team + Previous team + Associated players — 1x3 horizontal row */}
              {!isSupportOnly && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <TeammatesSection
                    subjectId={subject.steamId}
                    category="teaming"
                    only="current"
                  />
                  <TeammatesSection
                    subjectId={subject.steamId}
                    category="teaming"
                    only="previous"
                  />
                  <FriendlyRecipientsSection
                    subjectId={subject.steamId}
                    serverId={null}
                  />
                </div>
              )}
              {isSupportOnly && (
                <FriendlyRecipientsSection
                  subjectId={subject.steamId}
                  serverId={null}
                />
              )}

              {/* Server History */}
              {!isSupportOnly && (
                <ServerHistorySection
                  subjectId={subject.steamId}
                  isOnline={subject.lastSeen.startsWith("Now")}
                />
              )}

              {/* Chat Log + Kill Feed — 1x2 horizontal grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ChatLogSection subjectId={subject.steamId} />
                <KillFeedSection subjectId={subject.steamId} />
              </div>
            </div>
          </div>
        )}

        {subject && (
          <BanDialog
            open={muteOpen}
            onOpenChange={setMuteOpen}
            orgId={banOrgId}
            category="toxicity"
            subjectName={subject.name}
            onSubmit={submitMute}
            mode="mute"
          />
        )}
      </main>

      {subject && banCategory && (
        <BanDialog
          open={banCategory !== null}
          onOpenChange={(v) => {
            if (!v) setBanCategory(null);
          }}
          orgId={banOrgId}
          category={banCategory}
          subjectName={subject.name}
          onSubmit={submitBan}
        />
      )}
    </div>
  );
}
function AlertBrowser({ entries }) {
  const F7_COLOR = "#f59e0b";
  const TH_COLOR = "#ec4899";
  const kindFill = (kind) => (kind === "thorium" ? TH_COLOR : F7_COLOR);
  const [dayWindow, setDayWindow] = useState(90);
  const W = 600;
  const H = 110;
  const PAD_L = 12;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const NOW = Date.now();
  const aged = useMemo(() => {
    return entries.map((e) => {
      const when = e.msg.occurredAt
        ? Date.parse(e.msg.occurredAt)
        : Date.parse(e.ticket.createdAt);
      const ageDays = Math.max(0, (NOW - when) / 864e5);
      return { entry: e, ageDays };
    });
  }, [entries, NOW]);
  const visible = useMemo(
    () => aged.filter((a) => a.ageDays <= dayWindow),
    [aged, dayWindow],
  );
  const f7Visible = visible.filter((v) => v.entry.kind === "f7").length;
  const thVisible = visible.filter((v) => v.entry.kind === "thorium").length;
  const points = useMemo(() => {
    const bucketSize = Math.max(0.25, dayWindow / 40);
    const byBucket = /* @__PURE__ */ new Map();
    return visible.map((v) => {
      const bucket = Math.floor(v.ageDays / bucketSize);
      const stackIndex = byBucket.get(bucket) ?? 0;
      byBucket.set(bucket, stackIndex + 1);
      const x = PAD_L + ((dayWindow - v.ageDays) / dayWindow) * innerW;
      const baseY = PAD_T + innerH;
      const y = baseY - 2 - stackIndex * 10;
      return { entry: v.entry, ageDays: v.ageDays, x, y };
    });
  }, [visible, dayWindow, innerW, innerH]);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [pinnedIdx, setPinnedIdx] = useState(null);
  const activeIdx = pinnedIdx !== null ? pinnedIdx : hoverIdx;
  const active = activeIdx !== null ? points[activeIdx] : null;
  const ticks = useMemo(() => {
    const stops = [0, 0.25, 0.5, 0.75, 1];
    return stops.map((s) => Math.round(s * dayWindow));
  }, [dayWindow]);
  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: F7_COLOR }}
            />
            <span style={{ color: F7_COLOR }}>F7</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: TH_COLOR }}
            />
            <span style={{ color: TH_COLOR }}>Thorium</span>
          </span>
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {f7Visible > 0 && (
            <span className="mr-2" style={{ color: F7_COLOR }}>
              {f7Visible} F7
            </span>
          )}
          {thVisible > 0 && (
            <span style={{ color: TH_COLOR }}>{thVisible} Thorium</span>
          )}
          {visible.length === 0 && "0 alerts"}
          <span className="ml-2 text-muted-foreground">
            · last {dayWindow}d
          </span>
        </span>
      </h3>

      {/* Day-window slider */}
      <div className="flex items-center gap-3 mb-2 px-1">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground shrink-0">
          Window
        </span>
        <Slider
          value={[dayWindow]}
          onValueChange={(v) => setDayWindow(v[0] ?? 90)}
          min={1}
          max={90}
          step={1}
          className="flex-1"
        />
        <span className="text-[10px] font-mono tabular-nums text-foreground w-12 text-right">
          {dayWindow}d
        </span>
      </div>

      <div className="relative rounded-lg ring-1 ring-border/50 bg-surface/30 p-2">
        {visible.length === 0 ? (
          <div className="px-1 py-6 text-xs text-muted-foreground italic text-center">
            No F7 reports or Thorium alerts in the last {dayWindow} day
            {dayWindow === 1 ? "" : "s"}.
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-auto block"
            preserveAspectRatio="none"
            onMouseLeave={() => setHoverIdx(null)}
          >
            {/* baseline */}
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={PAD_T + innerH}
              y2={PAD_T + innerH}
              stroke="currentColor"
              strokeOpacity={0.25}
            />
            {/* tick marks + labels */}
            {ticks.map((d, i) => {
              const x = PAD_L + ((dayWindow - d) / dayWindow) * innerW;
              return (
                <g key={`${d}-${i}`} className="text-muted-foreground">
                  <line
                    x1={x}
                    x2={x}
                    y1={PAD_T + innerH}
                    y2={PAD_T + innerH + 3}
                    stroke="currentColor"
                    strokeOpacity={0.4}
                  />
                  <text
                    x={x}
                    y={H - 6}
                    textAnchor="middle"
                    fontSize={9}
                    fontFamily="ui-monospace, monospace"
                    fill="currentColor"
                    opacity={0.65}
                  >
                    {d === 0 ? "today" : `${d}d`}
                  </text>
                </g>
              );
            })}
            {/* Map-pin markers: circle head + triangle tail, tip on baseline */}
            {points.map((p, i) => {
              const isActive = activeIdx === i;
              const fill = kindFill(p.entry.kind);
              const headR = isActive ? 7 : 5.5;
              const headCy = -10;
              const tailW = isActive ? 4.5 : 3.5;
              return (
                <g key={i}>
                  {/* invisible hit target */}
                  <rect
                    x={p.x - 10}
                    y={p.y - 22}
                    width={20}
                    height={26}
                    fill="transparent"
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setHoverIdx(i)}
                    onClick={() =>
                      setPinnedIdx((prev) => (prev === i ? null : i))
                    }
                  />
                  <g
                    transform={`translate(${p.x}, ${p.y})`}
                    style={{ pointerEvents: "none" }}
                  >
                    {/* glow ring on active */}
                    {isActive && (
                      <circle
                        cx={0}
                        cy={headCy}
                        r={headR + 5}
                        fill={fill}
                        opacity={0.18}
                      />
                    )}
                    {/* triangle tail */}
                    <path
                      d={`M${-tailW},${headCy + 2} L${tailW},${headCy + 2} L0,0 Z`}
                      fill={fill}
                      opacity={isActive ? 1 : 0.95}
                    />
                    {/* circle head with white outline for separation */}
                    <circle
                      cx={0}
                      cy={headCy}
                      r={headR}
                      fill={fill}
                      stroke="#ffffff"
                      strokeWidth={1.5}
                      opacity={isActive ? 1 : 0.95}
                    />
                    {/* inner dot */}
                    <circle cx={0} cy={headCy} r={headR * 0.4} fill="#ffffff" />
                  </g>
                </g>
              );
            })}
          </svg>
        )}

        {/* Popup */}
        {active && (
          <div
            className="absolute z-20 left-2 right-2 bottom-2 rounded-md ring-1 ring-border/60 bg-background/95 backdrop-blur shadow-lg overflow-hidden"
            onMouseEnter={() => {
              if (pinnedIdx === null) setHoverIdx(activeIdx);
            }}
          >
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/60">
              <Link
                to="/"
                search={{ ticket: active.entry.ticket.id }}
                className="flex items-center gap-1 text-[10px] font-mono text-brand hover:underline truncate"
                title={active.entry.ticket.title}
              >
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={{ background: kindFill(active.entry.kind) }}
                />
                #{active.entry.ticket.number} · {active.entry.ticket.title}
                <ExternalLink className="size-3 shrink-0" />
              </Link>
              <div className="flex items-center gap-2">
                {pinnedIdx !== null && (
                  <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                    pinned
                  </span>
                )}
                <button
                  onClick={() => {
                    setPinnedIdx(null);
                    setHoverIdx(null);
                  }}
                  className="text-[10px] font-mono text-muted-foreground hover:text-foreground px-1"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>
            <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-foreground leading-relaxed max-h-40 overflow-auto select-text">
              {active.entry.msg.body}
            </pre>
            <div className="px-3 py-1.5 border-t border-border/60 text-[10px] font-mono text-muted-foreground">
              {active.entry.msg.authorName} ·{" "}
              {active.entry.msg.occurredAt
                ? new Date(active.entry.msg.occurredAt).toLocaleString()
                : active.entry.msg.timestamp}
              {" \xB7 "}
              {active.ageDays < 1
                ? "today"
                : `${Math.round(active.ageDays)}d ago`}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
const STATUS_GROUP = {
  open: "active",
  triage: "active",
  in_progress: "active",
  waiting_response: "waiting",
  resolved: "closed",
  closed: "closed",
  cleared: "closed",
  banned: "closed",
};
function PlayerTicketsSection({ subjectId, tickets }) {
  const groups = {
    active: [],
    waiting: [],
    closed: [],
  };
  for (const t of tickets) groups[STATUS_GROUP[t.status]].push(t);
  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>Tickets</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {tickets.length}
        </span>
      </h3>
      {tickets.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No tickets involving this player.
        </p>
      ) : (
        <div className="space-y-3">
          {["active", "waiting", "closed"].map((g) =>
            groups[g].length === 0 ? null : (
              <TicketGroup
                key={g}
                label={g}
                subjectId={subjectId}
                tickets={groups[g]}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}
function TicketGroup({ label, subjectId, tickets }) {
  const labelTone =
    label === "active"
      ? "text-success"
      : label === "waiting"
        ? "text-warning"
        : "text-muted-foreground";
  return (
    <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 border-b border-border/60 flex items-center justify-between">
        <span
          className={`text-[10px] font-mono uppercase tracking-widest ${labelTone}`}
        >
          {label}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          {tickets.length}
        </span>
      </div>
      <ul className="divide-y divide-border/60">
        {tickets.map((t) => {
          const role = t.subjectId === subjectId ? "Subject" : "Reporter";
          return (
            <li key={t.id}>
              <Link
                to="/"
                search={{ ticket: t.id }}
                className="flex items-center gap-3 px-3 py-2 hover:bg-surface group"
              >
                <span className="text-[10px] font-mono text-muted-foreground w-14 shrink-0">
                  #{t.number}
                </span>
                <span className="text-xs font-medium truncate flex-1 group-hover:text-brand">
                  {t.title}
                </span>
                <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground shrink-0">
                  {role}
                </span>
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                  {t.createdLabel}
                </span>
                <ExternalLink className="size-3 text-muted-foreground group-hover:text-brand shrink-0" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
export { Route };

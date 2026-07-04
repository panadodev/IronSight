import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  UsersRound,
  Server as ServerIcon,
  X,
  Handshake,
  Flag,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { fmtNum } from "@/lib/constants";

// Stubs for live data that requires game-server integration (team rosters, server
// player lists). Returns empty so the UI shows "no data" rather than fake entries.
const getTeammates = () => [];
const getPreviousTeammates = () => [];
const getServerPlayers = () => [];
// Resolves a display object for a Steam ID when no rich player data is available.
const getPlayer = (steamId) => ({
  name: steamId ? String(steamId).slice(-5) : "?",
  steamId: steamId ?? "",
  avatar: null,
  playtimeHours: null,
  country: null,
  lastSeen: null,
});
import {
  getAssociationsFor,
  addAssociationReports,
  hideAssociation,
  unhideAssociation,
  isAssociationHidden,
} from "@/lib/associations";
import { Hint, HINTS } from "@/components/hint";
import { useAuth } from "@/lib/auth-context";
import { PlayerLinks } from "@/components/player-links";
import { ExternalBansSection } from "@/components/external-bans";
import { LinkedAccountIntelSection } from "@/components/linked-accounts";
import { PinnedPlayerNotesSection } from "@/components/player-notes";
function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="inline-flex items-center justify-center rounded hover:bg-muted transition-colors p-0.5 -mr-0.5"
      title={done ? "Copied" : "Copy Steam ID"}
    >
      <Copy
        size={10}
        className={done ? "text-success" : "text-muted-foreground"}
      />
    </button>
  );
}
function Avatar({ player, size = 48 }) {
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
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
// Returns the offense/stat shape that the sidebar components expect.
// Filled with nulls until real ban-history data is wired from the API.
export function deriveStats(_p) {
  return {
    bmHours: null,
    proxy: false,
    pingMs: null,
    kd: null,
    hitPct: null,
    atHours: null,
    offenses: [],
  };
}
function pingTone(ms) {
  if (ms < 80) return { color: "bg-success", label: "good" };
  if (ms < 160) return { color: "bg-warning", label: "ok" };
  return { color: "bg-danger", label: "high" };
}
function PlayerSidebar({
  subject,
  reporter,
  team,
  reports,
  category,
  serverId,
  ticketStatus,
  onAutoReopen,
  messages,
  orgId,
}) {
  const d = subject ? deriveStats(subject) : null;
  const { rankOf, selectedOrgIds, maxRankAcross, hasOrgPermission } = useAuth();
  const effectiveRank = orgId ? rankOf(orgId) : maxRankAcross(selectedOrgIds);
  const canSeeIp = orgId
    ? hasOrgPermission(orgId, "ip_read")
    : selectedOrgIds.some((id) => hasOrgPermission(id, "ip_read"));
  const isSupportOnly = effectiveRank < 2;
  const visibleOffenses = d
    ? isSupportOnly
      ? d.offenses.filter((o) => o.type === "Mute")
      : d.offenses
    : [];
  void team;
  return (
    <aside className="w-[28rem] shrink-0 border-l border-border bg-background overflow-y-auto">
      <div className="p-6 space-y-8">
        {subject && d && (
          <section>
            <div className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
              <div className="flex items-center gap-3 mb-4">
                <Avatar player={subject} size={48} />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold truncate">
                    {subject.name}
                  </h3>
                  <p className="text-[0.625rem] font-mono text-muted-foreground uppercase truncate flex items-center gap-1">
                    {subject.steamId}
                    <CopyBtn text={subject.steamId} />
                    <PlayerLinks steamId={subject.steamId} size="sm" />
                  </p>
                </div>
              </div>
              {!isSupportOnly && (
                <div className="grid grid-cols-2 gap-y-3">
                  {category === "cheating" ? (
                    <>
                      <Field
                        label="S-Hours"
                        value={fmtNum(subject.playtimeHours)}
                        hint={HINTS.steamHours}
                      />
                      <Field
                        label="BM-Hours"
                        value={fmtNum(d.bmHours)}
                        hint={HINTS.bmHours}
                      />
                      <Field
                        label="AIM-TRAIN Hours"
                        value={fmtNum(d.atHours)}
                        hint={HINTS.atHours}
                      />
                      <Field
                        label="K.D"
                        value={d.kd.toFixed(2)}
                        hint={HINTS.kd}
                      />
                      <Field
                        label="Proxy"
                        value={d.proxy ? "True" : "False"}
                        tone={d.proxy ? "danger" : "success"}
                        hint={HINTS.proxy}
                      />
                      <div>
                        <p className="text-[0.625rem] text-muted-foreground uppercase">
                          Location
                        </p>
                        <p className="text-sm font-mono text-foreground flex items-center gap-1.5">
                          {canSeeIp ? subject.country : "—"}
                          <span
                            className={`inline-block size-1.5 rounded-full ${pingTone(d.pingMs).color}`}
                            title={`${d.pingMs}ms ping`}
                          />
                          <span className="text-[0.625rem] text-muted-foreground">
                            {d.pingMs}ms
                          </span>
                        </p>
                      </div>
                    </>
                  ) : category === "teaming" ? (
                    <>
                      <Field
                        label="S-Hours"
                        value={fmtNum(subject.playtimeHours)}
                        hint={HINTS.steamHours}
                      />
                      <Field
                        label="BM-Hours"
                        value={fmtNum(d.bmHours)}
                        hint={HINTS.bmHours}
                      />
                    </>
                  ) : category === "toxicity" ? null : (
                    <>
                      <Field
                        label="S-Hours"
                        value={fmtNum(subject.playtimeHours)}
                        hint={HINTS.steamHours}
                      />
                      <Field
                        label="BM-Hours"
                        value={fmtNum(d.bmHours)}
                        hint={HINTS.bmHours}
                      />
                      <Field
                        label="Proxy"
                        value={d.proxy ? "True" : "False"}
                        tone={d.proxy ? "danger" : "success"}
                        hint={HINTS.proxy}
                      />
                      <div>
                        <p className="text-[0.625rem] text-muted-foreground uppercase">
                          Location
                        </p>
                        <p className="text-sm font-mono text-foreground flex items-center gap-1.5">
                          {canSeeIp ? subject.country : "—"}
                          <span
                            className={`inline-block size-1.5 rounded-full ${pingTone(d.pingMs).color}`}
                            title={`${d.pingMs}ms ping`}
                          />
                          <span className="text-[0.625rem] text-muted-foreground">
                            {d.pingMs}ms
                          </span>
                        </p>
                      </div>
                      <Field label="K.D" value={d.kd.toFixed(2)} />
                      <Field label="Hit %" value={`${d.hitPct}%`} />
                    </>
                  )}
                </div>
              )}
              {!isSupportOnly &&
                category !== "cheating" &&
                category !== "teaming" && (
                  <div
                    className={
                      category === "toxicity"
                        ? ""
                        : "mt-3 pt-3 border-t border-border"
                    }
                  >
                    <Field label="Last Seen" value={subject.lastSeen} />
                  </div>
                )}
            </div>
          </section>
        )}

        {subject && d && (
          <section>
            <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
              <span>Previous Offenses</span>
              <span className="font-mono normal-case tracking-normal text-muted-foreground">
                {visibleOffenses.length}
              </span>
            </h2>
            {visibleOffenses.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No prior offenses.
              </p>
            ) : (
              <OffensesTable offenses={visibleOffenses} />
            )}
          </section>
        )}

        {subject && category === "cheating" && (
          <ExternalBansSection subjectId={subject.steamId} />
        )}

        {subject && category === "cheating" && !isSupportOnly && (
          <LinkedAccountIntelSection
            subjectId={subject.steamId}
            subjectName={subject.name}
          />
        )}

        {subject && category === "cheating" && (
          <AlertsSection messages={messages ?? []} />
        )}

        {subject && category === "cheating" && (
          <HitDistanceSection subjectId={subject.steamId} />
        )}

        {subject && category === "teaming" && (
          <FriendlyRecipientsSection
            subjectId={subject.steamId}
            subjectName={subject.name}
            serverId={serverId ?? null}
          />
        )}

        {subject && !isSupportOnly && category !== "toxicity" && (
          <TeammatesSection subjectId={subject.steamId} category={category} />
        )}

        {subject && category === "toxicity" && (
          <ChatLogSection
            subjectId={subject.steamId}
            ticketStatus={ticketStatus}
            onAutoReopen={onAutoReopen}
          />
        )}

        {subject &&
          !isSupportOnly &&
          category !== "teaming" &&
          category !== "toxicity" &&
          category !== "other" && (
            <ServerHistorySection
              subjectId={subject.steamId}
              isOnline={subject?.lastSeen?.startsWith("Now") ?? false}
            />
          )}

        {reports ? (
          <ReportersSection reports={reports} />
        ) : (
          <section>
            <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4">
              Reporter
            </h2>
            <div className="flex items-center gap-3">
              <Avatar player={reporter} size={28} />
              <div className="min-w-0 flex-1 flex items-center justify-between gap-2">
                <p className="text-sm font-medium truncate">{reporter.name}</p>
                <p className="text-[0.625rem] font-mono text-muted-foreground shrink-0">
                  {fmtNum(reporter.playtimeHours)}h
                </p>
              </div>
            </div>
          </section>
        )}

        {subject && (
          <PinnedPlayerNotesSection subjectId={subject.steamId} orgId={orgId} />
        )}
      </div>
    </aside>
  );
}
function ReportersSection({ reports }) {
  const [open, setOpen] = useState(false);
  const visible = open ? reports : reports.slice(0, 3);
  const pending = reports.filter((r) => r.status === "pending").length;
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center justify-between">
        <span>Reporters · {reports.length}</span>
        <span className="text-warning font-mono normal-case tracking-normal">
          {pending} pending
        </span>
      </h2>
      <ul className="space-y-1.5">
        {visible.map((r) => {
          const p = getPlayer(r.reporterId);
          const tone =
            r.status === "banned"
              ? "text-danger"
              : r.status === "case_closed"
                ? "text-muted-foreground"
                : "text-warning";
          return (
            <li
              key={r.id}
              className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1.5"
            >
              <Avatar player={p} size={20} />
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <p className="text-xs font-medium truncate">{p.name}</p>
                <span className="text-[0.625rem] font-mono text-muted-foreground shrink-0">
                  {r.submittedLabel}
                </span>
              </div>
              <span
                className={`text-[0.625rem] font-mono uppercase font-bold tracking-wider ${tone}`}
              >
                {r.status === "case_closed" ? "closed" : r.status}
              </span>
            </li>
          );
        })}
      </ul>
      {reports.length > 3 && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-2 text-[0.625rem] font-mono uppercase tracking-widest text-brand hover:underline"
        >
          {open ? "Collapse" : `Show ${reports.length - 3} more`}
        </button>
      )}
    </section>
  );
}
function TeammatesSection({ subjectId, category, only }) {
  const mates = getTeammates(subjectId);
  const showPrevious = category === "teaming";
  const previous = showPrevious ? getPreviousTeammates(subjectId) : [];
  const showCurrentBlock = only !== "previous";
  const showPreviousBlock = showPrevious && only !== "current";
  return (
    <section className="space-y-4">
      {showCurrentBlock && (
        <div>
          <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
            <span>
              {showPrevious ? "Current team" : "Team"} · {mates.length}
            </span>
          </h2>
          {mates.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Solo player.</p>
          ) : (
            <ul className="space-y-1.5">
              {mates.map((t) => (
                <li
                  key={t.player.steamId}
                  className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1"
                >
                  <span
                    className={`size-1.5 rounded-full shrink-0 ${t.online ? "bg-success" : "bg-danger"}`}
                    title={t.online ? "Online" : "Offline"}
                  />
                  <span className="text-[0.625rem] font-medium truncate min-w-0">
                    {t.player.name}
                  </span>
                  <span className="text-[0.625rem] font-mono text-muted-foreground flex items-center gap-1 shrink-0">
                    <CopyBtn text={t.player.steamId} />
                    <PlayerLinks steamId={t.player.steamId} />
                  </span>

                  <span
                    className="text-[0.625rem] font-mono text-muted-foreground shrink-0 ml-auto"
                    title={`Joined ${t.joinedLabel}`}
                  >
                    joined {t.joinedLabel}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showPreviousBlock && (
        <div>
          <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
            <span>Previous team members · {previous.length}</span>
          </h2>
          {previous.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No prior teammates on record.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {previous.map((t) => (
                <li
                  key={t.player.steamId}
                  className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1"
                >
                  <span
                    className="size-1.5 rounded-full shrink-0 bg-muted-foreground/50"
                    title="Left team"
                  />
                  <span className="text-[0.625rem] font-medium truncate min-w-0">
                    {t.player.name}
                  </span>
                  <span className="text-[0.625rem] font-mono text-muted-foreground flex items-center gap-1 shrink-0">
                    <CopyBtn text={t.player.steamId} />
                    <PlayerLinks steamId={t.player.steamId} />
                  </span>

                  <span
                    className="text-[0.625rem] font-mono text-muted-foreground shrink-0 ml-auto"
                    title={`Left ${t.leftLabel}`}
                  >
                    left {t.leftLabel}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
function OffensesTable({ offenses }) {
  const [openId, setOpenId] = useState(null);
  const open = offenses.find((o) => o.id === openId) ?? null;
  return (
    <>
      <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
        <table className="w-full text-[0.625rem] font-mono">
          <thead>
            <tr className="text-[0.625rem] uppercase tracking-wider text-muted-foreground bg-surface/60">
              <th className="px-1.5 py-1 text-left font-medium">Type</th>
              <th className="px-1.5 py-1 text-left font-medium">Status</th>
              <th className="px-1.5 py-1 text-left font-medium">Reason</th>
              <th className="px-1.5 py-1 text-left font-medium">Staff</th>
              <th className="px-1.5 py-1 text-left font-medium">Note</th>
              <th className="px-1.5 py-1 text-right font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {offenses.map((o) => {
              const statusColor =
                o.statusTone === "danger"
                  ? "text-danger"
                  : o.statusTone === "warning"
                    ? "text-warning"
                    : "text-muted-foreground";
              return (
                <tr key={o.id} className="border-t border-border">
                  <td
                    className={`px-1.5 py-1 font-bold uppercase ${o.type === "Ban" ? "text-danger" : "text-warning"}`}
                  >
                    {o.type}
                  </td>
                  <td className={`px-1.5 py-1 ${statusColor}`}>{o.status}</td>
                  <td className="px-1.5 py-1 text-foreground">{o.reason}</td>
                  <td className="px-1.5 py-1 text-muted-foreground">{o.by}</td>
                  <td className="px-1.5 py-1">
                    <button
                      onClick={() => setOpenId(o.id)}
                      className="text-brand hover:underline"
                    >
                      view
                    </button>
                  </td>
                  <td className="px-1.5 py-1 text-right text-muted-foreground">
                    {o.when}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          onClick={() => setOpenId(null)}
        >
          <div
            className="bg-background ring-1 ring-border rounded-lg p-5 max-w-md w-full shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">
                <span
                  className={
                    open.type === "Ban" ? "text-danger" : "text-warning"
                  }
                >
                  {open.type}
                </span>{" "}
                · {open.reason}
              </h3>
              <button
                onClick={() => setOpenId(null)}
                className="text-[0.625rem] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                close
              </button>
            </div>
            <p className="text-[0.625rem] font-mono text-muted-foreground uppercase mb-2">
              by {open.by} · {open.when} · {open.status}
            </p>
            <p className="text-sm text-foreground leading-relaxed">
              {open.note}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
function alertTitle(kind, body) {
  if (kind === "thorium") {
    const m = body.match(/\[THORIUM ALERT · ([^\]]+)\]\s*(?:\[(\d+%)\])?/);
    if (m) return m[2] ? `${m[1]} \xB7 ${m[2]}` : m[1];
    return "Thorium alert";
  }
  const d = body.match(/Description:\s*"([^"]+)"/);
  if (d) return d[1];
  const r = body.match(/Reporter:\s*([^·]+)/);
  return r ? `Reporter: ${r[1].trim()}` : "F7 report";
}
function AlertCategoryGroup({ kind, label, items, toneClass }) {
  const [open, setOpen] = useState(false);
  const [openItem, setOpenItem] = useState(null);
  const count = items.length;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={count === 0}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-surface/60 transition-colors disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
          <span
            className={
              "inline-block text-[0.5625rem] font-mono transition-transform " +
              (open ? "rotate-90" : "")
            }
          >
            ▶
          </span>
          {label}
        </span>
        <span
          className={`text-xs font-mono font-bold ${count > 0 ? toneClass : "text-muted-foreground"}`}
        >
          {count}
        </span>
      </button>
      {open && count > 0 && (
        <div className="bg-background/40 border-t border-border">
          {items.map((m, i) => {
            const title = alertTitle(kind, m.body);
            const expanded = openItem === i;
            return (
              <div key={i} className="border-b border-border last:border-0">
                <button
                  type="button"
                  onClick={() => setOpenItem(expanded ? null : i)}
                  className="w-full text-left px-3 py-1.5 hover:bg-surface/60 transition-colors flex items-start gap-2"
                >
                  <span
                    className={
                      "text-[0.5625rem] font-mono mt-1 transition-transform " +
                      (expanded ? "rotate-90" : "")
                    }
                  >
                    ▶
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.6875rem] font-medium truncate">
                      {title}
                    </div>
                    <div className="text-[0.625rem] font-mono text-muted-foreground truncate">
                      {m.timestamp}
                    </div>
                  </div>
                </button>
                {expanded && (
                  <div className="px-3 pb-2 pt-1 text-[0.6875rem] font-mono whitespace-pre-wrap break-words text-foreground/90 bg-surface/40">
                    {m.body}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
function AlertsSection({ messages }) {
  const thorium = messages.filter((m) => m.body.startsWith("[THORIUM ALERT"));
  const f7 = messages.filter((m) => m.body.startsWith("[F7 REPORT"));
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center gap-2">
        <span className="size-1 bg-danger rounded-full" />
        Alerts
      </h2>
      <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden divide-y divide-border">
        <AlertCategoryGroup
          kind="thorium"
          label="Thorium alerts"
          items={thorium}
          toneClass="text-danger"
        />
        <AlertCategoryGroup
          kind="f7"
          label="F7 reports"
          items={f7}
          toneClass="text-warning"
        />
      </div>
    </section>
  );
}
function HitDistanceSection({ subjectId }) {
  const buckets = [
    { label: ">5m", seed: 1 },
    { label: ">25m", seed: 2 },
    { label: ">50m", seed: 3 },
    { label: ">100m", seed: 4 },
    { label: ">150m", seed: 5 },
    { label: "150m+", seed: 6 },
  ];
  const parts = [
    { key: "head", label: "H", title: "Head", weight: 0.18 },
    { key: "body", label: "B", title: "Body", weight: 1 },
    { key: "hands", label: "Ha", title: "Hands", weight: 0.55 },
    { key: "legs", label: "L", title: "Legs", weight: 0.5 },
    { key: "feet", label: "F", title: "Feet", weight: 0.35 },
  ];
  const rows = buckets.map((b) => {
    const baseline = Math.max(4, 70 - b.seed * 9);
    const cells = parts.map((p) => {
      const h = hash(subjectId + ":hit:" + b.seed + ":" + p.key);
      const raw = baseline * p.weight + (h % 18) - 8;
      const pct = Math.min(95, Math.max(0, Math.round(raw)));
      const tone =
        pct >= 60
          ? "text-danger"
          : pct >= 40
            ? "text-warning"
            : "text-foreground";
      return { ...p, pct, tone };
    });
    return { label: b.label, cells };
  });
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center gap-2">
        <span className="size-1 bg-danger rounded-full" />
        Hit % by Distance
      </h2>
      <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
        <table className="w-full text-[0.625rem] font-mono">
          <thead>
            <tr className="text-[0.625rem] uppercase tracking-wider text-muted-foreground bg-surface/60">
              <th className="px-2 py-1 text-left font-medium">Dist</th>
              {parts.map((p) => (
                <th
                  key={p.key}
                  className="px-1 py-1 text-right font-medium"
                  title={p.title}
                >
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-border">
                <td className="px-2 py-1.5 text-muted-foreground uppercase text-[0.625rem]">
                  {r.label}
                </td>
                {r.cells.map((c) => (
                  <td
                    key={c.key}
                    className={`px-1 py-1.5 text-right ${c.tone}`}
                    title={`${c.title} \xB7 ${c.pct}%`}
                  >
                    {c.pct}%
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
const SERVER_NAMES = [
  "RustyMoose|MainEU",
  "Rustafied.com - US Long III",
  "Facepunch Hapis",
  "Reddit.com/r/PlayRust EU",
  "OXIDE 2x | Solo/Duo",
  "Vital Rust | Trio Max",
  "Pickle Rust | NA Vanilla",
  "Survivors EU 5x",
];
function buildServerSessions(subjectId, isOnline, windowDays = 7) {
  if (windowDays <= 7) {
    const count2 = 3 + (hash(subjectId + ":srvcount") % 4);
    return Array.from({ length: count2 }).map((_, i) => {
      const h = hash(subjectId + ":srv:" + i);
      const name = SERVER_NAMES[h % SERVER_NAMES.length];
      const startHoursAgo = isOnline && i === 0 ? 0 : i * 6 + (h % 18) + 1;
      const playedMin = 20 + (h % 280);
      const endHoursAgo = startHoursAgo + playedMin / 60;
      return {
        key: `${subjectId}-srv-${i}`,
        name,
        startHoursAgo,
        endHoursAgo,
        playedMin,
      };
    });
  }
  const count = 16 + (hash(subjectId + ":srvcount" + windowDays) % 12);
  const maxHours = windowDays * 24;
  const segment = maxHours / count;
  return Array.from({ length: count }).map((_, i) => {
    const h = hash(subjectId + ":srv" + windowDays + ":" + i);
    const name = SERVER_NAMES[h % SERVER_NAMES.length];
    const jitter = h % Math.max(1, Math.floor(segment));
    const startHoursAgo =
      isOnline && i === 0 ? 0 : Math.floor(i * segment + jitter);
    const playedMin = 25 + (h % 320);
    const endHoursAgo = startHoursAgo + playedMin / 60;
    return {
      key: `${subjectId}-srv${windowDays}-${i}`,
      name,
      startHoursAgo,
      endHoursAgo,
      playedMin,
    };
  });
}
function bmSessionLastSeen(unix) {
  if (!unix) return "—";
  const min = Math.floor((Date.now() / 1000 - unix) / 60);
  if (min < 2) return "now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
function sessionRankColor(index, total) {
  const t = total <= 1 ? 0 : index / (total - 1);
  const r = Math.round(215 - t * 70);
  const g = Math.round(66 + t * 149);
  return `rgb(${r}, ${g}, 66)`;
}
function BmPlaytimeList({ sessions }) {
  const [showCount, setShowCount] = useState("10");
  const sorted = [...sessions].sort(
    (a, b) => Number(b.hoursPlayed ?? 0) - Number(a.hoursPlayed ?? 0),
  );
  const visible =
    showCount === "all" ? sorted : sorted.slice(0, Number(showCount));
  const maxHrs = Number(sorted[0]?.hoursPlayed ?? 0);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.625rem] font-mono text-muted-foreground uppercase tracking-widest">
          Highest playtime
        </span>
        <select
          value={showCount}
          onChange={(e) => setShowCount(e.target.value)}
          className="text-[0.625rem] font-mono bg-surface ring-1 ring-border rounded px-1 py-0.5 text-muted-foreground"
        >
          {["5", "10", "25", "50", "all"].map((v) => (
            <option key={v} value={v}>
              {v === "all" ? "All" : `Top ${v}`}
            </option>
          ))}
        </select>
      </div>
      <ul className="space-y-1">
        {visible.map((s, i) => {
          const hrs = Number(s.hoursPlayed ?? 0);
          const played =
            hrs >= 1 ? `${hrs.toFixed(2)} hrs` : `${Math.round(hrs * 60)}m`;
          const pct = maxHrs > 0 ? (hrs / maxHrs) * 100 : 0;
          const color = sessionRankColor(i, visible.length);
          return (
            <li
              key={s.bmServerId}
              style={{ borderLeft: `3px solid ${color}` }}
              className="pl-2 py-0.5"
            >
              <div className="flex items-baseline justify-between gap-2 mb-0.5">
                <span
                  className="text-[0.625rem] font-medium truncate min-w-0 flex-1"
                  title={s.serverName}
                >
                  {s.serverName}
                </span>
                <span
                  className="text-[0.625rem] font-mono shrink-0"
                  style={{ color }}
                >
                  {played}
                </span>
              </div>
              <div className="h-1 bg-surface rounded overflow-hidden">
                <div
                  className="h-full rounded"
                  style={{ width: `${pct}%`, background: color }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
function ServerHistorySection({ subjectId, isOnline, recipients, bmSessions }) {
  if (bmSessions) {
    return (
      <section>
        <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
          <span>Server History (BM)</span>
          <span className="font-mono normal-case tracking-normal text-muted-foreground">
            {bmSessions.length}
          </span>
        </h2>
        {bmSessions.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No server sessions on record.
          </p>
        ) : (
          <BmPlaytimeList sessions={bmSessions} />
        )}
      </section>
    );
  }
  const sessions = buildServerSessions(subjectId, !!isOnline);
  const recipientSessions = (recipients ?? []).map((r) => ({
    ...r,
    sessions: buildServerSessions(r.steamId, false),
  }));
  const servers = sessions.map((s) => {
    let label;
    if (s.startHoursAgo === 0) label = "now";
    else if (s.startHoursAgo < 24)
      label = `${Math.round(s.startHoursAgo)}h ago`;
    else label = `${Math.floor(s.startHoursAgo / 24)}d ago`;
    const played =
      s.playedMin >= 60
        ? `${Math.floor(s.playedMin / 60)}h ${s.playedMin % 60}m`
        : `${s.playedMin}m`;
    const overlaps = recipientSessions
      .filter((r) =>
        r.sessions.some(
          (rs) =>
            rs.name === s.name &&
            rs.startHoursAgo <= s.endHoursAgo &&
            rs.endHoursAgo >= s.startHoursAgo,
        ),
      )
      .map((r) => r.name);
    return { ...s, label, played, overlaps };
  });
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center justify-between">
        <span>Server History · 7d</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {servers.length}
        </span>
      </h2>
      <ul className="space-y-1.5">
        {servers.map((s) => (
          <li
            key={s.key}
            className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1"
          >
            {s.overlaps.length > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-[0.625rem] font-mono font-bold text-warning shrink-0"
                title={`Overlapped with: ${s.overlaps.join(", ")}`}
              >
                <span className="size-1.5 rounded-full bg-warning" />
                {s.overlaps.length}
              </span>
            )}
            <span className="text-[0.625rem] font-medium truncate min-w-0 flex-1">
              {s.name}
            </span>
            <span className="text-[0.625rem] font-mono text-muted-foreground shrink-0">
              {s.played}
            </span>
            <span className="text-[0.625rem] font-mono text-muted-foreground shrink-0">
              {s.label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
function getFriendlyRecipients(subjectId) {
  const events = buildFriendlyEvents(subjectId);
  const map = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (!map.has(e.target.steamId)) {
      map.set(e.target.steamId, {
        steamId: e.target.steamId,
        name: e.target.name,
      });
    }
  }
  return Array.from(map.values());
}
const FRIENDLY_ACTIONS = [
  "Dropped items",
  "Received items",
  "Revived",
  "TC authed",
  "Turret authed",
];
function buildFriendlyEvents(subjectId) {
  const mates = getTeammates(subjectId);
  const pool =
    mates.length > 0
      ? mates.map((m) => m.player)
      : [
          { steamId: "76561198000000001", name: "ShadowFox" },
          { steamId: "76561198000000002", name: "BlueWolf" },
          { steamId: "76561198000000003", name: "NightOwl" },
        ];
  const count = 22 + (hash(subjectId + ":fa:n") % 18);
  const events = Array.from({ length: count }).map((_, i) => {
    const h = hash(subjectId + ":fa:" + i);
    const action = FRIENDLY_ACTIONS[h % FRIENDLY_ACTIONS.length];
    const target = pool[h % pool.length];
    let secAgo;
    if (i < 4) {
      secAgo = i * 47 + (h % 40) + 3;
    } else {
      const dayBucket = ((i - 4) / Math.max(1, count - 4)) * 30;
      secAgo = Math.floor(dayBucket * 86400 + (h % 86400));
    }
    let when;
    if (secAgo < 60) when = `${secAgo}s ago`;
    else if (secAgo < 3600) when = `${Math.floor(secAgo / 60)}m ago`;
    else if (secAgo < 86400) when = `${Math.floor(secAgo / 3600)}h ago`;
    else when = `${Math.floor(secAgo / 86400)}d ago`;
    return { key: `${subjectId}-fa-${i}`, action, target, when, secAgo };
  });
  return events;
}
function FriendlyActionsSection({ subjectId }) {
  const events = buildFriendlyEvents(subjectId);
  const [copiedId, setCopiedId] = useState(null);
  const [open, setOpen] = useState(false);
  const visible = open ? events : events.slice(0, 5);
  const copy = (sid) => {
    navigator.clipboard.writeText(sid).then(() => {
      setCopiedId(sid);
      setTimeout(() => setCopiedId((c) => (c === sid ? null : c)), 1200);
    });
  };
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center justify-between">
        <span>Friendly Actions</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {events.length}
        </span>
      </h2>
      <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
        <table className="w-full text-[0.625rem] font-mono">
          <tbody>
            {visible.map((e) => (
              <tr key={e.key} className="border-t border-border first:border-0">
                <td className="px-2 py-1 text-foreground whitespace-nowrap">
                  {e.action}
                </td>
                <td className="px-2 py-1">
                  <button
                    onClick={() => copy(e.target.steamId)}
                    className="text-brand hover:underline truncate max-w-[110px] inline-block align-middle"
                    title={
                      copiedId === e.target.steamId
                        ? `Copied ${e.target.steamId}`
                        : `Copy ${e.target.steamId}`
                    }
                  >
                    {copiedId === e.target.steamId
                      ? e.target.steamId
                      : e.target.name}
                  </button>
                </td>
                <td className="px-2 py-1 text-right text-muted-foreground whitespace-nowrap">
                  {e.when}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {events.length > 5 && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-2 text-[0.625rem] font-mono uppercase tracking-widest text-brand hover:underline"
        >
          {open ? "Collapse" : `Show ${events.length - 5} more`}
        </button>
      )}
    </section>
  );
}
function hoursAgoLabel(h) {
  if (h <= 0) return "now";
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function secAgoLabel(s) {
  if (!Number.isFinite(s)) return "\u2014";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const STEAM_FRIEND_POOL = [
  { steamId: "76561198100000011", name: "RedPanda" },
  { steamId: "76561198100000012", name: "IronClad" },
  { steamId: "76561198100000013", name: "Vortex" },
  { steamId: "76561198100000014", name: "Saber" },
  { steamId: "76561198100000015", name: "Echo" },
  { steamId: "76561198100000016", name: "Glacier" },
  { steamId: "76561198100000017", name: "Wraith" },
  { steamId: "76561198100000018", name: "Nomad" },
  { steamId: "76561198100000019", name: "Cinder" },
  { steamId: "76561198100000020", name: "Onyx" },
  { steamId: "76561198100000021", name: "Lynx" },
  { steamId: "76561198100000022", name: "Pyre" },
  { steamId: "76561198100000023", name: "Drift" },
  { steamId: "76561198100000024", name: "Specter" },
  { steamId: "76561198100000025", name: "Reaver" },
  { steamId: "76561198100000026", name: "Halcyon" },
  { steamId: "76561198100000027", name: "Quartz" },
  { steamId: "76561198100000028", name: "Mako" },
  { steamId: "76561198100000029", name: "Cobalt" },
  { steamId: "76561198100000030", name: "Tempest" },
  { steamId: "76561198100000031", name: "Rogue" },
  { steamId: "76561198100000032", name: "Havoc" },
  { steamId: "76561198100000033", name: "Sable" },
  { steamId: "76561198100000034", name: "Vector" },
];
function buildSteamFriends(steamId) {
  const count = 8 + (hash(steamId + ":sf:n") % 8);
  const picks = /* @__PURE__ */ new Set();
  let i = 0;
  while (picks.size < count && i < 200) {
    picks.add(hash(steamId + ":sf:" + i) % STEAM_FRIEND_POOL.length);
    i++;
  }
  return Array.from(picks).map((idx) => STEAM_FRIEND_POOL[idx]);
}
function hasNotes(a, b) {
  if (typeof window === "undefined") return false;
  try {
    const key = "friendly-notes:" + [a, b].sort().join(":");
    const raw = window.localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}
function FriendlyRecipientsSection({ subjectId, subjectName, serverId }) {
  const [refresh, setRefresh] = useState(0);
  void refresh;
  const events = buildFriendlyEvents(subjectId);
  const subjectSessions = buildServerSessions(subjectId, false);
  const subjectSessions90 = buildServerSessions(subjectId, false, 90);
  const map = /* @__PURE__ */ new Map();
  for (const e of events) {
    let cur = map.get(e.target.steamId);
    if (!cur) {
      cur = {
        steamId: e.target.steamId,
        name: e.target.name,
        count: 0,
        events: [],
      };
      map.set(e.target.steamId, cur);
    }
    cur.count += 1;
    cur.events.push({ action: e.action, when: e.when, secAgo: e.secAgo });
  }
  const assocMap = getAssociationsFor(subjectId);
  for (const [id, info] of assocMap) {
    if (!map.has(id)) {
      map.set(id, { steamId: id, name: info.name, count: 0, events: [] });
    }
  }
  const ranked = Array.from(map.values()).sort((a, b) => {
    const ac = (assocMap.get(a.steamId)?.count ?? 0) + a.count;
    const bc = (assocMap.get(b.steamId)?.count ?? 0) + b.count;
    return bc - ac;
  });
  const recipients = ranked.map((r, idx) => {
    let sessions = buildServerSessions(r.steamId, false);
    let sessions90 = buildServerSessions(r.steamId, false, 90);
    let steamFriend = hash(subjectId + ":friend:" + r.steamId) % 3 === 0;
    if (idx === 0 && subjectSessions.length > 0) {
      steamFriend = true;
      const ref = subjectSessions[0];
      const shifted = {
        ...ref,
        key: `${r.steamId}-srv-overlap`,
        startHoursAgo: Math.max(0, ref.startHoursAgo - 0.25),
        endHoursAgo: ref.endHoursAgo + 0.25,
      };
      sessions = [shifted, ...sessions.slice(1)];
      if (subjectSessions90.length > 0) {
        const ref90 =
          subjectSessions90[Math.min(2, subjectSessions90.length - 1)];
        const shifted90 = {
          ...ref90,
          key: `${r.steamId}-srv90-overlap`,
          startHoursAgo: Math.max(0, ref90.startHoursAgo - 0.5),
          endHoursAgo: ref90.endHoursAgo + 0.5,
        };
        sessions90 = [shifted, shifted90, ...sessions90.slice(2)];
      }
    }
    const overlaps = [];
    for (const s of subjectSessions) {
      for (const rs of sessions) {
        if (
          rs.name === s.name &&
          rs.startHoursAgo <= s.endHoursAgo &&
          rs.endHoursAgo >= s.startHoursAgo
        ) {
          overlaps.push({
            server: s.name,
            subjectLabel: hoursAgoLabel(s.startHoursAgo),
            theirLabel: hoursAgoLabel(rs.startHoursAgo),
          });
        }
      }
    }
    const subjectFriends = buildSteamFriends(subjectId);
    const recipientFriends = buildSteamFriends(r.steamId);
    const subjectFriendIds = new Set(subjectFriends.map((f) => f.steamId));
    let mutualFriends = recipientFriends.filter((f) =>
      subjectFriendIds.has(f.steamId),
    );
    if (idx === 0 && mutualFriends.length < 3) {
      const needed = STEAM_FRIEND_POOL.slice(0, 3).filter(
        (f) => !mutualFriends.some((m) => m.steamId === f.steamId),
      );
      mutualFriends = [...mutualFriends, ...needed].slice(
        0,
        Math.max(3, mutualFriends.length),
      );
    }
    const reverseEvents = buildFriendlyEvents(r.steamId);
    let reciprocated = reverseEvents.some(
      (e) => e.target.steamId === subjectId,
    );
    if (idx === 0) reciprocated = true;
    const teamIds = new Set(
      getTeammates(subjectId).map((m) => m.player.steamId),
    );
    const inTeamUi = teamIds.has(r.steamId);
    const assocInfo = assocMap.get(r.steamId);
    const associationReports = assocInfo?.count ?? 0;
    const signals = [
      r.count > 0,
      // friendly actions from subject
      overlaps.length > 0,
      // shared server history
      steamFriend,
      // direct steam friend
      mutualFriends.length > 0,
      // mutual steam friends
      reciprocated,
      // bidirectional friendly actions
      associationReports > 0,
      // public association reports
    ];
    const signalCount = signals.filter(Boolean).length;
    const eventMinSec =
      r.events.length > 0
        ? Math.min(...r.events.map((e) => e.secAgo))
        : Number.POSITIVE_INFINITY;
    const assocSec = assocInfo
      ? Math.max(0, Math.floor((Date.now() - assocInfo.lastAt) / 1e3))
      : Number.POSITIVE_INFINITY;
    const lastActivitySec = Math.min(eventMinSec, assocSec);
    return {
      steamId: r.steamId,
      name: r.name,
      count: r.count,
      events: r.events.sort((a, b) => a.secAgo - b.secAgo),
      sessions,
      sessions90,
      overlaps,
      steamFriend,
      mutualFriends,
      reciprocated,
      inTeamUi,
      associationReports,
      signalCount,
      lastActivitySec,
      assocLastSec: assocSec,
      hidden: isAssociationHidden(subjectId, r.steamId),
    };
  });
  function metaFor(target) {
    const existingAgg = map.get(target.steamId);
    const evs = existingAgg?.events ?? [];
    const sessions = buildServerSessions(target.steamId, false);
    const sessions90 = buildServerSessions(target.steamId, false, 90);
    const overlaps = [];
    for (const s of subjectSessions) {
      for (const rs of sessions) {
        if (
          rs.name === s.name &&
          rs.startHoursAgo <= s.endHoursAgo &&
          rs.endHoursAgo >= s.startHoursAgo
        ) {
          overlaps.push({
            server: s.name,
            subjectLabel: hoursAgoLabel(s.startHoursAgo),
            theirLabel: hoursAgoLabel(rs.startHoursAgo),
          });
        }
      }
    }
    const steamFriend = hash(subjectId + ":friend:" + target.steamId) % 3 === 0;
    const subjectFriends = buildSteamFriends(subjectId);
    const recipientFriends = buildSteamFriends(target.steamId);
    const subjectFriendIds = new Set(subjectFriends.map((f) => f.steamId));
    const mutualFriends = recipientFriends.filter((f) =>
      subjectFriendIds.has(f.steamId),
    );
    const reverseEvents = buildFriendlyEvents(target.steamId);
    const reciprocated = reverseEvents.some(
      (e) => e.target.steamId === subjectId,
    );
    const teamIds = new Set(
      getTeammates(subjectId).map((m) => m.player.steamId),
    );
    const inTeamUi = teamIds.has(target.steamId);
    const assocInfo = assocMap.get(target.steamId);
    const associationReports = assocInfo?.count ?? 0;
    const signalCount = [
      evs.length > 0,
      overlaps.length > 0,
      steamFriend,
      mutualFriends.length > 0,
      reciprocated,
      associationReports > 0,
    ].filter(Boolean).length;
    const eventMinSec =
      evs.length > 0
        ? Math.min(...evs.map((e) => e.secAgo))
        : Number.POSITIVE_INFINITY;
    const assocSec = assocInfo
      ? Math.max(0, Math.floor((Date.now() - assocInfo.lastAt) / 1e3))
      : Number.POSITIVE_INFINITY;
    return {
      steamId: target.steamId,
      name: target.name,
      count: evs.length,
      events: [...evs].sort((a, b) => a.secAgo - b.secAgo),
      sessions,
      sessions90,
      overlaps,
      steamFriend,
      mutualFriends,
      reciprocated,
      inTeamUi,
      associationReports,
      signalCount,
      lastActivitySec: Math.min(eventMinSec, assocSec),
      assocLastSec: assocSec,
      hidden: isAssociationHidden(subjectId, target.steamId),
    };
  }
  const [openId, setOpenId] = useState(null);
  const [searchedId, setSearchedId] = useState(null);
  const [ignoreTeamUi, setIgnoreTeamUi] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [sortMode, setSortMode] = useState("most");
  let visible = ignoreTeamUi
    ? recipients.filter((r) => !r.inTeamUi)
    : recipients;
  visible = showHidden ? visible : visible.filter((r) => !r.hidden);
  visible = [...visible].sort((a, b) =>
    sortMode === "recent"
      ? a.assocLastSec - b.assocLastSec
      : b.associationReports - a.associationReports ||
        b.signalCount - a.signalCount,
  );
  let open = null;
  if (openId) open = recipients.find((r) => r.steamId === openId) ?? null;
  if (!open && searchedId) {
    const p = getPlayer(searchedId);
    if (p) open = metaFor({ steamId: p.steamId, name: p.name });
  }
  const openFromSearch = Boolean(
    open && !recipients.find((r) => r.steamId === open.steamId),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const serverPlayers = serverId ? getServerPlayers(serverId) : [];
  const trimmed = searchQuery.trim().toLowerCase();
  const matches = trimmed
    ? serverPlayers
        .filter((p) => p.steamId !== subjectId)
        .filter(
          (p) =>
            p.name.toLowerCase().includes(trimmed) ||
            p.steamId.toLowerCase().includes(trimmed),
        )
        .slice(0, 8)
    : [];
  return (
    <section>
      <div className="flex items-center justify-between mb-2 gap-2">
        <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground flex items-center gap-1.5">
          <span>Associated Players</span>
          <span className="font-mono normal-case tracking-normal text-muted-foreground">
            {visible.length}
          </span>
        </h2>
        <div className="flex items-center gap-1">
          {["most", "recent"].map((m) => (
            <button
              key={m}
              onClick={() => setSortMode(m)}
              className={`text-[0.625rem] font-mono uppercase px-1.5 py-0.5 rounded ring-1 transition-colors ${sortMode === m ? "ring-brand bg-brand/10 text-brand" : "ring-border text-muted-foreground hover:text-foreground"}`}
              title={
                m === "most"
                  ? "Sort by most associations"
                  : "Sort by most recent association"
              }
            >
              {m === "most" ? "Most" : "Recent"}
            </button>
          ))}
          <button
            onClick={() => setIgnoreTeamUi((v) => !v)}
            className={`text-[0.625rem] font-mono uppercase px-1.5 py-0.5 rounded ring-1 transition-colors ${ignoreTeamUi ? "ring-brand bg-brand/10 text-brand" : "ring-border text-muted-foreground hover:text-foreground"}`}
            title="Hide players already in the subject's team UI"
          >
            Ignore TeamUI: {ignoreTeamUi ? "true" : "false"}
          </button>
          <button
            onClick={() => setShowHidden((v) => !v)}
            className={`text-[0.625rem] font-mono uppercase px-1.5 py-0.5 rounded ring-1 transition-colors ${showHidden ? "ring-brand bg-brand/10 text-brand" : "ring-border text-muted-foreground hover:text-foreground"}`}
            title="Include players that have been manually unassociated"
          >
            Show hidden
          </button>
        </div>
      </div>

      {serverId && (
        <div className="relative mb-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search server roster by name or Steam ID..."
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-[0.625rem] font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
          {matches.length > 0 && (
            <ul className="absolute z-10 left-0 right-0 mt-1 bg-background ring-1 ring-border rounded shadow-lg max-h-56 overflow-y-auto">
              {matches.map((p) => (
                <li key={p.steamId}>
                  <button
                    onClick={() => {
                      setSearchedId(p.steamId);
                      setOpenId(null);
                      setSearchQuery("");
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-surface/60 flex items-center gap-2"
                  >
                    <span className="text-[0.625rem] font-medium truncate flex-1">
                      {p.name}
                    </span>
                    <span className="text-[0.625rem] font-mono text-muted-foreground truncate">
                      {p.steamId}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {trimmed && matches.length === 0 && (
            <p className="absolute z-10 left-0 right-0 mt-1 bg-background ring-1 ring-border rounded p-2 text-[0.625rem] text-muted-foreground italic">
              No players on this server match.
            </p>
          )}
        </div>
      )}

      <ul className="space-y-1.5">
        {visible.map((r) => (
          <li
            key={r.steamId}
            className={`flex items-center gap-1.5 ring-1 ring-border rounded px-2 py-1 ${r.hidden ? "bg-surface/20 opacity-60" : "bg-surface/40"}`}
          >
            <button
              onClick={() => {
                setSearchedId(null);
                setOpenId(r.steamId);
              }}
              className={`text-[0.625rem] font-medium truncate text-left hover:underline shrink-0 max-w-[100px] ${r.hidden ? "text-muted-foreground line-through" : "text-brand"}`}
              title="View breakdown"
            >
              {r.name}
            </button>
            <span className="text-[0.625rem] font-mono text-muted-foreground min-w-0 flex-1 flex items-center gap-1">
              <CopyBtn text={r.steamId} />
              <PlayerLinks steamId={r.steamId} />
            </span>

            <span
              className="text-[0.625rem] text-muted-foreground shrink-0 tabular-nums"
              title={
                r.associationReports > 0
                  ? `Last reported as associated ${secAgoLabel(r.assocLastSec)} \xB7 ${r.associationReports} report${r.associationReports === 1 ? "" : "s"}`
                  : `Last association signal ${secAgoLabel(r.lastActivitySec)}`
              }
            >
              {secAgoLabel(
                r.associationReports > 0 ? r.assocLastSec : r.lastActivitySec,
              )}
            </span>
            <span
              className="text-[0.625rem] font-mono text-foreground/80 shrink-0 px-1.5 py-0.5 rounded bg-surface/80 ring-1 ring-border"
              title={`${r.signalCount} unique association signal${r.signalCount === 1 ? "" : "s"}`}
            >
              ×{r.signalCount}
            </span>
            {r.hidden ? (
              <button
                onClick={() => {
                  unhideAssociation(subjectId, r.steamId);
                  setRefresh((x) => x + 1);
                }}
                className="shrink-0 p-0.5 rounded hover:bg-surface text-emerald-400 hover:text-emerald-300"
                title="Re-associate this player"
              >
                <RotateCcw size={11} />
              </button>
            ) : (
              <button
                onClick={() => {
                  hideAssociation(subjectId, r.steamId);
                  setRefresh((x) => x + 1);
                }}
                className="shrink-0 p-0.5 rounded hover:bg-surface text-muted-foreground hover:text-rose-400"
                title="Remove from associated players"
              >
                <Trash2 size={11} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {open && (
        <RecipientBreakdownModal
          subjectId={subjectId}
          recipient={open}
          subjectSessions={subjectSessions}
          subjectSessions90={subjectSessions90}
          onClose={() => {
            setOpenId(null);
            setSearchedId(null);
          }}
          canAddAssociated={openFromSearch && !open.hidden}
          onAddAssociated={
            openFromSearch && !open.hidden
              ? () => {
                  if (!subjectId || !open) return;
                  addAssociationReports(
                    { steamId: subjectId, name: subjectName ?? subjectId },
                    [{ steamId: open.steamId, name: open.name }],
                  );
                  setSearchedId(null);
                  setOpenId(open.steamId);
                  setRefresh((x) => x + 1);
                }
              : void 0
          }
          onReassociate={
            open.hidden
              ? () => {
                  if (!open) return;
                  unhideAssociation(subjectId, open.steamId);
                  setSearchedId(null);
                  setOpenId(open.steamId);
                  setRefresh((x) => x + 1);
                }
              : void 0
          }
        />
      )}
    </section>
  );
}
const ACTION_RANGES = [
  { label: "24h", sec: 86400 },
  { label: "72h", sec: 86400 * 3 },
  { label: "7d", sec: 86400 * 7 },
  { label: "30d", sec: 86400 * 30 },
];
const SERVER_WINDOWS = [
  { label: "7d", days: 7 },
  { label: "90d", days: 90 },
];
function RecipientBreakdownModal({
  subjectId,
  recipient,
  subjectSessions,
  subjectSessions90,
  onClose,
  canAddAssociated,
  onAddAssociated,
  onReassociate,
}) {
  const [rangeIdx, setRangeIdx] = useState(2);
  const [serverWinIdx, setServerWinIdx] = useState(0);
  const range = ACTION_RANGES[rangeIdx];
  const serverWin = SERVER_WINDOWS[serverWinIdx];
  const filteredEvents = recipient.events.filter((e) => e.secAgo <= range.sec);
  const breakdown = /* @__PURE__ */ new Map();
  for (const e of filteredEvents)
    breakdown.set(e.action, (breakdown.get(e.action) ?? 0) + 1);
  const subjSessions =
    serverWin.days === 7 ? subjectSessions : subjectSessions90;
  const recipSessions =
    serverWin.days === 7 ? recipient.sessions : recipient.sessions90;
  const serverNames = Array.from(
    /* @__PURE__ */ new Set([
      ...subjSessions.map((s) => s.name),
      ...recipSessions.map((s) => s.name),
    ]),
  );
  const rows = serverNames
    .map((name) => {
      const subj = subjSessions.filter((s) => s.name === name);
      const recip = recipSessions.filter((s) => s.name === name);
      const hasOverlap = subj.some((a) =>
        recip.some(
          (b) =>
            a.startHoursAgo <= b.endHoursAgo &&
            a.endHoursAgo >= b.startHoursAgo,
        ),
      );
      return { name, subj, recip, hasOverlap };
    })
    .sort((a, b) => Number(b.hasOverlap) - Number(a.hasOverlap));
  const maxHours = serverWin.days * 24;
  const xPct = (hoursAgo) =>
    Math.max(0, Math.min(100, ((maxHours - hoursAgo) / maxHours) * 100));
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-background ring-1 ring-border rounded-lg p-5 max-w-2xl w-full shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4 gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              {recipient.name}
              {recipient.steamFriend && (
                <UsersRound size={12} className="text-success" />
              )}
              {recipient.overlaps.length > 0 && (
                <ServerIcon size={12} className="text-warning" />
              )}
            </h3>
            <p className="text-[0.625rem] font-mono text-muted-foreground uppercase mt-0.5 flex items-center gap-1">
              {recipient.steamId}
              <CopyBtn text={recipient.steamId} />
              <PlayerLinks steamId={recipient.steamId} size="sm" />
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {recipient.hidden && onReassociate && (
          <div className="mb-4 px-3 py-2 rounded ring-1 ring-amber-400/30 bg-amber-400/5 flex items-center gap-3">
            <Trash2 size={12} className="text-amber-400 shrink-0" />
            <p className="text-[0.6875rem] text-foreground flex-1">
              These players were previously associated but were manually
              unassociated.
            </p>
            <button
              onClick={onReassociate}
              className="text-[0.625rem] font-mono uppercase px-2 py-1 rounded ring-1 ring-amber-400 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20 inline-flex items-center gap-1"
            >
              <RotateCcw size={11} /> Re-associate
            </button>
          </div>
        )}

        {canAddAssociated && onAddAssociated && (
          <div className="mb-4 px-3 py-2 rounded ring-1 ring-brand/30 bg-brand/5 flex items-center gap-3">
            <p className="text-[0.6875rem] text-foreground flex-1">
              {recipient.name} isn't yet listed as an associated player.
            </p>
            <button
              onClick={onAddAssociated}
              className="text-[0.625rem] font-mono uppercase px-2 py-1 rounded ring-1 ring-brand bg-brand text-brand-foreground hover:opacity-90"
            >
              Add as associated
            </button>
          </div>
        )}

        {recipient.steamFriend && (
          <div className="mb-3 px-3 py-2 rounded ring-1 ring-success/30 bg-success/5 flex items-center gap-2">
            <UsersRound size={12} className="text-success shrink-0" />
            <p className="text-[0.6875rem] text-foreground">
              <span className="font-semibold text-success">
                Friends on Steam
              </span>{" "}
              — the subject and {recipient.name} are connected on Steam.
            </p>
          </div>
        )}

        {recipient.associationReports > 0 && (
          <div className="mb-4 px-3 py-2 rounded ring-1 ring-rose-400/30 bg-rose-400/5 flex items-center gap-2">
            <Flag size={12} className="text-rose-400 shrink-0" />
            <p className="text-[0.6875rem] text-foreground">
              Reported as associated with this player{" "}
              <span className="font-mono font-semibold text-rose-400">
                ×{recipient.associationReports}
              </span>{" "}
              {recipient.associationReports === 1 ? "time" : "times"} via the
              public report flow.
            </p>
          </div>
        )}

        {/* FRIENDLY ACTIONS */}
        <div className="flex items-center justify-between mb-2 gap-2">
          <h4 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Friendly Actions · {filteredEvents.length}
          </h4>
          <div className="flex gap-1">
            {ACTION_RANGES.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setRangeIdx(i)}
                className={`text-[0.625rem] font-mono uppercase px-1.5 py-0.5 rounded ring-1 transition-colors ${i === rangeIdx ? "ring-brand bg-brand/10 text-brand" : "ring-border text-muted-foreground hover:text-foreground"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {breakdown.size > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {Array.from(breakdown.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([action, count]) => (
                <span
                  key={action}
                  className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded bg-surface/60 ring-1 ring-border text-foreground"
                >
                  {action}{" "}
                  <span className="text-muted-foreground">×{count}</span>
                </span>
              ))}
          </div>
        )}

        <div className="bg-surface/40 ring-1 ring-border rounded mb-5 overflow-hidden max-h-48 overflow-y-auto">
          {filteredEvents.length === 0 ? (
            <p className="text-[0.625rem] text-muted-foreground italic p-2">
              No actions in this range.
            </p>
          ) : (
            <table className="w-full text-[0.625rem] font-mono">
              <tbody>
                {filteredEvents.map((e, i) => (
                  <tr
                    key={`${recipient.steamId}-evt-${i}`}
                    className="border-t border-border first:border-0"
                  >
                    <td className="px-2 py-1 text-foreground whitespace-nowrap">
                      {e.action}
                    </td>
                    <td className="px-2 py-1 text-right text-muted-foreground whitespace-nowrap">
                      {e.when}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* SERVER HISTORY TIMELINE */}
        <div className="flex items-center justify-between mb-2 gap-2">
          <h4 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Server History · {serverWin.label}
          </h4>
          <div className="flex gap-1">
            {SERVER_WINDOWS.map((w, i) => (
              <button
                key={w.label}
                onClick={() => setServerWinIdx(i)}
                className={`text-[0.625rem] font-mono uppercase px-1.5 py-0.5 rounded ring-1 transition-colors ${i === serverWinIdx ? "ring-brand bg-brand/10 text-brand" : "ring-border text-muted-foreground hover:text-foreground"}`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 mb-2 text-[0.625rem] font-mono text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm bg-brand" /> Subject
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm bg-warning" /> {recipient.name}
          </span>
          <span className="ml-auto">Overlap highlighted</span>
        </div>

        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.name}>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[0.625rem] font-medium truncate flex-1">
                  {row.name}
                </span>
                {row.hasOverlap && (
                  <span className="text-[0.625rem] font-mono text-warning font-bold uppercase tracking-wider">
                    overlap
                  </span>
                )}
              </div>
              <div className="relative h-6 bg-surface/40 ring-1 ring-border rounded overflow-hidden">
                {/* day gridlines */}
                {Array.from({ length: serverWin.days === 7 ? 7 : 9 }).map(
                  (_, i) => {
                    const step = serverWin.days === 7 ? 1 : 10;
                    const dayAgo = (i + 1) * step;
                    if (dayAgo >= serverWin.days) return null;
                    return (
                      <span
                        key={i}
                        className="absolute top-0 bottom-0 w-px bg-border/50"
                        style={{ left: `${xPct(dayAgo * 24)}%` }}
                      />
                    );
                  },
                )}
                {/* Subject sessions — top half */}
                {row.subj.map((s, i) => (
                  <div
                    key={`s-${i}`}
                    className="absolute top-1 h-2 rounded-sm bg-brand"
                    style={{
                      left: `${xPct(s.endHoursAgo)}%`,
                      width: `${Math.max(0.6, xPct(s.startHoursAgo) - xPct(s.endHoursAgo))}%`,
                    }}
                    title={`Subject: ${Math.round(s.playedMin)}m, ${hoursAgoLabel(s.startHoursAgo)}`}
                  />
                ))}
                {/* Recipient sessions — bottom half */}
                {row.recip.map((s, i) => (
                  <div
                    key={`r-${i}`}
                    className="absolute bottom-1 h-2 rounded-sm bg-warning"
                    style={{
                      left: `${xPct(s.endHoursAgo)}%`,
                      width: `${Math.max(0.6, xPct(s.startHoursAgo) - xPct(s.endHoursAgo))}%`,
                    }}
                    title={`${recipient.name}: ${Math.round(s.playedMin)}m, ${hoursAgoLabel(s.startHoursAgo)}`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[0.625rem] font-mono text-muted-foreground mt-1">
          <span>{serverWin.days}d ago</span>
          <span>now</span>
        </div>

        {/* MUTUAL STEAM FRIENDS */}
        <div className="mt-5">
          <h4 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2 flex items-center gap-1.5">
            <Handshake size={11} className="text-fuchsia-400" />
            Mutual Steam Friends · {recipient.mutualFriends.length}
          </h4>
          {recipient.mutualFriends.length === 0 ? (
            <p className="text-[0.625rem] text-muted-foreground italic">
              No friends in common on Steam.
            </p>
          ) : (
            <ul className="space-y-1">
              {recipient.mutualFriends.map((f) => (
                <li
                  key={f.steamId}
                  className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1"
                >
                  <span className="text-[0.625rem] font-medium truncate shrink-0 max-w-[120px]">
                    {f.name}
                  </span>
                  <span className="text-[0.625rem] font-mono text-muted-foreground truncate min-w-0 flex-1 flex items-center gap-1">
                    {f.steamId}
                    <CopyBtn text={f.steamId} />
                    <PlayerLinks steamId={f.steamId} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <FriendlyNotes
          subjectId={subjectId}
          recipientId={recipient.steamId}
          recipientName={recipient.name}
        />
      </div>
    </div>
  );
}
function pairNotesKey(a, b) {
  return "friendly-notes:" + [a, b].sort().join(":");
}
function FriendlyNotes({ subjectId, recipientId, recipientName }) {
  const storageKey = pairNotesKey(subjectId, recipientId);
  const [notes, setNotes] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [draft, setDraft] = useState("");
  const persist = (next) => {
    setNotes(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  };
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const note = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
    };
    persist([note, ...notes]);
    setDraft("");
  };
  const remove = (id) => persist(notes.filter((n) => n.id !== id));
  const fmt = (ts) => {
    const sec = Math.floor((Date.now() - ts) / 1e3);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  };
  return (
    <div className="mt-5">
      <h4 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2 flex items-center justify-between">
        <span>Pair Notes</span>
        <span
          className="font-mono normal-case tracking-normal text-muted-foreground"
          title="Notes are shared between both players — they appear regardless of who is reported."
        >
          shared · {notes.length}
        </span>
      </h4>
      <div className="flex gap-1.5 mb-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              add();
            }
          }}
          placeholder={`Note about interaction with ${recipientName}\u2026`}
          className="flex-1 text-[0.625rem] bg-surface/40 ring-1 ring-border rounded px-2 py-1 placeholder:text-muted-foreground focus:outline-none focus:ring-brand"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="text-[0.625rem] font-mono uppercase tracking-wider px-2 py-1 rounded ring-1 ring-brand text-brand hover:bg-brand/10 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add
        </button>
      </div>
      {notes.length === 0 ? (
        <p className="text-[0.625rem] text-muted-foreground italic">
          No notes yet for this pair.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {notes.map((n) => (
            <li
              key={n.id}
              className="bg-surface/40 ring-1 ring-border rounded px-2 py-1.5 flex gap-2 items-start"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[0.6875rem] text-foreground whitespace-pre-wrap break-words">
                  {n.text}
                </p>
                <p className="text-[0.625rem] font-mono text-muted-foreground mt-0.5">
                  {fmt(n.createdAt)}
                </p>
              </div>
              <button
                onClick={() => remove(n.id)}
                className="text-muted-foreground hover:text-danger shrink-0"
                title="Delete note"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function Field({ label, value, tone, hint }) {
  const color =
    tone === "danger"
      ? "text-danger"
      : tone === "success"
        ? "text-success"
        : tone === "warning"
          ? "text-warning"
          : "text-foreground";
  const labelEl = (
    <p
      className={
        "text-xs text-muted-foreground uppercase w-fit" +
        (hint
          ? " underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 cursor-help"
          : "")
      }
    >
      {label}
    </p>
  );
  return (
    <div>
      {hint ? <Hint text={hint}>{labelEl}</Hint> : labelEl}
      <p className={`text-base font-mono ${color}`}>{value}</p>
    </div>
  );
}
function buildChatLog(subjectId) {
  let h = 0;
  for (let i = 0; i < subjectId.length; i++)
    h = (h * 31 + subjectId.charCodeAt(i)) | 0;
  h = Math.abs(h);
  const samples = [
    "gg ez noobs",
    "you're absolute trash kid",
    "anyone selling sulfur at outpost?",
    "shut up you [slur] go back to your country",
    "lmao that raid was free",
    "i'll find where you live irl",
    "wp",
    "report this clown he's hacking",
    "kys honestly",
    "anyone got a spare bow",
    "[slur] team get off my server",
    "trading hqm for scrap 1:1",
  ];
  const channels = ["global", "team", "voice"];
  const times = [
    "14:22",
    "14:18",
    "14:05",
    "13:51",
    "13:40",
    "13:22",
    "12:58",
    "12:31",
    "11:47",
    "11:12",
    "10:38",
    "09:55",
  ];
  const out = [];
  const count = 8 + (h % 5);
  for (let i = 0; i < count; i++) {
    const k = Math.abs((h + i * 1103) | 0);
    out.push({
      ts: times[i % times.length],
      channel: channels[k % channels.length],
      body: samples[k % samples.length],
    });
  }
  return out;
}
function classifyLine(body, yellow, red) {
  const lc = body.toLowerCase();
  for (const p of red) {
    const q = p.trim().toLowerCase();
    if (q && lc.includes(q)) return "red";
  }
  for (const p of yellow) {
    const q = p.trim().toLowerCase();
    if (q && lc.includes(q)) return "yellow";
  }
  return null;
}
function ChatLogSection({ subjectId, ticketStatus, onAutoReopen }) {
  const { orgToxicity, myOrgIds } = useAuth();
  const { yellow, red } = useMemo(() => {
    const y = /* @__PURE__ */ new Set();
    const r = /* @__PURE__ */ new Set();
    for (const oid of myOrgIds) {
      const cfg = orgToxicity[oid];
      if (!cfg) continue;
      for (const p of cfg.yellow) y.add(p);
      for (const p of cfg.red) r.add(p);
    }
    return { yellow: Array.from(y), red: Array.from(r) };
  }, [orgToxicity, myOrgIds]);
  const log = buildChatLog(subjectId);
  const classified = log.map((l) => ({
    ...l,
    flag: classifyLine(l.body, yellow, red),
  }));
  const flaggedCount = classified.filter((l) => l.flag !== null).length;
  const firstRed = classified.find((l) => l.flag === "red");
  const firedRef = useRef(null);
  useEffect(() => {
    if (!onAutoReopen || ticketStatus !== "cleared" || !firstRed) return;
    const key = `${subjectId}::${firstRed.body}`;
    if (firedRef.current === key) return;
    firedRef.current = key;
    onAutoReopen(
      `Auto-reopened: red phrase detected in chat \u2014 "${firstRed.body}"`,
    );
  }, [onAutoReopen, ticketStatus, firstRed, subjectId]);
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>Chat Log · {log.length}</span>
        {flaggedCount > 0 && (
          <span className="font-mono normal-case tracking-normal text-danger">
            {flaggedCount} flagged
          </span>
        )}
      </h2>
      <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
        {classified.map((line, i) => {
          const bgRing =
            line.flag === "red"
              ? "bg-danger/10 border border-danger/30"
              : line.flag === "yellow"
                ? "bg-warning/10 border border-warning/30"
                : "bg-muted/30 border border-border";
          const bodyColor =
            line.flag === "red"
              ? "text-danger"
              : line.flag === "yellow"
                ? "text-warning"
                : "text-foreground";
          return (
            <div
              key={i}
              className={`text-xs rounded-md px-2 py-1.5 flex gap-2 items-start ${bgRing}`}
            >
              <span className="font-mono text-[0.625rem] text-muted-foreground shrink-0 mt-0.5">
                {line.ts}
              </span>
              <span
                className={`font-mono text-[0.625rem] uppercase tracking-wider shrink-0 mt-0.5 ${line.channel === "global" ? "text-foreground/70" : line.channel === "team" ? "text-success" : "text-warning"}`}
              >
                {line.channel}
              </span>
              <span className={`flex-1 break-words ${bodyColor}`}>
                {line.body}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
const KF_WEAPONS = [
  "AK-47",
  "Bolt Action",
  "MP5",
  "Custom SMG",
  "Semi Rifle",
  "DB Shotgun",
  "Pump Shotgun",
  "M249",
  "L96",
  "Revolver",
  "Python",
  "Compound Bow",
  "Crossbow",
  "Eoka",
  "Salvaged Sword",
  "Rock",
];
const KF_PVE = [
  "Wolf",
  "Bear",
  "Boar",
  "Scientist",
  "Heavy Scientist",
  "Patrol Helicopter",
  "Bradley APC",
  "Fall damage",
  "Drowning",
  "Cold",
  "Hunger",
  "Barbed wire",
  "Landmine",
  "Bear trap",
];
const KF_SUICIDES = ["Suicide (F1)", "Disconnected (bleeding)", "Wounded out"];
const KF_OPPONENTS = [
  "RAGE_KING",
  "moose.exe",
  "Doc_Holiday",
  "stonk",
  "v0idwalker",
  "kreepyKev",
  "ZyklonZ",
  "sunshine.gg",
  "MrTuna",
  "frostbyte",
  "neonNomad",
  "ghostFace",
  "cR4cked",
  "saltyDog",
  "Mr. Crab",
  "PixelPanda",
  "rustler44",
  "scrapHoarder",
  "tarpRoof",
  "wood1k",
  "Beanieboi",
  "M3lon",
];
function buildKillFeed(subjectId) {
  let h = 0;
  for (let i = 0; i < subjectId.length; i++)
    h = (h * 33 + subjectId.charCodeAt(i)) | 0;
  h = Math.abs(h) || 1;
  const rand = (n, salt) => Math.abs(((h + salt * 2654435761) | 0) % n);
  const count = 14 + rand(8, 1);
  const out = [];
  let mins = 0;
  for (let i = 0; i < count; i++) {
    mins += 1 + rand(11, i + 7);
    const total = 14 * 60 + 22 - mins;
    const hh = Math.floor((((total % (24 * 60)) + 24 * 60) % (24 * 60)) / 60);
    const mm = ((total % 60) + 60) % 60;
    const ts = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const roll = rand(100, i * 13 + 3);
    let ev;
    if (roll < 45) {
      ev = {
        ts,
        kind: "kill",
        weapon: KF_WEAPONS[rand(KF_WEAPONS.length, i * 17 + 5)],
        distance: 3 + rand(280, i * 19 + 11),
        other: KF_OPPONENTS[rand(KF_OPPONENTS.length, i * 23 + 9)],
        headshot: rand(100, i * 29 + 1) < 32,
      };
    } else if (roll < 80) {
      ev = {
        ts,
        kind: "death",
        weapon: KF_WEAPONS[rand(KF_WEAPONS.length, i * 31 + 4)],
        distance: 3 + rand(280, i * 37 + 6),
        other: KF_OPPONENTS[rand(KF_OPPONENTS.length, i * 41 + 8)],
        headshot: rand(100, i * 43 + 2) < 24,
      };
    } else if (roll < 92) {
      ev = {
        ts,
        kind: "pve",
        other: KF_PVE[rand(KF_PVE.length, i * 47 + 3)],
      };
    } else {
      ev = {
        ts,
        kind: "suicide",
        other: KF_SUICIDES[rand(KF_SUICIDES.length, i * 53 + 7)],
      };
    }
    out.push(ev);
  }
  return out;
}
function KillFeedSection({ subjectId }) {
  const feed = buildKillFeed(subjectId);
  const kills = feed.filter((e) => e.kind === "kill").length;
  const deaths = feed.filter(
    (e) => e.kind === "death" || e.kind === "pve" || e.kind === "suicide",
  ).length;
  const kd = deaths === 0 ? kills.toFixed(2) : (kills / deaths).toFixed(2);
  return (
    <section>
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>Kill / Death Feed · {feed.length}</span>
        <span className="font-mono normal-case tracking-normal text-foreground/70">
          <span className="text-success">{kills}K</span>
          <span className="text-muted-foreground"> / </span>
          <span className="text-danger">{deaths}D</span>
          <span className="text-muted-foreground"> · </span>
          <span>{kd}</span>
        </span>
      </h2>
      <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
        {feed.map((e, i) => {
          const ringBg =
            e.kind === "kill"
              ? "bg-success/10 border border-success/30"
              : e.kind === "suicide"
                ? "bg-warning/10 border border-warning/30"
                : "bg-danger/10 border border-danger/30";
          const tag =
            e.kind === "kill"
              ? { label: "KILL", color: "text-success" }
              : e.kind === "death"
                ? { label: "DIED", color: "text-danger" }
                : e.kind === "pve"
                  ? { label: "PVE", color: "text-danger" }
                  : { label: "SELF", color: "text-warning" };
          return (
            <div
              key={i}
              className={`text-xs rounded-md px-2 py-1.5 flex gap-2 items-start ${ringBg}`}
            >
              <span className="font-mono text-[0.625rem] text-muted-foreground shrink-0 mt-0.5">
                {e.ts}
              </span>
              <span
                className={`font-mono text-[0.625rem] uppercase tracking-wider shrink-0 mt-0.5 w-9 ${tag.color}`}
              >
                {tag.label}
              </span>
              <span className="flex-1 break-words text-foreground">
                {e.kind === "kill" && (
                  <>
                    killed{" "}
                    <span className="font-mono text-foreground">{e.other}</span>{" "}
                    <span className="text-muted-foreground">
                      · {e.weapon} · {e.distance}m
                    </span>
                    {e.headshot && (
                      <span className="ml-1 font-mono text-[0.625rem] uppercase text-warning">
                        headshot
                      </span>
                    )}
                  </>
                )}
                {e.kind === "death" && (
                  <>
                    killed by{" "}
                    <span className="font-mono text-foreground">{e.other}</span>{" "}
                    <span className="text-muted-foreground">
                      · {e.weapon} · {e.distance}m
                    </span>
                    {e.headshot && (
                      <span className="ml-1 font-mono text-[0.625rem] uppercase text-warning">
                        headshot
                      </span>
                    )}
                  </>
                )}
                {e.kind === "pve" && (
                  <>
                    died to{" "}
                    <span className="font-mono text-foreground">{e.other}</span>
                  </>
                )}
                {e.kind === "suicide" && (
                  <span className="font-mono text-foreground">{e.other}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
export {
  AlertsSection,
  ChatLogSection,
  Field,
  FriendlyRecipientsSection,
  HitDistanceSection,
  KillFeedSection,
  OffensesTable,
  PlayerSidebar,
  ServerHistorySection,
  TeammatesSection,
  pingTone,
};

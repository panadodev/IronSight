import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ArrowLeft, Activity, ExternalLink } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
const Route = createFileRoute("/staff-audit")({
  head: () => ({ meta: [{ title: "Staff Audit Log \u2014 IronSight" }] }),
  validateSearch: (s) => ({
    staff: typeof s.staff === "string" ? s.staff : void 0
  }),
  component: StaffAuditPage
});
function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const ACTIVITY_TYPES = [
  { key: "page_view", label: "Page views", color: "hsl(210 80% 60%)" },
  { key: "lookup", label: "Player lookups", color: "hsl(160 70% 55%)" },
  { key: "ticket", label: "Tickets resolved", color: "hsl(45 90% 60%)" },
  { key: "ban", label: "Bans issued", color: "hsl(0 75% 60%)" },
  { key: "mute", label: "Mutes issued", color: "hsl(30 80% 60%)" }
];
const PAGES = [
  "/",
  "/player-lookup",
  "/player-list",
  "/bans-mutes",
  "/chat",
  "/my-reports",
  "/panel",
  "/threat-triggers",
  "/manage/staff",
  "/manage/tickets"
];
const NAMES_POOL = [
  "Snowfox",
  "BlitzKing",
  "Vex",
  "Nyx_03",
  "RaidGod",
  "Saltwater",
  "Crispy",
  "Lumi",
  "Penguin",
  "TacoTuesday",
  "MoonGremlin",
  "DryFire",
  "ZenRust",
  "PartyParrot",
  "Static42",
  "Echo",
  "Vulture",
  "Bramble",
  "ColdBrew",
  "Phantom",
  "Ace_99",
  "Wraith",
  "Drift",
  "Slate",
  "Rune",
  "Hex",
  "Nova"
];
function steamIdFor(seed) {
  const rng = mulberry(seed);
  return "7656119" + String(randInt(rng, 8e9, 8999999999));
}
function buildDays(staffId) {
  const rng = mulberry(hashSeed(staffId + "::days"));
  const baseline = randInt(rng, 3, 9);
  const days = [];
  for (let i = 0; i < 30; i++) {
    const weekday = (i + Math.floor(rng() * 7)) % 7;
    const isWeekend = weekday === 0 || weekday === 6;
    const mult = isWeekend ? 0.55 : 1;
    const swing = 0.6 + rng() * 0.9;
    const pv = Math.round(baseline * 6 * mult * swing);
    const lk = Math.round(baseline * 2.2 * mult * (0.5 + rng()));
    const tk = Math.round(baseline * 1.1 * mult * (0.4 + rng()));
    const bn = Math.max(0, Math.round(baseline * 0.4 * mult * (rng() * 1.3)));
    const mt = Math.max(0, Math.round(baseline * 0.6 * mult * (rng() * 1.3)));
    days.push({ page_view: pv, lookup: lk, ticket: tk, ban: bn, mute: mt });
  }
  return days;
}
function buildAudit(staffId) {
  const rng = mulberry(hashSeed(staffId + "::audit"));
  const total = randInt(rng, 180, 420);
  const out = [];
  for (let i = 0; i < total; i++) {
    const r = rng();
    const type = r < 0.55 ? "page_view" : r < 0.8 ? "lookup" : r < 0.92 ? "ticket" : r < 0.97 ? "mute" : "ban";
    const daysAgo = Math.floor(rng() * 30);
    const hh = String(randInt(rng, 0, 23)).padStart(2, "0");
    const mm = String(randInt(rng, 0, 59)).padStart(2, "0");
    const time = `${hh}:${mm}`;
    const needsTarget = type !== "page_view";
    const entry = {
      id: `${staffId}-a-${i}`,
      type,
      daysAgo,
      time
    };
    if (needsTarget) {
      const nameSeed = hashSeed(staffId + ":" + i + ":target");
      entry.target = {
        name: pick(mulberry(nameSeed), NAMES_POOL) + String(randInt(rng, 1, 999)),
        steamId: steamIdFor(nameSeed)
      };
    } else {
      entry.page = pick(rng, PAGES);
    }
    if (type === "ban")
      entry.note = pick(rng, ["Cheating \xB7 permanent", "Toxicity \xB7 30d", "Teaming \xB7 permanent", "Ban evasion \xB7 permanent"]);
    if (type === "mute")
      entry.note = pick(rng, ["Toxicity \xB7 24h", "Spam \xB7 1h", "Slurs \xB7 7d"]);
    if (type === "ticket")
      entry.note = pick(rng, ["Resolved", "Closed - insufficient evidence", "Resolved - banned", "Resolved - warned"]);
    out.push(entry);
  }
  out.sort(
    (a, b) => a.daysAgo !== b.daysAgo ? a.daysAgo - b.daysAgo : b.time.localeCompare(a.time)
  );
  return out;
}
function ActivityChart({
  days,
  enabled
}) {
  const w = 800;
  const h = 260;
  const padL = 36;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const max = Math.max(
    1,
    ...days.flatMap(
      (d) => ACTIVITY_TYPES.filter((t) => enabled.has(t.key)).map((t) => d[t.key])
    )
  );
  const stepX = innerW / (days.length - 1);
  const yTicks = 4;
  return <svg
    viewBox={`0 0 ${w} ${h}`}
    className="w-full h-auto block"
    preserveAspectRatio="none"
  >
      {
    /* y grid */
  }
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
    const y = padT + innerH * i / yTicks;
    const v = Math.round(max * (yTicks - i) / yTicks);
    return <g key={i}>
            <line
      x1={padL}
      x2={w - padR}
      y1={y}
      y2={y}
      stroke="hsl(var(--border, 0 0% 30%))"
      strokeOpacity={0.25}
    />
            <text
      x={padL - 6}
      y={y + 3}
      textAnchor="end"
      className="fill-muted-foreground"
      style={{ fontSize: 9, fontFamily: "monospace" }}
    >
              {v}
            </text>
          </g>;
  })}
      {
    /* x labels: every 5 days */
  }
      {days.map(
    (_, i) => i % 5 === 0 || i === days.length - 1 ? <text
      key={i}
      x={padL + stepX * i}
      y={h - 6}
      textAnchor="middle"
      className="fill-muted-foreground"
      style={{ fontSize: 9, fontFamily: "monospace" }}
    >
            {i === days.length - 1 ? "today" : `-${29 - i}d`}
          </text> : null
  )}
      {
    /* lines */
  }
      {ACTIVITY_TYPES.filter((t) => enabled.has(t.key)).map((t) => {
    const d = days.map((bucket, i) => {
      const x = padL + stepX * i;
      const y = padT + innerH - bucket[t.key] / max * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
    return <g key={t.key}>
            <path d={d} fill="none" stroke={t.color} strokeWidth={1.5} />
            {days.map((bucket, i) => {
      const x = padL + stepX * i;
      const y = padT + innerH - bucket[t.key] / max * innerH;
      return <circle
        key={i}
        cx={x.toFixed(2)}
        cy={y.toFixed(2)}
        r={1.6}
        fill={t.color}
      />;
    })}
          </g>;
  })}
    </svg>;
}
function StaffAuditPage() {
  const { staff } = useAuth();
  const search = Route.useSearch();
  const staffId = search.staff ?? "";
  const target = staff.find((s) => s.id === staffId);
  const days = useMemo(() => buildDays(staffId), [staffId]);
  const entries = useMemo(() => buildAudit(staffId), [staffId]);
  const [enabled, setEnabled] = useState(
    new Set(ACTIVITY_TYPES.map((t) => t.key))
  );
  const [typeFilter, setTypeFilter] = useState("all");
  const filteredEntries = useMemo(
    () => typeFilter === "all" ? entries : entries.filter((e) => e.type === typeFilter),
    [entries, typeFilter]
  );
  const totals = useMemo(() => {
    const out = {
      page_view: 0,
      lookup: 0,
      ticket: 0,
      ban: 0,
      mute: 0
    };
    for (const d of days) for (const t of ACTIVITY_TYPES) out[t.key] += d[t.key];
    return out;
  }, [days]);
  return <div className="h-screen bg-background flex flex-col">
      <SiteNav />
      <main className="flex-1 flex">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto p-6 space-y-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <Link
    to="/manage/staff"
    className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
  >
                  <ArrowLeft className="size-3" /> Staff
                </Link>
                <span className="text-muted-foreground">/</span>
                <h1 className="text-lg font-semibold inline-flex items-center gap-2">
                  <Activity className="size-4" />
                  Audit log · {target?.name ?? staffId ?? "unknown"}
                </h1>
              </div>
            </div>

            {!target ? <p className="text-sm text-muted-foreground italic">
                Staff member not found. Open this page from the Staff list.
              </p> : <>
                <section>
                  <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3">
                    Activity · last 30 days
                  </h2>
                  <div className="bg-surface/40 ring-1 ring-border rounded-lg p-4">
                    <div className="flex flex-wrap gap-3 mb-3">
                      {ACTIVITY_TYPES.map((t) => {
    const active = enabled.has(t.key);
    return <button
      key={t.key}
      onClick={() => {
        setEnabled((prev) => {
          const next = new Set(prev);
          if (next.has(t.key)) next.delete(t.key);
          else next.add(t.key);
          return next;
        });
      }}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono uppercase ring-1 transition-colors ${active ? "ring-border bg-surface text-foreground" : "ring-border/40 text-muted-foreground opacity-60 hover:opacity-100"}`}
    >
                            <span
      className="inline-block size-2 rounded-full"
      style={{ background: t.color }}
    />
                            {t.label}
                            <span className="text-muted-foreground">· {totals[t.key]}</span>
                          </button>;
  })}
                    </div>
                    <ActivityChart days={days} enabled={enabled} />
                  </div>
                </section>

                <section>
                  <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
                    <span>Full audit log</span>
                    <span className="font-mono normal-case tracking-normal text-muted-foreground">
                      {filteredEntries.length} / {entries.length}
                    </span>
                  </h2>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {[
    ["all", "All"],
    ["page_view", "Page views"],
    ["lookup", "Lookups"],
    ["ticket", "Tickets"],
    ["ban", "Bans"],
    ["mute", "Mutes"]
  ].map(([k, label]) => <button
    key={k}
    onClick={() => setTypeFilter(k)}
    className={`px-2 py-1 rounded text-[10px] font-mono uppercase ring-1 transition-colors ${typeFilter === k ? "text-foreground ring-border bg-surface" : "text-muted-foreground ring-border/50 hover:bg-surface/50"}`}
  >
                        {label}
                      </button>)}
                  </div>
                  <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
                    <table className="w-full text-[11px] font-mono">
                      <thead>
                        <tr className="text-[9px] uppercase tracking-wider text-muted-foreground bg-surface/60">
                          <th className="px-2 py-1.5 text-left font-medium w-20">When</th>
                          <th className="px-2 py-1.5 text-left font-medium w-24">Type</th>
                          <th className="px-2 py-1.5 text-left font-medium">Target / Page</th>
                          <th className="px-2 py-1.5 text-left font-medium">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEntries.map((e) => {
    const t = ACTIVITY_TYPES.find((x) => x.key === e.type);
    return <tr key={e.id} className="border-t border-border">
                              <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">
                                {e.daysAgo === 0 ? "Today" : `-${e.daysAgo}d`} · {e.time}
                              </td>
                              <td className="px-2 py-1">
                                <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded ring-1 ring-border bg-surface text-[10px] uppercase"
      style={{ color: t.color }}
    >
                                  <span
      className="inline-block size-1.5 rounded-full"
      style={{ background: t.color }}
    />
                                  {t.label.replace(/s$/, "")}
                                </span>
                              </td>
                              <td className="px-2 py-1">
                                {e.target ? <Link
      to="/player-lookup"
      search={{ steam: e.target.steamId }}
      className="inline-flex items-center gap-1 text-brand hover:underline"
    >
                                    {e.target.name}
                                    <span className="text-muted-foreground">
                                      · {e.target.steamId}
                                    </span>
                                    <ExternalLink className="size-3" />
                                  </Link> : <span className="text-muted-foreground">{e.page}</span>}
                              </td>
                              <td className="px-2 py-1 text-muted-foreground">
                                {e.note ?? ""}
                              </td>
                            </tr>;
  })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>}
          </div>
        </div>
      </main>
    </div>;
}
export {
  Route
};

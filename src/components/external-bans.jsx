import { useMemo, useState } from "react";
const PARTNER_ORGS = [
  { id: "rustopia", name: "Rustopia", short: "RTP" },
  { id: "rusticated", name: "Rusticated", short: "RST" },
  { id: "rustafied", name: "Rustafied", short: "RFD" },
  { id: "rustoria", name: "Rustoria", short: "RTA" },
  { id: "moose", name: "Moose Gaming", short: "MG" },
  { id: "reddit", name: "Reddit.com", short: "RDT" }
];
const REASONS = [
  "Cheating - Aim assist",
  "Cheating - Wallhack",
  "Cheating - ESP",
  "Cheating - Spinbot",
  "Toxicity - Slurs",
  "Toxicity - Harassment",
  "Teaming over limit",
  "Ban evasion",
  "Stream sniping",
  "Exploiting (door glitching)",
  "Macro / scripting",
  "EAC bypass attempt"
];
const STAFF = [
  "Vex",
  "Caelum",
  "Nyx",
  "Praxis",
  "Orion",
  "Selene",
  "Kade",
  "Mira",
  "Juno",
  "Briar"
];
const NOTE_TEMPLATES = [
  "Caught on demo, clear snaps to multiple targets behind walls within 0.2s. Reviewed twice with senior team.",
  "Tracked player through walls during raid defense. Held aim through structures, then prefired exact angle.",
  "EAC kicked twice in 10 minutes for memory integrity. Player rejoined with a different account on same IP.",
  "Demo shows impossible recoil compensation on AK over sustained sprays - no recoil pattern visible at all.",
  "Multiple reports across the wipe. F7s correlated with kill feed during low-pop. Reviewed and confirmed.",
  "Player admitted to using a paid cheat in voice chat - clip submitted by reporter, audio verified.",
  "Snap aim on naked target at 180m through a wall, then immediately swapped to second target behind rock.",
  "Repeated bypass attempts logged by anti-cheat. Pattern matches known cheat loader signature.",
  "Toxic in global for entire wipe despite warnings and mutes. Escalated to perm after 5th offense.",
  "Caught teaming with 6 players on a duo server, full base shared, kits exchanged on camera."
];
const STATUSES = [
  { label: "Permanent", tone: "danger", weight: 6 },
  { label: "Expires in 14d", tone: "warning", weight: 1 },
  { label: "Expires in 3d", tone: "warning", weight: 1 },
  { label: "Expired", tone: "muted", weight: 3 }
];
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pickWeighted(rng, items) {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let r = rng() * total;
  for (const it of items) {
    if ((r -= it.weight) <= 0) return it;
  }
  return items[items.length - 1];
}
function relTime(rng) {
  const days = Math.floor(rng() * 720) + 1;
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}
function buildExternalBans(subjectId) {
  const seed = hash(subjectId + "::external-bans");
  const rng = mulberry32(seed);
  const count = Math.floor(rng() * 5);
  if (count === 0) return [];
  const usedOrgs = /* @__PURE__ */ new Set();
  const bans = [];
  for (let i = 0; i < count; i++) {
    let org = PARTNER_ORGS[Math.floor(rng() * PARTNER_ORGS.length)];
    let attempts = 0;
    while (usedOrgs.has(org.id) && attempts++ < 8) {
      org = PARTNER_ORGS[Math.floor(rng() * PARTNER_ORGS.length)];
    }
    usedOrgs.add(org.id);
    const status = pickWeighted(rng, STATUSES);
    bans.push({
      id: `${subjectId}-ext-${i}`,
      orgId: org.id,
      orgName: org.name,
      orgShort: org.short,
      reason: REASONS[Math.floor(rng() * REASONS.length)],
      by: STAFF[Math.floor(rng() * STAFF.length)],
      when: relTime(rng),
      status: status.label,
      statusTone: status.tone,
      note: NOTE_TEMPLATES[Math.floor(rng() * NOTE_TEMPLATES.length)]
    });
  }
  return bans;
}
function ExternalBansSection({ subjectId }) {
  const bans = useMemo(() => buildExternalBans(subjectId), [subjectId]);
  const [openId, setOpenId] = useState(null);
  const open = bans.find((b) => b.id === openId) ?? null;
  return <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>
          Bans on Other Orgs
          <span className="ml-2 normal-case tracking-normal text-[9px] text-muted-foreground/70">
            (read-only · shared banlist)
          </span>
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {bans.length}
        </span>
      </h2>
      {bans.length === 0 ? <p className="text-xs text-muted-foreground italic">
          No bans on partner orgs.
        </p> : <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-muted-foreground bg-surface/60">
                <th className="px-1.5 py-1 text-left font-medium">Org</th>
                <th className="px-1.5 py-1 text-left font-medium">Status</th>
                <th className="px-1.5 py-1 text-left font-medium">Reason</th>
                <th className="px-1.5 py-1 text-left font-medium">Staff</th>
                <th className="px-1.5 py-1 text-left font-medium">Note</th>
                <th className="px-1.5 py-1 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {bans.map((b) => {
    const statusColor = b.statusTone === "danger" ? "text-danger" : b.statusTone === "warning" ? "text-warning" : "text-muted-foreground";
    return <tr key={b.id} className="border-t border-border">
                    <td className="px-1.5 py-1 text-foreground font-semibold" title={b.orgName}>
                      {b.orgName}
                    </td>
                    <td className={`px-1.5 py-1 ${statusColor}`}>{b.status}</td>
                    <td className="px-1.5 py-1 text-foreground">{b.reason}</td>
                    <td className="px-1.5 py-1 text-muted-foreground">{b.by}</td>
                    <td className="px-1.5 py-1">
                      <button
      onClick={() => setOpenId(b.id)}
      className="text-brand hover:underline"
    >
                        view
                      </button>
                    </td>
                    <td className="px-1.5 py-1 text-right text-muted-foreground">
                      {b.when}
                    </td>
                  </tr>;
  })}
            </tbody>
          </table>
        </div>}
      {open && <div
    className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
    onClick={() => setOpenId(null)}
  >
          <div
    className="bg-background ring-1 ring-border rounded-lg p-5 max-w-md w-full shadow-xl"
    onClick={(e) => e.stopPropagation()}
  >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">
                <span className="text-danger">Ban</span> · {open.reason}
              </h3>
              <button
    onClick={() => setOpenId(null)}
    className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
  >
                close
              </button>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground uppercase mb-2">
              {open.orgName} · by {open.by} · {open.when} · {open.status}
            </p>
            <p className="text-sm text-foreground leading-relaxed">{open.note}</p>
            <p className="mt-4 text-[10px] font-mono text-muted-foreground uppercase tracking-wider border-t border-border pt-3">
              Read-only · shared from {open.orgName}'s banlist. Cannot be
              edited or removed here.
            </p>
          </div>
        </div>}
    </section>;
}
export {
  ExternalBansSection
};

import { useMemo, useState } from "react";
function bmBanStatusLabel(ban) {
  if (ban.permanent || !ban.expiresAt)
    return { label: "Permanent", tone: "danger" };
  const sec = ban.expiresAt - Math.floor(Date.now() / 1000);
  if (sec <= 0) return { label: "Expired", tone: "muted" };
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  return {
    label: days > 0 ? `Expires in ${days}d` : `Expires in ${hours}h`,
    tone: "warning",
  };
}
function bmBanWhen(bannedAt) {
  if (!bannedAt) return "—";
  const days = Math.floor((Date.now() / 1000 - bannedAt) / 86400);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}
function transformBmBans(rawBans) {
  return rawBans.map((b) => {
    const st = bmBanStatusLabel(b);
    return {
      id: b.bmBanId,
      orgName: b.bmOrgName ?? "Unknown Org",
      reason: b.reason ?? "—",
      by: "—",
      when: bmBanWhen(b.bannedAt),
      status: st.label,
      statusTone: st.tone,
      note: b.note ?? "No additional notes.",
    };
  });
}
function ExternalBansSection({ bans: rawBans }) {
  const bans = useMemo(
    () => transformBmBans(Array.isArray(rawBans) ? rawBans : []),
    [rawBans],
  );
  const [openId, setOpenId] = useState(null);
  const open = bans.find((b) => b.id === openId) ?? null;
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>
          All Bans
          <span className="ml-2 normal-case tracking-normal text-[9px] text-muted-foreground/70">
            (read-only · from BattleMetrics)
          </span>
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {bans.length}
        </span>
      </h2>
      {bans.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No external bans on file.
        </p>
      ) : (
        <div className="bg-surface/40 ring-1 ring-border rounded-lg overflow-hidden">
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
                const statusColor =
                  b.statusTone === "danger"
                    ? "text-danger"
                    : b.statusTone === "warning"
                      ? "text-warning"
                      : "text-muted-foreground";
                return (
                  <tr key={b.id} className="border-t border-border">
                    <td
                      className="px-1.5 py-1 text-foreground font-semibold"
                      title={b.orgName}
                    >
                      {b.orgName}
                    </td>
                    <td className={`px-1.5 py-1 ${statusColor}`}>{b.status}</td>
                    <td className="px-1.5 py-1 text-foreground">{b.reason}</td>
                    <td className="px-1.5 py-1 text-muted-foreground">
                      {b.by}
                    </td>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
            <p className="text-sm text-foreground leading-relaxed">
              {open.note}
            </p>
            <p className="mt-4 text-[10px] font-mono text-muted-foreground uppercase tracking-wider border-t border-border pt-3">
              Read-only · shared from {open.orgName}'s banlist. Cannot be edited
              or removed here.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
export { ExternalBansSection };

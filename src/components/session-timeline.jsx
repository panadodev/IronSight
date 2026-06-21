import { useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { useTimezone } from "@/lib/timezone-store";

function fmtDuration(seconds) {
  if (seconds == null || seconds < 0) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function dayKey(unix, tz) {
  // Group sessions by local calendar day for the viewer's timezone.
  return new Date(unix * 1000).toLocaleDateString(
    undefined,
    tz ? { timeZone: tz } : {},
  );
}

/**
 * Chronological view of a player's recent raw BM session windows
 * (player_session_windows). Complements the per-server playtime totals in
 * ServerHistorySection by showing *when* the player was actually online.
 */
function SessionTimeline({ sessionWindows }) {
  const tz = useTimezone();
  const [expanded, setExpanded] = useState(false);

  const groups = useMemo(() => {
    const windows = (sessionWindows ?? [])
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt);
    const visible = expanded ? windows : windows.slice(0, 25);
    const out = [];
    let current = null;
    for (const w of visible) {
      const key = dayKey(w.startedAt, tz);
      if (!current || current.key !== key) {
        current = { key, windows: [] };
        out.push(current);
      }
      current.windows.push(w);
    }
    return out;
  }, [sessionWindows, expanded, tz]);

  const total = sessionWindows?.length ?? 0;
  const nowSec = Date.now() / 1000;

  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <Clock className="size-3" />
        Session Timeline · 90d
        <span className="font-mono normal-case tracking-normal text-muted-foreground ml-auto">
          {total}
        </span>
      </h2>
      {total === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No recent sessions on record.
        </p>
      ) : (
        <>
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.key}>
                <p className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/70 mb-1.5">
                  {g.key}
                </p>
                <ul className="space-y-1">
                  {g.windows.map((w, i) => {
                    const online = w.stoppedAt == null;
                    const end = w.stoppedAt ?? nowSec;
                    const startLabel = new Date(
                      w.startedAt * 1000,
                    ).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      ...(tz ? { timeZone: tz } : {}),
                    });
                    return (
                      <li
                        key={`${w.bmServerId}-${w.startedAt}-${i}`}
                        className="flex items-center gap-2 bg-surface/40 ring-1 ring-border rounded px-2 py-1"
                      >
                        <span
                          className={`size-1.5 rounded-full shrink-0 ${online ? "bg-success animate-pulse" : "bg-muted-foreground/40"}`}
                        />
                        <span
                          className="text-[10px] font-medium truncate min-w-0 flex-1"
                          title={w.serverName ?? w.bmServerId}
                        >
                          {w.serverName ?? `Server ${w.bmServerId}`}
                        </span>
                        <span className="text-[9px] font-mono text-muted-foreground shrink-0">
                          {startLabel}
                        </span>
                        <span
                          className={`text-[9px] font-mono shrink-0 ${online ? "text-success" : "text-muted-foreground"}`}
                        >
                          {online ? "online" : fmtDuration(end - w.startedAt)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          {total > 25 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 text-[10px] font-mono text-brand hover:underline"
            >
              {expanded ? "Show less" : `Show all ${total}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export { SessionTimeline };

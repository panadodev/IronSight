import { useMemo, useRef, useState } from "react";
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

function serverColor(bmServerId) {
  let hash = 0;
  for (let i = 0; i < bmServerId.length; i++) {
    hash = (hash * 31 + bmServerId.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function TimeAxisLabels({ earliestSec, spanSec, tz }) {
  const labels = useMemo(() => {
    if (spanSec <= 0) return [];
    const result = [];
    // One label roughly every 10% of the span, anchored to clean boundaries
    const MS = earliestSec * 1000;
    const ME = (earliestSec + spanSec) * 1000;
    const rangeMs = ME - MS;

    let stepMs;
    if (rangeMs < 2 * 86400e3)
      stepMs = 6 * 3600e3; // <2 days: every 6h
    else if (rangeMs < 14 * 86400e3)
      stepMs = 86400e3; // <14 days: daily
    else if (rangeMs < 90 * 86400e3)
      stepMs = 7 * 86400e3; // <90 days: weekly
    else stepMs = 30 * 86400e3; // months

    // Round start to nearest step boundary
    const startMs = Math.ceil(MS / stepMs) * stepMs;
    for (let ts = startMs; ts <= ME; ts += stepMs) {
      const pct = ((ts / 1000 - earliestSec) / spanSec) * 100;
      if (pct < 0 || pct > 100) continue;
      const d = new Date(ts);
      const label =
        rangeMs < 2 * 86400e3
          ? d.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              ...(tz ? { timeZone: tz } : {}),
            })
          : d.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              ...(tz ? { timeZone: tz } : {}),
            });
      result.push({ pct, label });
    }
    return result;
  }, [earliestSec, spanSec, tz]);

  return (
    <div className="relative h-4 mt-1">
      {labels.map(({ pct, label }) => (
        <span
          key={pct}
          className="absolute text-[8px] font-mono text-muted-foreground/60 -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${pct}%` }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function SessionBar({
  w,
  earliestSec,
  spanSec,
  nowSec,
  rowIdx,
  onHover,
  onLeave,
}) {
  const end = w.stoppedAt ?? nowSec;
  const leftPct = ((w.startedAt - earliestSec) / spanSec) * 100;
  const widthPct = Math.max(0.8, ((end - w.startedAt) / spanSec) * 100);
  const color = serverColor(w.bmServerId);
  const online = w.stoppedAt == null;
  const top = rowIdx * 14;

  return (
    <div
      className="absolute rounded-sm cursor-default transition-opacity hover:opacity-90"
      style={{
        left: `${Math.min(leftPct, 99.2)}%`,
        width: `${Math.min(widthPct, 100 - leftPct)}%`,
        height: 10,
        top,
        background: color,
        opacity: online ? 1 : 0.75,
        boxShadow: online ? `0 0 4px ${color}` : undefined,
      }}
      onMouseEnter={(e) => onHover(w, e)}
      onMouseLeave={onLeave}
    />
  );
}

function SessionTimeline({ sessionWindows }) {
  const tz = useTimezone();
  const containerRef = useRef(null);
  const [tooltip, setTooltip] = useState(null); // { w, x, y }

  const { windows, earliestSec, spanSec, rows, totalHeight } = useMemo(() => {
    const raw = (sessionWindows ?? []).filter(
      (w) => w.startedAt != null && Number.isFinite(w.startedAt),
    );
    if (raw.length === 0)
      return {
        windows: [],
        earliestSec: 0,
        spanSec: 0,
        rows: [],
        totalHeight: 16,
      };

    const nowSec = Date.now() / 1000;
    const sorted = [...raw].sort((a, b) => a.startedAt - b.startedAt);
    const earliest = sorted[0].startedAt;
    const latest = sorted.reduce(
      (m, w) => Math.max(m, w.stoppedAt ?? nowSec),
      earliest,
    );
    const span = Math.max(latest - earliest, 3600);

    // Row assignment: greedy interval packing to avoid overlaps
    const rowEnds = [];
    const rowMap = sorted.map((w) => {
      const end = w.stoppedAt ?? nowSec;
      let assigned = -1;
      for (let r = 0; r < rowEnds.length; r++) {
        if (rowEnds[r] <= w.startedAt) {
          rowEnds[r] = end;
          assigned = r;
          break;
        }
      }
      if (assigned === -1) {
        assigned = rowEnds.length;
        rowEnds.push(end);
      }
      return assigned;
    });

    const maxRow = rowMap.reduce((max, v) => Math.max(max, v), 0);
    const height = (maxRow + 1) * 14 + 4;

    return {
      windows: sorted,
      earliestSec: earliest,
      spanSec: span,
      rows: rowMap,
      totalHeight: height,
    };
  }, [sessionWindows]);

  const nowSec = Date.now() / 1000;
  const total = sessionWindows?.length ?? 0;

  const handleHover = (w, e) => {
    setTooltip({ w, x: e.clientX, y: e.clientY });
  };
  const handleLeave = () => setTooltip(null);

  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <Clock className="size-3 shrink-0" />
        Session Timeline
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
          <div
            ref={containerRef}
            className="relative bg-surface/30 ring-1 ring-border rounded-md px-2 pt-2 pb-1 overflow-hidden"
          >
            {/* Grid lines */}
            {[0, 25, 50, 75, 100].map((pct) => (
              <div
                key={pct}
                className="absolute top-0 bottom-0 border-l border-border/30"
                style={{ left: `${pct}%` }}
              />
            ))}

            {/* Session bars */}
            <div className="relative w-full" style={{ height: totalHeight }}>
              {windows.map((w, i) => (
                <SessionBar
                  key={`${w.bmServerId}-${w.startedAt}-${i}`}
                  w={w}
                  earliestSec={earliestSec}
                  spanSec={spanSec}
                  nowSec={nowSec}
                  rowIdx={rows[i]}
                  onHover={handleHover}
                  onLeave={handleLeave}
                />
              ))}
            </div>

            {/* Time axis */}
            <TimeAxisLabels earliestSec={earliestSec} spanSec={spanSec} tz={tz} />
          </div>

          {tooltip && (
            <div
              className="pointer-events-none fixed z-50 bg-background ring-1 ring-border rounded shadow-lg px-2 py-1.5 text-[10px] font-mono max-w-52"
              style={{
                left: tooltip.x + 12,
                top: tooltip.y - 8,
                transform: "translateY(-100%)",
              }}
            >
              <p className="font-semibold text-foreground">
                {tooltip.w.serverName ?? `Server ${tooltip.w.bmServerId}`}
              </p>
              <p className="text-muted-foreground">
                {new Date(tooltip.w.startedAt * 1000).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  ...(tz ? { timeZone: tz } : {}),
                })}
              </p>
              <p className="text-muted-foreground">
                {tooltip.w.stoppedAt
                  ? fmtDuration(tooltip.w.stoppedAt - tooltip.w.startedAt)
                  : "Online now"}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export { SessionTimeline };

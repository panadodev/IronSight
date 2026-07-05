import { Link } from "@tanstack/react-router";
import { UserSearch, Gamepad2, Activity } from "lucide-react";
const SIZE_MAP = {
  xs: { icon: 9, pad: "p-0.25" },
  sm: { icon: 10, pad: "p-0.25" },
};
function PlayerLinks({ steamId, bmId, size = "xs" }) {
  const s = SIZE_MAP[size];
  const stop = (e) => e.stopPropagation();
  const btn =
    "inline-flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground " +
    s.pad;
  const bmHref = bmId
    ? `https://www.battlemetrics.com/rcon/players/${bmId}`
    : `https://www.battlemetrics.com/players?filter%5Bsearch%5D=${steamId}`;
  const bmTitle = bmId
    ? "Open BattleMetrics RCON profile"
    : "Search BattleMetrics";
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" onClick={stop}>
      {steamId && (
        <Link
          to="/player-lookup"
          search={{ steam: steamId }}
          className={btn}
          title="Open in Player Lookup"
          aria-label="Open in Player Lookup"
        >
          <UserSearch size={s.icon} />
        </Link>
      )}
      {steamId && (
        <a
          href={`https://steamcommunity.com/profiles/${steamId}`}
          target="_blank"
          rel="noopener noreferrer"
          className={btn}
          title="Open Steam profile"
          aria-label="Open Steam profile"
        >
          <Gamepad2 size={s.icon} />
        </a>
      )}
      <a
        href={bmHref}
        target="_blank"
        rel="noopener noreferrer"
        className={btn}
        title={bmTitle}
        aria-label={bmTitle}
      >
        <Activity size={s.icon} />
      </a>
    </span>
  );
}
export { PlayerLinks };

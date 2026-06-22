import { Link } from "@tanstack/react-router";
import { UserSearch, Gamepad2, Activity } from "lucide-react";
const SIZE_MAP = {
  xs: { icon: 22, pad: "p-1" },
  sm: { icon: 26, pad: "p-1" },
};
function PlayerLinks({ steamId, size = "xs" }) {
  const s = SIZE_MAP[size];
  const stop = (e) => e.stopPropagation();
  const btn =
    "inline-flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground " +
    s.pad;
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" onClick={stop}>
      <Link
        to="/player-lookup"
        search={{ steam: steamId }}
        className={btn}
        title="Open in Player Lookup"
        aria-label="Open in Player Lookup"
      >
        <UserSearch size={s.icon} />
      </Link>
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
      <a
        href={`https://www.battlemetrics.com/players?filter%5Bsearch%5D=${steamId}`}
        target="_blank"
        rel="noopener noreferrer"
        className={btn}
        title="Open BattleMetrics profile"
        aria-label="Open BattleMetrics profile"
      >
        <Activity size={s.icon} />
      </a>
    </span>
  );
}
export { PlayerLinks };

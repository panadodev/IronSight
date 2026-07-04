import { useMemo, useState } from "react";
import { Users, Ban, EyeOff } from "lucide-react";
import { PlayerLinks } from "@/components/player-links";

const BAN_SOURCE_LABEL = {
  eac: "EAC",
  vac: "VAC",
  game: "Game",
};

function steamIdColor(steamId) {
  let h = 0;
  for (let i = 0; i < steamId.length; i++)
    h = (h * 31 + steamId.charCodeAt(i)) | 0;
  return `oklch(0.5 0.14 ${Math.abs(h) % 360})`;
}

function FriendAvatar({ steamId, displayName, avatarUrl }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={displayName ?? steamId}
        className="size-7 rounded ring-1 ring-black/40 shrink-0 object-cover"
      />
    );
  }
  return (
    <div
      className="size-7 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0 text-[0.625rem]"
      style={{ background: steamIdColor(steamId) }}
    >
      {(displayName ?? steamId)
        .replace(/[\[\]]/g, "")
        .slice(0, 2)
        .toUpperCase()}
    </div>
  );
}

/**
 * Steam friends list with ban flags. The backend (getPlayerCacheData) attaches
 * ban status to each friend from locally cached data and sorts banned-first, so
 * known-cheater friends surface immediately — a strong teaming/alt signal.
 */
function PlayerFriendsSection({ friends }) {
  const [expanded, setExpanded] = useState(false);
  const [bannedOnly, setBannedOnly] = useState(false);

  const enriched = friends?.enriched ?? null;
  const bannedCount = useMemo(
    () => (enriched ?? []).filter((f) => f.banned).length,
    [enriched],
  );

  // Private friends list — nothing to show.
  if (friends?.public === false && !friends?.wasPublic) {
    return (
      <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
        <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
          <Users className="size-3 shrink-0" />
          Steam Friends
        </h2>
        <p className="text-xs text-muted-foreground italic flex items-center gap-1.5">
          <EyeOff className="size-3 shrink-0" />
          Friends list is private.
        </p>
      </section>
    );
  }

  if (!enriched || enriched.length === 0) {
    return (
      <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
        <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
          <Users className="size-3 shrink-0" />
          Steam Friends
        </h2>
        <p className="text-xs text-muted-foreground italic">
          No friends on record.
        </p>
      </section>
    );
  }

  const filtered = bannedOnly ? enriched.filter((f) => f.banned) : enriched;
  const visible = expanded ? filtered : filtered.slice(0, 18);

  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
        <Users className="size-3 shrink-0" />
        Steam Friends
        {bannedCount > 0 && (
          <span className="text-[0.625rem] font-mono normal-case tracking-normal text-danger bg-danger/10 ring-1 ring-danger/30 px-1.5 py-0.5 rounded">
            {bannedCount} banned
          </span>
        )}
        <span className="font-mono normal-case tracking-normal text-muted-foreground ml-auto">
          {friends?.friendCount ?? enriched.length}
        </span>
      </h2>

      {bannedCount > 0 && (
        <label className="flex items-center gap-1.5 mb-2 text-[0.625rem] font-mono text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={bannedOnly}
            onChange={(e) => setBannedOnly(e.target.checked)}
            className="accent-danger"
          />
          Banned only
        </label>
      )}

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {visible.map((f) => (
          <li
            key={f.steamId}
            className={`flex items-center gap-2 ring-1 rounded px-2 py-1.5 ${f.banned ? "bg-danger/5 ring-danger/30" : "bg-surface/40 ring-border"}`}
          >
            <FriendAvatar
              steamId={f.steamId}
              displayName={f.displayName}
              avatarUrl={f.avatarUrl}
            />
            <div className="min-w-0 flex-1">
              <p
                className="text-[0.6875rem] font-medium truncate"
                title={f.displayName ?? f.steamId}
              >
                {f.displayName ?? f.steamId}
              </p>
              <p className="text-[0.625rem] font-mono text-muted-foreground truncate flex items-center gap-1">
                {f.steamId}
                <PlayerLinks steamId={f.steamId} size="sm" />
              </p>
            </div>
            {f.banned && (
              <span
                className="inline-flex items-center gap-0.5 text-[0.625rem] font-mono uppercase tracking-wider text-danger bg-danger/10 ring-1 ring-danger/30 px-1.5 py-0.5 rounded shrink-0"
                title={`Banned: ${f.banSources.map((s) => BAN_SOURCE_LABEL[s] ?? s).join(", ")}`}
              >
                <Ban className="size-2.5" />
                {f.banSources.map((s) => BAN_SOURCE_LABEL[s] ?? s).join("/")}
              </span>
            )}
          </li>
        ))}
      </ul>

      {filtered.length > 18 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[0.625rem] font-mono text-brand hover:underline"
        >
          {expanded ? "Show less" : `Show all ${filtered.length}`}
        </button>
      )}
    </section>
  );
}

export { PlayerFriendsSection };

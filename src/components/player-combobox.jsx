import { useMemo, useRef, useState, useEffect } from "react";
function PlayerCombobox({
  players,
  value,
  onChange,
  disabled,
  placeholder = "Search by name or Steam ID...",
}) {
  const selected = players.find((p) => p.steamId === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    setQuery(selected?.name ?? "");
  }, [selected?.steamId]);
  useEffect(() => {
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return players;
    return players.filter(
      (p) => p.name.toLowerCase().includes(q) || p.steamId.includes(q),
    );
  }, [players, query]);
  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
      />
      {open && !disabled && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-background ring-1 ring-border rounded-md shadow-lg">
          {filtered.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">
              No matching players.
            </div>
          ) : (
            filtered.map((p) => {
              const active = p.steamId === value;
              return (
                <button
                  key={p.steamId}
                  type="button"
                  onClick={() => {
                    onChange(p.steamId);
                    setQuery(p.name);
                    setOpen(false);
                  }}
                  className={
                    "w-full text-left px-3 py-2 flex items-center gap-3 transition-colors " +
                    (active ? "bg-brand/10" : "hover:bg-surface/60")
                  }
                >
                  <div
                    className="size-8 rounded-sm shrink-0 grid place-items-center font-mono text-[0.625rem] font-bold text-background"
                    style={{ background: p.avatarColor }}
                  >
                    {p.name
                      .replace(/[\[\]]/g, "")
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className={
                        "text-sm font-medium truncate " +
                        (active ? "text-brand" : "")
                      }
                    >
                      {p.name}
                    </p>
                    <p className="text-[0.625rem] font-mono text-muted-foreground truncate">
                      Last seen {p.lastSeen}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
export { PlayerCombobox };

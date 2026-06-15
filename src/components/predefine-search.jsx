import { useEffect, useMemo, useState } from "react";
import { Search, ListChecks, X } from "lucide-react";
function PredefineSearch({ orgId, onPick }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!orgId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/predefines`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setItems(body.predefines ?? []);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...items].sort((a, b) =>
      a.keyword.localeCompare(b.keyword),
    );
    if (!q) return sorted.slice(0, 8);
    return sorted.filter((p) => {
      if (p.keyword.toLowerCase().includes(q)) return true;
      if (p.extraKeywords.some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [items, query]);
  return (
    <div className="mb-2 relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={query}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              setTimeout(() => setOpen(false), 120);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            placeholder="Search pre-defines for this org..."
            className="w-full h-8 pl-7 pr-8 text-xs bg-surface/60 border border-border rounded focus:outline-none focus:ring-1 focus:ring-brand/50"
          />
          {open && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setOpen(false);
                setQuery("");
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title="Close"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1">
          <ListChecks className="size-3" /> Pre-defines
        </span>
      </div>

      {open && (
        <div className="absolute z-20 left-0 right-0 bottom-full mb-1 max-h-[260px] overflow-y-auto bg-background border border-border rounded-md shadow-lg">
          {matches.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic p-3">
              {items.length === 0
                ? "No pre-defines yet for this org. Add some in Manage Org \u2192 Pre-defines."
                : "No pre-defines match your search."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(p.content);
                      setOpen(false);
                      setQuery("");
                    }}
                    className="w-full text-left p-2.5 hover:bg-surface/60 transition-colors"
                  >
                    <p className="text-xs font-semibold font-mono text-brand">
                      {p.keyword}
                    </p>
                    {p.extraKeywords.length > 0 && (
                      <p className="text-[10px] font-mono text-muted-foreground truncate">
                        aka {p.extraKeywords.join(", ")}
                      </p>
                    )}
                    <p className="text-[11px] text-foreground/80 mt-0.5 line-clamp-2 whitespace-pre-wrap">
                      {p.content}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
export { PredefineSearch };

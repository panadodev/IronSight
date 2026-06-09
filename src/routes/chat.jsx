import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Check, ChevronDown, MessageSquare } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { SERVERS, getPlayer } from "@/lib/mock-data";
import { useAuth } from "@/lib/auth-context";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
const Route = createFileRoute("/chat")({
  head: () => ({ meta: [{ title: "Chat Logs \u2014 IronSight" }] }),
  component: ChatPage,
});
const SAMPLES = [
  "anyone got scrap?",
  "third party at launch site",
  "trading 100 sulfur for 50 hqm",
  "this server is wiped when?",
  "stop camping bro",
  "gg ez",
  "where do i find components",
  "any admins on?",
  "lost my base to offline",
  "anyone wanna team?",
  "heli down at airfield",
  "rust+ broken again",
  "trading rockets",
  "lf duo eu",
  "great fight at oil",
  "who took my horse",
  "kicked for what?",
  "cargo incoming",
  "free wood at outpost",
  "stop kos at bandit lol",
  "blueprint wipe when?",
  "anyone selling guns",
  "we just got raided",
  "snipe from harbor",
  "rcon lag?",
];
function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 1e5) / 1e5;
  };
}
const NOW = Date.now();
const CHAT_BY_SERVER = (() => {
  const out = {};
  for (const srv of SERVERS) {
    const players = srv.playerIds;
    if (players.length === 0) {
      out[srv.id] = [];
      continue;
    }
    const r = rng(
      srv.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 31,
    );
    const lines = [];
    const COUNT = 220;
    const WINDOW = 24 * 60 * 60 * 1e3;
    for (let i = 0; i < COUNT; i++) {
      const ts = NOW - Math.floor(r() * WINDOW);
      const sid = players[Math.floor(r() * players.length)];
      const text = SAMPLES[Math.floor(r() * SAMPLES.length)];
      lines.push({
        id: `${srv.id}_${i}`,
        serverId: srv.id,
        steamId: sid,
        ts,
        text,
      });
    }
    lines.sort((a, b) => a.ts - b.ts);
    out[srv.id] = lines;
  }
  return out;
})();
function fmtLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseLocal(v) {
  return new Date(v).getTime();
}
function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString();
}
function ChatPage() {
  const { selectedOrgIds } = useAuth();
  const availableServers = useMemo(
    () => SERVERS.filter((s) => selectedOrgIds.includes(s.orgId)),
    [selectedOrgIds],
  );
  const [serverId, setServerId] = useState(
    availableServers[0]?.id ?? SERVERS[0]?.id ?? "",
  );
  const [start, setStart] = useState(fmtLocalInput(NOW - 6 * 60 * 60 * 1e3));
  const [end, setEnd] = useState(fmtLocalInput(NOW));
  const [query, setQuery] = useState("");
  const [selectedPlayers, setSelectedPlayers] = useState(
    /* @__PURE__ */ new Set(),
  );
  const startMs = parseLocal(start);
  const endMs = parseLocal(end);
  const inWindow = useMemo(() => {
    const lines = CHAT_BY_SERVER[serverId] ?? [];
    return lines.filter((l) => l.ts >= startMs && l.ts <= endMs);
  }, [serverId, startMs, endMs]);
  const playersInWindow = useMemo(() => {
    const ids = Array.from(new Set(inWindow.map((l) => l.steamId)));
    return ids.map(getPlayer).filter(Boolean);
  }, [inWindow]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inWindow.filter((l) => {
      if (selectedPlayers.size > 0 && !selectedPlayers.has(l.steamId))
        return false;
      if (q && !l.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [inWindow, selectedPlayers, query]);
  const toggle = (id) => {
    setSelectedPlayers((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const playersLabel =
    selectedPlayers.size === 0
      ? "All players"
      : selectedPlayers.size === 1
        ? (getPlayer(Array.from(selectedPlayers)[0])?.name ?? "1 player")
        : `${selectedPlayers.size} players`;
  const activeServer = SERVERS.find((s) => s.id === serverId);
  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-hidden flex flex-col">
        <div className="border-b border-border bg-surface/30 px-6 py-3 space-y-3 shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="size-4 text-brand" />
            <h1 className="text-sm font-semibold tracking-tight">
              Server Chat Logs
            </h1>
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              {filtered.length} / {inWindow.length} lines
            </span>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Server
              </Label>
              <select
                value={serverId}
                onChange={(e) => {
                  setServerId(e.target.value);
                  setSelectedPlayers(/* @__PURE__ */ new Set());
                }}
                className="h-8 px-2 text-xs bg-background ring-1 ring-border rounded-md"
              >
                {availableServers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {availableServers.length === 0 && (
                  <option value="">No servers in selected orgs</option>
                )}
              </select>
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                From
              </Label>
              <Input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-8 w-[195px] text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                To
              </Label>
              <Input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="h-8 w-[195px] text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Players
              </Label>
              <Popover>
                <PopoverTrigger asChild>
                  <button className="h-8 px-2.5 text-xs bg-background ring-1 ring-border rounded-md flex items-center gap-1.5 min-w-[160px]">
                    <span className="flex-1 text-left truncate">
                      {playersLabel}
                    </span>
                    <ChevronDown className="size-3 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-2">
                  <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-border">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      In timeframe ({playersInWindow.length})
                    </span>
                    <button
                      onClick={() =>
                        setSelectedPlayers(/* @__PURE__ */ new Set())
                      }
                      className="text-[10px] font-semibold text-brand hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto space-y-0.5">
                    {playersInWindow.length === 0 && (
                      <p className="text-[11px] text-muted-foreground px-2 py-2">
                        No players spoke in this window.
                      </p>
                    )}
                    {playersInWindow.map((p) => {
                      const checked = selectedPlayers.has(p.steamId);
                      return (
                        <button
                          key={p.steamId}
                          onClick={() => toggle(p.steamId)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
                        >
                          <span
                            className={
                              "size-4 rounded-sm grid place-items-center ring-1 " +
                              (checked
                                ? "bg-brand ring-brand text-brand-foreground"
                                : "ring-border text-transparent")
                            }
                          >
                            <Check className="size-3" />
                          </span>
                          <span className="text-xs font-medium flex-1 truncate">
                            {p.name}
                          </span>
                          <span className="text-[9px] font-mono text-muted-foreground truncate">
                            {p.steamId.slice(-6)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1 flex-1 min-w-[200px]">
              <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Search text
              </Label>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chat content…"
                className="h-8 text-xs"
              />
            </div>
          </div>

          {activeServer && (
            <p className="text-[10px] font-mono text-muted-foreground">
              {activeServer.name} · {activeServer.region}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              No chat lines match these filters.
            </p>
          ) : (
            <div className="space-y-0.5 font-mono text-[12px] max-w-4xl mx-auto">
              {filtered.map((l) => {
                const p = getPlayer(l.steamId);
                return (
                  <div
                    key={l.id}
                    className="flex gap-3 px-2 py-1 hover:bg-surface/50 rounded"
                  >
                    <span className="text-muted-foreground shrink-0 w-[140px]">
                      {fmtTime(l.ts)}
                    </span>
                    <span
                      className="font-semibold shrink-0 w-[140px] truncate"
                      style={{ color: p?.avatarColor }}
                      title={p?.steamId}
                    >
                      {p?.name ?? l.steamId}
                    </span>
                    <span className="text-foreground/90 break-words">
                      {l.text}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
export { Route };

import { PlayerLinks } from "@/components/player-links";
import { SiteNav } from "@/components/site-nav";
import { Input } from "@/components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger
} from "@/components/ui/popover";
import { useAuth } from "@/lib/auth-context";
import { SERVERS, getPlayer } from "@/lib/mock-data";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
const Route = createFileRoute("/player-list")({
  head: () => ({ meta: [{ title: "Player List \u2014 IronSight" }] }),
  component: PlayerListPage
});
const FIRST = [
  "Frost",
  "Shadow",
  "Iron",
  "Vex",
  "Ghost",
  "Reaper",
  "Toxic",
  "Salty",
  "Big",
  "Lone",
  "Mad",
  "Dirty",
  "Quick",
  "Silent",
  "Crazy",
  "Ninja",
  "Pixel",
  "Acid",
  "Cold",
  "Burnt",
  "Rusty",
  "Loot",
  "Heli",
  "Roof",
  "Naked",
  "Wolf",
  "Bear",
  "Hawk",
  "Viper",
  "Storm"
];
const LAST = [
  "Beast",
  "Killer",
  "Hunter",
  "Bandit",
  "Goblin",
  "Wizard",
  "Demon",
  "Sniper",
  "Ranger",
  "Slayer",
  "Crusher",
  "Hammer",
  "Maverick",
  "Smith",
  "Walker",
  "Kid",
  "Daddy",
  "Lord",
  "King",
  "Boss",
  "Fox",
  "Tank",
  "Diver",
  "Spike",
  "Junkie"
];
const TAGS = ["", "[RU]", "[EU]", "[NA]", "[SWE]", "[DE]", "[BR]", "[AU]", "[GB]"];
const COUNTRIES = ["US", "RU", "DE", "GB", "FR", "CA", "SE", "NL", "AU", "BR", "PL", "FI"];
function rng(seed) {
  let s = seed | 0;
  return () => {
    s = s * 1664525 + 1013904223 | 0;
    return (s >>> 0) % 1e5 / 1e5;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h * 16777619 >>> 0;
  }
  return h >>> 0;
}
function generateSyntheticPlayers(serverId, count, seedOffset) {
  const r = rng(hashStr(serverId) + seedOffset);
  const out = [];
  for (let i = 0; i < count; i++) {
    const tag = TAGS[Math.floor(r() * TAGS.length)];
    const name = `${tag}${tag ? " " : ""}${FIRST[Math.floor(r() * FIRST.length)]}${LAST[Math.floor(r() * LAST.length)]}${Math.floor(r() * 99)}`;
    const steamId = `7656119${String(8e9 + Math.floor(r() * 999999999)).slice(0, 10)}`;
    const vacBans = r() < 0.1 ? 1 : r() < 0.04 ? 2 : 0;
    out.push({
      steamId,
      name,
      avatarColor: `oklch(${0.4 + r() * 0.2} ${0.08 + r() * 0.1} ${Math.floor(r() * 360)})`,
      playtimeHours: Math.floor(r() * 5e3),
      accountAgeYears: +(r() * 11 + 0.3).toFixed(1),
      vacBans,
      daysSinceLastBan: vacBans > 0 ? Math.floor(r() * 1500) : null,
      lastSeen: `Now \u2014 ${serverId}`,
      priorOffenses: r() < 0.2 ? Math.floor(r() * 4) : 0,
      serverHoursThisWipe: Math.floor(r() * 100),
      country: COUNTRIES[Math.floor(r() * COUNTRIES.length)],
      profileCreated: "\u2014"
    });
  }
  return out;
}
function deriveLive(p, serverId) {
  const h = hashStr(p.steamId);
  const r = rng(h);
  const kills = Math.floor(r() * 80);
  const deaths = Math.max(1, Math.floor(r() * 60));
  const kd = +(kills / deaths).toFixed(2);
  const hitPct = +(r() * 38 + 8).toFixed(1);
  const bmHours = r() < 0.25 ? Math.floor(r() * 80) : 0;
  const proxy = r() < 0.18;
  const ping = Math.floor(r() * 220 + 18);
  let threat = 0;
  if (proxy) threat += 0.5;
  if (p.vacBans > 0) threat += 0.3;
  if (p.accountAgeYears < 1) threat += 0.4;
  if (p.playtimeHours < 100) threat += 0.3;
  if (bmHours > 20) threat += 0.5;
  if (hitPct > 40) threat += 0.4;
  if (kd > 3) threat += 0.3;
  if (p.priorOffenses >= 2) threat += 0.2;
  return {
    ...p,
    serverId,
    kills,
    deaths,
    kd,
    hitPct,
    bmHours,
    proxy,
    ping,
    threat: +Math.min(threat, 1.5).toFixed(2)
  };
}
const LIVE_PLAYERS = SERVERS.flatMap((srv, idx) => {
  const real = srv.playerIds.map(getPlayer);
  const synth = generateSyntheticPlayers(srv.id, 22 + idx * 4, 17 + idx);
  return [...real, ...synth].map((p) => deriveLive(p, srv.id));
});
const SORT_LABEL = {
  threat: "Threat",
  kills: "Kills",
  deaths: "Deaths",
  kd: "K/D",
  hitPct: "Avg Hit %",
  playtimeHours: "Steam Hours",
  bmHours: "BM Hours",
  ping: "Ping",
  name: "Name"
};
function threatColor(t) {
  if (t >= 1) return "bg-danger/15 text-danger ring-danger/40";
  if (t >= 0.6) return "bg-warning/15 text-warning ring-warning/40";
  return "bg-surface text-muted-foreground ring-border";
}
function PlayerListPage() {
  const { orgs, selectedOrgIds, maxRankAcross } = useAuth();
  const canAccess = maxRankAcross(selectedOrgIds) >= 2;
  const visibleServers = useMemo(
    () => SERVERS.filter((s) => selectedOrgIds.includes(s.orgId)),
    [selectedOrgIds]
  );
  const [serverIds, setServerIds] = useState(SERVERS.map((s) => s.id));
  const [sortKey, setSortKey] = useState("threat");
  const [sortDir, setSortDir] = useState("desc");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState(null);
  const PAGE_SIZE = 50;
  const rows = useMemo(() => {
    const allowedServerIds = new Set(visibleServers.map((s) => s.id));
    const set = new Set(serverIds.filter((id) => allowedServerIds.has(id)));
    const q = query.trim().toLowerCase();
    let list = LIVE_PLAYERS.filter((p) => set.has(p.serverId));
    if (q) {
      list = list.filter(
        (p) => p.name.toLowerCase().includes(q) || p.steamId.includes(q)
      );
    }
    list = [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string") {
        return sortDir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
      }
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return list;
  }, [serverIds, query, sortKey, sortDir, visibleServers]);
  useEffect(() => {
    setPage(1);
  }, [serverIds, query, sortKey, sortDir, visibleServers]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const setSort = (k) => {
    if (k === sortKey) {
      setSortDir((d) => d === "desc" ? "asc" : "desc");
    } else {
      setSortKey(k);
      setSortDir(k === "name" ? "asc" : "desc");
    }
  };
  const toggleServer = (id) => {
    setServerIds(
      (cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
  };
  const copySteamId = async (id) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => cur === id ? null : cur), 1500);
    } catch {
    }
  };
  const effectiveServerIds = serverIds.filter(
    (id) => visibleServers.some((s) => s.id === id)
  );
  const serverLabel = effectiveServerIds.length === visibleServers.length ? "All servers" : effectiveServerIds.length === 0 ? "No servers" : effectiveServerIds.map((id) => visibleServers.find((s) => s.id === id)?.name.replace(/^\[[^\]]+\]\s*/, "")).filter(Boolean).join(" \xB7 ");
  if (!canAccess) {
    return <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 grid place-items-center px-6">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="size-10 text-warning mx-auto" />
            <h1 className="text-lg font-semibold">Admin access required</h1>
            <p className="text-sm text-muted-foreground">
              The player list is restricted to <span className="font-mono text-foreground">Admin</span>{" "}
              and above. You don't have that rank in any of the currently selected orgs
              ({selectedOrgIds.map((id) => orgs.find((o) => o.id === id)?.short).filter(Boolean).join(", ") || "none"}).
              Try selecting a different organization from the top-left selector.
            </p>
          </div>
        </div>
      </div>;
  }
  return <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
          {
    /* Header */
  }
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Player List</h1>
              <p className="text-xs text-muted-foreground mt-1">
                Every player currently connected to your servers. Threat score uses
                the same weights as Threat Triggers.
              </p>
            </div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              {rows.length} online
            </div>
          </div>

          {
    /* Filters */
  }
          <div className="flex items-center gap-2 flex-wrap">
            <Input
    placeholder="Search name or Steam ID…"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
    className="h-9 max-w-xs"
  />
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground ml-auto">
              Sorted by {SORT_LABEL[sortKey]} {sortDir === "desc" ? "\u2193" : "\u2191"} · click a column to change
            </div>
          </div>


          {
    /* Table */
  }
          <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
            <div className="grid grid-cols-[minmax(220px,2fr)_140px_70px_60px_60px_60px_70px_70px_70px_60px_60px] gap-2 px-3 py-2 border-b border-border text-[10px] font-mono uppercase tracking-widest text-muted-foreground sticky top-0 bg-surface/80 backdrop-blur">
              <HeaderCell label="Player" k="name" sortKey={sortKey} sortDir={sortDir} onClick={setSort} />
              <Popover>
                <PopoverTrigger asChild>
                  <button
    className={"px-1 flex items-center gap-1 hover:text-foreground transition-colors text-left " + (effectiveServerIds.length !== visibleServers.length ? "text-brand" : "")}
    title={serverLabel}
  >
                    <span>Server</span>
                    <ChevronDown className="size-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-2">
                  <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-border">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      Filter servers
                    </span>
                    <button
    onClick={() => {
      const all = visibleServers.map((s) => s.id);
      setServerIds(effectiveServerIds.length === all.length ? [] : all);
    }}
    className="text-[10px] font-semibold text-brand hover:underline"
  >
                      {effectiveServerIds.length === visibleServers.length ? "Clear" : "Select all"}
                    </button>
                  </div>
                  <div className="space-y-0.5">
                    {visibleServers.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                        No servers in the selected orgs.
                      </div>}
                    {visibleServers.map((s) => {
    const checked = serverIds.includes(s.id);
    const org = orgs.find((o) => o.id === s.orgId);
    return <button
      key={s.id}
      onClick={() => toggleServer(s.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
    >
                          <span
      className={"size-3.5 rounded-sm ring-1 " + (checked ? "bg-brand ring-brand" : "ring-border")}
    />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium truncate normal-case tracking-normal">
                              {s.name}
                            </div>
                            <div className="text-[9px] font-mono text-muted-foreground normal-case tracking-normal">
                              {s.region} · {org?.short}
                            </div>
                          </div>
                        </button>;
  })}
                  </div>
                </PopoverContent>
              </Popover>


              <HeaderCell label="Threat" k="threat" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
              <HeaderCell label="Kills" k="kills" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
              <HeaderCell label="Deaths" k="deaths" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
              <HeaderCell label="K/D" k="kd" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
              <HeaderCell label="Hit %" k="hitPct" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
              <HeaderCell label="Steam h" k="playtimeHours" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
              <HeaderCell label="BM h" k="bmHours" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
              <div className="px-1 text-right">Proxy</div>
              <HeaderCell label="Ping" k="ping" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
            </div>

            <div className="divide-y divide-border/60">
              {pageRows.map((p) => {
    const srv = SERVERS.find((s) => s.id === p.serverId);
    return <div
      key={p.steamId}
      className="grid grid-cols-[minmax(220px,2fr)_140px_70px_60px_60px_60px_70px_70px_70px_60px_60px] gap-2 px-3 py-2 items-center text-xs hover:bg-surface/60 transition-colors"
    >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
      className="size-7 rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-[10px] text-background shrink-0"
      style={{ background: p.avatarColor }}
    >
                        {p.name.replace(/\[[^\]]*\]\s*/g, "").slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium truncate flex items-center gap-1.5">
                          <span className="truncate">{p.name}</span>
                          <PlayerLinks steamId={p.steamId} />
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground truncate flex items-center gap-1">
                          {p.steamId}
                          <button
      onClick={() => copySteamId(p.steamId)}
      className="inline-flex items-center justify-center rounded hover:text-foreground transition-colors"
      title="Copy Steam ID"
    >
                            {copiedId === p.steamId ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                          </button>
                        </div>
                      </div>

                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground truncate" title={srv?.name}>
                      {srv?.name.replace(/^\[[^\]]+\]\s*/, "")}
                    </div>
                    <div className="text-right">
                      <span
      className={"px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 " + threatColor(p.threat)}
    >
                        {p.threat.toFixed(2)}
                      </span>
                    </div>
                    <div className="text-right font-mono">{p.kills}</div>
                    <div className="text-right font-mono">{p.deaths}</div>
                    <div className="text-right font-mono">{p.kd.toFixed(2)}</div>
                    <div className="text-right font-mono">{p.hitPct.toFixed(1)}%</div>
                    <div className="text-right font-mono">{p.playtimeHours}</div>
                    <div className="text-right font-mono">{p.bmHours}</div>
                    <div className="text-right">
                      <span
      className={"px-1.5 py-0.5 rounded text-[9px] font-mono font-bold ring-1 " + (p.proxy ? "bg-danger/15 text-danger ring-danger/40" : "bg-surface ring-border text-muted-foreground")}
    >
                        {p.proxy ? "YES" : "NO"}
                      </span>
                    </div>
                    <div
      className={"text-right font-mono " + (p.ping > 150 ? "text-danger" : p.ping > 80 ? "text-warning" : "text-foreground")}
    >
                      {p.ping}
                    </div>
                  </div>;
  })}
              {rows.length === 0 && <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                  No players match your filters.
                </div>}
            </div>
          </div>

          {
    /* Pagination */
  }
          {rows.length > PAGE_SIZE && <div className="flex items-center justify-between text-xs">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, rows.length)} of {rows.length}
              </div>
              <div className="flex items-center gap-1">
                <button
    onClick={() => setPage((p) => Math.max(1, p - 1))}
    disabled={safePage === 1}
    className="px-2.5 h-8 rounded ring-1 ring-border bg-surface/40 hover:bg-surface disabled:opacity-40 disabled:hover:bg-surface/40"
  >
                  Prev
                </button>
                <span className="font-mono px-2">
                  {safePage} / {totalPages}
                </span>
                <button
    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
    disabled={safePage === totalPages}
    className="px-2.5 h-8 rounded ring-1 ring-border bg-surface/40 hover:bg-surface disabled:opacity-40 disabled:hover:bg-surface/40"
  >
                  Next
                </button>
              </div>
            </div>}
        </div>
      </div>
    </div>;
}
function HeaderCell({
  label,
  k,
  sortKey,
  sortDir,
  onClick,
  align = "left"
}) {
  const active = sortKey === k;
  return <button
    onClick={() => onClick(k)}
    className={"px-1 flex items-center gap-1 hover:text-foreground transition-colors " + (align === "right" ? "justify-end" : "justify-start") + (active ? " text-foreground" : "")}
  >
      <span>{label}</span>
      {active && (sortDir === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
    </button>;
}
export {
    Route
};


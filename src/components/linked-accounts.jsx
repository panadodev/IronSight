import { useMemo, useState, useRef, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import {
  Wifi,
  Building2,
  ShieldAlert,
  ExternalLink,
  Filter,
  Ban,
  AlertOctagon,
  Users,
  Gamepad2,
  MessageSquare,
  CalendarRange,
  EyeOff,
  ChevronDown,
  Check,
  Copy,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PlayerLinks } from "@/components/player-links";
import { getAssociationsFor } from "@/lib/associations";
function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 1831565813) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const IP_TYPE_META = {
  residential: { label: "Residential", tone: "text-success", short: "RES" },
  business: { label: "Business", tone: "text-brand", short: "BIZ" },
  mobile: { label: "Mobile", tone: "text-foreground", short: "MOB" },
  proxy_vpn: { label: "Proxy / VPN", tone: "text-danger", short: "VPN" },
  hosting: { label: "Hosting / DC", tone: "text-warning", short: "HOST" },
};
const NAME_POOL = [
  "ToxicTim",
  "[RU] Zorin",
  "BigGrub_99",
  "ShadowKiller",
  "FennecFox",
  "SaltMinerXD",
  "[SWE] Bjorn",
  "GhostLeaf",
  "MeatTaco",
  "NoLifeAlt",
  "ColdBrew",
  "PixelGrim",
  "RatKing",
  "milf_diff",
  "[m1lf] \u044D\u043A\u0441\u0442\u0440\u0435\u043C\u0438\u0441\u0442",
  "zxboctababcs\u043F\u0440u\u043C",
  "DeathMask99",
  "Adolf",
  "daddy",
  "[mllf] zxbocta",
  "VodkaBear",
  "PoutineKing",
  "BunkerBob",
  "RaidGremlin",
  "BlueWindow",
];
const COUNTRIES = [
  "US",
  "RU",
  "DE",
  "GB",
  "CA",
  "AU",
  "FR",
  "SE",
  "NL",
  "MX",
  "BR",
  "PL",
];
const COLORS = [
  "oklch(0.45 0.15 30)",
  "oklch(0.5 0.12 200)",
  "oklch(0.55 0.14 140)",
  "oklch(0.5 0.16 60)",
  "oklch(0.4 0.08 280)",
  "oklch(0.55 0.18 50)",
  "oklch(0.5 0.1 250)",
];
const GROUP_NAMES = [
  "rust gremlins",
  "eu raiders club",
  "salt mine refugees",
  "no life crew",
  "tarp tower TRIO",
  "wipe day wolves",
  "[milf] backup",
  "smolbase enjoyers",
];
const FRIEND_NAMES = [
  "Kiro",
  "ColdBrew",
  "VodkaBear",
  "Marcy",
  "Pixel",
  "RatKing",
  "Soup",
  "Magpie",
  "Hex",
  "TinyDoor",
  "Bunkerbob",
  "Wattson",
  "GremlinRaid",
  "Snowpea",
  "DrSludge",
  "TarpFu",
  "Loot_Goblin",
  "[RU] Slava",
  "Mango",
  "QuietKid",
  "Helios",
  "Bee",
  "NoSleep",
  "Crumb",
  "OneShot",
];
const GAMES = [
  { appId: 252490, name: "Rust" },
  { appId: 730, name: "Counter-Strike 2" },
  { appId: 271590, name: "Grand Theft Auto V" },
  { appId: 578080, name: "PUBG: BATTLEGROUNDS" },
  { appId: 359550, name: "Rainbow Six Siege" },
  { appId: 1172470, name: "Apex Legends" },
  { appId: 252950, name: "Rocket League" },
  { appId: 304930, name: "Unturned" },
];
const BAN_REASONS = [
  "Cheating \u2014 aim assist",
  "Cheating \u2014 wallhack",
  "Toxicity \u2014 slurs",
  "Ban evasion",
  "Teaming on solo server",
  "Stream sniping",
];
function randomIp(rng, type) {
  switch (type) {
    case "residential":
      return `${randInt(rng, 24, 99)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
    case "business":
      return `${randInt(rng, 200, 223)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
    case "mobile":
      return `${randInt(rng, 100, 172)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
    case "proxy_vpn":
      return `${randInt(rng, 45, 89)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
    case "hosting":
      return `${randInt(rng, 134, 199)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
  }
}
function maskIp(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4)
    return "\u2022\u2022.\u2022\u2022.\u2022\u2022.\u2022\u2022";
  return `\u2022\u2022.\u2022\u2022.\u2022\u2022.${parts[3]}`;
}
function similarity(a, b) {
  const grams = (s) => {
    const t = s.toLowerCase().replace(/\s+/g, "");
    const g = /* @__PURE__ */ new Set();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 && B.size === 0) return 100;
  let inter = 0;
  A.forEach((g) => B.has(g) && inter++);
  return Math.round((2 * inter * 100) / (A.size + B.size));
}
function generateLinkedAccounts(subjectId, subjectName) {
  const rng = mulberry(hashSeed(subjectId));
  const count = randInt(rng, 8, 140);
  const out = [];
  const usedNames = /* @__PURE__ */ new Set();
  for (let i = 0; i < count; i++) {
    let name = pick(rng, NAME_POOL);
    let safety = 0;
    while (usedNames.has(name) && safety++ < 10) name = pick(rng, NAME_POOL);
    usedNames.add(name);
    const sid =
      "7656" +
      String(randInt(rng, 1199e7, 11999999999))
        .padStart(13, "0")
        .slice(0, 13);
    const ipCount = randInt(rng, 1, 5);
    const sharedIps = [];
    for (let j = 0; j < ipCount; j++) {
      const type = pick(rng, [
        "residential",
        "residential",
        "residential",
        "business",
        "mobile",
        "proxy_vpn",
        "proxy_vpn",
        "hosting",
      ]);
      sharedIps.push({
        ip: randomIp(rng, type),
        type,
        overlapDays: randInt(rng, 1, 320),
        hits: randInt(rng, 2, 480),
      });
    }
    const gameBanned = rng() < 0.28;
    const serverBanned = rng() < 0.42;
    const hasBan = gameBanned || serverBanned;
    const lastBanAt = hasBan ? Date.now() - randInt(rng, 1, 540) * 864e5 : null;
    const groupCount = randInt(rng, 0, 3);
    const sharedSmallGroups = [];
    for (let j = 0; j < groupCount; j++) {
      sharedSmallGroups.push({
        name: pick(rng, GROUP_NAMES),
        members: randInt(rng, 3, 95),
      });
    }
    const nameVariants = [
      name,
      name.toLowerCase(),
      name.replace(/\d+/g, ""),
      name + String(randInt(rng, 1, 99)),
      "[" +
        subjectName
          .replace(/[\[\]]/g, "")
          .slice(0, 3)
          .toUpperCase() +
        "] " +
        name.slice(0, 6),
    ];
    const subjVariants = [
      subjectName,
      subjectName.toLowerCase(),
      subjectName.replace(/[\[\]]/g, ""),
      subjectName.split(" ").slice(-1)[0] ?? subjectName,
    ];
    const matches = [];
    for (const s of subjVariants) {
      for (const l of nameVariants) {
        matches.push({
          subjectName: s,
          linkedName: l,
          similarity: similarity(s, l),
        });
      }
    }
    matches.sort((a, b) => b.similarity - a.similarity);
    const similarNames = matches.slice(0, 5);
    const gameCount = randInt(rng, 0, 4);
    const pickedGames = /* @__PURE__ */ new Set();
    const mutualGames = [];
    for (let j = 0; j < gameCount; j++) {
      const g = pick(rng, GAMES);
      if (pickedGames.has(g.appId)) continue;
      pickedGames.add(g.appId);
      const dayA = randInt(rng, 0, 220);
      const dayB = randInt(rng, 0, 220);
      mutualGames.push({
        appId: g.appId,
        name: g.name,
        subjectLastPlayed: new Date(Date.now() - dayA * 864e5)
          .toISOString()
          .slice(0, 10),
        linkedLastPlayed: new Date(Date.now() - dayB * 864e5)
          .toISOString()
          .slice(0, 10),
      });
    }
    const banMonthsAgo =
      lastBanAt !== null
        ? Math.floor((Date.now() - lastBanAt) / (30 * 864e5))
        : -1;
    const rustYear = [];
    const now = /* @__PURE__ */ new Date();
    const baseline = randInt(rng, 8, 45);
    for (let m = 11; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const month =
        d.toLocaleString("en-US", { month: "short" }) +
        " " +
        String(d.getFullYear()).slice(2);
      const isAfterGameBan =
        gameBanned && banMonthsAgo >= 0 && m < banMonthsAgo;
      const isBanMonth = banMonthsAgo >= 0 && m === banMonthsAgo;
      const isAfterServerBan =
        serverBanned && !gameBanned && banMonthsAgo >= 0 && m < banMonthsAgo;
      let sessions;
      let hours;
      if (isAfterGameBan) {
        sessions = 0;
        hours = 0;
      } else if (isBanMonth) {
        sessions = Math.floor(baseline * (0.2 + rng() * 0.4));
        hours = sessions * randInt(rng, 1, 4);
      } else if (isAfterServerBan) {
        sessions = Math.floor(baseline * (0.3 + rng() * 0.5));
        hours = sessions * randInt(rng, 1, 5);
      } else {
        const variance = 0.55 + rng() * 0.9;
        sessions = Math.max(0, Math.floor(baseline * variance));
        hours = sessions === 0 ? 0 : sessions * randInt(rng, 1, 6);
      }
      rustYear.push({ month, hours, sessions });
    }
    const friendCount = randInt(rng, 0, 8);
    const mutualFriends = [];
    const pickedFriends = /* @__PURE__ */ new Set();
    for (let j = 0; j < friendCount; j++) {
      const f = pick(rng, FRIEND_NAMES);
      if (pickedFriends.has(f)) continue;
      pickedFriends.add(f);
      mutualFriends.push(f);
    }
    const crossComment =
      rng() < 0.35
        ? {
            commenterFriendOf: rng() < 0.5 ? "subject" : "linked",
            commenterName: pick(rng, FRIEND_NAMES),
            profileOwnerName: "",
            // filled below
          }
        : null;
    if (crossComment) {
      crossComment.profileOwnerName =
        crossComment.commenterFriendOf === "subject" ? name : subjectName;
    }
    out.push({
      steamId: sid,
      name,
      avatarColor: pick(rng, COLORS),
      country: pick(rng, COUNTRIES),
      accountAgeYears: +(rng() * 10 + 0.5).toFixed(1),
      gameBanned,
      serverBanned,
      lastBanAt,
      lastBanReason: hasBan ? pick(rng, BAN_REASONS) : null,
      mutualFriends,
      crossComment,
      sharedSmallGroups,
      sharedIps,
      similarNames,
      mutualGames,
      rustYear,
    });
  }
  out.sort((a, b) => (b.lastBanAt ?? -Infinity) - (a.lastBanAt ?? -Infinity));
  return out;
}
function getLinkedAccountsSummary(subjectId, subjectName) {
  const accounts = generateLinkedAccounts(subjectId, subjectName);
  let gameBanned = 0;
  let serverBanned = 0;
  let anyBan = 0;
  let residentialWithBan = 0;
  for (const a of accounts) {
    if (a.gameBanned) gameBanned++;
    if (a.serverBanned) serverBanned++;
    if (a.gameBanned || a.serverBanned) {
      anyBan++;
      if (a.sharedIps.some((ip) => ip.type === "residential"))
        residentialWithBan++;
    }
  }
  return {
    total: accounts.length,
    gameBanned,
    serverBanned,
    anyBan,
    residentialWithBan,
  };
}
function MiniAvatar({ color, name }) {
  return (
    <div
      className="rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0 size-7 text-[10px]"
      style={{ background: color }}
    >
      {name
        .replace(/[\[\]]/g, "")
        .slice(0, 2)
        .toUpperCase()}
    </div>
  );
}
function IpChip({ ip, type, canSeeReal }) {
  const meta = IP_TYPE_META[type];
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface ring-1 ring-border text-[10px] font-mono">
      <span className={`uppercase ${meta.tone}`}>{meta.short}</span>
      <span className="text-muted-foreground">
        {canSeeReal ? ip : maskIp(ip)}
      </span>
    </span>
  );
}
function formatBanAge(ms) {
  const days = Math.floor((Date.now() - ms) / 864e5);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}
function LinkedAccountIntelSection({ subjectId, subjectName }) {
  const summary = useMemo(
    () => getLinkedAccountsSummary(subjectId, subjectName),
    [subjectId, subjectName],
  );
  const hasResRisk = summary.residentialWithBan > 0;
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Wifi className="size-3" />
          IP-Linked Accounts
        </span>
        <Link
          to="/player-lookup"
          search={{ steam: subjectId }}
          className="text-[9px] font-mono uppercase tracking-wider text-brand hover:underline inline-flex items-center gap-1"
        >
          Lookup <ExternalLink className="size-2.5" />
        </Link>
      </h2>
      <div className="bg-surface/40 ring-1 ring-border rounded-lg p-3 space-y-2">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-lg font-mono font-bold text-foreground">
              {summary.total}
            </p>
            <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
              Linked
            </p>
          </div>
          <div>
            <p className="text-lg font-mono font-bold text-danger">
              {summary.gameBanned}
            </p>
            <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
              Game ban
            </p>
          </div>
          <div>
            <p className="text-lg font-mono font-bold text-warning">
              {summary.serverBanned}
            </p>
            <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
              Server ban
            </p>
          </div>
        </div>
        {hasResRisk ? (
          <div className="flex items-start gap-2 bg-danger/10 ring-1 ring-danger/40 rounded p-2">
            <ShieldAlert className="size-3.5 text-danger shrink-0 mt-0.5" />
            <p className="text-[10px] text-danger leading-snug">
              <span className="font-bold">{summary.residentialWithBan}</span>{" "}
              {summary.residentialWithBan === 1
                ? "account shares"
                : "accounts share"}{" "}
              a <span className="font-bold">residential IP</span> and{" "}
              {summary.residentialWithBan === 1 ? "has" : "have"} a game or
              server ban.
            </p>
          </div>
        ) : summary.anyBan > 0 ? (
          <p className="text-[10px] text-muted-foreground">
            {summary.anyBan} banned linked{" "}
            {summary.anyBan === 1 ? "account" : "accounts"}, but none share a
            residential IP.
          </p>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            No bans on any linked accounts.
          </p>
        )}
      </div>
    </section>
  );
}
function LinkedAccountsSection({ subjectId, subjectName, canSeeRealIp }) {
  const accounts = useMemo(
    () => generateLinkedAccounts(subjectId, subjectName),
    [subjectId, subjectName],
  );
  const [activeIpTypes, setActiveIpTypes] = useState(
    new Set(Object.keys(IP_TYPE_META)),
  );
  const [banFilter, setBanFilter] = useState("all");
  const [openId, setOpenId] = useState(null);
  const [pageSize, setPageSize] = useState(10);
  const [ipDropdownOpen, setIpDropdownOpen] = useState(false);
  const [banDropdownOpen, setBanDropdownOpen] = useState(false);
  const ipRef = useRef(null);
  const banRef = useRef(null);
  useEffect(() => {
    function onDocClick(e) {
      if (ipRef.current && !ipRef.current.contains(e.target))
        setIpDropdownOpen(false);
      if (banRef.current && !banRef.current.contains(e.target))
        setBanDropdownOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);
  const toggleIpType = (t) => {
    setActiveIpTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };
  const banLabelMap = {
    all: "All",
    any: "Any ban",
    game: "Game ban",
    server: "Server ban",
    none: "No bans",
  };
  const filtered = useMemo(() => {
    return accounts.filter((a) => {
      if (activeIpTypes.size === 0) return false;
      const ipOk = a.sharedIps.some((ip) => activeIpTypes.has(ip.type));
      if (!ipOk) return false;
      switch (banFilter) {
        case "all":
          return true;
        case "any":
          return a.gameBanned || a.serverBanned;
        case "game":
          return a.gameBanned;
        case "server":
          return a.serverBanned;
        case "none":
          return !a.gameBanned && !a.serverBanned;
      }
    });
  }, [accounts, activeIpTypes, banFilter]);
  const visible = useMemo(
    () => (pageSize === "all" ? filtered : filtered.slice(0, pageSize)),
    [filtered, pageSize],
  );
  const hiddenCount = filtered.length - visible.length;
  const openAccount = useMemo(
    () => accounts.find((a) => a.steamId === openId) ?? null,
    [accounts, openId],
  );
  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Wifi className="size-3" />
          Linked Accounts
          {!canSeeRealIp && (
            <span
              className="inline-flex items-center gap-1 text-warning normal-case tracking-normal text-[10px] font-mono"
              title="IPs are masked for your rank. Senior admins see full addresses."
            >
              <EyeOff className="size-3" />
              IPs masked
            </span>
          )}
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {filtered.length} / {accounts.length}
        </span>
      </h3>

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* IP Type checkbox dropdown */}
        <div ref={ipRef} className="relative">
          <button
            onClick={() => setIpDropdownOpen((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono uppercase ring-1 transition-colors ${ipDropdownOpen ? "text-foreground ring-border bg-surface" : "text-muted-foreground ring-border/50 hover:bg-surface/50"}`}
          >
            <Filter className="size-3" />
            IP type
            <span className="inline-flex items-center justify-center rounded-full bg-brand/15 text-brand text-[9px] px-1.5 leading-4 min-w-[1.25rem]">
              {activeIpTypes.size}
            </span>
            <ChevronDown
              className={`size-3 transition-transform ${ipDropdownOpen ? "rotate-180" : ""}`}
            />
          </button>
          {ipDropdownOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 min-w-[10rem] rounded-lg bg-surface border border-border shadow-lg p-2 space-y-1">
              {Object.keys(IP_TYPE_META).map((t) => {
                const meta = IP_TYPE_META[t];
                const checked = activeIpTypes.has(t);
                return (
                  <label
                    key={t}
                    className="flex items-center gap-2 px-2 py-1 rounded text-[11px] font-mono cursor-pointer hover:bg-surface/60"
                  >
                    <span
                      className={`inline-flex items-center justify-center size-3.5 rounded border transition-colors ${checked ? "bg-brand border-brand text-brand-foreground" : "border-border bg-transparent"}`}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() => toggleIpType(t)}
                    />
                    <span className={meta.tone}>{meta.label}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Ban type select dropdown */}
        <div ref={banRef} className="relative">
          <button
            onClick={() => setBanDropdownOpen((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono uppercase ring-1 transition-colors ${banDropdownOpen ? "text-foreground ring-border bg-surface" : "text-muted-foreground ring-border/50 hover:bg-surface/50"}`}
          >
            <Ban className="size-3" />
            {banLabelMap[banFilter]}
            <ChevronDown
              className={`size-3 transition-transform ${banDropdownOpen ? "rotate-180" : ""}`}
            />
          </button>
          {banDropdownOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 min-w-[10rem] rounded-lg bg-surface border border-border shadow-lg p-1">
              {[
                ["all", "All"],
                ["any", "Any ban"],
                ["game", "Game ban"],
                ["server", "Server ban"],
                ["none", "No bans"],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => {
                    setBanFilter(k);
                    setBanDropdownOpen(false);
                  }}
                  className={`w-full text-left px-2 py-1.5 rounded text-[11px] font-mono transition-colors ${banFilter === k ? "bg-brand/15 text-brand" : "text-muted-foreground hover:bg-surface/60"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="flex-1" />

        {/* Show amount */}
        <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground inline-flex items-center gap-2">
          Show
          <select
            value={String(pageSize)}
            onChange={(e) => {
              const v = e.target.value;
              setPageSize(v === "all" ? "all" : Number(v));
            }}
            className="bg-surface border border-border rounded px-2 py-1 text-[10px] font-mono [&>option]:bg-surface [&>option]:text-foreground"
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="all">100+</option>
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          Showing {visible.length} of {filtered.length}
        </span>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No linked accounts match the current filters.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 ring-1 ring-border rounded-lg bg-surface/40 overflow-hidden">
          {visible.map((a) => {
            const ipCount = a.sharedIps.length;
            const typeCounts = a.sharedIps.reduce((acc, ip) => {
              acc[ip.type] = (acc[ip.type] ?? 0) + 1;
              return acc;
            }, {});
            return (
              <li key={a.steamId} className="px-3 py-2 flex items-center gap-3">
                <MiniAvatar color={a.avatarColor} name={a.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold truncate max-w-[16rem]">
                      {a.name}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground inline-flex items-center gap-1">
                      {a.steamId}
                      <PlayerLinks steamId={a.steamId} size="xs" />
                    </span>
                    {a.gameBanned && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-danger/15 text-danger text-[10px] font-mono uppercase ring-1 ring-danger/40">
                        <AlertOctagon className="size-3" /> Game ban
                      </span>
                    )}
                    {a.serverBanned && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning/15 text-warning text-[10px] font-mono uppercase ring-1 ring-warning/40">
                        <Ban className="size-3" /> Server ban
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] font-mono text-muted-foreground">
                    <span>
                      {ipCount} shared IP{ipCount === 1 ? "" : "s"}
                    </span>
                    <span>·</span>
                    {Object.entries(typeCounts).map(([t, n]) => (
                      <span key={t} className={IP_TYPE_META[t].tone}>
                        {n} {IP_TYPE_META[t].short}
                      </span>
                    ))}
                    {a.lastBanAt && (
                      <>
                        <span>·</span>
                        <span>last ban {formatBanAge(a.lastBanAt)}</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setOpenId(a.steamId)}
                  className="px-2.5 py-1.5 rounded bg-brand text-brand-foreground text-[10px] font-mono uppercase tracking-widest hover:opacity-90 shrink-0"
                >
                  Compare
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hiddenCount > 0 && (
        <button
          onClick={() =>
            setPageSize((s) => (s === 10 ? 25 : s === 25 ? 50 : "all"))
          }
          className="mt-2 w-full text-center text-[10px] font-mono uppercase tracking-widest text-brand hover:underline py-1.5 ring-1 ring-border rounded bg-surface/40"
        >
          + {hiddenCount} more linked account{hiddenCount === 1 ? "" : "s"}{" "}
          hidden — increase limit
        </button>
      )}

      <ComparisonDialog
        open={openAccount !== null}
        onClose={() => setOpenId(null)}
        subjectId={subjectId}
        subjectName={subjectName}
        account={openAccount}
        canSeeRealIp={canSeeRealIp}
      />
    </section>
  );
}
function ComparisonDialog({
  open,
  onClose,
  subjectId,
  subjectName,
  account,
  canSeeRealIp,
}) {
  const [copied, setCopied] = useState(false);
  if (!account) return null;
  const typeTotals = account.sharedIps.reduce(
    (acc, ip) => {
      acc[ip.type] = (acc[ip.type] ?? 0) + 1;
      return acc;
    },
    { residential: 0, business: 0, mobile: 0, proxy_vpn: 0, hosting: 0 },
  );
  const maxHours = Math.max(1, ...account.rustYear.map((m) => m.hours));
  const buildClipboardText = () => {
    const teammates = Array.from(getAssociationsFor(subjectId).keys());
    const lines = [];
    lines.push(`SID: ${subjectId}`);
    lines.push(`Steam ID of linked: ${account.steamId}`);
    lines.push("");
    lines.push(
      `Team: ${teammates.length > 0 ? teammates.join(", ") : "(none reported)"}`,
    );
    lines.push("");
    const links = [];
    if (account.sharedIps.length > 0) {
      const parts = [
        `${account.sharedIps.length} ip link${account.sharedIps.length === 1 ? "" : "s"}`,
      ];
      for (const t of Object.keys(IP_TYPE_META)) {
        const n = typeTotals[t];
        if (n > 0) parts.push(`${n} ${IP_TYPE_META[t].label.toLowerCase()}`);
      }
      links.push(parts.join(", "));
    }
    if (account.mutualFriends.length > 0) {
      links.push(
        `${account.mutualFriends.length} mutual steam friends: ${account.mutualFriends.join(", ")}`,
      );
    }
    if (account.sharedSmallGroups.length > 0) {
      links.push(
        `${account.sharedSmallGroups.length} shared small steam group${account.sharedSmallGroups.length === 1 ? "" : "s"}: ${account.sharedSmallGroups.map((g) => `${g.name} (${g.members})`).join(", ")}`,
      );
    }
    if (account.crossComment) {
      links.push(
        `friend cross-comment: ${account.crossComment.commenterName} (friend of ${account.crossComment.commenterFriendOf === "subject" ? subjectName : account.name}) commented on ${account.crossComment.profileOwnerName}'s profile`,
      );
    }
    if (account.mutualGames.length > 0) {
      links.push(
        `${account.mutualGames.length} mutual game${account.mutualGames.length === 1 ? "" : "s"}: ${account.mutualGames.map((g) => g.name).join(", ")}`,
      );
    }
    const topName = account.similarNames[0];
    if (topName && topName.similarity >= 35) {
      links.push(
        `name similarity ${topName.similarity}%: "${topName.subjectName}" \u2194 "${topName.linkedName}"`,
      );
    }
    if (account.gameBanned || account.serverBanned) {
      const banBits = [];
      if (account.gameBanned) banBits.push("game ban");
      if (account.serverBanned) banBits.push("server ban");
      links.push(
        `${banBits.join(" + ")}${account.lastBanReason ? ` \u2014 ${account.lastBanReason}` : ""}${account.lastBanAt ? ` (${formatBanAge(account.lastBanAt)})` : ""}`,
      );
    }
    links.forEach((l, i) => {
      lines.push(`link ${i + 1}: ${l}`);
    });
    return lines.join("\n");
  };
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildClipboardText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <MiniAvatar color={account.avatarColor} name={account.name} />
            <span className="flex flex-col flex-1 min-w-0">
              <span className="text-sm">
                {subjectName} <span className="text-muted-foreground">vs</span>{" "}
                {account.name}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {account.steamId} · {account.country} ·{" "}
                {account.accountAgeYears}y account
              </span>
            </span>
            <button
              onClick={onCopy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded ring-1 ring-border bg-surface hover:bg-surface/70 text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground shrink-0 mr-6"
              title="Copy summary to clipboard"
            >
              {copied ? (
                <Check className="size-3 text-success" />
              ) : (
                <Copy className="size-3" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Ban status */}
          <div className="flex flex-wrap gap-2">
            {account.gameBanned ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-danger/15 text-danger text-[10px] font-mono uppercase ring-1 ring-danger/40">
                <AlertOctagon className="size-3" /> VAC / Game banned
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-success/15 text-success text-[10px] font-mono uppercase ring-1 ring-success/40">
                Game ban clean
              </span>
            )}
            {account.serverBanned && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-warning/15 text-warning text-[10px] font-mono uppercase ring-1 ring-warning/40">
                <Ban className="size-3" /> Server banned
                {account.lastBanReason && ` \u2014 ${account.lastBanReason}`}
              </span>
            )}
            {account.lastBanAt && (
              <span className="px-2 py-1 rounded bg-surface ring-1 ring-border text-[10px] font-mono text-muted-foreground">
                last ban {formatBanAge(account.lastBanAt)}
              </span>
            )}
          </div>

          {/* Shared IPs */}
          <Block
            icon={<Wifi className="size-3" />}
            title={`Shared IPs (${account.sharedIps.length})`}
            badge={!canSeeRealIp ? "masked" : void 0}
          >
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
              {Object.keys(IP_TYPE_META).map((t) => (
                <div
                  key={t}
                  className="flex items-center justify-between px-2 py-1.5 rounded ring-1 ring-border bg-surface/40"
                >
                  <span
                    className={`text-[10px] font-mono uppercase ${IP_TYPE_META[t].tone}`}
                  >
                    {IP_TYPE_META[t].label}
                  </span>
                  <span className="text-xs font-mono tabular-nums">
                    {typeTotals[t]}
                  </span>
                </div>
              ))}
            </div>
            <ul className="text-[11px] font-mono divide-y divide-border/40 ring-1 ring-border/60 rounded">
              {account.sharedIps.map((ip) => (
                <li
                  key={ip.ip}
                  className="flex items-center justify-between px-2 py-1.5 gap-2"
                >
                  <IpChip ip={ip.ip} type={ip.type} canSeeReal={canSeeRealIp} />
                  <span className="text-muted-foreground text-[10px]">
                    {ip.hits} hits · {ip.overlapDays}d overlap
                  </span>
                </li>
              ))}
            </ul>
          </Block>

          {/* Steam social — summary chips */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <SmallStat
              icon={<Users className="size-3" />}
              label="Mutual Steam friends"
              value={String(account.mutualFriends.length)}
              tone={
                account.mutualFriends.length > 0
                  ? "text-foreground"
                  : "text-muted-foreground"
              }
            />
            <SmallStat
              icon={<MessageSquare className="size-3" />}
              label="Friend cross-comment"
              value={account.crossComment ? "Yes" : "No"}
              tone={
                account.crossComment ? "text-warning" : "text-muted-foreground"
              }
              hint={
                account.crossComment
                  ? "A friend of one account has commented on the other's Steam profile."
                  : void 0
              }
            />
            <SmallStat
              icon={<Building2 className="size-3" />}
              label="Shared small groups"
              value={String(account.sharedSmallGroups.length)}
              tone={
                account.sharedSmallGroups.length > 0
                  ? "text-brand"
                  : "text-muted-foreground"
              }
              hint="Steam groups with under 100 members"
            />
          </div>

          {/* Mutual friends — names only */}
          {account.mutualFriends.length > 0 && (
            <Block
              icon={<Users className="size-3" />}
              title={`Mutual Steam friends (${account.mutualFriends.length})`}
            >
              <div className="flex flex-wrap gap-1.5">
                {account.mutualFriends.map((f) => (
                  <span
                    key={f}
                    className="px-2 py-0.5 rounded bg-surface ring-1 ring-border text-[11px] font-mono"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </Block>
          )}

          {/* Friend cross-comment — who -> whose profile */}
          {account.crossComment && (
            <Block
              icon={<MessageSquare className="size-3" />}
              title="Friend cross-comment"
            >
              <p className="text-[11px] font-mono">
                <span className="text-foreground">
                  {account.crossComment.commenterName}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  (friend of{" "}
                  {account.crossComment.commenterFriendOf === "subject"
                    ? subjectName
                    : account.name}
                  ) commented on{" "}
                </span>
                <span className="text-foreground">
                  {account.crossComment.profileOwnerName}
                </span>
                <span className="text-muted-foreground">'s Steam profile</span>
              </p>
            </Block>
          )}

          {account.sharedSmallGroups.length > 0 && (
            <Block
              icon={<Building2 className="size-3" />}
              title="Small Steam groups in common (<100 members)"
            >
              <ul className="text-[11px] font-mono divide-y divide-border/40 ring-1 ring-border/60 rounded">
                {account.sharedSmallGroups.map((g, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between px-2 py-1.5"
                  >
                    <span>{g.name}</span>
                    <span className="text-muted-foreground">
                      {g.members} members
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {/* Similar names */}
          <Block
            icon={<ShieldAlert className="size-3" />}
            title="Top 5 name similarity matches"
          >
            <ul className="text-[11px] font-mono">
              {account.similarNames.map((m, i) => (
                <li
                  key={i}
                  className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2 px-2 py-1.5 border-b last:border-b-0 border-border/40"
                >
                  <span className="truncate" title={m.subjectName}>
                    {m.subjectName}
                  </span>
                  <span className="text-muted-foreground">↔</span>
                  <span className="truncate" title={m.linkedName}>
                    {m.linkedName}
                  </span>
                  <span
                    className={`tabular-nums ${m.similarity >= 60 ? "text-danger" : m.similarity >= 35 ? "text-warning" : "text-muted-foreground"}`}
                  >
                    {m.similarity}%
                  </span>
                </li>
              ))}
            </ul>
          </Block>

          {/* Mutual games */}
          {account.mutualGames.length > 0 && (
            <Block
              icon={<Gamepad2 className="size-3" />}
              title={`Mutual games (${account.mutualGames.length})`}
            >
              <ul className="text-[11px] font-mono divide-y divide-border/40 ring-1 ring-border/60 rounded">
                {account.mutualGames.map((g) => (
                  <li
                    key={g.appId}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-2 py-1.5"
                  >
                    <span className="truncate">{g.name}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {subjectName.slice(0, 12)}: {g.subjectLastPlayed}
                    </span>
                    <span className="text-muted-foreground text-[10px]">
                      {account.name.slice(0, 12)}: {g.linkedLastPlayed}
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {/* Rust 12-month activity */}
          <Block
            icon={<CalendarRange className="size-3" />}
            title="Rust activity — last 12 months (BM sessions)"
          >
            <div className="flex items-end gap-1 h-24 px-1">
              {account.rustYear.map((m) => {
                const h = Math.round((m.hours / maxHours) * 100);
                return (
                  <div
                    key={m.month}
                    className="flex-1 flex flex-col items-center gap-1"
                    title={`${m.month} \u2014 ${m.hours}h over ${m.sessions} sessions`}
                  >
                    <div className="flex-1 w-full flex items-end">
                      <div
                        className={`w-full rounded-t ${m.hours === 0 ? "bg-border/40" : "bg-brand/70"}`}
                        style={{ height: `${Math.max(2, h)}%` }}
                      />
                    </div>
                    <span className="text-[8px] font-mono text-muted-foreground">
                      {m.month.split(" ")[0]}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[10px] font-mono text-muted-foreground">
              Total {account.rustYear.reduce((s, m) => s + m.hours, 0)}h ·{" "}
              {account.rustYear.reduce((s, m) => s + m.sessions, 0)} sessions
            </p>
          </Block>

          <div className="flex justify-end pt-2">
            <Link
              to="/player-lookup"
              search={{ steam: account.steamId }}
              onClick={onClose}
              className="inline-flex items-center gap-1 text-[11px] font-mono text-brand hover:underline"
            >
              Open full profile on {account.name}
              <ExternalLink className="size-3" />
            </Link>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function Block({ icon, title, badge, children }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2 flex items-center gap-2">
        {icon}
        {title}
        {badge && (
          <span className="text-warning normal-case tracking-normal font-mono">
            · {badge}
          </span>
        )}
      </h4>
      {children}
    </div>
  );
}
function SmallStat({ icon, label, value, tone, hint }) {
  return (
    <div
      className="px-3 py-2 rounded ring-1 ring-border bg-surface/40"
      title={hint}
    >
      <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1">
        {icon} {label}
      </p>
      <p className={`text-sm font-mono mt-0.5 ${tone}`}>{value}</p>
    </div>
  );
}
export {
  LinkedAccountIntelSection,
  LinkedAccountsSection,
  getLinkedAccountsSummary,
};

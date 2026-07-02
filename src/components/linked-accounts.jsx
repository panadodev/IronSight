import { Hint } from "@/components/hint";
import { PlayerLinks } from "@/components/player-links";
import { ServerOverlapSection } from "@/components/server-overlap-section";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Link } from "@tanstack/react-router";
import {
  AlertOctagon,
  Ban,
  Building2,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Filter,
  Heart,
  ShieldAlert,
  Users,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

// connType values from the backend (proxycheck classification) map 1:1 to these
// keys; `unknown` covers IPs proxycheck couldn't classify.
const IP_TYPE_META = {
  residential: {
    label: "Residential",
    tone: "text-success",
    short: "RES",
    hint: "Home internet connection. A shared residential IP is the strongest link signal — it means both accounts connected from the same household.",
  },
  business: {
    label: "Business",
    tone: "text-brand",
    short: "BIZ",
    hint: "Corporate or office connection. Shared with another account = moderate evidence of proximity, though offices can have many occupants.",
  },
  mobile: {
    label: "Mobile",
    tone: "text-foreground",
    short: "MOB",
    hint: "Cellular data connection. Shared = moderate evidence; cell towers serve large areas, so less specific than a home IP.",
  },
  proxy_vpn: {
    label: "Proxy / VPN",
    tone: "text-danger",
    short: "VPN",
    hint: "Commercial VPN, proxy, or anonymizer. Unreliable for linking — thousands of unrelated players may share the same exit node.",
  },
  hosting: {
    label: "Hosting / DC",
    tone: "text-warning",
    short: "HOST",
    hint: "Datacenter or hosting provider IP (e.g. a rented VPS). Not useful for player linking — not a personal connection.",
  },
  unknown: {
    label: "Unknown",
    tone: "text-muted-foreground",
    short: "?",
    hint: "Connection type could not be classified by Proxycheck.",
  },
};

// IP classes that meaningfully tie two accounts to the same person/household.
// Accounts linked ONLY through VPN/proxy/hosting are filtered out by default.
const STRONG_TYPES = new Set(["residential", "business", "mobile"]);

const CONFIDENCE_META = {
  high: {
    label: "High",
    tone: "text-danger bg-danger/10 ring-danger/30",
    rank: 3,
    hint: "High confidence: accounts share a residential, business, or mobile IP — the kind that isn't shared between strangers.",
  },
  likely: {
    label: "Likely",
    tone: "text-warning bg-warning/10 ring-warning/30",
    rank: 2,
    hint: "Likely the same person: solid indirect evidence such as matching name patterns, mutual friends, or shared groups alongside some IP overlap.",
  },
  possible: {
    label: "Possible",
    tone: "text-brand bg-brand/10 ring-brand/30",
    rank: 1,
    hint: "Possible link: only weak signals detected (minimal IP overlap or a few indirect connections). Could be a coincidence.",
  },
  unlikely: {
    label: "Unlikely",
    tone: "text-muted-foreground bg-surface ring-border",
    rank: 0,
    hint: "Unlikely to be the same person. Connected by a single weak signal only — treat with caution.",
  },
};

// Server-computed hard-link criteria → human-readable labels. A hard link is
// set when independent signals coincide such that two different people
// producing them by chance is statistically implausible.
const HARD_LINK_REASON_LABELS = {
  identical_name_same_network:
    "Identical name + same non-proxy network (home/work/mobile)",
  multiple_strong_networks:
    "3+ shared residential/business IPs — independent location matches",
  cross_network_types:
    "Same networks of multiple types (e.g. home AND work) — near-impossible by coincidence",
  account_switching_same_network:
    "Account-switching session pattern + same network + matching name",
  identical_name_account_switching:
    "Identical name + many shared sessions that never overlap (account switching)",
};

const HARD_LINK_HINT =
  "Hard link: multiple independent signals (name reuse, location-specific networks, session-switching pattern) coincide in a way that is statistically implausible for two different people. Treat these accounts as the same person.";

// One-line verdict for the Compare dialog so staff get a clear related /
// not-related answer instead of having to interpret raw signals.
function comparisonVerdict(account) {
  if (account.hardLink)
    return {
      label: "Same person",
      detail:
        "Hard-linked: the evidence combination below is not realistically produced by two different people.",
      tone: "text-danger",
      box: "bg-danger/10 ring-danger/40",
    };
  if (account.coPresence?.verdict === "co_play")
    return {
      label: "Likely different people (teammates)",
      detail:
        "These accounts are frequently online at the same time on the same servers — two people playing together, not one person's alt.",
      tone: "text-success",
      box: "bg-success/10 ring-success/40",
    };
  switch (account.altConfidence) {
    case "high":
      return {
        label: "Almost certainly the same person",
        detail:
          "Strong evidence (non-proxy IP overlap plus corroborating signals). Not quite a hard link, but treat as related.",
        tone: "text-danger",
        box: "bg-danger/10 ring-danger/40",
      };
    case "likely":
      return {
        label: "Probably the same person",
        detail:
          "Solid indirect evidence. Verify with the signals below before acting on it.",
        tone: "text-warning",
        box: "bg-warning/10 ring-warning/40",
      };
    case "possible":
      return {
        label: "Weak link — could be coincidence",
        detail:
          "Only weak signals connect these accounts (e.g. a shared mobile carrier IP or minor name overlap).",
        tone: "text-brand",
        box: "bg-brand/10 ring-brand/40",
      };
    default:
      return {
        label: "Probably not related",
        detail:
          "A single weak identifier connects these accounts — most likely two unrelated players.",
        tone: "text-muted-foreground",
        box: "bg-surface ring-border",
      };
  }
}

const CO_PRESENCE_META = {
  alt_switch: {
    label: "Never online together",
    hint: "Many shared-server sessions but never overlapping — consistent with one person switching accounts.",
    tone: "text-danger",
  },
  co_play: {
    label: "Often online together",
    hint: "Sessions frequently overlap — more consistent with teammates than a single person's alt.",
    tone: "text-success",
  },
  inconclusive: {
    label: "Inconclusive",
    hint: "Not enough shared-server session data to judge co-presence.",
    tone: "text-muted-foreground",
  },
};

function ipTypeKey(connType) {
  return connType && IP_TYPE_META[connType] ? connType : "unknown";
}

function bigramSim(a, b) {
  const grams = (s) => {
    const t = (s ?? "").toLowerCase().replace(/\s+/g, "");
    const g = new Set();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  A.forEach((g) => B.has(g) && inter++);
  return (2 * inter * 100) / (A.size + B.size || 1);
}

function colorFromId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `oklch(0.5 0.14 ${Math.abs(h) % 360})`;
}

// Unix-seconds → "1d ago" / "3mo ago" / "1y ago".
function formatBanAge(unixSec) {
  if (!unixSec) return null;
  const days = Math.floor((Date.now() / 1000 - unixSec) / 86400);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function typeCountsOf(sharedIps) {
  return (sharedIps ?? []).reduce((acc, ip) => {
    const k = ipTypeKey(ip.connType);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

function displayNameOf(a) {
  return a.relatedName ?? a.relatedSteamId ?? `BM ${a.relatedBmId}`;
}

function MiniAvatar({ id, name }) {
  return (
    <div
      className="rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0 size-7 text-[10px]"
      style={{ background: colorFromId(id) }}
    >
      {String(name)
        .replace(/[\[\]]/g, "")
        .slice(0, 2)
        .toUpperCase()}
    </div>
  );
}

function IpChip({ ipHashShort, connType }) {
  const meta = IP_TYPE_META[ipTypeKey(connType)];
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface ring-1 ring-border text-[10px] font-mono">
      <span className={`uppercase ${meta.tone}`}>{meta.short}</span>
      <span className="text-muted-foreground">{ipHashShort ?? "UNKNOWN"}</span>
    </span>
  );
}

function ConfidenceBadge({ tier }) {
  const meta = CONFIDENCE_META[tier] ?? CONFIDENCE_META.unlikely;
  return (
    <Hint text={meta.hint}>
      <span
        className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 shrink-0 cursor-help ${meta.tone}`}
      >
        {meta.label}
      </span>
    </Hint>
  );
}

function HardLinkBadge() {
  return (
    <Hint text={HARD_LINK_HINT}>
      <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 shrink-0 cursor-help text-danger bg-danger/15 ring-danger/50 font-bold">
        <ShieldAlert className="size-3" /> Hard Link
      </span>
    </Hint>
  );
}

// ── Summary card (also used by the appeal sidebar) ────────────────────────────

function LinkedAccountIntelSection({ subjectId, relatedAccounts }) {
  const summary = useMemo(() => {
    const hasData = Array.isArray(relatedAccounts);
    const list = hasData ? relatedAccounts : [];
    let gameBanned = 0;
    let serverBanned = 0;
    let strongBanned = 0;
    let highConfidence = 0;
    let hardLinked = 0;
    for (const a of list) {
      if (a.hasEacBans) gameBanned++;
      if (a.hasBmBans) serverBanned++;
      if (a.nonProxyLinked && (a.hasEacBans || a.hasBmBans)) strongBanned++;
      if (a.altConfidence === "high" || a.altConfidence === "likely")
        highConfidence++;
      if (a.hardLink) hardLinked++;
    }
    return {
      hasData,
      total: list.length,
      gameBanned,
      serverBanned,
      strongBanned,
      highConfidence,
      hardLinked,
    };
  }, [relatedAccounts]);

  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Wifi className="size-3" />
          Linked Accounts
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
        {!summary.hasData ? (
          <p className="text-[10px] text-muted-foreground italic">
            Open the full player lookup to scan for linked accounts.
          </p>
        ) : (
          <>
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
                <p className="text-lg font-mono font-bold text-warning">
                  {summary.highConfidence}
                </p>
                <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                  Likely alt
                </p>
              </div>
              <div>
                <p className="text-lg font-mono font-bold text-danger">
                  {summary.gameBanned + summary.serverBanned}
                </p>
                <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                  Bans
                </p>
              </div>
            </div>
            {summary.hardLinked > 0 && (
              <div className="flex items-start gap-2 bg-danger/10 ring-1 ring-danger/40 rounded p-2">
                <ShieldAlert className="size-3.5 text-danger shrink-0 mt-0.5" />
                <p className="text-[10px] text-danger leading-snug">
                  <span className="font-bold">{summary.hardLinked}</span>{" "}
                  <span className="font-bold">hard-linked</span>{" "}
                  {summary.hardLinked === 1 ? "account" : "accounts"} — same
                  person beyond reasonable doubt.
                </p>
              </div>
            )}
            {summary.strongBanned > 0 ? (
              <div className="flex items-start gap-2 bg-danger/10 ring-1 ring-danger/40 rounded p-2">
                <ShieldAlert className="size-3.5 text-danger shrink-0 mt-0.5" />
                <p className="text-[10px] text-danger leading-snug">
                  <span className="font-bold">{summary.strongBanned}</span>{" "}
                  banned{" "}
                  {summary.strongBanned === 1
                    ? "account shares"
                    : "accounts share"}{" "}
                  a <span className="font-bold">non-proxy IP</span>{" "}
                  (residential, business or mobile).
                </p>
              </div>
            ) : summary.total === 0 ? (
              <p className="text-[10px] text-muted-foreground">
                No linked accounts found.
              </p>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                No banned account shares a non-proxy IP.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ── Full comparison list ──────────────────────────────────────────────────────

function LinkedAccountsSection({
  subjectName,
  relatedAccounts,
  sessionRelated = [],
  friendSteamIds = new Set(),
}) {
  const accounts = useMemo(
    () => (Array.isArray(relatedAccounts) ? relatedAccounts : []),
    [relatedAccounts],
  );
  const [ignoreProxyOnly, setIgnoreProxyOnly] = useState(true);
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
    return accounts
      .filter((a) => {
        // Default-on: hide accounts whose ONLY link is through VPN/proxy/hosting IPs.
        // Accounts with no shared IPs (linked via mutual friends / name alone) are
        // always shown — nonProxyLinked=false doesn't mean "only proxy IPs" when
        // there are no IPs at all.
        if (
          ignoreProxyOnly &&
          a.nonProxyLinked === false &&
          (a.sharedIps ?? []).length > 0
        )
          return false;
        if (activeIpTypes.size === 0) return false;
        if ((a.sharedIps ?? []).length > 0) {
          const ipOk = a.sharedIps.some((ip) =>
            activeIpTypes.has(ipTypeKey(ip.connType)),
          );
          if (!ipOk) return false;
        }
        switch (banFilter) {
          case "any":
            return a.hasEacBans || a.hasBmBans;
          case "game":
            return a.hasEacBans;
          case "server":
            return a.hasBmBans;
          case "none":
            return !a.hasEacBans && !a.hasBmBans;
          default:
            return true;
        }
      })
      .sort((a, b) => {
        if (Boolean(b.hardLink) !== Boolean(a.hardLink))
          return b.hardLink ? 1 : -1;
        const ra = CONFIDENCE_META[a.altConfidence]?.rank ?? 0;
        const rb = CONFIDENCE_META[b.altConfidence]?.rank ?? 0;
        if (rb !== ra) return rb - ra;
        if ((b.nameSimilarity ?? 0) !== (a.nameSimilarity ?? 0))
          return (b.nameSimilarity ?? 0) - (a.nameSimilarity ?? 0);
        return (b.matchCount ?? 0) - (a.matchCount ?? 0);
      });
  }, [accounts, ignoreProxyOnly, activeIpTypes, banFilter]);

  const visible = useMemo(
    () => (pageSize === "all" ? filtered : filtered.slice(0, pageSize)),
    [filtered, pageSize],
  );
  const hiddenCount = filtered.length - visible.length;
  const openAccount = useMemo(
    () => accounts.find((a) => a.relatedBmId === openId) ?? null,
    [accounts, openId],
  );

  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Wifi className="size-3 shrink-0" />
          Linked Accounts
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {filtered.length} / {accounts.length}
        </span>
      </h3>

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* Ignore VPN/proxy-only links (default on) */}
        <button
          onClick={() => setIgnoreProxyOnly((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono uppercase ring-1 transition-colors ${
            ignoreProxyOnly
              ? "text-success ring-success/40 bg-success/10"
              : "text-muted-foreground ring-border/50 hover:bg-surface/50"
          }`}
          title="When on, accounts linked only through VPN / proxy / hosting IPs are hidden — those IPs are shared by thousands of unrelated players."
        >
          <span
            className={`inline-flex items-center justify-center size-3.5 rounded border transition-colors ${
              ignoreProxyOnly
                ? "bg-success border-success text-background"
                : "border-border bg-transparent"
            }`}
          >
            {ignoreProxyOnly && <Check className="size-3" />}
          </span>
          Ignore VPN / proxy-only
        </button>

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
            <option value="all">All</option>
          </select>
        </label>
      </div>

      {accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No linked accounts found for this player.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No linked accounts match the current filters.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Showing {visible.length} of {filtered.length}
            </span>
          </div>
          <ul className="divide-y divide-border/60 ring-1 ring-border rounded-lg bg-surface/40 overflow-hidden">
            {visible.map((a) => {
              const name = displayNameOf(a);
              const ipCount = (a.sharedIps ?? []).length;
              const typeCounts = typeCountsOf(a.sharedIps);
              const lastBan = formatBanAge(a.eacLastBan);
              return (
                <li
                  key={a.relatedBmId}
                  className="px-3 py-2 flex items-center gap-3"
                >
                  <MiniAvatar id={a.relatedBmId} name={name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold truncate max-w-[16rem]">
                        {name}
                      </span>
                      {a.relatedSteamId && (
                        <span className="text-[10px] font-mono text-muted-foreground inline-flex items-center gap-1">
                          {a.relatedSteamId}
                          <PlayerLinks steamId={a.relatedSteamId} size="xs" />
                        </span>
                      )}
                      {a.hardLink ? (
                        <HardLinkBadge />
                      ) : (
                        <ConfidenceBadge tier={a.altConfidence} />
                      )}
                      {a.nameSimilarity > 0 && (
                        <Hint text="Best bigram character similarity between this account's alias history and the subject's. ≥60% is a strong naming signal; ≥35% is notable.">
                          <span
                            className={`text-[10px] font-mono cursor-help ${a.nameSimilarity >= 60 ? "text-danger" : a.nameSimilarity >= 35 ? "text-warning" : "text-muted-foreground"}`}
                          >
                            name {a.nameSimilarity}%
                          </span>
                        </Hint>
                      )}
                      {a.hasEacBans && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-danger/15 text-danger text-[10px] font-mono uppercase ring-1 ring-danger/40">
                          <AlertOctagon className="size-3" /> Game ban
                        </span>
                      )}
                      {a.hasBmBans && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning/15 text-warning text-[10px] font-mono uppercase ring-1 ring-warning/40">
                          <Ban className="size-3" /> Server ban
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] font-mono text-muted-foreground">
                      <span>
                        {ipCount} shared IP{ipCount === 1 ? "" : "s"}
                      </span>
                      {ipCount > 0 && <span>·</span>}
                      {Object.entries(typeCounts).map(([t, n]) => (
                        <span key={t} className={IP_TYPE_META[t].tone}>
                          {n} {IP_TYPE_META[t].short}
                        </span>
                      ))}
                      {a.mutualFriends?.length > 0 && (
                        <>
                          <span>·</span>
                          <span>
                            {a.mutualFriends.length} mutual friend
                            {a.mutualFriends.length === 1 ? "" : "s"}
                          </span>
                        </>
                      )}
                      {lastBan && (
                        <>
                          <span>·</span>
                          <span>last ban {lastBan}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setOpenId(a.relatedBmId)}
                    className="px-2.5 py-1.5 rounded bg-brand text-brand-foreground text-[10px] font-mono uppercase tracking-widest hover:opacity-90 shrink-0"
                  >
                    Compare
                  </button>
                </li>
              );
            })}
          </ul>
        </>
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
        subjectName={subjectName}
        account={openAccount}
      />

      {/* Playing Partners — cross-server co-players from BM sessions */}
      {sessionRelated.length > 0 && (
        <PlayingPartnersSection
          sessionRelated={sessionRelated}
          friendSteamIds={friendSteamIds}
        />
      )}
    </section>
  );
}

function PlayingPartnersSection({ sessionRelated, friendSteamIds }) {
  const sorted = useMemo(
    () =>
      [...sessionRelated]
        .filter((c) => c.overlapSessions > 0 || c.distinctDays > 0)
        .sort(
          (a, b) =>
            b.overlapSessions - a.overlapSessions ||
            b.distinctDays - a.distinctDays,
        )
        .slice(0, 10),
    [sessionRelated],
  );

  if (!sorted.length) return null;

  return (
    <div className="border-t border-border pt-4 mt-2">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2 flex items-center gap-2">
        <Users className="size-3" />
        Playing Partners
        <span className="text-[9px] font-mono ml-auto">{sorted.length}</span>
      </h4>
      <ul className="space-y-1">
        {sorted.map((c) => {
          const name =
            c.relatedName ?? c.relatedSteamId ?? `BM ${c.relatedBmId}`;
          const isFriend =
            c.relatedSteamId && friendSteamIds.has(c.relatedSteamId);
          const hasBan = c.alsoIpLinked;
          return (
            <li
              key={c.relatedBmId}
              className="flex items-center gap-2 px-2 py-1.5 rounded bg-surface/40 ring-1 ring-border/50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-medium truncate max-w-[10rem]">
                    {name}
                  </span>
                  {isFriend && (
                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-brand/10 text-brand text-[8px] font-mono uppercase ring-1 ring-brand/30">
                      <Heart className="size-2" />
                      Friend
                    </span>
                  )}
                  {hasBan && (
                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-danger/10 text-danger text-[8px] font-mono uppercase ring-1 ring-danger/30">
                      <Ban className="size-2" />
                      IP link
                    </span>
                  )}
                </div>
                <div className="text-[9px] font-mono text-muted-foreground">
                  {c.overlapSessions > 0 && `${c.overlapSessions} co-play`}
                  {c.distinctDays > 0 && ` · ${c.distinctDays}d`}
                  {(c.sharedServers ?? []).length > 0 &&
                    ` · ${c.sharedServers.length} server${c.sharedServers.length === 1 ? "" : "s"}`}
                </div>
              </div>
              {c.relatedSteamId ? (
                <Link
                  to="/player-lookup"
                  search={{ steam: c.relatedSteamId }}
                  className="shrink-0 text-brand hover:underline text-[10px] font-mono inline-flex items-center gap-0.5"
                >
                  View <ExternalLink className="size-2.5" />
                </Link>
              ) : (
                <a
                  href={`https://www.battlemetrics.com/players/${c.relatedBmId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-brand hover:underline text-[10px] font-mono inline-flex items-center gap-0.5"
                >
                  BM <ExternalLink className="size-2.5" />
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ComparisonDialog({ open, onClose, subjectName, account }) {
  const [copied, setCopied] = useState(false);
  if (!account) return null;

  const name = displayNameOf(account);
  const typeCounts = typeCountsOf(account.sharedIps);
  const lastBan = formatBanAge(account.eacLastBan);
  const co = account.coPresence
    ? (CO_PRESENCE_META[account.coPresence.verdict] ??
      CO_PRESENCE_META.inconclusive)
    : null;

  const buildClipboardText = () => {
    const lines = [];
    lines.push(`Alt comparison — ${subjectName} vs ${name}`);
    if (account.relatedSteamId)
      lines.push(`Alt Steam ID: ${account.relatedSteamId}`);
    lines.push(`Alt BM ID: ${account.relatedBmId}`);
    lines.push(
      `Confidence: ${CONFIDENCE_META[account.altConfidence]?.label ?? "Unlikely"} (score ${account.altScore ?? 0})`,
    );
    if (account.hardLink) {
      lines.push(
        `HARD LINK — statistically implausible to be different people:`,
      );
      for (const r of account.hardLinkReasons ?? []) {
        lines.push(`  - ${HARD_LINK_REASON_LABELS[r] ?? r}`);
      }
    }
    lines.push("");

    const links = [];
    if ((account.sharedIps ?? []).length > 0) {
      const parts = [
        `${account.sharedIps.length} shared IP${account.sharedIps.length === 1 ? "" : "s"}`,
      ];
      for (const t of Object.keys(IP_TYPE_META)) {
        const n = typeCounts[t];
        if (n > 0) parts.push(`${n} ${IP_TYPE_META[t].label.toLowerCase()}`);
      }
      links.push(parts.join(", "));
    }
    if (account.nameSimilarity > 0) {
      links.push(`name similarity ${account.nameSimilarity}%`);
    }
    if (account.mutualFriends?.length > 0) {
      links.push(`${account.mutualFriends.length} mutual Steam friends`);
    }
    if (account.sharedGroups?.length > 0) {
      links.push(`${account.sharedGroups.length} shared Steam groups`);
    }
    if (account.serverOverlap?.length > 0) {
      links.push(
        `${account.serverOverlap.length} shared servers; co-presence: ${co?.label ?? "inconclusive"}`,
      );
    }
    if (account.hasEacBans || account.hasBmBans) {
      const bits = [];
      if (account.hasEacBans) bits.push("game ban");
      if (account.hasBmBans) bits.push("server ban");
      links.push(`${bits.join(" + ")}${lastBan ? ` (${lastBan})` : ""}`);
    }
    links.forEach((l, i) => lines.push(`link ${i + 1}: ${l}`));
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
            <MiniAvatar id={account.relatedBmId} name={name} />
            <span className="flex flex-col flex-1 min-w-0">
              <span className="text-sm flex items-center gap-2">
                {subjectName} <span className="text-muted-foreground">vs</span>{" "}
                {name}
                {account.hardLink ? (
                  <HardLinkBadge />
                ) : (
                  <ConfidenceBadge tier={account.altConfidence} />
                )}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {account.relatedSteamId ?? `BM ${account.relatedBmId}`}
                {account.altScore != null && (
                  <Hint text="Numerical confidence score combining all link signals: shared IPs (weighted by type), name similarity, mutual friends, shared groups, and session co-presence. Higher = more evidence of the same person.">
                    <span className="cursor-help">{` · score ${account.altScore}`}</span>
                  </Hint>
                )}
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
          {/* Verdict — the clear related / not-related answer */}
          {(() => {
            const verdict = comparisonVerdict(account);
            return (
              <div className={`rounded-lg ring-1 p-3 ${verdict.box}`}>
                <p
                  className={`text-xs font-mono font-bold uppercase tracking-wider ${verdict.tone}`}
                >
                  {verdict.label}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                  {verdict.detail}
                </p>
                {account.hardLink &&
                  (account.hardLinkReasons ?? []).length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {account.hardLinkReasons.map((r) => (
                        <li
                          key={r}
                          className="flex items-start gap-1.5 text-[11px] text-danger leading-snug"
                        >
                          <ShieldAlert className="size-3 shrink-0 mt-0.5" />
                          {HARD_LINK_REASON_LABELS[r] ?? r}
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            );
          })()}

          {/* Ban status */}
          <div className="flex flex-wrap gap-2">
            {account.hasEacBans ? (
              <Hint text="This account has a Steam VAC or Game Developer ban (including EAC/Easy Anti-Cheat). Steam does not disclose which specific game issued the ban.">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-danger/15 text-danger text-[10px] font-mono uppercase ring-1 ring-danger/40 cursor-help">
                  <AlertOctagon className="size-3" /> Game banned
                </span>
              </Hint>
            ) : (
              <Hint text="No Steam VAC or Game Developer bans found on this account.">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-success/15 text-success text-[10px] font-mono uppercase ring-1 ring-success/40 cursor-help">
                  Game ban clean
                </span>
              </Hint>
            )}
            {account.hasBmBans && (
              <Hint text="This account has one or more ban records in BattleMetrics, typically issued by a server admin or community ban list.">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-warning/15 text-warning text-[10px] font-mono uppercase ring-1 ring-warning/40 cursor-help">
                  <Ban className="size-3" /> Server banned
                  {account.bmBanCount > 1 && ` (${account.bmBanCount})`}
                </span>
              </Hint>
            )}
            {lastBan && (
              <Hint text="How long ago the most recent EAC/game ban on this account was issued.">
                <span className="px-2 py-1 rounded bg-surface ring-1 ring-border text-[10px] font-mono text-muted-foreground cursor-help">
                  last ban {lastBan}
                </span>
              </Hint>
            )}
          </div>

          {/* Shared IPs */}
          <Block
            icon={<Wifi className="size-3" />}
            title={`Shared IPs (${(account.sharedIps ?? []).length})`}
            badge="hashed"
          >
            {(account.sharedIps ?? []).length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Linked via a non-IP identifier (no shared IP recorded).
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
                  {Object.keys(IP_TYPE_META).map((t) => (
                    <div
                      key={t}
                      className="flex items-center justify-between px-2 py-1.5 rounded ring-1 ring-border bg-surface/40"
                    >
                      <Hint text={IP_TYPE_META[t].hint}>
                        <span
                          className={`text-[10px] font-mono uppercase cursor-help ${IP_TYPE_META[t].tone}`}
                        >
                          {IP_TYPE_META[t].label}
                        </span>
                      </Hint>
                      <span className="text-xs font-mono tabular-nums">
                        {typeCounts[t] ?? 0}
                      </span>
                    </div>
                  ))}
                </div>
                <ul className="text-[11px] font-mono divide-y divide-border/40 ring-1 ring-border/60 rounded">
                  {account.sharedIps.map((ip) => (
                    <li
                      key={ip.ipHash ?? ip.ipHashShort}
                      className="flex items-center justify-between px-2 py-1.5 gap-2"
                    >
                      <IpChip
                        ipHashShort={ip.ipHashShort}
                        connType={ip.connType}
                      />
                      <span className="text-muted-foreground text-[10px] truncate">
                        {ip.isp ?? "Unknown ISP"}
                        {ip.country ? ` · ${ip.country}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Block>

          {/* Signal summary chips */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SmallStat
              icon={<ShieldAlert className="size-3" />}
              label="Name match"
              value={`${account.nameSimilarity ?? 0}%`}
              tone={
                (account.nameSimilarity ?? 0) >= 60
                  ? "text-danger"
                  : (account.nameSimilarity ?? 0) >= 35
                    ? "text-warning"
                    : "text-muted-foreground"
              }
              hint="Best bigram (character-pair) similarity between this account's alias history and the subject's. ≥60% is a strong naming signal; ≥35% is notable."
            />
            <SmallStat
              icon={<Users className="size-3" />}
              label="Mutual friends"
              value={String(account.mutualFriends?.length ?? 0)}
              tone={
                account.mutualFriends?.length > 0
                  ? "text-foreground"
                  : "text-muted-foreground"
              }
              hint="Steam accounts that appear in both players' friends lists. A mutual friend who is also IP-linked to both is a particularly strong signal."
            />
            <SmallStat
              icon={<Building2 className="size-3" />}
              label="Shared groups"
              value={String(account.sharedGroups?.length ?? 0)}
              tone={
                account.sharedGroups?.length > 0
                  ? "text-brand"
                  : "text-muted-foreground"
              }
              hint="Steam groups both accounts are members of (matched by group ID). Alone it's a weak signal, but adds weight alongside other evidence."
            />
            <SmallStat
              icon={<Clock className="size-3" />}
              label="Shared servers"
              value={String(account.serverOverlap?.length ?? 0)}
              tone={
                account.serverOverlap?.length > 0
                  ? "text-foreground"
                  : "text-muted-foreground"
              }
              hint="BattleMetrics-tracked servers both players have played on. A weak signal on its own — busy servers are shared by thousands. Stronger when combined with IP or name evidence."
            />
          </div>

          {/* Co-presence verdict */}
          {co && (
            <Block
              icon={<Clock className="size-3" />}
              title="Session co-presence"
              badge="timing"
            >
              <p className={`text-[11px] font-mono ${co.tone}`}>{co.label}</p>
              <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
                {co.hint}
                {account.coPresence.sharedServers > 0 &&
                  ` (${account.coPresence.overlapping}/${account.coPresence.altSessions} alt sessions overlapped across ${account.coPresence.sharedServers} shared server${account.coPresence.sharedServers === 1 ? "" : "s"})`}
              </p>
            </Block>
          )}

          {/* Mutual friends */}
          {account.mutualFriends?.length > 0 && (
            <Block
              icon={<Users className="size-3" />}
              title={`Mutual Steam friends (${account.mutualFriends.length})`}
            >
              <div className="flex flex-wrap gap-1.5">
                {account.mutualFriends.map((f) => (
                  <span
                    key={f}
                    className="px-2 py-0.5 rounded bg-surface ring-1 ring-border text-[11px] font-mono inline-flex items-center gap-1"
                  >
                    {f}
                    <PlayerLinks steamId={f} size="xs" />
                  </span>
                ))}
              </div>
            </Block>
          )}

          {/* Name aliases — top 5 by bigram similarity to subject name */}
          {(account.nameAliases?.length > 0 || account.relatedName) && (
            <Block
              icon={<ShieldAlert className="size-3" />}
              title="Known names (alias history)"
            >
              <div className="flex flex-wrap gap-1.5">
                {(account.nameAliases?.length
                  ? [...account.nameAliases]
                      .sort(
                        (a, b) =>
                          bigramSim(b, subjectName) - bigramSim(a, subjectName),
                      )
                      .slice(0, 5)
                  : [account.relatedName]
                ).map((n, i) => (
                  <span
                    key={`${n}-${i}`}
                    className="px-2 py-0.5 rounded bg-surface ring-1 ring-border text-[11px] font-mono"
                  >
                    {n}
                  </span>
                ))}
              </div>
            </Block>
          )}

          {/* Previous connection points with EAC/BM ban checks */}
          <ServerOverlapSection
            serverOverlap={account.serverOverlap}
            relatedBmId={account.relatedBmId}
            subjectName={subjectName}
            relatedName={name}
          />

          <div className="flex justify-end pt-2">
            {account.relatedSteamId ? (
              <Link
                to="/player-lookup"
                search={{ steam: account.relatedSteamId }}
                onClick={onClose}
                className="inline-flex items-center gap-1 text-[11px] font-mono text-brand hover:underline"
              >
                Open full profile on {name}
                <ExternalLink className="size-3" />
              </Link>
            ) : (
              <a
                href={`https://www.battlemetrics.com/players/${account.relatedBmId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-mono text-brand hover:underline"
              >
                Open on BattleMetrics
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const BLOCK_BADGE_HINTS = {
  hashed:
    "Full IP addresses are never stored — only a one-way hash. The short code (e.g. A3F2C1) identifies a specific IP without exposing the raw address.",
  timing:
    "Compares the timestamps when both accounts were seen online on the same servers. 'Never together' means their sessions never overlapped — consistent with one person alternating accounts.",
};

function Block({ icon, title, badge, children }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2 flex items-center gap-2">
        {icon}
        {title}
        {badge && (
          <Hint text={BLOCK_BADGE_HINTS[badge]}>
            <span className="text-warning normal-case tracking-normal font-mono cursor-help">
              · {badge}
            </span>
          </Hint>
        )}
      </h4>
      {children}
    </div>
  );
}

function SmallStat({ icon, label, value, tone, hint }) {
  return (
    <Hint text={hint}>
      <div className="px-3 py-2 rounded ring-1 ring-border bg-surface/40 cursor-help">
        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-1">
          {icon} {label}
        </p>
        <p className={`text-sm font-mono mt-0.5 ${tone}`}>{value}</p>
      </div>
    </Hint>
  );
}

// ── Session-history related players ───────────────────────────────────────────
// Accounts linked by TEMPORAL fingerprint instead of shared IPs: the backend
// probes BattleMetrics sessions around the subject's own connect/disconnect
// times and surfaces players who repeatedly join right after the subject
// leaves (or leave right before the subject joins) without playing at the
// same time — the signature of one person switching accounts. Catches alts
// on networks IP linking can't see (mobile hotspot, VPN, second household).

const SESSION_CONFIDENCE_META = {
  high: {
    label: "High",
    tone: "text-danger bg-danger/10 ring-danger/30",
    hint: "5+ switch events across 3+ different days with zero overlapping play — a consistent account-switching pattern, very unlikely by chance.",
  },
  likely: {
    label: "Likely",
    tone: "text-warning bg-warning/10 ring-warning/30",
    hint: "Repeated switch events across multiple days with at most one overlapping session — probably the same person switching accounts.",
  },
  possible: {
    label: "Possible",
    tone: "text-brand bg-brand/10 ring-brand/30",
    hint: "A couple of switch events. Could be coincidence (server queues produce join/leave adjacency) — corroborate with other evidence.",
  },
};

function formatGap(seconds) {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function SessionRelatedSection({ sessionRelated }) {
  const list = Array.isArray(sessionRelated) ? sessionRelated : [];
  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Clock className="size-3 shrink-0" />
          Session-Linked Players
          <Hint text="Players who repeatedly connect right after this player disconnects (or vice versa) on the same servers, without ever meaningfully playing at the same time. This catches account switching even when the alt uses a different network, so it finds links shared-IP analysis misses.">
            <span className="text-warning normal-case tracking-normal font-mono cursor-help">
              · timing
            </span>
          </Hint>
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {list.length}
        </span>
      </h3>

      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No account-switching pattern detected in recent session history.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 ring-1 ring-border rounded-lg bg-surface/40 overflow-hidden">
          {list.map((c) => {
            const name = displayNameOf(c);
            const meta =
              SESSION_CONFIDENCE_META[c.confidence] ??
              SESSION_CONFIDENCE_META.possible;
            const gap = formatGap(c.medianGapSeconds);
            return (
              <li key={c.relatedBmId} className="px-3 py-2 flex gap-3">
                <MiniAvatar id={c.relatedBmId} name={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold truncate max-w-[12rem]">
                      {name}
                    </span>
                    {c.relatedSteamId && (
                      <span className="text-[10px] font-mono text-muted-foreground inline-flex items-center gap-1">
                        <PlayerLinks steamId={c.relatedSteamId} size="xs" />
                      </span>
                    )}
                    <Hint text={meta.hint}>
                      <span
                        className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 shrink-0 cursor-help ${meta.tone}`}
                      >
                        {meta.label}
                      </span>
                    </Hint>
                    {c.alsoIpLinked && (
                      <Hint text="This player ALSO shares an IP identifier with the subject (see Linked Accounts). Two independent detection methods agreeing is very strong evidence.">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-danger/15 text-danger text-[9px] font-mono uppercase ring-1 ring-danger/40 cursor-help">
                          <Wifi className="size-2.5" /> IP match
                        </span>
                      </Hint>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] font-mono text-muted-foreground">
                    <Hint text="Times this player connected within 15 minutes of the subject disconnecting (or disconnected within 15 minutes of the subject connecting) on the same server.">
                      <span className="cursor-help text-foreground">
                        {c.adjacencyEvents} switch event
                        {c.adjacencyEvents === 1 ? "" : "s"}
                      </span>
                    </Hint>
                    <span>·</span>
                    <span>
                      {c.distinctDays} day{c.distinctDays === 1 ? "" : "s"}
                    </span>
                    {gap && (
                      <>
                        <span>·</span>
                        <Hint text="Median time between the subject's disconnect and this player's connect (or vice versa). Short, consistent gaps look like one person relogging.">
                          <span className="cursor-help">~{gap} gap</span>
                        </Hint>
                      </>
                    )}
                    {c.overlapSessions > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-success">
                          {c.overlapSessions} overlap
                        </span>
                      </>
                    )}
                  </div>
                  {(c.sharedServers ?? []).length > 0 && (
                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                      {c.sharedServers.map((s) => (
                        <span
                          key={s.bmServerId}
                          className="px-1.5 py-0.5 rounded bg-surface ring-1 ring-border text-[9px] font-mono text-muted-foreground truncate max-w-[11rem]"
                        >
                          {s.serverName ?? `BM ${s.bmServerId}`}
                          {s.events > 1 ? ` ×${s.events}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {c.relatedSteamId ? (
                  <Link
                    to="/player-lookup"
                    search={{ steam: c.relatedSteamId }}
                    className="self-center shrink-0 text-brand hover:underline text-[10px] font-mono uppercase tracking-widest inline-flex items-center gap-1"
                  >
                    View <ExternalLink className="size-2.5" />
                  </Link>
                ) : (
                  <a
                    href={`https://www.battlemetrics.com/players/${c.relatedBmId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="self-center shrink-0 text-brand hover:underline text-[10px] font-mono uppercase tracking-widest inline-flex items-center gap-1"
                  >
                    BM <ExternalLink className="size-2.5" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export {
  LinkedAccountIntelSection,
  LinkedAccountsSection,
  SessionRelatedSection,
};

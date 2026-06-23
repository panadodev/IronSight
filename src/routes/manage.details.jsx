import { SectionHeader } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import {
  ExternalLink,
  Globe,
  KeyRound,
  Radar,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const Route = createFileRoute("/manage/details")({
  component: ManageDetailsPage,
});

function redirectToLogin() {
  window.location.assign(
    `/login?next=${encodeURIComponent(window.location.pathname)}`,
  );
}

async function authFetch(url, init) {
  const res = await fetch(url, init);
  if (res.status === 401) {
    redirectToLogin();
    const err = new Error("Session expired");
    err.code = "AUTH_EXPIRED";
    throw err;
  }
  return res;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const SERVICE_LABELS = {
  battlemetrics: "BattleMetrics",
  steam: "Steam Web API",
  proxycheck: "Proxycheck.io",
};

const SERVICE_LINKS = {
  battlemetrics: "https://www.battlemetrics.com/developers/token",
  steam: "https://steamcommunity.com/dev/apikey",
  proxycheck: "https://proxycheck.io/dashboard/",
};

const SERVICE_HINTS = {
  battlemetrics:
    "Used to look up players, issue bans, and sync ban history via the BattleMetrics API.",
  steam:
    "Used to fetch Steam profile data, friends lists, and game hours during player lookup.",
  proxycheck:
    "Used to flag VPN / proxy connections on new player joins and during lookups.",
};

const SERVICE_PERMISSIONS = {
  battlemetrics: [
    {
      group: "Bans",
      items: [
        "View, search, and list bans",
        "Add new bans",
        "Edit existing bans",
        "Allow exporting bans",
      ],
    },
    { group: "RCON", items: ["View RCON information"] },
    { group: "Organizations", items: ["View organization information"] },
  ],
  steam: null,
  proxycheck: null,
};

const STEAM_DAILY_LIMIT = 100_000;

function BmKeyGraph({ keyData }) {
  if (!keyData?.length) return null;
  const hasRateData = keyData.some(
    (pt) => pt.rateMax != null && pt.minRemaining != null,
  );
  if (!hasRateData) return null;

  const data = keyData.map((pt) => ({
    bucket: pt.bucket,
    usage:
      pt.rateMax != null && pt.minRemaining != null
        ? Math.round(((pt.rateMax - pt.minRemaining) / pt.rateMax) * 100)
        : undefined,
  }));

  const formatHour = (ts) =>
    new Date(ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

  const formatTooltipLabel = (ts) =>
    new Date(ts * 1000).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="mt-2 space-y-1">
      <p className="text-[10px] text-muted-foreground">
        Rate limit usage — peak per hour, last 48h (
        <span className="text-amber-500">amber = 80%</span>)
      </p>
      <ResponsiveContainer width="100%" height={70}>
        <LineChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: -16 }}
        >
          <XAxis
            dataKey="bucket"
            tickFormatter={formatHour}
            tick={{ fontSize: 9, fill: "var(--color-muted-foreground, #888)" }}
            interval="preserveStartEnd"
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 9, fill: "var(--color-muted-foreground, #888)" }}
            tickFormatter={(v) => `${v}%`}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <ReferenceLine
            y={80}
            stroke="#f59e0b"
            strokeDasharray="3 2"
            strokeWidth={1}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <div className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs shadow-lg">
                  <p className="text-muted-foreground font-medium">
                    {formatTooltipLabel(label)}
                  </p>
                  <p className="text-blue-400">{payload[0]?.value}%</p>
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="usage"
            stroke="#60a5fa"
            dot={false}
            strokeWidth={1.5}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function UsageDayBar({ queriesDay, dailyLimit, label }) {
  if (!dailyLimit) return null;
  const pct = Math.min(Math.round((queriesDay / dailyLimit) * 100), 100);
  return (
    <div className="mt-2 space-y-1">
      <p className="text-[10px] text-muted-foreground">
        {label}: {queriesDay.toLocaleString()} / {dailyLimit.toLocaleString()} (
        {pct}%)
      </p>
      <div className="h-1 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${pct >= 80 ? "bg-amber-500" : "bg-blue-400"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ProxycheckKeyUsage({ usage }) {
  if (!usage) return null;
  return (
    <UsageDayBar
      queriesDay={usage.queriesDay}
      dailyLimit={usage.dailyLimit}
      label="Queries today"
    />
  );
}

function SteamKeyUsage({ keyData }) {
  const todayStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const callsToday = (keyData ?? [])
    .filter((pt) => pt.bucket >= todayStart)
    .reduce((sum, pt) => sum + (pt.sampleCount || 0), 0);
  if (!callsToday) return null;
  return (
    <UsageDayBar
      queriesDay={callsToday}
      dailyLimit={STEAM_DAILY_LIMIT}
      label="Steam API calls today"
    />
  );
}

function ApiKeysSection({ orgId }) {
  const [keys, setKeys] = useState([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [keysError, setKeysError] = useState("");
  const [stats, setStats] = useState({});
  const [proxycheckUsage, setProxycheckUsage] = useState({});

  const [addService, setAddService] = useState("battlemetrics");
  const [addKey, setAddKey] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);

  async function loadStats() {
    try {
      const res = await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/external-keys/stats`,
      );
      if (res.ok) {
        const body = await res.json();
        setStats(body.stats ?? {});
        setProxycheckUsage(body.proxycheckUsage ?? {});
      }
    } catch {
      // non-critical — usage displays just won't show
    }
  }

  async function loadKeys() {
    setLoadingKeys(true);
    setKeysError("");
    try {
      const res = await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/external-keys`,
      );
      if (!res.ok) {
        const body = await safeJson(res);
        setKeysError(body?.error ?? "Failed to load API keys.");
        return;
      }
      const body = await res.json();
      setKeys(body.keys ?? []);
    } catch (err) {
      if (err?.code !== "AUTH_EXPIRED")
        setKeysError("Failed to load API keys.");
    } finally {
      setLoadingKeys(false);
    }
  }

  useEffect(() => {
    loadKeys();
    loadStats();
  }, [orgId]);

  async function handleAddKey(e) {
    e.preventDefault();
    setAdding(true);
    setAddError("");
    try {
      const res = await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/external-keys`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            service: addService,
            key: addKey.trim(),
            label: addLabel.trim() || addService,
          }),
        },
      );
      if (!res.ok) {
        const body = await safeJson(res);
        setAddError(body?.error ?? "Failed to add key.");
        return;
      }
      const body = await res.json();
      setKeys((prev) => [...prev, body]);
      setAddKey("");
      setAddLabel("");
    } catch (err) {
      if (err?.code !== "AUTH_EXPIRED") setAddError("Failed to add key.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(keyId) {
    setDeletingId(keyId);
    try {
      await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/external-keys/${keyId}`,
        { method: "DELETE" },
      );
      setKeys((prev) => prev.filter((k) => k.keyId !== keyId));
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  }

  async function handleToggle(key) {
    setTogglingId(key.keyId);
    try {
      const res = await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/external-keys/${key.keyId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: !key.enabled }),
        },
      );
      if (res.ok) {
        setKeys((prev) =>
          prev.map((k) =>
            k.keyId === key.keyId ? { ...k, enabled: !k.enabled } : k,
          ),
        );
      }
    } catch {
      // ignore
    } finally {
      setTogglingId(null);
    }
  }

  const keysByService = ["battlemetrics", "steam", "proxycheck"].reduce(
    (acc, svc) => {
      acc[svc] = keys.filter((k) => k.service === svc);
      return acc;
    },
    {},
  );

  return (
    <div className="space-y-4 border-t border-border pt-6">
      <div>
        <h2 className="text-sm font-semibold">API Keys</h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Manage per-org API keys for player lookup integrations. Keys are
          stored encrypted and rotated automatically on rate-limit errors.
        </p>
      </div>

      {keysError && (
        <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {keysError}
        </div>
      )}

      {loadingKeys ? (
        <p className="text-sm text-muted-foreground">Loading keys…</p>
      ) : (
        <div className="space-y-4">
          {["battlemetrics", "steam", "proxycheck"].map((svc) => (
            <div
              key={svc}
              className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-2 max-w-xl"
            >
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{SERVICE_LABELS[svc]}</p>
                  <a
                    href={SERVICE_LINKS[svc]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    New token
                    <ExternalLink className="size-2.5" />
                  </a>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {SERVICE_HINTS[svc]}
                </p>
                {SERVICE_PERMISSIONS[svc] && (
                  <div className="mt-1.5 space-y-0.5">
                    <p className="text-[10px] font-medium text-muted-foreground">
                      Required permissions:
                    </p>
                    {SERVICE_PERMISSIONS[svc].map(({ group, items }) => (
                      <p
                        key={group}
                        className="text-[10px] text-muted-foreground"
                      >
                        <span className="text-foreground/60 font-medium">
                          {group}:
                        </span>{" "}
                        {items.join(" · ")}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              {keysByService[svc].length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No keys configured.
                </p>
              ) : (
                <div className="space-y-2">
                  {keysByService[svc].map((k) => (
                    <div
                      key={k.keyId}
                      className="rounded-md ring-1 ring-border bg-background px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <KeyRound className="size-3.5 text-muted-foreground shrink-0" />
                        <span className="text-xs flex-1 truncate">
                          {k.label || k.service}
                        </span>
                        {k.rateLimitedUntil &&
                          k.rateLimitedUntil >
                            Math.floor(Date.now() / 1000) && (
                            <span className="text-[10px] text-amber-500 font-mono shrink-0">
                              rate-limited
                            </span>
                          )}
                        <span
                          className={`text-[10px] font-mono shrink-0 ${k.enabled ? "text-emerald-500" : "text-muted-foreground"}`}
                        >
                          {k.enabled ? "enabled" : "disabled"}
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-xs h-6 px-2 shrink-0"
                          disabled={togglingId === k.keyId}
                          onClick={() => handleToggle(k)}
                        >
                          {k.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-muted-foreground hover:text-danger h-6 w-6 p-0 shrink-0"
                          disabled={deletingId === k.keyId}
                          onClick={() => handleDelete(k.keyId)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>

                      {svc === "battlemetrics" && (
                        <BmKeyGraph keyData={stats[k.keyId]} />
                      )}
                      {svc === "proxycheck" && (
                        <ProxycheckKeyUsage usage={proxycheckUsage[k.keyId]} />
                      )}
                      {svc === "steam" && (
                        <SteamKeyUsage keyData={stats[k.keyId]} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={handleAddKey}
        className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-3 max-w-xl"
      >
        <p className="text-sm font-medium">Add a key</p>

        {addError && (
          <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {addError}
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label htmlFor="add-service">Service</Label>
            <a
              href={SERVICE_LINKS[addService]}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              New token
              <ExternalLink className="size-2.5" />
            </a>
          </div>
          <Select value={addService} onValueChange={setAddService}>
            <SelectTrigger id="add-service">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="battlemetrics">BattleMetrics</SelectItem>
              <SelectItem value="steam">Steam Web API</SelectItem>
              <SelectItem value="proxycheck">Proxycheck.io</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="add-key">API key / token</Label>
          <Input
            id="add-key"
            type="password"
            placeholder="Paste key here"
            value={addKey}
            onChange={(e) => setAddKey(e.target.value)}
            required
          />
          {SERVICE_PERMISSIONS[addService] && (
            <div className="space-y-0.5 pt-0.5">
              <p className="text-[10px] font-medium text-muted-foreground">
                Required permissions:
              </p>
              {SERVICE_PERMISSIONS[addService].map(({ group, items }) => (
                <p key={group} className="text-[10px] text-muted-foreground">
                  <span className="text-foreground/60 font-medium">
                    {group}:
                  </span>{" "}
                  {items.join(" · ")}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="add-label">
            Label{" "}
            <span className="text-muted-foreground font-normal">
              (optional)
            </span>
          </Label>
          <Input
            id="add-label"
            placeholder="e.g. Main BM key"
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
          />
        </div>

        <Button type="submit" disabled={adding || !addKey.trim()}>
          {adding ? "Adding…" : "Add key"}
        </Button>
      </form>
    </div>
  );
}

const GLOBALPING_COUNTRIES = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "SG", name: "Singapore" },
  { code: "AU", name: "Australia" },
  { code: "JP", name: "Japan" },
  { code: "BR", name: "Brazil" },
  { code: "CA", name: "Canada" },
  { code: "SE", name: "Sweden" },
  { code: "PL", name: "Poland" },
  { code: "RU", name: "Russia" },
  { code: "ZA", name: "South Africa" },
  { code: "IN", name: "India" },
  { code: "KR", name: "South Korea" },
  { code: "FI", name: "Finland" },
  { code: "CH", name: "Switzerland" },
];
const DEFAULT_GP_COUNTRIES = [
  "US",
  "GB",
  "DE",
  "FR",
  "NL",
  "SG",
  "AU",
  "JP",
  "BR",
  "CA",
];

function RateLimitBadge({ limit }) {
  const { remaining, limit: total, reset, type } = limit;
  const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const color =
    pct > 50
      ? "text-emerald-400 ring-emerald-500/30 bg-emerald-500/10"
      : pct > 20
        ? "text-amber-400 ring-amber-500/30 bg-amber-500/10"
        : "text-danger ring-danger/30 bg-danger/10";
  const resetMins = reset != null && reset > 0 ? Math.ceil(reset / 60) : null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono ring-1 ${color}`}
      title={
        resetMins != null
          ? `Resets in ~${resetMins}m · ${type === "token" ? "authenticated" : "anonymous"}`
          : undefined
      }
    >
      {remaining.toLocaleString()} / {total.toLocaleString()} remaining
      {resetMins != null && (
        <span className="opacity-60">· {resetMins}m</span>
      )}
    </span>
  );
}

function GlobalpingSection({ orgId }) {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState("");
  const [limits, setLimits] = useState(null);

  const [apiToken, setApiToken] = useState("");
  const [countries, setCountries] = useState(DEFAULT_GP_COUNTRIES);
  const [probesPerCountry, setProbesPerCountry] = useState(3);
  const [checkIntervalMinutes, setCheckIntervalMinutes] = useState(5);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function loadLimits() {
    try {
      const res = await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/globalping/limits`,
      );
      if (res.ok) {
        const body = await res.json();
        setLimits(body.limits ?? null);
      }
    } catch {
      // non-critical
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/globalping/config`,
      );
      if (!res.ok) {
        const body = await safeJson(res);
        setError(body?.error ?? "Failed to load Globalping config.");
        return;
      }
      const body = await res.json();
      setConfig(body.config ?? null);
      if (body.config) {
        setCountries(body.config.countries ?? DEFAULT_GP_COUNTRIES);
        setProbesPerCountry(body.config.probesPerCountry ?? 3);
        setCheckIntervalMinutes(body.config.checkIntervalMinutes ?? 5);
      }
    } catch (err) {
      if (err?.code !== "AUTH_EXPIRED")
        setError("Failed to load Globalping config.");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
    loadLimits();
  }, [load]);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        countries,
        probesPerCountry: Number(probesPerCountry),
        checkIntervalMinutes: Number(checkIntervalMinutes),
      };
      if (apiToken.trim()) payload.apiToken = apiToken.trim();

      const res = await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/globalping/config`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = await safeJson(res);
        setError(body?.error ?? "Failed to save.");
        return;
      }
      const body = await res.json();
      setConfig(body.config ?? null);
      setApiToken("");
    } catch (err) {
      if (err?.code !== "AUTH_EXPIRED") setError("Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setError("");
    try {
      const res = await authFetch(
        `/api/orgs/${encodeURIComponent(orgId)}/globalping/config`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = await safeJson(res);
        setError(body?.error ?? "Failed to remove config.");
        return;
      }
      setConfig(null);
      setApiToken("");
      setCountries(DEFAULT_GP_COUNTRIES);
      setProbesPerCountry(3);
      setCheckIntervalMinutes(5);
    } catch (err) {
      if (err?.code !== "AUTH_EXPIRED") setError("Failed to remove.");
    } finally {
      setRemoving(false);
    }
  }

  function toggleCountry(code) {
    setCountries((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  const cyclesPerDay = Math.floor((24 * 60) / checkIntervalMinutes);

  return (
    <div className="border-t border-border pt-6">
      <div className="rounded-xl ring-1 ring-border bg-surface/40 overflow-hidden max-w-2xl">
        {/* Card header */}
        <div className="flex items-start gap-3 p-5 border-b border-border bg-surface/60">
          <div className="grid size-10 place-items-center rounded-lg ring-1 ring-border bg-background shrink-0">
            <Radar className="size-5 text-brand" />
          </div>
          <div className="space-y-1 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold leading-tight">
                Globalping Network Monitoring
              </h2>
              {limits?.rateLimit?.measurements?.create != null && (
                <RateLimitBadge limit={limits.rateLimit.measurements.create} />
              )}
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Ping your game servers from probes in major countries via the
              Globalping network. Free to use — an API token is optional and
              only raises the request rate limits.
            </p>
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-4 rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {loading ? (
          <p className="p-5 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <form onSubmit={handleSave} className="divide-y divide-border">
            {/* API token input */}
            <div className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 text-muted-foreground" />
                <p className="text-sm font-semibold">API token (optional)</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="gp-api-token" className="text-sm">
                    Globalping API token{" "}
                    {config?.hasToken && (
                      <span className="text-muted-foreground font-normal">
                        (leave blank to keep existing)
                      </span>
                    )}
                  </Label>
                  <a
                    href="https://dashboard.globalping.io/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    New token
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
                <Input
                  id="gp-api-token"
                  type="password"
                  placeholder="Leave blank to run unauthenticated"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                />
                {config?.tokenPrefix && (
                  <p className="text-xs text-muted-foreground font-mono">
                    Current token:{" "}
                    <span className="text-foreground">
                      {config.tokenPrefix}…
                    </span>
                  </p>
                )}
                <div className="rounded-md ring-1 ring-border bg-background/60 p-3 space-y-2">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Globalping works without an account, but unauthenticated
                    requests share a lower rate limit (250 measurements/hour).
                    Sign in at{" "}
                    <span className="font-mono text-foreground">
                      dashboard.globalping.io
                    </span>{" "}
                    and create a token to raise it to 500/hour and use up to 500
                    probes per measurement.
                  </p>
                </div>
              </div>
            </div>

            {/* Country selection */}
            <div className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Globe className="size-4 text-muted-foreground" />
                <p className="text-sm font-semibold">Probe countries</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Servers are pinged from each selected country each check cycle.
                Fewer countries = fewer probes per measurement.
              </p>
              <div className="flex flex-wrap gap-2">
                {GLOBALPING_COUNTRIES.map((c) => {
                  const active = countries.includes(c.code);
                  return (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => toggleCountry(c.code)}
                      className={`text-xs px-2.5 py-1.5 rounded-md ring-1 transition-colors ${
                        active
                          ? "ring-brand/60 bg-brand/15 text-brand font-medium"
                          : "ring-border bg-transparent text-muted-foreground hover:text-foreground hover:ring-border/80"
                      }`}
                    >
                      {c.code} · {c.name}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {countries.length} countr{countries.length === 1 ? "y" : "ies"}{" "}
                selected
              </p>
            </div>

            {/* Measurement settings */}
            <div className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="size-4 text-muted-foreground" />
                <p className="text-sm font-semibold">Measurement settings</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="probes-per-country" className="text-sm">
                    Probes per country
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="probes-per-country"
                      type="number"
                      min={1}
                      max={10}
                      value={probesPerCountry}
                      onChange={(e) =>
                        setProbesPerCountry(Number(e.target.value))
                      }
                      className="w-24"
                    />
                    <span className="text-sm text-muted-foreground">
                      per cycle
                    </span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="check-interval" className="text-sm">
                    Check interval
                  </Label>
                  <select
                    id="check-interval"
                    value={checkIntervalMinutes}
                    onChange={(e) =>
                      setCheckIntervalMinutes(Number(e.target.value))
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring [&>option]:bg-surface [&>option]:text-foreground"
                  >
                    <option value={5}>Every 5 minutes</option>
                    <option value={10}>Every 10 minutes</option>
                    <option value={25}>Every 25 minutes</option>
                  </select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Each cycle runs one measurement per server covering{" "}
                {countries.length} countr
                {countries.length === 1 ? "y" : "ies"} ({probesPerCountry} probe
                {probesPerCountry === 1 ? "" : "s"} each), ~
                {cyclesPerDay.toLocaleString()} cycles/day. Longer intervals
                stay further under Globalping's rate limit.
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 p-5 bg-surface/30">
              <Button
                type="submit"
                disabled={saving || removing || countries.length === 0}
              >
                {saving
                  ? "Saving…"
                  : config
                    ? "Update config"
                    : "Enable monitoring"}
              </Button>
              {config && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-danger hover:text-danger"
                  disabled={removing || saving}
                  onClick={handleRemove}
                >
                  <Trash2 className="size-4" />
                  {removing ? "Removing…" : "Disable & remove"}
                </Button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ManageDetailsPage() {
  const orgId = useManageOrgId();
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [guildId, setGuildId] = useState("");
  const [bmOrgId, setBmOrgId] = useState("");
  const [bmAutoSync, setBmAutoSync] = useState(false);
  const [guilds, setGuilds] = useState([]);
  const [sessionUser, setSessionUser] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) {
            setSessionUser(null);
            setSessionLoading(false);
          }
          return;
        }

        const body = await res.json();
        if (!cancelled) {
          setSessionUser(body?.user ?? null);
          setSessionLoading(false);
        }
      } catch {
        if (!cancelled) {
          setSessionUser(null);
          setSessionLoading(false);
        }
      }
    }

    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!orgId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function loadOrg() {
      setLoading(true);
      setError("");
      setMessage("");

      try {
        const res = await authFetch(`/api/orgs/${orgId}`);
        if (!res.ok) {
          const body = await safeJson(res);
          if (!cancelled)
            setError(body?.error ?? "Failed to load organization details.");
          return;
        }

        const body = await res.json();
        if (cancelled) return;
        setName(body.organization?.name ?? "");
        setGuildId(body.organization?.guildId ?? "");
        setBmOrgId(body.organization?.bmOrgId ?? "");
        setBmAutoSync(body.organization?.bmAutoSync === true);
      } catch (err) {
        if (!cancelled && err?.code !== "AUTH_EXPIRED") {
          setError(err?.message ?? "Failed to load organization details.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadOrg();

    return () => {
      cancelled = true;
    };
  }, [orgId]);

  useEffect(() => {
    let cancelled = false;
    async function loadGuilds() {
      try {
        const res = await fetch("/api/internal/discord-guilds", {
          credentials: "include",
        });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && Array.isArray(body?.guilds)) setGuilds(body.guilds);
      } catch {}
    }
    loadGuilds();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(event) {
    event.preventDefault();
    if (!orgId) return;

    setSaving(true);
    setError("");
    setMessage("");

    try {
      const res = await authFetch(`/api/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          guildId: guildId.trim() || null,
          bmOrgId: bmOrgId.trim() || null,
          bmAutoSync,
        }),
      });

      if (!res.ok) {
        const body = await safeJson(res);
        setError(body?.error ?? "Failed to save organization details.");
        return;
      }

      const body = await res.json();
      setName(body.organization?.name ?? name.trim());
      setGuildId(body.organization?.guildId ?? guildId.trim());
      setBmOrgId(body.organization?.bmOrgId ?? bmOrgId.trim());
      if (body.organization?.bmAutoSync !== undefined)
        setBmAutoSync(body.organization.bmAutoSync === true);
      setMessage("Organization details saved.");
    } catch (err) {
      if (err?.code !== "AUTH_EXPIRED") {
        setError(err?.message ?? "Failed to save organization details.");
      }
    } finally {
      setSaving(false);
    }
  }

  if (!orgId) {
    return (
      <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 text-sm text-muted-foreground">
        Select an organization from the Manage Org switcher first.
      </div>
    );
  }

  const isSysAdmin = Boolean(sessionUser?.isSysAdmin);
  const isOwner =
    isSysAdmin ||
    (Array.isArray(sessionUser?.orgOwnerOrgIds) &&
      sessionUser.orgOwnerOrgIds.includes(orgId));

  if (!sessionLoading && !isOwner) {
    return (
      <div className="rounded-lg ring-1 ring-border bg-surface/40 p-8 text-center">
        <SectionHeader
          title="Manage"
          blurb="Update core organization details."
        />
        <p className="text-sm text-muted-foreground mt-4">
          Only organization owners can access this page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <SectionHeader
          title="Manage"
          blurb="Update core organization details."
        />

        {error ? (
          <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="rounded-md ring-1 ring-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
            {message}
          </div>
        ) : null}

        <form
          onSubmit={handleSave}
          className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-4 max-w-xl"
        >
          <div className="space-y-1">
            <Label htmlFor="org-id">Organization ID</Label>
            <Input id="org-id" value={orgId} disabled />
          </div>

          <div className="space-y-1">
            <Label htmlFor="org-name">Organization name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={loading || saving}
              required
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="guild-id">Discord guild</Label>
            {guilds.length > 0 ? (
              <Select
                value={guildId || "__none__"}
                onValueChange={(v) => setGuildId(v === "__none__" ? "" : v)}
                disabled={loading || saving}
              >
                <SelectTrigger id="guild-id">
                  <SelectValue placeholder="Select a guild" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Not linked —</SelectItem>
                  {guilds.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name} ({g.id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="guild-id"
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                disabled={loading || saving}
                placeholder="123456789012345678"
              />
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="bm-org-id">BattleMetrics organization ID</Label>
            <Input
              id="bm-org-id"
              value={bmOrgId}
              onChange={(e) => setBmOrgId(e.target.value)}
              disabled={loading || saving}
              placeholder="12345"
            />
            <p className="text-[11px] text-muted-foreground">
              Found in your BattleMetrics URL: battlemetrics.com/rcon/orgs/
              <strong>ID</strong>
            </p>
          </div>

          <button
            type="button"
            onClick={() => setBmAutoSync((v) => !v)}
            disabled={loading || saving}
            className="flex w-full items-center justify-between gap-3 rounded-md ring-1 ring-border bg-background p-3 text-left transition-colors hover:bg-surface/60 disabled:opacity-50"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">Auto-sync bans to BattleMetrics</p>
              <p className="text-[11px] text-muted-foreground">
                Mirror every new ban to BattleMetrics as a record-only ban — no
                identifiers are attached, so BattleMetrics never bans the player
                itself; it just shows in your BM ban history. Requires a
                BattleMetrics organization ID and API key.
              </p>
            </div>
            <span
              className={
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors " +
                (bmAutoSync ? "bg-brand" : "bg-muted")
              }
            >
              <span
                className={
                  "inline-block size-4 rounded-full bg-background shadow transition-transform " +
                  (bmAutoSync ? "translate-x-4" : "translate-x-0.5")
                }
              />
            </span>
          </button>

          <Button type="submit" disabled={loading || saving}>
            {saving ? "Saving..." : "Save details"}
          </Button>
        </form>
      </div>

      <ApiKeysSection orgId={orgId} />

      <GlobalpingSection orgId={orgId} />
    </div>
  );
}

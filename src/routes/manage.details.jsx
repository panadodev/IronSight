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
import { KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
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

const SERVICE_HINTS = {
  battlemetrics:
    "Used to look up players, issue bans, and sync ban history via the BattleMetrics API.",
  steam:
    "Used to fetch Steam profile data, friends lists, and game hours during player lookup.",
  proxycheck:
    "Used to flag VPN / proxy connections on new player joins and during lookups.",
};

const KEY_COLORS = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171"];

function RateLimitGraph({ serviceKeys, stats }) {
  const keysWithData = serviceKeys.filter((k) => stats[k.keyId]?.length > 0);
  if (!keysWithData.length) return null;

  const bucketSet = new Set();
  for (const k of keysWithData) {
    for (const pt of stats[k.keyId]) bucketSet.add(pt.bucket);
  }
  const buckets = [...bucketSet].sort((a, b) => a - b);

  const data = buckets.map((bucket) => {
    const entry = { bucket };
    for (const k of keysWithData) {
      const pt = stats[k.keyId]?.find((p) => p.bucket === bucket);
      if (pt?.rateMax && pt.minRemaining != null) {
        entry[k.keyId] = Math.round(
          ((pt.rateMax - pt.minRemaining) / pt.rateMax) * 100,
        );
      }
    }
    return entry;
  });

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
    <div className="mt-3 space-y-1">
      <p className="text-[10px] text-muted-foreground">
        Rate limit usage — peak per hour, last 48h (
        <span className="text-amber-500">amber line = 80%</span>)
      </p>
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
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
                <div className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs shadow-lg space-y-0.5">
                  <p className="text-muted-foreground font-medium">
                    {formatTooltipLabel(label)}
                  </p>
                  {payload.map((p) => {
                    const k = keysWithData.find((k) => k.keyId === p.dataKey);
                    return (
                      <p key={p.dataKey} style={{ color: p.color }}>
                        {k?.label || k?.service}: {p.value}%
                      </p>
                    );
                  })}
                </div>
              );
            }}
          />
          {keysWithData.map((k, i) => (
            <Line
              key={k.keyId}
              type="monotone"
              dataKey={k.keyId}
              stroke={KEY_COLORS[i % KEY_COLORS.length]}
              dot={false}
              strokeWidth={1.5}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ApiKeysSection({ orgId }) {
  const [keys, setKeys] = useState([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [keysError, setKeysError] = useState("");
  const [stats, setStats] = useState({});

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
      }
    } catch {
      // non-critical — graph just won't show
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
                <p className="text-sm font-medium">{SERVICE_LABELS[svc]}</p>
                <p className="text-[11px] text-muted-foreground">
                  {SERVICE_HINTS[svc]}
                </p>
              </div>

              {keysByService[svc].length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No keys configured.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {keysByService[svc].map((k) => (
                    <div
                      key={k.keyId}
                      className="flex items-center gap-2 rounded-md ring-1 ring-border bg-background px-3 py-2"
                    >
                      <KeyRound className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs flex-1 truncate">
                        {k.label || k.service}
                      </span>
                      {k.rateLimitedUntil &&
                        k.rateLimitedUntil > Math.floor(Date.now() / 1000) && (
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
                  ))}
                </div>
              )}

              <RateLimitGraph serviceKeys={keysByService[svc]} stats={stats} />
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
          <Label htmlFor="add-service">Service</Label>
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

function ManageDetailsPage() {
  const orgId = useManageOrgId();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [guildId, setGuildId] = useState("");
  const [sessionUser, setSessionUser] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) setSessionUser(null);
          return;
        }

        const body = await res.json();
        if (!cancelled) setSessionUser(body?.user ?? null);
      } catch {
        if (!cancelled) setSessionUser(null);
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
          guildId: guildId.trim(),
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
            <Label htmlFor="guild-id">Discord guild ID</Label>
            <Input
              id="guild-id"
              value={guildId}
              onChange={(e) => setGuildId(e.target.value)}
              disabled={loading || saving}
              placeholder="123456789012345678"
            />
          </div>

          <Button type="submit" disabled={loading || saving}>
            {saving ? "Saving..." : "Save details"}
          </Button>
        </form>
      </div>

      <ApiKeysSection orgId={orgId} />

      {isSysAdmin && (
        <div className="space-y-2 border-t border-border pt-6">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Roles & Permissions</h2>
            <span className="text-[9px] font-mono uppercase tracking-widest text-brand bg-brand/10 px-1.5 py-0.5 rounded">
              Sysadmin Privilege
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            This organization does not directly manage roles. Go to SYS_ADMIN
            section to create or modify global roles.
          </p>
        </div>
      )}
    </div>
  );
}

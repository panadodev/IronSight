import { SectionHeader } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/manage/details")({
  component: ManageDetailsPage
});

function redirectToLogin() {
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
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
          if (!cancelled) setError(body?.error ?? "Failed to load organization details.");
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
          guildId: guildId.trim()
        })
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
        <SectionHeader title="Manage" blurb="Update core organization details." />

        {error ? (
          <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
        ) : null}
        {message ? (
          <div className="rounded-md ring-1 ring-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
            {message}
          </div>
        ) : null}

        <form onSubmit={handleSave} className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-4 max-w-xl">
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

      {isSysAdmin && (
        <div className="space-y-2 border-t border-border pt-6">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Roles & Permissions</h2>
            <span className="text-[9px] font-mono uppercase tracking-widest text-brand bg-brand/10 px-1.5 py-0.5 rounded">
              Sysadmin Privilege
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            This organization does not directly manage roles. Go to SYS_ADMIN section to create or modify global roles.
          </p>
        </div>
      )}
    </div>
  );
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

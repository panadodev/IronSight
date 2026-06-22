import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { BanConfigsPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";

const Route = createFileRoute("/manage/ban-configs")({
  component: BanConfigsPage,
});

function BanConfigsPage() {
  const {
    sessionUser,
    hasOrgPermission,
    orgBanConfigs,
    orgMuteConfigs,
    loadOrgBanConfigs,
  } = useAuth();
  const orgId = useManageOrgId();
  const [loading, setLoading] = useState(false);

  const isAdmin =
    Boolean(sessionUser?.isSysAdmin) ||
    hasOrgPermission(orgId, "ban_configs_manage");

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    loadOrgBanConfigs(orgId).finally(() => setLoading(false));
  }, [orgId, loadOrgBanConfigs]);

  const refresh = () => loadOrgBanConfigs(orgId);

  const addReason = async (category, label) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ban-configs/reasons`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, label }),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: body?.error ?? "Failed to add." };
    await refresh();
    return { ok: true };
  };

  const updateReason = async (category, id, label) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ban-configs/reasons/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: body?.error ?? "Failed to save." };
    await refresh();
    return { ok: true };
  };

  const removeReason = async (category, id) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ban-configs/reasons/${encodeURIComponent(id)}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: body?.error ?? "Failed to remove." };
    }
    await refresh();
    return { ok: true };
  };

  const setNoteFormat = async (category, noteFormat) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ban-configs/note`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, noteFormat }),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: body?.error ?? "Failed to save." };
    await refresh();
    return { ok: true };
  };

  if (!orgId) return null;

  const banCfg = orgBanConfigs[orgId];
  const muteCfg = orgMuteConfigs[orgId];
  const allConfigs = banCfg
    ? { ...banCfg, mute: muteCfg ?? { reasons: [], noteFormat: "" } }
    : null;

  return (
    <GateRank rank={isAdmin ? 4 : 0} required={4}>
      <SectionHeader
        title="Ban configs"
        blurb="Pre-set ban reasons and note templates per report category."
      />
      {loading && !allConfigs ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <BanConfigsPanel
          orgId={orgId}
          configs={allConfigs ?? {}}
          onAddReason={addReason}
          onUpdateReason={updateReason}
          onRemoveReason={removeReason}
          onSetNoteFormat={setNoteFormat}
        />
      )}
    </GateRank>
  );
}

export { Route };

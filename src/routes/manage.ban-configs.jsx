import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { BanConfigsPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";

const Route = createFileRoute("/manage/ban-configs")({
  component: BanConfigsPage,
});

function BanConfigsPage() {
  const { sessionOrgAdminIds, sessionUser } = useAuth();
  const orgId = useManageOrgId();
  const [data, setData] = useState({
    configs: {},
    mute: { reasons: [], noteFormat: "" },
  });

  const isAdmin =
    Boolean(sessionUser?.isSysAdmin) || sessionOrgAdminIds.includes(orgId);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ban-configs`,
        { credentials: "include" },
      );
      if (res.ok) {
        const body = await res.json();
        setData({
          configs: body.configs ?? {},
          mute: body.mute ?? { reasons: [], noteFormat: "" },
        });
      }
    } catch {
      /* ignore */
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

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
    await load();
    return { ok: true };
  };

  const updateReason = async (id, label) => {
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
    await load();
    return { ok: true };
  };

  const removeReason = async (id) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ban-configs/reasons/${encodeURIComponent(id)}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: body?.error ?? "Failed to remove." };
    }
    await load();
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
    await load();
    return { ok: true };
  };

  if (!orgId) return null;

  return (
    <GateRank rank={isAdmin ? 4 : 0} required={4}>
      <SectionHeader
        title="Ban configs"
        blurb="Pre-set ban reasons and note templates per report category."
      />
      <BanConfigsPanel
        orgId={orgId}
        configs={data.configs}
        muteConfig={data.mute}
        onAddReason={(cat, label) => addReason(cat, label)}
        onUpdateReason={(cat, id, label) => updateReason(id, label)}
        onRemoveReason={(cat, id) => removeReason(id)}
        onSetNoteFormat={(cat, fmt) => setNoteFormat(cat, fmt)}
        onAddMuteReason={(label) => addReason("mute", label)}
        onUpdateMuteReason={(id, label) => updateReason(id, label)}
        onRemoveMuteReason={(id) => removeReason(id)}
        onSetMuteNoteFormat={(fmt) => setNoteFormat("mute", fmt)}
      />
    </GateRank>
  );
}

export { Route };

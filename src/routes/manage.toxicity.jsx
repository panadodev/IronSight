import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { ToxicityPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";

const Route = createFileRoute("/manage/toxicity")({
  component: ToxicityPage,
});

function ToxicityPage() {
  const { sessionOrgAdminIds, sessionUser } = useAuth();
  const orgId = useManageOrgId();
  const [config, setConfig] = useState({ yellow: [], red: [] });

  const isAdmin =
    Boolean(sessionUser?.isSysAdmin) || sessionOrgAdminIds.includes(orgId);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/toxicity`,
        { credentials: "include" },
      );
      if (res.ok) {
        const body = await res.json();
        setConfig({ yellow: body.yellow ?? [], red: body.red ?? [] });
      }
    } catch {
      /* ignore */
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSave = async (kind, phrases) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/toxicity`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, phrases }),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: body?.error ?? "Failed to save." };
    setConfig({ yellow: body.yellow ?? [], red: body.red ?? [] });
    return { ok: true };
  };

  if (!orgId) return null;

  return (
    <GateRank rank={isAdmin ? 4 : 0} required={4}>
      <SectionHeader
        title="Toxicity"
        blurb="Flag chat phrases as yellow or red in toxicity reports."
      />
      <ToxicityPanel orgId={orgId} config={config} onSave={onSave} />
    </GateRank>
  );
}

export { Route };

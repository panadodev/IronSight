import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { PredefinesPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";

const Route = createFileRoute("/manage/predefines")({
  component: PredefinesPage,
});

function PredefinesPage() {
  const { sessionUser, hasOrgPermission } = useAuth();
  const orgId = useManageOrgId();
  const [items, setItems] = useState([]);
  const [ticketTypes, setTicketTypes] = useState([]);

  const isAdmin =
    Boolean(sessionUser?.isSysAdmin) ||
    hasOrgPermission(orgId, "predefines_manage");

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/predefines`,
        { credentials: "include" },
      );
      if (res.ok) {
        const body = await res.json();
        setItems(body.predefines ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/ticket-types`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setTicketTypes(data?.ticketTypes ?? []))
      .catch(() => {});
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const onAdd = async ({ keyword, extraKeywords, content, ticketTypeIds }) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/predefines`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keyword,
          extraKeywords,
          content,
          ticketTypeIds,
        }),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok)
      return { ok: false, error: body?.error ?? "Failed to add pre-define." };
    await load();
    return { ok: true };
  };

  const onUpdate = async (
    id,
    { keyword, extraKeywords, content, ticketTypeIds },
  ) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/predefines/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keyword,
          extraKeywords,
          content,
          ticketTypeIds,
        }),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: body?.error ?? "Failed to save." };
    await load();
    return { ok: true };
  };

  const onRemove = async (id) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/predefines/${encodeURIComponent(id)}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: body?.error ?? "Failed to remove." };
    }
    await load();
    return { ok: true };
  };

  if (!orgId) return null;

  return (
    <GateRank rank={isAdmin ? 4 : 0} required={4}>
      <SectionHeader
        title="Pre-defines"
        blurb="Reusable canned messages for staff replies."
      />
      <PredefinesPanel
        orgId={orgId}
        items={items}
        ticketTypes={ticketTypes}
        onAdd={onAdd}
        onUpdate={onUpdate}
        onRemove={onRemove}
      />
    </GateRank>
  );
}

export { Route };

import { TicketTypesPanel } from "@/components/manage-org-dialog";
import { GateRank, SectionHeader } from "@/components/manage-section";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const Route = createFileRoute("/manage/tickets")({
  component: TicketsPage,
});

function TicketsPage() {
  const { sessionUser, sessionOrgOwnerIds } = useAuth();
  const orgId = useManageOrgId();
  const [ticketTypes, setTicketTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/ticket-types`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setTicketTypes(data?.ticketTypes ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [orgId]);

  if (!orgId) return null;

  const isOwner =
    Boolean(sessionUser?.isSysAdmin) || sessionOrgOwnerIds.includes(orgId);

  const enabled = ticketTypes.reduce((acc, tt) => {
    const key = tt.name.toLowerCase().replace(/\s+/g, "");
    return { ...acc, [key]: tt.isEnabled };
  }, {});

  const handleToggle = async (key, value) => {
    const ticketType = ticketTypes.find((tt) => {
      const ttKey = tt.name.toLowerCase().replace(/\s+/g, "");
      return ttKey === key;
    });

    if (!ticketType) return;

    setUpdating(ticketType.ticketTypeId);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketType.ticketTypeId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isEnabled: value }),
        },
      );

      if (res.ok) {
        setTicketTypes((prev) =>
          prev.map((tt) =>
            tt.ticketTypeId === ticketType.ticketTypeId
              ? { ...tt, isEnabled: value }
              : tt,
          ),
        );
      }
    } catch {}
    setUpdating(null);
  };

  return (
    <GateRank rank={isOwner ? 4 : 0} required={4}>
      <SectionHeader
        title="Tickets"
        blurb="Enable or disable each ticket type for this org."
      />
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <TicketTypesPanel
          enabled={enabled}
          onToggle={handleToggle}
          updating={updating}
        />
      )}
    </GateRank>
  );
}

export { Route };

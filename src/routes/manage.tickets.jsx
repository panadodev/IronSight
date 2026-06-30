import { GateRank, SectionHeader } from "@/components/manage-section";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const Route = createFileRoute("/manage/tickets")({
  component: TicketsPage,
});

function TicketsPage() {
  const { sessionUser, hasOrgPermission } = useAuth();
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

  const canManage =
    Boolean(sessionUser?.isSysAdmin) ||
    hasOrgPermission(orgId, "ticket_types_manage");

  const handleToggle = async (ticketTypeId, value) => {
    // Optimistic update
    setTicketTypes((prev) =>
      prev.map((tt) =>
        tt.ticketTypeId === ticketTypeId ? { ...tt, isEnabled: value } : tt,
      ),
    );

    setUpdating(ticketTypeId);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isEnabled: value }),
        },
      );

      if (!res.ok) {
        // Revert on failure
        setTicketTypes((prev) =>
          prev.map((tt) =>
            tt.ticketTypeId === ticketTypeId
              ? { ...tt, isEnabled: !value }
              : tt,
          ),
        );
      }
    } catch {
      // Revert on network error
      setTicketTypes((prev) =>
        prev.map((tt) =>
          tt.ticketTypeId === ticketTypeId ? { ...tt, isEnabled: !value } : tt,
        ),
      );
    }
    setUpdating(null);
  };

  return (
    <GateRank rank={canManage ? 4 : 0} required={4}>
      <SectionHeader
        title="Tickets"
        blurb="Enable or disable each ticket type for this org."
      />
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : ticketTypes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ticket types found.</p>
      ) : (
        <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
          <div className="divide-y divide-border">
            {ticketTypes.map((tt) => (
              <div
                key={tt.ticketTypeId}
                className="flex items-center justify-between py-2"
              >
                <span className="text-sm">{tt.name}</span>
                <Switch
                  checked={tt.isEnabled}
                  disabled={updating === tt.ticketTypeId}
                  onCheckedChange={(v) => handleToggle(tt.ticketTypeId, v)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </GateRank>
  );
}

export { Route };

import { createFileRoute } from "@tanstack/react-router";
import { useAuth, TICKET_TYPE_KEYS } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { TicketTypesPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";

const Route = createFileRoute("/manage/tickets")({
  component: TicketsPage,
});

function TicketsPage() {
  const {
    orgTicketTypes,
    setOrgTicketTypeEnabled,
    sessionUser,
    sessionOrgOwnerIds,
  } = useAuth();
  const orgId = useManageOrgId();
  if (!orgId) return null;
  const isOwner =
    Boolean(sessionUser?.isSysAdmin) || sessionOrgOwnerIds.includes(orgId);
  const enabled =
    orgTicketTypes[orgId] ??
    TICKET_TYPE_KEYS.reduce((acc, k) => ({ ...acc, [k]: true }), {});
  return (
    <GateRank rank={isOwner ? 4 : 0} required={4}>
      <SectionHeader
        title="Tickets"
        blurb="Enable or disable each ticket type for this org."
      />
      <TicketTypesPanel
        enabled={enabled}
        onToggle={(key, value) => setOrgTicketTypeEnabled(orgId, key, value)}
      />
    </GateRank>
  );
}

export { Route };

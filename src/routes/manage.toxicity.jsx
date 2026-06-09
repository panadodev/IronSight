import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { ToxicityPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";
const Route = createFileRoute("/manage/toxicity")({
  component: ToxicityPage,
});
function ToxicityPage() {
  const { orgToxicity, setOrgToxicityPhrases, realRankOf } = useAuth();
  const orgId = useManageOrgId();
  if (!orgId) return null;
  const rank = realRankOf(orgId);
  return (
    <GateRank rank={rank} required={3}>
      <SectionHeader
        title="Toxicity"
        blurb="Flag chat phrases as yellow or red in toxicity reports."
      />
      <ToxicityPanel
        orgId={orgId}
        config={orgToxicity[orgId] ?? { yellow: [], red: [] }}
        onSave={(kind, phrases) => setOrgToxicityPhrases(orgId, kind, phrases)}
      />
    </GateRank>
  );
}
export { Route };

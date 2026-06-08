import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { PredefinesPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";
const Route = createFileRoute("/manage/predefines")({
  component: PredefinesPage
});
function PredefinesPage() {
  const { orgPredefines, addOrgPredefine, updateOrgPredefine, removeOrgPredefine, realRankOf } = useAuth();
  const orgId = useManageOrgId();
  if (!orgId) return null;
  const rank = realRankOf(orgId);
  return <GateRank rank={rank} required={3}>
      <SectionHeader
    title="Pre-defines"
    blurb="Reusable canned messages for staff replies."
  />
      <PredefinesPanel
    orgId={orgId}
    items={orgPredefines[orgId] ?? []}
    onAdd={(input) => addOrgPredefine(orgId, input)}
    onUpdate={(id, patch) => updateOrgPredefine(orgId, id, patch)}
    onRemove={(id) => removeOrgPredefine(orgId, id)}
  />
    </GateRank>;
}
export {
  Route
};

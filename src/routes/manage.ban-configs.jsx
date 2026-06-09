import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { BanConfigsPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";
const Route = createFileRoute("/manage/ban-configs")({
  component: BanConfigsPage,
});
function BanConfigsPage() {
  const {
    orgBanConfigs,
    addBanReason,
    removeBanReason,
    updateBanReason,
    setBanNoteFormat,
    orgMuteConfigs,
    addMuteReason,
    removeMuteReason,
    updateMuteReason,
    setMuteNoteFormat,
    realRankOf,
  } = useAuth();
  const orgId = useManageOrgId();
  if (!orgId) return null;
  const rank = realRankOf(orgId);
  return (
    <GateRank rank={rank} required={4}>
      <SectionHeader
        title="Ban configs"
        blurb="Pre-set ban reasons and note templates per report category."
      />
      <BanConfigsPanel
        orgId={orgId}
        configs={orgBanConfigs[orgId] ?? {}}
        muteConfig={orgMuteConfigs[orgId] ?? { reasons: [], noteFormat: "" }}
        onAddReason={(cat, label) => addBanReason(orgId, cat, label)}
        onUpdateReason={(cat, id, label) =>
          updateBanReason(orgId, cat, id, label)
        }
        onRemoveReason={(cat, id) => removeBanReason(orgId, cat, id)}
        onSetNoteFormat={(cat, fmt) => setBanNoteFormat(orgId, cat, fmt)}
        onAddMuteReason={(label) => addMuteReason(orgId, label)}
        onUpdateMuteReason={(id, label) => updateMuteReason(orgId, id, label)}
        onRemoveMuteReason={(id) => removeMuteReason(orgId, id)}
        onSetMuteNoteFormat={(fmt) => setMuteNoteFormat(orgId, fmt)}
      />
    </GateRank>
  );
}
export { Route };

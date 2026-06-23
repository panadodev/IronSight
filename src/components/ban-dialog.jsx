import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
const LENGTH_OPTIONS = [
  { id: "1h", label: "1 hour" },
  { id: "3h", label: "3 hours" },
  { id: "6h", label: "6 hours" },
  { id: "12h", label: "12 hours" },
  { id: "24h", label: "24 hours" },
  { id: "2d", label: "2 days" },
  { id: "3d", label: "3 days" },
  { id: "4d", label: "4 days" },
  { id: "5d", label: "5 days" },
  { id: "6d", label: "6 days" },
  { id: "next_wipe", label: "Next wipe" },
  { id: "7d", label: "7 days" },
  { id: "14d", label: "14 days" },
  { id: "30d", label: "30 days" },
  { id: "permanent", label: "Permanent" },
];
const LENGTH_LABEL = Object.fromEntries(
  LENGTH_OPTIONS.map((o) => [o.id, o.label]),
);
function BanDialog({
  open,
  onOpenChange,
  orgId,
  category,
  subjectName,
  onSubmit,
  mode = "ban",
}) {
  const { orgBanConfigs, orgMuteConfigs, loadOrgBanConfigs } = useAuth();
  const isMute = mode === "mute";
  const isOther = !isMute && category === "other";
  const banCategory = isOther ? null : category;
  const config = isMute
    ? (orgMuteConfigs[orgId] ?? null)
    : banCategory && orgBanConfigs[orgId]
      ? orgBanConfigs[orgId][banCategory]
      : null;
  const reasons = config?.reasons ?? [];
  const noteFormat = isOther ? "" : (config?.noteFormat ?? "");
  const [reasonId, setReasonId] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [length, setLength] = useState("7d");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  useEffect(() => {
    if (!open || !orgId) return;
    if (orgBanConfigs[orgId] === undefined) {
      loadOrgBanConfigs(orgId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orgId]);
  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setSubmitError("");
      return;
    }
    setReasonId(isOther ? "__custom__" : (reasons[0]?.id ?? "__custom__"));
    setCustomReason("");
    setLength("7d");
    setNote(noteFormat);
    setSubmitError("");
  }, [open, orgId, category, isOther, noteFormat, reasons]);
  const reasonLabel = useMemo(() => {
    if (reasonId === "__custom__") return customReason.trim();
    return reasons.find((r) => r.id === reasonId)?.label ?? "";
  }, [reasonId, customReason, reasons]);
  const canSubmit = reasonLabel.length > 0;
  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      await onSubmit({
        reason: reasonLabel,
        length,
        lengthLabel: LENGTH_LABEL[length],
        note: note.trim(),
      });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err?.message ?? "Failed — please try again");
      setSubmitting(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isMute ? "Mute" : "Ban"} {subjectName}
          </DialogTitle>
          <DialogDescription>
            {isMute
              ? "Issue a mute. Reasons and note format come from this org's mute config."
              : category === "other"
                ? "Other \u2014 enter a custom reason. No pre-set note format for this category."
                : `Issue a ${category} ban. Reasons and note format come from this org's ban configs.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
              {isMute ? "Mute reason" : "Ban reason"}
            </Label>

            <select
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              className="w-full bg-surface border border-border rounded px-2 py-2 text-sm"
            >
              {reasons.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
              <option value="__custom__">Custom ban reason…</option>
            </select>
            {reasonId === "__custom__" && (
              <Input
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Type custom reason"
                className="h-8 text-xs"
                autoFocus
              />
            )}
            {reasons.length === 0 && !isOther && (
              <p className="text-[11px] text-muted-foreground italic">
                No pre-set reasons configured — add some in Manage org → Ban
                configs.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
              {isMute ? "Mute length" : "Ban length"}
            </Label>
            <select
              value={length}
              onChange={(e) => setLength(e.target.value)}
              className="w-full bg-surface border border-border rounded px-2 py-2 text-sm"
            >
              {LENGTH_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
              {isMute ? "Mute note" : "Ban note"}
            </Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                isOther ? "Add internal notes about this ban\u2026" : ""
              }
              className="min-h-[160px] text-xs font-mono"
            />
            {!isOther && (
              <p className="text-[10px] font-mono text-muted-foreground">
                Pre-filled from the {isMute ? "mute" : "category's ban"} note
                format. Edit in Manage org → Ban configs.
              </p>
            )}
          </div>
        </div>

        {submitError && (
          <p className="text-xs text-danger bg-danger/10 ring-1 ring-danger/30 rounded px-3 py-2">
            {submitError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canSubmit || submitting}
            onClick={handleSubmit}
          >
            {submitting
              ? isMute
                ? "Muting…"
                : "Banning…"
              : isMute
                ? "Mute player"
                : "Ban player"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
export { BanDialog, LENGTH_LABEL, LENGTH_OPTIONS };

import { GateRank, SectionHeader } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { OWNER_STEAM_ID, TEAM_IDS, TEAM_META } from "@/lib/mock-data";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList, Crown, Trash2, UserCog, UserPlus } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/manage/staff")({
  component: StaffPage,
});

function StaffPage() {
  const {
    orgMembers,
    staff,
    addOrgMember,
    removeOrgMember,
    setOrgMemberTeam,
    isOwner,
    realStaffId,
    activeStaffId,
    impersonate,
    stopImpersonating,
    realRankOf,
  } = useAuth();
  const orgId = useManageOrgId();

  const [memberName, setMemberName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [newTeam, setNewTeam] = useState("support");
  const [err, setErr] = useState(null);

  if (!orgId) return null;
  const rank = realRankOf(orgId);
  const currentMembers = orgMembers[orgId] ?? [];

  const handleAdd = () => {
    const value = identifier.trim();
    if (!value) {
      setErr("Enter a Steam ID or Discord ID.");
      return;
    }
    const isSteam = value.startsWith("76561198");
    const res = addOrgMember(orgId, {
      name: memberName.trim() || undefined,
      steamId: isSteam ? value : undefined,
      discordId: isSteam ? undefined : value,
      team: newTeam,
    });
    if (!res.ok) {
      setErr(res.error ?? "Failed to add member.");
      return;
    }
    setMemberName("");
    setIdentifier("");
    setNewTeam("support");
    setErr(null);
  };

  return (
    <GateRank rank={rank} required={4}>
      <SectionHeader
        title="Staff"
        blurb="Add, remove, or move staff between teams."
      />

      <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
            Add staff
          </Label>
          <span className="text-[9px] font-mono uppercase tracking-widest text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded">
            WIP
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Name (optional)"
            value={memberName}
            onChange={(e) => {
              setMemberName(e.target.value);
              setErr(null);
            }}
            className="min-w-[180px]"
          />
          <Input
            placeholder="Discord ID or Steam ID"
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value);
              setErr(null);
            }}
            className="flex-1 min-w-[200px]"
          />
          <select
            value={newTeam}
            onChange={(e) => setNewTeam(e.target.value)}
            className="bg-surface border border-border rounded px-2 py-1 text-xs"
          >
            {TEAM_IDS.map((id) => (
              <option key={id} value={id}>
                {TEAM_META[id].label}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={handleAdd}>
            <UserPlus className="size-3.5 mr-1" /> Add
          </Button>
        </div>
        {!isOwner && newTeam === "management" && (
          <p className="text-[11px] text-muted-foreground">
            Heads-up: adding someone to Management gives them the same powers as
            you.
          </p>
        )}
        {err && <p className="text-[11px] text-danger">{err}</p>}
      </div>

      <div className="space-y-1.5">
        {currentMembers.map((m) => {
          const s = staff.find((x) => x.id === m.staffId);
          if (!s) return null;
          const isOwnerRow = s.steamId === OWNER_STEAM_ID;
          return (
            <div
              key={m.staffId}
              className="flex items-center justify-between gap-2 bg-background ring-1 ring-border rounded-md p-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="size-7 rounded bg-brand/20 text-brand text-[10px] font-mono font-bold grid place-items-center shrink-0">
                  {s.avatar}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate flex items-center gap-1.5">
                    {s.name}
                    {isOwnerRow && (
                      <span title="Owner — cannot be removed">
                        <Crown className="size-3 text-brand" />
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] font-mono text-muted-foreground truncate">
                    {s.steamId ? `steam:${s.steamId}` : ""}
                    {s.steamId && s.discordId ? " · " : ""}
                    {s.discordId ? `discord:${s.discordId}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                  className="h-7 px-2 text-[10px] font-mono uppercase tracking-widest gap-1"
                  title="View audit log"
                >
                  <Link to="/staff-audit" search={{ staff: m.staffId }}>
                    <ClipboardList className="size-3" />
                    Audit
                  </Link>
                </Button>
                <span className="text-[9px] font-mono uppercase tracking-widest text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded">
                  WIP
                </span>
                <Button
                  size="sm"
                  variant={activeStaffId === m.staffId ? "default" : "outline"}
                  onClick={() =>
                    m.staffId === realStaffId
                      ? stopImpersonating()
                      : impersonate(m.staffId)
                  }
                  className="h-7 px-2 text-[10px] font-mono uppercase tracking-widest gap-1"
                >
                  <UserCog className="size-3" />
                  {m.staffId === realStaffId
                    ? "You"
                    : activeStaffId === m.staffId
                      ? "Acting"
                      : "Impersonate"}
                </Button>
                <select
                  value={m.team}
                  disabled={isOwnerRow}
                  onChange={(e) =>
                    setOrgMemberTeam(orgId, m.staffId, e.target.value)
                  }
                  className="bg-surface border border-border rounded px-2 py-1 text-[11px] font-mono disabled:opacity-50"
                  title={
                    isOwnerRow
                      ? "Owner's team cannot be changed"
                      : "Change team"
                  }
                >
                  {TEAM_IDS.map((id) => (
                    <option key={id} value={id}>
                      {TEAM_META[id].label}
                    </option>
                  ))}
                </select>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={isOwnerRow}
                  onClick={() => removeOrgMember(orgId, m.staffId)}
                  className="size-7"
                  title={
                    isOwnerRow ? "Owner cannot be removed" : "Remove from org"
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
        {currentMembers.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No members yet.
          </p>
        )}
      </div>
    </GateRank>
  );
}

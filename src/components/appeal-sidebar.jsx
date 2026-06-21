import { useMemo, useState } from "react";
import { Ban, MicOff } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { PinnedPlayerNotesSection } from "@/components/player-notes";
import { fmtNum, getPlayer, STATUS_LABEL } from "@/lib/mock-data";
import {
  deriveStats,
  pingTone,
  ServerHistorySection,
  OffensesTable,
  Field,
  TeammatesSection,
  AlertsSection,
  HitDistanceSection,
  FriendlyRecipientsSection,
  ChatLogSection,
} from "@/components/player-sidebar";
import { PlayerLinks } from "@/components/player-links";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LENGTH_OPTIONS } from "@/components/ban-dialog";
function buildModOffenses(stats) {
  return stats.offenses.map((o) => {
    const permanent = o.status === "Permanent";
    const expiresMatch = /Expires in (\d+)d/.exec(o.status);
    const active = permanent || !!expiresMatch;
    return {
      id: o.id,
      type: o.type,
      reason: o.reason,
      when: o.when,
      by: o.by,
      active,
      permanent,
      daysLeft: expiresMatch ? Number(expiresMatch[1]) : null,
    };
  });
}
function lengthLabel(id) {
  return LENGTH_OPTIONS.find((o) => o.id === id)?.label ?? id;
}
function statusText(o, ov) {
  if (ov?.lifted)
    return { label: `Lifted via appeal \xB7 ${ov.at}`, tone: "success" };
  if (ov?.newLength === "permanent")
    return { label: "Permanent (updated)", tone: "danger" };
  if (ov?.newLength)
    return { label: `${lengthLabel(ov.newLength)} (updated)`, tone: "warning" };
  if (!o.active) return { label: "Expired", tone: "muted" };
  if (o.permanent) return { label: "Permanent", tone: "danger" };
  return { label: `Expires in ${o.daysLeft}d`, tone: "warning" };
}
const TONE_CLASS = {
  danger: "text-danger bg-danger/10 ring-danger/30",
  warning: "text-warning bg-warning/10 ring-warning/30",
  muted: "text-muted-foreground bg-surface ring-border",
  success: "text-success bg-success/10 ring-success/30",
};
function ManageDialog({ kind, offenses, trigger }) {
  const [overrides, setOverrides] = useState({});
  const [drafts, setDrafts] = useState({});
  const list = useMemo(
    () =>
      offenses
        .filter((o) => o.type === kind)
        .sort((a, b) => Number(b.active) - Number(a.active)),
    [offenses, kind],
  );
  const now = "just now";
  const apply = (id) => {
    const v = drafts[id];
    if (!v) return;
    setOverrides((p) => ({ ...p, [id]: { newLength: v, at: now } }));
  };
  const lift = (id) =>
    setOverrides((p) => ({ ...p, [id]: { lifted: true, at: now } }));
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {kind === "Ban" ? "Manage Bans" : "Manage Mutes"}
          </DialogTitle>
          <DialogDescription>
            Adjust duration or lift {kind.toLowerCase()}s. Records remain in the
            system for audit.
          </DialogDescription>
        </DialogHeader>
        {list.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-6 text-center">
            No {kind.toLowerCase()}s on record.
          </p>
        ) : (
          <ul className="space-y-2 max-h-[60vh] overflow-y-auto">
            {list.map((o) => {
              const ov = overrides[o.id];
              const st = statusText(o, ov);
              const editable = o.active && !ov?.lifted;
              return (
                <li
                  key={o.id}
                  className="bg-surface/40 ring-1 ring-border rounded p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{o.reason}</p>
                      <p className="text-[10px] font-mono text-muted-foreground">
                        {o.when} · by {o.by}
                      </p>
                    </div>
                    <span
                      className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 shrink-0 ${TONE_CLASS[st.tone]}`}
                    >
                      {st.label}
                    </span>
                  </div>
                  {editable && (
                    <div className="flex items-center gap-2">
                      <Select
                        value={drafts[o.id] ?? ""}
                        onValueChange={(v) =>
                          setDrafts((p) => ({ ...p, [o.id]: v }))
                        }
                      >
                        <SelectTrigger className="h-8 text-xs flex-1">
                          <SelectValue placeholder="New duration" />
                        </SelectTrigger>
                        <SelectContent>
                          {LENGTH_OPTIONS.map((opt) => (
                            <SelectItem
                              key={opt.id}
                              value={opt.id}
                              className="text-xs"
                            >
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-8"
                        onClick={() => apply(o.id)}
                        disabled={!drafts[o.id]}
                      >
                        Apply
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-8"
                        onClick={() => lift(o.id)}
                      >
                        {kind === "Ban" ? "Unban" : "Unmute"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
function AppealModerationActions({ appellant }) {
  const stats = useMemo(() => deriveStats(appellant), [appellant]);
  const offenses = useMemo(() => buildModOffenses(stats), [stats]);
  const activeBans = offenses.filter(
    (o) => o.type === "Ban" && o.active,
  ).length;
  const activeMutes = offenses.filter(
    (o) => o.type === "Mute" && o.active,
  ).length;
  const btnClass =
    "inline-flex items-center gap-1.5 h-8 px-3 bg-surface text-foreground text-xs font-semibold rounded-md ring-1 ring-border hover:bg-surface-bright";
  return (
    <>
      <ManageDialog
        kind="Ban"
        offenses={offenses}
        trigger={
          <button type="button" className={btnClass}>
            <Ban className="size-3.5" />
            Manage Bans
            {activeBans > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {activeBans}
              </span>
            )}
          </button>
        }
      />
      <ManageDialog
        kind="Mute"
        offenses={offenses}
        trigger={
          <button type="button" className={btnClass}>
            <MicOff className="size-3.5" />
            Manage Mutes
            {activeMutes > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {activeMutes}
              </span>
            )}
          </button>
        }
      />
    </>
  );
}
function Avatar({ player, size = 48 }) {
  return (
    <div
      className="rounded ring-1 ring-black/40 grid place-items-center font-mono font-bold text-background shrink-0"
      style={{
        width: size,
        height: size,
        background: player.avatarColor,
        fontSize: size / 2.6,
      }}
    >
      {player.name
        .replace(/[\[\]]/g, "")
        .slice(0, 2)
        .toUpperCase()}
    </div>
  );
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const VIP_SERVERS = [
  "[EU] Main 5x Solo/Duo",
  "[NA] Vanilla Trio",
  "[EU] 2x Modded",
  "[NA] Hardcore Wipe",
  "[EU] Low Pop Chill",
  "[AS] 3x Quad",
];
const OXIDE_GROUPS = ["default", "vip", "mvp", "elite", "supporter", "legend"];
function buildPermissions(steamId) {
  const h = hash(steamId);
  const count = 2 + (h % 4);
  const out = [];
  const used = /* @__PURE__ */ new Set();
  for (let i = 0; i < count; i++) {
    let idx = (h + i * 17) % VIP_SERVERS.length;
    while (used.has(idx)) idx = (idx + 1) % VIP_SERVERS.length;
    used.add(idx);
    const seed = hash(steamId + ":perm:" + i);
    const groupCount = 1 + (seed % 3);
    const groups = ["default"];
    for (let g = 0; g < groupCount; g++) {
      const cand =
        OXIDE_GROUPS[1 + ((seed + g * 7) % (OXIDE_GROUPS.length - 1))];
      if (!groups.includes(cand)) groups.push(cand);
    }
    out.push({
      server: VIP_SERVERS[idx],
      daysAgo: seed % 30,
      hours: 2 + (seed % 80),
      groups,
    });
  }
  return out.sort((a, b) => a.daysAgo - b.daysAgo);
}
const GROUP_TONE = {
  default: "bg-surface text-muted-foreground ring-border",
  vip: "bg-brand/15 text-brand ring-brand/30",
  mvp: "bg-warning/15 text-warning ring-warning/30",
  elite: "bg-danger/15 text-danger ring-danger/30",
  supporter: "bg-success/15 text-success ring-success/30",
  legend: "bg-accent/15 text-accent ring-accent/30",
};
function InGamePermissionsSection({ steamId }) {
  const perms = buildPermissions(steamId);
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center justify-between">
        <span>In-Game Permissions · 30d</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {perms.length}
        </span>
      </h2>
      <ul className="space-y-2">
        {perms.map((p) => (
          <li
            key={p.server}
            className="bg-surface/40 ring-1 ring-border rounded px-2.5 py-2 space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium truncate min-w-0 flex-1">
                {p.server}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground shrink-0">
                {p.hours}h · {p.daysAgo === 0 ? "today" : `${p.daysAgo}d ago`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {p.groups.map((g) => (
                <span
                  key={g}
                  className={`text-[9px] font-mono uppercase font-bold tracking-wider px-1.5 py-0.5 rounded ring-1 ${GROUP_TONE[g] ?? GROUP_TONE.default}`}
                >
                  {g}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
function AppealSidebar({ ticket, team }) {
  const { selectedOrgIds, hasOrgPermission } = useAuth();
  const canSeeIp = selectedOrgIds.some((id) => hasOrgPermission(id, "ip_read"));
  const appellant = getPlayer(ticket.reporterId);
  const assignee = ticket.assigneeId ? ticket.assigneeId : "Unassigned";
  const isAppeal = ticket.type === "ban_appeal";
  const isVip = ticket.type === "vip_issue";
  const isSupport = ticket.type === "general_support";
  const submitterLabel = isAppeal ? "Appellant" : "Submitted by";
  const stats = isSupport || isAppeal ? deriveStats(appellant) : null;
  return (
    <aside className="w-[28rem] shrink-0 border-l border-border bg-background overflow-y-auto">
      <div className="p-6 space-y-8">
        {isVip ? (
          <section>
            <div className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Avatar player={appellant} size={48} />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold truncate">
                    {appellant.name}
                  </h3>
                  <p className="text-[10px] font-mono text-muted-foreground uppercase truncate flex items-center gap-1">
                    {appellant.steamId}
                    <PlayerLinks steamId={appellant.steamId} size="sm" />
                  </p>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {(isSupport || isAppeal) && stats ? (
          <section>
            <div className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
              <div className="flex items-center gap-3 mb-4">
                <Avatar player={appellant} size={48} />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold truncate">
                    {appellant.name}
                  </h3>
                  <p className="text-[10px] font-mono text-muted-foreground uppercase truncate flex items-center gap-1">
                    {appellant.steamId}
                    <PlayerLinks steamId={appellant.steamId} size="sm" />
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-y-3">
                <Field
                  label="S-Hours"
                  value={fmtNum(appellant.playtimeHours)}
                />
                <Field label="BM-Hours" value={fmtNum(stats.bmHours)} />
                <Field label="AT-Hours" value={fmtNum(stats.atHours)} />
                {isAppeal ? (
                  <Field label="K.D" value={stats.kd.toFixed(2)} />
                ) : null}
                {isAppeal ? (
                  <Field label="Hit %" value={`${stats.hitPct}%`} />
                ) : null}
                <Field
                  label="Proxy"
                  value={stats.proxy ? "True" : "False"}
                  tone={stats.proxy ? "danger" : "success"}
                />
                <div className="col-span-2">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Location
                  </p>
                  <p className="text-sm font-mono text-foreground flex items-center gap-1.5">
                    {canSeeIp ? appellant.country : "—"}
                    <span
                      className={`inline-block size-1.5 rounded-full ${pingTone(stats.pingMs).color}`}
                      title={`${stats.pingMs}ms ping`}
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {stats.pingMs}ms
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {!isVip && !isSupport && !isAppeal && (
          <section>
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4">
              Ticket Details
            </h2>

            <div className="space-y-2">
              <Row label="Ticket" value={`#${ticket.number}`} mono />
              <Row label="Status" value={STATUS_LABEL[ticket.status]} />
              <Row label="Submitted" value={ticket.createdLabel} />
              <Row label="Server" value={ticket.serverId ?? "\u2014"} mono />
              <Row label="Team" value={team} />
              <Row label="Assignee" value={assignee} />
            </div>
          </section>
        )}

        {!isVip && !isSupport && !isAppeal && (
          <section>
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3">
              Summary
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed bg-surface/40 ring-1 ring-border rounded p-3">
              {ticket.summary}
            </p>
          </section>
        )}

        {/* Moderation actions moved to ticket header */}

        {(isSupport || isAppeal) && stats && (
          <section>
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
              <span>Previous Offenses</span>
              <span className="font-mono normal-case tracking-normal text-muted-foreground">
                {stats.offenses.length}
              </span>
            </h2>
            {stats.offenses.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No prior offenses.
              </p>
            ) : (
              <OffensesTable offenses={stats.offenses} />
            )}
          </section>
        )}

        {isAppeal && <AlertsSection messages={ticket.messages ?? []} />}

        {isAppeal && <HitDistanceSection subjectId={appellant.steamId} />}

        {isAppeal && (
          <FriendlyRecipientsSection
            subjectId={appellant.steamId}
            serverId={ticket.serverId ?? null}
          />
        )}

        {(isSupport || isAppeal) && (
          <TeammatesSection
            subjectId={appellant.steamId}
            category={isAppeal ? "teaming" : void 0}
          />
        )}

        {isAppeal && (
          <ChatLogSection
            subjectId={appellant.steamId}
            ticketStatus={ticket.status}
          />
        )}

        {(isSupport || isAppeal) && (
          <ServerHistorySection
            subjectId={appellant.steamId}
            isOnline={appellant.lastSeen.startsWith("Now")}
          />
        )}

        {isVip && <InGamePermissionsSection steamId={appellant.steamId} />}

        {isVip && (
          <ServerHistorySection
            subjectId={appellant.steamId}
            isOnline={appellant.lastSeen.startsWith("Now")}
          />
        )}

        <PinnedPlayerNotesSection subjectId={appellant.steamId} />
      </div>
    </aside>
  );
}
function Row({ label, value, mono }) {
  return (
    <div className="flex justify-between text-xs py-1.5 border-b border-border">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "text-foreground font-mono" : "text-foreground"}>
        {value}
      </span>
    </div>
  );
}
export { AppealModerationActions, AppealSidebar };

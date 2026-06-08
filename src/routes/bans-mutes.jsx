import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ShieldAlert, ChevronDown, Edit3, X } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { useAuth, ORGS } from "@/lib/auth-context";
import {
  BAN_RECORDS,
  MUTE_RECORDS,
  BAN_LENGTH_LABEL,
  STAFF,
  SERVERS,
  getStaff
} from "@/lib/mock-data";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
const Route = createFileRoute("/bans-mutes")({
  head: () => ({ meta: [{ title: "Bans / Mutes \u2014 IronSight" }] }),
  component: BansMutesPage
});
const NOW = Date.parse("2026-05-26T12:00:00Z");
function fmtAgo(iso) {
  const d = NOW - Date.parse(iso);
  const m = Math.max(0, Math.floor(d / 6e4));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fmtRemaining(expiresAt, revoked) {
  if (revoked) return "Revoked";
  if (expiresAt === null) return "Permanent";
  const ms = Date.parse(expiresAt) - NOW;
  if (ms <= 0) return "Expired";
  const min = Math.floor(ms / 6e4);
  if (min < 60) return `${min}m left`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h left`;
  return `${Math.floor(h / 24)}d left`;
}
const BAN_TYPES = ["cheating", "teaming", "toxicity"];
const MUTE_TYPES = ["toxicity", "spam", "harassment", "mic_abuse"];
const LENGTH_KEYS = [
  "1h",
  "3h",
  "6h",
  "12h",
  "24h",
  "2d",
  "3d",
  "5d",
  "7d",
  "14d",
  "30d",
  "permanent"
];
function BansMutesPage() {
  const { selectedOrgIds, maxRankAcross } = useAuth();
  const canAccess = maxRankAcross(selectedOrgIds) >= 2;
  const [tab, setTab] = useState("bans");
  const [bans, setBans] = useState(BAN_RECORDS);
  const [mutes, setMutes] = useState(MUTE_RECORDS);
  const [query, setQuery] = useState("");
  const [staffFilter, setStaffFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const setTabAndReset = (t) => {
    setTab(t);
    setTypeFilter("all");
    setStaffFilter("all");
  };
  const rows = useMemo(() => {
    const orgSet = new Set(selectedOrgIds);
    const base = tab === "bans" ? bans : mutes;
    const q = query.trim().toLowerCase();
    return base.filter((r) => orgSet.has(r.orgId)).filter((r) => staffFilter === "all" ? true : r.staffId === staffFilter).filter((r) => typeFilter === "all" ? true : r.type === typeFilter).filter(
      (r) => q ? r.subjectName.toLowerCase().includes(q) || r.subjectSteamId.includes(q) || r.reason.toLowerCase().includes(q) : true
    ).sort((a, b) => +new Date(b.issuedAt) - +new Date(a.issuedAt));
  }, [tab, bans, mutes, query, staffFilter, typeFilter, selectedOrgIds]);
  const editingRecord = editing ? editing.kind === "bans" ? bans.find((b) => b.id === editing.id) : mutes.find((m) => m.id === editing.id) : null;
  const saveEdit = (patch) => {
    if (!editing || !editingRecord) return;
    const durMin = (key) => {
      const map = {
        "1h": 60,
        "3h": 180,
        "6h": 360,
        "12h": 720,
        "24h": 1440,
        "2d": 2880,
        "3d": 4320,
        "4d": 5760,
        "5d": 7200,
        "6d": 8640,
        "next_wipe": 60 * 24 * 5,
        "7d": 10080,
        "14d": 20160,
        "30d": 43200,
        "permanent": null
      };
      return map[key];
    };
    const newExpires = (() => {
      const d = durMin(patch.length);
      if (d === null) return null;
      return new Date(Date.parse(editingRecord.issuedAt) + d * 6e4).toISOString();
    })();
    if (editing.kind === "bans") {
      setBans(
        (cur) => cur.map(
          (b) => b.id === editing.id ? { ...b, length: patch.length, note: patch.note, reason: patch.reason, expiresAt: newExpires } : b
        )
      );
    } else {
      setMutes(
        (cur) => cur.map(
          (m) => m.id === editing.id ? { ...m, length: patch.length, note: patch.note, reason: patch.reason, expiresAt: newExpires } : m
        )
      );
    }
    setEditing(null);
  };
  const revoke = (kind, id) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (kind === "bans") {
      setBans((cur) => cur.map((b) => b.id === id ? { ...b, revoked: true, revokedAt: now } : b));
    } else {
      setMutes((cur) => cur.map((m) => m.id === id ? { ...m, revoked: true, revokedAt: now } : m));
    }
  };
  if (!canAccess) {
    return <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 grid place-items-center px-6">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="size-10 text-warning mx-auto" />
            <h1 className="text-lg font-semibold">Admin access required</h1>
            <p className="text-sm text-muted-foreground">
              Bans &amp; Mutes is restricted to Admin and above.
            </p>
          </div>
        </div>
      </div>;
  }
  const TYPES = tab === "bans" ? BAN_TYPES : MUTE_TYPES;
  return <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Bans / Mutes</h1>
              <p className="text-xs text-muted-foreground mt-1">
                Every active and historical {tab === "bans" ? "ban" : "mute"} for your selected orgs.
                Sorted by issued date.
              </p>
            </div>
            <div className="flex items-center gap-1 bg-surface/60 ring-1 ring-border rounded-md p-0.5">
              {["bans", "mutes"].map((t) => <button
    key={t}
    onClick={() => setTabAndReset(t)}
    className={"px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors " + (tab === t ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground")}
  >
                  {t}
                </button>)}
            </div>
          </div>

          {
    /* Filters */
  }
          <div className="flex items-center gap-2 flex-wrap">
            <Input
    placeholder="Search name / Steam ID / reason…"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
    className="h-9 max-w-xs"
  />
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground ml-auto">
              {rows.length} records
            </div>
          </div>

          {
    /* Table */
  }
          <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
            <div className="grid grid-cols-[minmax(180px,1.6fr)_120px_110px_110px_120px_130px_140px_140px] gap-2 px-3 py-2 border-b border-border text-[10px] font-mono uppercase tracking-widest text-muted-foreground sticky top-0 bg-surface/80 backdrop-blur">
              <div>Subject</div>
              <Popover>
                <PopoverTrigger asChild>
                  <button className={"inline-flex items-center gap-1 hover:text-foreground text-left " + (typeFilter !== "all" ? "text-brand" : "")}>
                    Type {typeFilter !== "all" && <span className="normal-case tracking-normal">· {typeFilter}</span>}
                    <ChevronDown className="size-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-44 p-1">
                  <button onClick={() => setTypeFilter("all")} className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-surface normal-case tracking-normal">
                    Any type
                  </button>
                  {TYPES.map((t) => <button key={t} onClick={() => setTypeFilter(t)} className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-surface capitalize normal-case tracking-normal">
                      {t.replace("_", " ")}
                    </button>)}
                </PopoverContent>
              </Popover>
              <div>Reason</div>
              <div>Length</div>
              <div>Status</div>
              <Popover>
                <PopoverTrigger asChild>
                  <button className={"inline-flex items-center gap-1 hover:text-foreground text-left " + (staffFilter !== "all" ? "text-brand" : "")}>
                    Staff {staffFilter !== "all" && <span className="normal-case tracking-normal truncate max-w-[70px]">· {getStaff(staffFilter)?.name}</span>}
                    <ChevronDown className="size-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-60 p-1 max-h-72 overflow-y-auto">
                  <button onClick={() => setStaffFilter("all")} className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-surface normal-case tracking-normal">
                    Any staff
                  </button>
                  {STAFF.map((s) => <button key={s.id} onClick={() => setStaffFilter(s.id)} className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-surface flex items-center justify-between normal-case tracking-normal">
                      <span>{s.name}</span>
                      <span className="text-[9px] font-mono text-muted-foreground">{s.role}</span>
                    </button>)}
                </PopoverContent>
              </Popover>
              <div>Issued</div>
              <div className="text-right">Actions</div>
            </div>
            <div className="divide-y divide-border/60">
              {rows.map((r) => {
    const staff = getStaff(r.staffId);
    const org = ORGS.find((o) => o.id === r.orgId);
    const srv = SERVERS.find((s) => s.id === r.serverId);
    return <div
      key={r.id}
      className="grid grid-cols-[minmax(180px,1.6fr)_120px_110px_110px_120px_130px_140px_140px] gap-2 px-3 py-2 items-center text-xs hover:bg-surface/60"
    >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{r.subjectName}</div>
                      <div className="text-[10px] font-mono text-muted-foreground truncate">
                        {r.subjectSteamId} · {org?.short}{srv ? ` \xB7 ${srv.name.replace(/^\[[^\]]+\]\s*/, "")}` : ""}
                      </div>
                    </div>
                    <div>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 ring-border bg-surface capitalize">
                        {r.type.replace("_", " ")}
                      </span>
                    </div>
                    <div className="truncate text-muted-foreground" title={r.reason}>{r.reason}</div>
                    <div className="font-mono text-[10px]">{BAN_LENGTH_LABEL[r.length]}</div>
                    <div>
                      <span
      className={"px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ring-1 " + (r.revoked ? "bg-muted text-muted-foreground ring-border" : r.expiresAt === null ? "bg-danger/15 text-danger ring-danger/40" : Date.parse(r.expiresAt) <= NOW ? "bg-surface text-muted-foreground ring-border" : "bg-warning/15 text-warning ring-warning/40")}
    >
                        {fmtRemaining(r.expiresAt, r.revoked)}
                      </span>
                    </div>
                    <div className="truncate">{staff?.name ?? "\u2014"}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{fmtAgo(r.issuedAt)}</div>
                    <div className="flex items-center justify-end gap-1">
                      <button
      onClick={() => setEditing({ kind: tab, id: r.id })}
      className="size-7 inline-flex items-center justify-center rounded ring-1 ring-border hover:bg-surface"
      title="View / edit"
    >
                        <Edit3 className="size-3" />
                      </button>
                      {!r.revoked && <button
      onClick={() => revoke(tab, r.id)}
      className="size-7 inline-flex items-center justify-center rounded ring-1 ring-danger/40 text-danger hover:bg-danger/10"
      title="Revoke"
    >
                          <X className="size-3" />
                        </button>}
                    </div>
                  </div>;
  })}
              {rows.length === 0 && <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                  No records match your filters.
                </div>}
            </div>
          </div>
        </div>
      </div>

      <EditDialog
    record={editingRecord ?? null}
    kind={editing?.kind ?? "bans"}
    onClose={() => setEditing(null)}
    onSave={saveEdit}
  />
    </div>;
}
function EditDialog({
  record,
  kind,
  onClose,
  onSave
}) {
  const [length, setLength] = useState(record?.length ?? "24h");
  const [note, setNote] = useState(record?.note ?? "");
  const [reason, setReason] = useState(record?.reason ?? "");
  useMemoInit(record, () => {
    setLength(record?.length ?? "24h");
    setNote(record?.note ?? "");
    setReason(record?.reason ?? "");
  });
  if (!record) return null;
  return <Dialog open={!!record} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Edit {kind === "bans" ? "ban" : "mute"} — {record.subjectName}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px]">
            {record.subjectSteamId} · issued {fmtAgo(record.issuedAt)} by {getStaff(record.staffId)?.name ?? "\u2014"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Reason</label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Length</label>
            <Select value={length} onValueChange={(v) => setLength(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LENGTH_KEYS.map((k) => <SelectItem key={k} value={k}>{BAN_LENGTH_LABEL[k]}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Currently: {fmtRemaining(record.expiresAt, record.revoked)}
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Note</label>
            <Textarea
    value={note}
    onChange={(e) => setNote(e.target.value)}
    rows={6}
    className="font-mono text-xs"
  />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ length, note, reason })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
}
function useMemoInit(key, fn) {
  useEffect(() => {
    fn();
  }, [key]);
}
export {
  Route
};

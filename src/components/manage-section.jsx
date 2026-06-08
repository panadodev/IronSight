import { ShieldAlert } from "lucide-react";
function SectionHeader({ title, blurb }) {
  return <div className="space-y-1">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{blurb}</p>
    </div>;
}
function GateRank({
  rank,
  required,
  children
}) {
  if (rank < required) {
    return <div className="rounded-lg ring-1 ring-border bg-surface/40 p-8 text-center space-y-2">
        <ShieldAlert className="size-8 mx-auto text-warning" />
        <h2 className="text-base font-semibold">Insufficient permissions</h2>
        <p className="text-sm text-muted-foreground">
          You need a higher rank in this organization to access this section.
        </p>
      </div>;
  }
  return <div className="space-y-4">{children}</div>;
}
export {
  GateRank,
  SectionHeader
};

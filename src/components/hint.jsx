import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHintsEnabled } from "@/lib/hints-store";

// Shared descriptions for commonly abbreviated/unclear data points, so hints
// stay consistent wherever a given metric is shown. Reference these via the
// `HINTS` map (e.g. <Hint text={HINTS.bmHours}>…</Hint>) rather than retyping.
export const HINTS = {
  steamHours:
    "Total hours this player has played Rust according to their Steam profile. Private profiles show no value.",
  bmHours:
    "Hours BattleMetrics has tracked this player across servers it monitors. Often lower than Steam hours since it only counts BM-tracked time.",
  atHours:
    "Hours spent on aim-training servers (servers with 'aim' or 'ukn' in the name, e.g. UKN.aim).",
  kd: "Kill/death ratio from tracked PvP activity.",
  proxy:
    "Whether the player's connection looks like a VPN, proxy, or hosting/datacenter IP (a common evasion signal).",
  ping: "Most recent measured latency between the player and the server.",
  banEvasion:
    "This ban was created automatically because the player connected from an IP that has an active IP ban.",
  ipBan:
    "Bans the IP address itself. Anyone who later connects from this IP is automatically given a linked ban record.",
  steamVisibility:
    "Steam profile visibility: Public = anyone can view; Friends Only = only Steam friends; Private = only the player themselves. Affects what data Steam exposes.",
  bmVisibility:
    "BattleMetrics profile privacy flag. When private, BM hides server history and player data from its public API.",
  bmAutoSync:
    "When on, every new ban is mirrored to BattleMetrics as a record-only ban (no identifiers attached), so it shows in your BM ban history without BattleMetrics also banning the player.",
};

// Wraps content with a hover tooltip describing it. When the user has hints
// disabled (Profile → Enable Hints), the children render untouched with no
// tooltip and no extra DOM behaviour. Each instance carries its own
// TooltipProvider so callers don't need a root-level provider.
function Hint({ text, children, side = "top", asChild = true, className }) {
  const enabled = useHintsEnabled();
  if (!enabled || !text) return children;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild={asChild} className={className}>
          {children}
        </TooltipTrigger>
        <TooltipContent side={side} className="max-w-xs text-xs leading-snug">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { Hint };

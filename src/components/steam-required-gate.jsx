import { useAuth } from "@/lib/auth-context";
import { Link } from "@tanstack/react-router";

export function SteamRequiredGate({ children }) {
  const { sessionUser, orgsLoaded } = useAuth();

  // Still loading bootstrap
  if (!orgsLoaded) return null;

  if (!sessionUser?.steamId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[300px] gap-4 p-8 text-center">
        <div className="size-12 rounded-full bg-[#66c0f4]/10 ring-1 ring-[#66c0f4]/30 grid place-items-center">
          <span className="text-[#66c0f4] font-mono font-bold text-sm">S</span>
        </div>
        <div className="space-y-1.5 max-w-sm">
          <h2 className="text-base font-semibold">Steam account required</h2>
          <p className="text-sm text-muted-foreground">
            Moderation features require your Steam account to be linked. This
            lets the panel verify your in-game identity and attribute actions
            correctly.
          </p>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <a
            href="/api/auth/steam/start"
            className="px-4 py-2 bg-[#171a21] hover:bg-[#1f242d] ring-1 ring-border text-white rounded text-sm font-semibold flex items-center gap-2 transition-colors"
          >
            <span className="font-mono text-xs uppercase tracking-widest text-[#66c0f4]">
              Steam
            </span>
            Link Steam account
          </a>
          <Link
            to="/"
            className="px-4 py-2 ring-1 ring-border bg-surface rounded text-sm text-muted-foreground hover:bg-surface/80 transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return children;
}

// Headless visual check for the text-size scaling / navbar-exclusion work.
// Renders a faithful mock of the real sidebar + a content page using the
// ACTUAL compiled Tailwind CSS (dist/client/assets/*.css), then screenshots it
// at each text-size setting. No DB/Redis/OAuth needed.
//
// Run:  node scripts/preview/nav-preview.mjs
import { chromium } from "playwright";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const cssDir = join(root, "dist", "client", "assets");
const cssFile = readdirSync(cssDir).find(
  (f) => f.startsWith("styles-") && f.endsWith(".css"),
);
if (!cssFile)
  throw new Error("Compiled CSS not found — run `npm run build` first.");
const css = readFileSync(join(cssDir, cssFile), "utf8");
const outDir = join(__dirname, "out");
mkdirSync(outDir, { recursive: true });

// A small square stands in for a lucide icon (size-3.5 etc. drive its box).
const icon = (cls = "size-3.5") =>
  `<span class="${cls} shrink-0 inline-block bg-current rounded-[2px] opacity-70"></span>`;

const navLink = (label, active = false) => `
  <a class="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs ${
    active ? "bg-brand/15 text-brand" : "text-muted-foreground"
  }">${icon()}<span class="truncate">${label}</span></a>`;

// A dense player-list-style row: the kind of small text (formerly text-[10px] /
// text-[9px], now rem) that should now grow with the text size.
const listRow = (name, id, sus, susCls) => `
  <div class="grid grid-cols-[minmax(160px,1fr)_90px_60px_70px] gap-2 items-center px-3 py-2 text-xs border-b border-border/60">
    <div class="min-w-0">
      <div class="font-medium truncate">${name}</div>
      <div class="text-[0.625rem] font-mono text-muted-foreground truncate">${id}</div>
    </div>
    <div class="text-[0.625rem] font-mono text-muted-foreground truncate">EU Main</div>
    <div class="text-right"><span class="px-1.5 py-0.5 rounded text-[0.625rem] font-mono font-bold ring-1 ${susCls}">${sus}</span></div>
    <div class="text-right"><span class="px-1.5 py-0.5 rounded text-[0.625rem] font-mono font-bold ring-1 bg-surface ring-border text-muted-foreground">NO</span></div>
  </div>`;

const field = (label, value, tone = "text-foreground") => `
  <div>
    <p class="text-xs text-muted-foreground uppercase w-fit">${label}</p>
    <p class="text-base font-mono ${tone}">${value}</p>
  </div>`;

const body = `
  <!-- Desktop sidebar (real classes) -->
  <aside id="sidebar" class="nav-no-scale fixed inset-y-0 left-0 z-30 w-56 border-r border-border bg-background hidden md:flex flex-col">
    <div class="h-14 px-4 flex items-center gap-2 border-b border-border shrink-0">
      <span class="size-7 rounded bg-brand/80 shrink-0"></span>
      <span class="font-bold text-sm">IronSight</span>
    </div>
    <div class="flex-1 overflow-y-auto p-2 space-y-4">
      <div class="space-y-1">
        <p class="px-2.5 text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground/60">Support</p>
        ${navLink("Tickets", true)}
        ${navLink("My Reports")}
        ${navLink("Player Lookup")}
      </div>
      <div class="space-y-1">
        <p class="px-2.5 text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground/60">Moderation</p>
        ${navLink("Chat")}
        ${navLink("Server Logs")}
        ${navLink("Discord Mod")}
      </div>
    </div>
    <div class="p-2 border-t border-border">
      <button class="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface/60 ring-1 ring-border rounded-md">
        <span class="size-2 bg-success rounded-full shrink-0"></span>
        <span class="text-xs font-mono truncate flex-1 text-left">staffmember</span>
        <span class="text-[0.625rem] font-bold text-brand uppercase tracking-widest">LIVE</span>
      </button>
    </div>
  </aside>

  <!-- Page content (scales with text size) -->
  <main class="min-h-screen">
    <div class="max-w-4xl mx-auto p-6 space-y-6">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <span class="size-[72px] rounded bg-brand/70 shrink-0"></span>
          <div>
            <h2 class="text-xl font-semibold">SaltyBandit</h2>
            <p class="text-xs font-mono text-muted-foreground">7656119800000000</p>
          </div>
        </div>
        <button class="flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs font-semibold uppercase tracking-widest bg-danger text-danger-foreground">
          ${icon()} Ban
        </button>
      </div>

      <div class="bg-surface/60 ring-1 ring-border rounded-lg p-5 space-y-4">
        <p class="text-[0.625rem] font-mono uppercase tracking-[0.2em] text-muted-foreground/50">Steam</p>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-y-4 gap-x-6">
          ${field("Rust Hours", "1,284")}
          ${field("Acct Age", "6y 2mo")}
          ${field("Visibility", "Public", "text-success")}
          ${field("VAC / Game", "None")}
          ${field("Last Ban", "—")}
        </div>
      </div>

      <p class="text-sm text-muted-foreground">
        Body copy at text-sm — this is the sort of paragraph text that appears in
        tickets and notes across the panel. It should grow with the selected text
        size while the sidebar on the left stays exactly the same size.
      </p>

      <div class="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
        <div class="grid grid-cols-[minmax(160px,1fr)_90px_60px_70px] gap-2 px-3 py-2 border-b border-border text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground bg-surface/60">
          <div>Player</div><div>Server</div><div class="text-right">Sus</div><div class="text-right">Proxy</div>
        </div>
        ${listRow("SaltyBandit", "76561198000000001", "88", "bg-danger/15 text-danger ring-danger/40")}
        ${listRow("gg_ez_clan", "76561198000000002", "42", "bg-warning/15 text-warning ring-warning/40")}
        ${listRow("QuietMember", "76561198000000003", "3", "bg-surface text-muted-foreground ring-border")}
      </div>
    </div>
  </main>`;

const html = (size) => `<!doctype html>
<html lang="en"${size ? ` data-text-size="${size}"` : ""}>
<head><meta charset="utf-8"><style>${css}</style></head>
<body>${body}</body>
</html>`;

const shots = [
  { name: "1-small-default", size: null, fix: true },
  { name: "2-large-FIXED", size: "large", fix: true },
  { name: "3-large-NO-FIX", size: "large", fix: false },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

for (const shot of shots) {
  await page.setContent(html(shot.size), { waitUntil: "networkidle" });
  // Optionally strip the fix to demonstrate the original ballooning problem.
  if (!shot.fix) {
    await page.evaluate(() =>
      document.getElementById("sidebar")?.classList.remove("nav-no-scale"),
    );
  }
  await page.screenshot({ path: join(outDir, `${shot.name}.png`) });
  console.log("wrote", `${shot.name}.png`);
}

await browser.close();
console.log("done →", outDir);

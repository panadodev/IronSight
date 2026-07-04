// Headless check for the profile dialog overflow at large text size.
// Reproduces the dialog (header + long scrolling body + pinned footer) using the
// real compiled CSS, at data-text-size="large", with and without the fix.
// Run: node scripts/preview/dialog-preview.mjs
import { chromium } from "playwright";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssDir = join(__dirname, "..", "..", "dist", "client", "assets");
const cssFile = readdirSync(cssDir).find(
  (f) => f.startsWith("styles-") && f.endsWith(".css"),
);
if (!cssFile)
  throw new Error("Compiled CSS not found — run `npm run build` first.");
const css = readFileSync(join(cssDir, cssFile), "utf8");
const outDir = join(__dirname, "out");
mkdirSync(outDir, { recursive: true });

const section = (label, hint) => `
  <div class="space-y-1.5">
    <label class="text-sm font-medium">${label}</label>
    <div class="h-9 rounded-md ring-1 ring-border bg-surface/60"></div>
    <p class="text-xs text-muted-foreground">${hint}</p>
  </div>`;

// contentCls / bodyCls differ between the fixed and broken variants.
const dialog = (contentCls, bodyCls) => `
  <div class="fixed inset-0 z-50 bg-black/80"></div>
  <div class="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-background p-6 shadow-lg sm:rounded-lg ${contentCls}">
    <div class="flex flex-col space-y-1.5 text-left">
      <h2 class="text-lg font-semibold leading-none tracking-tight">Profile</h2>
      <p class="text-sm text-muted-foreground">Manage your support system identity, linked accounts, and preferences.</p>
    </div>
    <div class="space-y-5 py-2 ${bodyCls}">
      ${section("Demo view", "Toggle between the public site and the staff panel.")}
      ${section("Text size", "Scale text across the panel for easier reading.")}
      ${section("Signed in as", "Your current staff session.")}
      ${section("Display name", "How your name appears to players and other staff.")}
      ${section("Timezone", "Timestamps throughout the panel display in this zone.")}
      ${section("Hints", "Show explanatory tooltips when hovering data.")}
      ${section("Privacy", "Stop other staff from looking up your profile.")}
      ${section("Linked accounts", "Steam and Discord accounts on this profile.")}
    </div>
    <div class="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
      <button class="inline-flex items-center justify-center rounded-md h-9 px-4 text-sm font-medium text-muted-foreground">Cancel</button>
      <button class="inline-flex items-center justify-center rounded-md h-9 px-4 text-sm font-medium bg-brand text-brand-foreground">Save changes</button>
    </div>
  </div>`;

const page = (bodyHtml) => `<!doctype html>
<html lang="en" data-text-size="large">
<head><meta charset="utf-8"><style>${css}</style></head>
<body class="bg-background">${bodyHtml}</body>
</html>`;

const shots = [
  // Before: old base dialog (grid, no height cap) — footer overflows off-screen.
  { name: "dialog-large-BROKEN", content: "grid", body: "" },
  // After (new base): plain grid dialog now capped + scrollable — footer reachable.
  {
    name: "dialog-large-BASE",
    content: "grid max-h-[90dvh] overflow-y-auto",
    body: "",
  },
  // After (profile usage-site): flex column with pinned footer.
  {
    name: "dialog-large-FIXED",
    content: "flex flex-col max-h-[90dvh]",
    body: "flex-1 min-h-0 overflow-y-auto",
  },
];

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 900, height: 720 } });
for (const s of shots) {
  await p.setContent(page(dialog(s.content, s.body)), {
    waitUntil: "networkidle",
  });
  await p.screenshot({ path: join(outDir, `${s.name}.png`) });
  console.log("wrote", `${s.name}.png`);
}
await browser.close();
console.log("done →", outDir);

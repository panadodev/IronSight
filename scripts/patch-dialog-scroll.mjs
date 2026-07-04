// Per-usage-site patch: cap DialogContent / PopoverContent to the viewport and
// make them scroll, so tall dialogs / long popovers keep their footer/items
// reachable at the larger accessibility text sizes. Base ui/ components are left
// untouched (excluded below). Idempotent: tags that already set max-h are skipped.
//
// Run: node scripts/patch-dialog-scroll.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const UI_DIR = join("components", "ui"); // never touch generated primitives
const DIALOG_ADD = "max-h-[90dvh] overflow-y-auto";
const POPOVER_ADD =
  "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if ([".jsx", ".tsx"].includes(extname(p))) out.push(p);
  }
  return out;
}

// Add `add` classes to an opening tag's attribute string. Appends to an existing
// className="..." literal, or inserts a new className when none is present.
function inject(tag, attrs, comp, add) {
  if (/max-h-/.test(attrs)) return tag; // already capped
  if (/className="/.test(attrs)) {
    return tag.replace(/className="([^"]*)"/, `className="$1 ${add}"`);
  }
  return `<${comp} className="${add}"${attrs}>`;
}

let files = 0;
const counts = { DialogContent: 0, PopoverContent: 0 };
for (const file of walk(SRC)) {
  if (file.includes(sep + UI_DIR + sep)) continue;
  const src = readFileSync(file, "utf8");
  let next = src;
  for (const [comp, add] of [
    ["DialogContent", DIALOG_ADD],
    ["PopoverContent", POPOVER_ADD],
  ]) {
    const re = new RegExp(`<${comp}\\b([^>]*)>`, "g");
    next = next.replace(re, (tag, attrs) => {
      const out = inject(tag, attrs, comp, add);
      if (out !== tag) counts[comp]++;
      return out;
    });
  }
  if (next !== src) {
    writeFileSync(file, next);
    files++;
  }
}
console.log(`Patched ${files} files`);
console.log(counts);

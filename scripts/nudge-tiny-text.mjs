// One-shot: nudge up the genuinely-tiny font sizes for readability. Operates on
// the rem tokens produced by px-to-rem.mjs. Raises the floor so nothing renders
// below ~9px, and lifts the large 9px tier to the 10px label baseline. Leaves
// 10px (0.625rem) and 11px (0.6875rem) untouched to avoid disturbing dense
// layouts (tables, chips). Single pass so mappings don't cascade.
//
// Run: node scripts/nudge-tiny-text.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SRC = join(process.cwd(), "src");
const MAP = {
  "0.4375rem": "0.5625rem", // 7px  -> 9px
  "0.5rem": "0.5625rem", // 8px  -> 9px
  "0.5625rem": "0.625rem", // 9px  -> 10px
};
const re = /text-\[(0\.4375rem|0\.5rem|0\.5625rem)\]/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if ([".jsx", ".tsx", ".js", ".ts"].includes(extname(p))) out.push(p);
  }
  return out;
}

let files = 0;
let total = 0;
const per = {};
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");
  const next = src.replace(re, (_m, tok) => {
    per[tok] = (per[tok] || 0) + 1;
    total++;
    return `text-[${MAP[tok]}]`;
  });
  if (next !== src) {
    writeFileSync(file, next);
    files++;
  }
}
console.log(`Nudged ${total} occurrences across ${files} files`);
console.log("By source token:", per);

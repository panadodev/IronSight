// One-shot: convert fixed-pixel Tailwind font-size utilities (text-[Npx]) to
// their rem equivalents so they scale with the accessibility text-size setting.
// rem values are computed against the 16px root, so rendering at the default
// text size is byte-for-byte identical — only the scaled settings differ.
//
// Idempotent (rem tokens are left alone). Run: node scripts/px-to-rem.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SRC = join(process.cwd(), "src");
const px2rem = (px) => `${px / 16}rem`;

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
const perSize = {};
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");
  // Only match text-[<int>px]; leave any other arbitrary value untouched.
  const next = src.replace(/text-\[(\d+)px\]/g, (_m, n) => {
    const px = Number(n);
    perSize[px] = (perSize[px] || 0) + 1;
    total++;
    return `text-[${px2rem(px)}]`;
  });
  if (next !== src) {
    writeFileSync(file, next);
    files++;
  }
}
console.log(`Converted ${total} occurrences across ${files} files`);
console.log("By px size:", perSize);

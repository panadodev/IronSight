// Pure HTTP/request helpers shared across the backend. No DB/Redis/env deps.

export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function parseLimit(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

export function getClientIp(request) {
  // Prefer the edge-provided client IP (Cloudflare), which a client cannot
  // forge. Fall back to the right-most x-forwarded-for hop (closest to our
  // edge) rather than the left-most, which is fully client-controlled.
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return "unknown";
}

// Normalizes an IP into the scope used for session IP pinning. IPv4 pins on
// the exact address; IPv6 pins on the /64 prefix because clients on the same
// connection routinely rotate the low 64 bits (privacy extensions), which
// would otherwise revoke the session on every rotation. Returns null when the
// IP is unknown/unparseable — callers must treat that as "no information",
// not as a mismatch.
export function ipPinScope(ip) {
  if (!ip || typeof ip !== "string") return null;
  let value = ip.trim().toLowerCase();
  if (!value || value === "unknown") return null;
  // Strip brackets ("[::1]:443" style) and any zone index ("fe80::1%eth0").
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    value = value.slice(1, end);
  }
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(":")) return value; // IPv4 → exact address
  // IPv4-mapped IPv6 ("::ffff:203.0.113.9") → pin on the IPv4 address so it
  // matches the same client arriving as plain IPv4.
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  // Expand "::" and pin on the first four hextets (/64).
  const halves = value.split("::");
  if (halves.length > 2) return null;
  let hextets;
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    hextets = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    hextets = value.split(":");
  }
  if (hextets.length !== 8 || hextets.some((h) => !/^[0-9a-f]{1,4}$/.test(h)))
    return null;
  const prefix = hextets
    .slice(0, 4)
    .map((h) => h.padStart(4, "0"))
    .join(":");
  return `${prefix}::/64`;
}

export function parseMaybeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  const str = String(value).trim();
  if (!str) return [];
  if (str.startsWith("[") && str.endsWith("]")) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) return arr.filter(Boolean).map(String);
    } catch {
      // fall back to csv
    }
  }
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

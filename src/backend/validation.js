// Pure, dependency-free request-validation helpers shared by api.js handlers.
// Deliberately side-effect free (no DB, Redis, or env access) so they can be
// unit-tested in isolation. See src/backend/validation.test.js.

// SteamID64 for individual accounts: 17 digits beginning with 765611.
export const STEAM_ID_RE = /^765611\d{11}$/;

// SteamID64s reported through the public ticket flow — stricter form used by
// handleCreateTicket (the 7th digit is always 9 for individual accounts).
const REPORTED_STEAM_ID_RE = /^7656119\d{10}$/;

export function isValidSteamId(steamId) {
  return STEAM_ID_RE.test(String(steamId));
}

// Prevents open redirects after auth: only allow same-site absolute paths
// (must start with a single "/", never "//host").
export function sanitizeNext(nextValue, fallback = "/todo") {
  const next = String(nextValue ?? fallback).trim();
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}

// Normalizes a client-supplied structured-fields array for ticket creation:
// each entry becomes { label, value } with trimmed strings, empty values are
// dropped, and both count and lengths are capped (public endpoint). Returns
// null when the payload is malformed enough to reject outright (non-array,
// or any entry over the hard length caps) so the handler can 400 instead of
// silently truncating user-entered evidence.
export function sanitizeTicketFields(
  value,
  { maxFields = 20, maxLabel = 120, maxValue = 10000 } = {},
) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > maxFields) return null;
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const label = String(entry.label ?? "").trim();
    const fieldValue = String(entry.value ?? "").trim();
    if (label.length > maxLabel || fieldValue.length > maxValue) return null;
    if (!label || !fieldValue) continue;
    out.push({ label, value: fieldValue });
  }
  return out;
}

// Normalizes a client-supplied reportedPlayers array: bounds the work before
// validating (public endpoint), trims, keeps only valid SteamID64s, and caps
// the result.
export function sanitizeReportedPlayers(
  value,
  { max = 10, scanLimit = 50 } = {},
) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, scanLimit)
    .map((s) => String(s).trim())
    .filter((s) => REPORTED_STEAM_ID_RE.test(s))
    .slice(0, max);
}

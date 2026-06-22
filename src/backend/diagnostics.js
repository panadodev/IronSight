// In-memory API diagnostics ring buffers (incoming/outgoing/error samples,
// capped at DIAG_MAX). Read by the sysadmin metrics endpoint; written by the
// request wrapper and external-fetch layer. No backend deps.

const DIAG_MAX = 1000;
export const diagIncoming = []; // { ts, method, route, status, ms, isIngest }
export const diagOutgoing = []; // { ts, service, host, status, ms }
export const diagErrors = []; // non-2xx from either direction (same shape + direction)

function diagPush(arr, entry) {
  arr.push(entry);
  if (arr.length > DIAG_MAX) arr.shift();
}

// Normalise a raw pathname to a stable route pattern for grouping.
function diagRoute(pathname) {
  return (
    pathname
      // UUIDs
      .replace(
        /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "/:uuid",
      )
      // Steam IDs (17-digit numbers) and other long numeric IDs
      .replace(/\/\d{10,}/g, "/:id")
      // Short numeric IDs (ticket IDs, etc.)
      .replace(/\/\d+/g, "/:id")
      // Likely opaque org/server slugs after known path segments
      .replace(/(\/orgs\/)([^/]+)/, "$1:orgId")
      .replace(/(\/servers\/)([^/]+)/, "$1:serverId")
      .replace(/(\/players\/)([^/]+)/, "$1:playerId")
      .replace(/(\/tickets\/)([^/]+)/, "$1:ticketId")
      .replace(/(\/roles\/)([^/]+)/, "$1:roleId")
      .replace(/(\/staff\/)([^/]+)/, "$1:userId")
  );
}

export function diagRecordIncoming(method, pathname, status, ms) {
  const isIngest =
    pathname.startsWith("/api/ingest/") ||
    pathname === "/api/server-health-check" ||
    pathname.startsWith("/api/internal/");
  const route = diagRoute(pathname);
  const entry = { ts: Date.now(), method, route, status, ms, isIngest };
  diagPush(diagIncoming, entry);
  if (status < 200 || status >= 300) {
    diagPush(diagErrors, { ...entry, direction: "incoming" });
  }
}

export function diagRecordOutgoing(
  service,
  url,
  status,
  ms,
  { expected = false } = {},
) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url.slice(0, 60);
  }
  const entry = { ts: Date.now(), service, host, status, ms };
  diagPush(diagOutgoing, entry);
  if (!expected && (status < 200 || status >= 300)) {
    diagPush(diagErrors, { ...entry, direction: "outgoing" });
  }
}

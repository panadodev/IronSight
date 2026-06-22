// External API fetch layer: per-org key rotation, rate-limit handling, and
// Steam concurrency throttling for BattleMetrics / Steam / Proxycheck.

import { pool, redis } from "./runtime.js";
import { decryptExternalApiKey } from "./crypto-keys.js";
import { diagRecordOutgoing } from "./diagnostics.js";

// ── External API key helpers (BM / Steam / Proxycheck) ───────────────────────

export async function getAvailableExternalKeys(orgId, service) {
  const { rows } = await pool.query(
    `SELECT key_id, key_encrypted
     FROM org_external_api_keys
     WHERE org_id = $1
       AND service = $2
       AND enabled = TRUE
       AND (rate_limited_until IS NULL OR rate_limited_until < unix_now())
     ORDER BY priority DESC, last_used_at ASC NULLS FIRST`,
    [orgId, service],
  );
  const keys = [];
  for (const r of rows) {
    try {
      keys.push({
        keyId: String(r.key_id),
        key: decryptExternalApiKey(String(r.key_encrypted)),
      });
    } catch {
      console.warn(
        `[ext-api] key ${r.key_id} for org ${orgId}/${service} failed to decrypt, skipping`,
      );
    }
  }
  return keys;
}

async function markExternalKeyRateLimited(keyId, retryAfterSeconds) {
  const secs = Math.min(Math.max(Number(retryAfterSeconds) || 60, 1), 7200);
  await pool.query(
    `UPDATE org_external_api_keys
     SET rate_limited_until = unix_now() + $1
     WHERE key_id = $2`,
    [secs, keyId],
  );
}

async function markExternalKeyUsed(keyId) {
  await pool.query(
    `UPDATE org_external_api_keys SET last_used_at = unix_now() WHERE key_id = $1`,
    [keyId],
  );
}

async function recordRateLimitStats(keyId, orgId, service, resp) {
  const limitHdr = resp.headers.get("X-Rate-Limit-Limit");
  const remainingHdr = resp.headers.get("X-Rate-Limit-Remaining");
  const bucketHour = Math.floor(Date.now() / 1000 / 3600) * 3600;

  if (!limitHdr || !remainingHdr) {
    // Steam doesn't return rate-limit headers; track call count only so the
    // frontend can display "X / 100,000 calls today".
    if (service !== "steam") return;
    await pool.query(
      `INSERT INTO org_external_api_key_stats
         (key_id, bucket_hour, org_id, service, rate_limit_max, rate_limit_min_remaining)
       VALUES ($1, $2, $3, $4, NULL, NULL)
       ON CONFLICT (key_id, bucket_hour) DO UPDATE SET
         sample_count = org_external_api_key_stats.sample_count + 1`,
      [keyId, bucketHour, orgId, service],
    );
    return;
  }

  const rateMax = parseInt(limitHdr, 10);
  const remaining = parseInt(remainingHdr, 10);
  if (isNaN(rateMax) || isNaN(remaining) || rateMax <= 0) return;
  await pool.query(
    `INSERT INTO org_external_api_key_stats
       (key_id, bucket_hour, org_id, service, rate_limit_max, rate_limit_min_remaining)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (key_id, bucket_hour) DO UPDATE SET
       rate_limit_max = EXCLUDED.rate_limit_max,
       rate_limit_min_remaining = LEAST(
         org_external_api_key_stats.rate_limit_min_remaining,
         EXCLUDED.rate_limit_min_remaining
       ),
       sample_count = org_external_api_key_stats.sample_count + 1`,
    [keyId, bucketHour, orgId, service, rateMax, remaining],
  );
}

// Tries each available key in priority order; returns Response or null if all fail
async function externalFetchWithRotation(
  orgId,
  service,
  buildRequest,
  { privacyAware = false } = {},
) {
  const keys = await getAvailableExternalKeys(orgId, service);
  if (!keys.length) {
    console.warn(
      `[ext-api:${service}] org=${orgId} — no available keys (all disabled or rate-limited)`,
    );
    return null;
  }

  for (const { keyId, key } of keys) {
    const { url, options } = buildRequest(key);
    let resp;
    const t0ext = Date.now();
    try {
      resp = await fetch(url, options ?? {});
    } catch (err) {
      console.warn(
        `[ext-api:${service}] key=${keyId} network error: ${err.message}`,
      );
      diagRecordOutgoing(service, url, 0, Date.now() - t0ext);
      continue;
    }

    diagRecordOutgoing(service, url, resp.status, Date.now() - t0ext, {
      expected: service === "steam" && resp.status === 403,
    });

    if (resp.status === 429) {
      const retryAfter = parseFloat(resp.headers.get("Retry-After") ?? "60");
      await markExternalKeyRateLimited(keyId, retryAfter);
      console.warn(
        `[ext-api:${service}] key=${keyId} rate-limited (${retryAfter}s), trying next`,
      );
      continue;
    }

    // Auth failures. Steam returns 401 (GetFriendList) or 403 (GetUserGroupList,
    // and invalid keys) for a PRIVATE target profile just as it does for a bad
    // key — we cannot reliably tell them apart from the status alone.
    const isAuthFailure =
      resp.status === 401 || (service === "steam" && resp.status === 403);
    if (isAuthFailure) {
      let body = "";
      try {
        body = await resp.text();
      } catch {}
      // Privacy-dependent Steam endpoints (friend/group list) 401/403 when the
      // TARGET profile is private — not when the key is bad. Every key sees the
      // same private profile, so rotating just burns the rest of the org's keys
      // for nothing (and spams "all keys exhausted"). Mark this key healthy and
      // return immediately; the caller records the profile as private.
      if (privacyAware && service === "steam") {
        await markExternalKeyUsed(keyId);
        console.log(
          `[ext-api:steam] key=${keyId} org=${orgId} HTTP ${resp.status} — target profile private, returning without rotating.`,
        );
        return resp;
      }
      // Non-privacy Steam calls: a 401/403 means the key is likely invalid, so
      // rotate to the next key — but never disable (a false-positive disable is
      // worse than an extra retry). Other services: a 401 is a definitively bad
      // key, so disable it for 1h.
      if (service === "steam") {
        console.warn(
          `[ext-api:steam] key=${keyId} org=${orgId} HTTP ${resp.status} — rotating to next key (key may be invalid). body="${body.slice(0, 200)}"`,
        );
      } else {
        console.warn(
          `[ext-api:${service}] key=${keyId} org=${orgId} rejected with HTTP 401 — key is invalid or revoked. body="${body.slice(0, 300)}". Disabling for 1h.`,
        );
        markExternalKeyRateLimited(keyId, 3600).catch(() => {});
      }
      continue;
    }

    await markExternalKeyUsed(keyId);
    recordRateLimitStats(keyId, orgId, service, resp).catch((e) =>
      console.warn(`[ext-api:${service}] stats write failed: ${e.message}`),
    );
    return resp;
  }

  console.warn(
    `[ext-api:${service}] org=${orgId} — all ${keys.length} key(s) exhausted, returning null`,
  );
  return null;
}

export async function bmFetch(orgId, url, opts = {}) {
  return externalFetchWithRotation(orgId, "battlemetrics", (key) => ({
    url,
    options: {
      ...opts,
      headers: { Authorization: `Bearer ${key}`, ...(opts.headers ?? {}) },
    },
  }));
}

// Simple in-process concurrency gate: at most `max` wrapped calls run at once,
// the rest queue. Used to keep concurrent Steam Web API requests under the rate
// limit when a single refresh enriches many related accounts at once.
function createConcurrencyLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

const STEAM_API_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.STEAM_API_MAX_CONCURRENCY ?? 4),
);
const steamApiLimiter = createConcurrencyLimiter(STEAM_API_MAX_CONCURRENCY);

export async function steamApiFetch(orgId, path, params = {}, opts = {}) {
  // Gate all Steam calls through a shared concurrency limiter so a burst of
  // alt-enrichment lookups can't trip Steam's per-key rate limit (429).
  return steamApiLimiter(() =>
    externalFetchWithRotation(
      orgId,
      "steam",
      (key) => {
        const u = new URL(`https://api.steampowered.com${path}`);
        u.searchParams.set("key", key);
        for (const [k, v] of Object.entries(params))
          u.searchParams.set(k, String(v));
        console.log(
          `[steam] org=${orgId} path=${path} key_len=${key.length} key_prefix=${key.slice(0, 4)}`,
        );
        return { url: u.toString(), options: {} };
      },
      { privacyAware: opts.privacyAware === true },
    ),
  );
}

const VALID_IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[\da-fA-F:]+$/;

export async function proxycheckApiFetch(orgId, ipList) {
  const list = Array.isArray(ipList) ? ipList : [String(ipList)];
  const validIps = list.filter((ip) => VALID_IP_RE.test(String(ip).trim()));
  if (!validIps.length) return null;
  const ips = validIps.join(",");
  return externalFetchWithRotation(orgId, "proxycheck", (key) => ({
    url: `https://proxycheck.io/v2/${ips}?key=${encodeURIComponent(key)}&vpn=1&asn=1`,
    options: {},
  }));
}

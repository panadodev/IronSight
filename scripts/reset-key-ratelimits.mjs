// Clears bogus `rate_limited_until` flags on external API keys.
//
// The old externalFetchWithRotation disabled a Steam key for 1h whenever a
// looked-up profile was private (GetFriendList returns 401 for private
// profiles, which was misread as an invalid key). That left orgs with
// "no available keys (all disabled or rate-limited)" until the timer expired.
// The rotation bug is fixed, but already-disabled keys need a one-time reset.
//
// Usage:  node scripts/reset-key-ratelimits.mjs [service]
//   service defaults to "steam"; pass "all" to clear every service.

import { Client } from "pg";

function chooseUrl(primary, secondary) {
  const first = primary?.trim();
  const second = secondary?.trim();
  if (first && second) {
    const isLocal = (u) => /localhost|127\.0\.0\.1|\[::1\]|::1/i.test(u);
    if (isLocal(first) && !isLocal(second)) return second;
  }
  return first || second;
}

const pgUrl = chooseUrl(process.env.DATABASE_URL, process.env.POSTGRESQL_URI);
if (!pgUrl) {
  console.error("[reset-keys] No DATABASE_URL or POSTGRESQL_URI provided");
  process.exit(1);
}

const service = (process.argv[2] ?? "steam").toLowerCase();
const pg = new Client({
  connectionString: pgUrl,
  connectionTimeoutMillis: 5000,
});

try {
  await pg.connect();

  const where = service === "all" ? "" : "WHERE service = $1";
  const params = service === "all" ? [] : [service];

  const before = await pg.query(
    `SELECT org_id, service, label, enabled, rate_limited_until,
            (rate_limited_until IS NOT NULL AND rate_limited_until > EXTRACT(EPOCH FROM NOW())) AS currently_blocked
     FROM org_external_api_keys ${where}
     ORDER BY org_id, service`,
    params,
  );

  console.log(
    `[reset-keys] ${before.rows.length} key(s) for service="${service}":`,
  );
  for (const r of before.rows) {
    console.log(
      `  org=${r.org_id} service=${r.service} label="${r.label ?? ""}" ` +
        `enabled=${r.enabled} blocked=${r.currently_blocked}`,
    );
  }

  const res = await pg.query(
    `UPDATE org_external_api_keys SET rate_limited_until = NULL
     ${where ? where : ""}`,
    params,
  );
  console.log(
    `[reset-keys] Cleared rate_limited_until on ${res.rowCount} key(s).`,
  );

  const stillDisabled = before.rows.filter((r) => !r.enabled);
  if (stillDisabled.length) {
    console.log(
      `[reset-keys] Note: ${stillDisabled.length} key(s) are enabled=FALSE ` +
        `(disabled in the UI, not by rate limiting) and were NOT touched.`,
    );
  }
} catch (err) {
  console.error("[reset-keys] failed:", err.message);
  process.exit(1);
} finally {
  await pg.end().catch(() => {});
}

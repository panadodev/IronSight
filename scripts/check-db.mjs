import { Client } from "pg";
import Redis from "ioredis";

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
const redisUrl = chooseUrl(process.env.REDIS_URL, process.env.REDIS_URI);

if (!pgUrl) {
  console.error(
    "[check-db] No DATABASE_URL or POSTGRESQL_URI build arg provided",
  );
  process.exit(1);
}
if (!redisUrl) {
  console.error("[check-db] No REDIS_URL or REDIS_URI build arg provided");
  process.exit(1);
}

const pg = new Client({
  connectionString: pgUrl,
  connectionTimeoutMillis: 5000,
});
try {
  await pg.connect();
  await pg.query("SELECT 1");
  console.log("[check-db] PostgreSQL: reachable");
} catch (err) {
  console.error("[check-db] PostgreSQL unreachable:", err.message);
  process.exit(1);
} finally {
  await pg.end().catch(() => {});
}

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 0,
  enableReadyCheck: false,
  connectTimeout: 5000,
});

// Suppress the unhandled-error event that ioredis emits on connection failure
// before the ping() promise rejects.
redis.on("error", () => {});

try {
  await redis.ping();
  console.log("[check-db] Redis: reachable");
} catch (err) {
  console.error("[check-db] Redis unreachable:", err.message);
  process.exit(1);
} finally {
  redis.disconnect();
}

console.log("[check-db] All dependencies reachable.");

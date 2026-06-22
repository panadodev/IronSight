// Shared request-handling core: server-key authentication and Redis rate
// limiting. Depends only on the runtime singletons and pure http helpers.

import crypto from "node:crypto";
import { pool, redis } from "./runtime.js";
import { json } from "./http.js";

// Generic Redis sliding-window-ish limiter. Returns a 429 response when the
// caller exceeds `limit` actions within `windowSeconds`, otherwise null.
// Fails open (returns null) if Redis is unavailable, matching rateLimitLogin.
export async function checkRateLimit(
  key,
  limit,
  windowSeconds = 60,
  message = "Too many requests. Slow down.",
) {
  if (!redis) return null;
  try {
    const n = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      1,
      key,
      String(windowSeconds),
    );
    if (n > limit) {
      return json({ error: message }, 429);
    }
  } catch {
    return null;
  }
  return null;
}

// Authenticates a game-server plugin request by its API key (Authorization:
// Bearer <key> or x-api-key header). Returns { server } on success, or
// { error } (a ready-to-return Response) on failure. `server` always contains
// server_id, server_name and owner_org_id. `logTag`, when given, logs rejected
// attempts (e.g. "ingest:chat") matching the previous per-handler logging.
export async function authenticateServerKey(request, logTag) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKeyRaw = (
    bearerMatch ? bearerMatch[1] : (request.headers.get("x-api-key") ?? "")
  ).trim();
  if (!apiKeyRaw) {
    if (logTag) console.log(`[${logTag}] rejected — missing API key`);
    return {
      error: json(
        {
          error:
            "Missing API key (x-api-key header or Authorization: Bearer <key>)",
        },
        401,
      ),
    };
  }

  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKeyRaw)
    .digest("hex");
  const serverRes = await pool.query(
    "SELECT server_id, server_name, owner_org_id FROM servers WHERE api_key_hash = $1 LIMIT 1",
    [apiKeyHash],
  );
  if (!serverRes.rows[0]) {
    if (logTag) console.log(`[${logTag}] rejected — invalid API key`);
    return { error: json({ error: "Invalid API key" }, 401) };
  }
  return { server: serverRes.rows[0] };
}

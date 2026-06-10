/**
 * Shared in-memory cache for /api/auth/me.
 *
 * Both the root beforeLoad guard and SiteNav previously fired independent
 * fetch() calls on every navigation, serialising them and adding ~2 s of
 * latency. This module deduplicates them: the first caller fetches, all
 * subsequent callers within TTL_MS receive the same resolved value.
 */

let _promise = null;
let _result = null;
let _fetchedAt = 0;

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 2500;

/**
 * Returns a promise that resolves to { status: number, user: object|null }.
 * Within TTL_MS the cached value is returned without a new network request.
 */
export function getAuthMe() {
  const now = Date.now();

  // Cache hit
  if (_result !== null && now - _fetchedAt < TTL_MS) {
    return Promise.resolve(_result);
  }

  // Deduplicate in-flight request
  if (_promise) return _promise;

  _promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch("/api/auth/me", {
        credentials: "include",
        signal: controller.signal,
      });

      const user = res.ok
        ? ((await res.json().catch(() => null))?.user ?? null)
        : null;

      _result = { status: res.status, user };
      _fetchedAt = Date.now();
      return _result;
    } catch {
      // Do not cache errors so the next call retries immediately.
      // If we have stale data, prefer it over a hard failure to keep navigation responsive.
      return _result ?? { status: 0, user: null };
    } finally {
      clearTimeout(timeout);
      _promise = null;
    }
  })();

  return _promise;
}

/** Evict the cache (call after login, logout, or a PATCH to the profile). */
export function invalidateAuthMe() {
  _promise = null;
  _result = null;
  _fetchedAt = 0;
}

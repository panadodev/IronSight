import { createServerFn } from "@tanstack/react-start";

/**
 * Server-side auth probe for the root route guard.
 *
 * The client uses `getAuthMe()` (a cached relative fetch), which can't run
 * during SSR. Without a server-side check the SSR pass renders the full
 * protected page (e.g. the staff "Active Queue") and ships it to the browser,
 * which paints it for a frame before the client-side guard fetches
 * `/api/auth/me`, gets a 401, and redirects to `/support` — a visible flash.
 *
 * This runs the same `/api/auth/me` check in-process during SSR (reusing all
 * session validation in `handleApiRequest`) so unauthenticated visitors get a
 * redirect before any protected HTML is streamed. Returns the HTTP status.
 *
 * Both `getRequest` and `handleApiRequest` are imported dynamically inside the
 * handler so this server-only code never enters the client bundle.
 */
export const fetchAuthStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const { handleApiRequest } = await import("@/backend/api");

    const req = getRequest();
    const url = new URL("/api/auth/me", req.url);
    // Forward the client-IP headers along with the cookie: getSession pins
    // sessions to the login IP, and a synthetic request without these headers
    // resolves to getClientIp() === "unknown", which would read as an IP
    // mismatch and revoke the session on the first SSR page load after login.
    const headers = new Headers({ cookie: req.headers.get("cookie") ?? "" });
    for (const name of ["cf-connecting-ip", "x-forwarded-for"]) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }
    const apiReq = new Request(url, { headers });

    try {
      const res = await handleApiRequest(apiReq);
      return { status: res.status };
    } catch {
      // Fail open: if the in-process auth check errors, don't block SSR.
      // The client-side guard still runs as a backstop.
      return { status: 0 };
    }
  },
);

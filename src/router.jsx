import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Don't treat data as stale the moment it arrives. 1-minute window
        // prevents refetches on every mount and window-focus event.
        staleTime: 60_000,
        // Refetching on window focus is rarely useful in an internal panel
        // and adds latency every time the user alt-tabs back.
        refetchOnWindowFocus: false,
      },
    },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // 0 meant preloaded data was immediately stale, so navigating to a
    // preloaded route always triggered a fresh fetch anyway (no benefit).
    // 30 s gives preloading a real chance to save time.
    defaultPreloadStaleTime: 30_000,
  });
  return router;
};
export { getRouter };

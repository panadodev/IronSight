import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

export const PTERO_PLUGINS_KEY = "ptero-plugins";

async function fetchPteroPlugins(serverId) {
  const r = await fetch(`/api/servers/${serverId}/ptero-plugins`, {
    credentials: "include",
  });
  if (!r.ok) {
    let errMsg;
    try {
      const d = await r.json();
      errMsg = d.error ?? `HTTP ${r.status}`;
    } catch {
      errMsg = `HTTP ${r.status}`;
    }
    throw new Error(errMsg);
  }
  return r.json();
}

/**
 * Cached fetch of a server's Oxide plugins and their live RCON status.
 *
 * Backed by TanStack Query (60s staleTime) so switching between servers or
 * remounting the tab is served from cache instead of re-hitting Pterodactyl +
 * RCON. Mutations on the page (reload/unload, config save, bulk upload/delete)
 * call `invalidate` / `invalidateAll` to auto-refresh the list.
 */
export function usePteroPlugins(serverId) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: [PTERO_PLUGINS_KEY, serverId],
    queryFn: () => fetchPteroPlugins(serverId),
    enabled: Boolean(serverId),
    staleTime: 60_000,
  });

  // Refetch just this server — used after a plugin on it is modified
  // (reload/unload command, config save).
  const invalidate = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: [PTERO_PLUGINS_KEY, serverId],
      }),
    [queryClient, serverId],
  );

  // Refetch every cached server's plugin list — used after bulk operations
  // that span multiple servers (upload, delete-from-servers).
  const invalidateAll = useCallback(
    () => queryClient.invalidateQueries({ queryKey: [PTERO_PLUGINS_KEY] }),
    [queryClient],
  );

  return {
    plugins: query.data?.plugins ?? [],
    rconAvailable: query.data?.rconAvailable ?? null,
    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error ? String(query.error.message ?? query.error) : null,
    refresh: query.refetch,
    invalidate,
    invalidateAll,
  };
}

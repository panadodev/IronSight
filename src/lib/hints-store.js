import { useSyncExternalStore } from "react";

// Whether contextual hover hints (tooltips explaining data like BM/Steam hours)
// are shown across the panel. Enabled by default; persisted per-browser in
// localStorage. Follows the same module-level + useSyncExternalStore pattern as
// the other client preference stores (see manage-org-store.js / timezone-store.js).
const KEY = "iron_hints_enabled_v1";

function load() {
  if (typeof localStorage === "undefined") return true;
  const raw = localStorage.getItem(KEY);
  // Default ON: only an explicit "0" disables hints.
  return raw !== "0";
}

let value = load();
const listeners = new Set();

const hintsStore = {
  get: () => value,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  set(enabled) {
    value = !!enabled;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(KEY, value ? "1" : "0");
    }
    for (const l of listeners) l();
  },
};

function useHintsEnabled() {
  return useSyncExternalStore(hintsStore.subscribe, hintsStore.get, () => true);
}

export { hintsStore, useHintsEnabled };

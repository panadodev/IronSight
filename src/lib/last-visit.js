import { useSyncExternalStore } from "react";
const KEY = "iron_last_visit_v1";
function load() {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}
let map = load();
const listeners = /* @__PURE__ */ new Set();
function persist() {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, JSON.stringify(map));
  }
  for (const l of listeners) l();
}
const lastVisitStore = {
  get: () => map,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  mark(path) {
    map = { ...map, [path]: Date.now() };
    persist();
  }
};
function useLastVisits() {
  return useSyncExternalStore(
    lastVisitStore.subscribe,
    lastVisitStore.get,
    lastVisitStore.get
  );
}
export {
  lastVisitStore,
  useLastVisits
};

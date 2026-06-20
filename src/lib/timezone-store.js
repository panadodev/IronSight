import { useSyncExternalStore } from "react";
const KEY = "iron_timezone_v1";
function load() {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(KEY) ?? "";
}
let value = load();
const listeners = new Set();
const timezoneStore = {
  get: () => value,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  set(tz) {
    value = tz ?? "";
    if (typeof localStorage !== "undefined") {
      if (tz) localStorage.setItem(KEY, tz);
      else localStorage.removeItem(KEY);
    }
    for (const l of listeners) l();
  },
};
function useTimezone() {
  return useSyncExternalStore(
    timezoneStore.subscribe,
    timezoneStore.get,
    () => "",
  );
}
export { timezoneStore, useTimezone };

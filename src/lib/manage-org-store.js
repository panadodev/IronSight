import { useSyncExternalStore } from "react";
const KEY = "iron_manage_org_v1";
function load() {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY);
}
let value = load();
const listeners = /* @__PURE__ */ new Set();
const manageOrgStore = {
  get: () => value,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  set(orgId) {
    value = orgId;
    if (typeof localStorage !== "undefined") {
      if (orgId) localStorage.setItem(KEY, orgId);
      else localStorage.removeItem(KEY);
    }
    for (const l of listeners) l();
  }
};
function useManageOrgId() {
  return useSyncExternalStore(
    manageOrgStore.subscribe,
    manageOrgStore.get,
    () => null
  );
}
export {
  manageOrgStore,
  useManageOrgId
};

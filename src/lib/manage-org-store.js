import { useSyncExternalStore } from "react";
const KEY_PREFIX = "iron_manage_org_v2_";
let activeKey = null;
let value = null;
const listeners = /* @__PURE__ */ new Set();
const manageOrgStore = {
  get: () => value,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  init(userId) {
    activeKey = KEY_PREFIX + String(userId);
    value =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(activeKey)
        : null;
    for (const l of listeners) l();
  },
  clear() {
    activeKey = null;
    value = null;
    for (const l of listeners) l();
  },
  set(orgId) {
    value = orgId;
    if (typeof localStorage !== "undefined" && activeKey) {
      if (orgId) localStorage.setItem(activeKey, orgId);
      else localStorage.removeItem(activeKey);
    }
    for (const l of listeners) l();
  },
};
function useManageOrgId() {
  return useSyncExternalStore(
    manageOrgStore.subscribe,
    manageOrgStore.get,
    () => null,
  );
}
export { manageOrgStore, useManageOrgId };

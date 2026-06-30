import { useSyncExternalStore } from "react";

const KEY_PREFIX = "iron_player_history_v1_";
let activeKey = null;
let history = [];
const listeners = /* @__PURE__ */ new Set();

const playerSearchHistory = {
  get: () => history,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  init(userId) {
    activeKey = KEY_PREFIX + String(userId);
    try {
      const raw =
        typeof localStorage !== "undefined"
          ? localStorage.getItem(activeKey)
          : null;
      history = raw ? JSON.parse(raw) : [];
    } catch {
      history = [];
    }
    for (const l of listeners) l();
  },
  clear() {
    activeKey = null;
    history = [];
    for (const l of listeners) l();
  },
  push(entry) {
    // entry: { steamId, displayName, avatarUrl }
    const filtered = history.filter((e) => e.steamId !== entry.steamId);
    history = [
      { ...entry, searchedAt: Math.floor(Date.now() / 1000) },
      ...filtered,
    ].slice(0, 10);
    if (typeof localStorage !== "undefined" && activeKey) {
      localStorage.setItem(activeKey, JSON.stringify(history));
    }
    for (const l of listeners) l();
  },
};

function usePlayerSearchHistory() {
  return useSyncExternalStore(
    playerSearchHistory.subscribe,
    playerSearchHistory.get,
    () => [],
  );
}

export { playerSearchHistory, usePlayerSearchHistory };

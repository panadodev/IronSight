import { useCallback, useSyncExternalStore } from "react";

// Generic localStorage-backed UI preference store.
// Mirrors the useSyncExternalStore pattern used by timezone-store / manage-org-store,
// but keyed so any number of small display toggles can persist without a store each.
// Values are JSON-serialized, so booleans / strings / numbers / small objects all work.

const PREFIX = "iron_pref_";
const cache = new Map();
const listeners = new Set();

function storageKey(key) {
  return PREFIX + key;
}

function readRaw(key, fallback) {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(storageKey(key));
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getSnapshot(key, fallback) {
  if (cache.has(key)) return cache.get(key);
  const v = readRaw(key, fallback);
  cache.set(key, v);
  return v;
}

function emit() {
  for (const l of listeners) l();
}

function onStorage(e) {
  if (!e.key || !e.key.startsWith(PREFIX)) return;
  cache.delete(e.key.slice(PREFIX.length));
  emit();
}

function subscribe(fn) {
  listeners.add(fn);
  if (typeof window !== "undefined" && listeners.size === 1) {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined" && listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function setPref(key, value) {
  cache.set(key, value);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(storageKey(key), JSON.stringify(value));
    } catch {
      /* quota / disabled storage — keep in-memory value */
    }
  }
  emit();
}

// useState-compatible hook whose value persists in localStorage and stays in
// sync across tabs and across every component reading the same key.
function usePersistentState(key, fallback) {
  const value = useSyncExternalStore(
    subscribe,
    () => getSnapshot(key, fallback),
    () => fallback,
  );
  const setValue = useCallback(
    (next) => {
      const resolved =
        typeof next === "function" ? next(getSnapshot(key, fallback)) : next;
      setPref(key, resolved);
    },
    [key, fallback],
  );
  return [value, setValue];
}

export { usePersistentState, setPref };

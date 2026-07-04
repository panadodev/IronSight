import { useSyncExternalStore } from "react";

// Accessibility text scaling across the panel. Persisted per-browser in
// localStorage and applied by setting a `data-text-size` attribute on the
// document root; CSS in styles.css scales the root font-size, so every
// rem-based text/spacing utility grows proportionally. Follows the same
// module-level + useSyncExternalStore pattern as the other client preference
// stores (see hints-store.js / timezone-store.js).
const KEY = "iron_text_size_v1";
const SIZES = ["small", "normal", "large"];
// "small" is the default (no scaling / old compact density). Larger text is
// opt-in: users pick "normal" or "large" in the profile dialog to scale the
// whole panel up for comfortable reading and larger tap targets.
const DEFAULT = "small";

function normalize(raw) {
  return SIZES.includes(raw) ? raw : DEFAULT;
}

function apply(size) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-text-size", size);
}

function load() {
  if (typeof localStorage === "undefined") return DEFAULT;
  return normalize(localStorage.getItem(KEY));
}

let value = load();
const listeners = new Set();

// Apply the persisted preference as soon as this module is imported so the
// panel renders at the chosen size without waiting for the profile dialog.
apply(value);

const textSizeStore = {
  get: () => value,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  set(size) {
    value = normalize(size);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(KEY, value);
    }
    apply(value);
    for (const l of listeners) l();
  },
};

function useTextSize() {
  return useSyncExternalStore(
    textSizeStore.subscribe,
    textSizeStore.get,
    () => DEFAULT,
  );
}

export { textSizeStore, useTextSize, SIZES as TEXT_SIZES };

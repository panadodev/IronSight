import { useSyncExternalStore } from "react";
const SEED = [
  {
    id: "pn_seed_1",
    subjectId: "76561198000000123",
    body: "Has appealed twice \u2014 keep an eye on chat behavior when re-joining.",
    authorId: "u_zedge",
    authorName: "Zedge",
    createdAt: "2026-05-20T14:00:00Z",
    minRank: 2,
    pinned: true
  }
];
let state = SEED;
const listeners = /* @__PURE__ */ new Set();
const emit = () => listeners.forEach((l) => l());
const playerNotesStore = {
  get: () => state,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  add(input) {
    state = [
      {
        ...input,
        id: `pn_${Math.random().toString(36).slice(2, 9)}`,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      ...state
    ];
    emit();
  },
  update(id, patch) {
    state = state.map((n) => n.id === id ? { ...n, ...patch } : n);
    emit();
  },
  remove(id) {
    state = state.filter((n) => n.id !== id);
    emit();
  }
};
function usePlayerNotes(subjectId) {
  const all = useSyncExternalStore(playerNotesStore.subscribe, playerNotesStore.get, playerNotesStore.get);
  if (!subjectId) return [];
  return all.filter((n) => n.subjectId === subjectId);
}
const NOTE_RANK_OPTIONS = [
  { value: 1, label: "Support and above" },
  { value: 2, label: "Admin and above" },
  { value: 3, label: "Sr. Admin and above" },
  { value: 4, label: "Management only" }
];
function rankLabel(rank) {
  return NOTE_RANK_OPTIONS.find((o) => o.value === rank)?.label ?? `Rank ${rank}+`;
}
function timeAgo(iso) {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 6e4);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}
export {
  NOTE_RANK_OPTIONS,
  playerNotesStore,
  rankLabel,
  timeAgo,
  usePlayerNotes
};

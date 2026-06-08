import { useSyncExternalStore } from "react";
let state = [];
let boardMembers = {};
const listeners = /* @__PURE__ */ new Set();
function emit() {
  for (const l of listeners) l();
}
const todoStore = {
  get: () => state,
  getBoardMembers: () => boardMembers,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  add(card) {
    const c = {
      ...card,
      id: `td_${Math.random().toString(36).slice(2, 9)}`,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      status: card.status ?? "todo"
    };
    state = [c, ...state];
    emit();
  },
  update(id, patch) {
    state = state.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, ...patch };
      if (patch.status === "completed" && !next.completedAt) {
        next.completedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
      if (patch.status && patch.status !== "completed") {
        next.completedAt = void 0;
      }
      return next;
    });
    emit();
  },
  remove(id) {
    state = state.filter((c) => c.id !== id);
    emit();
  },
  addBoardMember(orgId, staffId) {
    const cur = boardMembers[orgId] ?? [];
    if (cur.includes(staffId)) return;
    boardMembers = { ...boardMembers, [orgId]: [...cur, staffId] };
    emit();
  },
  removeBoardMember(orgId, staffId) {
    const cur = boardMembers[orgId] ?? [];
    boardMembers = { ...boardMembers, [orgId]: cur.filter((id) => id !== staffId) };
    emit();
  }
};
function useTodos() {
  return useSyncExternalStore(
    todoStore.subscribe,
    todoStore.get,
    todoStore.get
  );
}
function useBoardMembers() {
  return useSyncExternalStore(
    todoStore.subscribe,
    todoStore.getBoardMembers,
    todoStore.getBoardMembers
  );
}
const PRIORITY_META = {
  1: { label: "P1 \xB7 Urgent", color: "bg-danger/15 text-danger ring-danger/40" },
  2: { label: "P2 \xB7 Normal", color: "bg-warning/15 text-warning ring-warning/40" },
  3: { label: "P3 \xB7 Low", color: "bg-surface text-muted-foreground ring-border" }
};
export {
    PRIORITY_META,
    todoStore,
    useBoardMembers,
    useTodos
};


import { useSyncExternalStore } from "react";
let articles = [];
let categories = [];
const listeners = /* @__PURE__ */ new Set();
const emit = () => listeners.forEach((l) => l());
const snap = () => ({ articles, categories });
let snapRef = snap();
const refreshSnap = () => {
  snapRef = snap();
};
const docsStore = {
  get: () => snapRef,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  addCategory(input) {
    const c = {
      id: `cat_${Math.random().toString(36).slice(2, 9)}`,
      ...input,
      name: input.name.trim(),
    };
    if (!c.name) return null;
    categories = [...categories, c];
    refreshSnap();
    emit();
    return c;
  },
  renameCategory(id, name) {
    const n = name.trim();
    if (!n) return;
    categories = categories.map((c) => (c.id === id ? { ...c, name: n } : c));
    refreshSnap();
    emit();
  },
  removeCategory(id) {
    categories = categories
      .filter((c) => c.id !== id)
      .map((c) => (c.parentId === id ? { ...c, parentId: null } : c));
    articles = articles.map((a) =>
      a.categoryId === id ? { ...a, categoryId: null } : a,
    );
    refreshSnap();
    emit();
  },
  addArticle(input) {
    const a = {
      id: `doc_${Math.random().toString(36).slice(2, 9)}`,
      orgId: input.orgId,
      categoryId: input.categoryId,
      title: input.title.trim() || "Untitled",
      body: input.body,
      minRank: input.minRank,
      updatedAt: /* @__PURE__ */ new Date().toISOString(),
      updatedByName: input.authorName,
      versions: [],
    };
    articles = [a, ...articles];
    refreshSnap();
    emit();
    return a;
  },
  saveArticle(id, patch, editor) {
    articles = articles.map((a) => {
      if (a.id !== id) return a;
      const v = {
        id: `dv_${Math.random().toString(36).slice(2, 9)}`,
        title: a.title,
        body: a.body,
        savedAt: a.updatedAt,
        savedById: editor.id,
        savedByName: a.updatedByName,
      };
      return {
        ...a,
        title: patch.title?.trim() || a.title,
        body: patch.body ?? a.body,
        minRank: patch.minRank ?? a.minRank,
        categoryId:
          patch.categoryId !== void 0 ? patch.categoryId : a.categoryId,
        updatedAt: /* @__PURE__ */ new Date().toISOString(),
        updatedByName: editor.name,
        versions: [v, ...a.versions],
      };
    });
    refreshSnap();
    emit();
  },
  restoreVersion(id, versionId, editor) {
    articles = articles.map((a) => {
      if (a.id !== id) return a;
      const v = a.versions.find((x) => x.id === versionId);
      if (!v) return a;
      const cur = {
        id: `dv_${Math.random().toString(36).slice(2, 9)}`,
        title: a.title,
        body: a.body,
        savedAt: a.updatedAt,
        savedById: editor.id,
        savedByName: a.updatedByName,
      };
      return {
        ...a,
        title: v.title,
        body: v.body,
        updatedAt: /* @__PURE__ */ new Date().toISOString(),
        updatedByName: editor.name,
        versions: [cur, ...a.versions],
      };
    });
    refreshSnap();
    emit();
  },
  deleteVersion(articleId, versionId) {
    articles = articles.map((a) =>
      a.id === articleId
        ? { ...a, versions: a.versions.filter((v) => v.id !== versionId) }
        : a,
    );
    refreshSnap();
    emit();
  },
  deleteArticle(id) {
    articles = articles.filter((a) => a.id !== id);
    refreshSnap();
    emit();
  },
};
function useDocs() {
  return useSyncExternalStore(
    docsStore.subscribe,
    docsStore.get,
    docsStore.get,
  );
}
const DOC_RANK_OPTIONS = [
  { value: 1, label: "Support and above" },
  { value: 2, label: "Admin and above" },
  { value: 3, label: "Sr. Admin and above" },
  { value: 4, label: "Management only" },
];
function docRankLabel(r) {
  return DOC_RANK_OPTIONS.find((o) => o.value === r)?.label ?? `Rank ${r}+`;
}
export { DOC_RANK_OPTIONS, docRankLabel, docsStore, useDocs };

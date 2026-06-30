import { useSyncExternalStore } from "react";

let articles = [];
let categories = [];
let roles = [];
let loadedOrgId = null;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
const snap = () => ({ articles, categories, roles, loadedOrgId });
let snapRef = snap();
const refreshSnap = () => {
  snapRef = snap();
};

export const docsStore = {
  get: () => snapRef,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  async load(orgId) {
    if (!orgId) return;
    loadedOrgId = orgId;
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/docs`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const body = await res.json();
    articles = Array.isArray(body.articles) ? body.articles : [];
    categories = Array.isArray(body.categories) ? body.categories : [];
    roles = Array.isArray(body.roles) ? body.roles : [];
    refreshSnap();
    emit();
  },

  async addCategory(orgId, input) {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/docs/categories`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          parentId: input.parentId ?? null,
        }),
      },
    );
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ??
          "Failed to create category",
      );
    const { category } = await res.json();
    categories = [...categories, category];
    refreshSnap();
    emit();
    return category;
  },

  async renameCategory(id, name) {
    const orgId = loadedOrgId;
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/docs/categories/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ??
          "Failed to rename category",
      );
    categories = categories.map((c) => (c.id === id ? { ...c, name } : c));
    refreshSnap();
    emit();
  },

  async removeCategory(id) {
    const orgId = loadedOrgId;
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/docs/categories/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        credentials: "include",
      },
    );
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ??
          "Failed to delete category",
      );
    categories = categories
      .filter((c) => c.id !== id)
      .map((c) => (c.parentId === id ? { ...c, parentId: null } : c));
    articles = articles.map((a) =>
      a.categoryId === id ? { ...a, categoryId: null } : a,
    );
    refreshSnap();
    emit();
  },

  async addArticle(orgId, input) {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/docs/articles`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          minPosition: input.minPosition ?? 0,
          categoryId: input.categoryId ?? null,
        }),
      },
    );
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ??
          "Failed to create article",
      );
    const { article } = await res.json();
    articles = [article, ...articles];
    refreshSnap();
    emit();
    return article;
  },

  async saveArticle(id, patch) {
    const orgId = loadedOrgId;
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/docs/articles/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ?? "Failed to save article",
      );
    const { article } = await res.json();
    articles = articles.map((a) => (a.id === id ? article : a));
    refreshSnap();
    emit();
  },

  async restoreVersion(id, versionId) {
    const orgId = loadedOrgId;
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/docs/articles/${encodeURIComponent(id)}/restore/${encodeURIComponent(versionId)}`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ??
          "Failed to restore version",
      );
    const { article } = await res.json();
    articles = articles.map((a) => (a.id === id ? article : a));
    refreshSnap();
    emit();
  },

  async deleteVersion(articleId, versionId) {
    const orgId = loadedOrgId;
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/docs/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ??
          "Failed to delete version",
      );
    articles = articles.map((a) =>
      a.id === articleId
        ? { ...a, versions: a.versions.filter((v) => v.id !== versionId) }
        : a,
    );
    refreshSnap();
    emit();
  },

  async deleteArticle(id) {
    const orgId = loadedOrgId;
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/docs/articles/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        credentials: "include",
      },
    );
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ??
          "Failed to delete article",
      );
    articles = articles.filter((a) => a.id !== id);
    refreshSnap();
    emit();
  },
};

export function useDocs() {
  return useSyncExternalStore(
    docsStore.subscribe,
    docsStore.get,
    docsStore.get,
  );
}

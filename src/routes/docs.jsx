import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import {
  DOC_RANK_OPTIONS,
  docRankLabel,
  docsStore,
  useDocs,
} from "@/lib/docs-store";
import { createFileRoute } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  History,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
const Route = createFileRoute("/docs")({
  head: () => ({ meta: [{ title: "Docs \u2014 IronSight" }] }),
  component: DocsPage,
});
function timeAgo(unix) {
  const m = Math.floor((Date.now() / 1000 - unix) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}
function DocsPage() {
  const {
    orgs,
    selectedOrgIds,
    activeStaff,
    rankOf,
    orgsLoaded,
    hasStaffAccount,
  } = useAuth();
  const { articles, categories } = useDocs();
  const [orgId, setOrgId] = useState(
    () => selectedOrgIds[0] ?? orgs[0]?.id ?? "",
  );
  const effectiveOrgId = selectedOrgIds.includes(orgId)
    ? orgId
    : (selectedOrgIds[0] ?? orgs[0]?.id ?? "");

  useEffect(() => {
    if (effectiveOrgId) docsStore.load(effectiveOrgId);
  }, [effectiveOrgId]);

  const myRank = rankOf(effectiveOrgId);
  const canEdit = myRank >= 3;
  const canDelete = myRank >= 4;
  const orgCats = useMemo(
    () => categories.filter((c) => c.orgId === effectiveOrgId),
    [categories, effectiveOrgId],
  );
  const orgArticles = useMemo(
    () =>
      articles.filter((a) => a.orgId === effectiveOrgId && myRank >= a.minRank),
    [articles, effectiveOrgId, myRank],
  );
  const [selectedId, setSelectedId] = useState(null);
  const selected = orgArticles.find((a) => a.id === selectedId) ?? null;
  const [search, setSearch] = useState("");
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return orgArticles.filter(
      (a) =>
        a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q),
    );
  }, [search, orgArticles]);
  const [editing, setEditing] = useState(null);
  const [creatingCatParent, setCreatingCatParent] = useState(void 0);
  const [historyFor, setHistoryFor] = useState(null);
  const startNewArticle = async (categoryId) => {
    if (!canEdit || !activeStaff) return;
    try {
      const a = await docsStore.addArticle(effectiveOrgId, {
        categoryId,
        title: "Untitled",
        body: "# Untitled\n\nStart writing\u2026",
        minRank: 1,
      });
      setSelectedId(a.id);
      setEditing(a);
    } catch (err) {
      console.error("Failed to create article:", err);
    }
  };
  if (orgsLoaded && !hasStaffAccount) {
    return (
      <div className="h-screen w-full flex flex-col bg-background text-foreground">
        <SiteNav />
        <main className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">
            You must belong to an organization to view documentation.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 flex overflow-hidden">
        <div className="w-72 border-r border-border bg-surface/30 flex flex-col">
          <div className="p-3 border-b border-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Docs · Wiki
              </span>
              {selectedOrgIds.length > 1 && (
                <Select value={effectiveOrgId} onValueChange={setOrgId}>
                  <SelectTrigger className="h-6 w-28 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {orgs
                      .filter((o) => selectedOrgIds.includes(o.id))
                      .map((o) => (
                        <SelectItem key={o.id} value={o.id} className="text-xs">
                          {o.short}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search articles…"
                className="pl-7 h-8 text-xs"
              />
            </div>
            {canEdit && (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] flex-1"
                  onClick={() => setCreatingCatParent(null)}
                >
                  <FolderPlus className="size-3 mr-1" /> Category
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-[10px] flex-1"
                  onClick={() => startNewArticle(null)}
                >
                  <Plus className="size-3 mr-1" /> Article
                </Button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {search.trim() ? (
              <SearchResults
                results={searchResults}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
              />
            ) : (
              <Tree
                cats={orgCats}
                articles={orgArticles}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
                canEdit={canEdit}
                onAddSub={(parentId) => setCreatingCatParent(parentId)}
                onAddArticleIn={(catId) => startNewArticle(catId)}
                onRenameCat={(id, name) => docsStore.renameCategory(id, name)}
                onRemoveCat={(id) => {
                  if (
                    confirm(
                      "Delete this category? Articles will be uncategorized.",
                    )
                  ) {
                    docsStore.removeCategory(id);
                  }
                }}
              />
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {selected ? (
            editing && editing.id === selected.id ? (
              <Editor
                article={editing}
                cats={orgCats}
                onCancel={() => setEditing(null)}
                onSave={async (patch) => {
                  try {
                    await docsStore.saveArticle(selected.id, patch);
                    setEditing(null);
                  } catch (err) {
                    console.error("Failed to save article:", err);
                  }
                }}
              />
            ) : (
              <Viewer
                article={selected}
                canEdit={canEdit}
                canDelete={canDelete}
                onEdit={() => setEditing(selected)}
                onHistory={() => setHistoryFor(selected)}
                onDelete={async () => {
                  if (confirm("Permanently delete this article? Owner-only.")) {
                    try {
                      await docsStore.deleteArticle(selected.id);
                      setSelectedId(null);
                    } catch (err) {
                      console.error("Failed to delete article:", err);
                    }
                  }
                }}
              />
            )
          ) : (
            <div className="h-full grid place-items-center text-muted-foreground">
              <div className="text-center">
                <FileText className="size-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">
                  Pick an article from the left or search above.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>

      <NewCategoryDialog
        open={creatingCatParent !== void 0}
        parentId={creatingCatParent ?? null}
        onClose={() => setCreatingCatParent(void 0)}
        onCreate={async (name) => {
          try {
            await docsStore.addCategory(effectiveOrgId, {
              parentId: creatingCatParent ?? null,
              name,
            });
          } catch (err) {
            console.error("Failed to create category:", err);
          }
          setCreatingCatParent(void 0);
        }}
      />

      {historyFor && (
        <HistoryDialog
          article={historyFor}
          canEdit={canEdit}
          canDelete={canDelete}
          onClose={() => setHistoryFor(null)}
          onRestore={async (versionId) => {
            try {
              await docsStore.restoreVersion(historyFor.id, versionId);
            } catch (err) {
              console.error("Failed to restore version:", err);
            }
          }}
          onDeleteVersion={async (versionId) => {
            if (confirm("Delete this version permanently?")) {
              try {
                await docsStore.deleteVersion(historyFor.id, versionId);
              } catch (err) {
                console.error("Failed to delete version:", err);
              }
            }
          }}
        />
      )}
    </div>
  );
}
function Tree({
  cats,
  articles,
  selectedId,
  onSelect,
  canEdit,
  onAddSub,
  onAddArticleIn,
  onRenameCat,
  onRemoveCat,
}) {
  const roots = cats.filter((c) => !c.parentId);
  const uncategorized = articles.filter((a) => !a.categoryId);
  return (
    <div className="space-y-0.5 text-sm">
      {roots.map((c) => (
        <CatNode
          key={c.id}
          cat={c}
          cats={cats}
          articles={articles}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          canEdit={canEdit}
          onAddSub={onAddSub}
          onAddArticleIn={onAddArticleIn}
          onRenameCat={onRenameCat}
          onRemoveCat={onRemoveCat}
        />
      ))}
      {uncategorized.length > 0 && (
        <div className="mt-3 pt-2 border-t border-border">
          <div className="px-2 text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
            Uncategorized
          </div>
          {uncategorized.map((a) => (
            <ArticleRow
              key={a.id}
              article={a}
              depth={0}
              selected={selectedId === a.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
function CatNode({
  cat,
  cats,
  articles,
  depth,
  selectedId,
  onSelect,
  canEdit,
  onAddSub,
  onAddArticleIn,
  onRenameCat,
  onRemoveCat,
}) {
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(cat.name);
  const children = cats.filter((c) => c.parentId === cat.id);
  const ownArticles = articles.filter((a) => a.categoryId === cat.id);
  return (
    <div>
      <div
        className="group flex items-center gap-1 px-1 py-1 rounded hover:bg-surface"
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        <button onClick={() => setOpen((o) => !o)} className="shrink-0">
          {open ? (
            <ChevronDown className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground" />
          )}
        </button>
        <Folder className="size-3.5 text-brand shrink-0" />
        {renaming ? (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              onRenameCat(cat.id, name);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRenameCat(cat.id, name);
                setRenaming(false);
              }
              if (e.key === "Escape") {
                setName(cat.name);
                setRenaming(false);
              }
            }}
            className="h-5 text-xs px-1"
          />
        ) : (
          <span
            className="text-xs font-semibold flex-1 truncate cursor-default"
            onDoubleClick={() => canEdit && setRenaming(true)}
          >
            {cat.name}
          </span>
        )}
        {canEdit && (
          <div className="hidden group-hover:flex items-center gap-0.5">
            <button
              onClick={() => onAddArticleIn(cat.id)}
              className="size-5 grid place-items-center rounded hover:bg-background text-muted-foreground hover:text-foreground"
              title="New article here"
            >
              <Plus className="size-3" />
            </button>
            <button
              onClick={() => onAddSub(cat.id)}
              className="size-5 grid place-items-center rounded hover:bg-background text-muted-foreground hover:text-foreground"
              title="New subcategory"
            >
              <FolderPlus className="size-3" />
            </button>
            <button
              onClick={() => onRemoveCat(cat.id)}
              className="size-5 grid place-items-center rounded hover:bg-background text-muted-foreground hover:text-danger"
              title="Delete category"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        )}
      </div>
      {open && (
        <div>
          {children.map((c) => (
            <CatNode
              key={c.id}
              cat={c}
              cats={cats}
              articles={articles}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              canEdit={canEdit}
              onAddSub={onAddSub}
              onAddArticleIn={onAddArticleIn}
              onRenameCat={onRenameCat}
              onRemoveCat={onRemoveCat}
            />
          ))}
          {ownArticles.map((a) => (
            <ArticleRow
              key={a.id}
              article={a}
              depth={depth + 1}
              selected={selectedId === a.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
function ArticleRow({ article, depth, selected, onSelect }) {
  return (
    <button
      onClick={() => onSelect(article.id)}
      className={
        "w-full flex items-center gap-1.5 px-1 py-1 rounded text-left text-xs " +
        (selected
          ? "bg-brand/15 text-foreground"
          : "text-muted-foreground hover:bg-surface hover:text-foreground")
      }
      style={{ paddingLeft: 14 + depth * 12 }}
    >
      <FileText className="size-3 shrink-0" />
      <span className="truncate flex-1">{article.title}</span>
      {article.minRank > 1 && (
        <Lock className="size-3 text-muted-foreground shrink-0" />
      )}
    </button>
  );
}
function SearchResults({ results, selectedId, onSelect }) {
  if (results.length === 0) {
    return (
      <p className="px-2 py-3 text-[11px] text-muted-foreground">
        No matches in articles you can view.
      </p>
    );
  }
  return (
    <div className="space-y-0.5">
      {results.map((a) => (
        <ArticleRow
          key={a.id}
          article={a}
          depth={0}
          selected={selectedId === a.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
function Viewer({ article, canEdit, canDelete, onEdit, onHistory, onDelete }) {
  return (
    <article className="max-w-3xl mx-auto px-8 py-8">
      <header className="mb-6 pb-4 border-b border-border flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-2">
            <Lock className="size-3" /> {docRankLabel(article.minRank)}
          </div>
          <h1 className="text-2xl font-bold text-foreground truncate">
            {article.title}
          </h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            Updated {timeAgo(article.updatedAt)} by {article.updatedByName} ·{" "}
            {article.versions.length} previous version
            {article.versions.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" onClick={onHistory}>
            <History className="size-3.5 mr-1" /> History
          </Button>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="size-3.5 mr-1" /> Edit
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onDelete}
              className="text-danger hover:text-danger"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </header>
      <MarkdownView body={article.body} />
    </article>
  );
}
function MarkdownView({ body }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-a:text-brand prose-code:text-brand prose-code:before:content-none prose-code:after:content-none prose-pre:bg-surface prose-pre:ring-1 prose-pre:ring-border prose-blockquote:border-l-brand prose-blockquote:text-muted-foreground prose-img:rounded-md prose-img:ring-1 prose-img:ring-border">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
function Editor({ article, cats, onCancel, onSave }) {
  const [title, setTitle] = useState(article.title);
  const [body, setBody] = useState(article.body);
  const [minRank, setMinRank] = useState(article.minRank);
  const [categoryId, setCategoryId] = useState(article.categoryId);
  const [preview, setPreview] = useState(false);
  const taRef = useRef(null);
  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const img = items.find((i) => i.type.startsWith("image/"));
    if (!img) return;
    const file = img.getAsFile();
    if (!file) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const insert = `

![pasted image](${dataUrl})

`;
      const ta = taRef.current;
      if (!ta) {
        setBody((b) => b + insert);
        return;
      }
      const start = ta.selectionStart ?? body.length;
      const end = ta.selectionEnd ?? body.length;
      setBody((b) => b.slice(0, start) + insert + b.slice(end));
    };
    reader.readAsDataURL(file);
  };
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      onSave({ title, body, minRank, categoryId });
    }
  };
  return (
    <div className="max-w-3xl mx-auto px-8 py-8 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-xl font-bold h-11 flex-1"
          placeholder="Article title"
        />
        <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}>
          {preview ? "Edit" : "Preview"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="size-3.5 mr-1" /> Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onSave({ title, body, minRank, categoryId })}
        >
          <Save className="size-3.5 mr-1" /> Save
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Category
          </Label>
          <Select
            value={categoryId ?? "__none"}
            onValueChange={(v) => setCategoryId(v === "__none" ? null : v)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Uncategorized</SelectItem>
              {cats.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {catPath(c, cats)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Visibility
          </Label>
          <Select
            value={String(minRank)}
            onValueChange={(v) => setMinRank(Number(v))}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOC_RANK_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {preview ? (
        <div className="ring-1 ring-border rounded-md p-4 bg-surface/30 min-h-[400px]">
          <MarkdownView body={body} />
        </div>
      ) : (
        <Textarea
          ref={taRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKey}
          rows={20}
          placeholder="Write markdown here… paste images directly with Ctrl+V."
          className="font-mono text-xs leading-relaxed min-h-[400px]"
        />
      )}
      <p className="text-[10px] text-muted-foreground">
        Markdown supported (GFM). Paste images with Ctrl+V — they're embedded
        automatically. Ctrl+S to save.
      </p>
    </div>
  );
}
function catPath(c, all) {
  const parts = [c.name];
  let p = c.parentId;
  while (p) {
    const par = all.find((x) => x.id === p);
    if (!par) break;
    parts.unshift(par.name);
    p = par.parentId;
  }
  return parts.join(" / ");
}
function NewCategoryDialog({ open, parentId, onClose, onCreate }) {
  const [name, setName] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setName("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {parentId ? "New subcategory" : "New category"}
          </DialogTitle>
          <DialogDescription>
            Group related articles together.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Category name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              onCreate(name.trim());
              setName("");
            }
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => {
              onCreate(name.trim());
              setName("");
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function HistoryDialog({
  article,
  canEdit,
  canDelete,
  onClose,
  onRestore,
  onDeleteVersion,
}) {
  const [previewing, setPreviewing] = useState(null);
  const v = article.versions.find((x) => x.id === previewing);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Version history — {article.title}</DialogTitle>
          <DialogDescription>
            Every save creates a snapshot.{" "}
            {canEdit ? "Sr. Admins and Management can restore." : "Read-only."}
            {canDelete && " Owner can permanently delete versions."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[260px_1fr] gap-4 max-h-[60vh]">
          <div className="overflow-y-auto border-r border-border pr-3 space-y-1">
            {article.versions.length === 0 && (
              <p className="text-[11px] text-muted-foreground py-4">
                No previous versions yet.
              </p>
            )}
            {article.versions.map((vv) => (
              <div
                key={vv.id}
                className={
                  "group p-2 rounded text-xs cursor-pointer ring-1 " +
                  (previewing === vv.id
                    ? "bg-brand/15 ring-brand/40"
                    : "ring-border hover:bg-surface")
                }
                onClick={() => setPreviewing(vv.id)}
              >
                <div className="font-semibold truncate">{vv.title}</div>
                <div className="text-[10px] text-muted-foreground">
                  {timeAgo(vv.savedAt)} · {vv.savedByName}
                </div>
                <div className="hidden group-hover:flex items-center gap-1 mt-1">
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRestore(vv.id);
                      }}
                    >
                      <RotateCcw className="size-3 mr-1" /> Restore
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] text-danger hover:text-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteVersion(vv.id);
                        setPreviewing(null);
                      }}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="overflow-y-auto">
            {v ? (
              <MarkdownView body={v.body} />
            ) : (
              <p className="text-xs text-muted-foreground">
                Pick a version to preview.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export { Route };

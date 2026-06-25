import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute } from "@tanstack/react-router";
import {
  Film,
  Image,
  Plus,
  Trash2,
  Upload,
  X,
  FileIcon,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/media")({
  head: () => ({ meta: [{ title: "Media — IronSight" }] }),
  component: MediaPage,
});

function formatBytes(bytes) {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(unix) {
  if (!unix) return null;
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function FileTypeIcon({ fileType, className = "size-5" }) {
  if (fileType === "video") return <Film className={className} />;
  if (fileType === "image") return <Image className={className} />;
  return <FileIcon className={className} />;
}

function MediaCard({ item, onDelete, deleting }) {
  const isImage = item.fileType === "image";
  const isVideo = item.fileType === "video";

  return (
    <div className="group rounded-lg ring-1 ring-border bg-surface/40 overflow-hidden flex flex-col">
      <div className="relative bg-black/20 aspect-video flex items-center justify-center overflow-hidden">
        {isImage ? (
          <img
            src={item.ziplineUrl}
            alt={item.title || item.filename}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : isVideo ? (
          <video
            src={item.ziplineUrl}
            className="w-full h-full object-cover"
            preload="metadata"
            muted
          />
        ) : (
          <FileIcon className="size-10 text-muted-foreground" />
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
          <a
            href={item.ziplineUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-background/90 rounded-md ring-1 ring-border hover:bg-background transition-colors"
          >
            <ExternalLink className="size-3" />
            Open
          </a>
          <button
            onClick={() => onDelete(item.mediaId)}
            disabled={deleting}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-danger/90 text-white rounded-md hover:bg-danger transition-colors disabled:opacity-50"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </div>
      <div className="p-3 flex-1 min-w-0 space-y-1">
        <p className="text-xs font-medium truncate">{item.title || item.filename}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <FileTypeIcon fileType={item.fileType} className="size-3" />
            {item.fileType}
          </span>
          {item.fileSize && (
            <span className="text-[10px] text-muted-foreground">{formatBytes(item.fileSize)}</span>
          )}
          <span className="text-[10px] text-muted-foreground">{formatDate(item.uploadedAt)}</span>
        </div>
        {item.uploadedByName && (
          <p className="text-[10px] text-muted-foreground truncate">by {item.uploadedByName}</p>
        )}
      </div>
    </div>
  );
}

function UploadDialog({ open, onClose, orgId, onUploaded }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null);
  const fileRef = useRef(null);

  function reset() {
    setFile(null);
    setTitle("");
    setError("");
    setProgress(null);
  }

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  async function handleUpload(e) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError("");
    setProgress("Uploading…");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", title.trim());
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/media`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Upload failed.");
        return;
      }
      onUploaded(body.media);
      onClose();
    } catch (err) {
      setError(err.message ?? "Upload failed.");
    } finally {
      setUploading(false);
      setProgress(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload media</DialogTitle>
          <DialogDescription>
            Upload images or video clips to your organization's media gallery.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleUpload} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>File</Label>
            {file ? (
              <div className="flex items-center gap-2 rounded-md ring-1 ring-border bg-surface/40 px-3 py-2">
                <FileTypeIcon fileType={file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "other"} className="size-4 text-muted-foreground shrink-0" />
                <span className="text-xs flex-1 truncate">{file.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
                <button type="button" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }} className="text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full rounded-md ring-1 ring-dashed ring-border bg-surface/20 hover:bg-surface/40 transition-colors py-6 flex flex-col items-center gap-2 text-muted-foreground"
              >
                <Upload className="size-6" />
                <span className="text-sm">Click to select a file</span>
                <span className="text-[11px]">Images, videos, clips up to 500 MB</span>
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/*,video/*"
              onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upload-title">
              Title <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="upload-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Aimbot clip — 76561198000000000"
              maxLength={255}
            />
          </div>
          {error && (
            <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
          {progress && !error && (
            <p className="text-sm text-muted-foreground">{progress}</p>
          )}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={onClose} disabled={uploading}>
              Cancel
            </Button>
            <Button type="submit" disabled={!file || uploading}>
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MediaPage() {
  const { orgs, myOrgIds, orgsLoaded } = useAuth();

  const [orgId, setOrgId] = useState("");
  const [media, setMedia] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [offset, setOffset] = useState(0);
  const LIMIT = 48;

  useEffect(() => {
    if (orgsLoaded && !orgId && myOrgIds.length > 0) {
      setOrgId(myOrgIds[0]);
    }
  }, [orgsLoaded, myOrgIds, orgId]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
      if (typeFilter !== "all") params.set("type", typeFilter);
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/media?${params}`, {
        credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Failed to load media.");
        return;
      }
      setMedia(body.media ?? []);
      setTotal(body.total ?? 0);
    } catch (err) {
      setError(err.message ?? "Failed to load media.");
    } finally {
      setLoading(false);
    }
  }, [orgId, typeFilter, offset]);

  useEffect(() => {
    setOffset(0);
  }, [orgId, typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(mediaId) {
    setDeletingId(mediaId);
    setConfirmDeleteId(null);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/media/${mediaId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setMedia((prev) => prev.filter((m) => m.mediaId !== mediaId));
        setTotal((t) => Math.max(0, t - 1));
      }
    } finally {
      setDeletingId(null);
    }
  }

  const pages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <SiteNav>
      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold">Media Gallery</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Evidence clips and images uploaded by staff.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {myOrgIds.length > 1 && (
              <select
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring [&>option]:bg-surface [&>option]:text-foreground"
              >
                {myOrgIds.map((id) => {
                  const org = orgs?.find((o) => o.id === id);
                  return (
                    <option key={id} value={id}>
                      {org?.name ?? id}
                    </option>
                  );
                })}
              </select>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 h-9 px-3 text-sm rounded-md ring-1 ring-border bg-surface/40 hover:bg-surface/70 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
            <Button onClick={() => setUploadOpen(true)}>
              <Plus className="size-4" />
              Upload
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {["all", "image", "video", "other"].map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1 text-xs rounded-md ring-1 transition-colors capitalize ${
                typeFilter === t
                  ? "ring-brand/60 bg-brand/15 text-brand font-medium"
                  : "ring-border bg-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "all" ? "All" : t}
            </button>
          ))}
          {total > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">{total} item{total !== 1 ? "s" : ""}</span>
          )}
        </div>

        {error && (
          <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {loading && media.length === 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-lg ring-1 ring-border bg-surface/20 aspect-video animate-pulse" />
            ))}
          </div>
        ) : media.length === 0 ? (
          <div className="rounded-lg ring-1 ring-border bg-surface/20 py-16 text-center">
            <FileIcon className="size-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No media uploaded yet.</p>
            <Button className="mt-4" onClick={() => setUploadOpen(true)}>
              <Upload className="size-4" />
              Upload first file
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {media.map((item) => (
              <MediaCard
                key={item.mediaId}
                item={item}
                onDelete={(id) => setConfirmDeleteId(id)}
                deleting={deletingId === item.mediaId}
              />
            ))}
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center gap-2 justify-center pt-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {currentPage} of {pages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPage >= pages}
              onClick={() => setOffset((o) => o + LIMIT)}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        orgId={orgId}
        onUploaded={(item) => {
          setMedia((prev) => [item, ...prev]);
          setTotal((t) => t + 1);
        }}
      />

      <Dialog open={!!confirmDeleteId} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete media?</DialogTitle>
            <DialogDescription>
              This will permanently delete the file from Zipline and remove it from all linked bans. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleDelete(confirmDeleteId)}
              disabled={!!deletingId}
            >
              {deletingId ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SiteNav>
  );
}

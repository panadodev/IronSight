import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute } from "@tanstack/react-router";
import {
    ExternalLink,
    FileIcon,
    Film,
    HardDrive,
    Image,
    Plus,
    RefreshCw,
    ShieldAlert,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/media")({
  head: () => ({ meta: [{ title: "Media — IronSight" }] }),
  component: MediaPage,
});

const PART_SIZE = 100 * 1024 * 1024;

function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(unix) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function FileTypeIcon({ fileType, className = "size-4" }) {
  if (fileType === "video") return <Film className={className} />;
  if (fileType === "image") return <Image className={className} />;
  return <FileIcon className={className} />;
}

// Upload a single chunk via XHR so we get progress events.
function uploadChunkXhr(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.getResponseHeader("ETag"));
      } else {
        reject(new Error(`Upload failed: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(blob);
  });
}

function UploadDialog({ open, onClose, orgs, onUploaded }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null);
  const [statusText, setStatusText] = useState("");
  const fileRef = useRef(null);

  function reset() {
    setFile(null);
    setTitle("");
    setError("");
    setProgress(null);
    setStatusText("");
  }

  useEffect(() => {
    if (!open) reset();
    else setOrgId(orgs[0]?.id ?? "");
  }, [open]);

  async function handleUpload(e) {
    e.preventDefault();
    if (!file || !orgId) return;
    setUploading(true);
    setError("");
    setProgress(0);

    try {
      setStatusText("Preparing upload…");
      const prepareRes = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/media/prepare`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
          title: title.trim(),
        }),
      });
      const prepareBody = await prepareRes.json().catch(() => null);
      if (!prepareRes.ok) {
        setError(prepareBody?.error ?? "Upload preparation failed.");
        return;
      }

      const { uploadUrl, mediaId, multipart } = prepareBody;
      let parts = null;

      if (multipart) {
        setStatusText("Uploading (large file — multipart)…");
        const { partUrls, partSize } = multipart;
        parts = [];
        for (let i = 0; i < partUrls.length; i++) {
          const start = i * partSize;
          const chunk = file.slice(start, start + partSize);
          const etag = await uploadChunkXhr(partUrls[i], chunk, (frac) => {
            setProgress(Math.round(((i + frac) / partUrls.length) * 95));
          });
          parts.push({ partNumber: i + 1, etag });
        }
      } else {
        setStatusText("Uploading…");
        await uploadChunkXhr(uploadUrl, file, (frac) => {
          setProgress(Math.round(frac * 95));
        });
      }

      setStatusText("Finalizing…");
      setProgress(98);
      const confirmRes = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/media/confirm`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId, parts, fileSize: file.size }),
      });
      const confirmBody = await confirmRes.json().catch(() => null);
      if (!confirmRes.ok) {
        setError(confirmBody?.error ?? "Upload confirmation failed.");
        return;
      }

      setProgress(100);
      const org = orgs.find((o) => o.id === orgId);
      onUploaded({ ...confirmBody.media, orgName: org?.name ?? orgId });
      onClose();
    } catch (err) {
      setError(err.message ?? "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload media</DialogTitle>
          <DialogDescription>
            Files go directly from your browser to Cloudflare R2. Files ≥ 300 MB use multipart upload.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleUpload} className="space-y-4 py-2">
          {orgs.length > 1 && (
            <div className="space-y-1.5">
              <Label>Organization</Label>
              <Select value={orgId} onValueChange={setOrgId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select organization" />
                </SelectTrigger>
                <SelectContent>
                  {orgs.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>File</Label>
            {file ? (
              <div className="flex items-center gap-2 rounded-md ring-1 ring-border bg-surface/40 px-3 py-2">
                <FileTypeIcon
                  fileType={file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "other"}
                  className="size-4 text-muted-foreground shrink-0"
                />
                <span className="text-xs flex-1 truncate">{file.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                  className="text-muted-foreground hover:text-foreground"
                >
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
                <span className="text-[11px]">Images, videos &amp; PDFs · up to 5 GB</span>
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,application/pdf"
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
          {uploading && progress !== null && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{statusText}</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-1.5" />
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={onClose} disabled={uploading}>
              Cancel
            </Button>
            <Button type="submit" disabled={!file || !orgId || uploading}>
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Thumbnail({ item }) {
  if (item.fileType === "image" && item.url) {
    return (
      <img
        src={item.url}
        alt={item.title || item.filename}
        className="size-9 rounded object-cover bg-black/20 shrink-0"
        loading="lazy"
      />
    );
  }
  if (item.fileType === "video" && item.url) {
    return (
      <video
        src={item.url}
        className="size-9 rounded object-cover bg-black/20 shrink-0"
        preload="none"
        muted
      />
    );
  }
  return (
    <div className="size-9 rounded bg-surface/40 ring-1 ring-border flex items-center justify-center shrink-0">
      <FileTypeIcon fileType={item.fileType} className="size-4 text-muted-foreground" />
    </div>
  );
}

function MediaTable({ media, onDelete, deletingId, isSysAdmin }) {
  return (
    <div className="rounded-lg ring-1 ring-border overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-surface/30">
            <th className="text-left px-3 py-2 font-medium text-muted-foreground w-10" />
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
            {isSysAdmin && (
              <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">Org</th>
            )}
            {isSysAdmin && (
              <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden lg:table-cell">Uploader</th>
            )}
            <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell w-16">Type</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell w-20">Size</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground w-28">Uploaded</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground w-20">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {media.map((item) => (
            <tr key={item.mediaId} className="hover:bg-surface/20 transition-colors">
              <td className="px-3 py-2">
                <Thumbnail item={item} />
              </td>
              <td className="px-3 py-2 max-w-0">
                <p className="font-medium truncate text-foreground">{item.title || item.filename}</p>
                {item.title && (
                  <p className="text-[10px] text-muted-foreground truncate">{item.filename}</p>
                )}
              </td>
              {isSysAdmin && (
                <td className="px-3 py-2 hidden md:table-cell text-muted-foreground truncate max-w-[120px]">
                  {item.orgName ?? item.orgId ?? "—"}
                </td>
              )}
              {isSysAdmin && (
                <td className="px-3 py-2 hidden lg:table-cell text-muted-foreground truncate max-w-[120px]">
                  {item.uploadedByName ?? "—"}
                </td>
              )}
              <td className="px-3 py-2 hidden sm:table-cell">
                <span className="inline-flex items-center gap-1 text-muted-foreground capitalize">
                  <FileTypeIcon fileType={item.fileType} className="size-3" />
                  {item.fileType}
                </span>
              </td>
              <td className="px-3 py-2 hidden sm:table-cell text-muted-foreground tabular-nums">
                {formatBytes(item.fileSize)}
              </td>
              <td className="px-3 py-2 text-muted-foreground tabular-nums whitespace-nowrap">
                {formatDate(item.uploadedAt)}
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5 justify-end">
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-1 rounded ring-1 ring-border hover:bg-surface/60 transition-colors text-muted-foreground hover:text-foreground"
                      title="Open"
                    >
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                  <button
                    onClick={() => onDelete(item)}
                    disabled={deletingId === item.mediaId}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded ring-1 ring-danger/40 hover:bg-danger/10 transition-colors text-danger disabled:opacity-40"
                    title="Delete"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MediaPage() {
  const {
    orgs = [],
    orgsLoaded,
    sessionUser,
    hasOrgPermission,
    sessionOrgAdminIds = [],
    sessionOrgOwnerIds = [],
  } = useAuth();
  const LIMIT = 50;
  const [media, setMedia] = useState([]);
  const [total, setTotal] = useState(0);
  const [isSysAdmin, setIsSysAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // { mediaId, orgId, filename }

  const isSessionSysAdmin = sessionUser?.isSysAdmin === true;
  const canUploadInOrg = (orgId) =>
    isSessionSysAdmin ||
    sessionOrgAdminIds.includes(orgId) ||
    sessionOrgOwnerIds.includes(orgId) ||
    hasOrgPermission(orgId, "media_upload");

  const uploadOrgs = orgs.filter((o) => canUploadInOrg(o.id));
  const canAccess = isSessionSysAdmin || uploadOrgs.length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
      if (typeFilter !== "all") params.set("type", typeFilter);
      const res = await fetch(`/api/media?${params}`, { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Failed to load media.");
        return;
      }
      setMedia(body.media ?? []);
      setTotal(body.total ?? 0);
      setIsSysAdmin(body.isSysAdmin === true);
    } catch (err) {
      setError(err.message ?? "Failed to load media.");
    } finally {
      setLoading(false);
    }
  }, [typeFilter, offset]);

  useEffect(() => { setOffset(0); }, [typeFilter]);
  useEffect(() => { if (orgsLoaded) load(); }, [load, orgsLoaded]);

  async function handleDelete(item) {
    setDeletingId(item.mediaId);
    setConfirmDelete(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(item.orgId)}/media/${item.mediaId}`,
        { method: "DELETE", credentials: "include" },
      );
      if (res.ok) {
        setMedia((prev) => prev.filter((m) => m.mediaId !== item.mediaId));
        setTotal((t) => Math.max(0, t - 1));
      }
    } finally {
      setDeletingId(null);
    }
  }

  const pages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  if (!canAccess) {
    return (
      <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 grid place-items-center px-6">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="size-10 text-warning mx-auto" />
            <h1 className="text-lg font-semibold">Permission required</h1>
            <p className="text-sm text-muted-foreground">
              Media Gallery requires the Upload Media permission.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-lg font-semibold">Media Gallery</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {isSysAdmin
                  ? "All media across all organizations — sysadmin view."
                  : "Your uploaded evidence clips, screenshots, and files stored in Cloudflare R2."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                {["all", "image", "video", "other"].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={`px-2.5 py-1 text-[11px] rounded-md ring-1 transition-colors capitalize ${
                      typeFilter === t
                        ? "ring-brand/60 bg-brand/15 text-brand font-medium"
                        : "ring-border bg-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t === "all" ? "All" : t}
                  </button>
                ))}
              </div>
              <button
                onClick={load}
                disabled={loading}
                title="Refresh"
                className="inline-flex items-center h-7 px-2 text-xs rounded-md ring-1 ring-border bg-surface/40 hover:bg-surface/70 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
              </button>
              <Button
                size="sm"
                className="h-7 text-xs px-3"
                onClick={() => setUploadOpen(true)}
                disabled={uploadOrgs.length === 0}
              >
                <Plus className="size-3.5" />
                Upload
              </Button>
            </div>
          </div>

        {error && (
          <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {loading && media.length === 0 ? (
          <div className="rounded-lg ring-1 ring-border overflow-hidden">
            <div className="divide-y divide-border">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2">
                  <div className="size-9 rounded bg-surface/40 animate-pulse shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-48 bg-surface/60 rounded animate-pulse" />
                    <div className="h-2.5 w-32 bg-surface/40 rounded animate-pulse" />
                  </div>
                  <div className="h-3 w-16 bg-surface/40 rounded animate-pulse hidden sm:block" />
                  <div className="h-3 w-20 bg-surface/40 rounded animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        ) : media.length === 0 ? (
          <div className="rounded-lg ring-1 ring-border bg-surface/20 py-14 flex flex-col items-center gap-2 text-center">
            <HardDrive className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No media uploaded yet.</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Upload clips, screenshots, or evidence files. They can be linked to bans.
            </p>
            {orgs.length > 0 && (
              <Button size="sm" className="mt-1" onClick={() => setUploadOpen(true)}>
                <Upload className="size-3.5" />
                Upload first file
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{total} file{total !== 1 ? "s" : ""}</span>
            </div>
            <MediaTable
              media={media}
              onDelete={(item) => setConfirmDelete(item)}
              deletingId={deletingId}
              isSysAdmin={isSysAdmin}
            />
          </>
        )}

        {pages > 1 && (
          <div className="flex items-center gap-2 justify-center pt-1">
            <Button variant="ghost" size="sm" disabled={currentPage <= 1}
              onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}>
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {currentPage} of {pages}
            </span>
            <Button variant="ghost" size="sm" disabled={currentPage >= pages}
              onClick={() => setOffset((o) => o + LIMIT)}>
              Next
            </Button>
          </div>
        )}

        <UploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          orgs={uploadOrgs}
          onUploaded={(item) => {
            setMedia((prev) => [item, ...prev]);
            setTotal((t) => t + 1);
          }}
        />

        <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete media?</DialogTitle>
              <DialogDescription>
                <span className="font-medium text-foreground">{confirmDelete?.title || confirmDelete?.filename}</span>
                {" "}will be permanently deleted from cloud storage and removed from all linked bans. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => handleDelete(confirmDelete)}
                disabled={!!deletingId}
              >
                {deletingId ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}

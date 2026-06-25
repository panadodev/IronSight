import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Film, Image, FileIcon, Check } from "lucide-react";
import { useEffect, useState } from "react";

function FileTypeIcon({ fileType, className = "size-4" }) {
  if (fileType === "video") return <Film className={className} />;
  if (fileType === "image") return <Image className={className} />;
  return <FileIcon className={className} />;
}

export function MediaPicker({ open, onClose, orgId, selectedIds = [], onConfirm }) {
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(new Set(selectedIds));
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    if (open) setSelected(new Set(selectedIds));
  }, [open]);

  useEffect(() => {
    if (!open || !orgId) return;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "48", offset: "0" });
    if (typeFilter !== "all") params.set("type", typeFilter);
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/media?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((body) => setMedia(body.media ?? []))
      .catch(() => setError("Failed to load media."))
      .finally(() => setLoading(false));
  }, [open, orgId, typeFilter]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    const selectedItems = media.filter((m) => selected.has(m.mediaId));
    onConfirm(Array.from(selected), selectedItems);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Link evidence</DialogTitle>
          <DialogDescription>
            Select media from your gallery to attach as evidence to this ban.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5 shrink-0">
          {["all", "image", "video"].map((t) => (
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
          {selected.size > 0 && (
            <span className="ml-auto text-xs text-muted-foreground">{selected.size} selected</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {error && (
            <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
          {loading ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="rounded-md ring-1 ring-border bg-surface/20 aspect-video animate-pulse" />
              ))}
            </div>
          ) : media.length === 0 ? (
            <div className="py-12 text-center">
              <FileIcon className="size-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No media in gallery yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
              {media.map((item) => {
                const isSelected = selected.has(item.mediaId);
                return (
                  <button
                    key={item.mediaId}
                    type="button"
                    onClick={() => toggle(item.mediaId)}
                    className={`relative rounded-md ring-2 overflow-hidden aspect-video text-left transition-all focus:outline-none ${
                      isSelected ? "ring-brand" : "ring-transparent hover:ring-border"
                    }`}
                  >
                    <div className="w-full h-full bg-black/20 flex items-center justify-center">
                      {item.fileType === "image" ? (
                        <img
                          src={item.ziplineUrl}
                          alt={item.title || item.filename}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : item.fileType === "video" ? (
                        <video
                          src={item.ziplineUrl}
                          className="w-full h-full object-cover"
                          preload="metadata"
                          muted
                        />
                      ) : (
                        <FileIcon className="size-6 text-muted-foreground" />
                      )}
                    </div>
                    {isSelected && (
                      <div className="absolute top-1.5 right-1.5 size-5 rounded-full bg-brand flex items-center justify-center">
                        <Check className="size-3 text-white" strokeWidth={3} />
                      </div>
                    )}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1">
                      <p className="text-[9px] text-white truncate leading-tight">{item.title || item.filename}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>
            {selected.size > 0 ? `Attach ${selected.size} item${selected.size !== 1 ? "s" : ""}` : "Attach none"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

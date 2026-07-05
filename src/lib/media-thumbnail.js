// Client-side gallery thumbnail generation.
//
// The media gallery must not fetch full videos/images out of R2 just to render a
// list. Instead, at upload time the browser draws a downscaled frame (video) or a
// resized copy (image) onto a canvas and uploads that ~15 KB webp as a separate
// R2 object. The server verifies + size-caps it (see finalizeThumb in api.js) and
// the gallery then loads only the thumbnail. All generation is best-effort: if the
// browser can't decode the file (exotic codecs, etc.) we return null and the item
// just falls back to an icon — a missing thumbnail never blocks the upload.

const MAX_THUMB_DIM = 480; // longest edge, px
const THUMB_QUALITY = 0.7;
const LOAD_TIMEOUT_MS = 15000;

function fitWithin(w, h) {
  if (!w || !h) return { w: MAX_THUMB_DIM, h: MAX_THUMB_DIM };
  const scale = Math.min(1, MAX_THUMB_DIM / Math.max(w, h));
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

function drawToWebp(source, srcW, srcH) {
  const { w, h } = fitWithin(srcW, srcH);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(source, 0, 0, w, h);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/webp", THUMB_QUALITY);
  });
}

async function imageThumbnail(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      const timer = setTimeout(
        () => reject(new Error("image timeout")),
        LOAD_TIMEOUT_MS,
      );
      el.onload = () => {
        clearTimeout(timer);
        resolve(el);
      };
      el.onerror = () => {
        clearTimeout(timer);
        reject(new Error("image decode failed"));
      };
      el.src = url;
    });
    return await drawToWebp(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function videoThumbnail(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    video.src = url;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("video timeout")),
        LOAD_TIMEOUT_MS,
      );
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("video decode failed"));
      };
    });
    // Seek slightly in so we don't capture a black leading frame.
    const target =
      Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(1, video.duration / 2)
        : 0;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, LOAD_TIMEOUT_MS); // draw whatever we have
      video.onseeked = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        video.currentTime = target;
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    return await drawToWebp(video, video.videoWidth, video.videoHeight);
  } finally {
    video.removeAttribute("src");
    try {
      video.load();
    } catch {
      // ignore
    }
    URL.revokeObjectURL(url);
  }
}

// Returns a webp Blob for image/video files, or null (unsupported type or any
// failure). Never throws.
export async function generateThumbnail(file) {
  if (!file || typeof document === "undefined") return null;
  try {
    if (file.type.startsWith("image/")) return await imageThumbnail(file);
    if (file.type.startsWith("video/")) return await videoThumbnail(file);
  } catch {
    return null;
  }
  return null;
}

// Best-effort PUT of a thumbnail blob to its presigned R2 URL. The presigned PUT
// signs only `host`, so no extra headers are needed. Returns true on success.
export async function putThumbnail(url, blob) {
  if (!url || !blob) return false;
  try {
    const res = await fetch(url, { method: "PUT", body: blob });
    return res.ok;
  } catch {
    return false;
  }
}

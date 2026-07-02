import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";
import { env } from "./config.js";

// ── Constants ─────────────────────────────────────────────────────────────────

// R2 supports up to 5 TB via multipart; we switch to multipart above this
// threshold so the browser doesn't block on a single huge PUT.
export const MULTIPART_THRESHOLD = 300 * 1024 * 1024; // 300 MB
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB hard cap
export const DEFAULT_PUBLIC_FILE_LIMIT = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_PUBLIC_MAX_FILES = 5;
const MULTIPART_PART_SIZE = 100 * 1024 * 1024; // 100 MB per part
const PRESIGN_EXPIRY_SECONDS = 900; // 15-minute upload window

// Whitelisted MIME types. Staff are trusted; public uploads are more restricted.
export const STAFF_ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/ogg",
  "video/3gpp",
  "video/3gpp2",
]);

export const PUBLIC_ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

// ── R2 client (lazy-initialized, singleton) ───────────────────────────────────

let _r2Client = null;

function getR2Client() {
  if (!_r2Client) {
    _r2Client = new S3Client({
      region: "auto",
      endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.r2AccessKeyId,
        secretAccessKey: env.r2SecretAccessKey,
      },
      // Disable automatic checksum calculation — presigned PUT URLs are sent
      // directly from the browser via XHR which cannot compute CRC32 headers.
      requestChecksumCalculation: "when_required",
      responseChecksumValidation: "when_required",
    });
  }
  return _r2Client;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function r2Configured() {
  return !!(
    env.r2AccountId &&
    env.r2AccessKeyId &&
    env.r2SecretAccessKey &&
    env.r2BucketName
  );
}

// ── Signed media URLs ─────────────────────────────────────────────────────────
// Media is no longer served from a public bucket domain. Files are streamed
// through GET /api/media/:mediaId/file, authorized by an HMAC signature in the
// query string. Signed paths are only minted inside authenticated API
// responses, so possessing a valid URL implies a panel login (or a fresh link
// shared by someone with one — links expire after at most 2 windows).
//
// The expiry is bucketed to MEDIA_URL_WINDOW_SECONDS so every URL minted
// within the same window is byte-identical → Cloudflare's edge cache (keyed by
// full URL) gets real hit rates instead of one cache entry per page load.

const MEDIA_URL_WINDOW_SECONDS = 6 * 3600; // links live 6-12 h, stable per 6 h

function mediaSignature(mediaId, exp) {
  return crypto
    .createHmac("sha256", env.jwtSecret)
    .update(`media:${mediaId}:${exp}`)
    .digest("base64url");
}

export function signedMediaPath(mediaId) {
  if (!env.jwtSecret) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp =
    (Math.floor(now / MEDIA_URL_WINDOW_SECONDS) + 2) * MEDIA_URL_WINDOW_SECONDS;
  return `/api/media/${mediaId}/file?e=${exp}&s=${mediaSignature(mediaId, exp)}`;
}

export function verifyMediaSignature(mediaId, exp, sig) {
  if (!env.jwtSecret) return false;
  const expNum = Number(exp);
  if (!Number.isInteger(expNum)) return false;
  if (expNum < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(mediaSignature(mediaId, expNum));
  const provided = Buffer.from(String(sig ?? ""));
  return (
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected)
  );
}

export function sanitizeFilename(name) {
  return (
    String(name ?? "upload")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^[._-]+/, "")
      .slice(0, 120) || "file"
  );
}

export function buildObjectKey(orgId, subfolder, filename) {
  const uuid = crypto.randomUUID();
  const safe = sanitizeFilename(filename);
  return `org/${orgId}/${subfolder}/${uuid}_${safe}`;
}

// ── Presigned single-part PUT (files < 300 MB) ────────────────────────────────

export async function generatePresignedPut(key, mimeType, _fileSizeBytes) {
  // IMPORTANT: a SigV4 *presigned* PUT signs only the `host` header — neither
  // Content-Type nor Content-Length end up in X-Amz-SignedHeaders. That means
  // the browser can PUT arbitrary bytes with an arbitrary Content-Type to this
  // key regardless of what we pass here. So this URL enforces NOTHING about the
  // uploaded content — the real controls are:
  //   1. The MIME allow-list check at prepare time (declared type only).
  //   2. handleConfirmMedia, which HeadObjects the real size (quota/limit
  //      enforcement) and CopyObjects the object to pin a vetted Content-Type
  //      (neutralising text/html / image/svg+xml stored-XSS).
  // We still set ContentType as a best-effort hint for the (honest) client.
  const cmd = new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    ...(mimeType ? { ContentType: String(mimeType) } : {}),
  });
  return getSignedUrl(getR2Client(), cmd, {
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });
}

// ── Presigned multipart (files >= 300 MB) ─────────────────────────────────────
// R2 supports CreateMultipartUpload / UploadPart / CompleteMultipartUpload
// via its S3-compatible API. Each UploadPart URL is presigned individually.

export async function generatePresignedMultipart(key, mimeType, fileSizeBytes) {
  const client = getR2Client();

  // For multipart, ContentType is bound server-side here (not client-controlled),
  // so unlike the single presigned PUT it cannot be spoofed. `inline` disposition
  // keeps images/videos viewable while the vetted MIME keeps active types inert.
  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: env.r2BucketName,
      Key: key,
      ContentType: mimeType,
      ContentDisposition: "inline",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  const partCount = Math.ceil(fileSizeBytes / MULTIPART_PART_SIZE);
  const partUrls = [];
  for (let i = 1; i <= partCount; i++) {
    const url = await getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: env.r2BucketName,
        Key: key,
        UploadId,
        PartNumber: i,
      }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    );
    partUrls.push(url);
  }

  return { uploadId: UploadId, partUrls, partSize: MULTIPART_PART_SIZE };
}

export async function completeMultipartUpload(key, uploadId, parts) {
  await getR2Client().send(
    new CompleteMultipartUploadCommand({
      Bucket: env.r2BucketName,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

export async function abortMultipartUpload(key, uploadId) {
  try {
    await getR2Client().send(
      new AbortMultipartUploadCommand({
        Bucket: env.r2BucketName,
        Key: key,
        UploadId: uploadId,
      }),
    );
  } catch {
    // best-effort
  }
}

// ── Post-upload verification / finalization ───────────────────────────────────

// Read an object's true size + stored Content-Type straight from R2. Used at
// confirm time because a presigned PUT cannot bind content-length, so the size
// the client declared at prepare time is untrusted. Returns null on 404.
export async function headObject(key) {
  try {
    const res = await getR2Client().send(
      new HeadObjectCommand({ Bucket: env.r2BucketName, Key: key }),
    );
    return {
      contentLength: Number(res.ContentLength ?? 0),
      contentType: res.ContentType ?? null,
    };
  } catch (err) {
    if (
      err?.$metadata?.httpStatusCode === 404 ||
      err?.name === "NotFound" ||
      err?.name === "NoSuchKey"
    )
      return null;
    throw err;
  }
}

// Stream an object's bytes for the signed media file endpoint. `range` is the
// raw HTTP Range header from the client (forwarded verbatim so <video> seeking
// works). Returns null on 404 and { rangeError: true } on an unsatisfiable
// range so the caller can answer 416.
export async function getMediaObject(key, range) {
  try {
    const res = await getR2Client().send(
      new GetObjectCommand({
        Bucket: env.r2BucketName,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
    );
    return {
      body: res.Body?.transformToWebStream
        ? res.Body.transformToWebStream()
        : res.Body,
      contentLength:
        res.ContentLength != null ? Number(res.ContentLength) : null,
      contentRange: res.ContentRange ?? null,
      etag: res.ETag ?? null,
      status: res.ContentRange ? 206 : 200,
    };
  } catch (err) {
    if (
      err?.$metadata?.httpStatusCode === 404 ||
      err?.name === "NotFound" ||
      err?.name === "NoSuchKey"
    )
      return null;
    if (err?.$metadata?.httpStatusCode === 416 || err?.name === "InvalidRange")
      return { rangeError: true };
    throw err;
  }
}

// Rewrite the stored object's metadata in place (self-copy with REPLACE) to pin
// a known-safe, allow-listed Content-Type and mark it inline + long-cache. This
// is the security control that guarantees the bytes are served as the vetted
// MIME (never attacker-supplied text/html or image/svg+xml), since the presigned
// PUT itself cannot enforce Content-Type. `key` segments are already sanitized to
// a URL-safe charset by buildObjectKey, so encodeURI leaves them intact.
export async function normalizeObjectContentType(key, contentType) {
  await getR2Client().send(
    new CopyObjectCommand({
      Bucket: env.r2BucketName,
      Key: key,
      CopySource: encodeURI(`${env.r2BucketName}/${key}`),
      MetadataDirective: "REPLACE",
      ContentType: contentType || "application/octet-stream",
      ContentDisposition: "inline",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

// ── Bucket diagnostics ────────────────────────────────────────────────────────

export async function testR2BucketWriteDelete() {
  const testKey = `healthcheck/${Date.now()}_${crypto.randomUUID()}.txt`;
  const client = getR2Client();

  await client.send(
    new PutObjectCommand({
      Bucket: env.r2BucketName,
      Key: testKey,
      Body: "ironsight-r2-healthcheck",
      ContentType: "text/plain",
    }),
  );

  await client.send(
    new DeleteObjectCommand({
      Bucket: env.r2BucketName,
      Key: testKey,
    }),
  );

  return { key: testKey };
}

// ── Object deletion ───────────────────────────────────────────────────────────

export async function deleteMediaObject(key) {
  if (!key) return;
  try {
    await getR2Client().send(
      new DeleteObjectCommand({ Bucket: env.r2BucketName, Key: key }),
    );
  } catch (err) {
    console.error(`[r2] delete failed key=${key}:`, err?.message);
  }
}

import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
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
  "application/pdf",
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
  return !!(env.r2AccountId && env.r2AccessKeyId && env.r2SecretAccessKey && env.r2BucketName);
}

export function getPublicUrl(key) {
  if (!env.r2PublicUrl) return null;
  return `${env.r2PublicUrl}/${key}`;
}

export function sanitizeFilename(name) {
  return String(name ?? "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 120) || "file";
}

export function buildObjectKey(orgId, subfolder, filename) {
  const uuid = crypto.randomUUID();
  const safe = sanitizeFilename(filename);
  return `org/${orgId}/${subfolder}/${uuid}_${safe}`;
}

// ── Presigned single-part PUT (files < 300 MB) ────────────────────────────────

export async function generatePresignedPut(key, _mimeType, _fileSizeBytes) {
  const cmd = new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
  });
  return getSignedUrl(getR2Client(), cmd, { expiresIn: PRESIGN_EXPIRY_SECONDS });
}

// ── Presigned multipart (files >= 300 MB) ─────────────────────────────────────
// R2 supports CreateMultipartUpload / UploadPart / CompleteMultipartUpload
// via its S3-compatible API. Each UploadPart URL is presigned individually.

export async function generatePresignedMultipart(key, mimeType, fileSizeBytes) {
  const client = getR2Client();

  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: env.r2BucketName,
      Key: key,
      ContentType: mimeType,
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

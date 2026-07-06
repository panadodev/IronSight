// R2 media handlers: presigned upload prepare/confirm (staff + public), signed streaming, thumbnails, quotas, expiry purge. Pure relocation from api.js.

import {
  checkRateLimit,
  isGlobalAdmin,
  isConfiguredSysAdmin,
  canManageOrg,
  orgHasPermission,
  requireSession,
  listUserOrganizations,
} from "../core.js";
import { json } from "../http.js";
import { pool } from "../runtime.js";
import { env } from "../config.js";
import {
  MULTIPART_THRESHOLD,
  MAX_FILE_SIZE,
  DEFAULT_USER_STORAGE_BYTES,
  DEFAULT_PUBLIC_FILE_LIMIT,
  DEFAULT_PUBLIC_MAX_FILES,
  MAX_THUMB_SIZE,
  STAFF_ALLOWED_MIME,
  PUBLIC_ALLOWED_MIME,
  r2Configured,
  signedMediaPath,
  signedMediaThumbPath,
  thumbKeyFor,
  verifyMediaSignature,
  sanitizeFilename,
  buildObjectKey,
  generatePresignedPut,
  generatePresignedMultipart,
  completeMultipartUpload,
  abortMultipartUpload,
  headObject,
  getMediaObject,
  normalizeObjectContentType,
  deleteMediaObject,
} from "../r2.js";

// ── R2 / S3 media integration ─────────────────────────────────────────────────

export function mediaFileType(mimeType) {
  if (!mimeType) return "other";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "other";
}

export function resolveMediaUrl(r) {
  // R2 media is served through the signed /api/media/:id/file endpoint — the
  // raw bucket URL is never exposed, so viewing requires a link minted for a
  // logged-in panel user.
  if (r.r2_key) return signedMediaPath(String(r.media_id));
  return r.zipline_url ? String(r.zipline_url) : null; // legacy Zipline fallback
}

export function serializeMedia(r) {
  return {
    mediaId: String(r.media_id),
    orgId: String(r.org_id),
    uploadedBy: r.uploaded_by ? String(r.uploaded_by) : null,
    uploadedByName: r.uploaded_by_name ?? null,
    url: resolveMediaUrl(r),
    // Small gallery thumbnail; null falls the frontend back to an icon (video)
    // or the original (legacy images) without a full-object R2 fetch.
    thumbUrl: r.thumb_key ? signedMediaThumbPath(String(r.media_id)) : null,
    filename: String(r.filename),
    fileType: String(r.file_type),
    mimeType: r.mime_type ?? null,
    fileSize: r.file_size != null ? Number(r.file_size) : null,
    title: r.title ?? "",
    uploadedAt: Number(r.uploaded_at),
    lastAccessedAt:
      r.last_accessed_at != null ? Number(r.last_accessed_at) : null,
    storageBackend: r.storage_backend ?? "zipline",
    ...(r.source !== undefined ? { source: r.source } : {}),
  };
}

// Validate a client-uploaded thumbnail sitting at thumbKeyFor(r2Key): it must
// exist and be within MAX_THUMB_SIZE. Returns the thumb key to store, or null
// (discarding an oversized/empty object). Best-effort and never throws — a
// missing or bad thumbnail is cosmetic and must not fail the main upload. Like
// the main file, the thumb is only ever served via handleGetMediaThumb, which
// forces Content-Type: image/webp + nosniff, so the object's stored content-type
// is never trusted and no normalize/CopyObject is needed here.
export async function finalizeThumb(r2Key) {
  const thumbKey = thumbKeyFor(String(r2Key));
  try {
    const head = await headObject(thumbKey);
    if (!head || head.contentLength < 1) return null;
    if (head.contentLength > MAX_THUMB_SIZE) {
      await deleteMediaObject(thumbKey);
      return null;
    }
    return thumbKey;
  } catch (err) {
    console.error(`[r2] thumb verify failed key=${thumbKey}:`, err?.message);
    return null;
  }
}

// Returns bytes currently used by confirmed media for an org (staff only).
export async function getOrgStorageUsed(orgId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(file_size), 0)::BIGINT AS used
     FROM org_media WHERE org_id = $1 AND deleted = FALSE AND confirmed = TRUE AND source = 'staff'`,
    [orgId],
  );
  return Number(rows[0].used);
}

// Returns bytes used by a specific user within an org.
export async function getUserStorageUsed(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(file_size), 0)::BIGINT AS used
     FROM org_media WHERE org_id = $1 AND uploaded_by = $2 AND deleted = FALSE AND confirmed = TRUE AND source = 'staff'`,
    [orgId, userId],
  );
  return Number(rows[0].used);
}

// Decides whether `session` may stream a given media row (handleGetMediaFile).
// A valid signed URL only proves the link came out of one of our API responses;
// this is what actually stops a shared link from working for anyone who isn't
// entitled to the underlying ticket/ban/media.
export async function canViewMediaFile(session, media) {
  if (isGlobalAdmin(session)) return true;
  const orgId = String(media.org_id);
  // The uploader can always see their own upload — this is what lets a public
  // ticket submitter view the clips they attached to their own ticket.
  if (String(media.uploaded_by) === String(session.userId)) return true;
  // Org admins/owners can see anything in their org.
  if (canManageOrg(session, orgId)) return true;

  const hasBanReviewPerm =
    orgHasPermission(session, orgId, "players_view") ||
    orgHasPermission(session, orgId, "bans_create") ||
    orgHasPermission(session, orgId, "bans_manage");

  if (media.source === "staff") {
    // Staff-uploaded media (media library + ban evidence).
    return hasBanReviewPerm || orgHasPermission(session, orgId, "media_upload");
  }

  if (media.source === "ticket") {
    // Staff who can view tickets, or the submitter of the ticket this media is
    // attached to (covers a staffer attaching evidence to the submitter's ticket).
    if (
      orgHasPermission(session, orgId, "tickets_view") ||
      orgHasPermission(session, orgId, "tickets_manage")
    )
      return true;
    const { rows } = await pool.query(
      `SELECT 1 FROM ticket_media_links tml
       JOIN tickets t ON t.ticket_id = tml.ticket_id
       WHERE tml.media_id = $1 AND t.created_by = $2 LIMIT 1`,
      [media.media_id, session.userId],
    );
    if (rows.length > 0) return true;
    // Otherwise fall through to the ban-evidence check below.
  }

  // User-submitted media ('ticket'/'pending') a staffer attached to a ban as
  // evidence: viewable by anyone who can review that ban, even without
  // tickets_view — the people meant to review the evidence. Only reached for
  // non-'staff' sources (staff media returned above), so this query stays off
  // the staff-gallery hot path.
  if (hasBanReviewPerm) {
    const { rows } = await pool.query(
      `SELECT 1 FROM ban_media_links bml
       JOIN player_bans b ON b.ban_id = bml.ban_id
       WHERE bml.media_id = $1 AND b.org_id = $2 LIMIT 1`,
      [media.media_id, orgId],
    );
    if (rows.length > 0) return true;
  }

  // 'pending' (unattached public upload) and anything else: only the uploader,
  // already allowed above.
  return false;
}

// Streams a media object's bytes. Authorization is TWO-part: a valid HMAC
// signature in the query string (minted by signedMediaPath inside authenticated
// API responses) AND a signed-in panel session that `canViewMediaFile` clears.
// The signature alone is deliberately NOT enough — otherwise anyone the link is
// shared with could stream the file for its 6-12h window, turning R2 into a free
// video host. Cookies ride along on same-origin <img>/<video> requests, so
// in-panel playback stays transparent. Because the decision is now per-user, the
// response is marked `private` and is no longer edge-cacheable. Forwards the
// Range header so <video> elements can seek without downloading the whole file.
export async function handleGetMediaFile(request, mediaId) {
  const url = new URL(request.url);
  if (
    !verifyMediaSignature(
      mediaId,
      url.searchParams.get("e"),
      url.searchParams.get("s"),
    )
  )
    return json({ error: "Invalid or expired media link" }, 403);

  const { session, error } = await requireSession(request);
  if (error) return error;

  const { rows } = await pool.query(
    `SELECT media_id, org_id, uploaded_by, source, r2_key, mime_type, filename, file_size
     FROM org_media
     WHERE media_id = $1 AND deleted = FALSE AND confirmed = TRUE`,
    [mediaId],
  );
  if (!rows[0]?.r2_key) return json({ error: "Media not found" }, 404);
  const row = rows[0];

  if (!(await canViewMediaFile(session, row)))
    return json({ error: "Forbidden" }, 403);

  let obj;
  try {
    obj = await getMediaObject(
      String(row.r2_key),
      request.headers.get("range"),
    );
  } catch (err) {
    console.error(`[r2] get failed mediaId=${mediaId}:`, err?.message);
    return json({ error: "Failed to fetch media" }, 502);
  }
  if (!obj) return json({ error: "Media not found" }, 404);
  if (obj.rangeError)
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${Number(row.file_size ?? 0)}` },
    });

  // Keeps the org media-expiry window honest for files that are still viewed.
  // Edge-cached hits skip the origin (and this update) — acceptable drift.
  pool
    .query(
      `UPDATE org_media SET last_accessed_at = unix_now() WHERE media_id = $1`,
      [mediaId],
    )
    .catch(() => {});

  const headers = new Headers({
    // Serve the DB's vetted MIME (pinned at confirm time), never a sniffable one.
    "Content-Type": String(row.mime_type || "application/octet-stream"),
    "Content-Disposition": `inline; filename="${sanitizeFilename(row.filename)}"`,
    // Per-user authorized now, so it must NOT land in any shared/edge cache —
    // only the requesting user's own browser cache. URL still rotates with the
    // signature window so those private copies age out safely.
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
  if (obj.contentLength != null)
    headers.set("Content-Length", String(obj.contentLength));
  if (obj.contentRange) headers.set("Content-Range", obj.contentRange);
  if (obj.etag) headers.set("ETag", obj.etag);
  return new Response(obj.body, { status: obj.status, headers });
}

// Streams a media item's small gallery thumbnail. Same two-part authorization as
// handleGetMediaFile (HMAC signature + session cleared by canViewMediaFile), so a
// leaked thumb link is no more useful than a leaked file link. The whole point is
// that the gallery hits this — a ~15 KB webp — instead of range-fetching the full
// original out of R2 for every row. Content-Type is forced to image/webp + nosniff,
// so the stored object's type is never trusted (no normalize needed at confirm).
export async function handleGetMediaThumb(request, mediaId) {
  const url = new URL(request.url);
  if (
    !verifyMediaSignature(
      mediaId,
      url.searchParams.get("e"),
      url.searchParams.get("s"),
    )
  )
    return json({ error: "Invalid or expired media link" }, 403);

  const { session, error } = await requireSession(request);
  if (error) return error;

  const { rows } = await pool.query(
    `SELECT media_id, org_id, uploaded_by, source, thumb_key
     FROM org_media
     WHERE media_id = $1 AND deleted = FALSE AND confirmed = TRUE`,
    [mediaId],
  );
  if (!rows[0]?.thumb_key) return json({ error: "Thumbnail not found" }, 404);
  const row = rows[0];

  if (!(await canViewMediaFile(session, row)))
    return json({ error: "Forbidden" }, 403);

  let obj;
  try {
    obj = await getMediaObject(String(row.thumb_key), null);
  } catch (err) {
    console.error(`[r2] thumb get failed mediaId=${mediaId}:`, err?.message);
    return json({ error: "Failed to fetch thumbnail" }, 502);
  }
  if (!obj) return json({ error: "Thumbnail not found" }, 404);

  const headers = new Headers({
    "Content-Type": "image/webp",
    "Content-Disposition": "inline",
    // Per-user authorized, so private-only like the file endpoint. Thumbs are
    // immutable, so allow a longer browser cache to keep repeat gallery scrolls
    // off the origin.
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  if (obj.contentLength != null)
    headers.set("Content-Length", String(obj.contentLength));
  if (obj.etag) headers.set("ETag", obj.etag);
  return new Response(obj.body, { status: 200, headers });
}

export async function handleListAllMedia(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const url = new URL(request.url);
  const limitParam = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10),
  );
  const fileType = url.searchParams.get("type") ?? null;
  const orgFilter = url.searchParams.get("org")?.trim() || null;
  const sysAdmin = isConfiguredSysAdmin(session);
  // 'public' lists media submitted through the public ticket flow (source
  // 'ticket'/'pending'); it is visible only to org admins/owners (and sysadmin).
  // Default 'staff' keeps the original behaviour (media library + ban evidence).
  const isPublic = url.searchParams.get("source") === "public";

  const conditions = [
    "m.deleted = FALSE",
    "m.confirmed = TRUE",
    isPublic ? "m.source IN ('ticket','pending')" : "m.source = 'staff'",
  ];
  const params = [];
  let paramIdx = 1;
  let quotaOrgIds = [];

  if (!sysAdmin) {
    const userOrgs = await listUserOrganizations(session.userId);
    if (userOrgs.length === 0)
      return json({ media: [], total: 0, isSysAdmin: false, userQuotas: [] });

    const allOrgIds = userOrgs.map((o) => String(o.orgId));
    // Quota bars always reflect every org the user belongs to, even when the
    // list itself is narrowed to one org.
    quotaOrgIds = allOrgIds;

    // Org filter: silently scoped to the caller's own orgs — a non-member
    // orgId yields an empty list, never another tenant's media.
    const orgIds = orgFilter
      ? allOrgIds.filter((id) => id === orgFilter)
      : allOrgIds;
    if (orgIds.length === 0)
      return json({
        media: [],
        total: 0,
        isSysAdmin: false,
        userQuotas: [],
      });
    const elevatedOrgSet = new Set(
      Array.isArray(session.orgAdminOrgIds)
        ? session.orgAdminOrgIds.map((id) => String(id))
        : [],
    );
    const elevatedOrgIds = orgIds.filter((id) => elevatedOrgSet.has(id));
    const personalOrgIds = orgIds.filter((id) => !elevatedOrgSet.has(id));
    const scopeClauses = [];

    if (elevatedOrgIds.length > 0) {
      scopeClauses.push(`m.org_id = ANY($${paramIdx++}::text[])`);
      params.push(elevatedOrgIds);
    }

    // Public submissions are org-manager-only, so a plain staffer never sees
    // them via their personal-org scope — skip that clause on the public tab.
    if (!isPublic && personalOrgIds.length > 0) {
      const personalOrgsParam = paramIdx++;
      const userParam = paramIdx++;
      scopeClauses.push(
        `(m.org_id = ANY($${personalOrgsParam}::text[]) AND m.uploaded_by = $${userParam})`,
      );
      params.push(personalOrgIds, session.userId);
    }

    if (scopeClauses.length === 0)
      return json({ media: [], total: 0, isSysAdmin: false, userQuotas: [] });

    conditions.push(`(${scopeClauses.join(" OR ")})`);
  }

  if (sysAdmin && orgFilter) {
    conditions.push(`m.org_id = $${paramIdx++}`);
    params.push(orgFilter);
  }

  if (fileType && ["image", "video", "other"].includes(fileType)) {
    conditions.push(`m.file_type = $${paramIdx++}`);
    params.push(fileType);
  }

  const where = conditions.join(" AND ");

  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.uploaded_by, m.r2_key, m.thumb_key, m.storage_backend,
            m.zipline_url, m.filename, m.file_type, m.mime_type, m.file_size, m.title,
            m.uploaded_at, m.last_accessed_at,
            u.username AS uploaded_by_name,
            o.name AS org_name
     FROM org_media m
     LEFT JOIN users u ON u.user_id = m.uploaded_by
     LEFT JOIN organizations o ON o.org_id = m.org_id
     WHERE ${where}
     ORDER BY m.uploaded_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limitParam, offset],
  );

  const countRes = await pool.query(
    `SELECT COUNT(*) AS total FROM org_media m WHERE ${where}`,
    params,
  );

  // Per-org storage quota for the current user (staff uploads only; not shown
  // to sysadmin or on the public tab).
  let userQuotas = [];
  if (!sysAdmin && !isPublic && quotaOrgIds.length > 0) {
    const { rows: qRows } = await pool.query(
      `SELECT o.org_id, o.name, o.media_user_limit_bytes,
              om.media_user_limit_bytes AS member_user_limit_bytes,
              COALESCE(SUM(m.file_size), 0)::BIGINT AS user_used
       FROM organizations o
       LEFT JOIN organization_members om ON om.org_id = o.org_id AND om.user_id = $2
       LEFT JOIN org_media m
         ON m.org_id = o.org_id
         AND m.uploaded_by = $2
         AND m.deleted = FALSE
         AND m.confirmed = TRUE
         AND m.source = 'staff'
       WHERE o.org_id = ANY($1::text[])
       GROUP BY o.org_id, o.name, o.media_user_limit_bytes, om.media_user_limit_bytes`,
      [quotaOrgIds, session.userId],
    );
    userQuotas = qRows.map((r) => ({
      orgId: String(r.org_id),
      orgName: r.name ?? null,
      used: Number(r.user_used),
      limit:
        r.member_user_limit_bytes != null
          ? Number(r.member_user_limit_bytes)
          : r.media_user_limit_bytes != null
            ? Number(r.media_user_limit_bytes)
            : DEFAULT_USER_STORAGE_BYTES,
    }));
  }

  return json({
    media: rows.map((r) => ({ ...serializeMedia(r), orgName: r.org_name })),
    total: Number(countRes.rows[0].total),
    isSysAdmin: sysAdmin,
    userQuotas,
  });
}

export async function handleListOrgMedia(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const canManage =
    canManageOrg(session, orgId) || isConfiguredSysAdmin(session);
  if (
    !canManage &&
    !orgHasPermission(session, orgId, "players_view") &&
    !orgHasPermission(session, orgId, "bans_create") &&
    !orgHasPermission(session, orgId, "bans_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const url = new URL(request.url);
  const limitParam = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10),
  );
  const fileType = url.searchParams.get("type") ?? null;

  // `source=public` lists media players submitted through the public ticket
  // flow so staff can attach a reporter's clips/screenshots as ban evidence.
  // User submissions are ticket content, so browsing them is gated on
  // ticket-viewing (which is also what `canViewMediaFile` clears for these
  // 'ticket' items) rather than the ban perms — a ban-only staffer without
  // tickets access would just get broken thumbnails. In-flight 'pending'
  // uploads (never promoted to a ticket) are excluded.
  const isPublic = url.searchParams.get("source") === "public";
  if (
    isPublic &&
    !canManage &&
    !orgHasPermission(session, orgId, "tickets_view") &&
    !orgHasPermission(session, orgId, "tickets_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const conditions = [
    "m.org_id = $1",
    "m.deleted = FALSE",
    "m.confirmed = TRUE",
    isPublic ? "m.source = 'ticket'" : "m.source = 'staff'",
  ];
  const params = [orgId];
  let paramIdx = 2;

  // A plain staffer's own gallery is scoped to their uploads; the public tab is
  // already gated on ban permissions above, so it shows all org submissions.
  if (!isPublic && !canManage) {
    conditions.push(`m.uploaded_by = $${paramIdx++}`);
    params.push(session.userId);
  }

  if (fileType && ["image", "video", "other"].includes(fileType)) {
    conditions.push(`m.file_type = $${paramIdx++}`);
    params.push(fileType);
  }

  const where = conditions.join(" AND ");

  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.uploaded_by, m.r2_key, m.thumb_key, m.storage_backend,
            m.zipline_url, m.filename, m.file_type, m.mime_type, m.file_size, m.title,
            m.uploaded_at, m.last_accessed_at, m.source,
            u.username AS uploaded_by_name
     FROM org_media m
     LEFT JOIN users u ON u.user_id = m.uploaded_by
     WHERE ${where}
     ORDER BY m.uploaded_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limitParam, offset],
  );

  const countRes = await pool.query(
    `SELECT COUNT(*) AS total FROM org_media m WHERE ${where}`,
    params,
  );

  const total = Number(countRes.rows[0].total);
  return json({ media: rows.map(serializeMedia), total });
}

// Phase 1: validate, check quotas, generate presigned upload URL.
export async function handlePrepareMedia(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId) && !isConfiguredSysAdmin(session)) {
    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND role_id != 'org_disabled' LIMIT 1`,
      [orgId, session.userId],
    );
    if (!memberRows[0]) return json({ error: "Forbidden" }, 403);
    if (!orgHasPermission(session, orgId, "media_upload"))
      return json({ error: "Forbidden" }, 403);
  }

  if (!r2Configured())
    return json(
      {
        error:
          "R2 storage is not configured on this server. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME.",
      },
      503,
    );

  const rl = await checkRateLimit(
    `rl:media-prepare:${session.userId}`,
    env.mediaPrepareRateLimitPerMinute,
    60,
  );
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const filename = String(body?.filename ?? "upload").slice(0, 255);
  const mimeType = String(body?.mimeType ?? "")
    .trim()
    .toLowerCase();
  const fileSize = Number(body?.fileSize ?? 0);
  const title = String(body?.title ?? "")
    .trim()
    .slice(0, 255);

  if (!STAFF_ALLOWED_MIME.has(mimeType))
    return json({ error: `File type not allowed: ${mimeType}` }, 415);
  if (!fileSize || fileSize < 1)
    return json({ error: "fileSize is required" }, 400);
  if (fileSize > MAX_FILE_SIZE)
    return json(
      {
        error: `File too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024 / 1024)} GB)`,
      },
      413,
    );

  // Check org storage quota.
  const orgRes = await pool.query(
    `SELECT o.media_storage_limit_bytes, o.media_user_limit_bytes,
            om.media_user_limit_bytes AS member_user_limit_bytes
     FROM organizations o
     LEFT JOIN organization_members om ON om.org_id = o.org_id AND om.user_id = $2
     WHERE o.org_id = $1 LIMIT 1`,
    [orgId, session.userId],
  );
  const orgRow = orgRes.rows[0];
  if (orgRow?.media_storage_limit_bytes) {
    const used = await getOrgStorageUsed(orgId);
    if (used + fileSize > Number(orgRow.media_storage_limit_bytes))
      return json({ error: "Organization storage quota exceeded." }, 413);
  }
  {
    const effectiveUserLimit =
      orgRow?.member_user_limit_bytes != null
        ? Number(orgRow.member_user_limit_bytes)
        : orgRow?.media_user_limit_bytes != null
          ? Number(orgRow.media_user_limit_bytes)
          : DEFAULT_USER_STORAGE_BYTES;
    const used = await getUserStorageUsed(orgId, session.userId);
    if (used + fileSize > effectiveUserLimit)
      return json(
        { error: "Your personal storage quota for this organization is full." },
        413,
      );
  }

  const r2Key = buildObjectKey(orgId, `user/${session.userId}`, filename);
  const nowSec = Math.floor(Date.now() / 1000);

  let uploadUrl = null;
  let multipart = null;

  if (fileSize >= MULTIPART_THRESHOLD) {
    multipart = await generatePresignedMultipart(r2Key, mimeType, fileSize);
  } else {
    uploadUrl = await generatePresignedPut(r2Key, mimeType, fileSize);
  }

  // Client-generated gallery thumbnail (best-effort, image/video only). The
  // browser PUTs a small webp to this key; confirm HeadObjects + size-caps it
  // before trusting it. 'other' files get no thumb.
  const fileType = mediaFileType(mimeType);
  const thumbUploadUrl =
    fileType === "image" || fileType === "video"
      ? await generatePresignedPut(thumbKeyFor(r2Key), "image/webp")
      : null;

  const { rows } = await pool.query(
    `INSERT INTO org_media
       (org_id, uploaded_by, filename, file_type, mime_type, file_size, title,
        r2_key, storage_backend, source, confirmed, pending_since, multipart_upload_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'r2','staff',FALSE,$9,$10)
     RETURNING media_id`,
    [
      orgId,
      session.userId,
      filename,
      fileType,
      mimeType,
      fileSize,
      title,
      r2Key,
      nowSec,
      multipart?.uploadId ?? null,
    ],
  );
  const mediaId = String(rows[0].media_id);

  console.log(
    `[r2] prepare org=${orgId} user=${session.userId} key=${r2Key} size=${fileSize} multipart=${!!multipart}`,
  );
  return json(
    {
      uploadUrl,
      thumbUploadUrl,
      mediaId,
      multipart: multipart ? { ...multipart, key: r2Key } : null,
    },
    200,
  );
}

// Phase 2: confirm the upload completed, mark the record active.
export async function handleConfirmMedia(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId) && !isConfiguredSysAdmin(session)) {
    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND role_id != 'org_disabled' LIMIT 1`,
      [orgId, session.userId],
    );
    if (!memberRows[0]) return json({ error: "Forbidden" }, 403);
    if (!orgHasPermission(session, orgId, "media_upload"))
      return json({ error: "Forbidden" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const mediaId = String(body?.mediaId ?? "").trim();
  if (!mediaId) return json({ error: "mediaId is required" }, 400);

  const { rows } = await pool.query(
    `SELECT media_id, uploaded_by, r2_key, storage_backend, multipart_upload_id, mime_type
     FROM org_media
     WHERE media_id = $1 AND org_id = $2 AND confirmed = FALSE AND deleted = FALSE`,
    [mediaId, orgId],
  );
  if (!rows[0]) return json({ error: "Pending media not found" }, 404);
  const row = rows[0];

  if (
    String(row.uploaded_by) !== String(session.userId) &&
    !canManageOrg(session, orgId)
  )
    return json({ error: "Forbidden" }, 403);

  // Abort the upload + soft-delete the row when a post-upload check fails.
  const discard = async () => {
    if (row.r2_key) {
      if (row.multipart_upload_id)
        await abortMultipartUpload(
          String(row.r2_key),
          String(row.multipart_upload_id),
        );
      await deleteMediaObject(String(row.r2_key));
      await deleteMediaObject(thumbKeyFor(String(row.r2_key)));
    }
    await pool.query(
      `UPDATE org_media SET deleted = TRUE WHERE media_id = $1`,
      [mediaId],
    );
  };

  // For R2 multipart, the frontend sends the ETags from each part so we can complete.
  if (row.multipart_upload_id) {
    const rawParts = Array.isArray(body?.parts) ? body.parts : [];
    const parts = rawParts.map((p) => ({
      partNumber: Number(p?.partNumber),
      etag: String(p?.etag ?? ""),
    }));
    if (
      parts.length === 0 ||
      parts.some(
        (p) => !Number.isInteger(p.partNumber) || p.partNumber < 1 || !p.etag,
      )
    ) {
      await discard();
      return json(
        { error: "Invalid parts array for multipart completion" },
        400,
      );
    }
    try {
      await completeMultipartUpload(
        String(row.r2_key),
        String(row.multipart_upload_id),
        parts,
      );
    } catch (err) {
      console.error(
        `[r2] complete multipart failed mediaId=${mediaId}:`,
        err?.message,
      );
      // Permanent client-side failures (wrong/missing ETags, upload already
      // gone) can never succeed on retry — discard now instead of leaving a
      // dead pending row until the hourly purge. Transient R2 errors stay
      // retryable: the row remains unconfirmed so the client can re-confirm.
      const code = String(err?.name ?? err?.Code ?? "");
      if (
        [
          "InvalidPart",
          "InvalidPartOrder",
          "EntityTooSmall",
          "NoSuchUpload",
        ].includes(code)
      ) {
        await discard();
        return json({ error: "Multipart upload is invalid or expired" }, 400);
      }
      return json({ error: "Failed to complete multipart upload" }, 502);
    }
  }

  // Never trust the client-declared size: a presigned PUT can't bind
  // content-length, so read the true size from R2 and enforce limits/quota
  // against it — closes the "declare 1 byte, upload 5 GB" quota/cost bypass.
  let head;
  try {
    head = await headObject(String(row.r2_key));
  } catch (err) {
    console.error(`[r2] head failed mediaId=${mediaId}:`, err?.message);
    return json({ error: "Failed to verify upload" }, 502);
  }
  if (!head) {
    await discard();
    return json({ error: "Uploaded object not found in storage" }, 404);
  }

  const realSize = head.contentLength;
  if (realSize < 1) {
    await discard();
    return json({ error: "Uploaded file is empty" }, 400);
  }
  if (realSize > MAX_FILE_SIZE) {
    await discard();
    return json(
      {
        error: `File too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024 / 1024)} GB)`,
      },
      413,
    );
  }

  const quotaRes = await pool.query(
    `SELECT o.media_storage_limit_bytes, o.media_user_limit_bytes,
            om.media_user_limit_bytes AS member_user_limit_bytes
     FROM organizations o
     LEFT JOIN organization_members om ON om.org_id = o.org_id AND om.user_id = $2
     WHERE o.org_id = $1 LIMIT 1`,
    [orgId, String(row.uploaded_by)],
  );
  const quota = quotaRes.rows[0];
  if (quota?.media_storage_limit_bytes) {
    const used = await getOrgStorageUsed(orgId);
    if (used + realSize > Number(quota.media_storage_limit_bytes)) {
      await discard();
      return json({ error: "Organization storage quota exceeded." }, 413);
    }
  }
  {
    const effectiveUserLimit =
      quota?.member_user_limit_bytes != null
        ? Number(quota.member_user_limit_bytes)
        : quota?.media_user_limit_bytes != null
          ? Number(quota.media_user_limit_bytes)
          : DEFAULT_USER_STORAGE_BYTES;
    const used = await getUserStorageUsed(orgId, String(row.uploaded_by));
    if (used + realSize > effectiveUserLimit) {
      await discard();
      return json(
        { error: "Personal storage quota for this organization is full." },
        413,
      );
    }
  }

  // Pin a vetted Content-Type on the stored object. Multipart bound it
  // server-side at CreateMultipartUpload already; the single presigned PUT did
  // not (only `host` is signed), so rewrite it here — this is what stops an
  // attacker-supplied text/html / image/svg+xml body from being served as
  // active content from the public bucket domain.
  if (!row.multipart_upload_id) {
    try {
      await normalizeObjectContentType(
        String(row.r2_key),
        String(row.mime_type || "application/octet-stream"),
      );
    } catch (err) {
      console.error(
        `[r2] content-type normalize failed mediaId=${mediaId}:`,
        err?.message,
      );
      await discard();
      return json({ error: "Failed to finalize upload" }, 502);
    }
  }

  // Best-effort gallery thumbnail for image/video (the browser PUT a webp to the
  // thumb key during upload). A missing/oversized thumb just leaves thumb_key NULL.
  const fileType = mediaFileType(String(row.mime_type ?? ""));
  const thumbKey =
    fileType === "image" || fileType === "video"
      ? await finalizeThumb(String(row.r2_key))
      : null;

  const { rows: updated } = await pool.query(
    `UPDATE org_media
     SET confirmed = TRUE, pending_since = NULL, file_size = $2, thumb_key = $3
     WHERE media_id = $1
     RETURNING media_id, org_id, uploaded_by, r2_key, thumb_key, storage_backend, zipline_url,
               filename, file_type, mime_type, file_size, title, uploaded_at, last_accessed_at`,
    [mediaId, realSize, thumbKey],
  );

  console.log(
    `[r2] confirmed mediaId=${mediaId} backend=${row.storage_backend}`,
  );
  return json(
    { media: serializeMedia({ ...updated[0], uploaded_by_name: null }) },
    200,
  );
}

export async function handleDeleteMedia(request, orgId, mediaId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId) && !isConfiguredSysAdmin(session)) {
    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND role_id != 'org_disabled' LIMIT 1`,
      [orgId, session.userId],
    );
    if (!memberRows[0]) return json({ error: "Forbidden" }, 403);
  }

  const { rows } = await pool.query(
    `SELECT media_id, uploaded_by, r2_key, storage_backend, multipart_upload_id FROM org_media
     WHERE media_id = $1 AND org_id = $2 AND deleted = FALSE`,
    [mediaId, orgId],
  );
  if (!rows[0]) return json({ error: "Media not found" }, 404);

  const row = rows[0];
  const isOwner = String(row.uploaded_by) === String(session.userId);
  if (
    !isOwner &&
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "bans_manage")
  )
    return json(
      { error: "Forbidden: you can only delete your own uploads" },
      403,
    );

  // Abort any dangling multipart upload first (frees its parts), then remove the
  // finished object. Only soft-delete the DB row once R2 confirms the object is
  // gone — otherwise a failed bucket delete would orphan the bytes in storage
  // while the row disappears from the panel.
  if (row.multipart_upload_id) {
    await abortMultipartUpload(
      String(row.r2_key),
      String(row.multipart_upload_id),
    );
  }
  if (row.r2_key) {
    const removed = await deleteMediaObject(String(row.r2_key));
    if (!removed)
      return json(
        { error: "Failed to delete file from storage. Please try again." },
        502,
      );
    // Thumbnail is derived + optional; a failed thumb delete shouldn't block the
    // row soft-delete (worst case it's swept when the object's expiry fires).
    await deleteMediaObject(thumbKeyFor(String(row.r2_key)));
  }

  await pool.query(`UPDATE org_media SET deleted = TRUE WHERE media_id = $1`, [
    mediaId,
  ]);
  return json({ ok: true });
}

export async function handleGetMediaItem(request, orgId, mediaId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "players_view") &&
    !orgHasPermission(session, orgId, "bans_create") &&
    !orgHasPermission(session, orgId, "bans_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.uploaded_by, m.r2_key, m.thumb_key, m.storage_backend, m.zipline_url,
            m.filename, m.file_type, m.mime_type, m.file_size, m.title,
            m.uploaded_at, m.last_accessed_at,
            u.username AS uploaded_by_name
     FROM org_media m
     LEFT JOIN users u ON u.user_id = m.uploaded_by
     WHERE m.media_id = $1 AND m.org_id = $2 AND m.deleted = FALSE AND m.confirmed = TRUE`,
    [mediaId, orgId],
  );
  if (!rows[0]) return json({ error: "Media not found" }, 404);

  await pool.query(
    `UPDATE org_media SET last_accessed_at = unix_now() WHERE media_id = $1`,
    [mediaId],
  );
  return json({ media: serializeMedia(rows[0]) });
}

export async function handleGetBanMedia(request, orgId, banId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !canManageOrg(session, orgId) &&
    !orgHasPermission(session, orgId, "players_view") &&
    !orgHasPermission(session, orgId, "bans_create") &&
    !orgHasPermission(session, orgId, "bans_manage")
  )
    return json({ error: "Forbidden" }, 403);

  const banCheck = await pool.query(
    `SELECT ban_id FROM player_bans WHERE ban_id = $1 AND org_id = $2 LIMIT 1`,
    [banId, orgId],
  );
  if (!banCheck.rows[0]) return json({ error: "Ban not found" }, 404);

  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.uploaded_by, m.r2_key, m.thumb_key, m.storage_backend, m.zipline_url,
            m.filename, m.file_type, m.mime_type, m.file_size, m.title,
            m.uploaded_at, m.last_accessed_at,
            u.username AS uploaded_by_name
     FROM ban_media_links bml
     JOIN org_media m ON m.media_id = bml.media_id
     LEFT JOIN users u ON u.user_id = m.uploaded_by
     WHERE bml.ban_id = $1 AND m.deleted = FALSE AND m.confirmed = TRUE`,
    [banId],
  );
  return json({ media: rows.map(serializeMedia) });
}

// Public ticket media: prepare presigned upload URL (session with steamId required).
export async function handlePublicMediaPrepare(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!session.steamId)
    return json({ error: "Steam account required to upload files." }, 403);

  if (!r2Configured())
    return json({ error: "R2 storage not configured." }, 503);

  const rl = await checkRateLimit(
    `rl:pub-media:${session.userId}`,
    env.publicMediaPrepareRateLimitPerMinute,
    60,
  );
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const orgId = String(body?.orgId ?? "").trim();
  if (!orgId) return json({ error: "orgId is required" }, 400);

  const orgRes = await pool.query(
    `SELECT org_id, media_public_file_limit_bytes, media_public_max_files FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);
  const org = orgRes.rows[0];

  const fileLimitBytes = Number(
    org.media_public_file_limit_bytes ?? DEFAULT_PUBLIC_FILE_LIMIT,
  );
  const maxFiles = Number(
    org.media_public_max_files ?? DEFAULT_PUBLIC_MAX_FILES,
  );

  const filename = String(body?.filename ?? "upload").slice(0, 255);
  const mimeType = String(body?.mimeType ?? "")
    .trim()
    .toLowerCase();
  const fileSize = Number(body?.fileSize ?? 0);

  if (!PUBLIC_ALLOWED_MIME.has(mimeType))
    return json(
      {
        error: `File type not allowed: ${mimeType}. Allowed: images (jpeg/png/gif/webp) and video (mp4/webm/mov).`,
      },
      415,
    );
  if (!fileSize || fileSize < 1)
    return json({ error: "fileSize is required" }, 400);
  if (fileSize > fileLimitBytes)
    return json(
      {
        error: `File too large (max ${Math.round(fileLimitBytes / 1024 / 1024)} MB for this organization)`,
      },
      413,
    );

  // Count existing pending/confirmed media for this session to enforce per-submission cap.
  const countRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM org_media
     WHERE org_id = $1 AND uploaded_by = $2 AND source IN ('pending','ticket')
       AND deleted = FALSE AND pending_since > $3`,
    [orgId, session.userId, Math.floor(Date.now() / 1000) - 3600],
  );
  if (Number(countRes.rows[0].cnt) >= maxFiles)
    return json(
      { error: `Maximum ${maxFiles} file(s) allowed per submission.` },
      429,
    );

  const r2Key = buildObjectKey(orgId, `pending/${session.userId}`, filename);
  const nowSec = Math.floor(Date.now() / 1000);
  const uploadUrl = await generatePresignedPut(r2Key, mimeType, fileSize);

  // Best-effort thumbnail upload slot (image/video only), verified at confirm.
  const fileType = mediaFileType(mimeType);
  const thumbUploadUrl =
    fileType === "image" || fileType === "video"
      ? await generatePresignedPut(thumbKeyFor(r2Key), "image/webp")
      : null;

  const { rows } = await pool.query(
    `INSERT INTO org_media
       (org_id, uploaded_by, filename, file_type, mime_type, file_size,
        r2_key, storage_backend, source, confirmed, pending_since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'r2','pending',FALSE,$8)
     RETURNING media_id`,
    [
      orgId,
      session.userId,
      filename,
      fileType,
      mimeType,
      fileSize,
      r2Key,
      nowSec,
    ],
  );
  const mediaId = String(rows[0].media_id);

  return json({ uploadUrl, thumbUploadUrl, mediaId });
}

// Public ticket media confirm: mark upload complete so it can be attached to a ticket.
export async function handlePublicMediaConfirm(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!session.steamId) return json({ error: "Steam account required." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const mediaId = String(body?.mediaId ?? "").trim();
  if (!mediaId) return json({ error: "mediaId is required" }, 400);

  const { rows } = await pool.query(
    `SELECT media_id, uploaded_by, org_id, r2_key, mime_type FROM org_media
     WHERE media_id = $1 AND source = 'pending' AND confirmed = FALSE AND deleted = FALSE`,
    [mediaId],
  );
  if (!rows[0]) return json({ error: "Pending media not found" }, 404);
  const row = rows[0];
  if (String(row.uploaded_by) !== String(session.userId))
    return json({ error: "Forbidden" }, 403);

  const discard = async () => {
    if (row.r2_key) {
      await deleteMediaObject(String(row.r2_key));
      await deleteMediaObject(thumbKeyFor(String(row.r2_key)));
    }
    await pool.query(
      `UPDATE org_media SET deleted = TRUE WHERE media_id = $1`,
      [mediaId],
    );
  };

  // Verify the real uploaded size against the org's public per-file limit — the
  // presigned PUT can't bind content-length, so the declared size is moot.
  let head;
  try {
    head = await headObject(String(row.r2_key));
  } catch (err) {
    console.error(`[r2] public head failed mediaId=${mediaId}:`, err?.message);
    return json({ error: "Failed to verify upload" }, 502);
  }
  if (!head) {
    await discard();
    return json({ error: "Uploaded object not found in storage" }, 404);
  }
  if (head.contentLength < 1) {
    await discard();
    return json({ error: "Uploaded file is empty" }, 400);
  }

  const orgRes = await pool.query(
    `SELECT media_public_file_limit_bytes FROM organizations WHERE org_id = $1 LIMIT 1`,
    [row.org_id],
  );
  const fileLimitBytes = Number(
    orgRes.rows[0]?.media_public_file_limit_bytes ?? DEFAULT_PUBLIC_FILE_LIMIT,
  );
  if (head.contentLength > fileLimitBytes) {
    await discard();
    return json(
      {
        error: `File too large (max ${Math.round(fileLimitBytes / 1024 / 1024)} MB for this organization)`,
      },
      413,
    );
  }

  // Pin the vetted Content-Type (public uploads are always single presigned PUT).
  try {
    await normalizeObjectContentType(
      String(row.r2_key),
      String(row.mime_type || "application/octet-stream"),
    );
  } catch (err) {
    console.error(
      `[r2] public content-type normalize failed mediaId=${mediaId}:`,
      err?.message,
    );
    await discard();
    return json({ error: "Failed to finalize upload" }, 502);
  }

  const thumbKey = await finalizeThumb(String(row.r2_key));

  await pool.query(
    `UPDATE org_media SET confirmed = TRUE, file_size = $2, thumb_key = $3 WHERE media_id = $1`,
    [mediaId, head.contentLength, thumbKey],
  );
  return json({ ok: true, mediaId });
}

export async function purgeExpiredMedia() {
  // Soft-delete unconfirmed uploads older than 1 hour (abandoned presigned flows).
  const staleThreshold = Math.floor(Date.now() / 1000) - 3600;
  const { rows: stale } = await pool.query(
    `SELECT media_id, r2_key, multipart_upload_id
     FROM org_media WHERE confirmed = FALSE AND deleted = FALSE AND pending_since < $1`,
    [staleThreshold],
  );
  for (const row of stale) {
    if (row.r2_key) {
      if (row.multipart_upload_id)
        await abortMultipartUpload(
          String(row.r2_key),
          String(row.multipart_upload_id),
        );
      await deleteMediaObject(String(row.r2_key));
      await deleteMediaObject(thumbKeyFor(String(row.r2_key)));
    }
    await pool.query(
      `UPDATE org_media SET deleted = TRUE WHERE media_id = $1`,
      [row.media_id],
    );
  }
  if (stale.length)
    console.log(`[media-expiry] removed ${stale.length} abandoned upload(s)`);

  // Soft-delete confirmed *public* uploads that were never attached to a ticket.
  // handleCreateTicket promotes attached media from source='pending' to 'ticket',
  // so anything still 'pending' after a generous window is an orphan (the public
  // submitter confirmed the upload but abandoned the ticket). Without this they
  // would leak forever in orgs that don't set a media_expiry_months window.
  const orphanThreshold = Math.floor(Date.now() / 1000) - 24 * 3600;
  const { rows: orphans } = await pool.query(
    `SELECT media_id, r2_key FROM org_media
     WHERE source = 'pending' AND confirmed = TRUE AND deleted = FALSE
       AND COALESCE(pending_since, uploaded_at) < $1`,
    [orphanThreshold],
  );
  for (const row of orphans) {
    if (row.r2_key) {
      await deleteMediaObject(String(row.r2_key));
      await deleteMediaObject(thumbKeyFor(String(row.r2_key)));
    }
    await pool.query(
      `UPDATE org_media SET deleted = TRUE WHERE media_id = $1`,
      [row.media_id],
    );
  }
  if (orphans.length)
    console.log(
      `[media-expiry] removed ${orphans.length} orphaned public upload(s)`,
    );

  // Soft-delete confirmed media older than the org's configured expiry window.
  const { rows: orgs } = await pool.query(
    `SELECT org_id, media_expiry_months FROM organizations WHERE media_expiry_months IS NOT NULL`,
  );
  for (const org of orgs) {
    const thresholdSeconds =
      Math.floor(Date.now() / 1000) - org.media_expiry_months * 30 * 86400;
    const { rows: expired } = await pool.query(
      `SELECT media_id, r2_key FROM org_media
       WHERE org_id = $1 AND deleted = FALSE AND confirmed = TRUE
         AND COALESCE(last_accessed_at, uploaded_at) < $2`,
      [org.org_id, thresholdSeconds],
    );
    for (const row of expired) {
      if (row.r2_key) {
        await deleteMediaObject(String(row.r2_key));
        await deleteMediaObject(thumbKeyFor(String(row.r2_key)));
      }
      await pool.query(
        `UPDATE org_media SET deleted = TRUE WHERE media_id = $1`,
        [row.media_id],
      );
    }
    if (expired.length)
      console.log(
        `[media-expiry] purged ${expired.length} item(s) for org ${org.org_id}`,
      );
  }
}

// Documentation / wiki handlers (categories, articles, versions). Pure relocation from api.js.

import crypto from "node:crypto";
import {
  canManageOrg,
  orgHasPermission,
  orgActorPosition,
  requireSession,
} from "../core.js";
import { json } from "../http.js";
import { pool } from "../runtime.js";
import { sanitizeDocHtml } from "../sanitize.js";

// ── Documentation / wiki ─────────────────────────────────────────────────────

export function docArticleRow(a, versions) {
  // Sanitize on the way out so every read path (and any pre-existing row stored
  // before sanitization was added) is safe to render with dangerouslySetInnerHTML.
  return {
    id: String(a.article_id),
    orgId: String(a.org_id),
    categoryId: a.category_id ? String(a.category_id) : null,
    title: String(a.title),
    body: sanitizeDocHtml(String(a.body)),
    minRank: Number(a.min_rank),
    minPosition: a.min_position != null ? Number(a.min_position) : 0,
    updatedAt: Number(a.updated_at),
    updatedByName: a.updated_by_name ?? null,
    versions: (versions ?? []).map((v) => ({
      id: String(v.version_id),
      title: String(v.title),
      body: sanitizeDocHtml(String(v.body)),
      savedAt: Number(v.saved_at),
      savedByName: v.saved_by_name ?? null,
    })),
  };
}

export async function handleListOrgDocs(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "docs_view") &&
    !orgHasPermission(session, orgId, "docs_edit") &&
    !canManageOrg(session, orgId)
  )
    return json({ error: "Forbidden" }, 403);

  const isFullAccess = canManageOrg(session, orgId);

  const catsPromise = pool.query(
    `SELECT category_id, org_id, name, parent_id, sort_order, created_at
     FROM doc_categories WHERE org_id = $1 ORDER BY sort_order, created_at`,
    [orgId],
  );
  const rolesPromise = pool.query(
    `SELECT role_id, role_name, position
     FROM roles
     WHERE role_id LIKE ($1 || '_%')
       AND role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
     ORDER BY position ASC, role_name ASC`,
    [orgId],
  );

  let articlesPromise;
  if (isFullAccess) {
    articlesPromise = pool.query(
      `SELECT a.article_id, a.org_id, a.category_id, a.title, a.body,
              a.min_rank, a.min_position, a.updated_at, a.updated_by_name
       FROM doc_articles a
       WHERE a.org_id = $1
       ORDER BY a.updated_at DESC`,
      [orgId],
    );
  } else {
    const callerPos = await orgActorPosition(session, orgId);
    const posFilter = Number.isFinite(callerPos) ? callerPos : 0;
    articlesPromise = pool.query(
      `SELECT a.article_id, a.org_id, a.category_id, a.title, a.body,
              a.min_rank, a.min_position, a.updated_at, a.updated_by_name
       FROM doc_articles a
       WHERE a.org_id = $1 AND a.min_position <= $2
       ORDER BY a.updated_at DESC`,
      [orgId, posFilter],
    );
  }

  const [catsRes, articlesRes, rolesRes] = await Promise.all([
    catsPromise,
    articlesPromise,
    rolesPromise,
  ]);

  const articleIds = articlesRes.rows.map((r) => r.article_id);
  let versionsRows = [];
  if (articleIds.length > 0) {
    const vr = await pool.query(
      `SELECT version_id, article_id, title, body, saved_at, saved_by_name
       FROM doc_article_versions
       WHERE article_id = ANY($1)
       ORDER BY saved_at DESC`,
      [articleIds],
    );
    versionsRows = vr.rows;
  }

  const versionsByArticle = {};
  for (const v of versionsRows) {
    (versionsByArticle[v.article_id] ??= []).push(v);
  }

  return json({
    categories: catsRes.rows.map((c) => ({
      id: String(c.category_id),
      orgId: String(c.org_id),
      name: String(c.name),
      parentId: c.parent_id ? String(c.parent_id) : null,
      sortOrder: Number(c.sort_order),
    })),
    articles: articlesRes.rows.map((a) =>
      docArticleRow(a, versionsByArticle[a.article_id] ?? []),
    ),
    roles: rolesRes.rows.map((r) => ({
      roleId: String(r.role_id),
      roleName: String(r.role_name),
      position: Number(r.position),
    })),
  });
}

export async function handleCreateDocCategory(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const name = String(body?.name ?? "").trim();
  if (!name) return json({ error: "name is required" }, 400);
  const parentId = body?.parentId ? String(body.parentId) : null;

  if (parentId) {
    const check = await pool.query(
      `SELECT 1 FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
      [parentId, orgId],
    );
    if (!check.rows[0])
      return json({ error: "Parent category not found" }, 404);
  }

  const categoryId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO doc_categories (category_id, org_id, name, parent_id) VALUES ($1, $2, $3, $4)`,
    [categoryId, orgId, name, parentId],
  );
  return json(
    {
      category: {
        id: categoryId,
        orgId,
        name,
        parentId: parentId ?? null,
        sortOrder: 0,
      },
    },
    201,
  );
}

export async function handleUpdateDocCategory(request, orgId, categoryId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  const check = await pool.query(
    `SELECT 1 FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
    [categoryId, orgId],
  );
  if (!check.rows[0]) return json({ error: "Category not found" }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const name = String(body?.name ?? "").trim();
  if (!name) return json({ error: "name is required" }, 400);

  await pool.query(
    `UPDATE doc_categories SET name = $1 WHERE category_id = $2 AND org_id = $3`,
    [name, categoryId, orgId],
  );
  return json({ ok: true });
}

export async function handleDeleteDocCategory(request, orgId, categoryId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  const check = await pool.query(
    `SELECT 1 FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
    [categoryId, orgId],
  );
  if (!check.rows[0]) return json({ error: "Category not found" }, 404);

  await pool.query(
    `UPDATE doc_categories SET parent_id = NULL WHERE parent_id = $1`,
    [categoryId],
  );
  await pool.query(
    `UPDATE doc_articles SET category_id = NULL WHERE category_id = $1 AND org_id = $2`,
    [categoryId, orgId],
  );
  await pool.query(
    `DELETE FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
    [categoryId, orgId],
  );
  return json({ ok: true });
}

export async function handleCreateDocArticle(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const title = String(body?.title ?? "").trim() || "Untitled";
  const rawBody = String(body?.body ?? "");
  if (rawBody.length > 512 * 1024)
    return json({ error: "Article body too large (max 512 KB)" }, 413);
  const articleBody = sanitizeDocHtml(rawBody);
  const minPosition = Math.max(0, Number(body?.minPosition ?? 0) || 0);
  const categoryId = body?.categoryId ? String(body.categoryId) : null;

  if (categoryId) {
    const check = await pool.query(
      `SELECT 1 FROM doc_categories WHERE category_id = $1 AND org_id = $2`,
      [categoryId, orgId],
    );
    if (!check.rows[0]) return json({ error: "Category not found" }, 404);
  }

  const articleId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO doc_articles (article_id, org_id, category_id, title, body, min_rank, min_position, updated_at, updated_by_user_id, updated_by_name)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)`,
    [
      articleId,
      orgId,
      categoryId,
      title,
      articleBody,
      minPosition,
      now,
      session.userId,
      session.username ?? null,
    ],
  );
  return json(
    {
      article: docArticleRow(
        {
          article_id: articleId,
          org_id: orgId,
          category_id: categoryId,
          title,
          body: articleBody,
          min_rank: 1,
          min_position: minPosition,
          updated_at: now,
          updated_by_name: session.username ?? null,
        },
        [],
      ),
    },
    201,
  );
}

export async function handleUpdateDocArticle(request, orgId, articleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  const existing = await pool.query(
    `SELECT * FROM doc_articles WHERE article_id = $1 AND org_id = $2`,
    [articleId, orgId],
  );
  if (!existing.rows[0]) return json({ error: "Article not found" }, 404);
  const prev = existing.rows[0];

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const title =
    body?.title != null ? String(body.title).trim() || prev.title : prev.title;
  const rawBody = body?.body != null ? String(body.body) : prev.body;
  if (rawBody.length > 512 * 1024)
    return json({ error: "Article body too large (max 512 KB)" }, 413);
  const articleBody = sanitizeDocHtml(rawBody);
  const minPosition =
    body?.minPosition != null
      ? Math.max(0, Number(body.minPosition) || 0)
      : Number(prev.min_position ?? 0);
  const categoryId =
    "categoryId" in body
      ? body.categoryId
        ? String(body.categoryId)
        : null
      : prev.category_id;

  const versionId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await pool.query(
    `INSERT INTO doc_article_versions (version_id, article_id, title, body, saved_at, saved_by_user_id, saved_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      versionId,
      articleId,
      prev.title,
      prev.body,
      now,
      session.userId,
      session.username ?? null,
    ],
  );
  await pool.query(
    `UPDATE doc_articles
     SET title = $1, body = $2, min_rank = $3, min_position = $4, category_id = $5,
         updated_at = $6, updated_by_user_id = $7, updated_by_name = $8
     WHERE article_id = $9 AND org_id = $10`,
    [
      title,
      articleBody,
      Number(prev.min_rank),
      minPosition,
      categoryId,
      now,
      session.userId,
      session.username ?? null,
      articleId,
      orgId,
    ],
  );

  const versionsRes = await pool.query(
    `SELECT version_id, article_id, title, body, saved_at, saved_by_name
     FROM doc_article_versions WHERE article_id = $1 ORDER BY saved_at DESC`,
    [articleId],
  );
  return json({
    article: docArticleRow(
      {
        article_id: articleId,
        org_id: orgId,
        category_id: categoryId,
        title,
        body: articleBody,
        min_rank: Number(prev.min_rank),
        min_position: minPosition,
        updated_at: now,
        updated_by_name: session.username ?? null,
      },
      versionsRes.rows,
    ),
  });
}

export async function handleDeleteDocArticle(request, orgId, articleId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId))
    return json(
      { error: "Forbidden: org admin required to delete articles" },
      403,
    );

  const check = await pool.query(
    `SELECT 1 FROM doc_articles WHERE article_id = $1 AND org_id = $2`,
    [articleId, orgId],
  );
  if (!check.rows[0]) return json({ error: "Article not found" }, 404);

  await pool.query(`DELETE FROM doc_article_versions WHERE article_id = $1`, [
    articleId,
  ]);
  await pool.query(
    `DELETE FROM doc_articles WHERE article_id = $1 AND org_id = $2`,
    [articleId, orgId],
  );
  return json({ ok: true });
}

export async function handleRestoreDocVersion(
  request,
  orgId,
  articleId,
  versionId,
) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "docs_edit"))
    return json({ error: "Forbidden: docs_edit permission required" }, 403);

  const existing = await pool.query(
    `SELECT a.*, v.title AS v_title, v.body AS v_body
     FROM doc_articles a
     JOIN doc_article_versions v ON v.version_id = $2 AND v.article_id = a.article_id
     WHERE a.article_id = $1 AND a.org_id = $3`,
    [articleId, versionId, orgId],
  );
  if (!existing.rows[0])
    return json({ error: "Article or version not found" }, 404);
  const row = existing.rows[0];
  const restoredBody = sanitizeDocHtml(String(row.v_body));

  const now = Math.floor(Date.now() / 1000);
  const newVersionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO doc_article_versions (version_id, article_id, title, body, saved_at, saved_by_user_id, saved_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newVersionId,
      articleId,
      row.title,
      row.body,
      now,
      session.userId,
      session.username ?? null,
    ],
  );
  await pool.query(
    `UPDATE doc_articles
     SET title = $1, body = $2, updated_at = $3, updated_by_user_id = $4, updated_by_name = $5
     WHERE article_id = $6 AND org_id = $7`,
    [
      row.v_title,
      restoredBody,
      now,
      session.userId,
      session.username ?? null,
      articleId,
      orgId,
    ],
  );

  const versionsRes = await pool.query(
    `SELECT version_id, article_id, title, body, saved_at, saved_by_name
     FROM doc_article_versions WHERE article_id = $1 ORDER BY saved_at DESC`,
    [articleId],
  );
  return json({
    article: docArticleRow(
      {
        article_id: articleId,
        org_id: orgId,
        category_id: row.category_id,
        title: row.v_title,
        body: restoredBody,
        min_rank: row.min_rank,
        updated_at: now,
        updated_by_name: session.username ?? null,
      },
      versionsRes.rows,
    ),
  });
}

export async function handleDeleteDocVersion(
  request,
  orgId,
  articleId,
  versionId,
) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canManageOrg(session, orgId))
    return json(
      { error: "Forbidden: org admin required to delete versions" },
      403,
    );

  const check = await pool.query(
    `SELECT 1 FROM doc_article_versions v
     JOIN doc_articles a ON a.article_id = v.article_id
     WHERE v.version_id = $1 AND a.org_id = $2`,
    [versionId, orgId],
  );
  if (!check.rows[0]) return json({ error: "Version not found" }, 404);

  await pool.query(`DELETE FROM doc_article_versions WHERE version_id = $1`, [
    versionId,
  ]);
  return json({ ok: true });
}

// Per-org player notes CRUD with role-position visibility gating. Pure relocation from api.js.

import {
  checkRateLimit,
  auditLog,
  orgHasPermission,
  sessionRankForOrg,
  requireSession,
  orgsWithPermission,
  getStaffIdentityForSteamId,
  canBypassStaffPrivacy,
} from "../core.js";
import { json, getClientIp } from "../http.js";
import { pool } from "../runtime.js";
import { isValidSteamId } from "../validation.js";

export const PLAYER_NOTE_WRITE_RATE_LIMIT_PER_MINUTE = 30;
// ── Player notes ──────────────────────────────────────────────────────────────

export const PLAYER_NOTE_MAX_LEN = 4000;

export function serializePlayerNote(row) {
  return {
    id: String(row.id),
    subjectId: String(row.subject_steam_id),
    body: String(row.body),
    authorId: row.author_user_id ?? null,
    authorName: row.author_name ?? null,
    minRank: Number(row.min_rank),
    requiredRoleId: row.required_role_id ?? null,
    pinned: Boolean(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function handleListPlayerNotes(request, orgId, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);
  if (
    !orgHasPermission(session, orgId, "player_notes") &&
    !orgHasPermission(session, orgId, "players_view")
  )
    return json({ error: "Forbidden: player_notes permission required" }, 403);

  const rank = sessionRankForOrg(session, orgId);
  const { rows } = await pool.query(
    `SELECT id, subject_steam_id, body, author_user_id, author_name,
            min_rank, required_role_id, pinned, created_at, updated_at
     FROM player_notes
     WHERE org_id = $1 AND subject_steam_id = $2 AND (
       $3 >= 4
       OR (required_role_id IS NULL AND min_rank <= $3)
       OR EXISTS (
         SELECT 1 FROM organization_members om
         JOIN roles r ON om.role_id = r.role_id
         WHERE om.user_id = $4 AND om.org_id = $1
           AND r.position >= COALESCE(
             (SELECT position FROM roles WHERE role_id = required_role_id),
             0
           )
       )
     )
     ORDER BY pinned DESC, created_at DESC`,
    [orgId, steamId, rank, session.userId],
  );

  return json({ notes: rows.map(serializePlayerNote) });
}

// Combined notes across every org the caller may view: their own orgs (rank-gated
// as usual) plus notes shared in by other orgs. A sharing org chooses a ceiling
// (notes_share_level) — only its notes at/below that min_rank and NOT gated to a
// specific role are shared, since roles don't translate across orgs. Shared notes
// are read-only to the grantee and tagged with their source org.
export async function handleListPlayerNotesCombined(request, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);

  // Privacy gate — a private staffer's notes are part of their hidden profile.
  const staffIdentity = await getStaffIdentityForSteamId(steamId);
  if (
    staffIdentity?.profilePrivate &&
    !canBypassStaffPrivacy(session, staffIdentity)
  ) {
    return json({ notes: [], protected: true });
  }

  const memberOrgs = [
    ...new Set([
      ...orgsWithPermission(session, "players_view"),
      ...orgsWithPermission(session, "player_notes"),
    ]),
  ];
  if (!memberOrgs.length) return json({ notes: [] });

  const byId = new Map();

  // Own-org notes, rank-gated by the caller's rank in each org (same rule as the
  // single-org endpoint).
  for (const org of memberOrgs) {
    const rank = sessionRankForOrg(session, org);
    const { rows } = await pool.query(
      `SELECT n.id, n.org_id, n.subject_steam_id, n.body, n.author_user_id,
              n.author_name, n.min_rank, n.required_role_id, n.pinned,
              n.created_at, n.updated_at, o.name AS org_name
       FROM player_notes n
       LEFT JOIN organizations o ON o.org_id = n.org_id
       WHERE n.org_id = $1 AND n.subject_steam_id = $2 AND (
         $3 >= 4
         OR (n.required_role_id IS NULL AND n.min_rank <= $3)
         OR EXISTS (
           SELECT 1 FROM organization_members om
           JOIN roles r ON om.role_id = r.role_id
           WHERE om.user_id = $4 AND om.org_id = $1
             AND r.position >= COALESCE(
               (SELECT position FROM roles WHERE role_id = n.required_role_id),
               0
             )
         )
       )`,
      [org, steamId, rank, session.userId],
    );
    for (const r of rows) byId.set(String(r.id), { row: r, shared: false });
  }

  // Shared-in notes: orgs that granted 'notes' to one of the caller's orgs, only
  // up to that grant's level and excluding role-gated notes.
  const { rows: sharedRows } = await pool.query(
    `SELECT DISTINCT ON (n.id)
            n.id, n.org_id, n.subject_steam_id, n.body, n.author_user_id,
            n.author_name, n.min_rank, n.required_role_id, n.pinned,
            n.created_at, n.updated_at, o.name AS org_name
     FROM org_share_grants g
     JOIN player_notes n ON n.org_id = g.owner_org_id
     LEFT JOIN organizations o ON o.org_id = g.owner_org_id
     WHERE g.status = 'active' AND 'notes' = ANY(g.categories)
       AND g.grantee_org_id = ANY($1)
       AND n.subject_steam_id = $2
       AND n.required_role_id IS NULL
       AND n.min_rank <= g.notes_share_level
     ORDER BY n.id`,
    [memberOrgs, steamId],
  );
  for (const r of sharedRows) {
    const id = String(r.id);
    if (!byId.has(id)) byId.set(id, { row: r, shared: true });
  }

  const notes = [...byId.values()].map(({ row, shared }) => ({
    ...serializePlayerNote(row),
    orgId: String(row.org_id),
    orgName: row.org_name ?? null,
    shared,
    sourceOrgIds: [String(row.org_id)],
  }));
  notes.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt,
  );

  return json({ notes });
}

export async function handleGetOrgNoteRoles(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "players_view"))
    return json({ error: "Forbidden: players_view permission required" }, 403);

  const { rows } = await pool.query(
    `SELECT role_id, role_name, position FROM roles
     WHERE role_id LIKE ($1 || '_%')
       AND role_id NOT IN ('org_member', 'org_admin', 'org_owner', 'org_disabled')
     ORDER BY position ASC, role_name ASC`,
    [orgId],
  );

  return json({
    roles: rows.map((r) => ({
      roleId: String(r.role_id),
      roleName: String(r.role_name),
    })),
  });
}

export async function handleCreatePlayerNote(request, orgId, steamId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);
  if (
    !orgHasPermission(session, orgId, "player_notes") &&
    !orgHasPermission(session, orgId, "players_view")
  )
    return json({ error: "Forbidden: player_notes permission required" }, 403);

  const rl = await checkRateLimit(
    `rl:player-note:${session.userId}`,
    PLAYER_NOTE_WRITE_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (rl) return rl;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const text = String(body?.body ?? "").trim();
  if (!text) return json({ error: "body is required" }, 400);
  if (text.length > PLAYER_NOTE_MAX_LEN)
    return json(
      { error: `body must be ${PLAYER_NOTE_MAX_LEN} characters or fewer` },
      400,
    );

  let requiredRoleId = null;
  if (body?.requiredRoleId != null) {
    const roleId = String(body.requiredRoleId).trim();
    if (roleId) {
      const roleCheck = await pool.query(
        `SELECT role_id FROM roles WHERE role_id = $1 AND starts_with(role_id, $2 || '_') LIMIT 1`,
        [roleId, orgId],
      );
      if (!roleCheck.rows[0])
        return json({ error: "Role not found in this org" }, 400);
      requiredRoleId = roleId;
    }
  }

  // Sensitivity level (min_rank 1–4: all-staff → management-only), which also
  // determines whether the note is eligible for cross-org sharing. A role-gated
  // note is visible only to that role, so its level is moot — pin it at 1.
  const minRank = requiredRoleId
    ? 1
    : Math.min(4, Math.max(1, Number.parseInt(body?.minRank ?? 1, 10) || 1));

  const { rows } = await pool.query(
    `INSERT INTO player_notes
       (org_id, subject_steam_id, body, author_user_id, author_name, min_rank, required_role_id, pinned)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, subject_steam_id, body, author_user_id, author_name,
               min_rank, required_role_id, pinned, created_at, updated_at`,
    [
      orgId,
      steamId,
      text,
      session.userId,
      session.username ?? null,
      minRank,
      requiredRoleId,
      Boolean(body?.pinned),
    ],
  );

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "player_note",
    resourceId: steamId,
    actionType: "PLAYER_NOTE_CREATED",
    actionCategory: "player_management",
    severity: 1,
    metadata: { noteId: String(rows[0].id) },
    ipAddress: getClientIp(request),
  });

  return json({ note: serializePlayerNote(rows[0]) }, 201);
}

export async function handleUpdatePlayerNote(request, orgId, steamId, noteId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);
  if (
    !orgHasPermission(session, orgId, "player_notes") &&
    !orgHasPermission(session, orgId, "players_view")
  )
    return json({ error: "Forbidden: player_notes permission required" }, 403);

  const existing = await pool.query(
    `SELECT author_user_id FROM player_notes
     WHERE id = $1 AND org_id = $2 AND subject_steam_id = $3`,
    [noteId, orgId, steamId],
  );
  if (!existing.rows[0]) return json({ error: "Note not found" }, 404);

  // Author or management (rank ≥ 4) may edit/pin — matches the prior client rule.
  const isAuthor = existing.rows[0].author_user_id === session.userId;
  if (!isAuthor && sessionRankForOrg(session, orgId) < 4)
    return json({ error: "Forbidden: not your note" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const setClauses = [];
  const params = [];
  if (body?.body !== undefined) {
    const text = String(body.body).trim();
    if (!text) return json({ error: "body is required" }, 400);
    if (text.length > PLAYER_NOTE_MAX_LEN)
      return json(
        { error: `body must be ${PLAYER_NOTE_MAX_LEN} characters or fewer` },
        400,
      );
    params.push(text);
    setClauses.push(`body = $${params.length}`);
  }
  if (body?.pinned !== undefined) {
    params.push(Boolean(body.pinned));
    setClauses.push(`pinned = $${params.length}`);
  }
  if (body?.requiredRoleId !== undefined) {
    if (body.requiredRoleId === null || body.requiredRoleId === "") {
      params.push(null);
      setClauses.push(`required_role_id = $${params.length}`);
    } else {
      const roleId = String(body.requiredRoleId).trim();
      const roleCheck = await pool.query(
        `SELECT role_id FROM roles WHERE role_id = $1 AND starts_with(role_id, $2 || '_') LIMIT 1`,
        [roleId, orgId],
      );
      if (!roleCheck.rows[0])
        return json({ error: "Role not found in this org" }, 400);
      params.push(roleId);
      setClauses.push(`required_role_id = $${params.length}`);
    }
  }

  if (setClauses.length === 0)
    return json({ error: "No fields to update" }, 400);
  setClauses.push(`updated_at = unix_now()`);

  params.push(noteId);
  const { rows } = await pool.query(
    `UPDATE player_notes SET ${setClauses.join(", ")}
     WHERE id = $${params.length}
     RETURNING id, subject_steam_id, body, author_user_id, author_name,
               min_rank, required_role_id, pinned, created_at, updated_at`,
    params,
  );

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "player_note",
    resourceId: steamId,
    actionType: "PLAYER_NOTE_UPDATED",
    actionCategory: "player_management",
    severity: 1,
    metadata: {
      noteId: String(noteId),
      fields: Object.keys(body).filter((k) =>
        ["body", "pinned", "requiredRoleId"].includes(k),
      ),
    },
    ipAddress: getClientIp(request),
  });

  return json({ note: serializePlayerNote(rows[0]) });
}

export async function handleDeletePlayerNote(request, orgId, steamId, noteId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!isValidSteamId(steamId)) return json({ error: "Invalid Steam ID" }, 400);
  if (
    !orgHasPermission(session, orgId, "player_notes") &&
    !orgHasPermission(session, orgId, "players_view")
  )
    return json({ error: "Forbidden: player_notes permission required" }, 403);

  const existing = await pool.query(
    `SELECT author_user_id FROM player_notes
     WHERE id = $1 AND org_id = $2 AND subject_steam_id = $3`,
    [noteId, orgId, steamId],
  );
  if (!existing.rows[0]) return json({ error: "Note not found" }, 404);

  const isAuthor = existing.rows[0].author_user_id === session.userId;
  if (!isAuthor && sessionRankForOrg(session, orgId) < 4)
    return json({ error: "Forbidden: not your note" }, 403);

  await pool.query(`DELETE FROM player_notes WHERE id = $1`, [noteId]);

  auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "player_note",
    resourceId: steamId,
    actionType: "PLAYER_NOTE_DELETED",
    actionCategory: "player_management",
    severity: 1,
    metadata: { noteId: String(noteId) },
    ipAddress: getClientIp(request),
  });

  return json({ ok: true });
}

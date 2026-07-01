// Ticket persistence + Redis cache layer. Self-contained data access used by
// the ticket handlers in api.js; depends only on the runtime singletons.

import { pool, redis } from "./runtime.js";
import { getPublicUrl } from "./r2.js";

export function ticketCacheKey(ticketId) {
  return `ticket:${ticketId}`;
}

export async function cacheTicket(ticket) {
  const key = ticketCacheKey(ticket.ticket_id);
  let ttl;
  if (ticket.closed_at) {
    const expireAt = ticket.closed_at + 7 * 24 * 3600;
    ttl = expireAt - Math.floor(Date.now() / 1000);
  } else {
    ttl = 30 * 24 * 3600;
  }
  if (ttl > 0) {
    await redis.set(key, JSON.stringify(ticket), "EX", ttl);
  }
}

export async function getCachedTicket(ticketId) {
  const raw = await redis.get(ticketCacheKey(ticketId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function invalidateTicketCache(ticketId) {
  await redis.del(ticketCacheKey(ticketId));
}

// ── Ticket DB helpers ─────────────────────────────────────────────────────────

export async function loadTicketFromDb(ticketId) {
  const { rows } = await pool.query(
    `SELECT t.ticket_id, t.org_id, t.ticket_type_id, t.created_by, t.assigned_to,
            t.status, t.priority, t.category, t.title,
            t.created_at,
            t.updated_at,
            t.closed_at,
            t.reported_players,
            tt.ticket_type_name,
            creator.username AS created_by_username, creator.steam_id AS created_by_steam_id,
            assignee.username AS assigned_to_username
     FROM tickets t
     LEFT JOIN ticket_types tt ON tt.ticket_type_id = t.ticket_type_id
     LEFT JOIN users creator ON creator.user_id = t.created_by
     LEFT JOIN users assignee ON assignee.user_id = t.assigned_to
     WHERE t.ticket_id = $1
     LIMIT 1`,
    [ticketId],
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    ticket_id: Number(row.ticket_id),
    org_id: String(row.org_id),
    ticket_type_id: row.ticket_type_id ? Number(row.ticket_type_id) : null,
    ticket_type_name: row.ticket_type_name ?? null,
    category: row.category ?? null,
    created_by: row.created_by ? String(row.created_by) : null,
    created_by_username: row.created_by_username ?? null,
    created_by_steam_id: row.created_by_steam_id ?? null,
    assigned_to: row.assigned_to ? String(row.assigned_to) : null,
    assigned_to_username: row.assigned_to_username ?? null,
    status: String(row.status),
    priority: String(row.priority),
    title: String(row.title),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    closed_at: row.closed_at ? Number(row.closed_at) : null,
    reported_players: Array.isArray(row.reported_players)
      ? row.reported_players.map(String)
      : [],
  };
}

export async function loadTicketMessages(ticketId) {
  const { rows } = await pool.query(
    `SELECT tm.message_id, tm.ticket_id, tm.user_id, tm.message, tm.is_internal,
            tm.created_at,
            u.username, u.steam_id
     FROM ticket_messages tm
     LEFT JOIN users u ON u.user_id = tm.user_id
     WHERE tm.ticket_id = $1
     ORDER BY tm.created_at ASC`,
    [ticketId],
  );
  return rows.map((row) => ({
    messageId: Number(row.message_id),
    ticketId: Number(row.ticket_id),
    userId: row.user_id ? String(row.user_id) : null,
    username: row.username ?? null,
    steamId: row.steam_id ?? null,
    message: String(row.message),
    isInternal: Boolean(row.is_internal),
    createdAt: Number(row.created_at),
  }));
}

export async function loadTicketMedia(ticketId) {
  const { rows } = await pool.query(
    `SELECT m.media_id, m.org_id, m.filename, m.file_type, m.file_size, m.title, m.uploaded_at, m.r2_key
     FROM ticket_media_links tml
     JOIN org_media m ON m.media_id = tml.media_id
     WHERE tml.ticket_id = $1 AND m.deleted = FALSE
     ORDER BY m.uploaded_at DESC`,
    [ticketId],
  );
  return rows.map((row) => ({
    mediaId: String(row.media_id),
    orgId: String(row.org_id),
    filename: String(row.filename),
    fileType: String(row.file_type),
    fileSize: row.file_size != null ? Number(row.file_size) : null,
    title: row.title ?? "",
    uploadedAt: Number(row.uploaded_at),
    url: row.r2_key ? getPublicUrl(String(row.r2_key)) : null,
  }));
}

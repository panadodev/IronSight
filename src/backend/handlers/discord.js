// Discord bot REST helpers and moderation/mod-log/message-sync handlers, plus bot-token-authenticated endpoints. Pure relocation from api.js.

import crypto from "node:crypto";
import {
  checkRateLimit,
  auditLog,
  orgHasPermission,
  requireSession,
} from "../core.js";
import { json, nowUnix } from "../http.js";
import { pool, redis } from "../runtime.js";
import { env } from "../config.js";

export function hasDiscordModLegacy(session, orgId) {
  return orgHasPermission(session, orgId, "discord_mod");
}

export function canDiscordWarn(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_warn")
  );
}

export function canDiscordTimeout(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_timeout")
  );
}

export function canDiscordKick(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_kick")
  );
}

export function canDiscordBan(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_ban")
  );
}

export function canDiscordDeleteMessages(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_delete_messages")
  );
}

export function canDiscordViewBans(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_bans_view")
  );
}

export function canDiscordViewModLog(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    orgHasPermission(session, orgId, "discord_modlog_view")
  );
}

export function canDiscordViewMessages(session, orgId) {
  return (
    hasDiscordModLegacy(session, orgId) ||
    canDiscordTimeout(session, orgId) ||
    canDiscordKick(session, orgId) ||
    canDiscordBan(session, orgId) ||
    canDiscordDeleteMessages(session, orgId)
  );
}

// ── Discord moderation helpers ────────────────────────────────────────────────

export const DISCORD_API = "https://discord.com/api/v10";

export function discordBotHeaders(hasBody = false) {
  const headers = {
    Authorization: `Bot ${env.discordBotToken}`,
  };

  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

export async function discordFetch(path, opts = {}) {
  return fetch(`${DISCORD_API}${path}`, {
    ...opts,
    headers: {
      ...discordBotHeaders(!!opts.body),
      ...(opts.headers ?? {}),
    },
  });
}

// Discord message flag: suppress the push/ping notification for this message.
const DISCORD_SUPPRESS_NOTIFICATIONS = 1 << 12;

export async function sendDiscordDm(discordUserId, content, options = {}) {
  if (!env.discordBotToken) return;
  try {
    const dmRes = await discordFetch("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!dmRes.ok) return;
    const { id: channelId } = await dmRes.json();
    const payload = { content };
    if (options.silent) payload.flags = DISCORD_SUPPRESS_NOTIFICATIONS;
    await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    // DMs can fail silently (user has DMs disabled, etc.)
  }
}

// Returns { ok, reason } where reason is one of:
// "sent" | "no_bot_token" | "not_sharing_server" | "dms_closed" | "error"
export async function sendDiscordDmWithResult(discordUserId, content) {
  if (!env.discordBotToken) return { ok: false, reason: "no_bot_token" };
  try {
    const dmRes = await discordFetch("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!dmRes.ok) return { ok: false, reason: "not_sharing_server" };
    const { id: channelId } = await dmRes.json();
    const msgRes = await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    if (!msgRes.ok) return { ok: false, reason: "dms_closed" };
    return { ok: true, reason: "sent" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export async function sendDiscordWebhook(webhookUrl, mentionRoles, embed) {
  try {
    const payload = { embeds: [embed] };
    if (Array.isArray(mentionRoles) && mentionRoles.length > 0) {
      payload.content = mentionRoles.map((id) => `<@&${id}>`).join(" ");
      payload.allowed_mentions = { roles: mentionRoles };
    }
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Non-critical
  }
}

export async function checkGuildMembership(guildId, discordUserId) {
  if (!env.discordBotToken || !guildId || !discordUserId) return false;
  try {
    const res = await discordFetch(
      `/guilds/${guildId}/members/${discordUserId}`,
    );
    return res.ok;
  } catch {
    return false;
  }
}

// Returns a Discord invite URL for the guild, or null if one cannot be created.
export async function createGuildInvite(guildId) {
  if (!env.discordBotToken || !guildId) return null;
  try {
    const guildRes = await discordFetch(`/guilds/${guildId}`);
    if (!guildRes.ok) return null;
    const guild = await guildRes.json();

    if (guild.vanity_url_code) {
      return `https://discord.gg/${guild.vanity_url_code}`;
    }

    let channelId = guild.system_channel_id ?? null;
    if (!channelId) {
      const chRes = await discordFetch(`/guilds/${guildId}/channels`);
      if (chRes.ok) {
        const channels = await chRes.json();
        const textCh = Array.isArray(channels)
          ? channels.find((c) => c.type === 0)
          : null;
        channelId = textCh?.id ?? null;
      }
    }

    if (!channelId) return null;

    const inviteRes = await discordFetch(
      `/channels/${channelId}/invites`,
      {
        method: "POST",
        body: JSON.stringify({ max_age: 86400, max_uses: 0, unique: false }),
      },
    );
    if (!inviteRes.ok) return null;
    const invite = await inviteRes.json();
    return invite.code ? `https://discord.gg/${invite.code}` : null;
  } catch {
    return null;
  }
}

export const STALE_PING_SECONDS = 10 * 60;
export const ALERT_COOLDOWN_SECONDS = 15 * 60;

export async function checkServerHealthAlerts() {
  if (!pool || !redis) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const staleThreshold = nowSec - STALE_PING_SECONDS;

  const staleRes = await pool.query(
    `SELECT server_id, owner_org_id, server_name, last_health_ping
     FROM servers
     WHERE last_health_ping IS NOT NULL
       AND last_health_ping < $1`,
    [staleThreshold],
  );
  if (staleRes.rows.length === 0) return;

  for (const server of staleRes.rows) {
    const { server_id, owner_org_id, server_name, last_health_ping } = server;

    // Check / update alert state for cooldown
    const stateRes = await pool.query(
      `INSERT INTO server_alert_state (org_id, server_id, alert_type, first_detected_at, last_notified_at)
       VALUES ($1, $2, 'stale_ping', $3, NULL)
       ON CONFLICT (org_id, server_id, alert_type) DO UPDATE
         SET first_detected_at = LEAST(server_alert_state.first_detected_at, EXCLUDED.first_detected_at)
       RETURNING last_notified_at`,
      [owner_org_id, server_id, nowSec],
    );
    const lastNotified = stateRes.rows[0]?.last_notified_at;
    if (lastNotified && nowSec - Number(lastNotified) < ALERT_COOLDOWN_SECONDS)
      continue;

    // Get subscribed staff Discord IDs
    const subsRes = await pool.query(
      `SELECT u.discord_id
       FROM staff_notification_prefs snp
       JOIN users u ON u.user_id = snp.user_id
       WHERE snp.org_id = $1 AND snp.enabled = TRUE AND u.discord_id IS NOT NULL`,
      [owner_org_id],
    );
    if (subsRes.rows.length === 0) continue;

    // Mark notified
    await pool.query(
      `UPDATE server_alert_state SET last_notified_at = $1
       WHERE org_id = $2 AND server_id = $3 AND alert_type = 'stale_ping'`,
      [nowSec, owner_org_id, server_id],
    );

    const lastPingUnix = Number(last_health_ping);
    const msg = `⚠️ **IronSight Alert** — Server **${server_name}** has not sent a health ping since <t:${lastPingUnix}:R> (last seen <t:${lastPingUnix}:t>). Check the Status page for details.`;
    for (const { discord_id } of subsRes.rows) {
      await sendDiscordDm(discord_id, msg);
    }
  }

  // Clear resolved alerts (server pinged recently again)
  await pool.query(
    `DELETE FROM server_alert_state
     WHERE alert_type = 'stale_ping'
       AND (org_id, server_id) IN (
         SELECT owner_org_id, server_id FROM servers WHERE last_health_ping >= $1
       )`,
    [staleThreshold],
  );
}

export async function getGuildRoles(guildId) {
  if (!env.discordBotToken || !guildId) return [];

  const cacheKey = `discord:roles:${guildId}`;
  try {
    const cached = await redis?.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {}

  try {
    const res = await discordFetch(`/guilds/${guildId}/roles`);
    if (!res.ok) return [];
    const roles = await res.json();
    const result = Array.isArray(roles) ? roles : [];
    try {
      await redis?.set(cacheKey, JSON.stringify(result), "EX", 300);
    } catch {}
    return result;
  } catch {
    return [];
  }
}

export async function addDiscordRoleToMember(
  guildId,
  discordUserId,
  discordRoleId,
) {
  if (!env.discordBotToken || !guildId || !discordUserId || !discordRoleId)
    return true;
  try {
    const res = await discordFetch(
      `/guilds/${guildId}/members/${discordUserId}/roles/${discordRoleId}`,
      { method: "PUT" },
    );
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

export async function removeDiscordRoleFromMember(
  guildId,
  discordUserId,
  discordRoleId,
) {
  if (!env.discordBotToken || !guildId || !discordUserId || !discordRoleId)
    return true;
  try {
    const res = await discordFetch(
      `/guilds/${guildId}/members/${discordUserId}/roles/${discordRoleId}`,
      { method: "DELETE" },
    );
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

export async function getDiscordRoleIdsForRole(roleId) {
  const { rows } = await pool.query(
    `SELECT discord_role_id FROM role_discord_roles WHERE role_id = $1`,
    [roleId],
  );
  return rows.map((r) => r.discord_role_id);
}

export async function syncDiscordRolesOnRoleChange(
  guildId,
  discordUserId,
  oldRoleId,
  newRoleId,
) {
  if (!guildId || !discordUserId) return null;
  const [oldIds, newIds] = await Promise.all([
    getDiscordRoleIdsForRole(oldRoleId),
    getDiscordRoleIdsForRole(newRoleId),
  ]);
  const toRemove = oldIds.filter((id) => !newIds.includes(id));
  const toAdd = newIds.filter((id) => !oldIds.includes(id));
  const results = await Promise.all([
    ...toRemove.map((id) =>
      removeDiscordRoleFromMember(guildId, discordUserId, id),
    ),
    ...toAdd.map((id) => addDiscordRoleToMember(guildId, discordUserId, id)),
  ]);
  return results.some((ok) => ok === false)
    ? "Discord role sync failed — check bot permissions."
    : null;
}

export async function removeAllDiscordRolesForRole(
  guildId,
  discordUserId,
  roleId,
) {
  if (!guildId || !discordUserId) return null;
  const ids = await getDiscordRoleIdsForRole(roleId);
  if (!ids.length) return null;
  const results = await Promise.all(
    ids.map((id) => removeDiscordRoleFromMember(guildId, discordUserId, id)),
  );
  return results.some((ok) => ok === false)
    ? "Discord role removal failed — check bot permissions."
    : null;
}

export async function handleGetOrgDiscordRoles(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  // Used both by Discord moderation and by the role editor (to link Discord
  // roles to custom roles), so either permission grants read access.
  if (
    !orgHasPermission(session, orgId, "discord_mod") &&
    !orgHasPermission(session, orgId, "role_create")
  ) {
    return json(
      { error: "Forbidden: discord_mod or role_create permission required" },
      403,
    );
  }

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org) return json({ error: "Organization not found" }, 404);

  const allRoles = await getGuildRoles(org.guild_id);

  // Build role id → position map for fast lookup
  const rolePositionMap = {};
  for (const r of allRoles) rolePositionMap[r.id] = r.position ?? 0;

  // Determine the caller's highest Discord role position in the guild.
  // null = no restriction (guild owner, or bot/guild not configured).
  let callerDiscordPosition = null;
  if (env.discordBotToken && org.guild_id && session.discordId) {
    try {
      // Check if the caller is the Discord guild owner (unrestricted)
      const guildRes = await discordFetch(`/guilds/${org.guild_id}`);
      let isGuildOwner = false;
      if (guildRes.ok) {
        const guild = await guildRes.json();
        isGuildOwner = String(guild.owner_id) === String(session.discordId);
      }
      if (!isGuildOwner) {
        const memberRes = await discordFetch(
          `/guilds/${org.guild_id}/members/${session.discordId}`,
        );
        if (memberRes.ok) {
          const member = await memberRes.json();
          const memberRoles = Array.isArray(member.roles) ? member.roles : [];
          callerDiscordPosition = memberRoles.reduce(
            (max, rid) => Math.max(max, rolePositionMap[rid] ?? 0),
            0,
          );
        }
      }
      // isGuildOwner → callerDiscordPosition stays null (no restriction)
    } catch {}
  }

  return json({
    discordRoles: allRoles
      .filter((r) => !r.managed && r.name !== "@everyone")
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        position: r.position ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    callerDiscordPosition,
  });
}

export async function getGuildTextChannels(guildId) {
  if (!env.discordBotToken || !guildId) return [];

  const cacheKey = `discord:channels:${guildId}`;
  try {
    const cached = await redis?.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {}

  try {
    const res = await discordFetch(`/guilds/${guildId}/channels`);
    if (!res.ok) return [];
    const channels = await res.json();
    // type 0 = GUILD_TEXT, type 5 = GUILD_ANNOUNCEMENT
    const result = channels
      .filter((c) => c.type === 0 || c.type === 5)
      .map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position ?? 0,
        permission_overwrites: c.permission_overwrites ?? [],
      }))
      .sort((a, b) => a.position - b.position);
    try {
      await redis?.set(cacheKey, JSON.stringify(result), "EX", 300);
    } catch {}
    return result;
  } catch {
    return [];
  }
}

export const VIEW_CHANNEL_BIT = BigInt(1024);

export function channelVisibleToRoles(channel, userRoleIds, guildId) {
  const overwrites = channel.permission_overwrites ?? [];
  let everyoneDeny = false;
  let everyoneAllow = false;
  let roleDeny = false;
  let roleAllow = false;
  for (const ow of overwrites) {
    if (ow.type !== 0) continue; // only role overwrites
    const allow = BigInt(ow.allow ?? "0");
    const deny = BigInt(ow.deny ?? "0");
    if (ow.id === guildId) {
      if (deny & VIEW_CHANNEL_BIT) everyoneDeny = true;
      if (allow & VIEW_CHANNEL_BIT) everyoneAllow = true;
    } else if (userRoleIds.has(ow.id)) {
      if (deny & VIEW_CHANNEL_BIT) roleDeny = true;
      if (allow & VIEW_CHANNEL_BIT) roleAllow = true;
    }
  }
  if (roleDeny) return false;
  if (roleAllow) return true;
  if (everyoneAllow) return true;
  if (everyoneDeny) return false;
  return true;
}

export async function syncChannelMessages(
  orgId,
  guildId,
  channelId,
  channelName,
) {
  const syncRes = await pool.query(
    `SELECT last_message_id FROM discord_channel_sync WHERE org_id = $1 AND channel_id = $2`,
    [orgId, channelId],
  );
  const lastMessageId = syncRes.rows[0]?.last_message_id ?? null;

  const params = new URLSearchParams({ limit: "100" });
  if (lastMessageId) params.set("after", lastMessageId);

  const res = await discordFetch(`/channels/${channelId}/messages?${params}`);
  if (!res.ok) return 0;

  const messages = await res.json();
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const toInsert = messages.filter((msg) => msg.author && !msg.author.bot);
  if (toInsert.length > 0) {
    const cols = 10;
    const valuePlaceholders = toInsert
      .map(
        (_, i) =>
          `(${Array.from({ length: cols }, (__, c) => `$${i * cols + c + 1}`).join(",")})`,
      )
      .join(",");
    const flatParams = toInsert.flatMap((msg) => [
      msg.id,
      orgId,
      guildId,
      channelId,
      channelName,
      msg.author.id,
      msg.author.global_name ?? msg.author.username,
      msg.content ?? "",
      JSON.stringify(msg.attachments ?? []),
      Math.floor(new Date(msg.timestamp).getTime() / 1000),
    ]);
    await pool.query(
      `INSERT INTO discord_messages
         (message_id, org_id, guild_id, channel_id, channel_name,
          author_discord_id, author_username, content, attachments, discord_created_at)
       VALUES ${valuePlaceholders}
       ON CONFLICT (org_id, message_id) DO NOTHING`,
      flatParams,
    );
  }

  // Keep the highest snowflake as last_message_id
  const newestId = messages.reduce(
    (max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max),
    lastMessageId ?? "0",
  );

  await pool.query(
    `INSERT INTO discord_channel_sync
       (org_id, channel_id, guild_id, channel_name, last_message_id, synced_at)
     VALUES ($1,$2,$3,$4,$5,unix_now())
     ON CONFLICT (org_id, channel_id) DO UPDATE SET
       last_message_id = EXCLUDED.last_message_id,
       channel_name = EXCLUDED.channel_name,
       synced_at = unix_now()`,
    [orgId, channelId, guildId, channelName, newestId],
  );

  return messages.length;
}

// Retention window < 30 days to stay within GDPR/Discord ToS obligations for
// users who have not received a moderation action. 25 days (2160000 s) gives a
// 5-day buffer below the 30-day hard limit.
export const DISCORD_MSG_RETENTION_SECONDS = 25 * 24 * 3600; // 2160000
export const CHAT_LOG_RETENTION_SECONDS = 90 * 24 * 3600; // 3 months

export async function pruneOldDiscordMessages() {
  const result = await pool.query(
    `DELETE FROM discord_messages WHERE indexed_at < unix_now() - $1`,
    [DISCORD_MSG_RETENTION_SECONDS],
  );
  if (result.rowCount > 0) {
    console.log(
      `[discord-prune] deleted ${result.rowCount} expired message(s)`,
    );
  }
}

export async function pruneOldChatMessages() {
  const result = await pool.query(
    `DELETE FROM text_chat_log WHERE created_at < unix_now() - $1`,
    [CHAT_LOG_RETENTION_SECONDS],
  );
  if (result.rowCount > 0) {
    console.log(`[chat-prune] deleted ${result.rowCount} expired message(s)`);
  }
}

// ── Discord API route handlers ────────────────────────────────────────────────

export async function handleDiscordSync(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewMessages(session, orgId)) {
    return json(
      {
        error:
          "Forbidden: requires discord_timeout, discord_kick, discord_ban, or discord_delete_messages permission",
      },
      403,
    );
  }

  if (!env.discordBotToken) {
    return json({ error: "DISCORD_BOT_TOKEN is not configured" }, 503);
  }

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) {
    return json({ error: "Organization has no guild_id configured" }, 400);
  }

  await pruneOldDiscordMessages();

  const channels = await getGuildTextChannels(org.guild_id);
  let totalSynced = 0;
  const results = [];
  for (const ch of channels) {
    const count = await syncChannelMessages(
      orgId,
      org.guild_id,
      ch.id,
      ch.name,
    );
    totalSynced += count;
    results.push({ channelId: ch.id, channelName: ch.name, synced: count });
  }

  return json({ ok: true, totalSynced, channels: results });
}

export async function handleGetDiscordChannels(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewMessages(session, orgId)) {
    return json(
      {
        error:
          "Forbidden: requires discord_timeout, discord_kick, discord_ban, or discord_delete_messages permission",
      },
      403,
    );
  }

  if (!env.discordBotToken) {
    return json({ error: "DISCORD_BOT_TOKEN is not configured" }, 503);
  }

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) return json({ channels: [] });

  const allChannels = await getGuildTextChannels(org.guild_id);

  // Fetch the session user's guild roles to filter channel visibility
  const userRoleIds = new Set([org.guild_id]); // @everyone = guildId
  if (session.discordId) {
    try {
      const memberRes = await discordFetch(
        `/guilds/${org.guild_id}/members/${session.discordId}`,
      );
      if (memberRes.ok) {
        const member = await memberRes.json();
        (member.roles ?? []).forEach((r) => userRoleIds.add(r));
      }
    } catch {}
  }

  const visibleApiChannels = allChannels.filter((c) =>
    channelVisibleToRoles(c, userRoleIds, org.guild_id),
  );

  // Include channels the bot has already ingested messages for, even if the
  // Discord REST API call failed or hasn't been synced yet.
  const dbChannelRes = await pool.query(
    `SELECT DISTINCT ON (channel_id) channel_id, channel_name
     FROM discord_messages WHERE org_id = $1`,
    [orgId],
  );
  const apiChannelIds = new Set(visibleApiChannels.map((c) => c.id));
  const dbOnlyChannels = dbChannelRes.rows
    .filter((r) => !apiChannelIds.has(r.channel_id))
    .map((r) => ({ id: r.channel_id, name: r.channel_name }));

  const channels = [...visibleApiChannels, ...dbOnlyChannels];

  const syncRes = await pool.query(
    `SELECT channel_id, channel_name, synced_at FROM discord_channel_sync WHERE org_id = $1`,
    [orgId],
  );
  const syncMap = Object.fromEntries(
    syncRes.rows.map((r) => [r.channel_id, r]),
  );

  return json({
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      syncedAt: syncMap[c.id]?.synced_at ?? null,
    })),
  });
}

export function requireBotAuth(request) {
  const authHeader = request.headers.get("authorization") ?? "";
  if (!env.discordBotToken) return json({ error: "Unauthorized" }, 401);
  // Constant-time compare of same-length digests — a plain !== leaks the
  // match-prefix length through response timing.
  const given = crypto.createHash("sha256").update(authHeader).digest();
  const expected = crypto
    .createHash("sha256")
    .update(`Bot ${env.discordBotToken}`)
    .digest();
  if (!crypto.timingSafeEqual(given, expected)) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

export async function handleBotGetStaffList(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const ownerDiscordId = (url.searchParams.get("ownerDiscordId") ?? "").trim();
  if (!ownerDiscordId) return json({ error: "ownerDiscordId required" }, 400);

  // Find the org where this Discord user is an owner
  const ownerRes = await pool.query(
    `SELECT om.org_id, o.name AS org_name
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     JOIN organizations o ON o.org_id = om.org_id
     WHERE u.discord_id = $1 AND om.role_id = 'org_owner'
     LIMIT 1`,
    [ownerDiscordId],
  );
  if (!ownerRes.rows[0])
    return json({ error: "No owner org found for this Discord ID" }, 404);
  const { org_id: orgId, org_name: orgName } = ownerRes.rows[0];

  const staffRes = await pool.query(
    `SELECT u.discord_id, u.username, om.role_id
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1
       AND om.role_id NOT IN ('org_owner', 'org_disabled')
     ORDER BY u.username`,
    [orgId],
  );

  return json({
    orgId,
    orgName,
    staff: staffRes.rows.map((r) => ({
      discordId: r.discord_id,
      username: r.username,
      roleId: r.role_id,
    })),
  });
}

export async function handleBotDeactivateMember(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { ownerDiscordId, targetDiscordId } = body ?? {};
  if (!ownerDiscordId || !targetDiscordId)
    return json(
      { error: "ownerDiscordId and targetDiscordId are required" },
      400,
    );

  // Verify the caller is an owner in some org
  const ownerRes = await pool.query(
    `SELECT om.org_id, om.user_id
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE u.discord_id = $1 AND om.role_id = 'org_owner'
     LIMIT 1`,
    [ownerDiscordId],
  );
  if (!ownerRes.rows[0])
    return json({ error: "Caller is not an org owner" }, 403);
  const { org_id: orgId } = ownerRes.rows[0];

  // Find the target member in the same org
  const targetRes = await pool.query(
    `SELECT om.user_id, u.username, om.role_id
     FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND u.discord_id = $2
     LIMIT 1`,
    [orgId, targetDiscordId],
  );
  if (!targetRes.rows[0])
    return json({ error: "Target member not found in your org" }, 404);
  const target = targetRes.rows[0];
  if (target.role_id === "org_owner")
    return json({ error: "Cannot disable another owner" }, 403);
  if (target.role_id === "org_disabled")
    return json({ ok: true, message: "Already disabled" });

  await pool.query(
    `UPDATE organization_members SET role_id = 'org_disabled' WHERE org_id = $1 AND user_id = $2`,
    [orgId, target.user_id],
  );

  return json({ ok: true, username: target.username, orgId });
}

export async function handleBotGetPlayerCount(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  const res = await pool.query(
    `SELECT COUNT(*) AS cnt FROM server_player_sessions WHERE disconnected_at IS NULL`,
  );
  return json({ count: Number(res.rows[0]?.cnt ?? 0) });
}

export async function handleIngestDiscordMessage(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const {
    messageId,
    guildId,
    channelId,
    channelName,
    authorId,
    authorUsername,
    content,
    attachments,
    timestamp,
  } = body ?? {};
  if (!messageId || !guildId || !channelId || !authorId) {
    return json({ error: "Missing required fields" }, 400);
  }

  const orgRes = await pool.query(
    `SELECT org_id FROM organizations WHERE guild_id = $1 LIMIT 1`,
    [String(guildId)],
  );
  if (!orgRes.rows[0]) return json({ ok: false, reason: "no org" });
  const orgId = orgRes.rows[0].org_id;

  const createdAt = timestamp
    ? Math.floor(new Date(timestamp).getTime() / 1000)
    : nowUnix();

  await pool.query(
    `INSERT INTO discord_messages
       (message_id, org_id, guild_id, channel_id, channel_name,
        author_discord_id, author_username, content, attachments, discord_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (org_id, message_id) DO NOTHING`,
    [
      String(messageId),
      orgId,
      String(guildId),
      String(channelId),
      String(channelName ?? ""),
      String(authorId),
      String(authorUsername ?? "").slice(0, 255),
      // Discord caps messages at 4000 chars (Nitro); cap defensively so a
      // compromised bot token can't bloat rows with megabyte payloads.
      String(content ?? "").slice(0, 8000),
      // Project raw Discord attachment objects down to the fields the panel
      // renders, with per-field caps — bounds the JSONB row size and drops
      // whatever extra keys Discord adds to the gateway payload.
      JSON.stringify(
        (Array.isArray(attachments) ? attachments.slice(0, 25) : []).map(
          (a) => ({
            id: a?.id != null ? String(a.id).slice(0, 32) : null,
            url: String(a?.url ?? "").slice(0, 1024),
            proxy_url: a?.proxy_url ? String(a.proxy_url).slice(0, 1024) : null,
            filename: String(a?.filename ?? "").slice(0, 255),
            content_type: a?.content_type
              ? String(a.content_type).slice(0, 100)
              : null,
          }),
        ),
      ),
      createdAt,
    ],
  );

  return json({ ok: true });
}

export async function handleDeleteDiscordMessage(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { messageId, guildId } = body ?? {};
  if (!messageId || !guildId) {
    return json({ error: "Missing required fields" }, 400);
  }

  const orgRes = await pool.query(
    `SELECT org_id FROM organizations WHERE guild_id = $1 LIMIT 1`,
    [String(guildId)],
  );
  if (!orgRes.rows[0]) return json({ ok: false, reason: "no org" });
  const orgId = orgRes.rows[0].org_id;

  await pool.query(
    `UPDATE discord_messages SET deleted = TRUE
     WHERE org_id = $1 AND message_id = $2`,
    [orgId, String(messageId)],
  );

  return json({ ok: true });
}

export async function handleBulkDeleteDiscordMessages(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { messageIds, guildId } = body ?? {};
  if (!Array.isArray(messageIds) || messageIds.length === 0 || !guildId) {
    return json({ error: "Missing required fields" }, 400);
  }

  const orgRes = await pool.query(
    `SELECT org_id FROM organizations WHERE guild_id = $1 LIMIT 1`,
    [String(guildId)],
  );
  if (!orgRes.rows[0]) return json({ ok: false, reason: "no org" });
  const orgId = orgRes.rows[0].org_id;

  const ids = messageIds.slice(0, 100).map(String);
  await pool.query(
    `UPDATE discord_messages SET deleted = TRUE
     WHERE org_id = $1 AND message_id = ANY($2)`,
    [orgId, ids],
  );

  return json({ ok: true });
}

export async function handleUpdateDiscordMessage(request) {
  const authError = requireBotAuth(request);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { messageId, guildId, content, editedTimestamp } = body ?? {};
  if (!messageId || !guildId) {
    return json({ error: "Missing required fields" }, 400);
  }

  const orgRes = await pool.query(
    `SELECT org_id FROM organizations WHERE guild_id = $1 LIMIT 1`,
    [String(guildId)],
  );
  if (!orgRes.rows[0]) return json({ ok: false, reason: "no org" });
  const orgId = orgRes.rows[0].org_id;

  const editedAt = editedTimestamp
    ? Math.floor(new Date(editedTimestamp).getTime() / 1000)
    : nowUnix();

  // Preserve original content before first edit
  await pool.query(
    `UPDATE discord_messages
     SET edited_at = $3,
         original_content = COALESCE(original_content, content),
         content = $4
     WHERE org_id = $1 AND message_id = $2 AND deleted = FALSE`,
    [orgId, String(messageId), editedAt, String(content ?? "").slice(0, 8000)],
  );

  return json({ ok: true });
}

export async function handleGetDiscordBotGuilds(request) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const isOwner = (session.orgOwnerOrgIds ?? []).length > 0;
  if (!isOwner && !session.globalAdmin) {
    return json({ error: "Forbidden: org owner required" }, 403);
  }

  if (!env.discordBotToken) {
    return json({ guilds: [] });
  }

  const ADMINISTRATOR = 0x8n;
  const MANAGE_GUILD = 0x20n;
  const userId = session.discordId;

  try {
    const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${env.discordBotToken}` },
    });
    if (!res.ok) {
      return json({ guilds: [] });
    }
    const allGuilds = await res.json();

    const results = await Promise.all(
      allGuilds.map(async (g) => {
        try {
          const [guildRes, memberRes] = await Promise.all([
            fetch(
              `https://discord.com/api/v10/guilds/${g.id}?with_counts=false`,
              { headers: { Authorization: `Bot ${env.discordBotToken}` } },
            ),
            fetch(
              `https://discord.com/api/v10/guilds/${g.id}/members/${userId}`,
              { headers: { Authorization: `Bot ${env.discordBotToken}` } },
            ),
          ]);
          if (!guildRes.ok) return null;
          const guild = await guildRes.json();

          if (guild.owner_id === userId) {
            return {
              id: String(g.id),
              name: String(g.name),
              icon: g.icon ?? null,
            };
          }

          if (!memberRes.ok) return null;
          const member = await memberRes.json();

          const memberRoleIds = new Set(member.roles ?? []);
          const rolePerms = Object.fromEntries(
            (guild.roles ?? []).map((r) => [r.id, BigInt(r.permissions)]),
          );
          let perms = rolePerms[guild.id] ?? 0n;
          for (const roleId of memberRoleIds) {
            perms |= rolePerms[roleId] ?? 0n;
          }

          if ((perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n) {
            return {
              id: String(g.id),
              name: String(g.name),
              icon: g.icon ?? null,
            };
          }
          return null;
        } catch {
          return null;
        }
      }),
    );

    return json({ guilds: results.filter(Boolean) });
  } catch {
    return json({ guilds: [] });
  }
}

export async function handleGetDiscordMessages(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewMessages(session, orgId)) {
    return json(
      {
        error:
          "Forbidden: requires discord_timeout, discord_kick, discord_ban, or discord_delete_messages permission",
      },
      403,
    );
  }

  await pruneOldDiscordMessages();

  const url = new URL(request.url);
  const channelId = url.searchParams.get("channel_id") ?? null;
  const authorId = url.searchParams.get("author_id") ?? null;
  const before = url.searchParams.get("before") ?? null;
  const after = url.searchParams.get("after") ?? null;
  const limit = Math.min(
    100,
    parseInt(url.searchParams.get("limit") ?? "50", 10),
  );

  const conditions = ["org_id = $1"];
  const params = [orgId];
  let idx = 2;

  if (channelId) {
    conditions.push(`channel_id = $${idx++}`);
    params.push(channelId);
  }
  if (authorId) {
    conditions.push(`author_discord_id = $${idx++}`);
    params.push(authorId);
  }
  if (before) {
    conditions.push(`discord_created_at < $${idx++}`);
    params.push(before);
  }
  if (after) {
    conditions.push(`discord_created_at > $${idx++}`);
    params.push(after);
  }

  const { rows } = await pool.query(
    `SELECT message_id, channel_id, channel_name, author_discord_id, author_username,
            content, attachments, discord_created_at, deleted, edited_at, original_content
     FROM discord_messages
     WHERE ${conditions.join(" AND ")}
     ORDER BY discord_created_at DESC
     LIMIT $${idx}`,
    [...params, limit],
  );

  return json({
    messages: rows.map((r) => ({
      id: r.message_id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      authorDiscordId: r.author_discord_id,
      authorUsername: r.author_username,
      content: r.content,
      attachments: r.attachments,
      createdAt: r.discord_created_at,
      deleted: r.deleted,
      editedAt: r.edited_at ?? null,
      originalContent: r.original_content ?? null,
    })),
  });
}

export async function handleDiscordModAction(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!env.discordBotToken) {
    return json({ error: "DISCORD_BOT_TOKEN is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body?.action ?? "")
    .trim()
    .toLowerCase();
  const targetDiscordId = String(body?.targetDiscordId ?? "").trim();
  const targetUsername = String(body?.targetUsername ?? "").trim();
  const reason = body?.reason ? String(body.reason).trim() : null;
  const durationSeconds = body?.durationSeconds
    ? parseInt(body.durationSeconds, 10)
    : null;

  const VALID_ACTIONS = [
    "timeout",
    "untimeout",
    "mute",
    "unmute",
    "kick",
    "ban",
    "unban",
  ];
  if (!VALID_ACTIONS.includes(action)) {
    return json(
      { error: `action must be one of: ${VALID_ACTIONS.join(", ")}` },
      400,
    );
  }
  if (!targetDiscordId) {
    return json({ error: "targetDiscordId is required" }, 400);
  }
  if (action === "timeout" && (!durationSeconds || durationSeconds <= 0)) {
    return json({ error: "durationSeconds required for timeout" }, 400);
  }

  if (["timeout", "untimeout", "mute", "unmute"].includes(action)) {
    if (!canDiscordTimeout(session, orgId)) {
      return json(
        { error: "Forbidden: discord_timeout permission required" },
        403,
      );
    }
  }
  if (action === "kick" && !canDiscordKick(session, orgId)) {
    return json({ error: "Forbidden: discord_kick permission required" }, 403);
  }
  if (["ban", "unban"].includes(action) && !canDiscordBan(session, orgId)) {
    return json({ error: "Forbidden: discord_ban permission required" }, 403);
  }
  if (
    action === "ban" &&
    body.deleteMessages &&
    !canDiscordDeleteMessages(session, orgId)
  ) {
    return json(
      { error: "Forbidden: discord_delete_messages permission required" },
      403,
    );
  }

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id) {
    return json({ error: "Organization has no guild_id configured" }, 400);
  }

  const guildId = org.guild_id;

  // Prevent punitive actions against active staff members of this org.
  const PUNITIVE_ACTIONS = ["timeout", "mute", "kick", "ban"];
  if (PUNITIVE_ACTIONS.includes(action) && targetDiscordId) {
    const staffCheck = await pool.query(
      `SELECT 1 FROM organization_members om
       JOIN users u ON u.user_id = om.user_id
       WHERE om.org_id = $1 AND u.discord_id = $2 LIMIT 1`,
      [orgId, targetDiscordId],
    );
    if (staffCheck.rows.length > 0) {
      return json(
        { error: "Cannot perform this action on an active staff member." },
        403,
      );
    }
  }

  let discordRes;

  switch (action) {
    case "timeout": {
      const until = new Date(Date.now() + durationSeconds * 1000).toISOString();
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ communication_disabled_until: until }),
        },
      );
      break;
    }
    case "untimeout": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ communication_disabled_until: null }),
        },
      );
      break;
    }
    case "mute": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ mute: true }),
        },
      );
      break;
    }
    case "unmute": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ mute: false }),
        },
      );
      break;
    }
    case "kick": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/members/${targetDiscordId}`,
        {
          method: "DELETE",
        },
      );
      break;
    }
    case "ban": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/bans/${targetDiscordId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            delete_message_seconds: body.deleteMessages ? 604800 : 0,
          }),
        },
      );
      if ((discordRes.ok || discordRes.status === 204) && body.deleteMessages) {
        // Delete messages from Discord (visible to others) but keep them in our DB
        deleteUserDiscordMessagesFromGuild(
          guildId,
          orgId,
          targetDiscordId,
        ).catch(() => {});
      }
      break;
    }
    case "unban": {
      discordRes = await discordFetch(
        `/guilds/${guildId}/bans/${targetDiscordId}`,
        {
          method: "DELETE",
        },
      );

      console.log("[discord] unban HTTP status:", discordRes.status);

      break;
    }
  }

  if (discordRes && !discordRes.ok && discordRes.status !== 204) {
    // Unbanning someone not currently banned is a no-op success
    if (action === "unban" && discordRes.status === 404) {
      // fall through to log and return ok
    } else {
      let discordError = null;
      try {
        discordError = await discordRes.json();
      } catch {
        /* empty */
      }
      return json(
        {
          error: "Discord API error",
          details: discordError,
          status: discordRes.status,
        },
        502,
      );
    }
  }

  const expiresAt =
    action === "timeout" && durationSeconds
      ? Math.floor(Date.now() / 1000) + durationSeconds
      : null;

  await pool.query(
    `INSERT INTO discord_mod_log
       (org_id, guild_id, target_discord_id, target_username,
        action_type, reason, duration_seconds, expires_at, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      orgId,
      guildId,
      targetDiscordId,
      targetUsername,
      action.toUpperCase(),
      reason,
      durationSeconds,
      expiresAt,
      session.userId,
    ],
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "discord_member",
    resourceId: targetDiscordId,
    actionType: `DISCORD_${action.toUpperCase()}`,
    actionCategory: "discord_moderation",
    severity: action === "ban" || action === "kick" ? 3 : 2,
    metadata: { targetDiscordId, targetUsername, reason, durationSeconds },
  });

  return json({ ok: true, action, targetDiscordId });
}

// Open a DM channel with the user and send `content`. Returns a delivery status:
//   "delivered"    — message accepted by Discord
//   "dms_disabled" — user blocks DMs / shares no guild with the bot (code 50007)
//   "error"        — anything else (bad token, rate limit, network)
export async function deliverDiscordDm(discordUserId, content) {
  try {
    const dmRes = await discordFetch("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!dmRes.ok) {
      let detail = null;
      try {
        detail = await dmRes.json();
      } catch {
        /* empty */
      }
      if (detail?.code === 50007) return { status: "dms_disabled", detail };
      return { status: "error", detail };
    }
    const channel = await dmRes.json();
    const msgRes = await discordFetch(`/channels/${channel.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    if (msgRes.ok) return { status: "delivered" };
    let detail = null;
    try {
      detail = await msgRes.json();
    } catch {
      /* empty */
    }
    // 50007 = "Cannot send messages to this user" → DMs closed to the bot.
    if (detail?.code === 50007) return { status: "dms_disabled", detail };
    return { status: "error", detail };
  } catch (err) {
    return { status: "error", detail: String(err?.message ?? err) };
  }
}

// Warn a player via Discord DM. Gated by its own lower-privilege permission so a
// warner can nudge a member without the power to timeout/kick/ban. We attempt the
// DM and report whether it actually reached the user (DMs may be disabled).
export async function handleDiscordWarn(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordWarn(session, orgId)) {
    return json({ error: "Forbidden: discord_warn permission required" }, 403);
  }
  if (!env.discordBotToken) {
    return json({ error: "DISCORD_BOT_TOKEN is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const targetDiscordId = String(body?.targetDiscordId ?? "").trim();
  const targetUsername = String(body?.targetUsername ?? "").trim();
  const message = String(body?.message ?? "").trim();
  if (!/^\d{5,25}$/.test(targetDiscordId)) {
    return json({ error: "Valid targetDiscordId is required" }, 400);
  }
  if (!message) return json({ error: "message is required" }, 400);
  if (message.length > 1800) {
    return json({ error: "message must be 1800 characters or fewer" }, 400);
  }

  // Per-user cap — warning is an outward-facing action that hits Discord.
  const rl = await checkRateLimit(`rl:discord-warn:${session.userId}`, 20, 60);
  if (rl) return rl;

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const guildId = orgRes.rows[0]?.guild_id;
  if (!guildId) {
    return json({ error: "Organization has no guild_id configured" }, 400);
  }

  const result = await deliverDiscordDm(targetDiscordId, message);
  if (result.status === "error") {
    return json({ error: "Discord API error", details: result.detail }, 502);
  }
  const delivered = result.status === "delivered";

  await pool.query(
    `INSERT INTO discord_mod_log
       (org_id, guild_id, target_discord_id, target_username,
        action_type, reason, duration_seconds, expires_at, actor_user_id)
     VALUES ($1,$2,$3,$4,'WARN',$5,NULL,NULL,$6)`,
    [orgId, guildId, targetDiscordId, targetUsername, message, session.userId],
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "discord_member",
    resourceId: targetDiscordId,
    actionType: "DISCORD_WARN",
    actionCategory: "discord_moderation",
    severity: 2,
    metadata: { targetDiscordId, targetUsername, message, delivered },
  });

  return json({ ok: true, action: "warn", targetDiscordId, delivered });
}

export async function deleteUserDiscordMessagesFromGuild(
  guildId,
  orgId,
  discordUserId,
) {
  if (!env.discordBotToken || !guildId || !discordUserId) return;

  const { rows } = await pool.query(
    `SELECT message_id, channel_id, discord_created_at
     FROM discord_messages
     WHERE org_id = $1 AND guild_id = $2 AND author_discord_id = $3
     ORDER BY channel_id, discord_created_at ASC`,
    [orgId, guildId, discordUserId],
  );

  if (rows.length === 0) return;

  const cutoff = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;

  // Group by channel
  const byChannel = new Map();
  for (const row of rows) {
    if (!byChannel.has(row.channel_id)) byChannel.set(row.channel_id, []);
    byChannel.get(row.channel_id).push(row);
  }

  for (const [channelId, messages] of byChannel) {
    const recent = messages
      .filter((m) => Number(m.discord_created_at) >= cutoff)
      .map((m) => m.message_id);
    const old = messages
      .filter((m) => Number(m.discord_created_at) < cutoff)
      .map((m) => m.message_id);

    // Bulk delete in batches of 100 (Discord minimum is 2)
    for (let i = 0; i < recent.length; i += 100) {
      const batch = recent.slice(i, i + 100);
      if (batch.length === 1) {
        // Bulk-delete requires >= 2; fall back to single delete
        await discordFetch(`/channels/${channelId}/messages/${batch[0]}`, {
          method: "DELETE",
        }).catch(() => {});
      } else {
        await discordFetch(`/channels/${channelId}/messages/bulk-delete`, {
          method: "POST",
          body: JSON.stringify({ messages: batch }),
        }).catch(() => {});
      }
    }

    // Older messages must be deleted individually (Discord restriction)
    for (const messageId of old) {
      await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }
}

export async function fetchAllDiscordBans(guildId) {
  const allBans = [];
  let after = undefined;
  while (true) {
    const params = new URLSearchParams({ limit: "1000" });
    if (after) params.set("after", after);
    const res = await discordFetch(`/guilds/${guildId}/bans?${params}`);
    if (!res.ok) break;
    const bans = await res.json();
    if (!Array.isArray(bans) || bans.length === 0) break;
    allBans.push(...bans);
    if (bans.length < 1000) break;
    after = bans[bans.length - 1].user.id;
  }
  return allBans;
}

export async function handleGetDiscordBans(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewBans(session, orgId))
    return json(
      { error: "Forbidden: discord_bans_view permission required" },
      403,
    );
  if (!env.discordBotToken)
    return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id)
    return json({ error: "Organization has no guild_id configured" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10), 1),
    500,
  );
  const offset = Math.max(
    parseInt(url.searchParams.get("offset") ?? "0", 10),
    0,
  );
  const query = (url.searchParams.get("query") ?? "").toLowerCase().trim();

  const allBans = await fetchAllDiscordBans(org.guild_id);

  // Determine which bans are already in our log and whether they were panel-issued or external
  const { rows: logged } = await pool.query(
    `SELECT DISTINCT ON (target_discord_id)
            target_discord_id, actor_user_id
     FROM discord_mod_log
     WHERE org_id = $1 AND action_type = 'BAN'
     ORDER BY target_discord_id, created_at DESC`,
    [orgId],
  );
  const logMap = new Map(logged.map((r) => [r.target_discord_id, r]));

  let mapped = allBans.map((b) => {
    const log = logMap.get(b.user.id);
    return {
      discordUserId: b.user.id,
      username: b.user.global_name ?? b.user.username,
      reason: b.reason ?? null,
      source: log ? (log.actor_user_id ? "panel" : "external") : "external",
    };
  });

  if (query) {
    mapped = mapped.filter(
      (b) =>
        b.username?.toLowerCase().includes(query) ||
        b.discordUserId?.includes(query) ||
        b.reason?.toLowerCase().includes(query),
    );
  }

  const total = mapped.length;
  return json({
    bans: mapped.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total,
  });
}

export async function handleSyncDiscordBans(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewBans(session, orgId))
    return json(
      { error: "Forbidden: discord_bans_view permission required" },
      403,
    );
  if (!env.discordBotToken)
    return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id)
    return json({ error: "Organization has no guild_id configured" }, 400);

  const allBans = await fetchAllDiscordBans(org.guild_id);

  // Latest known action per discord user (to detect unbanned-then-rebanned externally)
  const { rows: latest } = await pool.query(
    `SELECT DISTINCT ON (target_discord_id)
            target_discord_id, action_type
     FROM discord_mod_log
     WHERE org_id = $1
     ORDER BY target_discord_id, created_at DESC`,
    [orgId],
  );
  const latestAction = new Map(
    latest.map((r) => [r.target_discord_id, r.action_type]),
  );

  let synced = 0;
  for (const ban of allBans) {
    const discordId = ban.user.id;
    const last = latestAction.get(discordId);
    if (!last || last !== "BAN") {
      await pool.query(
        `INSERT INTO discord_mod_log
           (org_id, guild_id, target_discord_id, target_username, action_type, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, 'BAN', $5, NULL)`,
        [
          orgId,
          org.guild_id,
          discordId,
          ban.user.global_name ?? ban.user.username,
          ban.reason ?? null,
        ],
      );
      synced++;
    }
  }

  return json({ ok: true, synced });
}

export async function handleSearchDiscordMembers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  // Warners and staff who can take direct member actions need lookup access.
  if (
    !canDiscordWarn(session, orgId) &&
    !canDiscordTimeout(session, orgId) &&
    !canDiscordKick(session, orgId) &&
    !canDiscordBan(session, orgId)
  )
    return json(
      {
        error:
          "Forbidden: requires discord_warn, discord_timeout, discord_kick, or discord_ban permission",
      },
      403,
    );
  if (!env.discordBotToken)
    return json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);

  const orgRes = await pool.query(
    `SELECT guild_id FROM organizations WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const org = orgRes.rows[0];
  if (!org?.guild_id)
    return json({ error: "Organization has no guild_id configured" }, 400);

  const url = new URL(request.url);
  const query = (url.searchParams.get("query") ?? "").trim();
  if (!query) return json({ members: [] });

  const params = new URLSearchParams({ query, limit: "25" });
  const res = await discordFetch(
    `/guilds/${org.guild_id}/members/search?${params}`,
  );
  if (!res.ok) return json({ members: [] });

  const members = await res.json();
  if (!Array.isArray(members) || members.length === 0)
    return json({ members: [] });

  // Cross-reference with panel staff so the UI can block punitive actions.
  const discordIds = members.map((m) => m.user.id);
  const staffCheckRes = await pool.query(
    `SELECT u.discord_id FROM organization_members om
     JOIN users u ON u.user_id = om.user_id
     WHERE om.org_id = $1 AND u.discord_id = ANY($2::text[])`,
    [orgId, discordIds],
  );
  const staffDiscordIds = new Set(staffCheckRes.rows.map((r) => r.discord_id));

  return json({
    members: members.map((m) => ({
      discordId: m.user.id,
      username: m.user.global_name ?? m.user.username,
      nickname: m.nick ?? null,
      avatar: m.user.avatar
        ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64`
        : null,
      isStaff: staffDiscordIds.has(m.user.id),
    })),
  });
}

export async function handleGetDiscordModLog(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!canDiscordViewModLog(session, orgId)) {
    return json(
      { error: "Forbidden: discord_modlog_view permission required" },
      403,
    );
  }

  const url = new URL(request.url);
  const limit = Math.min(
    100,
    Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 50),
  );
  const offset = Math.max(
    0,
    Math.trunc(Number(url.searchParams.get("offset"))) || 0,
  );
  const targetId = url.searchParams.get("target_discord_id") ?? null;

  const conditions = ["ml.org_id = $1"];
  const params = [orgId];
  let idx = 2;

  if (targetId) {
    conditions.push(`ml.target_discord_id = $${idx++}`);
    params.push(targetId);
  }

  const { rows } = await pool.query(
    `SELECT ml.id, ml.target_discord_id, ml.target_username, ml.action_type,
            ml.reason, ml.duration_seconds, ml.expires_at, ml.created_at,
            u.username AS actor_username
     FROM discord_mod_log ml
     LEFT JOIN users u ON u.user_id = ml.actor_user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ml.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset],
  );

  return json({
    entries: rows.map((r) => ({
      id: r.id,
      targetDiscordId: r.target_discord_id,
      targetUsername: r.target_username,
      actionType: r.action_type,
      reason: r.reason,
      durationSeconds: r.duration_seconds,
      expiresAt: r.expires_at,
      actorUsername: r.actor_username,
      createdAt: r.created_at,
    })),
  });
}

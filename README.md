# IronSight

## Stack

- Frontend: React + TanStack Start
- Backend API: Node runtime inside TanStack server entry
- Database: PostgreSQL
- Cache/session/rate limit/profile cache: Redis
- Background jobs: BullMQ

## Environment

Copy `.env.example` to `.env` and set values:

- `DATABASE_URL` (or `POSTGRESQL_URI`)
- `REDIS_URL` (or `REDIS_URI`)
- `JWT_SECRET`
- `APP_URL`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `SYS_ADMIN_DISCORD_ID`
- `SYSADMIN_STEAM_ID`

Optional runtime tuning:

- `SESSION_TTL_SECONDS` — session lifetime in seconds (code default: 1,209,600 = 14 days)
- `LOGIN_RATE_LIMIT_PER_MINUTE` — default 10
- `PG_POOL_MAX` — PostgreSQL pool size, default 20
- `PG_IDLE_TIMEOUT_MS` — pool idle timeout, default 30000
- `PG_CONNECT_TIMEOUT_MS` — pool acquisition timeout, default 5000 (fails fast under load)
- `DISCORD_REDIRECT_URI` — override OAuth callback URL
- `STEAM_REALM` / `STEAM_RETURN_URL` — override Steam OpenID URLs
- `PTERODACTYL_ENCRYPTION_KEY` — AES-256 key for Pterodactyl API keys; falls back to `JWT_SECRET`
- `DISCORD_BOT_TOKEN` — required for `npm run bot` and Discord Gateway features
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` — Cloudflare R2 for media uploads
- `PROXYCHECK_HMAC_KEY` — verify Proxycheck response signatures (HMAC-SHA256)
- `PROXYCHECK_API_KEY` — fallback Proxycheck key (per-org panel UI keys take priority)
- `RELAY_ALLOW_INSECURE` — set `true` in local dev only to allow `http://` BM relay URLs

## Login Flow

- UI route: `/login`
- First-time setup:
  - start with Discord OAuth2
  - then complete Steam OpenID linking
- Later sign-ins use Discord OAuth2 only if the account already has a linked Steam ID

Startup also ensures a seeded sysadmin account exists for the configured hardcoded owner IDs.

## Auth & Bootstrap API

- `GET /api/auth/discord/start` — starts Discord OAuth2
- `GET /api/auth/discord/callback` — completes Discord OAuth2
- `GET /api/auth/steam/start` — starts Steam OpenID
- `GET /api/auth/steam/callback` — completes Steam OpenID
- `GET /api/todo/bootstrap` — session bootstrap: returns authenticated user, their orgs, org members, and todo rows; called by the frontend on mount to hydrate auth context

## Startup Checks

On startup, API initialization pings:

- PostgreSQL
- Redis
- BullMQ/Redis queue connection

If dependencies are unavailable, API routes return `503`.

## Docker

`Dockerfile` is now a Node 22 multi-stage build and runs:

`npm run start`

The container exposes port `3000` and defines default env vars that should be overridden in production.

## Database Tables

All tables are created on startup via `ensureSchema()`. Additive migrations (ALTER TABLE … ADD COLUMN IF NOT EXISTS) run on every restart.

### Identity & Auth

| Table                   | Purpose                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `users`                 | One row per human. Identified by `discord_id` and/or `steam_id` (at least one required).                              |
| `sessions`              | Active login tokens — `token_hash` + `expires_at` + `revoked` flag. JWT cookie points to `session_id`.                |
| `public_identity_links` | Links a public portal user's Discord + Steam back to a `users` row. Used to verify identity before ticket submission. |

### Organizations & RBAC

| Table                  | Purpose                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `organizations`        | Top-level tenant. `org_id` is a human slug; `guild_id` is the linked Discord server.                                                                   |
| `organization_members` | Joins `users` → `organizations` with a `role_id`.                                                                                                      |
| `roles`                | Custom roles with a `position` integer (higher = more authority). Owner is the immutable top; `org_member`/`org_disabled` sit at 0.                    |
| `permissions`          | Named capability flags (e.g. `players_view`, `bans_create`, `tickets_view`, `role_create`, `org_manage`, `media_upload`, etc.).                        |
| `role_permissions`     | Many-to-many join between `roles` and `permissions`.                                                                                                   |
| `role_discord_roles`   | Maps panel roles to Discord role IDs for sync-on-join.                                                                                                 |
| `role_server_admin`    | Grants in-game server admin to holders of a given role.                                                                                                |
| `api_keys`             | Org-scoped API keys (hashed). Used for server-to-panel ingest.                                                                                         |
| `audit_logs`           | Append-only log of staff actions. Fields: actor, target, resource, action type/category, severity, before/after state, IP, user agent, correlation ID. |
| `org_share_grants`     | Cross-org data-sharing grants (lets org A surface player intel from org B's servers).                                                                   |

### Tickets

| Table                    | Purpose                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ticket_types`           | Per-org ticket categories (e.g. "Ban Appeal"). Supports custom intake questions.                                     |
| `ticket_type_roles`      | Which roles can handle each ticket type.                                                                             |
| `ticket_type_questions`  | Custom form questions attached to a ticket type (free-text, select, etc.).                                           |
| `ticket_blacklist`       | Steam IDs blocked from submitting tickets to an org.                                                                 |
| `tickets`                | One row per ticket. Status: `open` / `waiting_response` / `closed`. Priority: `urgent` / `high` / `normal` / `low`. |
| `ticket_messages`        | Thread messages. `is_internal` marks staff-only notes.                                                               |
| `ticket_audit_log`       | Per-ticket action history (status changes, assignments, etc.).                                                       |
| `ticket_media_links`     | Joins uploaded media objects to a ticket message.                                                                    |
| `ticket_feedback`        | Post-close satisfaction ratings (1–5) + optional comment left by the ticket submitter.                               |
| `ticket_staff_watches`   | Staff subscriptions to ticket notifications.                                                                         |

### Servers & Chat

| Table                    | Purpose                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `servers`                | Game servers registered to an org. Authenticated by `api_key_hash`.                                             |
| `text_chat_log`          | Ingested in-game chat messages. Indexed by `server_id`, `steam_id`, and `created_at`.                           |
| `pvp_log`                | Ingested PVP kill events. Indexed by `server_id`, `killer_steam_id`, and `created_at`.                          |
| `player_reports`         | Player-submitted in-game reports. Indexed by `server_id`, `reported_steam_id`, and `created_at`.                |
| `team_events`            | Team lifecycle events (`created`/`joined`/`left`/`invited`). Indexed by `server_id` and `created_at`.           |
| `server_logs`            | Admin actions ingested via `/api/ingest/server-log` (kicks, bans, RCON commands, noclip, etc.).                  |
| `staff_notification_prefs` | Per-staff opt-in notification preferences (Discord DMs for server events, etc.).                               |
| `server_alert_state`     | Tracks stale-ping state per server so recovery DMs fire only once per outage.                                    |
| `server_player_sessions` | Per-server player session windows (connect → disconnect times) for time-on-server intel.                         |

### Player Intelligence

| Table                        | Purpose                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `player_cache`               | 30-day cached player profile from BattleMetrics + Steam (name, avatar, country, playtime, ban counts, etc.).                  |
| `player_bm_sessions`         | Cached BattleMetrics session windows for a player.                                                                            |
| `player_friends_meta`        | Metadata about the last friends-list fetch for a player.                                                                      |
| `player_friends`             | Steam friends list entries for a player.                                                                                      |
| `player_ip_history`          | Deduplicated IP → player associations ingested from connect events.                                                           |
| `ip_metadata`                | Cached Proxycheck results (VPN/proxy flag, country, ASN) per IP.                                                              |
| `player_related_accounts`    | Computed alt-account relationships (shared IP, shared team, etc.) with relationship types and confidence.                     |
| `player_ip_observations`     | Raw per-org IP observations used for alt-detection within an org's servers.                                                   |
| `player_ip_connection_events`| Connection-event timeline keyed by IP + player for time-ordered alt-detection.                                                |
| `player_bm_ban_observations` | BattleMetrics ban records observed for a player (game, reason, expiry).                                                       |
| `player_session_windows`     | Cross-server play-session windows aggregated from server plugin events.                                                       |
| `player_session_related`     | Players who were online at the same time on the same server (for team/alt-detection).                                         |
| `player_notes`               | Staff-written notes on a player, scoped by org and subject Steam ID, with a `min_rank` visibility gate.                       |
| `player_bm_bans_cache`       | Locally cached BattleMetrics ban list for a player.                                                                           |
| `org_player_sightings`       | Per-org record of a player's last-seen server, name, and IP hash — powers the org Players page.                               |
| `player_bans`                | Bans issued by org staff. Includes type (kick/ban/mute), reason, duration, appeal status, and BM sync state.                  |
| `ban_server_targets`         | Which specific servers a ban applies to (null = org-wide).                                                                    |
| `ban_media_links`            | Media attachments (clips, screenshots) linked to a ban record.                                                                |
| `flagged_steam_groups`       | Steam group IDs flagged as suspicious; membership triggers intel warnings on the player page.                                  |

### Org Configuration

| Table                       | Purpose                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `org_scripts`               | Per-org RCON script library (named command sequences).                                               |
| `org_predefines`            | Predefined ban reasons / durations for quick-ban UI.                                                 |
| `org_toxicity_config`       | AI chat moderation config (thresholds, enabled flag) per org.                                        |
| `org_ban_reasons`           | Org-specific ban reason presets.                                                                     |
| `org_ban_note_formats`      | Org-specific ban note templates.                                                                     |
| `org_plugins`               | Metadata about the Rust plugin installed on each server (version, last seen, config).                |
| `org_external_api_keys`     | Per-org rotating API keys for BattleMetrics, Steam, Proxycheck, and OpenAI (stored encrypted).       |
| `org_external_api_key_stats`| Per-key rate-limit stats and backoff state for automatic key rotation.                               |
| `org_blacklisted_words`     | Per-org word blacklist; served to server plugins via `/api/blacklisted-words`.                       |
| `org_globalping_config`     | Per-org Globalping configuration (enabled targets, RCON actions on high-latency detection).          |
| `org_globalping_measurements`| Active Globalping measurement IDs pending result collection.                                        |
| `org_globalping_results`    | Collected Globalping latency results per server.                                                     |
| `org_ai_moderation_triggers`| Per-org AI moderation trigger rules (keywords, score thresholds, actions).                           |
| `ai_chat_flags`             | Chat messages flagged by AI moderation, with scores and action taken.                                |
| `threat_trigger_config`     | Per-org configurable threat triggers (regex/pattern rules on chat/reports).                          |

### Discord Integration

| Table                         | Purpose                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `discord_messages`            | Synced Discord messages (for the in-panel Discord feed and moderation log).                      |
| `discord_mod_log`             | Moderation actions taken in Discord (bans, timeouts, kicks) synced to the panel.                 |
| `discord_channel_sync`        | Per-org configuration of which Discord channels are synced into the panel feed.                  |
| `discord_member_notify_cursor`| Cursor for the new-member notification bot to avoid double-DMs on restart.                       |

### Media & Docs

| Table                | Purpose                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `org_media`          | Media objects (clips, screenshots) uploaded to R2 by staff or public ticket submitters. Stores vetted MIME type, real size, R2 key, and quota usage. |
| `doc_categories`     | Documentation section categories (org-scoped).                                                                      |
| `doc_articles`       | Wiki / documentation articles (org-scoped), with title, content, and publish state.                                 |
| `doc_article_versions` | Revision history for doc articles.                                                                                |

### Integrations

| Table               | Purpose                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ptero_api_keys`    | One row per org. Stores the Pterodactyl panel URL and AES-256-GCM encrypted API key. Plaintext `api_key` column is migrated to `api_key_encrypted` on startup. |
| `api_relays`        | BattleMetrics API relay nodes (AES-256-GCM encrypted keys, public host validated for SSRF safety).                                                              |
| `api_relay_stats`   | Per-relay request and error counters.                                                                                                                           |
| `todos`             | Legacy internal task tracker (todo/in_progress/completed/blocked).                                                                                              |

## Redis Keys

| Key pattern                      | Type          | TTL                                  | Purpose                                                                                                                                                                 |
| -------------------------------- | ------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session:<sid>`                  | String (JSON) | `SESSION_TTL_SECONDS` (default 24 h) | Cached session payload (userId, username, orgAdminOrgIds, etc.). Validated against the `sessions` table on every request. Updated in-place on username or role changes. |
| `rl:login:<ip>`                  | Counter       | 60 s                                 | Login rate limiter. Incremented on each Discord OAuth attempt; requests rejected above `LOGIN_RATE_LIMIT_PER_MINUTE` (default 10).                                      |
| `openid:steam:<nonce>`           | String        | 10 min                               | One-time nonce for staff Steam OpenID callback validation. Deleted on use.                                                                                              |
| `openid:public:<nonce>`          | String (JSON) | 10 min                               | One-time nonce for public portal Steam OpenID callback. Carries the target org. Deleted on use.                                                                         |
| `cache:members:<sorted-org-ids>` | String (JSON) | 30 s                                 | Cached org member list for the bootstrap endpoint. Invalidated on any member add / remove / role change.                                                                |
| `ticket:<ticketId>`              | String (JSON) | 30 days (open) · 7 days after close  | Cached ticket row. Populated on first load, invalidated on any ticket mutation.                                                                                         |
| `chat:server:<serverId>`         | Sorted set    | 7 days                               | Last 7 days of chat messages for a server, scored by Unix timestamp. Used to serve chat log queries without hitting Postgres for recent windows.                        |
| `rl:chat:<serverId>`             | Counter       | 60 s                                 | Chat ingest rate limiter per server.                                                                                                                                    |
| `pvp:server:<serverId>`          | Sorted set    | 7 days                               | Last 7 days of PVP kill events for a server, scored by Unix timestamp.                                                                                                  |
| `rl:pvp:<serverId>`              | Counter       | 60 s                                 | PVP ingest rate limiter per server (120 req/min).                                                                                                                       |
| `reports:server:<serverId>`      | Sorted set    | 7 days                               | Last 7 days of player reports for a server, scored by Unix timestamp.                                                                                                   |
| `rl:reports:<serverId>`          | Counter       | 60 s                                 | Reports ingest rate limiter per server (60 req/min).                                                                                                                    |
| `team:server:<serverId>`         | Sorted set    | 7 days                               | Last 7 days of team lifecycle events for a server, scored by Unix timestamp.                                                                                            |
| `rl:team:<serverId>`             | Counter       | 60 s                                 | Team event ingest rate limiter per server (120 req/min).                                                                                                                |
| `rl:mute-check:<serverId>`       | Counter       | 60 s                                 | Mute check rate limiter per server (60 req/min).                                                                                                                        |
| `rl:player-view:<userId>`        | Counter       | 60 s                                 | Player-lookup view limiter per user (120 req/min). Each view also writes an audit row, so the cap blunts audit-log flooding.                                            |
| `rl:player-refresh:<userId>`     | Counter       | 60 s                                 | Player force-refresh limiter per user (20 req/min). Refresh triggers external BattleMetrics/Steam/Proxycheck calls, so this caps upstream-API cost amplification.       |
| `rl:player-search:<userId>`      | Counter       | 60 s                                 | Org player-search limiter per user (60 req/min).                                                                                                                        |
| `rl:player-note:<userId>`        | Counter       | 60 s                                 | Player-note creation limiter per user (30 req/min). Prevents note write-spam.                                                                                           |
| `rl:public-servers:<ip>`         | Counter       | 60 s                                 | Per-IP limiter (60 req/min) on the unauthenticated public server list (ticket portal). Protects the DB pool from enumeration floods.                                    |
| `rl:ticket-types:<ip>`           | Counter       | 60 s                                 | Per-IP limiter (60 req/min) on the unauthenticated ticket-types list. Applied only to anonymous callers.                                                                |
| `rl:ban:<userId>`                | Counter       | 60 s                                 | Ban-issuance limiter per user.                                                                                                                                          |
| `rl:ticket:<userId>`             | Counter       | 60 s                                 | Ticket-creation limiter per user (public + staff).                                                                                                                      |

## Security & Rate Limiting

The panel is sized for ~50 concurrent staff users. Access control and abuse protection are enforced **server-side** in `src/backend/api.js`:

- **Sessions** are JWT cookies whose `sid` is validated on every request against the `sessions` table (`token_hash`, `revoked`, `expires_at`) **and** a Redis `session:<sid>` payload. A forged or revoked token fails all three checks.
- **Authorization** — every handler calls `requireSession` then `canManageOrg(session, orgId)` (admin/owner) or `orgHasPermission(session, orgId, <perm>)`. Org owners are members of both the owner and admin sets, so they never fail a permission gate. Handlers derive `owner_org_id` from the looked-up DB row before authorizing (prevents IDOR), and all data is scoped by `org_id`, keeping tenants separated.
- **Rank gating** — `sessionRankForOrg` returns 4 (owner/admin/sysadmin), 3 (any granted permission), or 1 (none). Player notes use this to filter `min_rank` server-side; a staffer can never read or create a note above their own rank.
- **Rate limiting** — Redis `INCR`/`EXPIRE` counters (see table above) fail **open** on Redis errors. Login and OAuth callbacks are IP-limited (`LOGIN_RATE_LIMIT_PER_MINUTE`, default 10); all game-event ingest endpoints are per-server-limited; player view/refresh/search/notes are per-user-limited; unauthenticated public reads are per-IP-limited. Client IP is taken from `cf-connecting-ip` (or the right-most `x-forwarded-for` hop) so it cannot be spoofed by the client.
- **Connection pool** — PostgreSQL pool defaults to `PG_POOL_MAX=20` with a 5 s acquisition timeout (fails fast under load). The player hot path is Redis-first to keep pool pressure low. For sustained 50-user load, raise `PG_POOL_MAX` to match your Postgres `max_connections` headroom.

## Game Event Ingest API

All ingest endpoints authenticate with the server API key.

**Authentication** — pass the server key via either header:

- `Authorization: Bearer <api-key>`
- `x-api-key: <api-key>`

The key is SHA-256 hashed and matched against `servers.api_key_hash`.

---

### POST /api/ingest/chat

Ingest an in-game chat message.

**Request body:**

```json
{
  "message": "Hello everyone",
  "steam_id": "76561198825911004",
  "player_name": "Nightfall",
  "team_message": false
}
```

`player_name` is optional (defaults to `null`). `team_message` is optional (defaults to `false`). `message` max 1000 chars, `steam_id` max 64 chars.

**Response `201`:**

```json
{ "ok": true, "id": "99999" }
```

---

### GET /api/chat/logs

Read chat messages for a server. Requires a valid staff session (org member or sysadmin).

**Query params:**

- `serverId` _(required)_ — UUID of the server
- `start` / `end` — Unix timestamps (default: last 6 hours)
- `limit` — max rows (default 200, max 500)

**Response:**

```json
{
  "lines": [
    {
      "id": "99999",
      "message": "Hello everyone",
      "steamId": "76561198825911004",
      "playerName": "Nightfall",
      "teamMessage": false,
      "ts": 1750000000
    }
  ]
}
```

---

### POST /api/ingest/pvp

Ingest a PVP kill event.

**Request body:**

```json
{
  "killer_steam_id": "76561198825911004",
  "victim_name": "Nightfall",
  "combatlog_cache": {
    "distance": 42.5,
    "weapon": "AK47",
    "bodypart": "head",
    "hp_before": 100,
    "hp_after": 0
  }
}
```

`combatlog_cache` is a free-form JSON object — include any extra fields your plugin produces. Defaults to `{}`.

**Response `201`:**

```json
{ "ok": true, "id": "12345" }
```

---

### POST /api/ingest/reports

Ingest a player report submitted in-game.

**Request body:**

```json
{
  "report_type": "cheating",
  "report_reason": "Aimbot",
  "report_description": "Snapping to heads through walls at 200m",
  "reporter_name": "Nightfall",
  "reporter_steam_id": "76561198825911004",
  "reported_steam_id": "76561198000000001"
}
```

`report_description` is optional (defaults to `""`).

**Response `201`:**

```json
{ "ok": true, "id": "67890" }
```

---

### GET /api/pvp/logs

Read PVP kill events for a server. Requires a valid staff session (org member or sysadmin).

**Query params:**

- `serverId` _(required)_ — UUID of the server
- `start` / `end` — Unix timestamps (default: last 6 hours)
- `limit` — max rows (default 200, max 500)

**Response:**

```json
{
  "lines": [
    {
      "id": "12345",
      "killerSteamId": "76561198825911004",
      "victimName": "Nightfall",
      "combatlogCache": {
        "distance": 42.5,
        "weapon": "AK47",
        "bodypart": "head"
      },
      "ts": 1750000000
    }
  ]
}
```

---

### GET /api/reports/logs

Read player reports for a server. Requires a valid staff session.

**Query params:** same as `/api/pvp/logs`

**Response:**

```json
{
  "lines": [
    {
      "id": "67890",
      "reportType": "cheating",
      "reportReason": "Aimbot",
      "reportDescription": "Snapping to heads through walls at 200m",
      "reporterName": "Nightfall",
      "reporterSteamId": "76561198825911004",
      "reportedSteamId": "76561198000000001",
      "ts": 1750000000
    }
  ]
}
```

---

### /api/teaminfo

Single endpoint for team lifecycle events — `POST` to ingest, `GET` to read.

#### POST /api/teaminfo

Uses server API key auth (`Authorization: Bearer <server key>` or `x-api-key: <server key>`). Send one request per team event as it happens.

**Request body:**

```json
{
  "event_type": "joined",
  "team_leader": "76561198825911004",
  "team_members": [
    "76561198825911004",
    "76561198000000001",
    "76561198000000002"
  ],
  "target_player": null,
  "event_time": "2026-06-16T12:00:00Z"
}
```

| Field           | Type             | Required           | Description                                                                                            |
| --------------- | ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| `event_type`    | string           | yes                | One of `created`, `joined`, `left`, `invited`.                                                         |
| `team_leader`   | string           | yes                | SteamID64 of the team leader. For `invited` events this is the **inviter**. Max 128 chars.             |
| `team_members`  | string[]         | yes                | Current team roster (SteamID64s). May be empty `[]`. Max 100 entries.                                  |
| `target_player` | string \| null   | only for `invited` | SteamID64 of the **invitee** (the player invited to the team). Ignored for other event types. Max 128. |
| `event_time`    | string \| number | no                 | When the event occurred. ISO 8601 string or Unix seconds. Defaults to server receive time.             |

**Example — an invite:**

```json
{
  "event_type": "invited",
  "team_leader": "76561198825911004",
  "team_members": ["76561198825911004", "76561198000000001"],
  "target_player": "76561198000000099",
  "event_time": "2026-06-16T12:05:00Z"
}
```

**Response `201`:**

```json
{ "ok": true, "id": "11111" }
```

**Errors:**

| Status | Body                                                                       | Reason                    |
| ------ | -------------------------------------------------------------------------- | ------------------------- |
| `400`  | `{ "error": "Invalid JSON body" }`                                         | Body is not valid JSON    |
| `400`  | `{ "error": "event_type and team_leader are required" }`                   | Missing required field    |
| `400`  | `{ "error": "event_type must be one of: created, joined, left, invited" }` | Unknown event type        |
| `400`  | `{ "error": "target_player is required for 'invited' events" }`            | Invite without an invitee |
| `401`  | `{ "error": "Missing API key …" }` / `{ "error": "Invalid API key" }`      | Bad/missing server key    |
| `429`  | `{ "error": "Rate limit exceeded" }`                                       | > 120 req/min per server  |

#### GET /api/teaminfo

Requires a valid staff session (org member or sysadmin).

**Query params:** same as `/api/pvp/logs`

**Response:**

```json
{
  "lines": [
    {
      "id": "11111",
      "eventType": "joined",
      "teamLeader": "76561198825911004",
      "teamMembers": ["76561198825911004", "76561198000000001"],
      "targetPlayer": null,
      "eventTimeUnix": 1749999000,
      "ts": 1750000000
    }
  ]
}
```

---

### GET /api/mute-check

Check whether a player is currently muted. Intended for server plugins to call on player join.

Authenticated with the server API key (same headers as ingest endpoints). The org scope is derived from the key — only mutes issued under the key's org are returned.

**Query params:**

- `steam_id` _(required)_ — 64-bit Steam ID of the player to check

**Response — player is muted:**

```json
{
  "muted": true,
  "permanent": false,
  "reason": "Excessive toxicity in voice chat",
  "expiresAt": 1751328000,
  "expiresUnix": 1751328000
}
```

`permanent: true` when the mute has no expiry; in that case `expiresAt` and `expiresUnix` are both `null`. Both fields are always returned and are identical (Unix seconds).

**Response — player is not muted (or mute has expired/been revoked):**

```json
{ "muted": false }
```

**Errors:**

| Status | Body                                                  | Reason                  |
| ------ | ----------------------------------------------------- | ----------------------- |
| `400`  | `{ "error": "steam_id query parameter is required" }` | Missing query param     |
| `400`  | `{ "error": "Invalid steam_id" }`                     | Non-numeric or too long |
| `401`  | `{ "error": "Missing API key …" }`                    | No auth header          |
| `401`  | `{ "error": "Invalid API key" }`                      | Key not found           |
| `429`  | `{ "error": "Rate limit exceeded" }`                  | > 60 req/min per server |

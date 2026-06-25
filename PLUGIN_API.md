# IronSight Plugin API

All plugin endpoints authenticate via a per-server API key. Pass it as either:

```
Authorization: Bearer <server_api_key>
```

or

```
x-api-key: <server_api_key>
```

The key is generated in the panel under **Manage Org → Servers** and stored hashed in the database. If the key is invalid the endpoint returns `401`.

All endpoints return JSON unless stated otherwise. Timestamps are Unix seconds (integers).

---

## Player Connect

**`POST /api/ingest/connect`**

Called when a player joins the server. Triggers a background player-data refresh (BattleMetrics + Steam) if the cache is older than 1 hour or missing. Also records the player's IP address with server context and optionally sets their in-game display name.

**Request body**

```json
{
  "steam_id": "76561198000000000",
  "ip": "1.2.3.4",
  "player_name": "PlayerName"
}
```

| Field         | Type   | Required | Description                                                  |
| ------------- | ------ | -------- | ------------------------------------------------------------ |
| `steam_id`    | string | Yes      | SteamID64 (must match `^765611\d{11}$`)                      |
| `ip`          | string | No       | Player's IP address (used for alt-detection)                 |
| `player_name` | string | No       | In-game display name (used as fallback if no Steam name yet) |

**Response**

```json
{ "ok": true }
```

---

## Player Disconnect

**`POST /api/ingest/disconnect`**

Called when a player leaves the server. Updates the player's `last_seen_at` timestamp in the org's player sightings table.

**Request body**

```json
{
  "steam_id": "76561198000000000",
  "player_name": "PlayerName"
}
```

| Field         | Type   | Required | Description                                   |
| ------------- | ------ | -------- | --------------------------------------------- |
| `steam_id`    | string | Yes      | SteamID64 (must match `^765611\d{11}$`)       |
| `player_name` | string | No       | In-game display name (logged for diagnostics) |

**Response**

```json
{ "ok": true }
```

---

## Chat Message

**`POST /api/ingest/chat`**

Stores a chat message. Persisted to PostgreSQL and cached in Redis for 7 days.

**Request body**

```json
{
  "message": "Hello world",
  "steam_id": "76561198000000000",
  "player_name": "PlayerName",
  "team_message": false
}
```

| Field          | Type    | Required | Description                                        |
| -------------- | ------- | -------- | -------------------------------------------------- |
| `message`      | string  | Yes      | Chat message content (max 1000 chars)              |
| `steam_id`     | string  | Yes      | SteamID64 of the sender                            |
| `player_name`  | string  | No       | In-game display name of the sender (max 128 chars) |
| `team_message` | boolean | No       | `true` if this is a team/squad chat message        |

**Response**

```json
{ "ok": true, "id": "123" }
```

---

## PvP Kill Log

**`POST /api/ingest/pvp`**

Logs a PvP kill event with optional Rust combatlog data. Persisted to PostgreSQL and cached in Redis for 7 days.

**Request body**

```json
{
  "killer_steam_id": "76561198000000000",
  "victim_name": "VictimName",
  "combatlog_cache": {}
}
```

| Field             | Type   | Required | Description                                |
| ----------------- | ------ | -------- | ------------------------------------------ |
| `killer_steam_id` | string | Yes      | SteamID64 of the killer (max 64 chars)     |
| `victim_name`     | string | Yes      | Display name of the victim (max 128 chars) |
| `combatlog_cache` | object | No       | Raw Rust combatlog JSON object (max 64 KB) |

**Response**

```json
{ "ok": true, "id": "456" }
```

---

## In-game Report

**`POST /api/ingest/reports`**

Stores a player report submitted via the in-game F7 menu or a custom plugin command.

**Request body**

```json
{
  "report_type": "cheat",
  "report_reason": "Aimbotting",
  "report_description": "Player was hitting every shot through walls",
  "reporter_name": "ReporterName",
  "reporter_steam_id": "76561198000000001",
  "reported_steam_id": "76561198000000002"
}
```

| Field                | Type   | Required | Description                                       |
| -------------------- | ------ | -------- | ------------------------------------------------- |
| `report_type`        | string | Yes      | Category (max 64 chars, e.g. `cheat`, `toxicity`) |
| `report_reason`      | string | Yes      | Short reason (max 256 chars)                      |
| `report_description` | string | No       | Longer description (max 2000 chars)               |
| `reporter_name`      | string | Yes      | Display name of the reporter (max 128 chars)      |
| `reporter_steam_id`  | string | Yes      | SteamID64 of the reporter (max 64 chars)          |
| `reported_steam_id`  | string | Yes      | SteamID64 of the reported player (max 64 chars)   |

**Response**

```json
{ "ok": true, "id": "789" }
```

---

## Team Event

**`POST /api/ingest/team-event`**

Logs a team/squad change event (member join, leave, team creation, or invite).

**Request body**

```json
{
  "event_type": "joined",
  "team_leader": "76561198000000000",
  "team_members": ["76561198000000001", "76561198000000002"],
  "target_player": null,
  "event_time": "2024-01-01T12:00:00Z"
}
```

| Field           | Type     | Required               | Description                                                       |
| --------------- | -------- | ---------------------- | ----------------------------------------------------------------- |
| `event_type`    | string   | Yes                    | One of: `created`, `joined`, `left`, `invited`                    |
| `team_leader`   | string   | Yes                    | SteamID64 of the team leader (max 128 chars)                      |
| `team_members`  | string[] | Yes                    | SteamID64 array of all current team members (max 100 entries)     |
| `target_player` | string   | Required for `invited` | SteamID64 or name of the invited player (max 128 chars)           |
| `event_time`    | string   | No                     | ISO 8601 timestamp or Unix seconds of the event (defaults to now) |

**Response**

```json
{ "ok": true, "id": "abc" }
```

---

## Server Admin Log

**`POST /api/ingest/server-log`**

Records an admin action taken on the server — commands, kicks, bans, mutes, noclip/godmode toggles, and RCON commands. Entries appear in the **Server Logs** page, visible to org admins and owners only.

**Request body**

```json
{
  "event_type": "KICK",
  "admin_steam_id": "76561198000000001",
  "admin_name": "AdminName",
  "target_steam_id": "76561198000000002",
  "target_name": "TargetName",
  "command": "/kick 76561198000000002 cheating",
  "coordinates": { "x": 123.4, "y": 50.0, "z": -890.1 },
  "details": {}
}
```

| Field             | Type          | Required | Description                                                                                                                          |
| ----------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `event_type`      | string        | Yes      | One of: `ADMIN_COMMAND`, `KICK`, `BAN`, `UNBAN`, `MUTE`, `UNMUTE`, `RCON_COMMAND`, `NOCLIP_TOGGLE`, `GODMODE_TOGGLE`               |
| `admin_steam_id`  | string        | No       | SteamID64 of the admin who performed the action (max 64 chars)                                                                       |
| `admin_name`      | string        | No       | In-game display name of the admin (max 128 chars)                                                                                    |
| `target_steam_id` | string        | No       | SteamID64 of the affected player (max 64 chars)                                                                                      |
| `target_name`     | string        | No       | In-game display name of the affected player (max 128 chars)                                                                          |
| `command`         | string        | No       | The raw command string that was executed (max 1000 chars)                                                                            |
| `coordinates`     | object/string | No       | World coordinates where the command was issued. Pass either `{ "x": float, "y": float, "z": float }` or a pre-formatted string (max 128 chars). Displayed in the Server Logs page. |
| `details`         | object        | No       | Any extra key/value context (e.g. `{ "duration": 3600, "reason": "cheating" }`). Max 4 KB when serialised as JSON.                  |

**Response**

```json
{ "ok": true, "id": "101" }
```

**Suggested plugin hooks**

| Hook / callback               | `event_type` to send  | Recommended fields                                         |
| ----------------------------- | --------------------- | ---------------------------------------------------------- |
| `OnUserCommand` (chat `/cmd`) | `ADMIN_COMMAND`       | `admin_steam_id`, `admin_name`, `command`, `coordinates` (admin position) |
| `OnServerCommand` (console)   | `RCON_COMMAND`        | `command`                                                  |
| `OnPlayerKicked`              | `KICK`                | `admin_steam_id`, `admin_name`, `target_steam_id`, `target_name`, `coordinates` |
| Ban issued (custom)           | `BAN`                 | `admin_steam_id`, `admin_name`, `target_steam_id`, `target_name`, `details.reason`, `details.duration`, `coordinates` |
| Unban issued (custom)         | `UNBAN`               | `admin_steam_id`, `admin_name`, `target_steam_id`          |
| Mute issued (custom)          | `MUTE`                | `admin_steam_id`, `admin_name`, `target_steam_id`, `target_name`, `coordinates` |
| Unmute issued (custom)        | `UNMUTE`              | `admin_steam_id`, `admin_name`, `target_steam_id`          |
| Noclip toggled                | `NOCLIP_TOGGLE`       | `admin_steam_id`, `admin_name`, `details.enabled`, `coordinates` |
| Godmode toggled               | `GODMODE_TOGGLE`      | `admin_steam_id`, `admin_name`, `details.enabled`, `coordinates` |

---

## Bulk Mute Sync

**`POST /api/ingest/mute-sync`**

Returns the active mute state for a batch of players. Useful on server startup to re-apply all existing mutes without querying one by one.

**Request body**

```json
{
  "steam_ids": ["76561198000000001", "76561198000000002"]
}
```

| Field       | Type     | Required | Description                                                             |
| ----------- | -------- | -------- | ----------------------------------------------------------------------- |
| `steam_ids` | string[] | Yes      | List of SteamID64s to check (max 350, invalid IDs are silently skipped) |

**Response**

```json
{
  "active_mutes": {
    "76561198000000001": 1700000000,
    "76561198000000002": null
  }
}
```

The value for each steam ID is the Unix expiry timestamp, or `null` for a permanent mute. Players not in the response are not muted.

---

## Rate limits

All endpoints are rate-limited per server. Exceeding the limit returns `429 Too Many Requests`. The limits are intentionally generous for normal plugin traffic:

| Endpoint             | Limit       |
| -------------------- | ----------- |
| Connect / Disconnect | 300 req/min |
| Chat                 | 120 req/min |
| PvP                  | 120 req/min |
| Reports              | 60 req/min  |
| Team events          | 120 req/min |
| Mute sync            | 120 req/min |
| Server admin log     | 120 req/min |

Rate limiters fail **open** — if Redis is unavailable, requests are passed through rather than rejected.

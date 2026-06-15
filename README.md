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

Optional runtime tuning:

- `SESSION_TTL_SECONDS`
- `LOGIN_RATE_LIMIT_PER_MINUTE`
- `PG_POOL_MAX`
- `PG_IDLE_TIMEOUT_MS`
- `DISCORD_REDIRECT_URI`
- `STEAM_REALM`
- `STEAM_RETURN_URL`
- `PTERODACTYL_ALLOWED_HOSTS`
- `PTERODACTYL_ENCRYPTION_KEY`

## Login Flow

- UI route: `/login`
- First-time setup:
  - start with Discord OAuth2
  - then complete Steam OpenID linking
- Later sign-ins use Discord OAuth2 only if the account already has a linked Steam ID

Startup also ensures a seeded sysadmin account exists for the configured hardcoded owner IDs.

## Todo Page API

- `GET /api/auth/discord/start` starts Discord OAuth2
- `GET /api/auth/discord/callback` completes Discord OAuth2
- `GET /api/auth/steam/start` starts Steam OpenID
- `GET /api/auth/steam/callback` completes Steam OpenID
- `GET /api/todo/bootstrap` loads:
  - authenticated user
  - orgs that include the user in `orgs.discord_ids`
  - org members resolved from `users`
  - todo rows from PostgreSQL

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

| Table | Purpose |
| --- | --- |
| `users` | One row per human. Identified by `discord_id` and/or `steam_id` (at least one required). |
| `sessions` | Active login tokens — `token_hash` + `expires_at` + `revoked` flag. JWT cookie points to `session_id`. |
| `public_identity_links` | Links a public portal user's Discord + Steam back to a `users` row. Used to verify identity before ticket submission. |

### Organizations & RBAC

| Table | Purpose |
| --- | --- |
| `organizations` | Top-level tenant. `org_id` is a human slug; `guild_id` is the linked Discord server. |
| `organization_members` | Joins `users` → `organizations` with a `role_id`. |
| `roles` | Seeded: `org_member`, `org_admin`, `org_owner` (+ legacy `sysadmin` for the global org). |
| `permissions` | Seeded: `todo_write`, `org_manage`, `role_create`. |
| `role_permissions` | Many-to-many join between `roles` and `permissions`. |
| `api_keys` | Org-scoped API keys (hashed). Used for server-to-panel ingest. |
| `audit_logs` | Append-only log of staff actions. Fields: actor, target, resource, action type/category, severity, before/after state, IP, user agent, correlation ID. |

### Tickets

| Table | Purpose |
| --- | --- |
| `ticket_types` | Per-org ticket categories (e.g. "Ban Appeal"). |
| `ticket_type_roles` | Which roles can handle each ticket type. |
| `tickets` | One row per ticket. Status: `open` / `waiting_response` / `closed`. Priority: `urgent` / `high` / `normal` / `low`. |
| `ticket_messages` | Thread messages. `is_internal` (added via migration) marks staff-only notes. |
| `ticket_audit_log` | Per-ticket action history (status changes, assignments, etc.). |

### Servers & Chat

| Table | Purpose |
| --- | --- |
| `servers` | Game servers registered to an org. Authenticated by `api_key_hash`. |
| `text_chat_log` | Ingested in-game chat messages. Indexed by `server_id`, `steam_id`, and `created_at`. |

### Integrations

| Table | Purpose |
| --- | --- |
| `ptero_api_keys` | One row per org. Stores the Pterodactyl panel URL and AES-256-GCM encrypted API key. Plaintext `api_key` column is migrated to `api_key_encrypted` on startup. |
| `todos` | Legacy internal task tracker (todo/in_progress/completed/blocked). |

## Redis Keys

| Key pattern | Type | TTL | Purpose |
| --- | --- | --- | --- |
| `session:<sid>` | String (JSON) | `SESSION_TTL_SECONDS` (default 24 h) | Cached session payload (userId, username, orgAdminOrgIds, etc.). Validated against the `sessions` table on every request. Updated in-place on username or role changes. |
| `rl:login:<ip>` | Counter | 60 s | Login rate limiter. Incremented on each Discord OAuth attempt; requests rejected above `LOGIN_RATE_LIMIT_PER_MINUTE` (default 10). |
| `openid:steam:<nonce>` | String | 10 min | One-time nonce for staff Steam OpenID callback validation. Deleted on use. |
| `openid:public:<nonce>` | String (JSON) | 10 min | One-time nonce for public portal Steam OpenID callback. Carries the target org. Deleted on use. |
| `cache:members:<sorted-org-ids>` | String (JSON) | 30 s | Cached org member list for the bootstrap endpoint. Invalidated on any member add / remove / role change. |
| `ticket:<ticketId>` | String (JSON) | 30 days (open) · 7 days after close | Cached ticket row. Populated on first load, invalidated on any ticket mutation. |
| `chat:server:<serverId>` | Sorted set | 7 days | Last 7 days of chat messages for a server, scored by Unix timestamp. Used to serve chat log queries without hitting Postgres for recent windows. |
| `rl:chat:<serverId>` | Counter | 60 s | Chat ingest rate limiter per server. |

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.node.json", "./tsconfig.app.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from "eslint-plugin-react-x";
import reactDom from "eslint-plugin-react-dom";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs["recommended-typescript"],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.node.json", "./tsconfig.app.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```

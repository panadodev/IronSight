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

Optional runtime tuning:

- `SESSION_TTL_SECONDS`
- `LOGIN_RATE_LIMIT_PER_MINUTE`
- `PG_POOL_MAX`
- `PG_IDLE_TIMEOUT_MS`
- `DISCORD_REDIRECT_URI`
- `STEAM_REALM`
- `STEAM_RETURN_URL`

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

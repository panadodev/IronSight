// Database schema + additive migrations, extracted from api.js.
// Pure SQL against the provided pg Pool — no other backend runtime deps.

import crypto from "node:crypto";

export async function ensureSchema(pool) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION unix_now()
    RETURNS BIGINT LANGUAGE SQL STABLE AS $$
      SELECT EXTRACT(EPOCH FROM NOW())::BIGINT
    $$
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      discord_id TEXT UNIQUE,
      steam_id TEXT UNIQUE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      CONSTRAINT chk_users_identity_present CHECK (discord_id IS NOT NULL OR steam_id IS NOT NULL)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      expires_at BIGINT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      org_id TEXT PRIMARY KEY,
      guild_id TEXT UNIQUE,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      role_id TEXT PRIMARY KEY,
      role_name TEXT NOT NULL UNIQUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      permission_id TEXT PRIMARY KEY,
      permission_name TEXT NOT NULL UNIQUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_discord_roles (
      role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
      discord_role_id TEXT NOT NULL,
      PRIMARY KEY (role_id, discord_role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organization_members (
      org_id TEXT NOT NULL,
      user_id UUID NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id),
      CONSTRAINT fk_org_members_org FOREIGN KEY (org_id) REFERENCES organizations(org_id) ON DELETE CASCADE,
      CONSTRAINT fk_org_members_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      CONSTRAINT fk_org_members_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_id UUID PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      last_used_at BIGINT,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      todo_id UUID PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(user_id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      completed_at BIGINT,
      CONSTRAINT chk_todos_status CHECK (status IN ('todo', 'in_progress', 'completed', 'blocked'))
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_steam_id ON users(steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON organization_members(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON organization_members(user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_todos_org_id ON todos(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_todos_assigned_to ON todos(assigned_to)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status)`,
  );

  // ── Ticket system ──────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_types (
      ticket_type_id SERIAL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      ticket_type_name TEXT NOT NULL,
      ticket_type_description TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_type_roles (
      ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(ticket_type_id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
      PRIMARY KEY (ticket_type_id, role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id SERIAL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      ticket_type_id INTEGER REFERENCES ticket_types(ticket_type_id) ON DELETE SET NULL,
      created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(user_id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      category TEXT,
      title TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      closed_at BIGINT,
      CONSTRAINT chk_tickets_status CHECK (status IN ('open', 'waiting_response', 'closed')),
      CONSTRAINT chk_tickets_priority CHECK (priority IN ('urgent', 'high', 'normal', 'low'))
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
      message_id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_audit_log (
      audit_id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details JSONB,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ticket_types_org_id ON ticket_types(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_tickets_org_id ON tickets(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id ON ticket_messages(ticket_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ticket_audit_ticket_id ON ticket_audit_log(ticket_id)`,
  );

  // Per-org threat-trigger configuration (weighted signals, trigger blocks,
  // bought-account rules). Evaluated on player refresh and F7 report ingest to
  // auto-open tickets. One JSONB row per org.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS threat_trigger_config (
      org_id TEXT PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_by UUID REFERENCES users(user_id) ON DELETE SET NULL
    )
  `);

  // Additive migrations
  await pool.query(
    `ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE`,
  );

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_ticket_types_org_name'
      ) THEN
        ALTER TABLE ticket_types ADD CONSTRAINT uq_ticket_types_org_name
          UNIQUE (org_id, ticket_type_name);
      END IF;
    END $$
  `);

  // Add ticket_type_category column for differentiating player report types
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ticket_types' AND column_name = 'ticket_type_category'
      ) THEN
        ALTER TABLE ticket_types ADD COLUMN ticket_type_category TEXT NOT NULL DEFAULT 'generic'
          CHECK (ticket_type_category IN ('generic', 'player_single', 'player_multi'));
      END IF;
    END $$
  `);

  // Fix categories for ticket types seeded before the category column existed.
  // "Player Report" and cheating/toxicity names → player_single; teaming → player_multi.
  await pool.query(`
    UPDATE ticket_types
    SET ticket_type_category = 'player_single'
    WHERE ticket_type_category = 'generic'
      AND (
        LOWER(ticket_type_name) LIKE '%player report%'
        OR LOWER(ticket_type_name) IN ('cheating', 'toxicity')
      )
  `);
  await pool.query(`
    UPDATE ticket_types
    SET ticket_type_category = 'player_multi'
    WHERE ticket_type_category = 'generic'
      AND LOWER(ticket_type_name) IN ('teaming')
  `);

  // Add is_enabled column to track which ticket types are active for an org
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ticket_types' AND column_name = 'is_enabled'
      ) THEN
        ALTER TABLE ticket_types ADD COLUMN is_enabled BOOLEAN NOT NULL DEFAULT true;
      END IF;
    END $$
  `);

  // Add reported_players column to tickets for structured player Steam ID references
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tickets' AND column_name = 'reported_players'
      ) THEN
        ALTER TABLE tickets ADD COLUMN reported_players TEXT[] NOT NULL DEFAULT '{}';
      END IF;
    END $$
  `);

  // Allow NULL actor_user_id in discord_mod_log for externally-synced bans
  // Guard: table may not exist yet on first migration pass
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'discord_mod_log') THEN
        ALTER TABLE discord_mod_log ALTER COLUMN actor_user_id DROP NOT NULL;
      END IF;
    END $$
  `);

  // ── Public identity links (Discord + Steam for portal ticket submitters) ──

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_identity_links (
      link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      discord_id TEXT NOT NULL UNIQUE,
      discord_username TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_public_identity_links_discord_id ON public_identity_links(discord_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_public_identity_links_steam_id ON public_identity_links(steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_public_identity_links_user_id ON public_identity_links(user_id)`,
  );

  // Audit logs for staff actions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      actor_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE SET NULL,
      target_user_id UUID NULL REFERENCES users(user_id) ON DELETE SET NULL,
      resource_type TEXT NULL,
      resource_id TEXT NULL,
      action_type TEXT NOT NULL,
      action_category TEXT NULL,
      severity SMALLINT NOT NULL DEFAULT 1,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      before_state JSONB NULL,
      after_state JSONB NULL,
      ip_address INET NULL,
      user_agent TEXT NULL,
      session_id TEXT NULL,
      correlation_id UUID NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_org_id ON audit_logs(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id ON audit_logs(actor_user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user_id ON audit_logs(target_user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)`,
  );

  // ── Servers ──────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      server_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_name TEXT NOT NULL,
      owner_org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      api_key_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      added_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_servers_owner_org_id ON servers(owner_org_id)`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS ptero_identifier TEXT`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS rcon_host TEXT`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS rcon_port INTEGER`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS rcon_password_enc TEXT`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS game_port INTEGER`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`,
  );
  await pool.query(
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS last_health_ping BIGINT`,
  );

  // ── Text chat log ─────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS text_chat_log (
      id BIGSERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      player_name TEXT,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      team_message BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_text_chat_log_server_id ON text_chat_log(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_text_chat_log_created_at ON text_chat_log(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_text_chat_log_steam_id ON text_chat_log(steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_text_chat_log_server_created ON text_chat_log(server_id, created_at)`,
  );

  // ── PVP log ─────────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pvp_log (
      id BIGSERIAL PRIMARY KEY,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      killer_steam_id TEXT NOT NULL,
      victim_name TEXT NOT NULL,
      combatlog_cache JSONB NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pvp_log_server_id ON pvp_log(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pvp_log_created_at ON pvp_log(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pvp_log_killer_steam_id ON pvp_log(killer_steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pvp_log_server_created ON pvp_log(server_id, created_at)`,
  );

  // ── Player reports ───────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_reports (
      id BIGSERIAL PRIMARY KEY,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      report_type TEXT NOT NULL,
      report_reason TEXT NOT NULL,
      report_description TEXT NOT NULL DEFAULT '',
      reporter_name TEXT NOT NULL,
      reporter_steam_id TEXT NOT NULL,
      reported_steam_id TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_reports_server_id ON player_reports(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_reports_created_at ON player_reports(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_reports_reported_steam_id ON player_reports(reported_steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_reports_server_created ON player_reports(server_id, created_at)`,
  );

  // ── Team events ──────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_events (
      id BIGSERIAL PRIMARY KEY,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      team_members JSONB NOT NULL DEFAULT '[]',
      team_leader TEXT NOT NULL,
      target_player TEXT,
      event_time BIGINT NOT NULL DEFAULT unix_now(),
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      CONSTRAINT chk_team_events_type CHECK (event_type IN ('created', 'joined', 'left', 'invited'))
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_team_events_server_id ON team_events(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_team_events_created_at ON team_events(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_team_events_server_created ON team_events(server_id, created_at)`,
  );

  // Additive: invite events carry an invitee (target_player) and the 'invited'
  // event type. Existing deployments created the table before these existed.
  await pool.query(
    `ALTER TABLE team_events ADD COLUMN IF NOT EXISTS target_player TEXT`,
  );
  await pool.query(
    `ALTER TABLE team_events DROP CONSTRAINT IF EXISTS chk_team_events_type`,
  );
  await pool.query(
    `ALTER TABLE team_events ADD CONSTRAINT chk_team_events_type
       CHECK (event_type IN ('created', 'joined', 'left', 'invited'))`,
  );

  // ── Server admin action logs ─────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_logs (
      id BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      admin_steam_id TEXT,
      admin_name TEXT,
      target_steam_id TEXT,
      target_name TEXT,
      command TEXT,
      details JSONB NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_server_logs_org_id ON server_logs(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_server_logs_server_id ON server_logs(server_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_server_logs_created_at ON server_logs(created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_server_logs_org_created ON server_logs(org_id, created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_server_logs_event_type ON server_logs(event_type)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_server_logs_admin_steam_id ON server_logs(admin_steam_id)`,
  );

  // -- Pterodactyl integration -----------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ptero_api_keys (
      org_id TEXT PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
      panel_url TEXT NOT NULL,
      api_key TEXT,
      api_key_encrypted TEXT,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      last_used_at BIGINT,
      created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL
    )
  `);
  await pool.query(
    `ALTER TABLE ptero_api_keys ALTER COLUMN api_key DROP NOT NULL`,
  );
  await pool.query(
    `ALTER TABLE ptero_api_keys ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT`,
  );
  await pool.query(
    `ALTER TABLE ptero_api_keys ADD COLUMN IF NOT EXISTS last_used_at BIGINT`,
  );
  await pool.query(
    `ALTER TABLE ptero_api_keys ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL`,
  );

  // ── RCON scripts ────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_scripts (
      script_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      min_rank INTEGER NOT NULL DEFAULT 1,
      created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_scripts_org_id ON org_scripts(org_id)`,
  );

  // ── Manage Org configs: predefines, toxicity, ban/mute reasons ─────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_predefines (
      predefine_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      extra_keywords TEXT[] NOT NULL DEFAULT '{}',
      content TEXT NOT NULL,
      created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_predefines_org_id ON org_predefines(org_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_toxicity_config (
      org_id TEXT PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
      yellow TEXT[] NOT NULL DEFAULT '{}',
      red TEXT[] NOT NULL DEFAULT '{}',
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);

  // Ban/mute reasons. category is one of: cheating, teaming, toxicity, mute.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ban_reasons (
      reason_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      CONSTRAINT chk_org_ban_reasons_category
        CHECK (category IN ('cheating', 'teaming', 'toxicity', 'mute'))
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_ban_reasons_org_id ON org_ban_reasons(org_id)`,
  );

  // Per-category note format templates (one row per org+category).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ban_note_formats (
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      note_format TEXT NOT NULL DEFAULT '',
      updated_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (org_id, category),
      CONSTRAINT chk_org_ban_note_formats_category
        CHECK (category IN ('cheating', 'teaming', 'toxicity', 'mute'))
    )
  `);

  // ── Plugin presets ──────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_plugins (
      plugin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'umod',
      umod_slug TEXT,
      installed_version TEXT,
      latest_version TEXT,
      latest_updated_at BIGINT,
      assigned_tags JSONB NOT NULL DEFAULT '[]',
      risk INTEGER NOT NULL DEFAULT 2 CHECK (risk IN (1,2,3)),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      UNIQUE(org_id, name)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_plugins_org_id ON org_plugins(org_id)`,
  );

  // ── Player bans / mutes ──────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_bans (
      ban_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      action_type TEXT NOT NULL DEFAULT 'ban',
      identifier TEXT NOT NULL,
      identifier_type TEXT NOT NULL,
      category TEXT,
      reason TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      expires_at BIGINT,
      issued_at BIGINT NOT NULL DEFAULT unix_now(),
      issued_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      revoked_at BIGINT,
      revoked_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
      CONSTRAINT chk_ban_action_type CHECK (action_type IN ('ban', 'mute')),
      CONSTRAINT chk_ban_identifier_type CHECK (identifier_type IN ('steam_id', 'ip'))
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bans_org_id ON player_bans(org_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bans_identifier ON player_bans(identifier)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bans_issued_at ON player_bans(issued_at)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ban_server_targets (
      ban_id UUID NOT NULL REFERENCES player_bans(ban_id) ON DELETE CASCADE,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      PRIMARY KEY (ban_id, server_id)
    )
  `);

  // ── External API keys (BattleMetrics / Steam / Proxycheck) per org ─────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_external_api_keys (
      key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      service TEXT NOT NULL,
      key_encrypted TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      priority INT NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      rate_limited_until BIGINT,
      last_used_at BIGINT,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      CONSTRAINT chk_ext_api_key_service
        CHECK (service IN ('battlemetrics', 'steam', 'proxycheck'))
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_external_api_keys_org_service
     ON org_external_api_keys(org_id, service)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_external_api_key_stats (
      key_id                   UUID   NOT NULL REFERENCES org_external_api_keys(key_id) ON DELETE CASCADE,
      bucket_hour              BIGINT NOT NULL,
      org_id                   TEXT   NOT NULL,
      service                  TEXT   NOT NULL,
      rate_limit_max           INT,
      rate_limit_min_remaining INT,
      sample_count             INT    NOT NULL DEFAULT 1,
      PRIMARY KEY (key_id, bucket_hour)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ext_api_key_stats_org_bucket
     ON org_external_api_key_stats(org_id, bucket_hour DESC)`,
  );

  // ── Player data cache tables ───────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_cache (
      steam_id TEXT PRIMARY KEY,
      display_name TEXT,
      avatar_url TEXT,
      steam_profile_visibility TEXT,
      steam_profile_created_at BIGINT,
      steam_rust_hours NUMERIC(10,1),
      steam_data_public BOOLEAN NOT NULL DEFAULT TRUE,
      bm_id TEXT,
      bm_profile_created_at BIGINT,
      bm_private BOOLEAN NOT NULL DEFAULT FALSE,
      bm_rust_hours NUMERIC(10,1),
      bm_aimtrain_hours NUMERIC(10,1),
      bm_server_count INT NOT NULL DEFAULT 0,
      bm_rust_bans_count INT NOT NULL DEFAULT 0,
      bm_rust_bans_last_ban BIGINT,
      bm_rust_bans_banned BOOLEAN NOT NULL DEFAULT FALSE,
      bm_cheating_reports INT NOT NULL DEFAULT 0,
      bm_teaming_reports INT NOT NULL DEFAULT 0,
      bm_other_reports INT NOT NULL DEFAULT 0,
      bm_kills INT NOT NULL DEFAULT 0,
      bm_deaths INT NOT NULL DEFAULT 0,
      steam_cached_at BIGINT,
      bm_cached_at BIGINT,
      activity_cached_at BIGINT,
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_cache_bm_id ON player_cache(bm_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_cache_expires ON player_cache(cache_expires_at)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_bm_sessions (
      steam_id TEXT NOT NULL,
      bm_server_id TEXT NOT NULL,
      server_name TEXT,
      hours_played NUMERIC(10,1) NOT NULL DEFAULT 0,
      last_seen BIGINT,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (steam_id, bm_server_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bm_sessions_steam_id
     ON player_bm_sessions(steam_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_friends_meta (
      steam_id TEXT PRIMARY KEY,
      friends_public BOOLEAN NOT NULL DEFAULT TRUE,
      friend_count INT NOT NULL DEFAULT 0,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_friends (
      steam_id TEXT NOT NULL,
      friend_steam_id TEXT NOT NULL,
      first_seen BIGINT NOT NULL DEFAULT unix_now(),
      last_confirmed BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (steam_id, friend_steam_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_friends_steam_id
     ON player_friends(steam_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_ip_history (
      id BIGSERIAL PRIMARY KEY,
      steam_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      server_id UUID REFERENCES servers(server_id) ON DELETE SET NULL,
      server_name TEXT,
      is_vpn BOOLEAN,
      first_seen BIGINT NOT NULL DEFAULT unix_now(),
      last_seen BIGINT NOT NULL DEFAULT unix_now(),
      UNIQUE(steam_id, ip_address)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_ip_history_steam_id
     ON player_ip_history(steam_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_ip_history_ip_address
     ON player_ip_history(ip_address)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ip_metadata (
      ip_address TEXT PRIMARY KEY,
      is_proxy BOOLEAN,
      is_vpn BOOLEAN,
      isp TEXT,
      country TEXT,
      asn TEXT,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_related_accounts (
      steam_id TEXT NOT NULL,
      related_bm_id TEXT NOT NULL,
      related_name TEXT,
      match_count INT NOT NULL DEFAULT 1,
      has_bm_bans BOOLEAN NOT NULL DEFAULT FALSE,
      bm_ban_count INT NOT NULL DEFAULT 0,
      has_eac_bans BOOLEAN NOT NULL DEFAULT FALSE,
      eac_last_ban BIGINT,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000,
      PRIMARY KEY (steam_id, related_bm_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_related_accounts_steam_id
     ON player_related_accounts(steam_id)`,
  );

  // ── Alt-detection enrichment (additive) ──────────────────────────────────────
  // Connection classification from proxycheck (residential/business/mobile/
  // proxy_vpn/hosting). Existing rows keep is_proxy/is_vpn; conn_type is finer.
  await pool.query(
    `ALTER TABLE ip_metadata ADD COLUMN IF NOT EXISTS conn_type TEXT`,
  );
  // BattleMetrics name-identifier history for the subject (used for name matching).
  await pool.query(
    `ALTER TABLE player_cache ADD COLUMN IF NOT EXISTS bm_name_aliases JSONB`,
  );
  // Steam VAC/game/community/economy ban status (Steam GetPlayerBans). BM's
  // rustBans only covers EAC; these are Steam-level bans across all of a player's
  // games and are a strong independent signal.
  for (const col of [
    `steam_vac_banned BOOLEAN`,
    `steam_vac_count INT`,
    `steam_game_ban_count INT`,
    `steam_days_since_last_ban INT`,
    `steam_community_banned BOOLEAN`,
    `steam_economy_ban TEXT`,
  ]) {
    await pool.query(
      `ALTER TABLE player_cache ADD COLUMN IF NOT EXISTS ${col}`,
    );
  }
  // Per-related-account evidence computed at refresh time.
  for (const col of [
    `related_steam_id TEXT`,
    `name_aliases JSONB`,
    `name_similarity INT`,
    `shared_ips JSONB`,
    `non_proxy_linked BOOLEAN`,
    `mutual_friends JSONB`,
    `shared_groups JSONB`,
    `server_overlap JSONB`,
    `co_presence JSONB`,
    `alt_confidence TEXT`,
  ]) {
    await pool.query(
      `ALTER TABLE player_related_accounts ADD COLUMN IF NOT EXISTS ${col}`,
    );
  }
  // Raw BM session windows for subject + enriched alts, used to compute temporal
  // co-presence (alt-switching vs co-play). Kept separate from the aggregate
  // player_bm_sessions table which only stores per-server totals.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_session_windows (
      steam_id TEXT NOT NULL,
      bm_server_id TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      stopped_at BIGINT,
      PRIMARY KEY (steam_id, bm_server_id, started_at)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_session_windows_steam_id
     ON player_session_windows(steam_id)`,
  );

  // Staff notes attached to a player, scoped per org and gated by min_rank so
  // sensitive notes are only visible to higher ranks. Shared across staff/devices
  // (previously a client-only localStorage store).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_notes (
      id BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL,
      subject_steam_id TEXT NOT NULL,
      body TEXT NOT NULL,
      author_user_id TEXT,
      author_name TEXT,
      min_rank INTEGER NOT NULL DEFAULT 1,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      updated_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_notes_lookup
     ON player_notes(org_id, subject_steam_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_bm_bans_cache (
      id BIGSERIAL PRIMARY KEY,
      steam_id TEXT NOT NULL,
      bm_ban_id TEXT NOT NULL UNIQUE,
      bm_org_id TEXT,
      bm_org_name TEXT,
      reason TEXT,
      note TEXT,
      expires_at BIGINT,
      banned_at BIGINT,
      permanent BOOLEAN NOT NULL DEFAULT TRUE,
      cached_at BIGINT NOT NULL DEFAULT unix_now(),
      cache_expires_at BIGINT NOT NULL DEFAULT unix_now() + 2592000
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bm_bans_cache_steam_id
     ON player_bm_bans_cache(steam_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_player_sightings (
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      steam_id TEXT NOT NULL,
      last_seen_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (org_id, steam_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_player_sightings_org_id
     ON org_player_sightings(org_id)`,
  );

  // ── Discord Moderation ────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_messages (
      message_id TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL DEFAULT '',
      author_discord_id TEXT NOT NULL,
      author_username TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      attachments JSONB NOT NULL DEFAULT '[]',
      discord_created_at BIGINT NOT NULL,
      indexed_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (org_id, message_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_messages_org_channel
     ON discord_messages(org_id, channel_id, discord_created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_messages_author
     ON discord_messages(org_id, author_discord_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_messages_indexed_at
     ON discord_messages(indexed_at)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_mod_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      target_discord_id TEXT NOT NULL,
      target_username TEXT NOT NULL DEFAULT '',
      action_type TEXT NOT NULL,
      reason TEXT,
      duration_seconds INTEGER,
      expires_at BIGINT,
      actor_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_mod_log_org_id
     ON discord_mod_log(org_id, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_discord_mod_log_target
     ON discord_mod_log(org_id, target_discord_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_channel_sync (
      channel_id TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      channel_name TEXT NOT NULL DEFAULT '',
      last_message_id TEXT,
      synced_at BIGINT,
      PRIMARY KEY (org_id, channel_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_member_notify_cursor (
      org_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      last_checked_at BIGINT NOT NULL DEFAULT unix_now(),
      PRIMARY KEY (org_id, guild_id)
    )
  `);

  await pool.query(`
    ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
  `);

  await pool.query(`
    ALTER TABLE todos ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_blacklisted_words (
      word_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      word TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unix_now(),
      UNIQUE (org_id, word)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_blacklisted_words_org_id ON org_blacklisted_words(org_id)`,
  );

  // ── Globalping network monitoring ─────────────────────────────────────────
  // Replaces the former RIPE Atlas integration. The old tables stored a
  // RIPE-specific API key and per-country measurement IDs that are useless for
  // Globalping, so drop them — orgs reconfigure against Globalping instead.

  await pool.query(`DROP TABLE IF EXISTS org_ripe_atlas_results`);
  await pool.query(`DROP TABLE IF EXISTS org_ripe_atlas_measurements`);
  await pool.query(`DROP TABLE IF EXISTS org_ripe_atlas_config`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_globalping_config (
      org_id              TEXT    PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
      api_token_enc       TEXT,
      countries           TEXT[]  NOT NULL DEFAULT '{US,GB,DE,FR,NL,SG,AU,JP,BR,CA}',
      probes_per_country  INTEGER NOT NULL DEFAULT 3,
      check_interval_minutes INTEGER NOT NULL DEFAULT 5,
      created_at          BIGINT  NOT NULL DEFAULT unix_now(),
      updated_at          BIGINT  NOT NULL DEFAULT unix_now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_globalping_measurements (
      id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id            TEXT    NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      server_id         UUID    NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      gp_measurement_id TEXT    NOT NULL,
      target_ip         TEXT    NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'pending',
      created_at        BIGINT  NOT NULL DEFAULT unix_now(),
      results_fetched_at BIGINT
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_globalping_msm_org_status
     ON org_globalping_measurements(org_id, status, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_globalping_msm_server
     ON org_globalping_measurements(server_id)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_globalping_results (
      id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id           TEXT         NOT NULL,
      server_id        UUID         NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      country          TEXT         NOT NULL,
      reachable        BOOLEAN      NOT NULL,
      avg_rtt          NUMERIC(10,2),
      min_rtt          NUMERIC(10,2),
      max_rtt          NUMERIC(10,2),
      probe_count      INTEGER      NOT NULL DEFAULT 0,
      reachable_count  INTEGER      NOT NULL DEFAULT 0,
      measured_at      BIGINT       NOT NULL
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_globalping_results_server_country
     ON org_globalping_results(server_id, country, measured_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_globalping_results_org
     ON org_globalping_results(org_id, measured_at DESC)`,
  );

  await pool.query(
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bm_org_id TEXT`,
  );
  await pool.query(
    `ALTER TABLE player_bans ADD COLUMN IF NOT EXISTS bm_ban_id TEXT`,
  );
  // Opt-in toggle: when TRUE, new bans are mirrored to BattleMetrics as
  // record-only bans (no identifiers, so the player is never banned there).
  await pool.query(
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bm_auto_sync BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  // Links an auto-created Steam ban back to the IP ban whose address the player
  // connected from (IP-ban evasion enforcement). NULL for normal bans.
  await pool.query(
    `ALTER TABLE player_bans ADD COLUMN IF NOT EXISTS source_ip_ban_id UUID
       REFERENCES player_bans(ban_id) ON DELETE SET NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_player_bans_ip_active
       ON player_bans(org_id, identifier)
       WHERE identifier_type = 'ip' AND action_type = 'ban' AND revoked = FALSE`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_player_sessions (
      session_id      BIGSERIAL PRIMARY KEY,
      org_id          TEXT   NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      server_id       UUID   NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      steam_id        TEXT   NOT NULL,
      player_name     TEXT,
      connected_at    BIGINT NOT NULL DEFAULT unix_now(),
      disconnected_at BIGINT
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sps_org_online
     ON server_player_sessions (org_id, server_id, steam_id)
     WHERE disconnected_at IS NULL`,
  );

  // ── AI chat moderation ────────────────────────────────────────────────────
  // Expand the external-key service constraint to include 'openai'.
  await pool.query(`
    ALTER TABLE org_external_api_keys DROP CONSTRAINT IF EXISTS chk_ext_api_key_service
  `);
  await pool.query(`
    ALTER TABLE org_external_api_keys ADD CONSTRAINT chk_ext_api_key_service
      CHECK (service IN ('battlemetrics', 'steam', 'proxycheck', 'openai'))
  `);

  // Store AI moderation scores alongside each chat message (null until evaluated).
  await pool.query(
    `ALTER TABLE text_chat_log ADD COLUMN IF NOT EXISTS ai_flags JSONB`,
  );

  // Per-org trigger rules: fire an action when a moderation score exceeds threshold.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ai_moderation_triggers (
      trigger_id     UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id         TEXT    NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      category       TEXT    NOT NULL,
      threshold      DOUBLE PRECISION NOT NULL DEFAULT 0.8,
      action         TEXT    NOT NULL DEFAULT 'highlight',
      mute_duration_minutes INTEGER,
      apply_to_all_servers BOOLEAN NOT NULL DEFAULT TRUE,
      enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at     BIGINT  NOT NULL DEFAULT unix_now(),
      updated_at     BIGINT  NOT NULL DEFAULT unix_now(),
      created_by     UUID    REFERENCES users(user_id) ON DELETE SET NULL,
      CONSTRAINT chk_ai_trigger_action
        CHECK (action IN ('highlight', 'automute')),
      CONSTRAINT chk_ai_trigger_threshold
        CHECK (threshold >= 0.0 AND threshold <= 1.0),
      CONSTRAINT chk_ai_trigger_category
        CHECK (category IN (
          'harassment', 'harassment/threatening',
          'hate', 'hate/threatening',
          'self-harm', 'self-harm/intent', 'self-harm/instructions',
          'sexual', 'sexual/minors',
          'violence', 'violence/graphic'
        ))
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ai_mod_triggers_org_id
     ON org_ai_moderation_triggers(org_id)`,
  );

  // Flagged messages log — one row per trigger-fire, resolvable by staff.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chat_flags (
      flag_id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      chat_log_id      BIGINT  REFERENCES text_chat_log(id) ON DELETE SET NULL,
      org_id           TEXT    NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
      server_id        UUID    NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      steam_id         TEXT    NOT NULL,
      player_name      TEXT,
      message          TEXT    NOT NULL,
      triggered_category TEXT  NOT NULL,
      score            DOUBLE PRECISION NOT NULL,
      action           TEXT    NOT NULL DEFAULT 'highlight',
      resolved         BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_by      UUID    REFERENCES users(user_id) ON DELETE SET NULL,
      resolved_at      BIGINT,
      created_at       BIGINT  NOT NULL DEFAULT unix_now(),
      CONSTRAINT uq_ai_chat_flag UNIQUE (chat_log_id, triggered_category)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ai_chat_flags_org_resolved
     ON ai_chat_flags(org_id, resolved, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ai_chat_flags_server
     ON ai_chat_flags(server_id, created_at DESC)`,
  );

  // Opt-in toggle: when TRUE, in-game admin perms are granted via RCON whenever
  // a staff member (whose role has server_admin on this server) joins a game server.
  await pool.query(
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sync_perms_on_join BOOLEAN NOT NULL DEFAULT FALSE`,
  );
}

export async function migrateTimestampsToUnix(pool) {
  await pool.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT c.table_name, c.column_name, c.column_default
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.data_type = 'timestamp with time zone'
      LOOP
        -- Drop the default first so PostgreSQL can change the type without
        -- trying to cast a TIMESTAMPTZ expression (e.g. NOW()) to BIGINT.
        IF r.column_default IS NOT NULL THEN
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT',
            r.table_name, r.column_name
          );
        END IF;
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I TYPE BIGINT USING EXTRACT(EPOCH FROM %I)::BIGINT',
          r.table_name, r.column_name, r.column_name
        );
        IF r.column_default LIKE '%interval%' OR r.column_default LIKE '%INTERVAL%' THEN
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT unix_now() + 2592000',
            r.table_name, r.column_name
          );
        ELSIF r.column_default IS NOT NULL AND (r.column_default LIKE '%now()%' OR r.column_default LIKE '%NOW()%') THEN
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT unix_now()',
            r.table_name, r.column_name
          );
        END IF;
      END LOOP;
    END $$
  `);
}

export async function ensureRolePermissionSeed(pool) {
  await pool.query(
    `INSERT INTO roles (role_id, role_name)
     VALUES
      ('org_member', 'Member'),
      ('org_admin', 'Admin'),
      ('org_owner', 'Owner'),
      ('org_disabled', 'Disabled')
     ON CONFLICT (role_id) DO UPDATE SET role_name = EXCLUDED.role_name`,
  );

  await pool.query(
    `INSERT INTO permissions (permission_id, permission_name)
     VALUES
      ('todo_read',           'View todos'),
      ('todo_write',          'Create and edit todos'),
      ('todo_delete',         'Delete todos'),
      ('org_manage',          'Manage organization members'),
      ('role_create',         'Create and manage custom roles'),
      ('rcon_access',         'Use RCON console'),
      ('scripts_view',        'View RCON scripts'),
      ('scripts_manage',      'Manage RCON scripts'),
      ('presets_manage',      'Manage server presets'),
      ('status_view',         'View server status'),
      ('servers_manage',      'Manage server connections'),
      ('tickets_view',        'View support tickets'),
      ('tickets_manage',      'Manage and respond to tickets'),
      ('tickets_player_intel','View player intelligence panel in tickets'),
      ('ban_configs_manage',  'Manage ban and mute configurations'),
      ('toxicity_manage',     'Manage toxicity filters'),
      ('predefines_manage',   'Manage ticket pre-defines'),
      ('bans_delete',         'Delete and revoke bans'),
      ('players_view',        'View player lookup and player list'),
      ('ip_read',             'View player IP addresses and location'),
      ('bans_manage',         'Issue and manage bans and mutes'),
      ('bans_create',         'Create bans and mutes'),
      ('bans_modify',         'Modify existing bans and mutes'),
      ('bans_ip',             'Issue IP bans and auto-ban evaders'),
      ('triggers_manage',     'Configure threat triggers'),
      ('server_admin',        'Admin on Server (grants in-game admin via RCON)'),
      ('discord_mod',         'Use Discord moderation'),
      ('flagged_messages_resolve', 'Resolve AI-flagged chat messages')
     ON CONFLICT (permission_id) DO UPDATE SET permission_name = EXCLUDED.permission_name`,
  );

  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     VALUES
      ('org_member', 'todo_write'),
      ('org_admin', 'todo_write'),
      ('org_admin', 'todo_delete'),
      ('org_admin', 'org_manage'),
      ('org_admin', 'server_admin'),
      ('org_owner', 'todo_write'),
      ('org_owner', 'todo_delete'),
      ('org_owner', 'org_manage'),
      ('org_owner', 'role_create'),
      ('org_owner', 'server_admin')
     ON CONFLICT (role_id, permission_id) DO NOTHING`,
  );

  // Per-role configuration for the "Admin on Server" permission. Built-in
  // Owner/Admin cover ALL of the org's servers (handled in code); custom roles
  // either cover all (roles.server_admin_all) or an explicit list below.
  await pool.query(
    `ALTER TABLE roles ADD COLUMN IF NOT EXISTS server_admin_all BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_server_admin (
      role_id TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
      server_id UUID NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, server_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_role_server_admin_role_id ON role_server_admin(role_id)`,
  );
}

export async function migrateLegacyData(pool) {
  const legacyOrgsExists = await pool.query(
    `SELECT to_regclass('public.orgs') IS NOT NULL AS exists`,
  );
  if (!legacyOrgsExists.rows[0]?.exists) return;

  const { rows: legacyOrgs } = await pool.query(
    "SELECT org_id, guild_id, discord_ids FROM orgs",
  );
  for (const org of legacyOrgs) {
    const orgId = String(org.org_id);
    const guildId = org.guild_id == null ? null : String(org.guild_id);

    await pool.query(
      `INSERT INTO organizations (org_id, guild_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id)
       DO UPDATE SET guild_id = COALESCE(EXCLUDED.guild_id, organizations.guild_id),
                     name = COALESCE(organizations.name, EXCLUDED.name)`,
      [orgId, guildId, orgId],
    );

    for (const discordId of parseMaybeList(org.discord_ids)) {
      const existing = await getUserByDiscordId(discordId);
      const userId = existing?.userId ?? crypto.randomUUID();

      if (!existing) {
        await pool.query(
          `INSERT INTO users (user_id, username, discord_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (discord_id) DO NOTHING`,
          [userId, `user_${discordId.slice(-6)}`, discordId],
        );
      }

      const resolved = existing ?? (await getUserByDiscordId(discordId));
      if (!resolved) continue;

      await pool.query(
        `INSERT INTO organization_members (org_id, user_id, role_id)
         VALUES ($1, $2, 'org_member')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [orgId, resolved.userId],
      );
    }
  }

  const legacyOrgAdminsExists = await pool.query(
    `SELECT to_regclass('public.org_admins') IS NOT NULL AS exists`,
  );
  if (legacyOrgAdminsExists.rows[0]?.exists) {
    const { rows } = await pool.query(
      "SELECT org_id, discord_id FROM org_admins",
    );
    for (const row of rows) {
      const orgId = String(row.org_id);
      const discordId = String(row.discord_id);
      const user = await getUserByDiscordId(discordId);
      if (!user) continue;

      await pool.query(
        `INSERT INTO organization_members (org_id, user_id, role_id)
         VALUES ($1, $2, 'org_admin')
         ON CONFLICT (org_id, user_id)
         DO UPDATE SET role_id = 'org_admin'`,
        [orgId, user.userId],
      );
    }
  }

  const legacyTodoExists = await pool.query(
    `SELECT to_regclass('public.todo') IS NOT NULL AS exists`,
  );
  if (legacyTodoExists.rows[0]?.exists) {
    const { rows } = await pool.query(
      `SELECT todo_id, todo_heading, todo_description, todo_status, assigned_to, org_id, created_unix, completed_unix, created_by
       FROM todo`,
    );

    for (const row of rows) {
      const todoId = String(row.todo_id);
      if (!/^[0-9a-fA-F-]{36}$/.test(todoId)) continue;

      const assignedUser = row.assigned_to
        ? await getUserByDiscordId(String(row.assigned_to))
        : null;
      const createdByUser = row.created_by
        ? await getUserByDiscordId(String(row.created_by))
        : null;

      const createdAt = Number.isFinite(Number(row.created_unix))
        ? Number(row.created_unix)
        : Math.floor(Date.now() / 1000);
      const completedAt = Number.isFinite(Number(row.completed_unix))
        ? Number(row.completed_unix)
        : null;

      await pool.query(
        `INSERT INTO todos (todo_id, org_id, title, description, status, created_by, assigned_to, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, unix_now(), $9)
         ON CONFLICT (todo_id) DO NOTHING`,
        [
          todoId,
          String(row.org_id),
          String(row.todo_heading),
          row.todo_description == null ? "" : String(row.todo_description),
          row.todo_status == null ? "todo" : String(row.todo_status),
          createdByUser?.userId ?? null,
          assignedUser?.userId ?? null,
          createdAt,
          completedAt,
        ],
      );
    }
  }
}

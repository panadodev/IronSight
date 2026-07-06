// Per-org external API key management (BattleMetrics / Steam / Proxycheck / OpenAI). Pure relocation from api.js.

import { auditLog, orgHasPermission, requireSession } from "../core.js";
import { json } from "../http.js";
import { pool } from "../runtime.js";
import {
  getPterodactylEncryptionKey,
  encryptExternalApiKey,
  decryptExternalApiKey,
} from "../crypto-keys.js";

// ── External API key route handlers ──────────────────────────────────────────

export async function handleListExternalKeys(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

  const { rows } = await pool.query(
    `SELECT key_id, org_id, service, label, priority, enabled,
            rate_limited_until, last_used_at, created_at
     FROM org_external_api_keys
     WHERE org_id = $1
     ORDER BY service, priority DESC, created_at`,
    [orgId],
  );

  return json({
    keys: rows.map((r) => ({
      keyId: String(r.key_id),
      service: r.service,
      label: r.label,
      priority: Number(r.priority),
      enabled: Boolean(r.enabled),
      rateLimitedUntil: r.rate_limited_until ?? null,
      lastUsedAt: r.last_used_at ?? null,
      createdAt: r.created_at,
    })),
  });
}

export async function handleAddExternalKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

  if (!getPterodactylEncryptionKey())
    return json(
      {
        error:
          "Encryption not configured (PTERODACTYL_ENCRYPTION_KEY or JWT_SECRET required)",
      },
      503,
    );

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const service = String(body?.service ?? "")
    .trim()
    .toLowerCase();
  const rawKey = String(body?.key ?? "").trim();
  const label = String(body?.label ?? "")
    .trim()
    .slice(0, 128);
  const priority = Number(body?.priority ?? 0);

  if (!["battlemetrics", "steam", "proxycheck", "openai"].includes(service))
    return json(
      { error: "service must be battlemetrics, steam, proxycheck, or openai" },
      400,
    );
  if (!rawKey) return json({ error: "key is required" }, 400);
  if (rawKey.length > 512)
    return json({ error: "key is too long (max 512 characters)" }, 400);

  let keyEncrypted;
  try {
    keyEncrypted = encryptExternalApiKey(rawKey);
  } catch {
    return json({ error: "Encryption error" }, 500);
  }

  const { rows } = await pool.query(
    `INSERT INTO org_external_api_keys
       (org_id, service, key_encrypted, label, priority, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING key_id, service, label, priority, enabled, created_at`,
    [orgId, service, keyEncrypted, label, priority, session.userId],
  );

  const r = rows[0];

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "external_api_key",
    resourceId: String(r.key_id),
    actionType: "EXTERNAL_KEY_ADDED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { service, label },
  });

  return json(
    {
      keyId: String(r.key_id),
      service: r.service,
      label: r.label,
      priority: Number(r.priority),
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
    },
    201,
  );
}

export async function handleUpdateExternalKey(request, orgId, keyId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const sets = [];
  const params = [keyId, orgId];
  let idx = 3;

  if ("label" in body) {
    sets.push(`label = $${idx++}`);
    params.push(String(body.label).trim().slice(0, 128));
  }
  if ("priority" in body) {
    sets.push(`priority = $${idx++}`);
    params.push(Number(body.priority));
  }
  if ("enabled" in body) {
    sets.push(`enabled = $${idx++}`);
    params.push(Boolean(body.enabled));
  }
  if (body.clearRateLimit === true) {
    sets.push(`rate_limited_until = NULL`);
  }

  if (!sets.length) return json({ error: "Nothing to update" }, 400);

  const { rowCount } = await pool.query(
    `UPDATE org_external_api_keys SET ${sets.join(", ")}
     WHERE key_id = $1 AND org_id = $2`,
    params,
  );
  if (!rowCount) return json({ error: "Key not found" }, 404);

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "external_api_key",
    resourceId: String(keyId),
    actionType: "EXTERNAL_KEY_UPDATED",
    actionCategory: "org_management",
    severity: 2,
    metadata: {
      updatedFields: Object.keys(body).filter((k) =>
        ["label", "priority", "enabled", "clearRateLimit"].includes(k),
      ),
    },
  });

  return json({ ok: true });
}

export async function handleDeleteExternalKey(request, orgId, keyId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

  const { rowCount } = await pool.query(
    `DELETE FROM org_external_api_keys WHERE key_id = $1 AND org_id = $2`,
    [keyId, orgId],
  );
  if (!rowCount) return json({ error: "Key not found" }, 404);

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "external_api_key",
    resourceId: String(keyId),
    actionType: "EXTERNAL_KEY_DELETED",
    actionCategory: "org_management",
    severity: 3,
    metadata: { keyId },
  });

  return json({ ok: true });
}

export async function handleGetExternalKeyStats(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage"))
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );

  const sinceHour = Math.floor(Date.now() / 1000 / 3600) * 3600 - 47 * 3600;

  const [{ rows }, pcRows] = await Promise.all([
    pool.query(
      `SELECT key_id::text AS key_id, bucket_hour, rate_limit_max,
              rate_limit_min_remaining, sample_count
       FROM org_external_api_key_stats
       WHERE org_id = $1 AND bucket_hour >= $2
       ORDER BY key_id, bucket_hour`,
      [orgId, sinceHour],
    ),
    pool.query(
      `SELECT key_id::text AS key_id, key_encrypted
       FROM org_external_api_keys
       WHERE org_id = $1 AND service = 'proxycheck'`,
      [orgId],
    ),
  ]);

  const stats = {};
  for (const r of rows) {
    if (!stats[r.key_id]) stats[r.key_id] = [];
    stats[r.key_id].push({
      bucket: Number(r.bucket_hour),
      rateMax: r.rate_limit_max != null ? Number(r.rate_limit_max) : null,
      minRemaining:
        r.rate_limit_min_remaining != null
          ? Number(r.rate_limit_min_remaining)
          : null,
      sampleCount: Number(r.sample_count),
    });
  }

  const proxycheckUsage = {};
  await Promise.all(
    pcRows.rows.map(async (r) => {
      try {
        const key = decryptExternalApiKey(String(r.key_encrypted));
        const resp = await fetch(
          `https://proxycheck.io/dashboard/export/usage/?key=${encodeURIComponent(key)}`,
        );
        if (resp.ok) {
          const data = await resp.json();
          proxycheckUsage[String(r.key_id)] = {
            queriesDay: Number(data["Queries Today"] ?? 0),
            dailyLimit: Number(data["Daily Limit"] ?? 0),
          };
        }
      } catch {
        // non-critical — usage bar just won't show for this key
      }
    }),
  );

  return json({ stats, proxycheckUsage });
}

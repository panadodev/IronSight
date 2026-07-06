// Pterodactyl panel integration: encrypted API keys, server import/status, websocket console, plugin file discovery/config. Pure relocation from api.js.

import crypto from "node:crypto";
import {
  auditLog,
  canManageOrg,
  orgHasPermission,
  requireSession,
} from "../core.js";
import { executeRconCommand } from "../rcon.js";
import { json } from "../http.js";
import { pool } from "../runtime.js";
import {
  getPterodactylEncryptionKey,
  encryptPterodactylApiKey,
  decryptPterodactylApiKey,
} from "../crypto-keys.js";

// Private/reserved IPv4+IPv6 ranges — block to prevent SSRF
export const PRIVATE_HOST_RE =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.|::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;
export const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
]);

export function normalizePterodactylPanelUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) throw new Error("panel_url_required");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("panel_url_invalid");
  }

  if (parsed.protocol !== "https:") throw new Error("panel_url_invalid");
  if (parsed.username || parsed.password) throw new Error("panel_url_invalid");

  const hostname = parsed.hostname.toLowerCase();
  if (
    PRIVATE_HOST_RE.test(hostname) ||
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error("panel_url_invalid");
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";

  return parsed.toString().replace(/\/+$/, "");
}

export function getPterodactylSecurityConfigError() {
  if (!getPterodactylEncryptionKey()) {
    return json(
      {
        error:
          "Pterodactyl integration is not configured: PTERODACTYL_ENCRYPTION_KEY or JWT_SECRET is required.",
      },
      503,
    );
  }

  return null;
}
export async function migratePterodactylApiKeys() {
  const key = getPterodactylEncryptionKey();
  if (!key) return;

  const { rows } = await pool.query(
    `SELECT org_id, api_key
     FROM ptero_api_keys
     WHERE api_key IS NOT NULL
       AND COALESCE(api_key_encrypted, '') = ''`,
  );

  for (const row of rows) {
    const encrypted = encryptPterodactylApiKey(String(row.api_key));
    await pool.query(
      `UPDATE ptero_api_keys
       SET api_key_encrypted = $2,
           api_key = NULL,
           updated_at = unix_now()
       WHERE org_id = $1`,
      [String(row.org_id), encrypted],
    );
  }
}

export async function loadPterodactylCredentials(orgId) {
  const keyRow = await pool.query(
    `SELECT panel_url, api_key, api_key_encrypted
     FROM ptero_api_keys
     WHERE org_id = $1
     LIMIT 1`,
    [orgId],
  );
  if (!keyRow.rows[0]) return null;

  const row = keyRow.rows[0];
  let apiKey = null;

  if (row.api_key_encrypted) {
    apiKey = decryptPterodactylApiKey(String(row.api_key_encrypted));
  } else if (row.api_key) {
    apiKey = String(row.api_key);
    const encrypted = encryptPterodactylApiKey(apiKey);
    await pool.query(
      `UPDATE ptero_api_keys
       SET api_key_encrypted = $2,
           api_key = NULL,
           updated_at = unix_now()
       WHERE org_id = $1`,
      [orgId, encrypted],
    );
  }

  if (!apiKey) throw new Error("pterodactyl_api_key_missing");

  return {
    panelUrl: String(row.panel_url),
    apiKey,
  };
}

// ── Pterodactyl integration ──────────────────────────────────────────────────

export async function handleSavePteroKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const apiKey = String(body?.apiKey ?? "").trim();
  let panelUrl;

  try {
    panelUrl = normalizePterodactylPanelUrl(body?.panelUrl ?? "");
  } catch {
    return json({ error: "panelUrl must be a valid public https URL" }, 400);
  }

  if (!panelUrl || !apiKey) {
    return json({ error: "panelUrl and apiKey are required" }, 400);
  }

  let testRes;
  try {
    testRes = await fetch(`${panelUrl}/api/application/servers?per_page=1`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "Application/vnd.pterodactyl.v1+json",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return json(
      {
        error: `Could not reach Pterodactyl panel: ${String(err.message ?? err)}`,
      },
      502,
    );
  }

  if (testRes.status === 401 || testRes.status === 403) {
    return json({ error: "Invalid Pterodactyl API key" }, 400);
  }
  if (!testRes.ok) {
    return json({ error: `Pterodactyl returned HTTP ${testRes.status}` }, 502);
  }

  await pool.query(
    `INSERT INTO ptero_api_keys (
       org_id,
       panel_url,
       api_key,
       api_key_encrypted,
       updated_at,
       created_by_user_id,
       last_used_at
     )
     VALUES ($1, $2, NULL, $3, unix_now(), $4, NULL)
     ON CONFLICT (org_id)
     DO UPDATE SET panel_url = EXCLUDED.panel_url,
                   api_key = NULL,
                   api_key_encrypted = EXCLUDED.api_key_encrypted,
                   created_by_user_id = EXCLUDED.created_by_user_id,
                   updated_at = unix_now()`,
    [orgId, panelUrl, encryptPterodactylApiKey(apiKey), session.userId],
  );

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "pterodactyl_api_key",
    resourceId: orgId,
    actionType: "PTERODACTYL_API_KEY_SET",
    actionCategory: "server_management",
    severity: 3,
    metadata: {
      panelHost: new URL(panelUrl).host,
    },
  });

  return json({ ok: true, panelUrl });
}

export async function handleGetPteroKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
  }

  const res = await pool.query(
    "SELECT panel_url, updated_at FROM ptero_api_keys WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!res.rows[0]) return json({ connected: false });

  const row = res.rows[0];
  return json({
    connected: true,
    panelUrl: String(row.panel_url),
    updatedAt: row.updated_at ? Number(row.updated_at) : null,
  });
}

export async function handleDeletePteroKey(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
  }

  await pool.query("DELETE FROM ptero_api_keys WHERE org_id = $1", [orgId]);

  await auditLog({
    orgId,
    actorUserId: session.userId,
    resourceType: "pterodactyl_api_key",
    resourceId: orgId,
    actionType: "PTERODACTYL_API_KEY_REMOVED",
    actionCategory: "server_management",
    severity: 3,
  });

  return json({ ok: true });
}

export async function handleListPteroServers(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch (err) {
    console.error("[ptero] Failed to load credentials:", err.message);
    return json({ error: "Stored Pterodactyl credentials are invalid." }, 500);
  }

  if (!credentials) {
    return json({ error: "Pterodactyl not connected for this org" }, 400);
  }

  const { panelUrl, apiKey } = credentials;

  const servers = [];
  let page = 1;
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    let pteroRes;
    try {
      pteroRes = await fetch(
        `${panelUrl}/api/application/servers?include=allocations,node&per_page=50&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "Application/vnd.pterodactyl.v1+json",
          },
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch (err) {
      return json(
        {
          error: `Could not reach Pterodactyl panel: ${String(err.message ?? err)}`,
        },
        502,
      );
    }

    if (!pteroRes.ok) {
      return json(
        { error: `Pterodactyl returned HTTP ${pteroRes.status}` },
        502,
      );
    }

    const data = await pteroRes.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    const included = Array.isArray(data?.included) ? data.included : [];
    const includedAttributesByRef = new Map(
      included
        .filter((entry) => entry?.type && entry?.id)
        .map((entry) => [`${entry.type}:${entry.id}`, entry?.attributes ?? {}]),
    );

    for (const item of items) {
      const attr = item?.attributes ?? {};
      const relationships = item?.relationships ?? {};

      const allocRefs = Array.isArray(relationships?.allocations?.data)
        ? relationships.allocations.data
        : [];
      const allocEntries = allocRefs.map((ref) => {
        const refKey = `${ref?.type ?? ""}:${ref?.id ?? ""}`;
        const resolved = includedAttributesByRef.get(refKey) ?? {};
        return {
          ...resolved,
          ...(ref?.attributes ?? {}),
        };
      });
      const defaultAlloc =
        allocEntries.find((a) => a?.is_default) ?? allocEntries[0] ?? {};

      const nodeRef = relationships?.node?.data;
      const nodeKey = `${nodeRef?.type ?? ""}:${nodeRef?.id ?? ""}`;
      const nodeAttr = {
        ...(includedAttributesByRef.get(nodeKey) ?? {}),
        ...(nodeRef?.attributes ?? {}),
      };

      servers.push({
        pteroId: attr.id,
        uuid: attr.uuid,
        identifier: attr.identifier,
        name: attr.name ?? "",
        description: attr.description ?? "",
        suspended: Boolean(attr.suspended),
        ip: defaultAlloc.ip ?? null,
        port: defaultAlloc.port ?? null,
        nodeName: nodeAttr.name ?? null,
        nodeFqdn: nodeAttr.fqdn ?? null,
        egg: attr.egg ?? null,
        status: attr.status ?? null,
        createdAt: attr.created_at ?? null,
        limits: {
          memory: attr.limits?.memory ?? 0,
          cpu: attr.limits?.cpu ?? 0,
          disk: attr.limits?.disk ?? 0,
          swap: attr.limits?.swap ?? 0,
          io: attr.limits?.io ?? 0,
        },
      });
    }

    const pagination = data?.meta?.pagination;
    if (!pagination || page >= pagination.total_pages) break;
    page++;
  }

  await pool.query(
    `UPDATE ptero_api_keys
     SET last_used_at = unix_now()
     WHERE org_id = $1`,
    [orgId],
  );

  return json({ servers });
}

export async function handleImportPteroServer(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!orgHasPermission(session, orgId, "servers_manage")) {
    return json(
      { error: "Forbidden: servers_manage permission required" },
      403,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const serverName = String(body?.serverName ?? "").trim();
  const pteroIdentifier = String(body?.pteroIdentifier ?? "").trim() || null;
  if (!serverName) return json({ error: "serverName is required" }, 400);
  if (serverName.length > 128) {
    return json({ error: "serverName too long" }, 400);
  }
  if (pteroIdentifier && pteroIdentifier.length > 64) {
    return json({ error: "pteroIdentifier too long" }, 400);
  }

  const orgRes = await pool.query(
    "SELECT org_id FROM organizations WHERE org_id = $1 LIMIT 1",
    [orgId],
  );
  if (!orgRes.rows[0]) return json({ error: "Organization not found" }, 404);

  const plainApiKey = crypto.randomBytes(32).toString("hex");
  const apiKeyHash = crypto
    .createHash("sha256")
    .update(plainApiKey)
    .digest("hex");
  const serverId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO servers (server_id, server_name, owner_org_id, api_key_hash, added_by_user_id, ptero_identifier)
     VALUES ($1, $2, $3, $4, (SELECT user_id FROM users WHERE user_id = $5 LIMIT 1), $6)`,
    [serverId, serverName, orgId, apiKeyHash, session.userId, pteroIdentifier],
  );

  // Best-effort: pull RCON config from Pterodactyl Client API and pre-configure
  // the server. Failures are silently ignored so the import always succeeds.
  let rconInfo = null;
  if (pteroIdentifier && !getPterodactylSecurityConfigError()) {
    try {
      const credentials = await loadPterodactylCredentials(orgId);
      if (credentials) {
        const config = await fetchPteroRconConfig(
          credentials.panelUrl,
          credentials.apiKey,
          pteroIdentifier,
        );
        if (config) {
          const encryptedPass = encryptPterodactylApiKey(config.rconPassword);
          const params = [config.ip, config.rconPort, encryptedPass, serverId];
          let sql = `UPDATE servers SET rcon_host = $1, rcon_port = $2, rcon_password_enc = $3`;
          if (config.gamePort) {
            params.splice(3, 0, config.gamePort);
            sql += `, game_port = $4 WHERE server_id = $5`;
          } else {
            sql += ` WHERE server_id = $4`;
          }
          await pool.query(sql, params);
          rconInfo = {
            rconHost: config.ip,
            rconPort: config.rconPort,
            gamePort: config.gamePort ?? null,
          };
        }
      }
    } catch {
      // ignore
    }
  }

  return json(
    {
      ok: true,
      server: {
        serverId,
        serverName,
        ownerOrgId: orgId,
        pteroIdentifier,
        rconConfigured: Boolean(rconInfo),
        rconHost: rconInfo?.rconHost ?? null,
        rconPort: rconInfo?.rconPort ?? null,
        gamePort: rconInfo?.gamePort ?? null,
      },
      apiKey: plainApiKey,
    },
    201,
  );
}

export const PTERO_HEADERS = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  Accept: "Application/vnd.pterodactyl.v1+json",
});

// Fetch all servers from the Pterodactyl Application API. Throws an Error with
// a `.code` ("ptero_unreachable" | "ptero_http") on failure.
export async function fetchPteroApplicationServers(panelUrl, apiKey) {
  const servers = [];
  let page = 1;
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    let res;
    try {
      res = await fetch(
        `${panelUrl}/api/application/servers?include=allocations,node&per_page=50&page=${page}`,
        { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(10000) },
      );
    } catch (err) {
      const e = new Error(String(err?.message ?? err));
      e.code = "ptero_unreachable";
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.code = "ptero_http";
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    const included = Array.isArray(data?.included) ? data.included : [];
    const includedByRef = new Map(
      included
        .filter((entry) => entry?.type && entry?.id)
        .map((entry) => [`${entry.type}:${entry.id}`, entry?.attributes ?? {}]),
    );

    for (const item of items) {
      const attr = item?.attributes ?? {};
      const relationships = item?.relationships ?? {};

      const allocRefs = Array.isArray(relationships?.allocations?.data)
        ? relationships.allocations.data
        : [];
      const allocEntries = allocRefs.map((ref) => ({
        ...(includedByRef.get(`${ref?.type ?? ""}:${ref?.id ?? ""}`) ?? {}),
        ...(ref?.attributes ?? {}),
      }));
      const defaultAlloc =
        allocEntries.find((a) => a?.is_default) ?? allocEntries[0] ?? {};

      const nodeRef = relationships?.node?.data;
      const nodeAttr = {
        ...(includedByRef.get(`${nodeRef?.type ?? ""}:${nodeRef?.id ?? ""}`) ??
          {}),
        ...(nodeRef?.attributes ?? {}),
      };

      servers.push({
        pteroId: attr.id,
        uuid: attr.uuid,
        identifier: attr.identifier,
        name: attr.name ?? "",
        suspended: Boolean(attr.suspended),
        ip: defaultAlloc.ip ?? null,
        port: defaultAlloc.port ?? null,
        nodeId: attr.node ?? (nodeRef?.id != null ? Number(nodeRef.id) : null),
        nodeName: nodeAttr.name ?? null,
        installStatus: attr.status ?? null,
        limits: {
          memory: attr.limits?.memory ?? 0,
          cpu: attr.limits?.cpu ?? 0,
          disk: attr.limits?.disk ?? 0,
        },
      });
    }

    const pagination = data?.meta?.pagination;
    if (!pagination || page >= pagination.total_pages) break;
    page++;
  }
  return servers;
}

// Fetch nodes (capacity + maintenance) from the Application API.
export async function fetchPteroNodes(panelUrl, apiKey) {
  const nodes = [];
  let page = 1;
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    let res;
    try {
      res = await fetch(
        `${panelUrl}/api/application/nodes?per_page=50&page=${page}`,
        { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(10000) },
      );
    } catch (err) {
      const e = new Error(String(err?.message ?? err));
      e.code = "ptero_unreachable";
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.code = "ptero_http";
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    for (const item of items) {
      const a = item?.attributes ?? {};
      nodes.push({
        id: a.id,
        name: a.name ?? "",
        fqdn: a.fqdn ?? null,
        maintenanceMode: Boolean(a.maintenance_mode),
        memory: a.memory ?? 0,
        disk: a.disk ?? 0,
        memoryOverallocate: a.memory_overallocate ?? 0,
        diskOverallocate: a.disk_overallocate ?? 0,
      });
    }

    const pagination = data?.meta?.pagination;
    if (!pagination || page >= pagination.total_pages) break;
    page++;
  }
  return nodes;
}

// Live per-server utilization via the Client API. Returns null when the stored
// key cannot use the client API (e.g. it is an application-only key) or on any
// transient error — the caller treats null as "no live data".
export async function fetchPteroServerResources(panelUrl, apiKey, identifier) {
  let res;
  try {
    res = await fetch(
      `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/resources`,
      { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(8000) },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const a = data?.attributes ?? {};
  const r = a.resources ?? {};
  return {
    state: a.current_state ?? null,
    resources: {
      memoryBytes: r.memory_bytes ?? 0,
      cpuAbsolute: r.cpu_absolute ?? 0,
      diskBytes: r.disk_bytes ?? 0,
      networkRxBytes: r.network_rx_bytes ?? 0,
      networkTxBytes: r.network_tx_bytes ?? 0,
      uptime: r.uptime ?? 0,
    },
  };
}

// Fetch RCON config for a specific server via the Pterodactyl Client API.
// Uses the startup variables endpoint for RCON_PORT / RCON_PASSWORD, and the
// server details endpoint for the primary allocation IP and game port.
// Returns null on any failure (Application-only keys will 403 the client endpoints).
export async function fetchPteroRconConfig(panelUrl, apiKey, identifier) {
  const enc = encodeURIComponent(identifier);
  const [serverRes, startupRes] = await Promise.allSettled([
    fetch(`${panelUrl}/api/client/servers/${enc}?include=allocations`, {
      headers: PTERO_HEADERS(apiKey),
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`${panelUrl}/api/client/servers/${enc}/startup`, {
      headers: PTERO_HEADERS(apiKey),
      signal: AbortSignal.timeout(8000),
    }),
  ]);

  if (
    serverRes.status !== "fulfilled" ||
    !serverRes.value.ok ||
    startupRes.status !== "fulfilled" ||
    !startupRes.value.ok
  )
    return null;

  let serverData, startupData;
  try {
    [serverData, startupData] = await Promise.all([
      serverRes.value.json(),
      startupRes.value.json(),
    ]);
  } catch {
    return null;
  }

  const allocs = serverData?.attributes?.relationships?.allocations?.data ?? [];
  const defaultAlloc =
    allocs.find((a) => a?.attributes?.is_default) ?? allocs[0] ?? null;
  const rawIp =
    defaultAlloc?.attributes?.ip_alias || defaultAlloc?.attributes?.ip || null;
  // Skip obviously-unroutable bindings
  const ip = rawIp && rawIp !== "0.0.0.0" ? rawIp : null;
  const gamePort = defaultAlloc?.attributes?.port
    ? Number(defaultAlloc.attributes.port)
    : null;

  const vars = startupData?.attributes?.variables?.data ?? [];
  const varMap = Object.fromEntries(
    vars
      .filter((v) => v?.attributes?.env_variable)
      .map((v) => [
        v.attributes.env_variable,
        v.attributes.server_value ?? v.attributes.default_value ?? "",
      ]),
  );

  const rconPort = varMap.RCON_PORT ? Number(varMap.RCON_PORT) : null;
  const rconPassword = varMap.RCON_PASSWORD || null;

  if (!ip || !rconPort || !rconPassword) return null;
  return { ip, gamePort, rconPort, rconPassword };
}

// Combined status payload: node inventory + servers + best-effort live stats.
export async function handleGetPteroStatus(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "status_view") &&
    !orgHasPermission(session, orgId, "servers_manage")
  ) {
    return json(
      { error: "Forbidden: status_view or servers_manage permission required" },
      403,
    );
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch (err) {
    console.error("[ptero] Failed to load credentials:", err.message);
    return json({ error: "Stored Pterodactyl credentials are invalid." }, 500);
  }
  if (!credentials) return json({ connected: false });

  const { panelUrl, apiKey } = credentials;

  let servers, nodes;
  try {
    [servers, nodes] = await Promise.all([
      fetchPteroApplicationServers(panelUrl, apiKey),
      fetchPteroNodes(panelUrl, apiKey),
    ]);
  } catch (err) {
    if (err?.code === "ptero_unreachable") {
      return json(
        { error: `Could not reach Pterodactyl panel: ${err.message}` },
        502,
      );
    }
    return json({ error: `Pterodactyl returned ${err.message}` }, 502);
  }

  // Probe live resources on one server first. If the stored key can't use the
  // client API, skip the fan-out to avoid a burst of failing requests.
  let liveSupported = false;
  const liveByIdentifier = {};
  const candidates = servers.filter((s) => s.identifier);
  if (candidates.length > 0) {
    const probe = await fetchPteroServerResources(
      panelUrl,
      apiKey,
      candidates[0].identifier,
    );
    if (probe) {
      liveSupported = true;
      liveByIdentifier[candidates[0].identifier] = probe;
      const rest = candidates.slice(1, 60);
      const results = await Promise.allSettled(
        rest.map((s) =>
          fetchPteroServerResources(panelUrl, apiKey, s.identifier),
        ),
      );
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value) {
          liveByIdentifier[rest[i].identifier] = r.value;
        }
      });
    }
  }

  // Only surface servers that are registered in IronSight.
  const { rows: registeredRows } = await pool.query(
    `SELECT server_id, server_name, ptero_identifier, last_health_ping FROM servers WHERE owner_org_id = $1 AND ptero_identifier IS NOT NULL`,
    [orgId],
  );
  const registeredByIdentifier = new Map(
    registeredRows.map((r) => [r.ptero_identifier, r]),
  );

  const mergedServers = servers
    .filter((s) => s.identifier && registeredByIdentifier.has(s.identifier))
    .map((s) => {
      const reg = registeredByIdentifier.get(s.identifier);
      return {
        ...s,
        live: liveByIdentifier[s.identifier] ?? null,
        ironsightServerId: reg.server_id,
        ironsightServerName: reg.server_name,
        lastHealthPing: reg.last_health_ping
          ? Number(reg.last_health_ping)
          : null,
      };
    });

  // When live data is supported, infer node connectivity from registered server
  // live-data. A stopped server still returns {state:"offline"}; null means the
  // Client API couldn't reach Wings at all — so null unambiguously means down.
  const nodeOnlineMap = {};
  if (liveSupported) {
    const serversByNode = {};
    for (const s of mergedServers) {
      if (s.nodeId == null) continue;
      if (!serversByNode[s.nodeId]) serversByNode[s.nodeId] = [];
      serversByNode[s.nodeId].push(s);
    }
    for (const [nodeId, nodeServers] of Object.entries(serversByNode)) {
      nodeOnlineMap[Number(nodeId)] = nodeServers.some((s) => s.live !== null);
    }
  }

  const annotatedNodes = nodes.map((n) => ({
    ...n,
    online: Object.prototype.hasOwnProperty.call(nodeOnlineMap, n.id)
      ? nodeOnlineMap[n.id]
      : null,
  }));

  await pool.query(
    `UPDATE ptero_api_keys SET last_used_at = unix_now() WHERE org_id = $1`,
    [orgId],
  );

  return json({
    connected: true,
    liveSupported,
    nodes: annotatedNodes,
    servers: mergedServers,
  });
}

// Mint a short-lived Wings websocket token + socket URL for a server so the
// browser can stream live stats. Requires a client-capable API key.
export async function handleGetPteroServerWebsocket(
  request,
  orgId,
  identifier,
) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (
    !orgHasPermission(session, orgId, "rcon_access") &&
    !orgHasPermission(session, orgId, "servers_manage")
  ) {
    return json(
      { error: "Forbidden: rcon_access or servers_manage permission required" },
      403,
    );
  }

  // Verify the requested identifier belongs to a server registered under this org.
  // Without this check a user could pass any arbitrary Pterodactyl identifier and
  // obtain websocket credentials for a server owned by a different organization if
  // both orgs share the same Pterodactyl panel.
  const ownershipRes = await pool.query(
    `SELECT server_id FROM servers WHERE ptero_identifier = $1 AND owner_org_id = $2 LIMIT 1`,
    [identifier, orgId],
  );
  if (!ownershipRes.rows[0]) {
    return json({ error: "Server not found in this organization" }, 404);
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch (err) {
    console.error("[ptero] Failed to load credentials:", err.message);
    return json({ error: "Stored Pterodactyl credentials are invalid." }, 500);
  }
  if (!credentials) {
    return json({ error: "Pterodactyl not connected for this org" }, 400);
  }

  const { panelUrl, apiKey } = credentials;
  let res;
  try {
    res = await fetch(
      `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/websocket`,
      { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(8000) },
    );
  } catch (err) {
    return json(
      {
        error: `Could not reach Pterodactyl panel: ${String(err.message ?? err)}`,
      },
      502,
    );
  }

  if (res.status === 401 || res.status === 403) {
    return json(
      {
        error:
          "The stored key cannot open the live websocket. A Pterodactyl client API key is required for real-time stats.",
      },
      400,
    );
  }
  if (!res.ok) {
    return json({ error: `Pterodactyl returned HTTP ${res.status}` }, 502);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ error: "Invalid response from panel" }, 502);
  }
  const attr = data?.data ?? data?.attributes ?? {};
  if (!attr.socket || !attr.token) {
    return json({ error: "Panel did not return websocket credentials" }, 502);
  }

  return json({ socket: attr.socket, token: attr.token });
}
// ── Plugin Configs (Pterodactyl file discovery) ────────────────────────────────

export function parseOxidePluginMeta(content) {
  const info = content.match(
    /\[Info\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)\]/,
  );
  const desc = content.match(/\[Description\s*\(\s*"([^"]*)"\s*\)\]/);
  if (!info) return null;
  return {
    name: info[1],
    author: info[2],
    version: info[3],
    description: desc ? desc[1] : null,
  };
}

export function parseOxidePluginList(output) {
  const map = {};
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !/^\d+\s/.test(trimmed)) continue;
    const failedMatch = trimmed.match(
      /^\d+\s+(\S+)\s+-\s+Failed to compile:\s*(.*)/,
    );
    if (failedMatch) {
      map[failedMatch[1]] = { status: "failed", error: failedMatch[2].trim() };
      continue;
    }
    const activeMatch = trimmed.match(/-\s+([\w.]+)\.cs(?:\s*\([^)]*\))?\s*$/);
    if (activeMatch) {
      map[activeMatch[1]] = { status: "active" };
    }
  }
  return map;
}

export function safePluginName(raw) {
  const name = String(raw ?? "").trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name) || name.includes("..")) return null;
  return name;
}

export async function fetchPteroFileList(
  panelUrl,
  apiKey,
  identifier,
  directory,
) {
  const res = await fetch(
    `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/files/list?directory=${encodeURIComponent(directory)}`,
    { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(12000) },
  );
  if (!res.ok) throw new Error(`ptero_file_list_${res.status}`);
  const data = await res.json();
  return (data?.data ?? []).map((f) => f.attributes).filter(Boolean);
}

export async function fetchPteroFileContents(
  panelUrl,
  apiKey,
  identifier,
  filePath,
) {
  const res = await fetch(
    `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/files/contents?file=${encodeURIComponent(filePath)}`,
    { headers: PTERO_HEADERS(apiKey), signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`ptero_file_read_${res.status}`);
  return res.text();
}

export async function writePteroFile(
  panelUrl,
  apiKey,
  identifier,
  filePath,
  content,
) {
  const res = await fetch(
    `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/files/write?file=${encodeURIComponent(filePath)}`,
    {
      method: "POST",
      headers: { ...PTERO_HEADERS(apiKey), "Content-Type": "text/plain" },
      body: content,
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`ptero_file_write_${res.status}`);
}

export async function deletePteroFiles(
  panelUrl,
  apiKey,
  identifier,
  root,
  files,
) {
  const res = await fetch(
    `${panelUrl}/api/client/servers/${encodeURIComponent(identifier)}/files/delete`,
    {
      method: "POST",
      headers: { ...PTERO_HEADERS(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ root, files }),
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!res.ok) throw new Error(`ptero_file_delete_${res.status}`);
}

export async function handleListPteroPlugins(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT owner_org_id, ptero_identifier, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const {
    owner_org_id,
    ptero_identifier,
    rcon_host,
    rcon_port,
    rcon_password_enc,
  } = serverRes.rows[0];

  if (
    !orgHasPermission(session, owner_org_id, "presets_manage") &&
    !orgHasPermission(session, owner_org_id, "servers_manage")
  ) {
    return json({ error: "Forbidden" }, 403);
  }
  if (!ptero_identifier)
    return json({ error: "Server has no Pterodactyl identifier" }, 400);

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(owner_org_id);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  let files;
  try {
    files = await fetchPteroFileList(
      panelUrl,
      apiKey,
      ptero_identifier,
      "/oxide/plugins",
    );
  } catch (err) {
    return json({ error: `Failed to list plugins: ${err.message}` }, 502);
  }

  const csFiles = files.filter(
    (f) => f.is_file && f.name.toLowerCase().endsWith(".cs"),
  );

  const settled = await Promise.allSettled(
    csFiles.map(async (f) => {
      let meta = null;
      try {
        const src = await fetchPteroFileContents(
          panelUrl,
          apiKey,
          ptero_identifier,
          `/oxide/plugins/${f.name}`,
        );
        meta = parseOxidePluginMeta(src);
      } catch {
        // metadata unavailable — use filename fallback
      }
      const pluginName = f.name.replace(/\.cs$/i, "");
      return {
        fileName: f.name,
        pluginName,
        name: meta?.name ?? pluginName,
        author: meta?.author ?? null,
        version: meta?.version ?? null,
        description: meta?.description ?? null,
        modifiedAt: f.modified_at ?? null,
      };
    }),
  );

  const plugins = settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Enrich with live status from RCON if available
  let statusMap = {};
  let rconConnected = false;
  if (rcon_host && rcon_port && rcon_password_enc) {
    try {
      const password = decryptPterodactylApiKey(String(rcon_password_enc));
      const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(password)}`;
      const result = await executeRconCommand(rconUrl, "oxide.plugins");
      statusMap = parseOxidePluginList(result.response);
      rconConnected = true;
    } catch {
      // RCON unavailable — return plugins without live status
    }
  }

  return json({
    plugins: plugins.map((p) => ({
      ...p,
      status: statusMap[p.pluginName]?.status ?? null,
      compileError: statusMap[p.pluginName]?.error ?? null,
    })),
    rconAvailable:
      rcon_host != null && rcon_port != null && rcon_password_enc != null,
    rconConnected,
  });
}

export async function handleGetPteroPluginConfig(request, serverId, rawName) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const pluginName = safePluginName(rawName);
  if (!pluginName) return json({ error: "Invalid plugin name" }, 400);

  const serverRes = await pool.query(
    `SELECT owner_org_id, ptero_identifier FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const { owner_org_id, ptero_identifier } = serverRes.rows[0];

  if (
    !orgHasPermission(session, owner_org_id, "presets_manage") &&
    !orgHasPermission(session, owner_org_id, "servers_manage")
  ) {
    return json({ error: "Forbidden" }, 403);
  }
  if (!ptero_identifier)
    return json({ error: "Server has no Pterodactyl identifier" }, 400);

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(owner_org_id);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  try {
    const content = await fetchPteroFileContents(
      panelUrl,
      apiKey,
      ptero_identifier,
      `/oxide/config/${pluginName}.json`,
    );
    return json({ content });
  } catch (err) {
    if (err.message.includes("404")) return json({ content: null });
    return json({ error: `Failed to read config: ${err.message}` }, 502);
  }
}

export async function handleSavePteroPluginConfig(request, serverId, rawName) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const pluginName = safePluginName(rawName);
  if (!pluginName) return json({ error: "Invalid plugin name" }, 400);

  const serverRes = await pool.query(
    `SELECT owner_org_id, ptero_identifier, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const {
    owner_org_id,
    ptero_identifier,
    rcon_host,
    rcon_port,
    rcon_password_enc,
  } = serverRes.rows[0];

  if (!orgHasPermission(session, owner_org_id, "presets_manage")) {
    return json(
      { error: "Forbidden: presets_manage permission required" },
      403,
    );
  }
  if (!ptero_identifier)
    return json({ error: "Server has no Pterodactyl identifier" }, 400);

  let content;
  try {
    content = await request.text();
  } catch {
    return json({ error: "Failed to read request body" }, 400);
  }
  if (!content || content.length > 1_048_576)
    return json({ error: "Config body is empty or exceeds 1 MB" }, 400);
  try {
    JSON.parse(content);
  } catch {
    return json({ error: "Config must be valid JSON" }, 400);
  }

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(owner_org_id);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  try {
    await writePteroFile(
      panelUrl,
      apiKey,
      ptero_identifier,
      `/oxide/config/${pluginName}.json`,
      content,
    );
  } catch (err) {
    return json({ error: `Failed to write config: ${err.message}` }, 502);
  }

  // Reload plugin via RCON so the new config takes effect
  if (rcon_host && rcon_port && rcon_password_enc) {
    let password;
    try {
      password = decryptPterodactylApiKey(String(rcon_password_enc));
    } catch {
      return json({
        ok: true,
        saved: true,
        rconError: "Failed to decrypt RCON password",
      });
    }
    const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(password)}`;
    try {
      const result = await executeRconCommand(
        rconUrl,
        `oxide.reload ${pluginName}`,
      );
      return json({ ok: true, saved: true, rconOutput: result.response });
    } catch (err) {
      return json({ ok: true, saved: true, rconError: err.message });
    }
  }

  return json({ ok: true, saved: true, rconOutput: null });
}

export async function handlePteroPluginCmd(request, serverId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const serverRes = await pool.query(
    `SELECT owner_org_id, rcon_host, rcon_port, rcon_password_enc
     FROM servers WHERE server_id = $1`,
    [serverId],
  );
  if (!serverRes.rows[0]) return json({ error: "Server not found" }, 404);
  const { owner_org_id, rcon_host, rcon_port, rcon_password_enc } =
    serverRes.rows[0];

  if (!orgHasPermission(session, owner_org_id, "presets_manage")) {
    return json(
      { error: "Forbidden: presets_manage permission required" },
      403,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const cmd = String(body?.cmd ?? "").trim();
  const pluginName = safePluginName(body?.pluginName);

  if (!pluginName) return json({ error: "Invalid plugin name" }, 400);
  if (!["reload", "unload"].includes(cmd))
    return json({ error: "cmd must be reload or unload" }, 400);

  if (!rcon_host || !rcon_port || !rcon_password_enc)
    return json({ error: "RCON not configured for this server" }, 400);

  let password;
  try {
    password = decryptPterodactylApiKey(String(rcon_password_enc));
  } catch {
    return json({ error: "Failed to decrypt RCON password" }, 500);
  }

  const rconUrl = `ws://${rcon_host}:${rcon_port}/${encodeURIComponent(password)}`;
  const rconCmd =
    cmd === "reload"
      ? `oxide.reload ${pluginName}`
      : `oxide.unload ${pluginName}`;

  try {
    const result = await executeRconCommand(rconUrl, rconCmd);
    return json({
      ok: true,
      output: result.response,
      consoleLogs: result.consoleLogs,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

export async function handleBulkDeletePteroPlugin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !orgHasPermission(session, orgId, "presets_manage") &&
    !canManageOrg(session, orgId)
  ) {
    return json({ error: "Forbidden" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const pluginName = safePluginName(body?.pluginName);
  if (!pluginName) return json({ error: "Invalid plugin name" }, 400);
  const deleteConfig = body?.deleteConfig === true;

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  const serversRes = await pool.query(
    `SELECT server_id, server_name, ptero_identifier FROM servers WHERE owner_org_id = $1 AND ptero_identifier IS NOT NULL`,
    [orgId],
  );
  const allServerRows = serversRes.rows;

  const requestedIds = Array.isArray(body?.serverIds) ? body.serverIds : null;
  const serverRows = requestedIds
    ? allServerRows.filter((s) => requestedIds.includes(s.server_id))
    : allServerRows;
  if (serverRows.length === 0)
    return json({ error: "No matching servers found" }, 400);

  const results = await Promise.allSettled(
    serverRows.map(async (s) => {
      await deletePteroFiles(
        panelUrl,
        apiKey,
        s.ptero_identifier,
        "/oxide/plugins",
        [`${pluginName}.cs`],
      );
      if (deleteConfig) {
        try {
          await deletePteroFiles(
            panelUrl,
            apiKey,
            s.ptero_identifier,
            "/oxide/config",
            [`${pluginName}.json`],
          );
        } catch {
          // Config file may not exist — ignore
        }
      }
    }),
  );

  return json({
    results: serverRows.map((s, i) => ({
      serverId: s.server_id,
      serverName: s.server_name,
      ok: results[i].status === "fulfilled",
      error:
        results[i].status === "rejected" ? String(results[i].reason) : null,
    })),
  });
}

export async function handleBulkUploadPteroPlugin(request, orgId) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (
    !orgHasPermission(session, orgId, "presets_manage") &&
    !canManageOrg(session, orgId)
  ) {
    return json({ error: "Forbidden" }, 403);
  }

  const url = new URL(request.url);
  const rawFileName = url.searchParams.get("fileName") ?? "";
  if (
    !/^[a-zA-Z0-9._-]{1,64}\.cs$/i.test(rawFileName) ||
    rawFileName.includes("..")
  ) {
    return json({ error: "Invalid fileName parameter" }, 400);
  }
  const fileName = rawFileName;

  let content;
  try {
    content = await request.text();
  } catch {
    return json({ error: "Failed to read request body" }, 400);
  }
  if (!content || content.length > 10_485_760)
    return json({ error: "File body is empty or exceeds 10 MB" }, 400);

  const securityConfigError = getPterodactylSecurityConfigError();
  if (securityConfigError) return securityConfigError;

  let credentials;
  try {
    credentials = await loadPterodactylCredentials(orgId);
  } catch {
    return json({ error: "Failed to load Pterodactyl credentials" }, 500);
  }
  if (!credentials)
    return json({ error: "Pterodactyl not configured for this org" }, 400);

  const { panelUrl, apiKey } = credentials;

  const rawServerIds = url.searchParams.get("serverIds");
  const requestedIds = rawServerIds
    ? rawServerIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const serversRes = await pool.query(
    `SELECT server_id, server_name, ptero_identifier FROM servers WHERE owner_org_id = $1 AND ptero_identifier IS NOT NULL`,
    [orgId],
  );
  const allServerRows = serversRes.rows;
  const serverRows = requestedIds
    ? allServerRows.filter((s) => requestedIds.includes(s.server_id))
    : allServerRows;
  if (serverRows.length === 0)
    return json({ error: "No matching servers found" }, 400);

  const results = await Promise.allSettled(
    serverRows.map((s) =>
      writePteroFile(
        panelUrl,
        apiKey,
        s.ptero_identifier,
        `/oxide/plugins/${fileName}`,
        content,
      ),
    ),
  );

  return json({
    fileName,
    results: serverRows.map((s, i) => ({
      serverId: s.server_id,
      serverName: s.server_name,
      ok: results[i].status === "fulfilled",
      error:
        results[i].status === "rejected" ? String(results[i].reason) : null,
    })),
  });
}

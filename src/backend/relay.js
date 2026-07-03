// BattleMetrics API relay transport.
//
// Relays are small FastAPI services (see tmp-relay.py), each on its own
// container/IP, that proxy BattleMetrics requests so the panel's traffic is
// spread across many IPs (BM rate-limits by token AND by IP). Relays own no
// tokens — the org's BM token rides *inside* an AES-256-GCM encrypted envelope
// that only the relay's per-relay key can open. The relay decrypts, calls BM,
// and returns an encrypted response.
//
// Security: the envelope is AES-256-GCM (confidentiality + integrity) with a
// random 12-byte IV and a `ts`/`nonce` pair (anti-replay, enforced by the
// relay). Only a party holding the relay key can produce a decryptable
// envelope, so the relay is not an open proxy; it additionally hard-pins the
// upstream host to api.battlemetrics.com. Response payloads are encrypted too,
// so egress logs never see BM data or rate-limit posture.

import crypto from "node:crypto";
import { env } from "./config.js";
import { decryptExternalApiKey } from "./crypto-keys.js";
import { pool } from "./runtime.js";

const RELAY_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS ?? 15000);
const RELAY_RL_COOLDOWN_MAX = 3600;

// Mirrors the SSRF host checks in api.js normalizePterodactylPanelUrl.
const PRIVATE_HOST_RE =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.|::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
]);

// ── Key + envelope crypto ────────────────────────────────────────────────────

// A relay key is 32 random bytes, base64url-encoded, used directly as the
// AES-256 key on both sides (already high-entropy, so no KDF needed).
export function generateRelayKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function relayKeyBuffer(keyB64) {
  const buf = Buffer.from(String(keyB64 ?? ""), "base64url");
  if (buf.length !== 32) throw new Error("relay_key_invalid_length");
  return buf;
}

export function encryptForRelay(keyB64, obj) {
  const key = relayKeyBuffer(keyB64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(obj), "utf8")),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString("base64url"),
    ct: ct.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptFromRelay(keyB64, envelope) {
  const key = relayKeyBuffer(keyB64);
  const { iv, ct, tag } = envelope ?? {};
  if (!iv || !ct || !tag) throw new Error("relay_envelope_invalid");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

// ── Base URL validation ──────────────────────────────────────────────────────

// Validates + canonicalises a relay base URL. Production requires https + a
// public host (same SSRF posture as Pterodactyl panel URLs). RELAY_ALLOW_INSECURE
// relaxes this for local dev only.
export function normalizeRelayBaseUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) throw new Error("relay_url_required");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("relay_url_invalid");
  }
  if (parsed.username || parsed.password) throw new Error("relay_url_invalid");

  const insecureOk = env.relayAllowInsecure === true;
  if (
    parsed.protocol !== "https:" &&
    !(insecureOk && parsed.protocol === "http:")
  ) {
    throw new Error("relay_url_invalid");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isPrivate =
    PRIVATE_HOST_RE.test(hostname) ||
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost");
  if (isPrivate && !insecureOk) throw new Error("relay_url_invalid");

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";
  return parsed.toString().replace(/\/+$/, "");
}

// ── Relay selection + stats ──────────────────────────────────────────────────

// Enabled, online, not-cooling-down relays, least-recently-used first so
// distinct tokens naturally spread across distinct IPs (the "one token per
// relay" heuristic). Returns rows with the decrypted key ready to use.
export async function getUsableRelays() {
  const { rows } = await pool.query(
    `SELECT relay_id, base_url, enc_key_encrypted
     FROM api_relays
     WHERE enabled = TRUE
       AND online = TRUE
       AND (rate_limited_until IS NULL OR rate_limited_until < unix_now())
     ORDER BY last_used_at ASC NULLS FIRST`,
  );
  const relays = [];
  for (const r of rows) {
    try {
      relays.push({
        relayId: String(r.relay_id),
        baseUrl: String(r.base_url),
        key: decryptExternalApiKey(String(r.enc_key_encrypted)),
      });
    } catch {
      console.warn(
        `[relay] relay ${r.relay_id} key failed to decrypt, skipping`,
      );
    }
  }
  return relays;
}

async function markRelayUsed(relayId) {
  await pool.query(
    `UPDATE api_relays SET last_used_at = unix_now() WHERE relay_id = $1`,
    [relayId],
  );
}

async function markRelayRateLimited(relayId, retryAfterSeconds) {
  const secs = Math.min(
    Math.max(Number(retryAfterSeconds) || 60, 1),
    RELAY_RL_COOLDOWN_MAX,
  );
  await pool.query(
    `UPDATE api_relays SET rate_limited_until = unix_now() + $1 WHERE relay_id = $2`,
    [secs, relayId],
  );
}

async function markRelayOffline(relayId) {
  await pool.query(
    `UPDATE api_relays SET online = FALSE, last_health_at = unix_now() WHERE relay_id = $1`,
    [relayId],
  );
}

async function recordRelayStats(relayId, { ok, ms, limited }) {
  const bucketHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  await pool.query(
    `INSERT INTO api_relay_stats
       (relay_id, bucket_hour, request_count, error_count, rate_limited_count, total_latency_ms)
     VALUES ($1, $2, 1, $3, $4, $5)
     ON CONFLICT (relay_id, bucket_hour) DO UPDATE SET
       request_count      = api_relay_stats.request_count + 1,
       error_count        = api_relay_stats.error_count + $3,
       rate_limited_count = api_relay_stats.rate_limited_count + $4,
       total_latency_ms   = api_relay_stats.total_latency_ms + $5`,
    [
      relayId,
      bucketHour,
      ok ? 0 : 1,
      limited ? 1 : 0,
      Math.max(0, Math.round(ms) || 0),
    ],
  );
}

// ── Proxying ─────────────────────────────────────────────────────────────────

function fetchWithTimeout(url, options, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...options, signal: ctl.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// Sends one BM request through a single relay. Returns a reconstructed Response
// (so callers see the same interface as a direct fetch), or throws on transport/
// crypto failure. Throws a tagged error `{ rateLimited, retryAfter }` when the
// relay reports the IP was 429'd by BM so the caller can cool it and rotate.
async function proxyOnce(relay, { url, options }) {
  const method = (options?.method ?? "GET").toUpperCase();
  const headers = { ...(options?.headers ?? {}) };
  const body =
    options?.body != null
      ? Buffer.from(
          typeof options.body === "string"
            ? options.body
            : String(options.body),
          "utf8",
        ).toString("base64")
      : null;

  const envelope = encryptForRelay(relay.key, {
    method,
    url,
    headers,
    body_b64: body,
    ts: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(16).toString("base64url"),
  });

  const resp = await fetchWithTimeout(
    `${relay.baseUrl}/proxy`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    },
    RELAY_TIMEOUT_MS,
  );
  if (!resp.ok) {
    throw new Error(`relay_http_${resp.status}`);
  }

  const replyEnvelope = await resp.json();
  const reply = decryptFromRelay(relay.key, replyEnvelope);

  // Relay signals an IP-level BM 429 so we can cool this relay and rotate.
  if (reply.rate_limited) {
    const err = new Error("relay_bm_rate_limited");
    err.rateLimited = true;
    err.retryAfter = Number(reply.retry_after) || 60;
    throw err;
  }

  const respBody =
    reply.body_b64 != null ? Buffer.from(reply.body_b64, "base64") : null;
  return new Response(respBody, {
    status: Number(reply.status) || 502,
    headers: new Headers(reply.headers ?? {}),
  });
}

// Tries usable relays in order, cooling any that report a BM 429. Returns a
// Response on success, or null if no relay could serve the request (the caller
// then falls back to a direct fetch).
export async function proxyBmViaRelay({ url, options }) {
  const relays = await getUsableRelays();
  if (!relays.length) return null;

  for (const relay of relays) {
    const t0 = Date.now();
    try {
      const resp = await proxyOnce(relay, { url, options });
      const ms = Date.now() - t0;
      markRelayUsed(relay.relayId).catch(() => {});
      recordRelayStats(relay.relayId, { ok: true, ms, limited: false }).catch(
        () => {},
      );
      return resp;
    } catch (err) {
      const ms = Date.now() - t0;
      if (err?.rateLimited) {
        console.warn(
          `[relay] relay=${relay.relayId} BM rate-limited (${err.retryAfter}s), rotating`,
        );
        markRelayRateLimited(relay.relayId, err.retryAfter).catch(() => {});
        recordRelayStats(relay.relayId, { ok: false, ms, limited: true }).catch(
          () => {},
        );
        continue;
      }
      console.warn(`[relay] relay=${relay.relayId} failed: ${err.message}`);
      markRelayOffline(relay.relayId).catch(() => {});
      recordRelayStats(relay.relayId, { ok: false, ms, limited: false }).catch(
        () => {},
      );
      continue;
    }
  }
  return null;
}

// ── Health check ─────────────────────────────────────────────────────────────

// Encrypted challenge/response proving the relay holds the key and is alive.
// Updates online/last_health_at/last_latency_ms. Returns the updated status.
export async function healthCheckRelay({ relayId, baseUrl, keyB64 }) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const envelope = encryptForRelay(keyB64, {
    ping: nonce,
    ts: Math.floor(Date.now() / 1000),
    nonce,
  });
  const t0 = Date.now();
  let online = false;
  let latency = null;
  try {
    const resp = await fetchWithTimeout(
      `${baseUrl}/health`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      },
      RELAY_TIMEOUT_MS,
    );
    latency = Date.now() - t0;
    if (resp.ok) {
      const reply = decryptFromRelay(keyB64, await resp.json());
      online = reply?.pong === nonce;
    }
  } catch (err) {
    console.warn(
      `[relay] health check relay=${relayId} failed: ${err.message}`,
    );
  }
  await pool.query(
    `UPDATE api_relays
     SET online = $1, last_health_at = unix_now(), last_latency_ms = $2
     WHERE relay_id = $3`,
    [online, online ? latency : null, relayId],
  );
  return { online, latency: online ? latency : null };
}

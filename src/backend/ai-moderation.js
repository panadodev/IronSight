// AI chat moderation via OpenAI's Moderation API
// Used by the chat ingest handler (fire-and-forget)

import { decryptExternalApiKey } from "./crypto-keys.js";
import { pool, redis } from "./runtime.js";

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";
const OPENAI_MODERATION_MODEL = "omni-moderation-latest";

// Per-org cap on moderation API calls per minute (safety valve against burst ingest).
const AI_MOD_RATE_LIMIT = parseInt(
  process.env.AI_MODERATION_RATE_LIMIT_PER_MINUTE ?? "300",
  10,
);

// All category keys returned by text-moderation-stable.
export const AI_MODERATION_CATEGORIES = [
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
];

// Human-readable labels and Rust-context notes for each category.
export const CATEGORY_META = {
  harassment: {
    label: "Harassment",
    note: "IRL insults targeting a person — real-world abusive language.",
  },
  "harassment/threatening": {
    label: "Threatening Harassment",
    note: "Direct threats of real-world harm against a player.",
  },
  hate: {
    label: "Hate Speech",
    note: "Slurs or bigotry targeting protected groups.",
  },
  "hate/threatening": {
    label: "Threatening Hate Speech",
    note: "Threatening content grounded in identity-based hatred.",
  },
  "self-harm": {
    label: "Self-Harm Content",
    note: "Content that may encourage self-harm.",
  },
  "self-harm/intent": {
    label: "Self-Harm Intent",
    note: "Expressed intent to self-harm — welfare concern.",
  },
  "self-harm/instructions": {
    label: "Self-Harm Instructions",
    note: "Instructions for self-harm.",
  },
  sexual: {
    label: "Sexual Content",
    note: "Explicit sexual content.",
  },
  "sexual/minors": {
    label: "Sexual Content (Minors)",
    note: "CSAM-adjacent content — zero tolerance.",
  },
  violence: {
    label: "Violence",
    note: "Violent content. NOTE: killing/combat talk is normal in Rust — set threshold very high (>0.95) or leave disabled.",
  },
  "violence/graphic": {
    label: "Graphic Violence",
    note: "Gratuitous real-world gore descriptions.",
  },
};

// Retrieve the first enabled OpenAI key for an org. Returns null if none configured.
export async function getOrgOpenAIKey(orgId) {
  const { rows } = await pool.query(
    `SELECT key_encrypted FROM org_external_api_keys
     WHERE org_id = $1 AND service = 'openai' AND enabled = TRUE
     ORDER BY priority DESC, created_at ASC
     LIMIT 1`,
    [orgId],
  );
  if (!rows[0]) return null;
  try {
    return decryptExternalApiKey(rows[0].key_encrypted);
  } catch {
    return null;
  }
}

// Call the OpenAI Moderation API for a text string. Returns { flagged, categories, scores }.
// Retries up to 3 times on 429 with exponential backoff (1s, 2s, 4s).
export async function callOpenAIModeration(apiKey, text) {
  const MAX_RETRIES = 3;
  let delay = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(OPENAI_MODERATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: OPENAI_MODERATION_MODEL, input: text }),
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("retry-after");
      const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
      await new Promise((r) => setTimeout(r, wait));
      delay *= 2;
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI moderation API error ${res.status}: ${body}`);
    }

    const ratelimitHeaders = {
      remainingRequests: res.headers.get("x-ratelimit-remaining-requests"),
      limitRequests: res.headers.get("x-ratelimit-limit-requests"),
      remainingTokens: res.headers.get("x-ratelimit-remaining-tokens"),
      limitTokens: res.headers.get("x-ratelimit-limit-tokens"),
      resetRequests: res.headers.get("x-ratelimit-reset-requests"),
      resetTokens: res.headers.get("x-ratelimit-reset-tokens"),
    };

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) throw new Error("Unexpected OpenAI response: no results");

    return {
      flagged: Boolean(result.flagged),
      categories: result.categories ?? {},
      scores: result.category_scores ?? {},
      ratelimitHeaders,
    };
  }
}

// Load active moderation triggers for an org from DB.
async function loadTriggers(orgId) {
  const { rows } = await pool.query(
    `SELECT trigger_id, category, threshold, action, mute_duration_minutes
     FROM org_ai_moderation_triggers
     WHERE org_id = $1 AND enabled = TRUE
     ORDER BY threshold DESC`,
    [orgId],
  );
  return rows;
}

// Issue an automated mute for a player via DB (plugin syncs on next connect/poll).
async function issueMute(orgId, steamId, trigger, serverId) {
  const reason = `AI auto-moderation: ${trigger.category} score exceeded threshold (${(trigger.threshold * 100).toFixed(0)}%)`;
  const expiresAt =
    trigger.mute_duration_minutes != null
      ? Math.floor(Date.now() / 1000) + trigger.mute_duration_minutes * 60
      : null;

  const { rows } = await pool.query(
    `INSERT INTO player_bans
       (org_id, action_type, identifier, identifier_type, category, reason, expires_at)
     VALUES ($1, 'mute', $2, 'steam_id', 'toxicity', $3, $4)
     RETURNING ban_id`,
    [orgId, steamId, reason, expiresAt],
  );
  const banId = rows[0]?.ban_id;

  // Scope the mute to the specific server where the message was sent.
  if (banId && serverId) {
    await pool
      .query(
        `INSERT INTO ban_server_targets (ban_id, server_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [banId, serverId],
      )
      .catch(() => {});
  }

  console.log(
    `[ai-mod] auto-muted steamId=${steamId} org=${orgId} category=${trigger.category} ban=${banId}`,
  );
}

// Fire-and-forget moderation for an ingested chat message.
// chatRowId: BIGINT id from text_chat_log; orgId comes from server.owner_org_id.
export function runChatModerationAsync(
  chatRowId,
  orgId,
  steamId,
  serverId,
  message,
  playerName,
) {
  _runChatModeration(
    chatRowId,
    orgId,
    steamId,
    serverId,
    message,
    playerName,
  ).catch((err) => {
    console.error(`[ai-mod] background error for chat row ${chatRowId}:`, err);
  });
}

async function upsertCombinedFlag(
  chatRowId,
  orgId,
  serverId,
  steamId,
  playerName,
  message,
  signalEntries,
) {
  if (!signalEntries.length) return;

  const sortedSignals = [...signalEntries].sort(
    (a, b) => Number(b.score) - Number(a.score),
  );
  const primarySignal = sortedSignals[0];
  const action = sortedSignals.some((s) => s.action === "automute")
    ? "automute"
    : "highlight";
  const signals = Object.fromEntries(
    sortedSignals.map((s) => [s.category, Number(s.score)]),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${orgId}:${chatRowId}`,
    ]);

    const { rows: existingRows } = await client.query(
      `SELECT flag_id
       FROM ai_chat_flags
       WHERE chat_log_id = $1 AND org_id = $2
       ORDER BY created_at DESC, flag_id DESC`,
      [chatRowId, orgId],
    );

    if (existingRows.length) {
      const keepId = existingRows[0].flag_id;
      await client.query(
        `UPDATE ai_chat_flags
         SET server_id = $1,
             steam_id = $2,
             player_name = $3,
             message = $4,
             triggered_category = $5,
             score = $6,
             action = $7,
             signals = $8::jsonb
         WHERE flag_id = $9`,
        [
          serverId,
          steamId,
          playerName ?? null,
          message,
          primarySignal.category,
          Number(primarySignal.score),
          action,
          JSON.stringify(signals),
          keepId,
        ],
      );

      if (existingRows.length > 1) {
        await client.query(
          `DELETE FROM ai_chat_flags
           WHERE chat_log_id = $1 AND org_id = $2 AND flag_id <> $3`,
          [chatRowId, orgId, keepId],
        );
      }
    } else {
      await client.query(
        `INSERT INTO ai_chat_flags
           (chat_log_id, org_id, server_id, steam_id, player_name, message,
            triggered_category, score, action, signals)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          chatRowId,
          orgId,
          serverId,
          steamId,
          playerName ?? null,
          message,
          primarySignal.category,
          Number(primarySignal.score),
          action,
          JSON.stringify(signals),
        ],
      );
    }

    await client.query("COMMIT");

    redis
      .publish(
        `flagged-stream:${orgId}`,
        JSON.stringify({
          type: "flag_upserted",
          orgId,
          chatLogId: String(chatRowId),
          steamId,
          at: Math.floor(Date.now() / 1000),
        }),
      )
      .catch(() => {});
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[ai-mod] failed to upsert combined flag:`, err);
  } finally {
    client.release();
  }
}

// Cache the OpenAI rate limit headers returned by a moderation response.
async function cacheOpenAIRateLimitHeaders(orgId, headers) {
  if (!redis) return;
  try {
    await redis.set(
      `openai:rl:${orgId}`,
      JSON.stringify({ ...headers, fetchedAt: Math.floor(Date.now() / 1000) }),
      "EX",
      120,
    );
  } catch {}
}

// Return combined rate limit info for an org: cached OpenAI headers + internal budget counter.
export async function getOrgModerationRateInfo(orgId) {
  const result = { openai: null, internal: null };
  if (!redis) return result;
  try {
    const [cached, count, ttl] = await Promise.all([
      redis.get(`openai:rl:${orgId}`),
      redis.get(`rl:ai-mod:${orgId}`),
      redis.ttl(`rl:ai-mod:${orgId}`),
    ]);
    if (cached) {
      const p = JSON.parse(cached);
      result.openai = {
        remainingRequests:
          p.remainingRequests != null
            ? parseInt(p.remainingRequests, 10)
            : null,
        limitRequests:
          p.limitRequests != null ? parseInt(p.limitRequests, 10) : null,
        remainingTokens:
          p.remainingTokens != null ? parseInt(p.remainingTokens, 10) : null,
        limitTokens: p.limitTokens != null ? parseInt(p.limitTokens, 10) : null,
        fetchedAt: p.fetchedAt ?? null,
      };
    }
    result.internal = {
      used: count ? parseInt(count, 10) : 0,
      limit: AI_MOD_RATE_LIMIT,
      ttl: ttl > 0 ? ttl : 0,
    };
  } catch {}
  return result;
}

// Returns true if the org is over its per-minute moderation call budget.
async function isOrgModRateLimited(orgId) {
  if (!redis) return false;
  try {
    const n = await redis.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end
       return n`,
      1,
      `rl:ai-mod:${orgId}`,
    );
    return n > AI_MOD_RATE_LIMIT;
  } catch {
    return false;
  }
}

async function _runChatModeration(
  chatRowId,
  orgId,
  steamId,
  serverId,
  message,
  playerName,
) {
  const { rows: existing } = await pool.query(
    `SELECT ai_flags FROM text_chat_log WHERE id = $1`,
    [chatRowId],
  );
  if (!existing.length || existing[0].ai_flags !== null) return;

  const apiKey = await getOrgOpenAIKey(orgId);
  if (!apiKey) return;

  if (await isOrgModRateLimited(orgId)) {
    console.warn(
      `[ai-mod] rate limit reached for org=${orgId}, skipping chat ${chatRowId}`,
    );
    return;
  }

  let scores;
  try {
    const result = await callOpenAIModeration(apiKey, message);
    scores = result.scores;

    if (result.ratelimitHeaders) {
      cacheOpenAIRateLimitHeaders(orgId, result.ratelimitHeaders).catch(
        () => {},
      );
    }

    await pool.query(`UPDATE text_chat_log SET ai_flags = $1 WHERE id = $2`, [
      JSON.stringify({ flagged: result.flagged, scores }),
      chatRowId,
    ]);
  } catch (err) {
    const is429 = err.message?.includes("429");
    if (is429) {
      console.warn(
        `[ai-mod] rate limited by OpenAI for chat ${chatRowId}, skipping`,
      );
    } else {
      console.error(
        `[ai-mod] moderation API failed for chat ${chatRowId}:`,
        err,
      );
    }
    return;
  }

  const triggers = await loadTriggers(orgId);
  const matchedSignals = [];

  for (const trigger of triggers) {
    const score = scores[trigger.category] ?? 0;
    if (score >= Number(trigger.threshold)) {
      matchedSignals.push({
        category: trigger.category,
        score: Number(score),
        action: trigger.action,
        trigger,
      });
    }
  }

  if (matchedSignals.length) {
    await upsertCombinedFlag(
      chatRowId,
      orgId,
      serverId,
      steamId,
      playerName,
      message,
      matchedSignals,
    );
  }

  const automuteSignal = [...matchedSignals]
    .filter((s) => s.action === "automute")
    .sort((a, b) => Number(b.score) - Number(a.score))[0];
  if (automuteSignal) {
    await issueMute(orgId, steamId, automuteSignal.trigger, serverId).catch(
      (err) => {
        console.error(`[ai-mod] failed to issue mute:`, err);
      },
    );
  }
}

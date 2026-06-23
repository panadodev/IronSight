// AI chat moderation via OpenAI's Moderation API
// Used by the chat ingest handler (fire-and-forget)

import { pool, redis } from "./runtime.js";
import { decryptExternalApiKey } from "./crypto-keys.js";

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

    console.log({
      remainingRequests: res.headers.get("x-ratelimit-remaining-requests"),
      remainingTokens: res.headers.get("x-ratelimit-remaining-tokens"),
      resetRequests: res.headers.get("x-ratelimit-reset-requests"),
      resetTokens: res.headers.get("x-ratelimit-reset-tokens"),
    });

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) throw new Error("Unexpected OpenAI response: no results");

    return {
      flagged: Boolean(result.flagged),
      categories: result.categories ?? {},
      scores: result.category_scores ?? {},
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

async function insertFlag(
  chatRowId,
  orgId,
  serverId,
  steamId,
  playerName,
  message,
  trigger,
  score,
) {
  await pool
    .query(
      `INSERT INTO ai_chat_flags
         (chat_log_id, org_id, server_id, steam_id, player_name, message,
          triggered_category, score, action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (chat_log_id, triggered_category) DO NOTHING`,
      [
        chatRowId,
        orgId,
        serverId,
        steamId,
        playerName ?? null,
        message,
        trigger.category,
        score,
        trigger.action,
      ],
    )
    .catch((err) => {
      console.error(`[ai-mod] failed to insert flag:`, err);
    });
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

    await pool.query(`UPDATE text_chat_log SET ai_flags = $1 WHERE id = $2`, [
      JSON.stringify({ flagged: result.flagged, scores }),
      chatRowId,
    ]);
  } catch (err) {
    const is429 = err.message?.includes("429");
    if (is429) {
      console.warn(`[ai-mod] rate limited by OpenAI for chat ${chatRowId}, skipping`);
    } else {
      console.error(`[ai-mod] moderation API failed for chat ${chatRowId}:`, err);
    }
    return;
  }

  const triggers = await loadTriggers(orgId);
  const muteFired = new Set();

  for (const trigger of triggers) {
    const score = scores[trigger.category] ?? 0;
    if (score >= Number(trigger.threshold)) {
      await insertFlag(
        chatRowId,
        orgId,
        serverId,
        steamId,
        playerName,
        message,
        trigger,
        score,
      );

      if (trigger.action === "automute" && !muteFired.has(steamId)) {
        muteFired.add(steamId);
        await issueMute(orgId, steamId, trigger, serverId).catch((err) => {
          console.error(`[ai-mod] failed to issue mute:`, err);
        });
      }
    }
  }
}

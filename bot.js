import "dotenv/config";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN is not set");
  process.exit(1);
}

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const API_URL = (process.env.API_URL ?? "http://localhost:3000").replace(
  /\/api\/?$/,
  "",
);

if (!process.env.API_URL) {
  console.warn(
    "[IronSight Bot] API_URL is not set — defaulting to http://localhost:3000. Set API_URL to your panel's public URL in production.",
  );
}
console.log(`[IronSight Bot] Using API_URL: ${API_URL}`);

const INTENT_GUILD_MEMBERS = 1 << 1;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

const DM_MESSAGE =
  "👋 **IronSight Notice**\n\n" +
  "This server uses **IronSight**, a staff moderation panel for Rust game servers. " +
  "Staff members may review Discord messages and take moderation actions " +
  "(timeouts, kicks, bans) through the panel.\n\n" +
  "**What we collect:** Messages sent in this server are stored for up to 30 days " +
  "for moderation review, then permanently deleted. Your Discord ID and username " +
  "are stored as long as you remain a member.\n\n" +
  "**Privacy Policy:** https://ironsight.archipel.gg/privacy\n\n" +
  "_If you have questions, contact a server administrator._";

let ws;
let heartbeatTimer;
let sessionId = null;
let resumeGatewayUrl = null;
let seq = null;
let acked = true;
let reconnecting = false;

// Tracks owners awaiting a Discord ID reply to deactivate a staff member.
// Key: owner Discord user ID; value: { orgId, orgName, staffList, expiresAt }
const pendingDeactivate = new Map();
const DEACTIVATE_TIMEOUT_MS = 5 * 60 * 1000;

function send(data) {
  ws.send(JSON.stringify(data));
}

function reconnect(resume = false) {
  if (reconnecting) return;
  reconnecting = true;
  clearInterval(heartbeatTimer);
  console.log(`[IronSight Bot] Reconnecting in 5s (resume=${resume})`);
  try {
    ws.close();
  } catch {}
  setTimeout(() => {
    reconnecting = false;
    connect(resume);
  }, 5000);
}

function heartbeat() {
  if (!acked) {
    console.warn(
      "[IronSight Bot] Heartbeat not acknowledged — zombie connection, reconnecting",
    );
    reconnect(true);
    return;
  }
  acked = false;
  send({ op: 1, d: seq });
}

const BOT_HEADERS = {
  Authorization: `Bot ${TOKEN}`,
  "Content-Type": "application/json",
};

async function openDmChannel(userId) {
  const res = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: BOT_HEADERS,
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!res.ok) return null;
  const { id } = await res.json();
  return id;
}

async function sendDm(userId, content) {
  try {
    const channelId = await openDmChannel(userId);
    if (!channelId) return;
    await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: BOT_HEADERS,
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error(`[IronSight Bot] sendDm failed for ${userId}:`, err.message);
  }
}

async function dmUser(userId) {
  await sendDm(userId, DM_MESSAGE);
}

async function handleDeactivateCommand(authorId) {
  const res = await fetch(
    `${API_URL}/api/internal/bot/staff-list?ownerDiscordId=${encodeURIComponent(authorId)}`,
    { headers: BOT_HEADERS },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await sendDm(authorId, `❌ ${body.error ?? "Could not retrieve staff list. Are you an org owner?"}`);
    return;
  }
  const { orgId, orgName, staff } = await res.json();

  if (staff.length === 0) {
    await sendDm(authorId, `ℹ️ There are no active staff members in **${orgName}** to deactivate.`);
    return;
  }

  const staffLines = staff
    .map((s) => `• \`${s.discordId}\` — **${s.username}** (${s.roleId})`)
    .join("\n");

  pendingDeactivate.set(authorId, {
    orgId,
    orgName,
    staff,
    expiresAt: Date.now() + DEACTIVATE_TIMEOUT_MS,
  });

  await sendDm(
    authorId,
    `🛑 **Deactivate Staff Member — ${orgName}**\n\nReply with the Discord ID of the member to disable:\n\n${staffLines}\n\n_Type \`cancel\` to abort. This will expire in 5 minutes._`,
  );
}

async function handleDeactivateReply(authorId, content, pending) {
  pendingDeactivate.delete(authorId);

  if (content.toLowerCase() === "cancel") {
    await sendDm(authorId, "✅ Deactivation cancelled.");
    return;
  }

  const targetDiscordId = content.trim().replace(/\D/g, "");
  if (!targetDiscordId) {
    await sendDm(authorId, "❌ Invalid Discord ID. Please provide a numeric Discord user ID.");
    return;
  }

  const match = pending.staff.find((s) => s.discordId === targetDiscordId);
  if (!match) {
    await sendDm(authorId, `❌ Discord ID \`${targetDiscordId}\` is not in the staff list for **${pending.orgName}**. No action taken.`);
    return;
  }

  const res = await fetch(`${API_URL}/api/internal/bot/deactivate`, {
    method: "POST",
    headers: BOT_HEADERS,
    body: JSON.stringify({ ownerDiscordId: authorId, targetDiscordId }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.ok && body.ok) {
    await sendDm(authorId, `✅ **${match.username}** (\`${targetDiscordId}\`) has been disabled in **${pending.orgName}**. Their active sessions have been revoked.`);
    console.log(`[IronSight Bot] Deactivated ${match.username} (${targetDiscordId}) in org ${pending.orgId} by owner ${authorId}`);
  } else {
    await sendDm(authorId, `❌ Failed to disable member: ${body.error ?? "Unknown error"}`);
  }
}

function connect(resume = false) {
  const url = resume && resumeGatewayUrl ? resumeGatewayUrl : GATEWAY_URL;
  console.log(`[IronSight Bot] Connecting to gateway (resume=${resume})`);
  const socket = new WebSocket(url);
  ws = socket;

  socket.addEventListener("open", () => {
    if (resume && sessionId) {
      console.log("[IronSight Bot] Sending RESUME");
      socket.send(
        JSON.stringify({
          op: 6,
          d: { token: TOKEN, session_id: sessionId, seq },
        }),
      );
    }
  });

  socket.addEventListener("message", async ({ data }) => {
    const { op, d, s, t } = JSON.parse(data);
    if (s != null) seq = s;

    switch (op) {
      case 10: // HELLO
        clearInterval(heartbeatTimer);
        acked = true;
        heartbeatTimer = setInterval(heartbeat, d.heartbeat_interval);
        if (!resume || !sessionId) {
          console.log("[IronSight Bot] Sending IDENTIFY");
          send({
            op: 2, // IDENTIFY
            d: {
              token: TOKEN,
              intents:
                INTENT_GUILD_MEMBERS |
                INTENT_GUILD_MESSAGES |
                INTENT_MESSAGE_CONTENT,
              properties: {
                os: "linux",
                browser: "ironsight",
                device: "ironsight",
              },
            },
          });
        }
        break;

      case 11: // HEARTBEAT ACK
        acked = true;
        break;

      case 7: // RECONNECT
        reconnect(true);
        break;

      case 9: // INVALID SESSION — d indicates if resumable
        if (!d) {
          sessionId = null;
          seq = null;
        }
        reconnect(!!d);
        break;

      case 0: // DISPATCH
        if (t === "READY") {
          sessionId = d.session_id;
          resumeGatewayUrl = d.resume_gateway_url;
          console.log(`[IronSight Bot] Ready as ${d.user.username}`);
        } else if (t === "RESUMED") {
          console.log("[IronSight Bot] Session resumed");
        } else if (t === "GUILD_MEMBER_ADD") {
          if (!d.user?.bot) {
            console.log(
              `[IronSight Bot] New member: ${d.user.username} (${d.user.id}) in guild ${d.guild_id}`,
            );
            dmUser(d.user.id).catch((err) =>
              console.error(`[IronSight Bot] DM failed for ${d.user.id}:`, err),
            );
          }
        } else if (t === "MESSAGE_CREATE") {
          if (!d.guild_id && !d.author?.bot) {
            // DM from a user — handle owner commands
            const authorId = d.author.id;
            const content = (d.content ?? "").trim();
            const lc = content.toLowerCase();

            // Clean up expired pending operations
            for (const [id, p] of pendingDeactivate) {
              if (Date.now() > p.expiresAt) pendingDeactivate.delete(id);
            }

            const pending = pendingDeactivate.get(authorId);
            if (pending) {
              // Owner is in the middle of a deactivation flow — handle reply
              handleDeactivateReply(authorId, content, pending).catch((err) =>
                console.error(`[IronSight Bot] deactivate reply error:`, err),
              );
            } else if (lc === "stop user" || lc === "deactivate") {
              handleDeactivateCommand(authorId).catch((err) =>
                console.error(`[IronSight Bot] deactivate command error:`, err),
              );
            }
          } else if (d.guild_id && !d.author?.bot && !d.webhook_id) {
            fetch(`${API_URL}/api/internal/discord/message`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bot ${TOKEN}`,
              },
              body: JSON.stringify({
                messageId: d.id,
                guildId: d.guild_id,
                channelId: d.channel_id,
                channelName: "",
                authorId: d.author.id,
                authorUsername: d.author.global_name ?? d.author.username,
                content: d.content ?? "",
                attachments: d.attachments ?? [],
                timestamp: d.timestamp,
              }),
            })
              .then((r) => {
                if (!r.ok)
                  console.warn(
                    `[IronSight Bot] Ingest failed (${r.status}) for message ${d.id}`,
                  );
              })
              .catch((err) =>
                console.error(
                  `[IronSight Bot] Ingest error for message ${d.id}:`,
                  err.message,
                  err.cause
                    ? `(cause: ${err.cause?.message ?? err.cause})`
                    : "",
                ),
              );
          } else if (t === "MESSAGE_DELETE") {
            if (d.guild_id) {
              fetch(`${API_URL}/api/internal/discord/message/delete`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bot ${TOKEN}`,
                },
                body: JSON.stringify({
                  messageId: d.id,
                  guildId: d.guild_id,
                }),
              })
                .then((r) => {
                  if (!r.ok)
                    console.warn(
                      `[IronSight Bot] Delete ingest failed (${r.status}) for message ${d.id}`,
                    );
                })
                .catch((err) =>
                  console.error(
                    `[IronSight Bot] Delete ingest error for message ${d.id}:`,
                    err.message,
                  ),
                );
            }
          }
        }
        break;
    }
  });

  socket.addEventListener("close", ({ code }) => {
    clearInterval(heartbeatTimer);
    console.log(`[IronSight Bot] Gateway closed (code ${code})`);
    if (code === 4004) {
      console.error("[IronSight Bot] Invalid token — exiting");
      process.exit(1);
    }
    if (code === 4014) {
      console.error(
        "[IronSight Bot] GUILD_MEMBERS intent not approved in the Developer Portal — exiting",
      );
      process.exit(1);
    }
    if (!reconnecting) {
      reconnect(code !== 4007 && code !== 4009);
    }
  });

  socket.addEventListener("error", (err) =>
    console.error("[IronSight Bot] WebSocket error:", err),
  );
}

connect();
